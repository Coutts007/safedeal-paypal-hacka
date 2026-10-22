import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { fail, json } from "@/lib/http";
import { onSweep } from "@/lib/rules/engine";
import { processPendingWebhooks } from "@/lib/webhooks/paypal";

function secretMatches(given: string | null, expected: string): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Deadlines, reconciliation and leftover webhooks. Called by the Render cron job every 10 minutes. */
export async function POST(req: Request) {
  const secret = serverEnv().CRON_SECRET;
  if (!secret) return fail(503, "CRON_SECRET is not set");
  if (!secretMatches(req.headers.get("x-cron-secret"), secret)) return fail(401, "unauthorised");

  const db = getDb();
  const webhooks = await processPendingWebhooks(db);
  const results = await onSweep();
  const changed = results
    .filter((r) => r.result.outcome !== "unchanged" && r.result.outcome !== "skipped")
    .map((r) => ({ dealId: r.dealId, ...r.result }));
  return json({ checked: results.length, changed, webhooksProcessed: webhooks });
}
