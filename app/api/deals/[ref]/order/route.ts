import { fail, json, requireDeal, type RouteCtx } from "@/lib/http";
import { preparePayment } from "@/lib/rules/engine";

/** Buyer: the PayPal order for this deal, built from the locked terms (never from the browser). */
export async function POST(req: Request, { params }: RouteCtx) {
  const found = await requireDeal(req, (await params).ref, "buyer");
  if (!found.ok) return found.response;
  const res = await preparePayment(found.deal.id);
  return res.ok ? json({ id: res.orderId }) : fail(409, res.reason);
}
