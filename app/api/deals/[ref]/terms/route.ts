import { z } from "zod";
import { getDb } from "@/lib/db";
import { proposeTerms } from "@/lib/deals/service";
import { serverEnv } from "@/lib/env";
import { describeError, fail, json, readJson, requireDeal, type RouteCtx } from "@/lib/http";

/** Either party proposes changed terms while the deal is a DRAFT. */
export async function POST(req: Request, { params }: RouteCtx) {
  const found = await requireDeal(req, (await params).ref);
  if (!found.ok) return found.response;
  const input = await readJson(req, z.object({ terms: z.unknown() }));
  if (!input.ok) return input.response;
  try {
    const res = await proposeTerms(
      getDb(),
      found.deal.id,
      found.role,
      input.data.terms,
      serverEnv().MAX_DEAL_USD,
    );
    return res.ok ? json(res) : fail(409, res.reason);
  } catch (e) {
    return fail(400, describeError(e));
  }
}
