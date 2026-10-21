import type { DealState } from "@/lib/db/schema";

// The deal state machine from docs/BUILD_PLAN.md section 7, as a pure function with no I/O, so every
// transition is unit-tested. lib/rules/engine.ts applies its decisions inside a locked transaction.
// A timeout alone never releases money: capture without the buyer needs a verified delivery.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Default deadlines (Peter, 2026-10-20). All are divided by DEMO_TIME_SCALE. */
export const DEFAULTS = {
  shipWithinMs: 48 * HOUR,
  deliverWithinMs: 7 * DAY,
  adminReviewAfterMs: 26 * DAY,
  hardLimitAfterMs: 29 * DAY,
} as const;

/** Unanswered PayPal calls the sweep repeats (same request id) before handing over to an admin. */
export const MAX_PENDING_TRIES = 6;

/** States in which PayPal is holding the buyer's money. */
export const HELD_STATES: readonly DealState[] = [
  "AUTHORIZED",
  "SHIPPED",
  "DELIVERED",
  "IN_REVIEW",
  "CAPTURE_FAILED",
];

export type DealSnapshot = {
  state: DealState;
  shipBy: Date | null;
  deliverBy: Date | null;
  deliveredAt: Date | null;
  inspectionHours: number;
  authorizedAt: Date | null;
  authExpiresAt: Date | null;
  hasTracking: boolean;
  /** Hash of the latest terms version. */
  currentTermsHash: string | null;
  /** Hash each party confirmed most recently (null if none). */
  confirmedHashes: { buyer: string | null; seller: string | null };
};

export type Trigger =
  | { type: "CONFIRM" }
  | { type: "BUYER_APPROVED"; orderApproved: boolean }
  | { type: "TRACKING_SUBMITTED" }
  | { type: "COURIER_DELIVERED"; verified: boolean }
  | { type: "BUYER_CONFIRMED" }
  | { type: "BUYER_PROBLEM" }
  | { type: "SWEEP" }
  | { type: "ADMIN_DECISION"; decision: "capture" | "void"; reason: string }
  /** PayPal reports the authorisation voided or expired. `voidedByUs`: we had sent a void. */
  | { type: "AUTH_ENDED"; voidedByUs: boolean }
  /** PayPal reports the authorisation captured. `capturedByUs`: we had sent a capture. */
  | { type: "AUTH_CAPTURED"; capturedByUs: boolean }
  /** A capture or void we sent got no answer and PayPal still holds the money; `tries` so far. */
  | { type: "RETRY_PENDING"; step: "capture" | "void"; tries: number }
  | { type: "DISPUTE_CREATED"; verified: boolean }
  | { type: "DISPUTE_RESOLVED"; verified: boolean }
  | { type: "CANCEL" };

export type PaypalStep = "authorize" | "capture" | "void";

export type Decision =
  /** Move to `to`. With `paypal`, only after that call succeeds; on a final failure go to `onFailure`. */
  | { kind: "move"; to: DealState; paypal?: PaypalStep; onFailure?: DealState; reason: string }
  /** Allowed, but nothing changes (e.g. a sweep before any deadline). */
  | { kind: "stay"; reason: string }
  /** Not allowed in this state or the guard failed. */
  | { kind: "reject"; reason: string };

export type Timing = { timeScale: number };

const scaled = (ms: number, t: Timing) => ms / t.timeScale;
const after = (from: Date, ms: number) => new Date(from.getTime() + ms);

export function reviewAt(d: DealSnapshot, t: Timing): Date | null {
  return d.authorizedAt && after(d.authorizedAt, scaled(DEFAULTS.adminReviewAfterMs, t));
}

/** Last moment a capture may be attempted: day 29 (scaled) or PayPal's own expiry, if earlier. */
export function hardLimit(d: DealSnapshot, t: Timing): Date | null {
  if (!d.authorizedAt) return d.authExpiresAt;
  const day29 = after(d.authorizedAt, scaled(DEFAULTS.hardLimitAfterMs, t));
  return d.authExpiresAt && d.authExpiresAt < day29 ? d.authExpiresAt : day29;
}

export function inspectionEndsAt(d: DealSnapshot, t: Timing): Date | null {
  return d.deliveredAt && after(d.deliveredAt, scaled(d.inspectionHours * HOUR, t));
}

/** Deadlines set at authorisation when the terms did not fix them. */
export function defaultDeadlines(authorizedAt: Date, t: Timing) {
  return {
    shipBy: after(authorizedAt, scaled(DEFAULTS.shipWithinMs, t)),
    deliverBy: after(authorizedAt, scaled(DEFAULTS.deliverWithinMs, t)),
  };
}

const reject = (reason: string): Decision => ({ kind: "reject", reason });
const stay = (reason: string): Decision => ({ kind: "stay", reason });
const notIn = (d: DealSnapshot, what: string) =>
  reject(`${what} is not allowed in state ${d.state}`);

function captureIfValid(d: DealSnapshot, now: Date, t: Timing, reason: string): Decision {
  const limit = hardLimit(d, t);
  if (!limit || now >= limit) return reject("the authorisation is no longer valid for capture");
  return { kind: "move", to: "CAPTURED", paypal: "capture", onFailure: "CAPTURE_FAILED", reason };
}

function sweep(d: DealSnapshot, now: Date, t: Timing): Decision {
  const review = reviewAt(d, t);
  switch (d.state) {
    case "AUTHORIZED":
      if (!d.hasTracking && d.shipBy && now >= d.shipBy) {
        return {
          kind: "move",
          to: "VOIDED",
          paypal: "void",
          onFailure: "IN_REVIEW",
          reason: "ship-by deadline passed without tracking",
        };
      }
      break;
    case "SHIPPED":
      if (!d.deliveredAt && d.deliverBy && now >= d.deliverBy) {
        return {
          kind: "move",
          to: "IN_REVIEW",
          reason: "deliver-by deadline passed without a delivered event",
        };
      }
      break;
    case "DELIVERED": {
      const end = inspectionEndsAt(d, t);
      const limit = hardLimit(d, t);
      if (end && now >= end && limit && now < limit) {
        return captureIfValid(d, now, t, "inspection window ended after a verified delivery");
      }
      break;
    }
    default:
      return stay(`nothing to sweep in state ${d.state}`);
  }
  if (review && now >= review) {
    return {
      kind: "move",
      to: "IN_REVIEW",
      reason: "day 26 of the authorisation without a decision",
    };
  }
  return stay("no deadline reached");
}

export function nextState(d: DealSnapshot, trigger: Trigger, now: Date, t: Timing): Decision {
  switch (trigger.type) {
    case "CONFIRM": {
      if (d.state !== "DRAFT") return notIn(d, "Confirming terms");
      const h = d.currentTermsHash;
      if (h && d.confirmedHashes.buyer === h && d.confirmedHashes.seller === h) {
        return { kind: "move", to: "AGREED", reason: "both parties confirmed the same terms" };
      }
      return stay("waiting for the other party to confirm these terms");
    }

    case "BUYER_APPROVED":
      if (d.state !== "AGREED" && d.state !== "FUNDING_FAILED") return notIn(d, "Authorising");
      if (!trigger.orderApproved) return reject("the PayPal order is not approved");
      return {
        kind: "move",
        to: "AUTHORIZED",
        paypal: "authorize",
        onFailure: "FUNDING_FAILED",
        reason: "buyer approved the payment",
      };

    case "TRACKING_SUBMITTED":
      if (d.state === "SHIPPED") return stay("extra tracking recorded");
      if (d.state !== "AUTHORIZED") return notIn(d, "Adding tracking");
      if (d.shipBy && now >= d.shipBy) return reject("the ship-by deadline has passed");
      return { kind: "move", to: "SHIPPED", reason: "seller added tracking before ship-by" };

    case "COURIER_DELIVERED":
      if (!trigger.verified) return reject("the courier event is not verified");
      if (d.state !== "SHIPPED") return stay(`delivery recorded; no change in state ${d.state}`);
      return { kind: "move", to: "DELIVERED", reason: "verified courier delivered event" };

    case "BUYER_CONFIRMED":
      if (d.state !== "AUTHORIZED" && d.state !== "SHIPPED" && d.state !== "DELIVERED") {
        return notIn(d, "Confirming receipt");
      }
      return captureIfValid(d, now, t, "buyer confirmed receipt");

    case "BUYER_PROBLEM": {
      if (d.state === "SHIPPED") {
        return { kind: "move", to: "IN_REVIEW", reason: "buyer reported a problem" };
      }
      if (d.state !== "DELIVERED") return notIn(d, "Reporting a problem");
      const end = inspectionEndsAt(d, t);
      if (end && now >= end) return reject("the inspection window has closed");
      return { kind: "move", to: "IN_REVIEW", reason: "buyer reported a problem" };
    }

    case "SWEEP":
      return sweep(d, now, t);

    case "ADMIN_DECISION":
      if (d.state !== "IN_REVIEW" && d.state !== "CAPTURE_FAILED")
        return notIn(d, "An admin decision");
      if (!trigger.reason.trim()) return reject("an admin decision needs a reason");
      if (trigger.decision === "capture")
        return captureIfValid(d, now, t, "admin decided to capture");
      return {
        kind: "move",
        to: "VOIDED",
        paypal: "void",
        onFailure: d.state,
        reason: "admin decided to void",
      };

    case "AUTH_ENDED":
      if (!HELD_STATES.includes(d.state)) {
        return stay(`authorisation end ignored in state ${d.state}`);
      }
      // Our own void whose reply was lost is still a void, not an expiry.
      if (trigger.voidedByUs) {
        return { kind: "move", to: "VOIDED", reason: "PayPal confirms the void SafeDeal sent" };
      }
      return { kind: "move", to: "EXPIRED", reason: "PayPal voided or expired the authorisation" };

    case "AUTH_CAPTURED":
      if (!HELD_STATES.includes(d.state)) return stay(`capture ignored in state ${d.state}`);
      if (trigger.capturedByUs) {
        return {
          kind: "move",
          to: "CAPTURED",
          reason: "PayPal confirms the capture SafeDeal sent",
        };
      }
      return {
        kind: "move",
        to: "IN_REVIEW",
        reason: "PayPal reports a capture SafeDeal did not make",
      };

    case "RETRY_PENDING":
      if (!HELD_STATES.includes(d.state)) return stay(`nothing to retry in state ${d.state}`);
      if (trigger.tries >= MAX_PENDING_TRIES) {
        if (d.state === "IN_REVIEW") return stay("waiting for an admin after unanswered retries");
        return {
          kind: "move",
          to: "IN_REVIEW",
          reason: `PayPal did not answer the ${trigger.step} after ${trigger.tries} tries`,
        };
      }
      if (trigger.step === "capture") {
        const limit = hardLimit(d, t);
        if (!limit || now >= limit) {
          return {
            kind: "move",
            to: "IN_REVIEW",
            reason: "an unanswered capture can no longer be repeated: the authorisation is too old",
          };
        }
        return captureIfValid(d, now, t, "repeating a capture PayPal did not answer");
      }
      return {
        kind: "move",
        to: "VOIDED",
        paypal: "void",
        onFailure: "IN_REVIEW",
        reason: "repeating a void PayPal did not answer",
      };

    case "DISPUTE_CREATED":
      if (!trigger.verified) return reject("the dispute event is not verified");
      if (d.state !== "CAPTURED") return stay(`dispute recorded; no change in state ${d.state}`);
      return { kind: "move", to: "DISPUTED", reason: "buyer opened a PayPal dispute" };

    case "DISPUTE_RESOLVED":
      if (!trigger.verified) return reject("the dispute event is not verified");
      if (d.state !== "DISPUTED")
        return stay(`dispute resolution recorded; no change in state ${d.state}`);
      return { kind: "move", to: "CLOSED", reason: "PayPal resolved the dispute" };

    case "CANCEL":
      if (d.state !== "DRAFT" && d.state !== "AGREED" && d.state !== "FUNDING_FAILED") {
        return notIn(d, "Cancelling");
      }
      return { kind: "move", to: "CANCELLED", reason: "deal cancelled before any money was held" };
  }
}
