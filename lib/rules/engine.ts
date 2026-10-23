import { and, desc, eq, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { appendAudit } from "@/lib/audit";
import { getDb, type Db, type Tx } from "@/lib/db";
import {
  auditLog,
  confirmations,
  deals,
  dealTerms,
  evidence,
  extensions,
  payments,
  reviews,
  type Deal,
  type DealState,
  type ReviewKind,
} from "@/lib/db/schema";
import { carrySourceRefs } from "@/lib/ai/proposal";
import {
  codeMatches,
  HANDOVER_MAX_ATTEMPTS,
  handoverCode,
  handoverHash,
} from "@/lib/deals/handover";
import { dealTermsSchema, termsHash } from "@/lib/deals/terms";
import { serverEnv } from "@/lib/env";
import * as disputesApi from "@/lib/paypal/disputes";
import * as ordersApi from "@/lib/paypal/orders";
// RULE 1: this is the only file allowed to import the module that captures, voids and refunds.
import * as paymentsApi from "@/lib/paypal/payments";
import { installDbRecorder } from "@/lib/paypal/record";
import { paypalRequestId } from "@/lib/paypal/request-id";
import type { PaypalResult } from "@/lib/paypal/result";
import {
  defaultDeadlines,
  HELD_STATES,
  MAX_PENDING_TRIES,
  nextState,
  type DealSnapshot,
  type Decision,
  type PaypalStep,
  type Trigger,
} from "./machine";

// The rule engine. Every trigger runs the same way: open a transaction, lock the deal row, decide
// with the pure `nextState`, call PayPal with the deal's fixed request id if needed, update the
// deal, append to the audit log, commit. Two triggers at the same moment queue on the row lock,
// so the second one sees the first one's result and cannot capture again.
//
// The lock is FOR NO KEY UPDATE: it blocks other engine runs (which take the same lock) but not
// inserts into tables that reference the deal, such as the PayPal call log written on another
// connection while the lock is held.

export type PaypalPort = {
  createOrder: typeof ordersApi.createOrder;
  getOrder: typeof ordersApi.getOrder;
  authorizeOrder: typeof ordersApi.authorizeOrder;
  capture: typeof paymentsApi.capture;
  voidAuth: typeof paymentsApi.voidAuth;
  getAuth: typeof paymentsApi.getAuth;
  getDispute: typeof disputesApi.getDispute;
};

export type EngineDeps = {
  db: Db;
  paypal: PaypalPort;
  now: () => Date;
  timeScale: number;
  /** MAX_DEAL_USD, checked again before any PayPal order is created. */
  maxDealUsd: number;
  /** HANDOVER_SECRET; empty means no handover codes (code entry is then refused). */
  handoverSecret: string;
};

let defaults: EngineDeps | undefined;

export function defaultDeps(): EngineDeps {
  if (!defaults) {
    const db = getDb();
    installDbRecorder(db);
    defaults = {
      db,
      paypal: {
        createOrder: ordersApi.createOrder,
        getOrder: ordersApi.getOrder,
        authorizeOrder: ordersApi.authorizeOrder,
        capture: paymentsApi.capture,
        voidAuth: paymentsApi.voidAuth,
        getAuth: paymentsApi.getAuth,
        getDispute: disputesApi.getDispute,
      },
      now: () => new Date(),
      timeScale: serverEnv().DEMO_TIME_SCALE,
      maxDealUsd: serverEnv().MAX_DEAL_USD,
      handoverSecret: serverEnv().HANDOVER_SECRET,
    };
  }
  return defaults;
}

/** Test hook: replace the default dependencies used by routes (undefined restores them). */
export function setEngineDeps(deps: EngineDeps | undefined): void {
  defaults = deps;
}

export type EngineResult =
  | { outcome: "moved"; from: DealState; to: DealState; reason: string }
  /** Allowed; the state did not change. */
  | { outcome: "unchanged"; state: DealState; reason: string }
  | { outcome: "rejected"; state: DealState; reason: string }
  /** PayPal could not complete the call yet; repeating it later uses the same request id. */
  | { outcome: "pending"; state: DealState; reason: string }
  /** PayPal refused; the deal moved to the failure state (or stayed where it was). */
  | { outcome: "failed"; from: DealState; to: DealState; reason: string; issue: string }
  /** Deal not found, or locked by another run (sweep only). */
  | { outcome: "skipped"; reason: string };

type DealPatch = Partial<typeof deals.$inferInsert>;
type Ctx = { tx: Tx; deal: Deal; deps: EngineDeps; now: Date };

type RunOptions = {
  actor: string;
  skipLocked?: boolean;
  /** Extra audit details (never chat text or secrets). */
  details?: Record<string, unknown>;
  /** Text for the review opened if the deal enters IN_REVIEW. */
  reviewNote?: string;
  /**
   * Writes that belong to an accepted trigger (e.g. store the tracking number). Runs when the
   * intended outcome happens (a move to `decision.to`, or a stay), never after a PayPal failure.
   */
  effects?: (ctx: Ctx, to: DealState) => Promise<DealPatch | void>;
};

/** Build the trigger inside the locked transaction; a string means reject with that reason. */
type TriggerSource = Trigger | ((ctx: Ctx) => Promise<Trigger | string>);

async function snapshot(tx: Tx, deal: Deal): Promise<DealSnapshot> {
  const [terms] = await tx
    .select({ id: dealTerms.id, hash: dealTerms.termsHash })
    .from(dealTerms)
    .where(eq(dealTerms.dealId, deal.id))
    .orderBy(desc(dealTerms.version))
    .limit(1);
  const confirmed = terms
    ? await tx
        .select({ role: confirmations.role })
        .from(confirmations)
        .where(eq(confirmations.termsId, terms.id))
    : [];
  const hashFor = (role: "buyer" | "seller") =>
    confirmed.some((c) => c.role === role) ? (terms?.hash ?? null) : null;
  const [tracking] = await tx
    .select({ id: evidence.id })
    .from(evidence)
    .where(and(eq(evidence.dealId, deal.id), eq(evidence.type, "tracking")))
    .limit(1);
  const [review] = await tx
    .select({ kind: reviews.kind })
    .from(reviews)
    .where(and(eq(reviews.dealId, deal.id), isNull(reviews.decision)))
    .limit(1);
  return {
    state: deal.state,
    shipBy: deal.shipBy,
    deliverBy: deal.deliverBy,
    deliveredAt: deal.deliveredAt,
    inspectionHours: deal.inspectionHours,
    authorizedAt: deal.authorizedAt,
    authExpiresAt: deal.authExpiresAt,
    hasTracking: Boolean(tracking),
    openReview: review?.kind ?? null,
    currentTermsHash: terms?.hash ?? null,
    confirmedHashes: { buyer: hashFor("buyer"), seller: hashFor("seller") },
  };
}

async function currentPayment(tx: Tx, deal: Deal) {
  const [p] = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.dealId, deal.id), eq(payments.attempt, deal.paymentAttempt)))
    .limit(1);
  return p;
}

type StepResult =
  | { ok: true; patch: DealPatch; info: Record<string, unknown> }
  | { ok: false; retryable: boolean; issue: string; info: Record<string, unknown> };

function failure<T>(res: PaypalResult<T> & { ok: false }): StepResult {
  return {
    ok: false,
    retryable: res.retryable,
    issue: res.issue,
    info: { httpStatus: res.status, debugId: res.debugId, issue: res.issue },
  };
}

async function runPaypalStep(ctx: Ctx, step: PaypalStep): Promise<StepResult> {
  const { tx, deal, deps, now } = ctx;
  const payment = await currentPayment(tx, deal);
  if (!payment) return { ok: false, retryable: false, issue: "NO_PAYMENT_RECORD", info: {} };

  if (step === "authorize") {
    const requestId = paypalRequestId(deal.id, "authorize", deal.paymentAttempt);
    const res = await deps.paypal.authorizeOrder(payment.paypalOrderId, requestId, deal.id);
    let auth: ordersApi.Authorization | undefined = res.ok ? res.value : undefined;
    let reconciled = false;
    if (!res.ok && !res.retryable) {
      // E.g. ORDER_ALREADY_AUTHORIZED: an earlier attempt worked but its reply was lost, or PayPal
      // forgot the request id (it keeps them for about 6 hours). Use the authorisation it holds.
      const order = await deps.paypal.getOrder(payment.paypalOrderId, deal.id);
      const held = order.ok
        ? order.value.purchase_units?.[0]?.payments?.authorizations?.[0]
        : undefined;
      if (held && held.status === "CREATED") {
        auth = {
          id: held.id,
          status: held.status,
          expiresAt: held.expiration_time ? new Date(held.expiration_time) : null,
        };
        reconciled = true;
      }
    }
    if (!auth) {
      if (!res.ok && !res.retryable) {
        await tx
          .update(payments)
          .set({ status: `AUTHORIZE_FAILED:${res.issue}`.slice(0, 120), updatedAt: now })
          .where(eq(payments.id, payment.id));
      }
      return failure(res as PaypalResult<never> & { ok: false });
    }
    await tx
      .update(payments)
      .set({ authorizationId: auth.id, status: auth.status, updatedAt: now })
      .where(eq(payments.id, payment.id));
    const defaultsAt = defaultDeadlines(now, { timeScale: deps.timeScale });
    return {
      ok: true,
      patch: {
        authorizedAt: now,
        authExpiresAt: auth.expiresAt,
        shipBy: deal.shipBy ?? defaultsAt.shipBy,
        deliverBy: deal.deliverBy ?? defaultsAt.deliverBy,
        // Only the hash of the buyer's handover code is stored (lib/deals/handover.ts).
        handoverCodeHash: deps.handoverSecret
          ? handoverHash(deal.id, handoverCode(deal.id, deps.handoverSecret))
          : null,
      },
      info: {
        requestId,
        authorizationId: auth.id,
        debugId: res.debugId,
        ...(reconciled && { reconciled: true, issue: !res.ok ? res.issue : undefined }),
      },
    };
  }

  const authId = payment.authorizationId;
  if (!authId) return { ok: false, retryable: false, issue: "NO_AUTHORIZATION", info: {} };
  const requestId = paypalRequestId(deal.id, step, deal.settleAttempt);
  const res =
    step === "capture"
      ? await deps.paypal.capture(authId, requestId, deal.id)
      : await deps.paypal.voidAuth(authId, requestId, deal.id);
  if (res.ok) {
    const captureId = step === "capture" ? (res.value as paymentsApi.Capture).id : undefined;
    await tx
      .update(payments)
      .set({
        status: step === "capture" ? "CAPTURED" : "VOIDED",
        ...(captureId && { captureId }),
        updatedAt: now,
      })
      .where(eq(payments.id, payment.id));
    return { ok: true, patch: {}, info: { requestId, captureId, debugId: res.debugId } };
  }
  if (res.retryable) return failure(res);

  // A final refusal may mean the work was already done (e.g. AUTHORIZATION_ALREADY_CAPTURED after
  // an earlier attempt whose reply was lost). Re-read the authorisation before calling it a failure.
  const goal = step === "capture" ? "CAPTURED" : "VOIDED";
  const auth = await deps.paypal.getAuth(authId, deal.id);
  if (auth.ok && auth.value.status === goal) {
    await tx
      .update(payments)
      .set({ status: goal, updatedAt: now })
      .where(eq(payments.id, payment.id));
    return { ok: true, patch: {}, info: { requestId, reconciled: true, issue: res.issue } };
  }
  return failure(res);
}

/** Did the engine already send this step for the deal? Its reply may have been lost. */
async function stepSent(tx: Tx, dealId: string, step: "capture" | "void"): Promise<boolean> {
  const [row] = await tx
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.dealId, dealId),
        inArray(auditLog.action, ["paypal.pending", "paypal.failed"]),
        sql`${auditLog.detailsJson} -> 'paypal' ->> 'step' = ${step}`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * A capture or void still waiting for PayPal's answer: the latest PayPal outcome logged for the
 * deal is `paypal.pending`. Returns the step and how many tries have gone unanswered.
 */
async function pendingStep(tx: Tx, dealId: string) {
  const rows = await tx
    .select({ action: auditLog.action, details: auditLog.detailsJson })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.dealId, dealId),
        inArray(auditLog.action, ["paypal.pending", "paypal.failed", "state.changed"]),
      ),
    )
    .orderBy(desc(auditLog.id))
    .limit(MAX_PENDING_TRIES + 1);
  const stepOf = (r: (typeof rows)[number]) =>
    (r.details as { paypal?: { step?: string } }).paypal?.step;
  const first = rows[0];
  const step = first?.action === "paypal.pending" ? stepOf(first) : undefined;
  if (step !== "capture" && step !== "void") return null;
  let tries = 0;
  for (const r of rows) {
    if (r.action !== "paypal.pending" || stepOf(r) !== step) break;
    tries++;
  }
  return { step, tries } as const;
}

/** Turn PayPal's view of the authorisation into a reconciliation trigger, if it needs one. */
async function authStatusTrigger(tx: Tx, dealId: string, status: string): Promise<Trigger | null> {
  if (status === "VOIDED" || status === "EXPIRED") {
    return {
      type: "AUTH_ENDED",
      voidedByUs: status === "VOIDED" && (await stepSent(tx, dealId, "void")),
    };
  }
  if (status === "CAPTURED" || status === "PARTIALLY_CAPTURED") {
    return { type: "AUTH_CAPTURED", capturedByUs: await stepSent(tx, dealId, "capture") };
  }
  return null;
}

/** After a reconciliation move, record PayPal's status on the payment row too. */
async function syncPaymentStatus({ tx, deal, now }: Ctx, to: DealState) {
  if (to !== "CAPTURED" && to !== "VOIDED" && to !== "EXPIRED") return;
  await tx
    .update(payments)
    .set({ status: to, updatedAt: now })
    .where(and(eq(payments.dealId, deal.id), eq(payments.attempt, deal.paymentAttempt)));
}

async function openReview(
  tx: Tx,
  dealId: string,
  review: { kind: ReviewKind; reason: string; note?: string },
) {
  const [open] = await tx
    .select({ id: reviews.id })
    .from(reviews)
    .where(and(eq(reviews.dealId, dealId), isNull(reviews.decision)))
    .limit(1);
  if (!open) await tx.insert(reviews).values({ dealId, ...review });
}

/** Close a review the deal left without an admin decision (e.g. a late buyer confirmation). */
async function closeReview(tx: Tx, dealId: string, to: DealState, actor: string, now: Date) {
  await tx
    .update(reviews)
    .set({
      decision: to === "CAPTURED" ? "capture" : to === "VOIDED" ? "void" : "cleared",
      decidedBy: actor,
      decidedAt: now,
    })
    .where(and(eq(reviews.dealId, dealId), isNull(reviews.decision)));
}

const REVIEW_STATES: readonly DealState[] = ["IN_REVIEW", "CAPTURE_FAILED"];

async function transition(
  deps: EngineDeps,
  dealId: string,
  source: TriggerSource,
  opts: RunOptions,
): Promise<EngineResult> {
  return deps.db.transaction(async (tx) => {
    const lockQuery = tx.select().from(deals).where(eq(deals.id, dealId));
    const [deal] = await (opts.skipLocked
      ? lockQuery.for("no key update", { skipLocked: true })
      : lockQuery.for("no key update"));
    if (!deal) return { outcome: "skipped", reason: "deal not found or locked" } as const;

    const now = deps.now();
    const ctx: Ctx = { tx, deal, deps, now };
    const trigger = typeof source === "function" ? await source(ctx) : source;
    const from = deal.state;
    const audit = (action: string, details: Record<string, unknown>) =>
      appendAudit(
        tx,
        { dealId, actor: opts.actor, action, details: { ...opts.details, ...details } },
        now,
      );

    if (typeof trigger === "string") {
      await audit("trigger.rejected", { state: from, reason: trigger });
      return { outcome: "rejected", state: from, reason: trigger } as const;
    }

    const decision: Decision = nextState(await snapshot(tx, deal), trigger, now, {
      timeScale: deps.timeScale,
    });
    const base = { trigger: trigger.type, state: from, reason: decision.reason };

    if (decision.kind === "reject") {
      await audit("trigger.rejected", base);
      return { outcome: "rejected", state: from, reason: decision.reason } as const;
    }
    if (decision.kind === "stay") {
      const patch = (await opts.effects?.(ctx, from)) ?? undefined;
      if (patch && Object.keys(patch).length) {
        await tx
          .update(deals)
          .set({ ...patch, updatedAt: now })
          .where(eq(deals.id, dealId));
      }
      // Sweep runs every few minutes; logging every "nothing to do" would flood the audit log.
      if (opts.actor !== "sweep") await audit("trigger.accepted", base);
      return { outcome: "unchanged", state: from, reason: decision.reason } as const;
    }

    let to = decision.to;
    let patch: DealPatch = {};
    let paypalInfo: Record<string, unknown> | undefined;
    let failedIssue: string | undefined;

    if (decision.paypal) {
      const step = await runPaypalStep(ctx, decision.paypal);
      paypalInfo = { step: decision.paypal, ...step.info };
      if (!step.ok) {
        // PayPal's reason, in the server log too (Render logs); never amounts, emails or tokens.
        console.warn(
          `PayPal ${decision.paypal} not completed for deal ${deal.publicRef}: ${step.issue}` +
            ` (http ${String(step.info.httpStatus ?? "-")}, debug_id ${String(step.info.debugId ?? "-")}` +
            `${step.retryable ? ", will retry" : ""})`,
        );
      }
      if (!step.ok && step.retryable) {
        await audit("paypal.pending", { ...base, paypal: paypalInfo });
        return {
          outcome: "pending",
          state: from,
          reason: `PayPal did not complete ${decision.paypal} (${step.issue}); it will be retried`,
        } as const;
      }
      if (!step.ok) {
        failedIssue = step.issue;
        to = decision.onFailure ?? from;
        // A capture or void that PayPal refused is never retried blindly with the same key.
        if (decision.paypal !== "authorize") patch.settleAttempt = deal.settleAttempt + 1;
      } else {
        patch = step.patch;
      }
    }

    if (!failedIssue) Object.assign(patch, (await opts.effects?.(ctx, to)) ?? {});
    // Deals that need a person (review, or a capture PayPal refused) get an open review.
    if (REVIEW_STATES.includes(to) && from !== to) {
      await openReview(tx, dealId, {
        kind: failedIssue ? "paypal" : (decision.review ?? "other"),
        reason: failedIssue ? `PayPal refused ${decision.paypal}: ${failedIssue}` : decision.reason,
        note: opts.reviewNote,
      });
    } else if (REVIEW_STATES.includes(from) && !REVIEW_STATES.includes(to)) {
      // An admin decision has already closed its review; this closes the rest.
      await closeReview(tx, dealId, to, opts.actor, now);
    }
    await tx
      .update(deals)
      .set({ ...patch, state: to, version: deal.version + 1, updatedAt: now })
      .where(eq(deals.id, dealId));
    await audit(failedIssue ? "paypal.failed" : "state.changed", {
      ...base,
      from,
      to,
      ...(paypalInfo && { paypal: paypalInfo }),
    });

    if (failedIssue) {
      return { outcome: "failed", from, to, reason: decision.reason, issue: failedIssue } as const;
    }
    return { outcome: "moved", from, to, reason: decision.reason } as const;
  });
}

// ---- Payment set-up (no state change) ----------------------------------------------------------

export type PreparePaymentResult = { ok: true; orderId: string } | { ok: false; reason: string };

/** Order statuses that can still be approved and authorised. */
const USABLE_ORDER = new Set(["CREATED", "SAVED", "PAYER_ACTION_REQUIRED", "APPROVED"]);

/**
 * Create (or reuse) the PayPal order for the deal's current payment attempt. Amount, currency,
 * payee and description come from the locked terms on the deal row, never from the browser.
 * A new attempt (request id `create-v<n+1>`) starts only after a failed authorisation or when the
 * previous order can no longer be used.
 */
export async function preparePayment(
  dealId: string,
  deps = defaultDeps(),
): Promise<PreparePaymentResult> {
  return deps.db.transaction(async (tx) => {
    const [deal] = await tx.select().from(deals).where(eq(deals.id, dealId)).for("no key update");
    if (!deal) return { ok: false, reason: "deal not found" };
    if (deal.state !== "AGREED" && deal.state !== "FUNDING_FAILED") {
      return { ok: false, reason: `payment is not possible in state ${deal.state}` };
    }
    if (!deal.amount || !deal.payeeEmail || !deal.confirmedTermsId) {
      return { ok: false, reason: "the terms are not locked yet" };
    }
    // Checked at creation too; again here in case MAX_DEAL_USD was lowered since (section 5.1).
    if (Number(deal.amount) > deps.maxDealUsd) {
      return {
        ok: false,
        reason: `the deal amount is above the ${deps.maxDealUsd} USD limit per deal`,
      };
    }
    const now = deps.now();
    const audit = (action: string, details: Record<string, unknown>) =>
      appendAudit(tx, { dealId, actor: "buyer", action, details }, now);
    // Dates agreed in the terms must still be ahead, or the deal would be voided at once.
    for (const [label, at] of [
      ["ship-by", deal.shipBy],
      ["deliver-by", deal.deliverBy],
    ] as const) {
      if (at && at <= now) {
        return {
          ok: false,
          reason: `the agreed ${label} date has passed; cancel this deal and agree new dates`,
        };
      }
    }

    let attempt = deal.paymentAttempt;
    const existing = await currentPayment(tx, deal);
    if (existing) {
      let usable = !existing.status.startsWith("AUTHORIZE_FAILED");
      if (usable) {
        const order = await deps.paypal.getOrder(existing.paypalOrderId, dealId);
        usable = order.ok && USABLE_ORDER.has(order.value.status);
        if (!order.ok && order.retryable) {
          return { ok: false, reason: "PayPal is not answering; try again in a moment" };
        }
      }
      if (usable) return { ok: true, orderId: existing.paypalOrderId };
      attempt += 1;
      await tx
        .update(deals)
        .set({ paymentAttempt: attempt, version: deal.version + 1, updatedAt: now })
        .where(eq(deals.id, dealId));
    }

    const [terms] = await tx
      .select({ json: dealTerms.termsJson })
      .from(dealTerms)
      .where(eq(dealTerms.id, deal.confirmedTermsId));
    const item = dealTermsSchema.parse(terms.json).item;
    const requestId = paypalRequestId(dealId, "create", attempt);
    const res = await deps.paypal.createOrder(
      {
        dealId,
        publicRef: deal.publicRef,
        amount: deal.amount,
        currency: "USD",
        payeeEmail: deal.payeeEmail,
        description: item,
      },
      requestId,
    );
    if (!res.ok) {
      await audit("paypal.create_failed", { attempt, issue: res.issue, debugId: res.debugId });
      console.warn(
        `PayPal create order failed for deal ${deal.publicRef}: ${res.issue} (debug_id ${res.debugId ?? "-"})`,
      );
      return { ok: false, reason: `PayPal could not create the order (${res.issue})` };
    }
    await tx.insert(payments).values({
      dealId,
      paypalOrderId: res.value.id,
      status: res.value.status,
      amount: deal.amount,
      currency: deal.currency,
      attempt,
    });
    await audit("payment.order_created", { attempt, orderId: res.value.id, requestId });
    return { ok: true, orderId: res.value.id };
  });
}

// ---- Triggers ---------------------------------------------------------------------------------

/** A party confirms the terms they were shown (by hash); the second matching confirmation agrees the deal. */
export function onTermsConfirmed(
  dealId: string,
  input: { role: "buyer" | "seller"; termsHash: string },
  deps = defaultDeps(),
) {
  return transition(
    deps,
    dealId,
    async ({ tx }) => {
      const [latest] = await tx
        .select()
        .from(dealTerms)
        .where(eq(dealTerms.dealId, dealId))
        .orderBy(desc(dealTerms.version))
        .limit(1);
      if (!latest) return "the deal has no terms yet";
      if (latest.termsHash !== input.termsHash) return "the terms changed; review them again";
      await tx
        .insert(confirmations)
        .values({ dealId, termsId: latest.id, role: input.role })
        .onConflictDoNothing();
      return { type: "CONFIRM" };
    },
    {
      actor: input.role,
      details: { termsHash: input.termsHash },
      effects: async ({ tx }, to) => {
        if (to !== "AGREED") return;
        // Lock the terms: amount, currency, payee and deadlines are copied from the confirmed
        // version, and only these copies are ever sent to PayPal (rule 2).
        const [latest] = await tx
          .select()
          .from(dealTerms)
          .where(eq(dealTerms.dealId, dealId))
          .orderBy(desc(dealTerms.version))
          .limit(1);
        const terms = dealTermsSchema.parse(latest.termsJson);
        return {
          confirmedTermsId: latest.id,
          amount: terms.price.amount,
          currency: terms.price.currency,
          payeeEmail: terms.payeeEmail,
          shipBy: terms.shipBy ? new Date(terms.shipBy) : null,
          deliverBy: terms.deliverBy ? new Date(terms.deliverBy) : null,
          inspectionHours: terms.inspectionHours,
        };
      },
    },
  );
}

/**
 * The buyer approved the PayPal order in the browser. The order id is checked against the deal's
 * own payment record and re-read from PayPal; the browser's word alone is never enough.
 */
export function onBuyerApproved(dealId: string, orderId: string, deps = defaultDeps()) {
  return transition(
    deps,
    dealId,
    async ({ tx, deal }) => {
      const payment = await currentPayment(tx, deal);
      if (!payment || payment.paypalOrderId !== orderId) {
        return "this PayPal order does not belong to the deal's current payment";
      }
      const order = await deps.paypal.getOrder(orderId, dealId);
      const unit = order.ok ? order.value.purchase_units?.[0] : undefined;
      const approved =
        order.ok &&
        order.value.status === "APPROVED" &&
        unit?.custom_id === dealId &&
        unit.amount?.value === deal.amount &&
        unit.amount?.currency_code === deal.currency;
      return { type: "BUYER_APPROVED", orderApproved: approved };
    },
    { actor: "buyer", details: { orderId } },
  );
}

export function onTrackingSubmitted(
  dealId: string,
  input: { carrier: string; trackingNumber: string },
  deps = defaultDeps(),
) {
  return transition(
    deps,
    dealId,
    { type: "TRACKING_SUBMITTED" },
    {
      actor: "seller",
      details: { carrier: input.carrier },
      effects: async ({ tx }) => {
        await tx.insert(evidence).values({
          dealId,
          type: "tracking",
          addedBy: "seller",
          carrier: input.carrier,
          trackingNumber: input.trackingNumber,
        });
      },
    },
  );
}

/** A courier "delivered" event; `verified` must come from the webhook signature check. */
export function onCourierDelivered(
  dealId: string,
  input: { verified: boolean; deliveredAt: Date; eventId: string },
  deps = defaultDeps(),
) {
  return transition(
    deps,
    dealId,
    { type: "COURIER_DELIVERED", verified: input.verified },
    {
      actor: "courier",
      details: { eventId: input.eventId },
      effects: async (_ctx, to) =>
        to === "DELIVERED"
          ? { deliveredAt: input.deliveredAt, deliveryProof: "courier" as const }
          : undefined,
    },
  );
}

/**
 * The seller enters the code the buyer gave them at handover. A correct code is a verified
 * delivery; the 5th wrong code locks entry and flags the deal for an admin. The code itself is
 * never logged.
 */
export function onHandoverCode(dealId: string, code: string, deps = defaultDeps()) {
  return transition(
    deps,
    dealId,
    async ({ tx, deal, now }) => {
      if (deal.handoverLocked) {
        return "code entry is locked after 5 wrong codes; a SafeDeal reviewer has been alerted";
      }
      const stored =
        deal.handoverCodeHash ??
        (deps.handoverSecret
          ? handoverHash(deal.id, handoverCode(deal.id, deps.handoverSecret))
          : null);
      if (!stored) return "this deal has no handover code";
      if (codeMatches(stored, deal.id, code)) return { type: "HANDOVER_VERIFIED" };
      const attempts = deal.handoverAttempts + 1;
      const locked = attempts >= HANDOVER_MAX_ATTEMPTS;
      await tx
        .update(deals)
        .set({ handoverAttempts: attempts, handoverLocked: locked, updatedAt: now })
        .where(eq(deals.id, dealId));
      if (locked) {
        await appendAudit(
          tx,
          { dealId, actor: "seller", action: "handover.locked", details: { attempts } },
          now,
        );
        return "wrong code. Code entry is now locked; a SafeDeal reviewer has been alerted";
      }
      const left = HANDOVER_MAX_ATTEMPTS - attempts;
      return `wrong code. ${left} ${left === 1 ? "try" : "tries"} left before code entry locks`;
    },
    {
      actor: "seller",
      effects: async ({ now }, to) =>
        to === "DELIVERED"
          ? { deliveredAt: now, deliveryProof: "handover_code" as const, handoverAttempts: 0 }
          : undefined,
    },
  );
}

/** Either party proposes a new deliver-by date. A newer proposal replaces an open one. */
export function onExtensionProposed(
  dealId: string,
  input: { role: "buyer" | "seller"; newDeliverBy: Date },
  deps = defaultDeps(),
) {
  return transition(
    deps,
    dealId,
    { type: "EXTENSION_PROPOSED", newDeliverBy: input.newDeliverBy },
    {
      actor: input.role,
      details: { newDeliverBy: input.newDeliverBy.toISOString() },
      effects: async ({ tx, deal, now }) => {
        await tx
          .update(extensions)
          .set({ status: "expired", decidedAt: now })
          .where(and(eq(extensions.dealId, dealId), eq(extensions.status, "proposed")));
        await tx.insert(extensions).values({
          dealId,
          proposedBy: input.role,
          oldDeliverBy: deal.deliverBy,
          newDeliverBy: input.newDeliverBy,
        });
      },
    },
  );
}

/**
 * The other party accepts or rejects a proposed date. Accepting creates a new terms version with
 * the new deliver-by, confirmed by both (the proposer by proposing, the other by accepting), and a
 * deal in a deliver-by review goes back to SHIPPED.
 */
export function onExtensionDecided(
  dealId: string,
  input: { role: "buyer" | "seller"; extensionId: string; accept: boolean },
  deps = defaultDeps(),
) {
  return transition(
    deps,
    dealId,
    async ({ tx }) => {
      const [ext] = await tx
        .select()
        .from(extensions)
        .where(and(eq(extensions.id, input.extensionId), eq(extensions.dealId, dealId)));
      if (!ext || ext.status !== "proposed") return "this date change is no longer open";
      if (ext.proposedBy === input.role) {
        return "the other party has to accept or reject the date you proposed";
      }
      return input.accept
        ? { type: "EXTENSION_ACCEPTED", newDeliverBy: ext.newDeliverBy }
        : { type: "EXTENSION_REJECTED" };
    },
    {
      actor: input.role,
      details: { extensionId: input.extensionId, accept: input.accept },
      effects: async ({ tx, now }) => {
        const [ext] = await tx
          .select()
          .from(extensions)
          .where(eq(extensions.id, input.extensionId));
        if (!input.accept) {
          await tx
            .update(extensions)
            .set({ status: "rejected", decidedAt: now })
            .where(eq(extensions.id, ext.id));
          return;
        }
        const [latest] = await tx
          .select()
          .from(dealTerms)
          .where(eq(dealTerms.dealId, dealId))
          .orderBy(desc(dealTerms.version))
          .limit(1);
        const prev = dealTermsSchema.parse(latest.termsJson);
        const terms = { ...prev, deliverBy: ext.newDeliverBy.toISOString() };
        const [added] = await tx
          .insert(dealTerms)
          .values({
            dealId,
            version: latest.version + 1,
            termsJson: terms,
            termsHash: termsHash(terms),
            sourceRefsJson: carrySourceRefs(latest.sourceRefsJson, prev, terms) ?? {},
            proposedBy: "user",
          })
          .returning({ id: dealTerms.id });
        await tx.insert(confirmations).values([
          { dealId, termsId: added.id, role: "buyer" },
          { dealId, termsId: added.id, role: "seller" },
        ]);
        await tx
          .update(extensions)
          .set({ status: "accepted", termsId: added.id, decidedAt: now })
          .where(eq(extensions.id, ext.id));
        return { deliverBy: ext.newDeliverBy, confirmedTermsId: added.id };
      },
    },
  );
}

/** Admin lifts a handover lock (e.g. after talking to both parties), with a written reason. */
export async function onHandoverUnlock(
  dealId: string,
  input: { reason: string; admin: string },
  deps = defaultDeps(),
): Promise<{ ok: boolean; reason: string }> {
  if (!input.reason.trim()) return { ok: false, reason: "unlocking needs a reason" };
  return deps.db.transaction(async (tx) => {
    const [deal] = await tx.select().from(deals).where(eq(deals.id, dealId)).for("no key update");
    if (!deal?.handoverLocked) return { ok: false, reason: "code entry is not locked" };
    const now = deps.now();
    await tx
      .update(deals)
      .set({ handoverLocked: false, handoverAttempts: 0, updatedAt: now })
      .where(eq(deals.id, dealId));
    await appendAudit(
      tx,
      {
        dealId,
        actor: "admin",
        action: "handover.unlocked",
        details: { adminReason: input.reason, admin: input.admin },
      },
      now,
    );
    return { ok: true, reason: "code entry unlocked" };
  });
}

export function onBuyerConfirmed(dealId: string, deps = defaultDeps()) {
  return transition(
    deps,
    dealId,
    { type: "BUYER_CONFIRMED" },
    {
      actor: "buyer",
      // The buyer's word is the proof unless a courier event or handover code came first.
      effects: async ({ deal }, to) =>
        to === "CAPTURED" && !deal.deliveryProof ? { deliveryProof: "buyer" as const } : undefined,
    },
  );
}

export function onBuyerProblem(dealId: string, note: string, deps = defaultDeps()) {
  return transition(
    deps,
    dealId,
    { type: "BUYER_PROBLEM" },
    {
      actor: "buyer",
      reviewNote: note.slice(0, 2000),
      // A deal already in a deadline review keeps that review, now marked as a complaint.
      effects: async ({ tx, deal }) => {
        if (deal.state !== "IN_REVIEW") return;
        await tx
          .update(reviews)
          .set({ kind: "buyer_problem", note: note.slice(0, 2000) })
          .where(and(eq(reviews.dealId, dealId), isNull(reviews.decision)));
      },
    },
  );
}

export function onAdminDecision(
  dealId: string,
  input: { decision: "capture" | "void"; reason: string; admin: string },
  deps = defaultDeps(),
) {
  return transition(
    deps,
    dealId,
    { type: "ADMIN_DECISION", decision: input.decision, reason: input.reason },
    {
      actor: "admin",
      details: { decision: input.decision, adminReason: input.reason, admin: input.admin },
      effects: async ({ tx, now }) => {
        await tx
          .update(reviews)
          .set({
            decision: input.decision,
            decidedBy: input.admin,
            note: input.reason,
            decidedAt: now,
          })
          .where(and(eq(reviews.dealId, dealId), isNull(reviews.decision)));
      },
    },
  );
}

export function onCancel(dealId: string, role: "buyer" | "seller", deps = defaultDeps()) {
  return transition(deps, dealId, { type: "CANCEL" }, { actor: role });
}

/**
 * Deadlines and reconciliation for every deal whose money is held. Safe to run twice at once:
 * a deal locked by the other run is skipped, and every PayPal call has a fixed request id.
 */
export async function onSweep(deps = defaultDeps()) {
  await expireExtensions(deps);
  const held = await deps.db
    .select({ id: deals.id })
    .from(deals)
    .where(inArray(deals.state, [...HELD_STATES]));
  const results: { dealId: string; result: EngineResult }[] = [];
  for (const { id } of held) {
    const result = await transition(
      deps,
      id,
      async ({ tx, deal }) => {
        // Reconcile first: if PayPal already ended or captured the hold (perhaps through a call
        // whose reply was lost), that decides the state and deadlines no longer apply.
        const payment = await currentPayment(tx, deal);
        if (payment?.authorizationId) {
          const auth = await deps.paypal.getAuth(payment.authorizationId, id);
          if (!auth.ok) return { type: "SWEEP" };
          const reconcile = await authStatusTrigger(tx, id, auth.value.status);
          if (reconcile) return reconcile;
          // PayPal still holds the money, so an unanswered capture or void did not happen and is
          // safe to repeat with the same request id (even after PayPal has forgotten that id).
          const pending = auth.value.status === "CREATED" ? await pendingStep(tx, id) : null;
          if (pending) return { type: "RETRY_PENDING", ...pending };
        }
        return { type: "SWEEP" };
      },
      { actor: "sweep", skipLocked: true, effects: syncPaymentStatus },
    );
    results.push({ dealId: id, result });
  }
  return results;
}

/** Open date proposals whose date has passed, or whose deal can no longer be extended. */
async function expireExtensions(deps: EngineDeps) {
  const now = deps.now();
  await deps.db.transaction(async (tx) => {
    const stale = await tx
      .select({ id: extensions.id, dealId: extensions.dealId })
      .from(extensions)
      .innerJoin(deals, eq(deals.id, extensions.dealId))
      .where(
        and(
          eq(extensions.status, "proposed"),
          or(lte(extensions.newDeliverBy, now), notInArray(deals.state, ["SHIPPED", "IN_REVIEW"])),
        ),
      );
    for (const x of stale) {
      await tx
        .update(extensions)
        .set({ status: "expired", decidedAt: now })
        .where(eq(extensions.id, x.id));
      await appendAudit(
        tx,
        {
          dealId: x.dealId,
          actor: "sweep",
          action: "extension.expired",
          details: { extensionId: x.id },
        },
        now,
      );
    }
  });
}

type WebhookEvent = { id: string; event_type: string; resource?: unknown };

async function dealIdFor(db: Db, column: "authorizationId" | "captureId", value: string) {
  const [p] = await db
    .select({ dealId: payments.dealId })
    .from(payments)
    .where(eq(payments[column], value))
    .limit(1);
  return p?.dealId;
}

/**
 * A PayPal webhook that the route has already verified and stored. The resource is re-read from
 * PayPal before any state change, because events arrive late, twice or out of order.
 */
export async function onPaypalWebhook(
  event: WebhookEvent,
  deps = defaultDeps(),
): Promise<EngineResult | { outcome: "ignored"; reason: string }> {
  const resource = (event.resource ?? {}) as { id?: string; dispute_id?: string };
  const actorOpts = {
    actor: "paypal",
    details: { webhookEventId: event.id, eventType: event.event_type },
  };

  if (event.event_type === "PAYMENT.AUTHORIZATION.VOIDED" && resource.id) {
    const authId = resource.id;
    const dealId = await dealIdFor(deps.db, "authorizationId", authId);
    if (!dealId) return { outcome: "ignored", reason: "no deal for this authorization" };
    return transition(
      deps,
      dealId,
      async ({ tx }) => {
        const auth = await deps.paypal.getAuth(authId, dealId);
        if (!auth.ok) return `could not re-read the authorization (${auth.issue})`;
        if (auth.value.status !== "VOIDED" && auth.value.status !== "EXPIRED") {
          return `PayPal reports the authorization as ${auth.value.status}`;
        }
        return (await authStatusTrigger(tx, dealId, auth.value.status)) as Trigger;
      },
      { ...actorOpts, effects: syncPaymentStatus },
    );
  }

  if (
    (event.event_type === "CUSTOMER.DISPUTE.CREATED" ||
      event.event_type === "CUSTOMER.DISPUTE.RESOLVED") &&
    (resource.dispute_id ?? resource.id)
  ) {
    const disputeId = (resource.dispute_id ?? resource.id) as string;
    const dispute = await deps.paypal.getDispute(disputeId);
    if (!dispute.ok)
      return { outcome: "ignored", reason: `could not re-read the dispute (${dispute.issue})` };
    const captureId = dispute.value.captureIds[0];
    const dealId = captureId && (await dealIdFor(deps.db, "captureId", captureId));
    if (!dealId) return { outcome: "ignored", reason: "no deal for this dispute" };
    const trigger: Trigger =
      event.event_type === "CUSTOMER.DISPUTE.CREATED"
        ? { type: "DISPUTE_CREATED", verified: true }
        : { type: "DISPUTE_RESOLVED", verified: dispute.value.status === "RESOLVED" };
    return transition(deps, dealId, trigger, {
      ...actorOpts,
      details: { ...actorOpts.details, disputeId, disputeStatus: dispute.value.status },
    });
  }

  return { outcome: "ignored", reason: `no state change for ${event.event_type}` };
}
