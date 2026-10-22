import { z } from "zod";
import { engineResponse, readJson, requireDeal, type RouteCtx } from "@/lib/http";
import { onBuyerApproved } from "@/lib/rules/engine";

/** Buyer approved in PayPal: the engine checks the order and authorises it (funds held). */
export async function POST(req: Request, { params }: RouteCtx) {
  const found = await requireDeal(req, (await params).ref, "buyer");
  if (!found.ok) return found.response;
  const input = await readJson(req, z.object({ orderId: z.string().regex(/^[A-Z0-9]{5,40}$/) }));
  if (!input.ok) return input.response;
  return engineResponse(await onBuyerApproved(found.deal.id, input.data.orderId));
}
