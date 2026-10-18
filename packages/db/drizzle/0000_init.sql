CREATE TYPE "public"."budget_purpose" AS ENUM('classify', 'eval');--> statement-breakpoint
CREATE TYPE "public"."item_category" AS ENUM('docs', 'browser_testing', 'unit_testing', 'database', 'deploy', 'ui_components', 'code_review', 'git_github', 'observability', 'search', 'auth', 'payments', 'email', 'cms');--> statement-breakpoint
CREATE TYPE "public"."classification_state" AS ENUM('pending', 'classified', 'needs_manual_classification');--> statement-breakpoint
CREATE TYPE "public"."confidence" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."item_kind" AS ENUM('mcp_server', 'skill', 'plugin', 'subagent', 'hook_recipe', 'model_setting', 'claude_code_feature');--> statement-breakpoint
CREATE TYPE "public"."item_provenance" AS ENUM('official_vendor', 'community', 'anthropic');--> statement-breakpoint
CREATE TYPE "public"."record_source" AS ENUM('github_repo', 'npm_package', 'mcp_registry', 'marketplace', 'claude_code_changelog', 'claude_code_release');--> statement-breakpoint
CREATE TYPE "public"."item_status" AS ENUM('candidate', 'watchlist', 'recommended_provisional', 'recommended', 'deprecated', 'blocked', 'rejected');--> statement-breakpoint
CREATE TABLE "budget_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"week_start" date NOT NULL,
	"purpose" "budget_purpose" NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) NOT NULL,
	"ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_items" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" "item_kind",
	"category" "item_category",
	"stacks" text[] DEFAULT '{}'::text[] NOT NULL,
	"source_url" text NOT NULL,
	"package_name" text,
	"publisher" text,
	"provenance" "item_provenance",
	"capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"install" jsonb,
	"context_overhead_tokens" integer,
	"status" "item_status" DEFAULT 'candidate' NOT NULL,
	"supersedes" text,
	"superseded_by" text,
	"classification_state" "classification_state" DEFAULT 'pending' NOT NULL,
	"classification" jsonb,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked" timestamp with time zone,
	CONSTRAINT "catalog_items_source_url_unique" UNIQUE("source_url"),
	CONSTRAINT "catalog_items_package_name_unique" UNIQUE("package_name")
);
--> statement-breakpoint
CREATE TABLE "claude_code_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" "record_source" NOT NULL,
	"external_id" text NOT NULL,
	"version" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"url" text,
	"published_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"item_id" text,
	"item_version" text,
	"baseline_item_id" text,
	"task_id" text NOT NULL,
	"task_set_version" text NOT NULL,
	"model" text NOT NULL,
	"claude_code_version" text NOT NULL,
	"with_tool" boolean NOT NULL,
	"success" boolean NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"wall_seconds" real DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"logs_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_versions" (
	"item_id" text NOT NULL,
	"version" text NOT NULL,
	"released_at" timestamp with time zone,
	"pinned" boolean DEFAULT false NOT NULL,
	CONSTRAINT "item_versions_item_id_version_pk" PRIMARY KEY("item_id","version")
);
--> statement-breakpoint
CREATE TABLE "raw_source_records" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" "record_source" NOT NULL,
	"external_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"item_id" text
);
--> statement-breakpoint
CREATE TABLE "scorecards" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"version" text NOT NULL,
	"gate_results" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"security_findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"eval_summary" jsonb,
	"confidence" "confidence" DEFAULT 'low' NOT NULL,
	"reviewer" text,
	"reviewed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stars" integer,
	"star_velocity_7d" real,
	"downloads_7d" integer,
	"last_commit_at" timestamp with time zone,
	"open_issues" integer,
	"median_issue_response_hours" real,
	"contributors" integer,
	"mentions_firsthand" integer,
	"mentions_total" integer
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"version" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"item_count" integer NOT NULL,
	"sha256" text NOT NULL,
	"published_url" text
);
--> statement-breakpoint
CREATE TABLE "status_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"from_status" "item_status",
	"to_status" "item_status" NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_supersedes_catalog_items_id_fk" FOREIGN KEY ("supersedes") REFERENCES "public"."catalog_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_superseded_by_catalog_items_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."catalog_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_item_id_catalog_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."catalog_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_baseline_item_id_catalog_items_id_fk" FOREIGN KEY ("baseline_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_item_id_catalog_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."catalog_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_source_records" ADD CONSTRAINT "raw_source_records_item_id_catalog_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."catalog_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_item_id_catalog_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."catalog_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_snapshots" ADD CONSTRAINT "signal_snapshots_item_id_catalog_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."catalog_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_events" ADD CONSTRAINT "status_events_item_id_catalog_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."catalog_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_ledger_week_purpose_idx" ON "budget_ledger" USING btree ("week_start","purpose");--> statement-breakpoint
CREATE INDEX "catalog_items_status_idx" ON "catalog_items" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "claude_code_changes_source_external_id_uq" ON "claude_code_changes" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "eval_runs_item_idx" ON "eval_runs" USING btree ("item_id","task_set_version");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_source_records_source_external_id_uq" ON "raw_source_records" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "raw_source_records_item_id_idx" ON "raw_source_records" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scorecards_item_version_uq" ON "scorecards" USING btree ("item_id","version");--> statement-breakpoint
CREATE INDEX "signal_snapshots_item_captured_idx" ON "signal_snapshots" USING btree ("item_id","captured_at");--> statement-breakpoint
CREATE INDEX "status_events_item_idx" ON "status_events" USING btree ("item_id","created_at");