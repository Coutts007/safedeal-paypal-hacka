import { eq, inArray } from "drizzle-orm";
import { appendAudit } from "@/lib/audit";
import type { Db } from "@/lib/db";
import { auditLog, chatSources, deals, dealTerms } from "@/lib/db/schema";
import { onCancel, onTermsConfirmed, type EngineDeps } from "@/lib/rules/engine";
import { newPublicRef, newRoleToken } from "./ids";
import { parseDealTerms, termsHash } from "./terms";

// The two demo deals (BUILD_PLAN Phase 6; DECISIONS 2026-10-20), used by `npm run db:seed` and
// `npm run demo:reset`. Parties (Peter, 2026-10-21): A: David sells to Shemaya; B: Shemaya sells
// to David. The chats are fictional and already redacted.

export type Demo = {
  label: "A" | "B";
  sellerName: string;
  buyerName: string;
  chat: string;
  languageMix: string;
  terms: unknown;
};

export function demoDeals(opts: {
  sellerA: string;
  sellerB: string;
  /** Ship-by for deal B (the void demo); null leaves the default window after payment. */
  shipByB: Date | null;
}): Demo[] {
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
        payeeEmail: opts.sellerA,
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
        shipBy: opts.shipByB?.toISOString() ?? null,
        deliverBy: null,
        conditions: ["Brand new in the box"],
        payeeEmail: opts.sellerB,
      },
    },
  ];
}

/** Insert one demo deal as a DRAFT with terms v1 and its chat. */
export async function insertDemoDeal(db: Db, demo: Demo, maxDealUsd: number) {
  const terms = parseDealTerms(demo.terms, maxDealUsd);
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
  return { deal, terms, hash };
}

/** Both parties confirm the terms, so the deal is ready to pay. */
export async function agreeDemoDeal(dealId: string, hash: string, deps?: EngineDeps) {
  await onTermsConfirmed(dealId, { role: "seller", termsHash: hash }, deps);
  const res = await onTermsConfirmed(dealId, { role: "buyer", termsHash: hash }, deps);
  if (res.outcome !== "moved") throw new Error(`could not agree demo deal: ${res.outcome}`);
}

/** States in which an earlier demo deal can be cancelled: no money is held. */
const CANCELLABLE = ["DRAFT", "AGREED", "FUNDING_FAILED"] as const;

/**
 * Fresh demo deals: earlier demo deals that hold no money are cancelled, deals
 * where PayPal holds money are left alone and listed (a reviewer decides those; this script never
 * moves money), then deals A and B are created and agreed by both parties.
 */
export async function demoReset(
  db: Db,
  opts: {
    sellerA: string;
    sellerB: string;
    now: Date;
    /** Deal B's ship-by, this many minutes after the reset. */
    shipMinutes: number;
    maxDealUsd: number;
    deps?: EngineDeps;
  },
) {
  const seeded = await db
    .select({ dealId: auditLog.dealId })
    .from(auditLog)
    .where(eq(auditLog.action, "deal.seeded"));
  const ids = [...new Set(seeded.map((s) => s.dealId).filter((x): x is string => !!x))];
  const earlier = ids.length ? await db.select().from(deals).where(inArray(deals.id, ids)) : [];

  const cancelled: string[] = [];
  const held: { ref: string; state: string }[] = [];
  for (const d of earlier) {
    if ((CANCELLABLE as readonly string[]).includes(d.state)) {
      await onCancel(d.id, "seller", opts.deps);
      cancelled.push(d.publicRef);
    } else if (!["CANCELLED", "CAPTURED", "VOIDED", "EXPIRED", "CLOSED"].includes(d.state)) {
      held.push({ ref: d.publicRef, state: d.state });
    }
  }

  const shipByB = new Date(opts.now.getTime() + opts.shipMinutes * 60_000);
  const created = [];
  for (const demo of demoDeals({ sellerA: opts.sellerA, sellerB: opts.sellerB, shipByB })) {
    const { deal, terms, hash } = await insertDemoDeal(db, demo, opts.maxDealUsd);
    await agreeDemoDeal(deal.id, hash, opts.deps);
    created.push({ demo, deal, terms });
  }
  return { cancelled, held, created };
}
