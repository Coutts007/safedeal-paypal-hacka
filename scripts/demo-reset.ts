/**
 * Fresh demo deals for recording the video or for judges (BUILD_PLAN Phase 6, item 6):
 * `npm run demo:reset` (locally) or `npx tsx scripts/demo-reset.ts` in the Render shell.
 *
 *   A: Samsung Galaxy A15, US$95, David → Shemaya by G4S (pay, track, deliver, confirm: CAPTURED)
 *   B: Nike Air Force 1, US$40, Shemaya → David by rider, ship-by in 15 minutes (pay, never ship:
 *      VOIDED by the next cron run after ship-by)
 *
 * Both deals are created already agreed by both parties, ready to pay. Earlier demo deals that
 * hold no money are cancelled; any that still hold money are listed and left alone (decide them on
 * the reviewer page). Options: --ship-minutes N (default 15). No secrets are printed.
 */
import "dotenv/config";
import { closeDb, getDb } from "../lib/db";
import { demoReset } from "../lib/deals/demo";
import { nairobiTime } from "../lib/deals/service";
import { serverEnv } from "../lib/env";

const i = process.argv.indexOf("--ship-minutes");
const shipMinutes = i >= 0 ? Number(process.argv[i + 1]) : 15;

async function main() {
  if (!Number.isFinite(shipMinutes) || shipMinutes < 2)
    throw new Error("--ship-minutes must be 2 or more");
  const env = serverEnv();
  const sellerA = env.SANDBOX_SELLER_A_EMAIL;
  if (!sellerA) throw new Error("Set SANDBOX_SELLER_A_EMAIL first");
  const sellerB = env.SANDBOX_SELLER_B_EMAIL || sellerA;

  const res = await demoReset(getDb(), {
    sellerA,
    sellerB,
    now: new Date(),
    shipMinutes,
    maxDealUsd: env.MAX_DEAL_USD,
  });
  if (res.cancelled.length)
    console.log(`Cancelled earlier demo deals: ${res.cancelled.join(", ")}`);
  for (const h of res.held) {
    console.log(`Left alone (money held, state ${h.state}): ${h.ref}. Decide it on /admin.`);
  }
  for (const { demo, deal, terms } of res.created) {
    const link = (t: string) => `${env.APP_BASE_URL}/deal/${deal.publicRef}?t=${t}`;
    console.log(
      `\nDemo deal ${demo.label}: ${terms.item}, US$${terms.price.amount} (agreed, ready to pay)`,
    );
    console.log(`  ${demo.sellerName} sells to ${demo.buyerName}, ref ${deal.publicRef}`);
    if (terms.shipBy) console.log(`  Ship-by: ${nairobiTime(new Date(terms.shipBy))} (Nairobi)`);
    console.log(`  ${demo.sellerName} (seller): ${link(deal.sellerToken)}`);
    console.log(`  ${demo.buyerName} (buyer):  ${link(deal.buyerToken)}`);
  }
  console.log(
    `\nDeal B: pay it now and never add tracking. After its ship-by, trigger the cron job in Render ("Trigger Run") or wait up to 10 minutes; the hold is voided.`,
  );
}

main()
  .catch((e: Error) => {
    console.error(`Demo reset failed: ${e.message}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
