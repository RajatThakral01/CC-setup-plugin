CREATE TABLE "accepted_versions" (
	"component" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"accepted_by" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "held_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"from_status" "item_status" NOT NULL,
	"to_status" "item_status" NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"block" jsonb,
	"source" text NOT NULL,
	"trigger" text NOT NULL,
	"versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"resolved_by" text
);
--> statement-breakpoint
ALTER TABLE "scorecards" ADD COLUMN "scanner_version" text;--> statement-breakpoint
ALTER TABLE "held_changes" ADD CONSTRAINT "held_changes_item_id_catalog_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."catalog_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "held_changes_open_idx" ON "held_changes" USING btree ("resolved_at","item_id");--> statement-breakpoint
-- The scanner as it was before M10's independent review: a newer scanner must be accepted (safeguard c).
INSERT INTO "accepted_versions" ("component", "version", "accepted_by") VALUES ('scanner', 'scanner-v1', 'migration: scanner before M10') ON CONFLICT DO NOTHING;
