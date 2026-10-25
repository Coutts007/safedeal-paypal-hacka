CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paypal_user_id" text NOT NULL,
	"payer_id" text,
	"email" text NOT NULL,
	"name" text,
	"verified_account" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_paypal_user_id_unique" UNIQUE("paypal_user_id")
);
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "seller_account_id" uuid;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_seller_account_id_accounts_id_fk" FOREIGN KEY ("seller_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;