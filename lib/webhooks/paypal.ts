import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { webhookEvents } from "@/lib/db/schema";
import { onPaypalWebhook, type EngineDeps } from "@/lib/rules/engine";

// Stored, verified PayPal events are processed right after the 200 reply, and again by the sweep
// if that did not finish (PayPal also redelivers for about three days until it gets a 2xx).

type Stored = typeof webhookEvents.$inferSelect;

export async function processWebhookEvent(db: Db, row: Stored, deps?: EngineDeps) {
  if (row.processedAt || !row.verified) return null;
  const raw = row.rawJson as { resource?: unknown };
  const result = await onPaypalWebhook(
    { id: row.eventId, event_type: row.eventType, resource: raw.resource },
    deps,
  );
  // "pending" means PayPal itself did not answer the re-read; leave it for the next sweep.
  if (result.outcome !== "pending") {
    await db
      .update(webhookEvents)
      .set({ processedAt: new Date() })
      .where(and(eq(webhookEvents.id, row.id), isNull(webhookEvents.processedAt)));
  }
  return result;
}

export async function processPendingWebhooks(db: Db, deps?: EngineDeps, limit = 50) {
  const rows = await db
    .select()
    .from(webhookEvents)
    .where(and(isNull(webhookEvents.processedAt), eq(webhookEvents.verified, true)))
    .orderBy(asc(webhookEvents.receivedAt))
    .limit(limit);
  let processed = 0;
  for (const row of rows) {
    try {
      await processWebhookEvent(db, row, deps);
      processed++;
    } catch (e) {
      console.error(`Webhook event ${row.eventId} failed:`, (e as Error).message);
    }
  }
  return processed;
}
