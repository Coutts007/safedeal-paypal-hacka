/**
 * Seed the two demo deals (BUILD_PLAN Phase 6; DECISIONS 2026-10-20). Run: `npm run db:seed`.
 *
 *   A: used Samsung Galaxy A15, US$95, Nairobi → Nakuru by G4S (demo ends CAPTURED)
 *   B: Nike Air Force 1, US$40, seller never ships (demo ends VOIDED)
 *
 * Each run adds two new DRAFT deals with terms v1 and a short fictional chat (lib/deals/demo.ts),
 * and prints the seller and buyer links. `--agreed` also confirms both sides so the deals are ready
 * to pay. Payees are the sandbox seller emails from `.env`: A → seller A, B → seller B (falls back
 * to seller A with a warning). No secrets are printed. For fresh deals on Render, use `npm run demo:reset`.
 */
import "dotenv/config";
import { closeDb, getDb } from "../lib/db";
import { agreeDemoDeal, demoDeals, insertDemoDeal } from "../lib/deals/demo";
import { serverEnv } from "../lib/env";

const agreed = process.argv.includes("--agreed");

async function main() {
  const env = serverEnv();
  const sellerA = env.SANDBOX_SELLER_A_EMAIL;
  if (!sellerA) throw new Error("Set SANDBOX_SELLER_A_EMAIL in .env first");
  const sellerB = env.SANDBOX_SELLER_B_EMAIL || sellerA;
  if (!env.SANDBOX_SELLER_B_EMAIL) {
    console.warn("SANDBOX_SELLER_B_EMAIL is not set; demo deal B pays seller A for now.");
  }
  const db = getDb();

  for (const demo of demoDeals({ sellerA, sellerB, shipByB: null })) {
    const { deal, terms, hash } = await insertDemoDeal(db, demo, env.MAX_DEAL_USD);
    if (agreed) await agreeDemoDeal(deal.id, hash);

    const link = (t: string) => `${env.APP_BASE_URL}/deal/${deal.publicRef}?t=${t}`;
    console.log(`\nDemo deal ${demo.label}: ${terms.item}, ${terms.price.amount} USD`);
    console.log(`  ${demo.sellerName} sells to ${demo.buyerName}`);
    console.log(`  ref ${deal.publicRef}, state ${agreed ? "AGREED" : "DRAFT"}`);
    console.log(`  ${demo.sellerName}'s link (seller): ${link(deal.sellerToken)}`);
    console.log(`  ${demo.buyerName}'s link (buyer):  ${link(deal.buyerToken)}`);
  }
  console.log("\nOpen each link in its own browser window (one per party).");
}

main()
  .catch((e: Error) => {
    console.error(`Seed failed: ${e.message}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
