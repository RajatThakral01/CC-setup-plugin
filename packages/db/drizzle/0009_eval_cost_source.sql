ALTER TABLE "eval_runs" ADD COLUMN "cost_source" text DEFAULT 'claude' NOT NULL;--> statement-breakpoint
-- Runs booked at their cap before M8.3 (unreadable output after a timeout) were never measured.
UPDATE "eval_runs" SET "cost_source" = 'cap' WHERE "run_id" IN (SELECT split_part("ref", ' ', 1) FROM "budget_ledger" WHERE "purpose" = 'eval' AND "ref" LIKE '% (unparsed output: cap recorded)');
