import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { verifyAuditChain } from "@/lib/audit";
import { parseChat } from "@/lib/ai/chat";
import type { Db } from "@/lib/db";
import {
  aiExtractions,
  auditLog,
  chatSources,
  courierEvents,
  deals,
  dealTerms,
  evidence,
  evidenceChecks,
  extensions,
  payments,
  reviews,
  type Deal,
} from "@/lib/db/schema";
import { dealTermsSchema } from "@/lib/deals/terms";
import { hardLimit, HELD_STATES, inspectionEndsAt, reviewAt } from "@/lib/rules/machine";

// Read-only data for the admin pages. Decisions go through the rule engine (onAdminDecision).

/** PayPal guarantees held funds for the first 3 days after authorisation (real time, not scaled). */
export const HONOUR_PERIOD_MS = 3 * 24 * 3_600_000;

export async function adminQueue(db: Db) {
  const open = await db
    .select({
      ref: deals.publicRef,
      state: deals.state,
      amount: deals.amount,
      kind: reviews.kind,
      reason: reviews.reason,
      openedAt: reviews.createdAt,
      dealId: deals.id,
    })
    .from(reviews)
    .innerJoin(deals, eq(deals.id, reviews.dealId))
    .where(isNull(reviews.decision))
    .orderBy(asc(reviews.createdAt));
  const locked = await db
    .select({ ref: deals.publicRef, state: deals.state, amount: deals.amount, at: deals.updatedAt })
    .from(deals)
    .where(and(eq(deals.handoverLocked, true), inArray(deals.state, [...HELD_STATES])));
  const recent = await db
    .select({
      ref: deals.publicRef,
      state: deals.state,
      amount: deals.amount,
      seller: deals.sellerName,
      buyer: deals.buyerName,
      updatedAt: deals.updatedAt,
    })
    .from(deals)
    .orderBy(desc(deals.updatedAt))
    .limit(30);
  return { open, locked, recent };
}

export async function adminDeal(db: Db, deal: Deal, opts: { now: Date; timeScale: number }) {
  const termsRows = await db
    .select()
    .from(dealTerms)
    .where(eq(dealTerms.dealId, deal.id))
    .orderBy(desc(dealTerms.version));
  const confirmed = termsRows.find((t) => t.id === deal.confirmedTermsId) ?? termsRows[0];
  const terms = confirmed ? dealTermsSchema.parse(confirmed.termsJson) : null;
  const [chat] = await db
    .select({ text: chatSources.redactedText, languageMix: chatSources.languageMix })
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
  const pays = await db
    .select()
    .from(payments)
    .where(eq(payments.dealId, deal.id))
    .orderBy(asc(payments.attempt));
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
  const courier = await db
    .select({
      eventId: courierEvents.eventId,
      status: courierEvents.status,
      trackingNumber: courierEvents.trackingNumber,
      verified: courierEvents.verified,
      receivedAt: courierEvents.receivedAt,
    })
    .from(courierEvents)
    .where(eq(courierEvents.dealId, deal.id))
    .orderBy(asc(courierEvents.receivedAt));
  const allReviews = await db
    .select()
    .from(reviews)
    .where(eq(reviews.dealId, deal.id))
    .orderBy(asc(reviews.createdAt));
  const exts = await db
    .select()
    .from(extensions)
    .where(eq(extensions.dealId, deal.id))
    .orderBy(asc(extensions.createdAt));
  const checks = await db
    .select()
    .from(evidenceChecks)
    .where(eq(evidenceChecks.dealId, deal.id))
    .orderBy(desc(evidenceChecks.createdAt))
    .limit(3);
  const audit = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.dealId, deal.id))
    .orderBy(asc(auditLog.id));
  const chain = await verifyAuditChain(db);

  const snap = {
    state: deal.state,
    shipBy: deal.shipBy,
    deliverBy: deal.deliverBy,
    deliveredAt: deal.deliveredAt,
    inspectionHours: deal.inspectionHours,
    authorizedAt: deal.authorizedAt,
    authExpiresAt: deal.authExpiresAt,
    hasTracking: ev.some((e) => e.type === "tracking"),
    openReview: allReviews.find((r) => !r.decision)?.kind ?? null,
    currentTermsHash: null,
    confirmedHashes: { buyer: null, seller: null },
  };
  const t = { timeScale: opts.timeScale };
  const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
  const flags =
    (reading?.extraction as { instruction_flags?: { message_id: string; reason: string }[] } | null)
      ?.instruction_flags ?? [];
  return {
    ref: deal.publicRef,
    state: deal.state,
    names: { seller: deal.sellerName, buyer: deal.buyerName },
    amount: deal.amount,
    payeeEmail: deal.payeeEmail,
    terms,
    termsVersion: confirmed?.version ?? null,
    termsVersions: termsRows.length,
    chat: chat ? parseChat(chat.text) : [],
    chatFlags: flags.map((f) => ({ messageId: f.message_id, reason: f.reason })),
    deadlines: {
      shipBy: iso(deal.shipBy),
      deliverBy: iso(deal.deliverBy),
      inspectionEndsAt: iso(inspectionEndsAt(snap, t)),
      reviewAt: iso(reviewAt(snap, t)),
      holdEndsAt: iso(hardLimit(snap, t)),
      authorizedAt: iso(deal.authorizedAt),
    },
    honourPeriodPassed: Boolean(
      deal.authorizedAt && opts.now.getTime() - deal.authorizedAt.getTime() > HONOUR_PERIOD_MS,
    ),
    handover: {
      deliveryProof: deal.deliveryProof,
      deliveredAt: iso(deal.deliveredAt),
      attempts: deal.handoverAttempts,
      locked: deal.handoverLocked,
      hasCode: Boolean(deal.handoverCodeHash),
    },
    payments: pays.map((p) => ({
      attempt: p.attempt,
      orderId: p.paypalOrderId,
      authorizationId: p.authorizationId,
      captureId: p.captureId,
      status: p.status,
    })),
    evidence: ev.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
    courierEvents: courier.map((c) => ({ ...c, receivedAt: c.receivedAt.toISOString() })),
    reviews: allReviews.map((r) => ({
      kind: r.kind,
      reason: r.reason,
      note: r.note,
      decision: r.decision,
      decidedBy: r.decidedBy,
      createdAt: r.createdAt.toISOString(),
      decidedAt: iso(r.decidedAt),
    })),
    extensions: exts.map((x) => ({
      proposedBy: x.proposedBy,
      oldDeliverBy: iso(x.oldDeliverBy),
      newDeliverBy: x.newDeliverBy.toISOString(),
      status: x.status,
      createdAt: x.createdAt.toISOString(),
    })),
    checks: checks.map((c) => ({
      label: c.label,
      reasons: c.reasons as string[],
      flags: c.flags as { evidence_id: string; reason: string }[],
      createdAt: c.createdAt.toISOString(),
      promptVersion: c.promptVersion,
    })),
    audit: audit.map((a) => ({
      id: a.id,
      at: a.createdAt.toISOString(),
      actor: a.actor,
      action: a.action,
      details: a.detailsJson as Record<string, unknown>,
      hash: a.hash.slice(0, 12),
    })),
    chainOk: chain.ok,
    canDecide: deal.state === "IN_REVIEW" || deal.state === "CAPTURE_FAILED",
  };
}

export type AdminDealView = Awaited<ReturnType<typeof adminDeal>>;
