import { runEvidenceCheck, evidenceModel } from "@/lib/ai/evidence-service";
import { dealByRef, requireAdmin } from "@/lib/admin/http";
import { getDb } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { fail, json, type RouteCtx } from "@/lib/http";

const NOT_DONE = {
  no_terms: "this deal has no confirmed terms to compare with",
  ai_unavailable: "the AI is not answering right now; decide from the evidence yourself",
  invalid_output: "the AI could not give a usable answer; decide from the evidence yourself",
  refused: "the AI declined to look at this evidence; decide from the evidence yourself",
} as const;

/** The reviewer asks the AI to compare the evidence with the terms. Advice only. */
export async function POST(req: Request, { params }: RouteCtx) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const deal = await dealByRef((await params).ref);
  if (!deal) return fail(404, "deal not found");
  const env = serverEnv();
  const call = evidenceModel(env);
  if (!call) return fail(503, "no AI model is configured (LLM_API_KEY)");
  const result = await runEvidenceCheck(getDb(), deal.id, { call, modelName: env.LLM_MODEL });
  return result.ok ? json(result.check) : fail(502, NOT_DONE[result.reason]);
}
