import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { verifyAuditChain } from "@/lib/audit";
import { auditLog, deals, evidence, payments, reviews } from "@/lib/db/schema";
import { resetDb, testDb } from "@/tests/db";
import { addPayment, createDraftDeal, fakePaypal, paypalError, testDeps } from "@/tests/factories";
import {
  onAdminDecision,
  onBuyerApproved,
  onBuyerConfirmed,
  onBuyerProblem,
  onCancel,
  onCourierDelivered,
  onPaypalWebhook,
  onSweep,
  onTermsConfirmed,
  onTrackingSubmitted,
} from "./engine";

const H = 3_600_000;
const START = new Date("2026-11-01T09:00:00Z");
const { db, close } = testDb();
afterAll(close);
beforeEach(() => resetDb(db));

const getDeal = async (id: string) => (await db.select().from(deals).where(eq(deals.id, id)))[0];

/** A deal both parties agreed, with a PayPal order created for it. */
async function agreedDeal() {
  const fake = fakePaypal();
  const t = testDeps(db, fake.port, START);
  const { deal, hash } = await createDraftDeal(db);
  await onTermsConfirmed(deal.id, { role: "seller", termsHash: hash }, t.deps);
  await onTermsConfirmed(deal.id, { role: "buyer", termsHash: hash }, t.deps);
  const orderId = `ORDER-${deal.publicRef}`;
  await addPayment(db, deal.id, orderId);
  return { deal, hash, fake, orderId, authId: `AUTH-${orderId}`, ...t };
}

async function authorizedDeal() {
  const ctx = await agreedDeal();
  await onBuyerApproved(ctx.deal.id, ctx.orderId, ctx.deps);
  return ctx;
}

describe("terms confirmation", () => {
  it("agrees only when both confirm the same hash, then locks amount and payee from the terms", async () => {
    const fake = fakePaypal();
    const { deps } = testDeps(db, fake.port, START);
    const { deal, hash } = await createDraftDeal(db);

    expect(
      await onTermsConfirmed(deal.id, { role: "seller", termsHash: hash }, deps),
    ).toMatchObject({
      outcome: "unchanged",
    });
    expect(
      await onTermsConfirmed(deal.id, { role: "buyer", termsHash: "stale" }, deps),
    ).toMatchObject({ outcome: "rejected", reason: "the terms changed; review them again" });
    expect(await onTermsConfirmed(deal.id, { role: "buyer", termsHash: hash }, deps)).toMatchObject(
      {
        outcome: "moved",
        to: "AGREED",
      },
    );
    expect(await getDeal(deal.id)).toMatchObject({
      state: "AGREED",
      amount: "95.00",
      currency: "USD",
      payeeEmail: "seller-a@example.com",
      version: 1,
    });
  });

  it("can be cancelled before payment but not after", async () => {
    const { deal, deps } = await agreedDeal();
    expect(await onCancel(deal.id, "buyer", deps)).toMatchObject({
      outcome: "moved",
      to: "CANCELLED",
    });
    const other = await authorizedDeal();
    expect(await onCancel(other.deal.id, "seller", other.deps)).toMatchObject({
      outcome: "rejected",
    });
  });
});

describe("authorisation", () => {
  it("authorises with the fixed request id and sets default deadlines", async () => {
    const { deal, fake, deps, orderId, authId } = await agreedDeal();
    const res = await onBuyerApproved(deal.id, orderId, deps);
    expect(res).toMatchObject({ outcome: "moved", from: "AGREED", to: "AUTHORIZED" });
    expect(fake.port.authorizeOrder).toHaveBeenCalledWith(
      orderId,
      `deal-${deal.id}-authorize-v1`,
      deal.id,
    );
    const d = await getDeal(deal.id);
    expect(d.authorizedAt).toEqual(START);
    expect(d.shipBy).toEqual(new Date(START.getTime() + 48 * H));
    expect(d.deliverBy).toEqual(new Date(START.getTime() + 7 * 24 * H));
    const [p] = await db.select().from(payments).where(eq(payments.dealId, deal.id));
    expect(p).toMatchObject({ authorizationId: authId, status: "CREATED" });
  });

  it("refuses an order id that is not the deal's own, without calling PayPal", async () => {
    const { deal, fake, deps } = await agreedDeal();
    expect(await onBuyerApproved(deal.id, "SOMEONE-ELSES-ORDER", deps)).toMatchObject({
      outcome: "rejected",
    });
    expect(fake.port.getOrder).not.toHaveBeenCalled();
    expect(fake.port.authorizeOrder).not.toHaveBeenCalled();
  });

  it("refuses when PayPal reports a different amount or an unapproved order", async () => {
    const { deal, fake, deps, orderId } = await agreedDeal();
    fake.port.getOrder.mockResolvedValueOnce({
      ok: true,
      status: 200,
      debugId: "dbg",
      value: {
        id: orderId,
        status: "APPROVED",
        purchase_units: [{ custom_id: deal.id, amount: { currency_code: "USD", value: "1.00" } }],
      },
    });
    expect(await onBuyerApproved(deal.id, orderId, deps)).toMatchObject({ outcome: "rejected" });
    fake.port.getOrder.mockResolvedValueOnce({
      ok: true,
      status: 200,
      debugId: "dbg",
      value: { id: orderId, status: "PAYER_ACTION_REQUIRED" },
    });
    expect(await onBuyerApproved(deal.id, orderId, deps)).toMatchObject({ outcome: "rejected" });
    expect(fake.port.authorizeOrder).not.toHaveBeenCalled();
  });

  it("moves to FUNDING_FAILED when PayPal declines", async () => {
    const { deal, fake, deps, orderId } = await agreedDeal();
    fake.port.authorizeOrder.mockResolvedValueOnce(paypalError(422, "INSTRUMENT_DECLINED"));
    expect(await onBuyerApproved(deal.id, orderId, deps)).toMatchObject({
      outcome: "failed",
      to: "FUNDING_FAILED",
      issue: "INSTRUMENT_DECLINED",
    });
  });
});

describe("capture", () => {
  it("captures exactly once when the buyer confirms twice at the same moment", async () => {
    const { deal, fake, deps, authId } = await authorizedDeal();
    fake.port.capture.mockImplementation(async (authId: string) => {
      await new Promise((r) => setTimeout(r, 100));
      return {
        ok: true,
        status: 201,
        debugId: "dbg",
        value: { id: `CAP-${authId}`, status: "COMPLETED" },
      };
    });
    const results = await Promise.all([
      onBuyerConfirmed(deal.id, deps),
      onBuyerConfirmed(deal.id, deps),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["moved", "rejected"]);
    expect(fake.port.capture).toHaveBeenCalledTimes(1);
    expect(fake.port.capture).toHaveBeenCalledWith(authId, `deal-${deal.id}-capture-v1`, deal.id);
    expect((await getDeal(deal.id)).state).toBe("CAPTURED");
    const [p] = await db.select().from(payments).where(eq(payments.dealId, deal.id));
    expect(p).toMatchObject({ status: "CAPTURED", captureId: `CAP-${authId}` });
  });

  it("keeps the state on a retryable error and retries with the same request id", async () => {
    const { deal, fake, deps } = await authorizedDeal();
    fake.port.capture.mockResolvedValueOnce(paypalError(503, "SERVICE_UNAVAILABLE", true));
    expect(await onBuyerConfirmed(deal.id, deps)).toMatchObject({ outcome: "pending" });
    expect((await getDeal(deal.id)).state).toBe("AUTHORIZED");
    expect(await onBuyerConfirmed(deal.id, deps)).toMatchObject({
      outcome: "moved",
      to: "CAPTURED",
    });
    const keys = fake.port.capture.mock.calls.map((c) => c[1]);
    expect(keys).toEqual([`deal-${deal.id}-capture-v1`, `deal-${deal.id}-capture-v1`]);
  });

  it("goes to CAPTURE_FAILED on a refusal, opens a review, and an admin retry uses a new key", async () => {
    const { deal, fake, deps } = await authorizedDeal();
    fake.port.capture.mockResolvedValueOnce(paypalError(422, "PAYEE_ACCOUNT_RESTRICTED"));
    expect(await onBuyerConfirmed(deal.id, deps)).toMatchObject({
      outcome: "failed",
      to: "CAPTURE_FAILED",
    });
    expect(await getDeal(deal.id)).toMatchObject({ state: "CAPTURE_FAILED", settleAttempt: 2 });
    expect(await db.select().from(reviews).where(eq(reviews.dealId, deal.id))).toHaveLength(1);

    expect(
      await onAdminDecision(
        deal.id,
        { decision: "capture", reason: "seller fixed account", admin: "peter" },
        deps,
      ),
    ).toMatchObject({ outcome: "moved", to: "CAPTURED" });
    expect(fake.port.capture.mock.calls[1][1]).toBe(`deal-${deal.id}-capture-v2`);
    const [review] = await db.select().from(reviews).where(eq(reviews.dealId, deal.id));
    expect(review).toMatchObject({ decision: "capture", decidedBy: "peter" });
  });

  it("treats AUTHORIZATION_ALREADY_CAPTURED as success after re-reading the authorisation", async () => {
    const { deal, fake, deps, authId } = await authorizedDeal();
    fake.authStatus.set(authId, "CAPTURED");
    fake.port.capture.mockResolvedValueOnce(paypalError(422, "AUTHORIZATION_ALREADY_CAPTURED"));
    expect(await onBuyerConfirmed(deal.id, deps)).toMatchObject({
      outcome: "moved",
      to: "CAPTURED",
    });
  });
});

describe("sweep", () => {
  it("voids after ship_by without tracking, once, even when two sweeps run together", async () => {
    const { deal, fake, deps, advance, authId } = await authorizedDeal();
    advance(48 * H);
    fake.port.voidAuth.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return { ok: true, status: 200, debugId: "dbg", value: null };
    });
    const [a, b] = await Promise.all([onSweep(deps), onSweep(deps)]);
    const outcomes = [...a, ...b].map((r) => r.result.outcome).sort();
    expect(outcomes).toContain("moved");
    expect(fake.port.voidAuth).toHaveBeenCalledTimes(1);
    expect(fake.port.voidAuth).toHaveBeenCalledWith(authId, `deal-${deal.id}-void-v1`, deal.id);
    expect((await getDeal(deal.id)).state).toBe("VOIDED");
  });

  it("marks a deal EXPIRED when PayPal reports the hold voided", async () => {
    const { deal, fake, deps, authId } = await authorizedDeal();
    fake.authStatus.set(authId, "VOIDED");
    await onSweep(deps);
    expect((await getDeal(deal.id)).state).toBe("EXPIRED");
    expect(fake.port.voidAuth).not.toHaveBeenCalled();
  });

  it("runs the happy path: tracking → delivered → capture after the inspection window", async () => {
    const { deal, fake, deps, advance } = await authorizedDeal();
    advance(H);
    expect(
      await onTrackingSubmitted(deal.id, { carrier: "G4S", trackingNumber: "G4S-123" }, deps),
    ).toMatchObject({ to: "SHIPPED" });
    expect(await db.select().from(evidence).where(eq(evidence.dealId, deal.id))).toHaveLength(1);

    advance(24 * H);
    const deliveredAt = deps.now();
    expect(
      await onCourierDelivered(deal.id, { verified: true, deliveredAt, eventId: "ev1" }, deps),
    ).toMatchObject({ to: "DELIVERED" });

    advance(47 * H);
    await onSweep(deps);
    expect((await getDeal(deal.id)).state).toBe("DELIVERED");
    advance(H);
    await onSweep(deps);
    expect((await getDeal(deal.id)).state).toBe("CAPTURED");
    expect(fake.port.capture).toHaveBeenCalledTimes(1);
    expect(await verifyAuditChain(db)).toMatchObject({ ok: true });
  });

  it("never captures a shipped deal on time alone", async () => {
    const { deal, fake, deps, advance } = await authorizedDeal();
    await onTrackingSubmitted(deal.id, { carrier: "G4S", trackingNumber: "T" }, deps);
    advance(7 * 24 * H);
    await onSweep(deps);
    expect((await getDeal(deal.id)).state).toBe("IN_REVIEW");
    expect(fake.port.capture).not.toHaveBeenCalled();
  });
});

describe("reconciliation (a reply from PayPal was lost)", () => {
  it("a capture that went through after a timeout is recorded as CAPTURED by the sweep", async () => {
    const { deal, fake, deps, authId } = await authorizedDeal();
    fake.port.capture.mockImplementationOnce(async (id) => {
      fake.authStatus.set(id, "CAPTURED"); // PayPal did it, but we never heard back
      return paypalError(null, "PayPal unreachable", true);
    });
    expect(await onBuyerConfirmed(deal.id, deps)).toMatchObject({ outcome: "pending" });
    await onSweep(deps);
    expect((await getDeal(deal.id)).state).toBe("CAPTURED");
    const [p] = await db.select().from(payments).where(eq(payments.dealId, deal.id));
    expect(p.status).toBe("CAPTURED");
    expect(fake.authStatus.get(authId)).toBe("CAPTURED");
  });

  it("a void that went through after a timeout ends as VOIDED, not EXPIRED", async () => {
    const { deal, fake, deps, advance } = await authorizedDeal();
    advance(48 * H);
    fake.port.voidAuth.mockImplementationOnce(async (id) => {
      fake.authStatus.set(id, "VOIDED");
      return paypalError(504, "GATEWAY_TIMEOUT", true);
    });
    expect((await onSweep(deps))[0].result).toMatchObject({ outcome: "pending" });
    await onSweep(deps);
    expect((await getDeal(deal.id)).state).toBe("VOIDED");
  });

  it("a capture SafeDeal never sent goes to review", async () => {
    const { deal, fake, deps, authId } = await authorizedDeal();
    fake.authStatus.set(authId, "CAPTURED");
    await onSweep(deps);
    expect((await getDeal(deal.id)).state).toBe("IN_REVIEW");
    expect(await db.select().from(reviews).where(eq(reviews.dealId, deal.id))).toHaveLength(1);
  });
});

describe("review", () => {
  it("buyer problem opens a review with the note; admin void closes it", async () => {
    const { deal, deps } = await authorizedDeal();
    await onTrackingSubmitted(deal.id, { carrier: "G4S", trackingNumber: "T" }, deps);
    expect(await onBuyerProblem(deal.id, "box was empty", deps)).toMatchObject({ to: "IN_REVIEW" });
    expect(await onBuyerConfirmed(deal.id, deps)).toMatchObject({ outcome: "rejected" });
    expect(
      await onAdminDecision(
        deal.id,
        { decision: "void", reason: "photo shows empty box", admin: "peter" },
        deps,
      ),
    ).toMatchObject({ outcome: "moved", to: "VOIDED" });
    const [review] = await db.select().from(reviews).where(eq(reviews.dealId, deal.id));
    expect(review).toMatchObject({ reason: "buyer reported a problem", decision: "void" });
  });
});

describe("PayPal webhooks", () => {
  it("re-reads the authorisation before acting on a VOIDED event", async () => {
    const { deal, fake, deps, authId } = await authorizedDeal();
    const event = {
      id: "WH-1",
      event_type: "PAYMENT.AUTHORIZATION.VOIDED",
      resource: { id: authId },
    };
    expect(await onPaypalWebhook(event, deps)).toMatchObject({ outcome: "rejected" });
    expect((await getDeal(deal.id)).state).toBe("AUTHORIZED");
    fake.authStatus.set(authId, "VOIDED");
    expect(await onPaypalWebhook(event, deps)).toMatchObject({ outcome: "moved", to: "EXPIRED" });
  });

  it("moves a captured deal to DISPUTED when PayPal confirms the dispute", async () => {
    const { deal, fake, deps, authId } = await authorizedDeal();
    await onBuyerConfirmed(deal.id, deps);
    fake.port.getDispute.mockResolvedValueOnce({
      ok: true,
      status: 200,
      debugId: "dbg",
      value: { id: "PP-D-1", status: "OPEN", captureIds: [`CAP-${authId}`] },
    });
    const res = await onPaypalWebhook(
      { id: "WH-2", event_type: "CUSTOMER.DISPUTE.CREATED", resource: { dispute_id: "PP-D-1" } },
      deps,
    );
    expect(res).toMatchObject({ outcome: "moved", to: "DISPUTED" });
  });

  it("ignores event types that change nothing", async () => {
    const { deps } = await authorizedDeal();
    expect(
      await onPaypalWebhook(
        { id: "WH-3", event_type: "CHECKOUT.ORDER.APPROVED", resource: {} },
        deps,
      ),
    ).toMatchObject({ outcome: "ignored" });
  });
});

describe("audit", () => {
  it("logs rejected triggers and keeps the chain valid", async () => {
    const { deal, deps } = await agreedDeal();
    await onBuyerConfirmed(deal.id, deps);
    const rows = await db.select().from(auditLog).where(eq(auditLog.dealId, deal.id));
    expect(rows.map((r) => r.action)).toContain("trigger.rejected");
    expect(await verifyAuditChain(db)).toMatchObject({ ok: true });
  });
});
