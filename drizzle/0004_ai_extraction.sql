CREATE TABLE "ai_extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"redacted_text" text NOT NULL,
	"messages_json" jsonb NOT NULL,
	"extraction_json" jsonb,
	"status" text NOT NULL,
	"chat_date" text NOT NULL,
	"prompt_version" text NOT NULL,
	"deal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"extraction_id" uuid,
	"purpose" text NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"attempt" integer NOT NULL,
	"outcome" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_extractions" ADD CONSTRAINT "ai_extractions_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_extraction_id_ai_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."ai_extractions"("id") ON DELETE no action ON UPDATE no action;