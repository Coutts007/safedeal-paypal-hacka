/**
 * Seed the two demo deals (BUILD_PLAN section 10; DECISIONS 2026-10-20). Run: `npm run db:seed`.
 *
 *   A: used Samsung Galaxy A15, US$95, Nairobi → Nakuru by G4S (demo ends CAPTURED)
 *   B: Nike Air Force 1, US$40, seller never ships (demo ends VOIDED)
 *
 * Each run adds two new DRAFT deals with terms v1 and a short fictional chat, and prints the seller
 * and buyer links. `--agreed` also confirms both sides so the deals are ready to pay.
 * Parties (Peter, 2026-10-21): A: David sells to Shemaya; B: Shemaya sells to David. Payees are
 * the sandbox seller emails from `.env`: A → seller A, B → seller B (falls back to seller A with
 * a warning). No secrets are printed.
 */
import "dotenv/config";
import { closeDb, getDb } from "../lib/db";
import { chatSources, deals, dealTerms } from "../lib/db/schema";
import { newPublicRef, newRoleToken } from "../lib/deals/ids";
import { parseDealTerms, termsHash } from "../lib/deals/terms";
import { serverEnv } from "../lib/env";
import { appendAudit } from "../lib/audit";
import { onTermsConfirmed } from "../lib/rules/engine";

const agreed = process.argv.includes("--agreed");

type Demo = {
  label: string;
  sellerName: string;
  buyerName: string;
  chat: string;
  languageMix: string;
  terms: unknown;
};

function demos(sellerA: string, sellerB: string): Demo[] {
  return [
    {
      label: "A",
      sellerName: "David",
      buyerName: "Shemaya",
      languageMix: "mixed",
      chat: [
        "[m1] Shemaya: Sasa David, ile Samsung A15 bado iko?",
        "[m2] David: Iko boss. Used 6 months, screen safi, no cracks. $95.",
        "[m3] Shemaya: Poa. Unatuma Nakuru?",
        "[m4] David: Yes, G4S from Nairobi. Nitatuma kesho.",
        "[m5] Shemaya: Sawa, nitalipa through SafeDeal. My number is [PHONE_1]",
      ].join("\n"),
      terms: {
        item: "Samsung Galaxy A15, used (6 months)",
        quantity: 1,
        price: { amount: "95.00", currency: "USD" },
        deliveryMethod: "courier",
        carrier: "G4S",
        shipBy: null,
        deliverBy: null,
        conditions: ["Screen has no cracks", "Ships from Nairobi to Nakuru"],
        payeeEmail: sellerA,
      },
    },
    {
      label: "B",
      sellerName: "Shemaya",
      buyerName: "David",
      languageMix: "english",
      chat: [
        "[m1] David: Shemaya, are the Air Force 1s size 42 still available?",
        "[m2] Shemaya: Yes, brand new in the box. $40.",
        "[m3] David: Deal. Please send by rider to Westlands.",
        "[m4] Shemaya: OK, I'll send them tomorrow.",
      ].join("\n"),
      terms: {
        item: "Nike Air Force 1, size 42, new in box",
        quantity: 1,
        price: { amount: "40.00", currency: "USD" },
        deliveryMethod: "rider",
        carrier: null,
        shipBy: null,
        deliverBy: null,
        conditions: ["Brand new in the box"],
        payeeEmail: sellerB,
      },
    },
  ];
}

async function main() {
  const env = serverEnv();
  const sellerA = env.SANDBOX_SELLER_A_EMAIL;
  if (!sellerA) throw new Error("Set SANDBOX_SELLER_A_EMAIL in .env first");
  const sellerB = env.SANDBOX_SELLER_B_EMAIL || sellerA;
  if (!env.SANDBOX_SELLER_B_EMAIL) {
    console.warn("SANDBOX_SELLER_B_EMAIL is not set; demo deal B pays seller A for now.");
  }
  const db = getDb();

  for (const demo of demos(sellerA, sellerB)) {
    const terms = parseDealTerms(demo.terms, env.MAX_DEAL_USD);
    const hash = termsHash(terms);
    const deal = await db.transaction(async (tx) => {
      const [d] = await tx
        .insert(deals)
        .values({
          publicRef: newPublicRef(),
          sellerToken: newRoleToken(),
          buyerToken: newRoleToken(),
          sellerName: demo.sellerName,
          buyerName: demo.buyerName,
        })
        .returning();
      await tx.insert(chatSources).values({
        dealId: d.id,
        redactedText: demo.chat,
        languageMix: demo.languageMix,
        uploadedBy: "seller",
      });
      await tx.insert(dealTerms).values({
        dealId: d.id,
        version: 1,
        termsJson: terms,
        termsHash: hash,
        sourceRefsJson: {},
        proposedBy: "ai",
      });
      await appendAudit(tx, {
        dealId: d.id,
        actor: "system",
        action: "deal.seeded",
        details: { demo: demo.label },
      });
      return d;
    });

    if (agreed) {
      await onTermsConfirmed(deal.id, { role: "seller", termsHash: hash });
      const res = await onTermsConfirmed(deal.id, { role: "buyer", termsHash: hash });
      if (res.outcome !== "moved")
        throw new Error(`could not agree deal ${demo.label}: ${res.outcome}`);
    }

    const link = (t: string) => `${env.APP_BASE_URL}/deal/${deal.publicRef}?t=${t}`;
    console.log(`\nDemo deal ${demo.label}: ${terms.item}, ${terms.price.amount} USD`);
    console.log(`  ${demo.sellerName} sells to ${demo.buyerName}`);
    console.log(`  ref ${deal.publicRef}, state ${agreed ? "AGREED" : "DRAFT"}`);
    console.log(`  ${demo.sellerName}'s link (seller): ${link(deal.sellerToken)}`);
    console.log(`  ${demo.buyerName}'s link (buyer):  ${link(deal.buyerToken)}`);
  }
  console.log("\n(The Deal Room page arrives in Phase 3; the links are for then.)");
}

main()
  .catch((e: Error) => {
    console.error(`Seed failed: ${e.message}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
