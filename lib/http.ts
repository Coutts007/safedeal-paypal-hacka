import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { dealForToken, type Role } from "@/lib/deals/service";
import type { EngineResult } from "@/lib/rules/engine";

// Helpers shared by the API routes. Errors never include secrets or stack traces.

export const json = (data: unknown, status = 200) => NextResponse.json(data, { status });
export const fail = (status: number, error: string) => json({ error }, status);

/** Human-readable summary of a Zod error or our own validation error. */
export function describeError(e: unknown): string {
  if (e instanceof z.ZodError) {
    return e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
  }
  return e instanceof Error ? e.message : "invalid request";
}

export async function readJson<T extends z.ZodType>(
  req: Request,
  schema: T,
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; response: NextResponse }> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { ok: false, response: fail(400, "body must be JSON") };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, response: fail(400, describeError(parsed.error)) };
  return { ok: true, data: parsed.data };
}

/**
 * The deal for this route and the caller's role, from the `x-deal-token` header (the token in the
 * party's link). Unknown deal and wrong token both answer 404, so refs cannot be probed.
 */
export async function requireDeal(req: Request, ref: string, only?: Role) {
  const found = await dealForToken(getDb(), ref, req.headers.get("x-deal-token"));
  if (!found) return { ok: false as const, response: fail(404, "deal not found") };
  if (only && found.role !== only) {
    return { ok: false as const, response: fail(403, `only the ${only} can do this`) };
  }
  return { ok: true as const, ...found };
}

/** Map an engine result to an HTTP answer the Deal Room can show. */
export function engineResponse(result: EngineResult) {
  switch (result.outcome) {
    case "moved":
    case "unchanged":
    case "failed":
      return json(result);
    case "pending":
      return json(result, 202);
    case "rejected":
      return json({ ...result, error: result.reason }, 409);
    case "skipped":
      return fail(404, "deal not found");
  }
}

export type RouteCtx = { params: Promise<{ ref: string }> };
