import { eq } from "drizzle-orm";
import { after } from "next/server";
import { getDb } from "@/lib/db";
import { webhookEvents } from "@/lib/db/schema";
import { fail, json } from "@/lib/http";
import { verifyPaypalWebhook } from "@/lib/paypal/webhooks";
import { processWebhookEvent } from "@/lib/webhooks/paypal";

/**
 * PayPal webhooks (rule 4). Read the raw body, verify it with PayPal, store the event id once,
 * answer 200 quickly, then process. Unverified events are refused and not stored, so a forged
 * event can never take the id of a real one.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const check = await verifyPaypalWebhook(req.headers, raw);
  if (!check.verified) {
    console.warn(`PayPal webhook refused: ${check.reason}`);
    // If PayPal's verification service was unreachable, ask PayPal to redeliver later.
    return check.reason.startsWith("verification call failed")
      ? fail(503, "verification unavailable")
      : fail(400, "webhook not verified");
  }
  const db = getDb();
  const [row] = await db
    .insert(webhookEvents)
    .values({
      provider: "paypal",
      eventId: check.event.id,
      eventType: check.event.event_type,
      rawJson: JSON.parse(raw) as unknown,
      verified: true,
    })
    .onConflictDoNothing({ target: webhookEvents.eventId })
    .returning();
  if (!row) return json({ received: true, duplicate: true });

  after(async () => {
    try {
      const [fresh] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, row.id));
      if (fresh) await processWebhookEvent(db, fresh);
    } catch (e) {
      // The sweep retries unprocessed events.
      console.error(`Webhook ${row.eventId} processing failed:`, (e as Error).message);
    }
  });
  return json({ received: true });
}
