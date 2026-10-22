import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { chatStartDate, formatForModel, parseChat, type ChatMessage } from "./chat";
import { correctionPrompt, PROMPT_VERSION, SYSTEM_PROMPT, userPrompt } from "./prompt";
import { redact } from "./redact";
import { extractionSchema, type Extraction } from "./schema";
import { instructionLikeMessages, validateExtraction } from "./validate";

// Chat → proposed deal terms (BUILD_PLAN 8.3). The chat is redacted before it leaves the server,
// the model must answer in the extraction schema, and its answer is validated; one retry with the
// list of problems, then the caller falls back to an empty card. Nothing here can move money.

type Turn = Anthropic.Beta.BetaMessageParam;

export type ModelReply = {
  /** The assistant content, passed back unchanged on a retry. */
  content: Anthropic.Beta.BetaContentBlock[];
  text: string;
  stopReason: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
};

/** One model call. Injected so tests and the evaluation can run without the network. */
export type ModelCall = (req: { system: string; messages: Turn[] }) => Promise<ModelReply>;

export type AiRunLog = {
  purpose: "extract";
  promptVersion: string;
  model: string;
  attempt: number;
  outcome: "ok" | "invalid" | "refused" | "error";
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** Error class or validation problem count; never chat content. */
  detail?: string;
};

export type ExtractResult =
  | {
      ok: true;
      extraction: Extraction;
      messages: ChatMessage[];
      redactedText: string;
      chatDate: string;
    }
  | {
      ok: false;
      reason: "empty_chat" | "ai_unavailable" | "invalid_output" | "refused";
      messages: ChatMessage[];
      redactedText: string;
      chatDate: string;
    };

const FORMAT = betaZodOutputFormat(extractionSchema);

/** The Anthropic call used in production. The model comes from LLM_MODEL (Peter's choice). */
export function anthropicModel(opts: { apiKey: string; model: string }): ModelCall {
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 2, timeout: 90_000 });
  return async ({ system, messages }) => {
    const res = await client.beta.messages.create({
      model: opts.model,
      max_tokens: 16000,
      system,
      messages,
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: FORMAT.schema },
      },
      // If a safety classifier declines, the API retries on a suitable model in the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    const text = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return {
      content: res.content,
      text,
      stopReason: res.stop_reason,
      model: res.model,
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
    };
  };
}

/** "400 invalid_request_error: Your credit balance is too low…", capped for the log. */
function apiErrorDetail(e: InstanceType<typeof Anthropic.APIError>): string {
  const body = e.error as { error?: { type?: string; message?: string } } | undefined;
  const parts = [e.status, body?.error?.type].filter(Boolean).join(" ");
  const message = body?.error?.message;
  return (message ? `${parts}: ${message}` : parts || e.name).slice(0, 200);
}

const WEEKDAY = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Nairobi", weekday: "long" });
const NAIROBI_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi" });

export async function extractDeal(
  input: { chat: string; chatDate?: string | null; now: Date },
  deps: { call: ModelCall; log: (run: AiRunLog) => Promise<void> | void; modelName: string },
): Promise<ExtractResult> {
  const { text: redactedText } = redact(input.chat);
  const messages = parseChat(redactedText);
  const chatDate = input.chatDate ?? chatStartDate(messages) ?? NAIROBI_DATE.format(input.now);
  const base = { messages, redactedText, chatDate };
  if (!messages.length) return { ok: false, reason: "empty_chat", ...base };

  const weekday = WEEKDAY.format(new Date(`${chatDate}T12:00:00+03:00`));
  const turns: Turn[] = [
    { role: "user", content: userPrompt({ chat: formatForModel(messages), chatDate, weekday }) },
  ];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    const run = {
      purpose: "extract" as const,
      promptVersion: PROMPT_VERSION,
      attempt,
      model: deps.modelName,
      inputTokens: 0,
      outputTokens: 0,
    };
    let reply: ModelReply;
    try {
      reply = await deps.call({ system: SYSTEM_PROMPT, messages: turns });
    } catch (e) {
      await deps.log({
        ...run,
        outcome: "error",
        latencyMs: Date.now() - started,
        // The API's own message (e.g. "credit balance is too low"); it never echoes chat text.
        detail: e instanceof Anthropic.APIError ? apiErrorDetail(e) : "network",
      });
      return { ok: false, reason: "ai_unavailable", ...base };
    }
    const logged = {
      ...run,
      model: reply.model,
      inputTokens: reply.inputTokens,
      outputTokens: reply.outputTokens,
      latencyMs: Date.now() - started,
    };
    if (reply.stopReason === "refusal") {
      await deps.log({ ...logged, outcome: "refused" });
      return { ok: false, reason: "refused", ...base };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(reply.text);
    } catch {
      raw = undefined;
    }
    const checked =
      raw === undefined
        ? { ok: false as const, problems: ["output is not valid JSON"] }
        : validateExtraction(raw, messages);
    if (checked.ok) {
      await deps.log({ ...logged, outcome: "ok" });
      return { ok: true, extraction: withRuleFlags(checked.value, messages), ...base };
    }
    await deps.log({
      ...logged,
      outcome: "invalid",
      detail: `${checked.problems.length} problems`,
    });
    turns.push({ role: "assistant", content: reply.content });
    turns.push({ role: "user", content: correctionPrompt(checked.problems) });
  }
  return { ok: false, reason: "invalid_output", ...base };
}

/** Add messages our own patterns find instruction-like, in case the model missed them. */
function withRuleFlags(x: Extraction, messages: ChatMessage[]): Extraction {
  const flagged = new Set(x.instruction_flags.map((f) => f.message_id));
  const extra = instructionLikeMessages(messages)
    .filter((id) => !flagged.has(id))
    .map((id) => ({ message_id: id, reason: "looks like an instruction to an AI" }));
  return extra.length ? { ...x, instruction_flags: [...x.instruction_flags, ...extra] } : x;
}
