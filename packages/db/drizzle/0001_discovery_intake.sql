CREATE TYPE "public"."intake_state" AS ENUM('pending', 'accepted', 'linked', 'filtered', 'deferred', 'not_applicable');--> statement-breakpoint
CREATE TYPE "public"."source_run_status" AS ENUM('running', 'ok', 'failed');--> statement-breakpoint
CREATE TABLE "source_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"status" "source_run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"since" timestamp with time zone,
	"records" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "raw_source_records" ADD COLUMN "intake_state" "intake_state" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "raw_source_records" ADD COLUMN "intake_reasons" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "raw_source_records" ADD COLUMN "intake_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "raw_source_records" ADD COLUMN "stars" integer;--> statement-breakpoint
ALTER TABLE "raw_source_records" ADD COLUMN "stars_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "raw_source_records" ADD COLUMN "star_velocity_7d" real;--> statement-breakpoint
CREATE INDEX "source_runs_source_started_idx" ON "source_runs" USING btree ("source","started_at");--> statement-breakpoint
CREATE INDEX "raw_source_records_intake_idx" ON "raw_source_records" USING btree ("intake_state");--> statement-breakpoint
-- Data: records imported before intake existed. Linked ones are done; unlinked ones back npm items.
UPDATE "raw_source_records" SET "intake_state" = 'linked' WHERE "item_id" IS NOT NULL;--> statement-breakpoint
UPDATE "raw_source_records" SET "intake_state" = 'not_applicable' WHERE "item_id" IS NULL;
