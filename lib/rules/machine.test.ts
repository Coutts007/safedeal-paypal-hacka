import { describe, expect, it } from "vitest";
import { dealStates, type DealState } from "@/lib/db/schema";
import {
  defaultDeadlines,
  HELD_STATES,
  nextState,
  type DealSnapshot,
  type Decision,
  type Trigger,
} from "./machine";

// One test per row of the section 7 transition table, plus the guards around it.

const H = 3_600_000;
const D = 24 * H;
const T0 = new Date("2026-11-01T09:00:00Z"); // authorised at
const t1 = { timeScale: 1 };

function deal(patch: Partial<DealSnapshot> = {}): DealSnapshot {
  return {
    state: "AUTHORIZED",
    shipBy: new Date(T0.getTime() + 48 * H),
    deliverBy: new Date(T0.getTime() + 7 * D),
    deliveredAt: null,
    inspectionHours: 48,
    authorizedAt: T0,
    authExpiresAt: new Date(T0.getTime() + 29 * D),
    hasTracking: false,
    openReview: null,
    currentTermsHash: "h1",
    confirmedHashes: { buyer: null, seller: null },
    ...patch,
  };
}

const at = (ms: number) => new Date(T0.getTime() + ms);
const run = (d: DealSnapshot, trig: Trigger, now = at(H), t = t1) => nextState(d, trig, now, t);
const moved = (to: DealState, extra: Partial<Decision> = {}) =>
  expect.objectContaining({ kind: "move", to, ...extra });
const rejected = expect.objectContaining({ kind: "reject" });
const stayed = expect.objectContaining({ kind: "stay" });

describe("DRAFT → AGREED (second party confirms)", () => {
  const draft = (b: string | null, s: string | null) =>
    deal({ state: "DRAFT", authorizedAt: null, confirmedHashes: { buyer: b, seller: s } });

  it("moves when both confirmed the current terms hash", () => {
    expect(run(draft("h1", "h1"), { type: "CONFIRM" })).toEqual(moved("AGREED"));
  });
  it("stays while only one party confirmed", () => {
    expect(run(draft("h1", null), { type: "CONFIRM" })).toEqual(stayed);
  });
  it("stays when the confirmations are for different terms", () => {
    expect(run(draft("h0", "h1"), { type: "CONFIRM" })).toEqual(stayed);
  });
  it("is rejected once terms are locked", () => {
    expect(run(deal({ state: "AGREED" }), { type: "CONFIRM" })).toEqual(rejected);
  });
});

describe("AGREED → AUTHORIZED / FUNDING_FAILED (buyer approves)", () => {
  it("authorises, falling back to FUNDING_FAILED on a PayPal error", () => {
    expect(run(deal({ state: "AGREED" }), { type: "BUYER_APPROVED", orderApproved: true })).toEqual(
      moved("AUTHORIZED", { paypal: "authorize", onFailure: "FUNDING_FAILED" }),
    );
  });
  it("allows a new attempt from FUNDING_FAILED", () => {
    expect(
      run(deal({ state: "FUNDING_FAILED" }), { type: "BUYER_APPROVED", orderApproved: true }),
    ).toEqual(moved("AUTHORIZED", { paypal: "authorize" }));
  });
  it("rejects an order PayPal does not report as approved", () => {
    expect(
      run(deal({ state: "AGREED" }), { type: "BUYER_APPROVED", orderApproved: false }),
    ).toEqual(rejected);
  });
  it("rejects a second authorisation", () => {
    expect(run(deal(), { type: "BUYER_APPROVED", orderApproved: true })).toEqual(rejected);
  });
});

describe("AUTHORIZED → SHIPPED (seller submits tracking)", () => {
  it("moves before ship_by", () => {
    expect(run(deal(), { type: "TRACKING_SUBMITTED" }, at(47 * H))).toEqual(moved("SHIPPED"));
  });
  it("is rejected at or after ship_by", () => {
    expect(run(deal(), { type: "TRACKING_SUBMITTED" }, at(48 * H))).toEqual(rejected);
  });
  it("records extra tracking when already shipped", () => {
    expect(run(deal({ state: "SHIPPED" }), { type: "TRACKING_SUBMITTED" })).toEqual(stayed);
  });
  it("is rejected before payment", () => {
    expect(run(deal({ state: "AGREED" }), { type: "TRACKING_SUBMITTED" })).toEqual(rejected);
  });
});

describe("AUTHORIZED → VOIDED (sweep: ship_by passed, no tracking)", () => {
  it("voids, sending the deal to review if the void fails", () => {
    expect(run(deal(), { type: "SWEEP" }, at(48 * H))).toEqual(
      moved("VOIDED", { paypal: "void", onFailure: "IN_REVIEW" }),
    );
  });
  it("does nothing before ship_by", () => {
    expect(run(deal(), { type: "SWEEP" }, at(47 * H))).toEqual(stayed);
  });
  it("never voids after a verified delivery (e.g. a handover code)", () => {
    expect(run(deal({ deliveredAt: at(H) }), { type: "SWEEP" }, at(48 * H))).toEqual(stayed);
  });
});

describe("SHIPPED → DELIVERED (verified courier event)", () => {
  it("moves on a verified event", () => {
    expect(run(deal({ state: "SHIPPED" }), { type: "COURIER_DELIVERED", verified: true })).toEqual(
      moved("DELIVERED"),
    );
  });
  it("rejects an unverified event", () => {
    expect(run(deal({ state: "SHIPPED" }), { type: "COURIER_DELIVERED", verified: false })).toEqual(
      rejected,
    );
  });
  it("records but does not move a deal under review for a complaint or a PayPal problem", () => {
    for (const openReview of ["buyer_problem", "paypal", "other"] as const) {
      expect(
        run(deal({ state: "IN_REVIEW", openReview }), {
          type: "COURIER_DELIVERED",
          verified: true,
        }),
      ).toEqual(stayed);
    }
  });
});

// Section 7.1: deliveries without courier tracking are proven by the buyer's handover code.
describe("AUTHORIZED, SHIPPED → DELIVERED (seller enters the handover code)", () => {
  it.each(["AUTHORIZED", "SHIPPED"] as const)("moves from %s, with no PayPal call", (state) => {
    const d = run(deal({ state }), { type: "HANDOVER_VERIFIED" });
    expect(d).toEqual(moved("DELIVERED"));
    expect(d.kind === "move" && d.paypal).toBeFalsy();
  });
  it("counts as late proof in a deliver-by or day-26 review", () => {
    for (const openReview of ["deliver_by", "day_26"] as const) {
      expect(run(deal({ state: "IN_REVIEW", openReview }), { type: "HANDOVER_VERIFIED" })).toEqual(
        moved("DELIVERED"),
      );
    }
  });
  it("cannot clear a complaint, and is refused once delivered or settled", () => {
    for (const d of [
      deal({ state: "IN_REVIEW", openReview: "buyer_problem" }),
      deal({ state: "DELIVERED", deliveredAt: at(0) }),
      deal({ state: "CAPTURED" }),
      deal({ state: "VOIDED" }),
    ]) {
      expect(run(d, { type: "HANDOVER_VERIFIED" })).toEqual(rejected);
    }
  });
});

describe("SHIPPED, IN_REVIEW → SHIPPED (extend delivery date)", () => {
  const shipped = deal({ state: "SHIPPED", hasTracking: true });
  const lateReview = deal({ state: "IN_REVIEW", openReview: "deliver_by", hasTracking: true });
  const propose = (d: DealSnapshot, to: Date, now = at(8 * D)) =>
    run(d, { type: "EXTENSION_PROPOSED", newDeliverBy: to }, now);
  const accept = (d: DealSnapshot, to: Date, now = at(8 * D)) =>
    run(d, { type: "EXTENSION_ACCEPTED", newDeliverBy: to }, now);

  it("a proposal changes nothing until the other party accepts", () => {
    expect(propose(shipped, at(10 * D))).toEqual(stayed);
    expect(propose(lateReview, at(10 * D))).toEqual(stayed);
  });
  it("accepting keeps a shipped deal SHIPPED and brings a late deal back from review", () => {
    expect(accept(shipped, at(10 * D))).toEqual(stayed);
    expect(accept(lateReview, at(10 * D))).toEqual(moved("SHIPPED"));
  });
  it("rejects a date on or after day 26 of the hold, or in the past", () => {
    expect(propose(shipped, at(26 * D))).toEqual(rejected);
    expect(accept(lateReview, at(26 * D))).toEqual(rejected);
    expect(propose(shipped, at(7 * D))).toEqual(rejected);
  });
  it("cannot clear a buyer complaint, a day-26 review or a PayPal problem", () => {
    for (const openReview of ["buyer_problem", "day_26", "paypal"] as const) {
      expect(accept(deal({ state: "IN_REVIEW", openReview }), at(10 * D))).toEqual(rejected);
    }
  });
  it("is not possible before shipping or after delivery", () => {
    for (const state of ["AUTHORIZED", "DELIVERED", "CAPTURED"] as const) {
      expect(propose(deal({ state }), at(10 * D))).toEqual(rejected);
    }
  });
  it("is checked again at acceptance: a deal delivered meanwhile cannot be extended", () => {
    expect(accept(deal({ state: "DELIVERED", deliveredAt: at(8 * D) }), at(10 * D))).toEqual(
      rejected,
    );
  });
  it("a rejection never changes anything", () => {
    expect(run(shipped, { type: "EXTENSION_REJECTED" })).toEqual(stayed);
  });
});

// Section 7.1: a deadline review keeps the money held, but late proof of delivery still pays.
describe("IN_REVIEW (deadline) → DELIVERED or CAPTURED (late proof of delivery)", () => {
  it.each(["deliver_by", "day_26"] as const)(
    "a verified courier delivery after a %s review starts the inspection window",
    (openReview) => {
      const d = deal({ state: "IN_REVIEW", hasTracking: true, openReview });
      expect(run(d, { type: "COURIER_DELIVERED", verified: true }, at(8 * D))).toEqual(
        moved("DELIVERED"),
      );
    },
  );
  it("an unverified courier event still counts for nothing", () => {
    const d = deal({ state: "IN_REVIEW", openReview: "deliver_by" });
    expect(run(d, { type: "COURIER_DELIVERED", verified: false })).toEqual(rejected);
  });
  it("a deal already delivered does not restart its inspection window", () => {
    const d = deal({ state: "IN_REVIEW", openReview: "day_26", deliveredAt: at(3 * D) });
    expect(run(d, { type: "COURIER_DELIVERED", verified: true }, at(26 * D))).toEqual(stayed);
  });
  it.each(["deliver_by", "day_26"] as const)(
    "a late buyer confirmation after a %s review captures",
    (openReview) => {
      const d = deal({ state: "IN_REVIEW", hasTracking: true, openReview });
      expect(run(d, { type: "BUYER_CONFIRMED" }, at(8 * D))).toEqual(
        moved("CAPTURED", { paypal: "capture", onFailure: "CAPTURE_FAILED" }),
      );
    },
  );
  it("a late buyer confirmation past the hard limit is rejected", () => {
    const d = deal({ state: "IN_REVIEW", openReview: "day_26" });
    expect(run(d, { type: "BUYER_CONFIRMED" }, at(29 * D))).toEqual(rejected);
  });
  it.each(["buyer_problem", "paypal", "other"] as const)(
    "a buyer confirmation cannot clear a %s review",
    (openReview) => {
      expect(run(deal({ state: "IN_REVIEW", openReview }), { type: "BUYER_CONFIRMED" })).toEqual(
        rejected,
      );
    },
  );
  it("a buyer problem during a deadline review stays in review", () => {
    const d = deal({ state: "IN_REVIEW", openReview: "deliver_by" });
    expect(run(d, { type: "BUYER_PROBLEM" })).toEqual(stayed);
  });
});

describe("AUTHORIZED, SHIPPED, DELIVERED → CAPTURED (buyer confirms receipt)", () => {
  it.each(["AUTHORIZED", "SHIPPED", "DELIVERED"] as const)("captures from %s", (state) => {
    expect(run(deal({ state }), { type: "BUYER_CONFIRMED" })).toEqual(
      moved("CAPTURED", { paypal: "capture", onFailure: "CAPTURE_FAILED" }),
    );
  });
  it("is rejected once the authorisation is past its hard limit", () => {
    expect(run(deal({ state: "SHIPPED" }), { type: "BUYER_CONFIRMED" }, at(29 * D))).toEqual(
      rejected,
    );
  });
  it("respects PayPal's expiry when it is earlier than day 29", () => {
    const d = deal({ state: "SHIPPED", authExpiresAt: at(10 * D) });
    expect(run(d, { type: "BUYER_CONFIRMED" }, at(10 * D))).toEqual(rejected);
  });
  it("is rejected before payment and after capture", () => {
    expect(run(deal({ state: "AGREED" }), { type: "BUYER_CONFIRMED" })).toEqual(rejected);
    expect(run(deal({ state: "CAPTURED" }), { type: "BUYER_CONFIRMED" })).toEqual(rejected);
  });
});

describe("DELIVERED → CAPTURED (sweep: inspection window ended)", () => {
  const delivered = deal({ state: "DELIVERED", hasTracking: true, deliveredAt: at(3 * D) });

  it("captures after the window with a delivered event", () => {
    expect(run(delivered, { type: "SWEEP" }, at(5 * D))).toEqual(
      moved("CAPTURED", { paypal: "capture", onFailure: "CAPTURE_FAILED" }),
    );
  });
  it("waits while the window is open", () => {
    expect(run(delivered, { type: "SWEEP" }, at(5 * D - 1))).toEqual(stayed);
  });
  it("never captures on time alone: a SHIPPED deal is not captured by the sweep", () => {
    const shipped = deal({ state: "SHIPPED", hasTracking: true });
    const d = run(shipped, { type: "SWEEP" }, at(6 * D));
    expect(d).toEqual(stayed);
  });
});

describe("SHIPPED, DELIVERED → IN_REVIEW (buyer reports a problem)", () => {
  it("moves from SHIPPED", () => {
    expect(run(deal({ state: "SHIPPED" }), { type: "BUYER_PROBLEM" })).toEqual(
      moved("IN_REVIEW", { review: "buyer_problem" }),
    );
  });
  it("moves from DELIVERED inside the window", () => {
    const d = deal({ state: "DELIVERED", deliveredAt: at(3 * D) });
    expect(run(d, { type: "BUYER_PROBLEM" }, at(4 * D))).toEqual(moved("IN_REVIEW"));
  });
  it("is rejected after the window", () => {
    const d = deal({ state: "DELIVERED", deliveredAt: at(3 * D) });
    expect(run(d, { type: "BUYER_PROBLEM" }, at(5 * D))).toEqual(rejected);
  });
  it("is rejected before shipping", () => {
    expect(run(deal(), { type: "BUYER_PROBLEM" })).toEqual(rejected);
  });
});

describe("SHIPPED → IN_REVIEW (sweep: deliver_by passed)", () => {
  const shipped = deal({ state: "SHIPPED", hasTracking: true });
  it("moves at deliver_by with no delivered event, as a deliver_by review", () => {
    expect(run(shipped, { type: "SWEEP" }, at(7 * D))).toEqual(
      moved("IN_REVIEW", { review: "deliver_by" }),
    );
  });
  it("waits before deliver_by", () => {
    expect(run(shipped, { type: "SWEEP" }, at(7 * D - 1))).toEqual(stayed);
  });
});

describe("held state → IN_REVIEW (sweep: day 26)", () => {
  it("moves a shipped deal that has a delivered_by far in the future", () => {
    const d = deal({ state: "SHIPPED", hasTracking: true, deliverBy: at(28 * D) });
    expect(run(d, { type: "SWEEP" }, at(26 * D))).toEqual(
      moved("IN_REVIEW", { reason: expect.stringContaining("day 26"), review: "day_26" }),
    );
  });
  it("moves an authorised deal whose ship_by is later than day 26", () => {
    const d = deal({ shipBy: at(27 * D) });
    expect(run(d, { type: "SWEEP" }, at(26 * D))).toEqual(moved("IN_REVIEW"));
  });
  it("does not move a deal already in review", () => {
    expect(run(deal({ state: "IN_REVIEW" }), { type: "SWEEP" }, at(27 * D))).toEqual(stayed);
  });
});

describe("IN_REVIEW → CAPTURED or VOIDED (admin decides)", () => {
  const review = deal({ state: "IN_REVIEW" });
  it("captures", () => {
    expect(
      run(review, { type: "ADMIN_DECISION", decision: "capture", reason: "proof ok" }),
    ).toEqual(moved("CAPTURED", { paypal: "capture", onFailure: "CAPTURE_FAILED" }));
  });
  it("voids, staying in review if the void fails", () => {
    expect(run(review, { type: "ADMIN_DECISION", decision: "void", reason: "no proof" })).toEqual(
      moved("VOIDED", { paypal: "void", onFailure: "IN_REVIEW" }),
    );
  });
  it("requires a reason", () => {
    expect(run(review, { type: "ADMIN_DECISION", decision: "void", reason: "  " })).toEqual(
      rejected,
    );
  });
  it("can retry deliberately from CAPTURE_FAILED", () => {
    const d = deal({ state: "CAPTURE_FAILED" });
    expect(run(d, { type: "ADMIN_DECISION", decision: "capture", reason: "retry" })).toEqual(
      moved("CAPTURED", { paypal: "capture" }),
    );
  });
  it("is rejected outside review", () => {
    expect(run(deal(), { type: "ADMIN_DECISION", decision: "void", reason: "x" })).toEqual(
      rejected,
    );
  });
});

describe("held state → EXPIRED (PayPal voided or expired the authorisation)", () => {
  it.each(HELD_STATES)("moves from %s", (state) => {
    expect(run(deal({ state }), { type: "AUTH_ENDED", voidedByUs: false })).toEqual(
      moved("EXPIRED"),
    );
  });
  it("ignores the event once we voided or captured", () => {
    expect(run(deal({ state: "VOIDED" }), { type: "AUTH_ENDED", voidedByUs: false })).toEqual(
      stayed,
    );
    expect(run(deal({ state: "CAPTURED" }), { type: "AUTH_ENDED", voidedByUs: false })).toEqual(
      stayed,
    );
  });
  it("records our own void whose reply was lost as VOIDED, not EXPIRED", () => {
    expect(run(deal(), { type: "AUTH_ENDED", voidedByUs: true })).toEqual(moved("VOIDED"));
  });
});

describe("held state → CAPTURED or IN_REVIEW (reconciliation: PayPal reports a capture)", () => {
  it("accepts a capture we sent whose reply was lost", () => {
    const d = run(deal({ state: "SHIPPED" }), { type: "AUTH_CAPTURED", capturedByUs: true });
    expect(d).toEqual(moved("CAPTURED"));
    expect(d.kind === "move" && d.paypal).toBeFalsy();
  });
  it("sends a capture we did not make to review", () => {
    expect(run(deal(), { type: "AUTH_CAPTURED", capturedByUs: false })).toEqual(moved("IN_REVIEW"));
  });
  it("ignores it once the deal is settled", () => {
    expect(run(deal({ state: "CAPTURED" }), { type: "AUTH_CAPTURED", capturedByUs: true })).toEqual(
      stayed,
    );
  });
});

describe("held state: repeat an unanswered capture or void (sweep)", () => {
  it("repeats a capture while the authorisation is valid", () => {
    expect(run(deal(), { type: "RETRY_PENDING", step: "capture", tries: 1 })).toEqual(
      moved("CAPTURED", { paypal: "capture", onFailure: "CAPTURE_FAILED" }),
    );
  });
  it("repeats a void", () => {
    expect(run(deal(), { type: "RETRY_PENDING", step: "void", tries: 2 })).toEqual(
      moved("VOIDED", { paypal: "void", onFailure: "IN_REVIEW" }),
    );
  });
  it("hands over to an admin after 6 unanswered tries, then waits", () => {
    expect(run(deal(), { type: "RETRY_PENDING", step: "capture", tries: 6 })).toEqual(
      moved("IN_REVIEW"),
    );
    expect(
      run(deal({ state: "IN_REVIEW" }), { type: "RETRY_PENDING", step: "void", tries: 6 }),
    ).toEqual(stayed);
  });
  it("sends a capture to review instead of repeating it past the hard limit", () => {
    const d = run(deal(), { type: "RETRY_PENDING", step: "capture", tries: 1 }, at(29 * D));
    expect(d).toEqual(moved("IN_REVIEW"));
    expect(d.kind === "move" && d.paypal).toBeFalsy();
  });
  it("does nothing once settled", () => {
    expect(
      run(deal({ state: "CAPTURED" }), { type: "RETRY_PENDING", step: "capture", tries: 1 }),
    ).toEqual(stayed);
  });
});

describe("CAPTURED → DISPUTED → CLOSED", () => {
  it("opens and resolves a verified dispute", () => {
    expect(run(deal({ state: "CAPTURED" }), { type: "DISPUTE_CREATED", verified: true })).toEqual(
      moved("DISPUTED"),
    );
    expect(run(deal({ state: "DISPUTED" }), { type: "DISPUTE_RESOLVED", verified: true })).toEqual(
      moved("CLOSED"),
    );
  });
  it("rejects unverified events", () => {
    expect(run(deal({ state: "CAPTURED" }), { type: "DISPUTE_CREATED", verified: false })).toEqual(
      rejected,
    );
    expect(run(deal({ state: "DISPUTED" }), { type: "DISPUTE_RESOLVED", verified: false })).toEqual(
      rejected,
    );
  });
});

describe("CANCELLED (agreed amendment)", () => {
  it.each(["DRAFT", "AGREED", "FUNDING_FAILED"] as const)("cancels from %s", (state) => {
    expect(run(deal({ state }), { type: "CANCEL" })).toEqual(moved("CANCELLED"));
  });
  it.each(HELD_STATES)("cannot cancel once money is held (%s)", (state) => {
    expect(run(deal({ state }), { type: "CANCEL" })).toEqual(rejected);
  });
});

describe("terminal states", () => {
  const terminal: DealState[] = ["VOIDED", "EXPIRED", "CLOSED", "CANCELLED"];
  const moneyTriggers: Trigger[] = [
    { type: "BUYER_APPROVED", orderApproved: true },
    { type: "BUYER_CONFIRMED" },
    { type: "SWEEP" },
    { type: "ADMIN_DECISION", decision: "capture", reason: "x" },
    { type: "HANDOVER_VERIFIED" },
    { type: "EXTENSION_ACCEPTED", newDeliverBy: at(10 * D) },
  ];
  it.each(terminal)("no trigger moves money from %s", (state) => {
    for (const trig of moneyTriggers) {
      const d = run(deal({ state }), trig);
      expect(d.kind === "move" && d.paypal).toBeFalsy();
    }
  });
});

describe("DEMO_TIME_SCALE", () => {
  it("divides every deadline (1440: a day becomes a minute)", () => {
    const fast = { timeScale: 1440 };
    expect(defaultDeadlines(T0, fast).shipBy).toEqual(at(2 * 60_000));
    const d = deal({ state: "DELIVERED", deliveredAt: at(0) });
    expect(run(d, { type: "SWEEP" }, at(2 * 60_000), fast)).toEqual(moved("CAPTURED"));
    expect(
      run(
        deal({ state: "SHIPPED", deliverBy: at(30 * D) }),
        { type: "SWEEP" },
        at(26 * 60_000),
        fast,
      ),
    ).toEqual(moved("IN_REVIEW"));
  });
});

describe("coverage of states", () => {
  it("every state answers every trigger without throwing", () => {
    const triggers: Trigger[] = [
      { type: "CONFIRM" },
      { type: "BUYER_APPROVED", orderApproved: true },
      { type: "TRACKING_SUBMITTED" },
      { type: "COURIER_DELIVERED", verified: true },
      { type: "HANDOVER_VERIFIED" },
      { type: "EXTENSION_PROPOSED", newDeliverBy: at(10 * D) },
      { type: "EXTENSION_ACCEPTED", newDeliverBy: at(10 * D) },
      { type: "EXTENSION_REJECTED" },
      { type: "BUYER_CONFIRMED" },
      { type: "BUYER_PROBLEM" },
      { type: "SWEEP" },
      { type: "ADMIN_DECISION", decision: "void", reason: "r" },
      { type: "AUTH_ENDED", voidedByUs: false },
      { type: "AUTH_CAPTURED", capturedByUs: false },
      { type: "RETRY_PENDING", step: "capture", tries: 0 },
      { type: "DISPUTE_CREATED", verified: true },
      { type: "DISPUTE_RESOLVED", verified: true },
      { type: "CANCEL" },
    ];
    for (const state of dealStates) {
      for (const trig of triggers) {
        expect(["move", "stay", "reject"]).toContain(run(deal({ state }), trig).kind);
      }
    }
  });
});
