import { NextResponse } from "next/server";
import { getClientToken } from "@/lib/paypal/client";
import { spikeDisabled } from "@/lib/paypal/spike-guard";

// Fallback for SDK v6 `createInstance({ clientToken })` in case `clientId` is refused.
// The client token is browser-safe by design (short-lived, SDK-init scope).
export async function GET() {
  const disabled = spikeDisabled();
  if (disabled) return disabled;
  try {
    return NextResponse.json({ clientToken: await getClientToken() });
  } catch {
    return NextResponse.json({ error: "client token failed" }, { status: 502 });
  }
}
