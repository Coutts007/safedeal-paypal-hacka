import { timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { appendAudit } from "@/lib/audit";
import type { Db } from "@/lib/db";
import {
  auditLog,
  confirmations,
  deals,
  dealTerms,
  evidence,
  payments,
  type Deal,
  type DealState,
} from "@/lib/db/schema";
import { newPublicRef, newRoleToken } from "@/lib/deals/ids";
import { dealTermsSchema, parseDealTerms, termsHash, type DealTerms } from "@/lib/deals/terms";
import { hardLimit, inspectionEndsAt, reviewAt, type DealSnapshot } from "@/lib/rules/machine";

// Deal data access for routes and pages. State changes go through lib/rules/engine.ts; this file
// only creates deals, stores new terms versions while in DRAFT, and builds read-only views.

export type Role = "buyer" | "seller";

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The deal for this link and the role its token grants, or null (unknown ref or wrong token). */
export async function dealForToken(db: Db, ref: string, token: string | null) {
  if (!token || !/^[0-9A-Z]{6,20}$/.test(ref)) return null;
  const [deal] = await db.select().from(deals).where(eq(deals.publicRef, ref));
  if (!deal) return null;
  if (sameToken(token, deal.sellerToken)) return { deal, role: "seller" as Role };
  if (sameToken(token, deal.buyerToken)) return { deal, role: "buyer" as Role };
  return null;
}

export function dealLinks(
  appBaseUrl: string,
  deal: Pick<Deal, "publicRef" | "sellerToken" | "buyerToken">,
) {
  const link = (t: string) => `${appBaseUrl}/deal/${deal.publicRef}?t=${encodeURIComponent(t)}`;
  return { seller: link(deal.sellerToken), buyer: link(deal.buyerToken) };
}

export type NewDealInput = { terms: unknown; sellerName: string; buyerName: string };

/** A seller creates a DRAFT deal from hand-entered terms (version 1). */
export async function createDeal(db: Db, input: NewDealInput, maxUsd: number) {
  const terms = parseDealTerms(input.terms, maxUsd);
  return db.transaction(async (tx) => {
    const [deal] = await tx
      .insert(deals)
      .values({
        publicRef: newPublicRef(),
        sellerToken: newRoleToken(),
        buyerToken: newRoleToken(),
        sellerName: input.sellerName,
        buyerName: input.buyerName,
      })
      .returning();
    await tx.insert(dealTerms).values({
      dealId: deal.id,
      version: 1,
      termsJson: terms,
      termsHash: termsHash(terms),
      proposedBy: "user",
    });
    await appendAudit(tx, {
      dealId: deal.id,
      actor: "seller",
      action: "deal.created",
      details: { termsVersion: 1 },
    });
    return deal;
  });
}

export type TermsUpdate =
  { ok: true; version: number; termsHash: string } | { ok: false; reason: string };

/** Either party proposes changed terms while the deal is a DRAFT; earlier confirmations no longer match. */
export async function proposeTerms(
  db: Db,
  dealId: string,
  role: Role,
  input: unknown,
  maxUsd: number,
) {
  const terms = parseDealTerms(input, maxUsd);
  const hash = termsHash(terms);
  return db.transaction(async (tx): Promise<TermsUpdate> => {
    const [deal] = await tx.select().from(deals).where(eq(deals.id, dealId)).for("no key update");
    if (!deal) return { ok: false, reason: "deal not found" };
    if (deal.state !== "DRAFT") return { ok: false, reason: "the terms are locked" };
    const [latest] = await tx
      .select({ version: dealTerms.version, hash: dealTerms.termsHash })
      .from(dealTerms)
      .where(eq(dealTerms.dealId, dealId))
      .orderBy(desc(dealTerms.version))
      .limit(1);
    if (latest?.hash === hash) return { ok: true, version: latest.version, termsHash: hash };
    const version = (latest?.version ?? 0) + 1;
    await tx
      .insert(dealTerms)
      .values({ dealId, version, termsJson: terms, termsHash: hash, proposedBy: "user" });
    await tx
      .update(deals)
      .set({ version: deal.version + 1, updatedAt: new Date() })
      .where(eq(deals.id, dealId));
    await appendAudit(tx, {
      dealId,
      actor: role,
      action: "terms.proposed",
      details: { version, termsHash: hash },
    });
    return { ok: true, version, termsHash: hash };
  });
}

// ---- Read-only view for the Deal Room ---------------------------------------------------------

export type DealAction =
  | "confirm_terms"
  | "edit_terms"
  | "cancel"
  | "pay"
  | "add_tracking"
  | "confirm_receipt"
  | "report_problem";

export type TimelineStep = {
  key: string;
  label: string;
  state: "done" | "current" | "todo" | "stopped";
};

const STEPS = [
  { key: "agreed", label: "Agreed" },
  { key: "held", label: "Funds held" },
  { key: "shipped", label: "Shipped" },
  { key: "delivered", label: "Delivered" },
  { key: "paid", label: "Paid" },
] as const;

/** How far along the happy path each state is (index into STEPS), and whether it stopped there. */
const PROGRESS: Record<DealState, { reached: number; stopped?: boolean }> = {
  DRAFT: { reached: -1 },
  AGREED: { reached: 0 },
  FUNDING_FAILED: { reached: 0, stopped: true },
  AUTHORIZED: { reached: 1 },
  SHIPPED: { reached: 2 },
  DELIVERED: { reached: 3 },
  IN_REVIEW: { reached: 2, stopped: true },
  CAPTURE_FAILED: { reached: 3, stopped: true },
  CAPTURED: { reached: 4 },
  VOIDED: { reached: 1, stopped: true },
  EXPIRED: { reached: 1, stopped: true },
  DISPUTED: { reached: 4, stopped: true },
  CLOSED: { reached: 4 },
  CANCELLED: { reached: -1, stopped: true },
};

export function timeline(state: DealState): TimelineStep[] {
  const { reached, stopped } = PROGRESS[state];
  return STEPS.map((s, i) => ({
    ...s,
    state:
      i < reached
        ? "done"
        : i === reached
          ? stopped
            ? "stopped"
            : state === "CAPTURED" || state === "CLOSED"
              ? "done"
              : "current"
          : "todo",
  }));
}

const NAIROBI = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Nairobi",
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
export const nairobiTime = (d: Date) => NAIROBI.format(d);

/** Plain-language status for each role (section 8.6). */
export function statusLine(
  state: DealState,
  role: Role,
  d: { shipBy: Date | null; inspectionEnds: Date | null },
): string {
  const ship = d.shipBy ? nairobiTime(d.shipBy) : "the ship-by time";
  switch (state) {
    case "DRAFT":
      return "Check the terms. When you both confirm the same terms, the deal is agreed.";
    case "AGREED":
      return role === "buyer"
        ? "Terms agreed. Pay with PayPal: the money is held, not sent to the seller yet."
        : "Terms agreed. Waiting for the buyer to pay with PayPal.";
    case "FUNDING_FAILED":
      return role === "buyer"
        ? "PayPal could not hold the money. Try again, perhaps with another funding source."
        : "The buyer's payment did not go through. Waiting for them to try again.";
    case "AUTHORIZED":
      return role === "buyer"
        ? `Funds are held by PayPal. If the seller does not add tracking by ${ship}, they will be released to you.`
        : `Funds are held by PayPal. Ship the item and add tracking by ${ship}, or the hold is released to the buyer.`;
    case "SHIPPED":
      return role === "buyer"
        ? "The seller has shipped. When it arrives, confirm receipt to pay them, or report a problem."
        : "Shipped. You are paid when the buyer confirms receipt, or after a verified delivery and the inspection window.";
    case "DELIVERED": {
      const end = d.inspectionEnds
        ? nairobiTime(d.inspectionEnds)
        : "the end of the inspection window";
      return role === "buyer"
        ? `Delivered. Check the item: confirm receipt, or report a problem before ${end}. Otherwise the seller is paid then.`
        : `Delivered. You are paid when the buyer confirms, or automatically after ${end} if they raise no problem.`;
    }
    case "IN_REVIEW":
      return "A SafeDeal reviewer is looking at this deal. The money stays held until they decide.";
    case "CAPTURED":
      return role === "buyer" ? "Done. The seller has been paid." : "Done. PayPal has paid you.";
    case "CAPTURE_FAILED":
      return "PayPal refused the payment to the seller. A reviewer has been alerted; the money is still held.";
    case "VOIDED":
      return role === "buyer"
        ? "The hold was released. You have not been charged."
        : "The hold was released to the buyer.";
    case "EXPIRED":
      return "PayPal's hold ended before the deal finished. The buyer has not been charged.";
    case "DISPUTED":
      return "The buyer opened a PayPal dispute. PayPal will decide.";
    case "CLOSED":
      return "The PayPal dispute is closed.";
    case "CANCELLED":
      return "This deal was cancelled. No money moved.";
  }
}

const AUDIT_LABELS: Record<string, string> = {
  "deal.created": "Deal created",
  "deal.seeded": "Deal created",
  "terms.proposed": "New terms proposed",
  "payment.order_created": "PayPal order created",
  "state.changed": "Status changed",
  "paypal.failed": "PayPal refused a request",
  "paypal.pending": "Waiting for PayPal",
};

export async function dealView(
  db: Db,
  deal: Deal,
  role: Role,
  opts: { now: Date; timeScale: number; kesPerUsd: number; appBaseUrl: string },
) {
  const [latest] = await db
    .select()
    .from(dealTerms)
    .where(eq(dealTerms.dealId, deal.id))
    .orderBy(desc(dealTerms.version))
    .limit(1);
  const confirmedRoles = latest
    ? (
        await db
          .select({ role: confirmations.role })
          .from(confirmations)
          .where(eq(confirmations.termsId, latest.id))
      ).map((c) => c.role)
    : [];
  const terms: DealTerms | null = latest ? dealTermsSchema.parse(latest.termsJson) : null;
  const ev = await db
    .select({
      type: evidence.type,
      carrier: evidence.carrier,
      trackingNumber: evidence.trackingNumber,
      createdAt: evidence.createdAt,
    })
    .from(evidence)
    .where(eq(evidence.dealId, deal.id))
    .orderBy(asc(evidence.createdAt));
  const [payment] = await db
    .select({ status: payments.status })
    .from(payments)
    .where(and(eq(payments.dealId, deal.id), eq(payments.attempt, deal.paymentAttempt)));
  const history = await db
    .select({
      at: auditLog.createdAt,
      actor: auditLog.actor,
      action: auditLog.action,
      details: auditLog.detailsJson,
    })
    .from(auditLog)
    .where(and(eq(auditLog.dealId, deal.id), inArray(auditLog.action, Object.keys(AUDIT_LABELS))))
    .orderBy(asc(auditLog.id));

  const snap: DealSnapshot = {
    state: deal.state,
    shipBy: deal.shipBy,
    deliverBy: deal.deliverBy,
    deliveredAt: deal.deliveredAt,
    inspectionHours: deal.inspectionHours,
    authorizedAt: deal.authorizedAt,
    authExpiresAt: deal.authExpiresAt,
    hasTracking: ev.some((e) => e.type === "tracking"),
    currentTermsHash: latest?.termsHash ?? null,
    confirmedHashes: { buyer: null, seller: null },
  };
  const t = { timeScale: opts.timeScale };
  const inspectionEnds = inspectionEndsAt(snap, t);
  const s = deal.state;
  const actions: DealAction[] = [];
  if (s === "DRAFT") {
    if (!confirmedRoles.includes(role)) actions.push("confirm_terms");
    actions.push("edit_terms", "cancel");
  }
  if (s === "AGREED" || s === "FUNDING_FAILED") {
    if (role === "buyer") actions.push("pay");
    actions.push("cancel");
  }
  if (role === "seller" && (s === "AUTHORIZED" || s === "SHIPPED")) {
    if (s === "SHIPPED" || !deal.shipBy || opts.now < deal.shipBy) actions.push("add_tracking");
  }
  if (role === "buyer" && (s === "AUTHORIZED" || s === "SHIPPED" || s === "DELIVERED")) {
    actions.push("confirm_receipt");
    if (s === "SHIPPED" || (s === "DELIVERED" && inspectionEnds && opts.now < inspectionEnds)) {
      actions.push("report_problem");
    }
  }

  const amount = deal.amount ?? terms?.price.amount ?? null;
  return {
    ref: deal.publicRef,
    role,
    state: s,
    statusLine: statusLine(s, role, { shipBy: deal.shipBy, inspectionEnds }),
    names: { seller: deal.sellerName, buyer: deal.buyerName },
    terms,
    termsVersion: latest?.version ?? 0,
    termsHash: latest?.termsHash ?? null,
    confirmed: {
      buyer: confirmedRoles.includes("buyer"),
      seller: confirmedRoles.includes("seller"),
    },
    amount,
    kesEstimate: amount ? Math.round(Number(amount) * opts.kesPerUsd) : null,
    deadlines: {
      shipBy: deal.shipBy?.toISOString() ?? null,
      deliverBy: deal.deliverBy?.toISOString() ?? null,
      inspectionEndsAt: inspectionEnds?.toISOString() ?? null,
      reviewAt: reviewAt(snap, t)?.toISOString() ?? null,
      holdEndsAt: hardLimit(snap, t)?.toISOString() ?? null,
    },
    paymentStatus: payment?.status ?? null,
    evidence: ev.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
    timeline: timeline(s),
    actions,
    history: history.map((h) => ({
      at: h.at.toISOString(),
      actor: h.actor,
      label:
        h.action === "state.changed"
          ? `${String((h.details as { from?: string }).from)} → ${String((h.details as { to?: string }).to)}`
          : AUDIT_LABELS[h.action],
    })),
    // Only the seller sees the buyer's link, to send it to them.
    buyerLink: role === "seller" ? dealLinks(opts.appBaseUrl, deal).buyer : null,
    serverTime: opts.now.toISOString(),
  };
}

export type DealView = Awaited<ReturnType<typeof dealView>>;
