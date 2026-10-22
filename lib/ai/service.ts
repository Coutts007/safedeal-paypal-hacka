import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { aiExtractions, aiRuns } from "@/lib/db/schema";
import { parseChat, type ChatMessage } from "./chat";
import type { ServerEnv } from "@/lib/env";
import { anthropicModel, extractDeal, type AiRunLog, type ModelCall } from "./extract";
import { PROMPT_VERSION } from "./prompt";
import { extractionSchema, type Extraction } from "./schema";
import { toProposal, type Proposal } from "./proposal";

// Server side of "paste a chat": run the extraction, store the redacted chat and the proposal,
// log every AI call (without content), and hand the create page what it needs.

let testModel: ModelCall | undefined;
/** Test hook: use a fake model instead of calling Anthropic (undefined restores it). */
export function setExtractModel(call: ModelCall | undefined) {
  testModel = call;
}

/** The model to call, or null when no LLM key is configured (the form is then filled by hand). */
export function extractModel(env: ServerEnv): ModelCall | null {
  if (testModel) return testModel;
  return env.LLM_API_KEY ? anthropicModel({ apiKey: env.LLM_API_KEY, model: env.LLM_MODEL }) : null;
}

/** An unused extraction can be turned into a deal for this long. */
export const EXTRACTION_TTL_MS = 24 * 3_600_000;

export type ReadChatResponse = {
  extractionId: string;
  status: "ok" | "empty_chat" | "ai_unavailable" | "invalid_output" | "refused";
  chatDate: string;
  messages: ChatMessage[];
  proposal: Proposal | null;
};

export async function readChat(
  db: Db,
  input: { chat: string; chatDate?: string | null; now: Date },
  deps: { call: ModelCall; modelName: string; kesPerUsd: number },
): Promise<ReadChatResponse> {
  const runs: AiRunLog[] = [];
  const result = await extractDeal(input, {
    call: deps.call,
    modelName: deps.modelName,
    log: (run) => {
      runs.push(run);
      console.info(
        `ai ${run.purpose} ${run.promptVersion} ${run.model} attempt ${run.attempt}: ${run.outcome}` +
          ` (${run.inputTokens} in, ${run.outputTokens} out, ${run.latencyMs} ms${run.detail ? `, ${run.detail}` : ""})`,
      );
    },
  });

  const status = result.ok ? "ok" : result.reason;
  const [row] = await db
    .insert(aiExtractions)
    .values({
      redactedText: result.redactedText,
      messagesJson: result.messages,
      extractionJson: result.ok ? result.extraction : null,
      status,
      chatDate: result.chatDate,
      promptVersion: PROMPT_VERSION,
    })
    .returning({ id: aiExtractions.id });
  if (runs.length) {
    await db.insert(aiRuns).values(runs.map((r) => ({ ...r, extractionId: row.id })));
  }
  return {
    extractionId: row.id,
    status,
    chatDate: result.chatDate,
    messages: result.messages,
    proposal: result.ok ? toProposal(result.extraction, deps.kesPerUsd) : null,
  };
}

export type StoredExtraction = {
  id: string;
  redactedText: string;
  messages: ChatMessage[];
  extraction: Extraction | null;
};

/** An extraction that may still become a deal (recent, not used yet). */
export async function usableExtraction(
  db: Db,
  id: string,
  now: Date,
): Promise<StoredExtraction | null> {
  const [row] = await db
    .select()
    .from(aiExtractions)
    .where(
      and(
        eq(aiExtractions.id, id),
        isNull(aiExtractions.dealId),
        gt(aiExtractions.createdAt, new Date(now.getTime() - EXTRACTION_TTL_MS)),
      ),
    );
  if (!row) return null;
  return {
    id: row.id,
    redactedText: row.redactedText,
    // Re-derived from the stored text: the same parser gives the same message ids.
    messages: parseChat(row.redactedText),
    extraction: row.extractionJson ? extractionSchema.parse(row.extractionJson) : null,
  };
}
