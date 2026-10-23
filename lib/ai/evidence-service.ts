import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@/lib/db";
import {
  aiRuns,
  courierEvents,
  deals,
  dealTerms,
  evidence,
  evidenceChecks,
  evidenceFiles,
  reviews,
} from "@/lib/db/schema";
import { dealTermsSchema } from "@/lib/deals/terms";
import type { ServerEnv } from "@/lib/env";
import { anthropicModel, type AiRunLog, type ModelCall } from "./extract";
import {
  checkEvidence,
  EVIDENCE_PROMPT_VERSION,
  evidenceCheckSchema,
  type EvidenceInput,
  type EvidenceItem,
  type EvidenceResult,
} from "./evidence";

// Server side of the reviewer's "Ask the AI" button: gather the deal's terms and evidence, run the
// check, store the label and every AI call (without content). Advice only.

/** The most recent photos sent to the model per check (cost and request size). */
const MAX_IMAGES = 6;

let testModel: ModelCall | undefined;
/** Test hook: use a fake model instead of calling Anthropic (undefined restores it). */
export function setEvidenceModel(call: ModelCall | undefined) {
  testModel = call;
}

export function evidenceModel(env: ServerEnv): ModelCall | null {
  if (testModel) return testModel;
  return env.LLM_API_KEY
    ? anthropicModel({ apiKey: env.LLM_API_KEY, model: env.LLM_MODEL, schema: evidenceCheckSchema })
    : null;
}

export async function evidenceInput(db: Db, dealId: string): Promise<EvidenceInput | null> {
  const [deal] = await db.select().from(deals).where(eq(deals.id, dealId));
  if (!deal?.confirmedTermsId) return null;
  const [terms] = await db.select().from(dealTerms).where(eq(dealTerms.id, deal.confirmedTermsId));
  const t = dealTermsSchema.parse(terms.termsJson);
  const [review] = await db
    .select({ reason: reviews.reason, note: reviews.note })
    .from(reviews)
    .where(and(eq(reviews.dealId, dealId), isNull(reviews.decision)))
    .orderBy(desc(reviews.createdAt))
    .limit(1);
  const ev = await db
    .select()
    .from(evidence)
    .where(eq(evidence.dealId, dealId))
    .orderBy(asc(evidence.createdAt));
  const photoIds = ev
    .filter((e) => e.type === "photo")
    .slice(-MAX_IMAGES)
    .map((e) => e.id);
  const files = new Map<string, { contentType: string; data: Buffer }>();
  for (const id of photoIds) {
    const [f] = await db
      .select({ contentType: evidenceFiles.contentType, data: evidenceFiles.data })
      .from(evidenceFiles)
      .where(eq(evidenceFiles.evidenceId, id));
    if (f) files.set(id, f);
  }
  const events = await db
    .select({ status: courierEvents.status, at: courierEvents.receivedAt })
    .from(courierEvents)
    .where(and(eq(courierEvents.dealId, dealId), eq(courierEvents.verified, true)))
    .orderBy(asc(courierEvents.receivedAt));

  type NoId<T> = T extends unknown ? Omit<T, "id"> : never;
  type Timed = { at: Date; item: NoId<EvidenceItem> };
  const timed: Timed[] = [
    ...ev.map((e): Timed => {
      const at = e.createdAt;
      const iso = at.toISOString();
      if (e.type === "tracking") {
        return {
          at,
          item: { kind: "tracking", at: iso, carrier: e.carrier, trackingNumber: e.trackingNumber },
        };
      }
      if (e.type === "note") {
        return {
          at,
          item: { kind: "note", at: iso, by: e.addedBy ?? "seller", text: e.note ?? "" },
        };
      }
      const f = files.get(e.id);
      return {
        at,
        item: {
          kind: "photo",
          at: iso,
          by: e.addedBy ?? "seller",
          caption: e.note,
          image: f
            ? {
                mediaType: f.contentType as "image/jpeg" | "image/png" | "image/webp",
                base64: f.data.toString("base64"),
              }
            : null,
        },
      };
    }),
    ...events.map((c): Timed => ({
      at: c.at,
      item: { kind: "courier_event", at: c.at.toISOString(), status: c.status },
    })),
  ];
  timed.sort((a, b) => a.at.getTime() - b.at.getTime());
  return {
    terms: {
      item: t.item,
      quantity: t.quantity,
      price: `US$${t.price.amount}`,
      deliveryMethod: t.deliveryMethod,
      carrier: t.carrier,
      conditions: t.conditions,
    },
    deal: {
      state: deal.state,
      deliveryProof: deal.deliveryProof,
      deliveredAt: deal.deliveredAt?.toISOString() ?? null,
      handoverAttempts: deal.handoverAttempts,
      handoverLocked: deal.handoverLocked,
      // The review reason is SafeDeal's own text; the buyer's note is sent as evidence instead.
      reviewReason: review?.reason ?? null,
    },
    items: [
      ...timed.map((x, i) => ({ ...x.item, id: `e${i + 1}` }) as EvidenceItem),
      ...(review?.note
        ? [
            {
              id: `e${timed.length + 1}`,
              kind: "note",
              at: "",
              by: "buyer (problem report)",
              text: review.note,
            } as EvidenceItem,
          ]
        : []),
    ],
  };
}

export async function runEvidenceCheck(
  db: Db,
  dealId: string,
  deps: { call: ModelCall; modelName: string },
): Promise<EvidenceResult | { ok: false; reason: "no_terms" }> {
  const input = await evidenceInput(db, dealId);
  if (!input) return { ok: false, reason: "no_terms" };
  const runs: AiRunLog[] = [];
  const result = await checkEvidence(input, {
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
  if (runs.length) await db.insert(aiRuns).values(runs.map((r) => ({ ...r, dealId })));
  if (result.ok) {
    await db.insert(evidenceChecks).values({
      dealId,
      label: result.check.label,
      reasons: result.check.reasons,
      flags: result.check.instruction_flags,
      promptVersion: EVIDENCE_PROMPT_VERSION,
      model: runs.at(-1)?.model ?? deps.modelName,
    });
  }
  return result;
}
