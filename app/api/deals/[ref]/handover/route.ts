import { z } from "zod";
import { engineResponse, readJson, requireDeal, type RouteCtx } from "@/lib/http";
import { onHandoverCode } from "@/lib/rules/engine";

const body = z.object({ code: z.string().trim().min(1).max(20) });

/** Seller enters the buyer's 6-digit handover code (hash compare, 5 tries, then locked). */
export async function POST(req: Request, { params }: RouteCtx) {
  const found = await requireDeal(req, (await params).ref, "seller");
  if (!found.ok) return found.response;
  const input = await readJson(req, body);
  if (!input.ok) return input.response;
  return engineResponse(await onHandoverCode(found.deal.id, input.data.code));
}
