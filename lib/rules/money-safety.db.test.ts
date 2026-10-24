import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminDeal, adminQueue } from "@/lib/admin/queries";
import { verifyAuditChain } from "@/lib/audit";
import { deals, extensions, payments } from "@/lib/db/schema";
import { handoverCode } from "@/lib/deals/handover";
import { dealView, type Role } from "@/lib/deals/service";
import { resetDb, testDb } from "@/tests/db";
import {
  addPayment,
  createDraftDeal,
  fakePaypal,
  TEST_HANDOVER_SECRET,
  testDeps,
} from "@/tests/factories";
import {
  onAdminDecision,
  onBuyerApproved,
  onBuyerConfirmed,
  onBuyerProblem,
  onCourierDelivered,
  onExtensionDecided,
  onExtensionProposed,
  onHandoverCode,
  onPaypalWebhook,
  onSweep,
  onTermsConfirmed,
  onTrackingSubmitted,
} from "./engine";

// BUILD_PLAN section 7.1, one test per row: what happens to the money, and what each party (and
// the reviewer) is told. "Told" means the Deal Room status line for that role and the reviewer
// queue; SafeDeal sends no emails (stretch goal).

const H = 3_600_000;
const D = 24 * H;
const START = new Date("2026-11-01T09:00:00Z");
const { db, close } = testDb();
afterAll(close);
beforeEach(() => resetDb(db));

const getDeal = async (id: string) => (await db.select().from(deals).where(eq(deals.id, id)))[0];

type Ctx = Awaited<ReturnType<typeof authorizedDeal>>;

async function authorizedDeal() {
  const fake = fakePaypal();
  const t = testDeps(db, fake.port, START);
  const { deal, hash } = await createDraftDeal(db);
  await onTermsConfirmed(deal.id, { role: "seller", termsHash: hash }, t.deps);
  await onTermsConfirmed(deal.id, { role: "buyer", termsHash: hash }, t.deps);
  const orderId = `ORDER-${deal.publicRef}`;
  await addPayment(db, deal.id, orderId);
  await onBuyerApproved(deal.id, orderId, t.deps);
  return {
    deal,
    fake,
    authId: `AUTH-${orderId}`,
    code: handoverCode(deal.id, TEST_HANDOVER_SECRET),
    ...t,
  };
}

async function shippedDeal() {
  const ctx = await authorizedDeal();
  await onTrackingSubmitted(ctx.deal.id, { carrier: "G4S", trackingNumber: "G4S-1" }, ctx.deps);
  return ctx;
}

/** What the Deal Room shows this party right now. */
async function told(ctx: Ctx, role: Role) {
  return dealView(db, await getDeal(ctx.deal.id), role, {
    now: ctx.deps.now(),
    timeScale: 1,
    kesPerUsd: 130,
    appBaseUrl: "http://localhost:3000",
    handoverSecret: TEST_HANDOVER_SECRET,
  });
}

const inQueue = async (ref: string) => {
  const q = await adminQueue(db);
  return {
    review: q.open.find((r) => r.ref === ref)?.kind ?? null,
    locked: q.locked.some((r) => r.ref === ref),
  };
};

const wrongCode = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

describe("section 7.1 money safety", () => {
  it("seller never ships: the hold is voided at ship-by and both parties are told", async () => {
    const ctx = await authorizedDeal();
    const { deal, fake, deps, advance, authId } = ctx;
    const { shipBy } = await getDeal(deal.id);
    advance(shipBy!.getTime() - START.getTime() - 1);
    await onSweep(deps);
    expect((await getDeal(deal.id)).state).toBe("AUTHORIZED");

    advance(1);
    await onSweep(deps);
    expect((await getDeal(deal.id)).state).toBe("VOIDED");
    expect(fake.port.voidAuth).toHaveBeenCalledWith(authId, `deal-${deal.id}-void-v1`, deal.id);
    expect(fake.port.capture).not.toHaveBeenCalled();
    expect((await told(ctx, "buyer")).statusLine).toMatch(/released.*not been charged/);
    expect((await told(ctx, "seller")).statusLine).toMatch(/released to the buyer.*not paid/);
  });

  it("deliver-by passes: money stays held, both parties and the reviewer are told; a late confirmation still pays", async () => {
    const ctx = await shippedDeal();
    const { deal, fake, deps, advance } = ctx;
    const { deliverBy } = await getDeal(deal.id);
    advance(deliverBy!.getTime() - START.getTime());
    await onSweep(deps);

    expect((await getDeal(deal.id)).state).toBe("IN_REVIEW");
    expect(fake.port.capture).not.toHaveBeenCalled();
    expect(fake.port.voidAuth).not.toHaveBeenCalled();
    expect((await told(ctx, "buyer")).statusLine).toMatch(/delivery date passed.*stays held/);
    expect((await told(ctx, "seller")).statusLine).toMatch(/delivery date passed.*stays held/);
    expect(await inQueue(deal.publicRef)).toMatchObject({ review: "deliver_by" });

    expect(await onBuyerConfirmed(deal.id, deps)).toMatchObject({ to: "CAPTURED" });
    expect(fake.port.capture).toHaveBeenCalledTimes(1);
    expect(await inQueue(deal.publicRef)).toMatchObject({ review: null });
  });

  it("courier is late: an accepted new date returns the deal to SHIPPED; day 26 or later is refused; a complaint cannot be extended away", async () => {
    const ctx = await shippedDeal();
    const { deal, deps, advance } = ctx;
    advance(7 * D);
    await onSweep(deps);
    expect((await getDeal(deal.id)).state).toBe("IN_REVIEW");

    const tooLate = new Date(START.getTime() + 26 * D);
    expect(
      await onExtensionProposed(deal.id, { role: "seller", newDeliverBy: tooLate }, deps),
    ).toMatchObject({ outcome: "rejected", reason: expect.stringContaining("day 26") });

    const newDate = new Date(START.getTime() + 12 * D);
    await onExtensionProposed(deal.id, { role: "seller", newDeliverBy: newDate }, deps);
    const [ext] = await db.select().from(extensions).where(eq(extensions.dealId, deal.id));
    expect(
      await onExtensionDecided(deal.id, { role: "buyer", extensionId: ext.id, accept: true }, deps),
    ).toMatchObject({ outcome: "moved", to: "SHIPPED" });
    expect(await getDeal(deal.id)).toMatchObject({ state: "SHIPPED", deliverBy: newDate });
    expect((await told(ctx, "buyer")).termsVersion).toBe(2);

    await onBuyerProblem(deal.id, "box arrived empty", deps);
    expect(
      await onExtensionProposed(
        deal.id,
        { role: "seller", newDeliverBy: new Date(START.getTime() + 14 * D) },
        deps,
      ),
    ).toMatchObject({ outcome: "rejected" });
    expect(await inQueue(deal.publicRef)).toMatchObject({ review: "buyer_problem" });
  });

  it("buyer stays silent after a verified delivery: the seller is paid when the 48 h window ends", async () => {
    const ctx = await shippedDeal();
    const { deal, fake, deps, advance } = ctx;
    advance(D);
    await onCourierDelivered(
      deal.id,
      { verified: true, deliveredAt: deps.now(), eventId: "d" },
      deps,
    );
    expect((await told(ctx, "buyer")).statusLine).toMatch(/Otherwise the seller is paid then/);

    advance(48 * H - 1);
    await onSweep(deps);
    expect((await getDeal(deal.id)).state).toBe("DELIVERED");
    advance(1);
    await onSweep(deps);
    expect((await getDeal(deal.id)).state).toBe("CAPTURED");
    expect(fake.port.capture).toHaveBeenCalledTimes(1);
  });

  it("hand delivery: the correct code is a verified delivery; 5 wrong codes lock entry and alert the reviewer", async () => {
    const good = await authorizedDeal();
    expect(await onHandoverCode(good.deal.id, good.code, good.deps)).toMatchObject({
      to: "DELIVERED",
    });
    expect(await getDeal(good.deal.id)).toMatchObject({ deliveryProof: "handover_code" });

    await resetDb(db);
    const bad = await authorizedDeal();
    for (let i = 0; i < 5; i++) await onHandoverCode(bad.deal.id, wrongCode(bad.code), bad.deps);
    expect(await getDeal(bad.deal.id)).toMatchObject({ state: "AUTHORIZED", handoverLocked: true });
    expect(await onHandoverCode(bad.deal.id, bad.code, bad.deps)).toMatchObject({
      outcome: "rejected",
    });
    expect(await inQueue(bad.deal.publicRef)).toMatchObject({ locked: true });
    expect((await told(bad, "seller")).statusLine).toMatch(/locked after 5 wrong codes/);
    expect((await told(bad, "buyer")).statusLine).toMatch(/locked after 5 wrong codes/);
    expect(bad.fake.port.capture).not.toHaveBeenCalled();
  });

  it("buyer falsely reports a problem: money held, the reviewer sees the evidence and captures", async () => {
    const ctx = await shippedDeal();
    const { deal, fake, deps, advance } = ctx;
    advance(D);
    await onCourierDelivered(
      deal.id,
      { verified: true, deliveredAt: deps.now(), eventId: "d" },
      deps,
    );
    advance(H);
    await onBuyerProblem(deal.id, "never arrived", deps);
    expect((await getDeal(deal.id)).state).toBe("IN_REVIEW");
    expect(await inQueue(deal.publicRef)).toMatchObject({ review: "buyer_problem" });

    // The inspection window ending does not pay while a complaint is open.
    advance(3 * D);
    await onSweep(deps);
    expect(fake.port.capture).not.toHaveBeenCalled();

    const view = await adminDeal(db, await getDeal(deal.id), { now: deps.now(), timeScale: 1 });
    expect(view.evidence).toMatchObject([{ type: "tracking", trackingNumber: "G4S-1" }]);
    expect(view.reviews).toMatchObject([{ kind: "buyer_problem", note: "never arrived" }]);
    expect(view.canDecide).toBe(true);

    expect(
      await onAdminDecision(
        deal.id,
        { decision: "capture", reason: "courier confirmed delivery to the buyer", admin: "admin" },
        deps,
      ),
    ).toMatchObject({ to: "CAPTURED" });
    expect(fake.port.capture).toHaveBeenCalledTimes(1);
  });

  it("buyer opens a PayPal dispute after capture: DISPUTED, and the seller gets the evidence bundle", async () => {
    const ctx = await shippedDeal();
    const { deal, fake, deps } = ctx;
    await onBuyerConfirmed(deal.id, deps);
    const [pay] = await db.select().from(payments).where(eq(payments.dealId, deal.id));
    fake.port.getDispute.mockResolvedValue({
      ok: true,
      status: 200,
      debugId: "dbg",
      value: { id: "PP-D-1", status: "OPEN", captureIds: [pay.captureId!] },
    });
    await onPaypalWebhook(
      { id: "WH-1", event_type: "CUSTOMER.DISPUTE.CREATED", resource: { dispute_id: "PP-D-1" } },
      deps,
    );
    expect((await getDeal(deal.id)).state).toBe("DISPUTED");
    const seller = await told(ctx, "seller");
    expect(seller.statusLine).toMatch(/evidence bundle/);
    expect(seller.actions).toContain("download_bundle");
  });

  it("nobody acts at all: never paid by default; PayPal's expiry ends as EXPIRED and the buyer is told", async () => {
    const ctx = await shippedDeal();
    const { deal, fake, deps, advance, authId } = ctx;
    for (let day = 0; day < 29 * 4; day++) {
      advance(6 * H);
      await onSweep(deps);
    }
    expect((await getDeal(deal.id)).state).toBe("IN_REVIEW");
    expect(await inQueue(deal.publicRef)).toMatchObject({ review: "deliver_by" });
    expect(fake.port.capture).not.toHaveBeenCalled();

    fake.authStatus.set(authId, "VOIDED");
    await onPaypalWebhook(
      { id: "WH-2", event_type: "PAYMENT.AUTHORIZATION.VOIDED", resource: { id: authId } },
      deps,
    );
    expect((await getDeal(deal.id)).state).toBe("EXPIRED");
    expect((await told(ctx, "buyer")).statusLine).toMatch(/released back to you/);
    expect(fake.port.capture).not.toHaveBeenCalled();
    expect(await verifyAuditChain(db)).toMatchObject({ ok: true });
  });
});

describe("concurrency", () => {
  for (const first of ["buyer", "sweep"] as const) {
    it(`buyer confirmation and the sweep at the same moment capture once (${first} first)`, async () => {
      const { deal, fake, deps, advance } = await shippedDeal();
      await onCourierDelivered(
        deal.id,
        { verified: true, deliveredAt: deps.now(), eventId: "d" },
        deps,
      );
      advance(48 * H);
      // A slow PayPal keeps the first capture in flight while the second trigger arrives.
      const capture = fake.port.capture.getMockImplementation()!;
      fake.port.capture.mockImplementation(async (...args) => {
        await new Promise((r) => setTimeout(r, 150));
        return capture(...args);
      });
      const buyer = () => onBuyerConfirmed(deal.id, deps);
      const sweep = () => onSweep(deps);
      await Promise.all(first === "buyer" ? [buyer(), sweep()] : [sweep(), buyer()]);

      expect((await getDeal(deal.id)).state).toBe("CAPTURED");
      expect(fake.port.capture).toHaveBeenCalledTimes(1);
      expect(fake.port.capture).toHaveBeenCalledWith(
        expect.any(String),
        `deal-${deal.id}-capture-v1`,
        deal.id,
      );
    });
  }
});

/** Small seeded PRNG so a failing sequence can be replayed from its seed. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("time alone never pays the seller", () => {
  it("random sequences of everything except a verified delivery never capture (25 seeds, 31 days each)", async () => {
    for (let seed = 1; seed <= 25; seed++) {
      await resetDb(db);
      const { deal, fake, deps, advance, authId, code } = await authorizedDeal();
      const rand = rng(seed);
      const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
      const steps: string[] = [];
      while (deps.now().getTime() - START.getTime() < 31 * D) {
        const step = pick([
          "time",
          "time",
          "time",
          "tracking",
          "unverified_courier",
          "wrong_code",
          "problem",
          "extend",
        ] as const);
        steps.push(step);
        switch (step) {
          case "time":
            advance(Math.ceil(rand() * 72) * H);
            // PayPal ends the hold itself on day 29.
            if (
              deps.now().getTime() - START.getTime() >= 29 * D &&
              fake.authStatus.get(authId) === "CREATED"
            ) {
              fake.authStatus.set(authId, "EXPIRED");
            }
            await onSweep(deps);
            break;
          case "tracking":
            await onTrackingSubmitted(
              deal.id,
              { carrier: "G4S", trackingNumber: `T${seed}` },
              deps,
            );
            break;
          case "unverified_courier":
            await onCourierDelivered(
              deal.id,
              { verified: false, deliveredAt: deps.now(), eventId: `u${steps.length}` },
              deps,
            );
            break;
          case "wrong_code":
            await onHandoverCode(deal.id, wrongCode(code), deps);
            break;
          case "problem":
            await onBuyerProblem(deal.id, "where is it?", deps);
            break;
          case "extend": {
            const role = pick(["buyer", "seller"] as const);
            const to = new Date(deps.now().getTime() + Math.ceil(rand() * 10) * D);
            await onExtensionProposed(deal.id, { role, newDeliverBy: to }, deps);
            const [open] = await db
              .select()
              .from(extensions)
              .where(and(eq(extensions.dealId, deal.id), eq(extensions.status, "proposed")));
            if (open && rand() < 0.7) {
              const other = role === "buyer" ? "seller" : "buyer";
              await onExtensionDecided(
                deal.id,
                { role: other, extensionId: open.id, accept: rand() < 0.8 },
                deps,
              );
            }
            break;
          }
        }
      }
      const final = await getDeal(deal.id);
      const context = `seed ${seed}: ${steps.join(",")} → ${final.state}`;
      expect(fake.port.capture, context).not.toHaveBeenCalled();
      expect(final.state, context).not.toBe("CAPTURED");
      expect(final.deliveredAt, context).toBeNull();
      expect(["VOIDED", "EXPIRED", "IN_REVIEW"], context).toContain(final.state);
    }
  }, 120_000);
});
