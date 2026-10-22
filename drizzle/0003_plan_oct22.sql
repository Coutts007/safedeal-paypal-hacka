CREATE TYPE "public"."delivery_proof" AS ENUM('courier', 'handover_code', 'buyer');--> statement-breakpoint
CREATE TYPE "public"."extension_status" AS ENUM('proposed', 'accepted', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."review_kind" AS ENUM('deliver_by', 'day_26', 'buyer_problem', 'paypal', 'other');--> statement-breakpoint
ALTER TYPE "public"."review_decision" ADD VALUE 'cleared';--> statement-breakpoint
CREATE TABLE "extensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"proposed_by" "party_role" NOT NULL,
	"old_deliver_by" timestamp with time zone,
	"new_deliver_by" timestamp with time zone NOT NULL,
	"status" "extension_status" DEFAULT 'proposed' NOT NULL,
	"terms_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "delivery_proof" "delivery_proof";--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "handover_code_hash" text;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "handover_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "handover_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "kind" "review_kind" DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "extensions" ADD CONSTRAINT "extensions_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extensions" ADD CONSTRAINT "extensions_terms_id_deal_terms_id_fk" FOREIGN KEY ("terms_id") REFERENCES "public"."deal_terms"("id") ON DELETE no action ON UPDATE no action;