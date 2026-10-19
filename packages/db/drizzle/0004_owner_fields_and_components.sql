ALTER TABLE "catalog_items" ADD COLUMN "technologies" text[];--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN "components" jsonb;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN "context_on_use_tokens" integer;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN "first_published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN "kind_set_by" text;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN "category_set_by" text;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN "classification_review" jsonb;