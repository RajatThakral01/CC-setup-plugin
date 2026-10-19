CREATE TABLE "classifier_evals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"gold_set_hash" text NOT NULL,
	"gold_size" integer NOT NULL,
	"correct" integer NOT NULL,
	"score" real NOT NULL,
	"details" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_decisions" (
	"item_id" text PRIMARY KEY NOT NULL,
	"policy_version" text NOT NULL,
	"action" text NOT NULL,
	"from_status" "item_status" NOT NULL,
	"to_status" "item_status",
	"tier" text,
	"reason" text NOT NULL,
	"criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"applied" boolean DEFAULT false NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN "classification_input_hash" text;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN "second_opinion" jsonb;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN "policy_veto" jsonb;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN "security_override" jsonb;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_item_id_catalog_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."catalog_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "classifier_evals_prompt_idx" ON "classifier_evals" USING btree ("prompt_version","gold_set_hash");