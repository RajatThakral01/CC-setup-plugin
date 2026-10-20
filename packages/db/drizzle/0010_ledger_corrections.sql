CREATE TABLE "budget_ledger_corrections" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ledger_id" bigint NOT NULL,
	"old_cost_usd" numeric(12, 6) NOT NULL,
	"old_ref" text,
	"new_cost_usd" numeric(12, 6) NOT NULL,
	"new_ref" text,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "budget_ledger_corrections" ADD CONSTRAINT "budget_ledger_corrections_ledger_id_budget_ledger_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."budget_ledger"("id") ON DELETE no action ON UPDATE no action;