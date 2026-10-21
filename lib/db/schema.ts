// Database schema (Drizzle). See docs/BUILD_PLAN.md section 6; changes from the plan are logged in
// docs/DECISIONS.md. Times are timestamptz (UTC); money is numeric(10,2) read as a string.
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
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
export const reviewDecision = pgEnum("review_decision", ["capture", "void"]);

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => tstz("created_at").notNull().defaultNow();
const money = (name: string) => numeric(name, { precision: 10, scale: 2 });

export const deals = pgTable("deals", {
  id: uuid("id").primaryKey().defaultRandom(),
  publicRef: text("public_ref").notNull().unique(),
  sellerToken: text("seller_token").notNull().unique(),
  buyerToken: text("buyer_token").notNull().unique(),
  state: dealState("state").notNull().default("DRAFT"),
  // Set when both parties confirm the same terms hash (no FK: deal_terms references deals).
  confirmedTermsId: uuid("confirmed_terms_id"),
  amount: money("amount"),
  currency: text("currency").notNull().default("USD"),
  payeeEmail: text("payee_email"),
  shipBy: tstz("ship_by"),
  deliverBy: tstz("deliver_by"),
  inspectionHours: integer("inspection_hours").notNull().default(48),
  deliveredAt: tstz("delivered_at"),
  authorizedAt: tstz("authorized_at"),
  authExpiresAt: tstz("auth_expires_at"),
  // Version numbers in PayPal-Request-Ids; raised only when a new attempt is intended.
  paymentAttempt: integer("payment_attempt").notNull().default(1),
  captureAttempt: integer("capture_attempt").notNull().default(1),
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
  carrier: text("carrier"),
  trackingNumber: text("tracking_number"),
  fileUrl: text("file_url"),
  note: text("note"),
  checkLabel: text("check_label"),
  checkReasons: jsonb("check_reasons"),
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

export const reviews = pgTable("reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id")
    .notNull()
    .references(() => deals.id),
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
export type DealTermsRow = typeof dealTerms.$inferSelect;
export type AuditRow = typeof auditLog.$inferSelect;
