/**
 * Why has a deal not moved? Read-only: `npx tsx scripts/deal-status.ts <REF>` (or `npm run
 * deal:status -- <REF>`), locally or in the Render shell. With no ref it lists the deals where
 * PayPal holds money. Prints the deadlines, whether the sweep has reached the deal (every sweep
 * asks PayPal for the hold's status), the PayPal calls and the audit trail. Never prints chat
 * text, tokens or secrets.
 */
import "dotenv/config";
import { and, desc, eq, inArray } from "drizzle-orm";
import { closeDb, getDb } from "../lib/db";
import { auditLog, deals, evidence, paymentRequests, payments } from "../lib/db/schema";
import { nairobiTime } from "../lib/deals/service";
import { serverEnv } from "../lib/env";
import { HELD_STATES } from "../lib/rules/machine";

const at = (d: Date | null) => (d ? nairobiTime(d) : "-");

async function list(db: ReturnType<typeof getDb>, now: Date) {
  const held = await db
    .select()
    .from(deals)
    .where(inArray(deals.state, [...HELD_STATES]));
  if (!held.length) console.log("No deal holds money right now.");
  for (const d of held) {
    const due = d.state === "AUTHORIZED" && d.shipBy && now >= d.shipBy ? "  ship-by PASSED" : "";
    console.log(`${d.publicRef}  ${d.state}  ship-by ${at(d.shipBy)}${due}`);
  }
}

async function show(db: ReturnType<typeof getDb>, ref: string, now: Date) {
  const [d] = await db.select().from(deals).where(eq(deals.publicRef, ref));
  if (!d) throw new Error(`No deal with ref ${ref}`);
  const [tracking] = await db
    .select({ id: evidence.id })
    .from(evidence)
    .where(and(eq(evidence.dealId, d.id), eq(evidence.type, "tracking")))
    .limit(1);
  const [lastCheck] = await db
    .select({ at: paymentRequests.createdAt })
    .from(paymentRequests)
    .where(and(eq(paymentRequests.dealId, d.id), eq(paymentRequests.action, "get_auth")))
    .orderBy(desc(paymentRequests.createdAt))
    .limit(1);

  console.log(`Deal ${d.publicRef}: ${d.state}`);
  console.log(`  now (Nairobi)      ${at(now)}`);
  console.log(`  DEMO_TIME_SCALE    ${serverEnv().DEMO_TIME_SCALE}`);
  console.log(`  paid (held) at     ${at(d.authorizedAt)}`);
  console.log(
    `  ship-by            ${at(d.shipBy)}${d.shipBy && now >= d.shipBy ? "  (passed)" : ""}`,
  );
  console.log(`  tracking added     ${tracking ? "yes" : "no"}`);
  console.log(`  delivered at       ${at(d.deliveredAt)}`);
  console.log(`  last sweep check   ${lastCheck ? at(lastCheck.at) : "never"}`);

  const verdict = (() => {
    if (d.state !== "AUTHORIZED") return `not AUTHORIZED, so a missed ship-by does not apply`;
    if (!d.shipBy) return "no ship-by date is set";
    if (now < d.shipBy) return `ship-by has not passed yet`;
    if (tracking) return "the seller added tracking, so the deliver-by date applies instead";
    if (d.deliveredAt) return "a delivery is recorded";
    return "the next sweep should void the hold. If the last sweep check is before ship-by, the cron job has not run since";
  })();
  console.log(`  => ${verdict}`);

  const pays = await db.select().from(payments).where(eq(payments.dealId, d.id));
  for (const p of pays) {
    console.log(`  payment #${p.attempt}: ${p.status} (authorization ${p.authorizationId ?? "-"})`);
  }

  const calls = await db
    .select()
    .from(paymentRequests)
    .where(eq(paymentRequests.dealId, d.id))
    .orderBy(desc(paymentRequests.createdAt))
    .limit(10);
  console.log("PayPal calls (newest first):");
  for (const c of calls) {
    const debug = c.debugId ? ` debug_id ${c.debugId}` : "";
    console.log(`  ${at(c.createdAt)}  ${c.action}  http ${c.httpStatus ?? "unreachable"}${debug}`);
  }

  const audit = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.dealId, d.id))
    .orderBy(desc(auditLog.id))
    .limit(12);
  console.log("Audit (newest first):");
  for (const a of audit) {
    const x = a.detailsJson as Record<string, unknown>;
    const why = [x.from && x.to ? `${x.from} → ${x.to}` : null, x.reason, x.issue]
      .filter(Boolean)
      .join("; ");
    console.log(`  ${at(a.createdAt)}  ${a.actor}  ${a.action}${why ? `  (${why})` : ""}`);
  }
}

async function main() {
  const db = getDb();
  const now = new Date();
  const ref = process.argv[2];
  if (ref) await show(db, ref.trim().toUpperCase(), now);
  else await list(db, now);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
