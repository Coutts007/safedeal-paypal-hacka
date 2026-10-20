import { NextResponse } from "next/server";
import { z } from "zod";
import { paypalFetch } from "@/lib/paypal/client";
import { firstAuthorization, type AuthorizedOrder } from "@/lib/paypal/spike";
import { spikeDisabled } from "@/lib/paypal/spike-guard";

const bodySchema = z.object({ orderId: z.string().regex(/^[A-Z0-9]{10,30}$/) });

// Authorises an order the buyer approved in the v6 button. Does not capture: the spike page only
// proves the button accepts an AUTHORIZE order. The hold expires on its own in the sandbox.
export async function POST(request: Request) {
  const disabled = spikeDisabled();
  if (disabled) return disabled;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid orderId" }, { status: 400 });

  const { orderId } = parsed.data;
  const res = await paypalFetch<AuthorizedOrder>(`/v2/checkout/orders/${orderId}/authorize`, {
    method: "POST",
    requestId: `spike-${orderId}-authorize-v1`,
    body: {},
  });
  const auth = firstAuthorization(res.json);
  if (!res.ok || !auth) {
    return NextResponse.json(
      { error: "authorize failed", status: res.status, debugId: res.debugId },
      { status: 502 },
    );
  }
  return NextResponse.json({
    orderId,
    orderStatus: res.json.status,
    authorizationId: auth.id,
    authorizationStatus: auth.status,
    expirationTime: auth.expiration_time ?? null,
  });
}
