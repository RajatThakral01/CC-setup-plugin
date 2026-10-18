ALTER TABLE "catalog_items" ADD COLUMN "out_of_scope" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "raw_source_records" ADD COLUMN "classification" jsonb;--> statement-breakpoint
ALTER TABLE "raw_source_records" ADD COLUMN "classified_at" timestamp with time zone;