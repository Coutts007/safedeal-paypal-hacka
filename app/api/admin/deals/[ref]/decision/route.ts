import { z } from "zod";
import { dealByRef, requireAdmin } from "@/lib/admin/http";
import { engineResponse, fail, readJson, type RouteCtx } from "@/lib/http";
import { onAdminDecision } from "@/lib/rules/engine";

const body = z.object({
  decision: z.enum(["capture", "void"]),
  reason: z.string().trim().min(10, "write the reason (at least 10 characters)").max(2000),
});

/** The reviewer captures or voids a deal in review, with a written reason (section 7). */
export async function POST(req: Request, { params }: RouteCtx) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const deal = await dealByRef((await params).ref);
  if (!deal) return fail(404, "deal not found");
  const input = await readJson(req, body);
  if (!input.ok) return input.response;
  return engineResponse(await onAdminDecision(deal.id, { ...input.data, admin: "admin" }));
}
