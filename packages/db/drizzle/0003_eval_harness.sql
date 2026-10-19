CREATE TABLE "eval_queue" (
	"item_id" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "stage" text DEFAULT 'screen' NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_queue" ADD CONSTRAINT "eval_queue_item_id_catalog_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."catalog_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_runs_cache_idx" ON "eval_runs" USING btree ("task_id","task_set_version","model","claude_code_version");