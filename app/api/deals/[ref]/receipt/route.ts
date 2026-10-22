import { z } from "zod";
import { engineResponse, readJson, requireDeal, type RouteCtx } from "@/lib/http";
import { onBuyerConfirmed, onBuyerProblem } from "@/lib/rules/engine";

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm") }),
  z.object({ action: z.literal("problem"), note: z.string().trim().min(3).max(2000) }),
]);

/** Buyer confirms receipt (pays the seller) or reports a problem (review). */
export async function POST(req: Request, { params }: RouteCtx) {
  const found = await requireDeal(req, (await params).ref, "buyer");
  if (!found.ok) return found.response;
  const input = await readJson(req, body);
  if (!input.ok) return input.response;
  const result =
    input.data.action === "confirm"
      ? await onBuyerConfirmed(found.deal.id)
      : await onBuyerProblem(found.deal.id, input.data.note);
  return engineResponse(result);
}
