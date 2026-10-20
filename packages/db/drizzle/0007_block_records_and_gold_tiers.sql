ALTER TABLE "catalog_items" ADD COLUMN "block_record" jsonb;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN "blocked_versions" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "classifier_evals" ADD COLUMN "tier" text DEFAULT 'owner' NOT NULL;