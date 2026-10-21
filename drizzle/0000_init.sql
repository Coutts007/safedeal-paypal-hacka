CREATE TYPE "public"."deal_state" AS ENUM('DRAFT', 'AGREED', 'AUTHORIZED', 'FUNDING_FAILED', 'SHIPPED', 'DELIVERED', 'IN_REVIEW', 'CAPTURED', 'CAPTURE_FAILED', 'VOIDED', 'EXPIRED', 'DISPUTED', 'CLOSED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."evidence_type" AS ENUM('tracking', 'photo', 'note');--> statement-breakpoint
CREATE TYPE "public"."party_role" AS ENUM('buyer', 'seller');--> statement-breakpoint
CREATE TYPE "public"."review_decision" AS ENUM('capture', 'void');--> statement-breakpoint
CREATE TYPE "public"."terms_proposer" AS ENUM('ai', 'user');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"deal_id" uuid,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"details_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "audit_log_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "chat_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"redacted_text" text NOT NULL,
	"language_mix" text,
	"uploaded_by" "party_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"terms_id" uuid NOT NULL,
	"role" "party_role" NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "courier_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"tracking_number" text,
	"status" text NOT NULL,
	"raw_json" jsonb NOT NULL,
	"verified" boolean NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "courier_events_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "deal_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"terms_json" jsonb NOT NULL,
	"terms_hash" text NOT NULL,
	"source_refs_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"proposed_by" "terms_proposer" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_ref" text NOT NULL,
	"seller_token" text NOT NULL,
	"buyer_token" text NOT NULL,
	"state" "deal_state" DEFAULT 'DRAFT' NOT NULL,
	"confirmed_terms_id" uuid,
	"amount" numeric(10, 2),
	"currency" text DEFAULT 'USD' NOT NULL,
	"payee_email" text,
	"ship_by" timestamp with time zone,
	"deliver_by" timestamp with time zone,
	"inspection_hours" integer DEFAULT 48 NOT NULL,
	"delivered_at" timestamp with time zone,
	"authorized_at" timestamp with time zone,
	"auth_expires_at" timestamp with time zone,
	"payment_attempt" integer DEFAULT 1 NOT NULL,
	"settle_attempt" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deals_public_ref_unique" UNIQUE("public_ref"),
	CONSTRAINT "deals_seller_token_unique" UNIQUE("seller_token"),
	CONSTRAINT "deals_buyer_token_unique" UNIQUE("buyer_token")
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"type" "evidence_type" NOT NULL,
	"carrier" text,
	"tracking_number" text,
	"file_url" text,
	"note" text,
	"check_label" text,
	"check_reasons" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid,
	"action" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"paypal_request_id" text,
	"http_status" integer,
	"response_json" jsonb,
	"debug_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_requests_paypal_request_id_unique" UNIQUE("paypal_request_id")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"paypal_order_id" text NOT NULL,
	"authorization_id" text,
	"capture_id" text,
	"status" text NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"currency" text NOT NULL,
	"attempt" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_paypal_order_id_unique" UNIQUE("paypal_order_id"),
	CONSTRAINT "payments_authorization_id_unique" UNIQUE("authorization_id"),
	CONSTRAINT "payments_capture_id_unique" UNIQUE("capture_id")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"decision" "review_decision",
	"decided_by" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"raw_json" jsonb NOT NULL,
	"verified" boolean NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "webhook_events_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sources" ADD CONSTRAINT "chat_sources_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confirmations" ADD CONSTRAINT "confirmations_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confirmations" ADD CONSTRAINT "confirmations_terms_id_deal_terms_id_fk" FOREIGN KEY ("terms_id") REFERENCES "public"."deal_terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_events" ADD CONSTRAINT "courier_events_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_terms" ADD CONSTRAINT "deal_terms_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_deal" ON "audit_log" USING btree ("deal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "confirmations_terms_role" ON "confirmations" USING btree ("terms_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "deal_terms_deal_version" ON "deal_terms" USING btree ("deal_id","version");--> statement-breakpoint
CREATE INDEX "payment_requests_deal" ON "payment_requests" USING btree ("deal_id");