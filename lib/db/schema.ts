// Database schema (Drizzle). See docs/BUILD_PLAN.md section 6; changes from the plan are logged in
// docs/DECISIONS.md. Times are timestamptz (UTC); money is numeric(10,2) read as a string.
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const dealStates = [
  "DRAFT",
  "AGREED",
  "AUTHORIZED",
  "FUNDING_FAILED",
  "SHIPPED",
  "DELIVERED",
  "IN_REVIEW",
  "CAPTURED",
  "CAPTURE_FAILED",
  "VOIDED",
  "EXPIRED",
  "DISPUTED",
  "CLOSED",
  "CANCELLED",
] as const;
export type DealState = (typeof dealStates)[number];

export const dealState = pgEnum("deal_state", dealStates);
export const partyRole = pgEnum("party_role", ["buyer", "seller"]);
export const termsProposer = pgEnum("terms_proposer", ["ai", "user"]);
export const evidenceType = pgEnum("evidence_type", ["tracking", "photo", "note"]);
// "cleared": the deal left review without an admin decision (e.g. a late buyer confirmation).
export const reviewDecision = pgEnum("review_decision", ["capture", "void", "cleared"]);
/**
 * Why a deal is in review. Only the deadline kinds (deliver_by, day_26) can be cleared by a late
 * buyer confirmation or verified delivery (section 7.1); a complaint or a PayPal problem needs an admin.
 */
export const reviewKinds = ["deliver_by", "day_26", "buyer_problem", "paypal", "other"] as const;
export type ReviewKind = (typeof reviewKinds)[number];
export const reviewKind = pgEnum("review_kind", reviewKinds);
/** How delivery was proven (section 7.1): courier event, handover code, or the buyer's own word. */
export const deliveryProof = pgEnum("delivery_proof", ["courier", "handover_code", "buyer"]);
export const extensionStatus = pgEnum("extension_status", [
  "proposed",
  "accepted",
  "rejected",
  "expired",
]);

/** Raw bytes (evidence photos). Stored in Postgres so no paid file store is needed (DECISIONS). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => tstz("created_at").notNull().defaultNow();
const money = (name: string) => numeric(name, { precision: 10, scale: 2 });

/**
 * A seller who logged in with PayPal (Phase 6b). Only what PayPal shared at login: no password and
 * no PayPal tokens are stored. The email is the verified PayPal email deals pay out to.
 */
export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  // PayPal's stable id for the user (userinfo `user_id`); emails can change.
  paypalUserId: text("paypal_user_id").notNull().unique(),
  payerId: text("payer_id"),
  email: text("email").notNull(),
  name: text("name"),
  verifiedAccount: boolean("verified_account"),
  createdAt: createdAt(),
  lastLoginAt: tstz("last_login_at").notNull().defaultNow(),
});

export const deals = pgTable("deals", {
  id: uuid("id").primaryKey().defaultRandom(),
  publicRef: text("public_ref").notNull().unique(),
  sellerToken: text("seller_token").notNull().unique(),
  buyerToken: text("buyer_token").notNull().unique(),
  state: dealState("state").notNull().default("DRAFT"),
  // Display names shown in the Deal Room; not used for payment.
  sellerName: text("seller_name"),
  // The seller's account when the deal was made while logged in (or added at login); null for
  // deals made with the link only.
  sellerAccountId: uuid("seller_account_id").references(() => accounts.id),
  // Hidden from the seller's dashboard lists. Display only: never read by the rule engine.
  archivedAt: tstz("archived_at"),
  buyerName: text("buyer_name"),
  // Set when both parties confirm the same terms hash (no FK: deal_terms references deals).
  confirmedTermsId: uuid("confirmed_terms_id"),
  amount: money("amount"),
  currency: text("currency").notNull().default("USD"),
  payeeEmail: text("payee_email"),
  shipBy: tstz("ship_by"),
  deliverBy: tstz("deliver_by"),
  inspectionHours: integer("inspection_hours").notNull().default(48),
  deliveredAt: tstz("delivered_at"),
  deliveryProof: deliveryProof("delivery_proof"),
  authorizedAt: tstz("authorized_at"),
  authExpiresAt: tstz("auth_expires_at"),
  // Handover code (Phase 5): only a hash is stored; 5 wrong entries lock it and alert the admin.
  handoverCodeHash: text("handover_code_hash"),
  handoverAttempts: integer("handover_attempts").notNull().default(0),
  handoverLocked: boolean("handover_locked").notNull().default(false),
  // Version numbers in PayPal-Request-Ids; raised only when a new attempt is intended.
  paymentAttempt: integer("payment_attempt").notNull().default(1),
  // Raised after a final capture or void failure, so a deliberate retry uses a new key.
  settleAttempt: integer("settle_attempt").notNull().default(1),
  version: integer("version").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});

export const chatSources = pgTable("chat_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id")
    .notNull()
    .references(() => deals.id),
  redactedText: text("redacted_text").notNull(),
  languageMix: text("language_mix"),
  uploadedBy: partyRole("uploaded_by").notNull(),
  createdAt: createdAt(),
});

export const dealTerms = pgTable(
  "deal_terms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id")
      .notNull()
      .references(() => deals.id),
    version: integer("version").notNull(),
    termsJson: jsonb("terms_json").notNull(),
    termsHash: text("terms_hash").notNull(),
    sourceRefsJson: jsonb("source_refs_json").notNull().default({}),
    proposedBy: termsProposer("proposed_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("deal_terms_deal_version").on(t.dealId, t.version)],
);

/**
 * A chat read by the AI before a deal exists (Phase 4). Holds the redacted chat and the AI's
 * proposal so the deal can cite its sources; linked to the deal the seller then creates.
 */
export const aiExtractions = pgTable("ai_extractions", {
  id: uuid("id").primaryKey().defaultRandom(),
  redactedText: text("redacted_text").notNull(),
  messagesJson: jsonb("messages_json").notNull(),
  // Null when the AI could not produce a valid proposal (the seller fills the card by hand).
  extractionJson: jsonb("extraction_json"),
  status: text("status").notNull(),
  chatDate: text("chat_date").notNull(),
  promptVersion: text("prompt_version").notNull(),
  dealId: uuid("deal_id").references(() => deals.id),
  createdAt: createdAt(),
});

/** Every AI call: prompt version, model, tokens and latency. Never chat content (BUILD_PLAN 8.3). */
export const aiRuns = pgTable("ai_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  extractionId: uuid("extraction_id").references(() => aiExtractions.id),
  // Set for evidence checks (Phase 5), which run on an existing deal.
  dealId: uuid("deal_id").references(() => deals.id),
  purpose: text("purpose").notNull(),
  promptVersion: text("prompt_version").notNull(),
  model: text("model").notNull(),
  attempt: integer("attempt").notNull(),
  outcome: text("outcome").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  detail: text("detail"),
  createdAt: createdAt(),
});

export const confirmations = pgTable(
  "confirmations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id")
      .notNull()
      .references(() => deals.id),
    termsId: uuid("terms_id")
      .notNull()
      .references(() => dealTerms.id),
    role: partyRole("role").notNull(),
    confirmedAt: tstz("confirmed_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("confirmations_terms_role").on(t.termsId, t.role)],
);

export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id")
    .notNull()
    .references(() => deals.id),
  paypalOrderId: text("paypal_order_id").notNull().unique(),
  authorizationId: text("authorization_id").unique(),
  captureId: text("capture_id").unique(),
  status: text("status").notNull(),
  amount: money("amount").notNull(),
  currency: text("currency").notNull(),
  attempt: integer("attempt").notNull(),
  createdAt: createdAt(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});

// Every PayPal call, written outside the deal transaction so failed attempts are kept.
export const paymentRequests = pgTable(
  "payment_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id").references(() => deals.id),
    action: text("action").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    // Null for GETs. A replay with the same id updates the existing row.
    paypalRequestId: text("paypal_request_id").unique(),
    // Null when PayPal could not be reached.
    httpStatus: integer("http_status"),
    responseJson: jsonb("response_json"),
    debugId: text("debug_id"),
    createdAt: createdAt(),
  },
  (t) => [index("payment_requests_deal").on(t.dealId)],
);

export const evidence = pgTable("evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id")
    .notNull()
    .references(() => deals.id),
  type: evidenceType("type").notNull(),
  // Who added it (null for rows from before Phase 5, which were all seller tracking).
  addedBy: partyRole("added_by"),
  carrier: text("carrier"),
  trackingNumber: text("tracking_number"),
  fileUrl: text("file_url"),
  note: text("note"),
  checkLabel: text("check_label"),
  checkReasons: jsonb("check_reasons"),
  createdAt: createdAt(),
});

/** The bytes of a photo evidence row, kept apart so listing evidence never loads images. */
export const evidenceFiles = pgTable("evidence_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  evidenceId: uuid("evidence_id")
    .notNull()
    .unique()
    .references(() => evidence.id),
  dealId: uuid("deal_id")
    .notNull()
    .references(() => deals.id),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: text("sha256").notNull(),
  data: bytea("data").notNull(),
  createdAt: createdAt(),
});

/**
 * AI comparison of the evidence with the confirmed terms (BUILD_PLAN 8.3 `evidence.ts`). Advice
 * for the reviewer only: the rule engine never reads this table.
 */
export const evidenceChecks = pgTable("evidence_checks", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id")
    .notNull()
    .references(() => deals.id),
  label: text("label").notNull(),
  reasons: jsonb("reasons").notNull(),
  flags: jsonb("flags").notNull().default([]),
  promptVersion: text("prompt_version").notNull(),
  model: text("model").notNull(),
  createdAt: createdAt(),
});

export const courierEvents = pgTable("courier_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id").references(() => deals.id),
  provider: text("provider").notNull(),
  eventId: text("event_id").notNull().unique(),
  trackingNumber: text("tracking_number"),
  status: text("status").notNull(),
  rawJson: jsonb("raw_json").notNull(),
  verified: boolean("verified").notNull(),
  receivedAt: tstz("received_at").notNull().defaultNow(),
});

export const webhookEvents = pgTable("webhook_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull(),
  eventId: text("event_id").notNull().unique(),
  eventType: text("event_type").notNull(),
  rawJson: jsonb("raw_json").notNull(),
  verified: boolean("verified").notNull(),
  receivedAt: tstz("received_at").notNull().defaultNow(),
  processedAt: tstz("processed_at"),
});

/** Extend delivery date (section 7.1, Phase 5): one party proposes, the other accepts or rejects. */
export const extensions = pgTable("extensions", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id")
    .notNull()
    .references(() => deals.id),
  proposedBy: partyRole("proposed_by").notNull(),
  oldDeliverBy: tstz("old_deliver_by"),
  newDeliverBy: tstz("new_deliver_by").notNull(),
  status: extensionStatus("status").notNull().default("proposed"),
  // The terms version created when the extension is accepted.
  termsId: uuid("terms_id").references(() => dealTerms.id),
  createdAt: createdAt(),
  decidedAt: tstz("decided_at"),
});

export const reviews = pgTable("reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id")
    .notNull()
    .references(() => deals.id),
  kind: reviewKind("kind").notNull().default("other"),
  reason: text("reason").notNull(),
  // Null while the review is open.
  decision: reviewDecision("decision"),
  decidedBy: text("decided_by"),
  note: text("note"),
  createdAt: createdAt(),
  decidedAt: tstz("decided_at"),
});

// Append only (a trigger in the migrations refuses UPDATE and DELETE).
// hash = sha256(prev_hash + canonical row content); see lib/audit.ts.
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    dealId: uuid("deal_id").references(() => deals.id),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    detailsJson: jsonb("details_json")
      .notNull()
      .default(sql`'{}'::jsonb`),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull().unique(),
    createdAt: tstz("created_at").notNull(),
  },
  (t) => [index("audit_log_deal").on(t.dealId)],
);

export type Deal = typeof deals.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type DealTermsRow = typeof dealTerms.$inferSelect;
export type AuditRow = typeof auditLog.$inferSelect;
