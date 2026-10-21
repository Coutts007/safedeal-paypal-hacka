import { z } from "zod";
import { engineResponse, readJson, requireDeal, type RouteCtx } from "@/lib/http";
import { onTrackingSubmitted } from "@/lib/rules/engine";

const body = z.object({
  carrier: z.string().trim().min(1).max(80),
  trackingNumber: z.string().trim().min(3).max(60),
});

/** Seller adds tracking (photos come in Phase 5). */
export async function POST(req: Request, { params }: RouteCtx) {
  const found = await requireDeal(req, (await params).ref, "seller");
  if (!found.ok) return found.response;
  const input = await readJson(req, body);
  if (!input.ok) return input.response;
  return engineResponse(await onTrackingSubmitted(found.deal.id, input.data));
}
