import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { verifyAuditChain } from "@/lib/audit";
import { auditLog, confirmations, deals, dealTerms, extensions, reviews } from "@/lib/db/schema";
import { handoverCode } from "@/lib/deals/handover";
import { dealTermsSchema } from "@/lib/deals/terms";
import { resetDb, testDb } from "@/tests/db";
import {
  addPayment,
  createDraftDeal,
  fakePaypal,
  TEST_HANDOVER_SECRET,
  testDeps,
} from "@/tests/factories";
import {
  onBuyerApproved,
  onBuyerProblem,
  onExtensionDecided,
  onExtensionProposed,
  onHandoverCode,
  onHandoverUnlock,
  onSweep,
  onTermsConfirmed,
  onTrackingSubmitted,
} from "./engine";

// Phase 5: handover code and Extend delivery date (BUILD_PLAN section 7.1), end to end through
// the engine and a real database.

const H = 3_600_000;
const D = 24 * H;
const START = new Date("2026-11-01T09:00:00Z");
const { db, close } = testDb();
afterAll(close);
beforeEach(() => resetDb(db));

const getDeal = async (id: string) => (await db.select().from(deals).where(eq(deals.id, id)))[0];

async function authorizedDeal() {
  const fake = fakePaypal();
  const t = testDeps(db, fake.port, START);
  const { deal, hash } = await createDraftDeal(db);
  await onTermsConfirmed(deal.id, { role: "seller", termsHash: hash }, t.deps);
  await onTermsConfirmed(deal.id, { role: "buyer", termsHash: hash }, t.deps);
  await addPayment(db, deal.id, `ORDER-${deal.publicRef}`);
  await onBuyerApproved(deal.id, `ORDER-${deal.publicRef}`, t.deps);
  return { deal, fake, ...t, code: handoverCode(deal.id, TEST_HANDOVER_SECRET) };
}

async function shippedDeal() {
  const ctx = await authorizedDeal();
  await onTrackingSubmitted(ctx.deal.id, { carrier: "G4S", trackingNumber: "G4S-123" }, ctx.deps);
  return ctx;
}

const wrongCode = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

describe("handover code", () => {
  it("stores only a hash at authorisation; the right code is a verified delivery, then paid", async () => {
    const { deal, deps, advance, fake, code } = await authorizedDeal();
    const held = await getDeal(deal.id);
    expect(held.handoverCodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(held.handoverCodeHash).not.toContain(code);

    expect(await onHandoverCode(deal.id, code, deps)).toMatchObject({
      outcome: "moved",
      from: "AUTHORIZED",
      to: "DELIVERED",
    });
    expect(await getDeal(deal.id)).toMatchObject({
      deliveryProof: "handover_code",
      deliveredAt: START,
    });
    expect(fake.port.capture).not.toHaveBeenCalled();

    advance(49 * H);
    await onSweep(deps);
    expect((await getDeal(deal.id)).state).toBe("CAPTURED");
    // The code never reaches the audit log.
    const rows = await db.select().from(auditLog).where(eq(auditLog.dealId, deal.id));
    expect(JSON.stringify(rows)).not.toContain(code);
  });

  it("counts wrong codes, locks on the 5th and flags the deal; an admin can unlock", async () => {
    const { deal, deps, code } = await shippedDeal();
    for (let i = 1; i <= 4; i++) {
      const r = await onHandoverCode(deal.id, wrongCode(code), deps);
      expect(r).toMatchObject({ outcome: "rejected" });
      expect(r.outcome === "rejected" && r.reason).toContain(`${5 - i} tr`);
    }
    expect(await onHandoverCode(deal.id, "12-34", deps)).toMatchObject({ outcome: "rejected" });
    expect(await getDeal(deal.id)).toMatchObject({ handoverAttempts: 5, handoverLocked: true });
    const [locked] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.dealId, deal.id), eq(auditLog.action, "handover.locked")));
    expect(locked).toBeDefined();

    // Locked: even the right code is refused until an admin looks.
    expect(await onHandoverCode(deal.id, code, deps)).toMatchObject({ outcome: "rejected" });
    expect((await getDeal(deal.id)).state).toBe("SHIPPED");

    expect(await onHandoverUnlock(deal.id, { reason: "", admin: "admin" }, deps)).toMatchObject({
      ok: false,
    });
    expect(
      await onHandoverUnlock(
        deal.id,
        { reason: "spoke to both on the phone", admin: "admin" },
        deps,
      ),
    ).toMatchObject({ ok: true });
    expect(await onHandoverCode(deal.id, code, deps)).toMatchObject({ to: "DELIVERED" });
    expect(await verifyAuditChain(db)).toMatchObject({ ok: true });
  });

  it("counts as late proof after a deliver-by review, and closes the review", async () => {
    const { deal, deps, advance, code } = await shippedDeal();
    advance(7 * D + H);
    await onSweep(deps);
    expect((await getDeal(deal.id)).state).toBe("IN_REVIEW");
    expect(await onHandoverCode(deal.id, code, deps)).toMatchObject({ to: "DELIVERED" });
    const [review] = await db.select().from(reviews).where(eq(reviews.dealId, deal.id));
    expect(review.decision).toBe("cleared");
  });

  it("cannot clear a buyer complaint", async () => {
    const { deal, deps, code } = await shippedDeal();
    await onBuyerProblem(deal.id, "The seller has not come", deps);
    expect(await onHandoverCode(deal.id, code, deps)).toMatchObject({ outcome: "rejected" });
    expect((await getDeal(deal.id)).state).toBe("IN_REVIEW");
  });
});

describe("extend delivery date", () => {
  it("the other party accepts: new terms version, both confirmed, the old deadline no longer applies", async () => {
    const { deal, deps, advance } = await shippedDeal();
    const newDate = new Date(START.getTime() + 10 * D);
    expect(
      await onExtensionProposed(deal.id, { role: "seller", newDeliverBy: newDate }, deps),
    ).toMatchObject({ outcome: "unchanged" });
    const [ext] = await db.select().from(extensions).where(eq(extensions.dealId, deal.id));
    expect(ext).toMatchObject({ status: "proposed", proposedBy: "seller" });

    expect(
      await onExtensionDecided(
        deal.id,
        { role: "seller", extensionId: ext.id, accept: true },
        deps,
      ),
    ).toMatchObject({ outcome: "rejected" });
    expect(
      await onExtensionDecided(deal.id, { role: "buyer", extensionId: ext.id, accept: true }, deps),
    ).toMatchObject({ outcome: "unchanged", state: "SHIPPED" });

    const after = await getDeal(deal.id);
    expect(after.deliverBy).toEqual(newDate);
    const [v2] = await db
      .select()
      .from(dealTerms)
      .where(and(eq(dealTerms.dealId, deal.id), eq(dealTerms.version, 2)));
    expect(dealTermsSchema.parse(v2.termsJson).deliverBy).toBe(newDate.toISOString());
    expect(after.confirmedTermsId).toBe(v2.id);
    const confirmed = await db.select().from(confirmations).where(eq(confirmations.termsId, v2.id));
    expect(confirmed.map((c) => c.role).sort()).toEqual(["buyer", "seller"]);
    expect((await db.select().from(extensions).where(eq(extensions.id, ext.id)))[0]).toMatchObject({
      status: "accepted",
      termsId: v2.id,
    });
    // Amount and payee did not change.
    expect(after).toMatchObject({ amount: "95.00", payeeEmail: "seller-a@example.com" });

    advance(8 * D);
    await onSweep(deps);
    expect((await getDeal(deal.id)).state).toBe("SHIPPED");
    advance(3 * D);
    await onSweep(deps);
    expect((await getDeal(deal.id)).state).toBe("IN_REVIEW");
  });

  it("brings a late deal back from a deliver-by review", async () => {
    const { deal, deps, advance } = await shippedDeal();
    advance(7 * D + H);
    await onSweep(deps);
    const newDate = new Date(START.getTime() + 12 * D);
    await onExtensionProposed(deal.id, { role: "buyer", newDeliverBy: newDate }, deps);
    const [ext] = await db.select().from(extensions).where(eq(extensions.dealId, deal.id));
    expect(
      await onExtensionDecided(
        deal.id,
        { role: "seller", extensionId: ext.id, accept: true },
        deps,
      ),
    ).toMatchObject({ outcome: "moved", from: "IN_REVIEW", to: "SHIPPED" });
    const [review] = await db.select().from(reviews).where(eq(reviews.dealId, deal.id));
    expect(review.decision).toBe("cleared");
  });

  it("refuses after a buyer complaint, at day 26 or later, and before shipping", async () => {
    const auth = await authorizedDeal();
    expect(
      await onExtensionProposed(
        auth.deal.id,
        { role: "seller", newDeliverBy: new Date(START.getTime() + 9 * D) },
        auth.deps,
      ),
    ).toMatchObject({ outcome: "rejected" });

    await resetDb(db);
    const { deal, deps } = await shippedDeal();
    expect(
      await onExtensionProposed(
        deal.id,
        { role: "seller", newDeliverBy: new Date(START.getTime() + 26 * D) },
        deps,
      ),
    ).toMatchObject({ outcome: "rejected", reason: expect.stringContaining("day 26") });
    await onBuyerProblem(deal.id, "Wrong colour", deps);
    expect(
      await onExtensionProposed(
        deal.id,
        { role: "seller", newDeliverBy: new Date(START.getTime() + 9 * D) },
        deps,
      ),
    ).toMatchObject({ outcome: "rejected" });
  });

  it("a rejection keeps the old date; a newer proposal replaces an open one; the sweep expires stale ones", async () => {
    const { deal, deps, advance } = await shippedDeal();
    const at = (days: number) => new Date(START.getTime() + days * D);
    await onExtensionProposed(deal.id, { role: "seller", newDeliverBy: at(10) }, deps);
    const [first] = await db.select().from(extensions).where(eq(extensions.dealId, deal.id));
    await onExtensionDecided(
      deal.id,
      { role: "buyer", extensionId: first.id, accept: false },
      deps,
    );
    expect((await getDeal(deal.id)).deliverBy).toEqual(at(7));

    await onExtensionProposed(deal.id, { role: "seller", newDeliverBy: at(9) }, deps);
    await onExtensionProposed(deal.id, { role: "seller", newDeliverBy: at(11) }, deps);
    const rows = await db.select().from(extensions).where(eq(extensions.dealId, deal.id));
    expect(rows.map((r) => r.status).sort()).toEqual(["expired", "proposed", "rejected"]);

    advance(11 * D + H);
    await onSweep(deps);
    const open = await db
      .select()
      .from(extensions)
      .where(and(eq(extensions.dealId, deal.id), eq(extensions.status, "proposed")));
    expect(open).toEqual([]);
  });
});
