import { serverEnv } from "@/lib/env";
import { callPaypal } from "./result";

// Rule 4: verify every PayPal webhook with PayPal before acting on it. The route must read the raw
// body with `await request.text()` and pass it here unchanged.

const HEADERS = {
  auth_algo: "paypal-auth-algo",
  cert_url: "paypal-cert-url",
  transmission_id: "paypal-transmission-id",
  transmission_sig: "paypal-transmission-sig",
  transmission_time: "paypal-transmission-time",
} as const;

export type WebhookCheck =
  | { verified: true; event: { id: string; event_type: string; resource?: unknown } }
  | { verified: false; reason: string };

export async function verifyPaypalWebhook(
  headers: Headers,
  rawBody: string,
): Promise<WebhookCheck> {
  const webhookId = serverEnv().PAYPAL_WEBHOOK_ID;
  if (!webhookId) return { verified: false, reason: "PAYPAL_WEBHOOK_ID is not set" };

  const fields: Record<string, string> = {};
  for (const [field, header] of Object.entries(HEADERS)) {
    const v = headers.get(header);
    if (!v) return { verified: false, reason: `missing header ${header}` };
    fields[field] = v;
  }
  let event: { id?: unknown; event_type?: unknown; resource?: unknown };
  try {
    event = JSON.parse(rawBody) as typeof event;
  } catch {
    return { verified: false, reason: "body is not JSON" };
  }
  if (typeof event.id !== "string" || typeof event.event_type !== "string") {
    return { verified: false, reason: "event id or type missing" };
  }

  const res = await callPaypal(
    "/v1/notifications/verify-webhook-signature",
    {
      method: "POST",
      // Verification moves no money; the transmission id makes a natural fixed key.
      requestId: `verify-${fields.transmission_id}`,
      body: { ...fields, webhook_id: webhookId, webhook_event: event },
      record: { dealId: null, action: "verify_webhook" },
    },
    (j: { verification_status?: string }) => j.verification_status,
  );
  if (!res.ok) return { verified: false, reason: `verification call failed: ${res.issue}` };
  if (res.value !== "SUCCESS")
    return { verified: false, reason: `verification_status ${res.value}` };
  return {
    verified: true,
    event: { id: event.id, event_type: event.event_type, resource: event.resource },
  };
}
