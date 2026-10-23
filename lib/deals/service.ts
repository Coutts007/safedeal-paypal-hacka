import { timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { appendAudit } from "@/lib/audit";
import type { Db } from "@/lib/db";
import { parseChat, type ChatMessage } from "@/lib/ai/chat";
import { carrySourceRefs, sourceRefs, toProposal, type SourceRefs } from "@/lib/ai/proposal";
import { usableExtraction } from "@/lib/ai/service";
import {
  aiExtractions,
  auditLog,
  chatSources,
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
import { EVIDENCE_STATES } from "@/lib/deals/evidence";
import { HANDOVER_MAX_ATTEMPTS, handoverCode } from "@/lib/deals/handover";
import { newPublicRef, newRoleToken } from "@/lib/deals/ids";
import { dealTermsSchema, parseDealTerms, termsHash, type DealTerms } from "@/lib/deals/terms";
import {
  extensionProblem,
  hardLimit,
  inspectionEndsAt,
  isDeadlineReview,
  reviewAt,
  type DealSnapshot,
} from "@/lib/rules/machine";

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

export type NewDealInput = {
  terms: unknown;
  sellerName: string;
  buyerName: string;
  /** The chat the AI read for this deal, if the seller started from one. */
  extractionId?: string | null;
};

/** Agreed dates must still be ahead, and shipping cannot come after delivery. */
export function checkTermDates(terms: DealTerms, now: Date): void {
  const ship = terms.shipBy ? Date.parse(terms.shipBy) : null;
  const deliver = terms.deliverBy ? Date.parse(terms.deliverBy) : null;
  if (ship !== null && ship <= now.getTime()) throw new Error("The ship-by date has passed");
  if (deliver !== null && deliver <= now.getTime()) {
    throw new Error("The deliver-by date has passed");
  }
  if (ship !== null && deliver !== null && ship > deliver) {
    throw new Error("The ship-by date is after the deliver-by date");
  }
}

/**
 * A seller creates a DRAFT deal (terms version 1), by hand or from a chat the AI read. With a
 * chat, the redacted chat is kept with the deal and each field records the messages it came from.
 */
export async function createDeal(
  db: Db,
  input: NewDealInput,
  opts: { maxUsd: number; kesPerUsd: number; now: Date },
) {
  const terms = parseDealTerms(input.terms, opts.maxUsd);
  checkTermDates(terms, opts.now);
  const chat = input.extractionId ? await usableExtraction(db, input.extractionId, opts.now) : null;
  if (input.extractionId && !chat) {
    throw new Error("This chat reading has expired or was already used. Read the chat again.");
  }
  const refs = chat?.extraction && sourceRefs(toProposal(chat.extraction, opts.kesPerUsd), terms);
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
      sourceRefsJson: refs ?? {},
      proposedBy: refs ? "ai" : "user",
    });
    if (chat) {
      await tx.insert(chatSources).values({
        dealId: deal.id,
        redactedText: chat.redactedText,
        languageMix: chat.extraction?.language_mix ?? null,
        uploadedBy: "seller",
      });
      await tx.update(aiExtractions).set({ dealId: deal.id }).where(eq(aiExtractions.id, chat.id));
    }
    await appendAudit(tx, {
      dealId: deal.id,
      actor: "seller",
      action: "deal.created",
      details: { termsVersion: 1, fromChat: Boolean(chat), aiProposal: Boolean(refs) },
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
  checkTermDates(terms, new Date());
  const hash = termsHash(terms);
  return db.transaction(async (tx): Promise<TermsUpdate> => {
    const [deal] = await tx.select().from(deals).where(eq(deals.id, dealId)).for("no key update");
    if (!deal) return { ok: false, reason: "deal not found" };
    if (deal.state !== "DRAFT") return { ok: false, reason: "the terms are locked" };
    const [latest] = await tx
      .select({
        version: dealTerms.version,
        hash: dealTerms.termsHash,
        json: dealTerms.termsJson,
        refs: dealTerms.sourceRefsJson,
      })
      .from(dealTerms)
      .where(eq(dealTerms.dealId, dealId))
      .orderBy(desc(dealTerms.version))
      .limit(1);
    // Only the seller decides where the money goes; a buyer's proposal cannot change the payee.
    const currentPayee = latest && dealTermsSchema.parse(latest.json).payeeEmail;
    if (role === "buyer" && currentPayee && currentPayee !== terms.payeeEmail) {
      return {
        ok: false,
        reason: "only the seller can change the PayPal email that receives the money",
      };
    }
    if (latest?.hash === hash) return { ok: true, version: latest.version, termsHash: hash };
    const version = (latest?.version ?? 0) + 1;
    // Fields left unchanged keep citing the chat; changed ones no longer do.
    const refs = latest && carrySourceRefs(latest.refs, dealTermsSchema.parse(latest.json), terms);
    await tx.insert(dealTerms).values({
      dealId,
      version,
      termsJson: terms,
      termsHash: hash,
      sourceRefsJson: refs ?? {},
      proposedBy: "user",
    });
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
  | "report_problem"
  | "enter_handover"
  | "propose_extension"
  | "decide_extension"
  | "add_evidence"
  | "simulate_delivery"
  | "download_bundle";

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
  d: {
    shipBy: Date | null;
    inspectionEnds: Date | null;
    review?: ReviewKind | null;
    handoverLocked?: boolean;
  },
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
      if (d.handoverLocked) {
        return "Handover code entry is locked after 5 wrong codes. A SafeDeal reviewer has been alerted; the money stays held.";
      }
      return role === "buyer"
        ? `Funds are held by PayPal. If the seller does not add tracking or hand the item over by ${ship}, they will be released to you.`
        : `Funds are held by PayPal. Add tracking, or hand the item over and enter the buyer's code, by ${ship}. Otherwise the hold is released to the buyer.`;
    case "SHIPPED":
      if (d.handoverLocked) {
        return "Handover code entry is locked after 5 wrong codes. A SafeDeal reviewer has been alerted; the money stays held.";
      }
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
      if (d.review === "deliver_by") {
        return role === "buyer"
          ? "The delivery date passed without proof of delivery. The money stays held: if you have the item, confirm receipt to pay the seller. If the courier is just late, you can both agree a new date. Otherwise a reviewer decides."
          : "The delivery date passed without a verified delivery. The money stays held: you are paid if the buyer confirms receipt, the courier confirms delivery or you enter the handover code. If the courier is just late, propose a new date. Otherwise a reviewer decides.";
      }
      if (d.review === "day_26") {
        return role === "buyer"
          ? "PayPal's hold is close to its time limit, so a SafeDeal reviewer is checking this deal. If you have the item, confirm receipt to pay the seller."
          : "PayPal's hold is close to its time limit, so a SafeDeal reviewer is checking this deal. You are paid if the buyer confirms receipt or delivery is verified.";
      }
      if (d.review === "buyer_problem") {
        return role === "buyer"
          ? "You reported a problem. The money stays held while a SafeDeal reviewer checks the evidence. Add photos or notes below to help."
          : "The buyer reported a problem. The money stays held while a SafeDeal reviewer checks the evidence. Add photos or notes below to help; you are paid if the claim does not hold up.";
      }
      return "A SafeDeal reviewer is looking at this deal. The money stays held until they decide.";
    case "CAPTURED":
      return role === "buyer" ? "Done. The seller has been paid." : "Done. PayPal has paid you.";
    case "CAPTURE_FAILED":
      return "PayPal refused the payment to the seller. A reviewer has been alerted; the money is still held.";
    case "VOIDED":
      return role === "buyer"
        ? "The hold was released, so you have not been charged. If you paid by card, the hold can take a few days to disappear from your statement. There is nothing to dispute."
        : "The hold was released to the buyer, so this deal was not paid.";
    case "EXPIRED":
      return role === "buyer"
        ? "PayPal's hold ended before the deal finished, so the money is released back to you. You have not been charged."
        : "PayPal's hold ended before the deal finished. The money went back to the buyer; this deal was not paid.";
    case "DISPUTED":
      return role === "buyer"
        ? "You opened a PayPal dispute. PayPal will decide."
        : "The buyer opened a PayPal dispute. Download the evidence bundle below and upload it in PayPal's Resolution Center.";
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
  "evidence.added": "Evidence added",
  "handover.locked": "Handover code locked after 5 wrong codes",
  "handover.unlocked": "Handover code unlocked by a reviewer",
  "extension.expired": "New delivery date proposal expired",
  "trigger.accepted": "",
};

/** Accepted triggers that change nothing but are worth showing (date changes). */
const TRIGGER_LABELS: Record<string, string> = {
  EXTENSION_PROPOSED: "New delivery date proposed",
  EXTENSION_ACCEPTED: "New delivery date agreed",
  EXTENSION_REJECTED: "New delivery date rejected",
};

export async function dealView(
  db: Db,
  deal: Deal,
  role: Role,
  opts: {
    now: Date;
    timeScale: number;
    kesPerUsd: number;
    appBaseUrl: string;
    /** HANDOVER_SECRET: needed to show the buyer their code. */
    handoverSecret?: string;
    demoMode?: boolean;
  },
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
  // The chat the deal came from (redacted), so each field can show the messages it cites.
  const [chat] = await db
    .select({ text: chatSources.redactedText })
    .from(chatSources)
    .where(eq(chatSources.dealId, deal.id))
    .limit(1);
  const [reading] = chat
    ? await db
        .select({ extraction: aiExtractions.extractionJson })
        .from(aiExtractions)
        .where(eq(aiExtractions.dealId, deal.id))
        .limit(1)
    : [];
  const flagged =
    (reading?.extraction as { instruction_flags?: { message_id: string; reason: string }[] } | null)
      ?.instruction_flags ?? [];
  const ev = await db
    .select({
      id: evidence.id,
      type: evidence.type,
      addedBy: evidence.addedBy,
      carrier: evidence.carrier,
      trackingNumber: evidence.trackingNumber,
      note: evidence.note,
      createdAt: evidence.createdAt,
    })
    .from(evidence)
    .where(eq(evidence.dealId, deal.id))
    .orderBy(asc(evidence.createdAt));
  const [payment] = await db
    .select({ status: payments.status })
    .from(payments)
    .where(and(eq(payments.dealId, deal.id), eq(payments.attempt, deal.paymentAttempt)));
  const [review] = await db
    .select({ kind: reviews.kind })
    .from(reviews)
    .where(and(eq(reviews.dealId, deal.id), isNull(reviews.decision)))
    .limit(1);
  const [openExtension] = await db
    .select({
      id: extensions.id,
      proposedBy: extensions.proposedBy,
      newDeliverBy: extensions.newDeliverBy,
    })
    .from(extensions)
    .where(and(eq(extensions.dealId, deal.id), eq(extensions.status, "proposed")))
    .limit(1);
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
    openReview: review?.kind ?? null,
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
  // Handover: the buyer sees the code until delivery is proven; the seller can enter it.
  const handoverOpen =
    !deal.deliveredAt && (s === "AUTHORIZED" || s === "SHIPPED" || isDeadlineReview(snap));
  const canShowCode = handoverOpen && Boolean(opts.handoverSecret);
  if (role === "seller" && canShowCode && !deal.handoverLocked) actions.push("enter_handover");
  // Extend delivery date: either party proposes; the other accepts or rejects.
  const extendable = !extensionProblem(snap, new Date(opts.now.getTime() + 60_000), opts.now, t);
  if (extendable) {
    if (openExtension && openExtension.proposedBy !== role) actions.push("decide_extension");
    else actions.push("propose_extension");
  }
  if (EVIDENCE_STATES.includes(s)) actions.push("add_evidence");
  if (
    opts.demoMode &&
    snap.hasTracking &&
    !deal.deliveredAt &&
    (s === "SHIPPED" || isDeadlineReview(snap))
  ) {
    actions.push("simulate_delivery");
  }
  if (s === "CAPTURED" || s === "DISPUTED" || s === "CLOSED") actions.push("download_bundle");
  if (
    role === "buyer" &&
    (s === "AUTHORIZED" || s === "SHIPPED" || s === "DELIVERED" || isDeadlineReview(snap))
  ) {
    actions.push("confirm_receipt");
    if (
      s === "SHIPPED" ||
      isDeadlineReview(snap) ||
      (s === "DELIVERED" && inspectionEnds && opts.now < inspectionEnds)
    ) {
      actions.push("report_problem");
    }
  }

  const amount = deal.amount ?? terms?.price.amount ?? null;
  return {
    ref: deal.publicRef,
    role,
    state: s,
    statusLine: statusLine(s, role, {
      shipBy: deal.shipBy,
      inspectionEnds,
      review: snap.openReview,
      handoverLocked: deal.handoverLocked && handoverOpen,
    }),
    names: { seller: deal.sellerName, buyer: deal.buyerName },
    terms,
    sources: (latest?.sourceRefsJson ?? {}) as Partial<SourceRefs>,
    chat: chat ? parseChat(chat.text) : ([] as ChatMessage[]),
    chatFlags: flagged.map((f) => ({ messageId: f.message_id, reason: f.reason })),
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
    evidence: ev.map((e) => ({
      ...e,
      createdAt: e.createdAt.toISOString(),
      // Same-origin path; the Deal Room adds the party's token.
      photoPath: e.type === "photo" ? `/api/deals/${deal.publicRef}/photos/${e.id}` : null,
    })),
    handover: {
      // Only the buyer ever sees the code, and only until delivery is proven.
      code:
        role === "buyer" && canShowCode
          ? handoverCode(deal.id, opts.handoverSecret as string)
          : null,
      open: canShowCode,
      locked: deal.handoverLocked,
      attemptsLeft: Math.max(0, HANDOVER_MAX_ATTEMPTS - deal.handoverAttempts),
      proof: deal.deliveryProof,
    },
    extension: openExtension
      ? {
          id: openExtension.id,
          proposedBy: openExtension.proposedBy,
          newDeliverBy: openExtension.newDeliverBy.toISOString(),
        }
      : null,
    /** Latest date a new deliver-by may have (day 26 of the hold), for the date picker. */
    extensionLimit: extendable ? (reviewAt(snap, t)?.toISOString() ?? null) : null,
    notes: partyNotes(deal, role, opts.now),
    timeline: timeline(s),
    actions,
    history: history
      .map((h) => ({
        at: h.at.toISOString(),
        actor: h.actor,
        label:
          h.action === "state.changed"
            ? `${String((h.details as { from?: string }).from)} → ${String((h.details as { to?: string }).to)}`
            : h.action === "trigger.accepted"
              ? (TRIGGER_LABELS[String((h.details as { trigger?: string }).trigger)] ?? "")
              : AUDIT_LABELS[h.action],
      }))
      .filter((h) => h.label),
    // Only the seller sees the buyer's link, to send it to them.
    buyerLink: role === "seller" ? dealLinks(opts.appBaseUrl, deal).buyer : null,
    serverTime: opts.now.toISOString(),
  };
}

/** PayPal guarantees held funds for the first 3 days after authorisation (real time). */
const HONOUR_PERIOD_MS = 3 * 24 * 3_600_000;

/** Limits worth stating where they apply (BUILD_PLAN 7.1). */
function partyNotes(deal: Deal, role: Role, now: Date): string[] {
  const notes: string[] = [];
  const held = ["DELIVERED", "IN_REVIEW", "CAPTURE_FAILED", "SHIPPED"].includes(deal.state);
  if (
    role === "seller" &&
    held &&
    deal.authorizedAt &&
    now.getTime() - deal.authorizedAt.getTime() > HONOUR_PERIOD_MS
  ) {
    notes.push(
      "PayPal guarantees held money only for the first 3 days. Payment after that usually works, but can fail if the buyer's funding source fails.",
    );
  }
  return notes;
}

export type DealView = Awaited<ReturnType<typeof dealView>>;
