import { z } from "zod";
import { dealByRef, requireAdmin } from "@/lib/admin/http";
import { fail, json, readJson, type RouteCtx } from "@/lib/http";
import { onHandoverUnlock } from "@/lib/rules/engine";

const body = z.object({ reason: z.string().trim().min(10).max(2000) });

/** Lift a handover-code lock after 5 wrong codes, with a written reason. */
export async function POST(req: Request, { params }: RouteCtx) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const deal = await dealByRef((await params).ref);
  if (!deal) return fail(404, "deal not found");
  const input = await readJson(req, body);
  if (!input.ok) return input.response;
  const res = await onHandoverUnlock(deal.id, { reason: input.data.reason, admin: "admin" });
  return res.ok ? json(res) : fail(409, res.reason);
}
