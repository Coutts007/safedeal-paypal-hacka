import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db";
import { courierEvents, deals, evidence } from "@/lib/db/schema";
import { onCourierDelivered, type EngineDeps, type EngineResult } from "@/lib/rules/engine";
import { hmacHex, secretMatches } from "@/lib/secrets";

// Courier webhooks (rule 4): verify the HMAC of the raw body, store each event id once, ignore
// repeats, and only then act. Only a verified "delivered" event can move a deal, and only to
// DELIVERED: the money is still released by the rule engine after the inspection window.
//
// COURIER_MODE=test is the only mode built for the hackathon. The test courier signs events with
// TEST_COURIER_SECRET; AfterShip would need its own format and secret (DECISIONS 2026-10-23).

export const SIGNATURE_HEADER = "x-courier-signature";

const eventSchema = z.object({
  id: z.string().min(1).max(120),
  tracking_number: z.string().trim().min(3).max(60),
  carrier: z.string().max(80).optional(),
  status: z.enum(["in_transit", "out_for_delivery", "delivered", "failed_attempt"]),
  occurred_at: z.iso.datetime({ offset: true }).optional(),
});
export type CourierEvent = z.infer<typeof eventSchema>;

export type CourierConfig = { mode: "test" | "aftership"; testSecret: string };

export type CourierOutcome =
  | { status: 401 | 400 | 501 | 503; body: { error: string } }
  | {
      status: 200;
      body: { received: true; duplicate?: true; matched?: boolean; result?: EngineResult };
    };

/** States in which a delivered event still means something for the deal. */
const WAITING_FOR_DELIVERY = ["SHIPPED", "IN_REVIEW", "AUTHORIZED"] as const;

async function dealForTracking(db: Db, trackingNumber: string) {
  const [row] = await db
    .select({ dealId: deals.id, authorizedAt: deals.authorizedAt })
    .from(evidence)
    .innerJoin(deals, eq(deals.id, evidence.dealId))
    .where(
      and(
        eq(evidence.type, "tracking"),
        sql`lower(${evidence.trackingNumber}) = lower(${trackingNumber})`,
        inArray(deals.state, [...WAITING_FOR_DELIVERY]),
      ),
    )
    .orderBy(desc(evidence.createdAt))
    .limit(1);
  return row;
}

export async function handleCourierWebhook(
  db: Db,
  raw: string,
  headers: Headers,
  config: CourierConfig,
  opts: { now?: Date; deps?: EngineDeps } = {},
): Promise<CourierOutcome> {
  if (config.mode !== "test") {
    return { status: 501, body: { error: "only COURIER_MODE=test is supported" } };
  }
  if (!config.testSecret) return { status: 503, body: { error: "TEST_COURIER_SECRET is not set" } };
  // Unverified events are refused and not stored, so a forged event cannot take a real event's id.
  if (!secretMatches(headers.get(SIGNATURE_HEADER), hmacHex(config.testSecret, raw))) {
    return { status: 401, body: { error: "signature does not match" } };
  }
  let event: CourierEvent;
  try {
    event = eventSchema.parse(JSON.parse(raw));
  } catch {
    return { status: 400, body: { error: "not a courier event" } };
  }

  const deal = await dealForTracking(db, event.tracking_number);
  const [stored] = await db
    .insert(courierEvents)
    .values({
      dealId: deal?.dealId ?? null,
      provider: "test",
      eventId: event.id,
      trackingNumber: event.tracking_number,
      status: event.status,
      rawJson: JSON.parse(raw) as unknown,
      verified: true,
    })
    .onConflictDoNothing({ target: courierEvents.eventId })
    .returning({ id: courierEvents.id });
  if (!stored) return { status: 200, body: { received: true, duplicate: true } };
  if (!deal) return { status: 200, body: { received: true, matched: false } };
  if (event.status !== "delivered") return { status: 200, body: { received: true, matched: true } };

  // The courier's time, but never in the future and never before the money was held.
  const now = opts.now ?? new Date();
  let deliveredAt = event.occurred_at ? new Date(event.occurred_at) : now;
  if (deliveredAt > now) deliveredAt = now;
  if (deal.authorizedAt && deliveredAt < deal.authorizedAt) deliveredAt = deal.authorizedAt;
  const result = await onCourierDelivered(
    deal.dealId,
    { verified: true, deliveredAt, eventId: event.id },
    opts.deps,
  );
  return { status: 200, body: { received: true, matched: true, result } };
}

/** A signed test-courier event, as the courier would send it. */
export function testCourierEvent(
  secret: string,
  input: { trackingNumber: string; status?: CourierEvent["status"]; at: Date },
) {
  const body = JSON.stringify({
    id: `test-${randomUUID()}`,
    tracking_number: input.trackingNumber,
    status: input.status ?? "delivered",
    occurred_at: input.at.toISOString(),
  } satisfies CourierEvent);
  return { body, headers: new Headers({ [SIGNATURE_HEADER]: hmacHex(secret, body) }) };
}

/**
 * The test courier "delivers": it signs an event and passes it through the same verification as
 * a real webhook, in-process (no call to our own public URL).
 */
export function sendTestCourierEvent(
  db: Db,
  config: CourierConfig,
  input: { trackingNumber: string; status?: CourierEvent["status"]; at: Date },
  deps?: EngineDeps,
) {
  const signed = testCourierEvent(config.testSecret, input);
  return handleCourierWebhook(db, signed.body, signed.headers, config, { now: input.at, deps });
}
