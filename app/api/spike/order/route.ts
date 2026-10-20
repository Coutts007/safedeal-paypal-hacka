import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { serverEnv } from "@/lib/env";
import { paypalFetch } from "@/lib/paypal/client";
import { buildSpikeOrder } from "@/lib/paypal/spike";
import { spikeDisabled } from "@/lib/paypal/spike-guard";

// Creates the spike's AUTHORIZE order server-side. Amount and payee never come from the browser.
export async function POST() {
  const disabled = spikeDisabled();
  if (disabled) return disabled;

  const env = serverEnv();
  const res = await paypalFetch<{ id?: string; status?: string }>("/v2/checkout/orders", {
    method: "POST",
    requestId: `spike-${randomUUID()}-create-v1`,
    body: buildSpikeOrder(env.SANDBOX_SELLER_A_EMAIL, "spike-web"),
  });
  if (!res.ok || !res.json.id) {
    return NextResponse.json(
      { error: "order create failed", status: res.status, debugId: res.debugId },
      { status: 502 },
    );
  }
  return NextResponse.json({ id: res.json.id, status: res.json.status });
}
