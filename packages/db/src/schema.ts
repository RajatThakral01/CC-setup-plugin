import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  BUDGET_PURPOSES,
  CATEGORIES,
  CLASSIFICATION_STATES,
  CONFIDENCES,
  INTAKE_STATES,
  KINDS,
  PROVENANCES,
  SOURCES,
  STATUSES,
  type Classification,
  type GateResults,
  type EvalSummary,
  type Install,
  type SecurityFinding,
} from '@cc-setup-agent/shared';

export const kindEnum = pgEnum('item_kind', KINDS);
export const categoryEnum = pgEnum('item_category', CATEGORIES);
export const provenanceEnum = pgEnum('item_provenance', PROVENANCES);
export const statusEnum = pgEnum('item_status', STATUSES);
export const sourceEnum = pgEnum('record_source', SOURCES);
export const confidenceEnum = pgEnum('confidence', CONFIDENCES);
export const budgetPurposeEnum = pgEnum('budget_purpose', BUDGET_PURPOSES);
export const classificationStateEnum = pgEnum('classification_state', CLASSIFICATION_STATES);
export const intakeStateEnum = pgEnum('intake_state', INTAKE_STATES);
export const sourceRunStatusEnum = pgEnum('source_run_status', ['running', 'ok', 'failed']);

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const catalogItems = pgTable(
  'catalog_items',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    // Nullable until a seed hint or classification fills them.
    kind: kindEnum('kind'),
    category: categoryEnum('category'),
    stacks: text('stacks')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    sourceUrl: text('source_url').notNull().unique(),
    packageName: text('package_name').unique(),
    publisher: text('publisher'),
    provenance: provenanceEnum('provenance'),
    capabilities: text('capabilities')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    install: jsonb('install').$type<Install>(),
    contextOverheadTokens: integer('context_overhead_tokens'),
    status: statusEnum('status').notNull().default('candidate'),
    supersedes: text('supersedes').references((): AnyPgColumn => catalogItems.id),
    supersededBy: text('superseded_by').references((): AnyPgColumn => catalogItems.id),
    classificationState: classificationStateEnum('classification_state')
      .notNull()
      .default('pending'),
    classification: jsonb('classification').$type<Classification>(),
    /** Stacks this item is out of scope for (hidden from that stack's triage queue by default). */
    outOfScope: text('out_of_scope')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    firstSeen: timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
    lastChecked: timestamp('last_checked', { withTimezone: true }),
  },
  (t) => [index('catalog_items_status_idx').on(t.status)],
);

export const itemVersions = pgTable(
  'item_versions',
  {
    itemId: text('item_id')
      .notNull()
      .references(() => catalogItems.id),
    version: text('version').notNull(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    pinned: boolean('pinned').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.version] })],
);

export const rawSourceRecords = pgTable(
  'raw_source_records',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    source: sourceEnum('source').notNull(),
    externalId: text('external_id').notNull(),
    payload: jsonb('payload').$type<unknown>().notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    itemId: text('item_id').references(() => catalogItems.id),
    // Intake filter state (PRD FR-D10).
    intakeState: intakeStateEnum('intake_state').notNull().default('pending'),
    intakeReasons: text('intake_reasons')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    intakeCheckedAt: timestamp('intake_checked_at', { withTimezone: true }),
    // Star tracking for repo-backed records, so velocity is known before an item exists.
    stars: integer('stars'),
    starsCheckedAt: timestamp('stars_checked_at', { withTimezone: true }),
    starVelocity7d: real('star_velocity_7d'),
    // Pre-ranking classification of filter-passing records (owner decision 2026-10-19).
    classification: jsonb('classification').$type<Classification>(),
    classifiedAt: timestamp('classified_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('raw_source_records_source_external_id_uq').on(t.source, t.externalId),
    index('raw_source_records_item_id_idx').on(t.itemId),
    index('raw_source_records_intake_idx').on(t.intakeState),
  ],
);

/** One row per source per discovery run, so a failing source is visible (NFR-4, PRD 17.1). */
export const sourceRuns = pgTable(
  'source_runs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    source: text('source').notNull(),
    status: sourceRunStatusEnum('status').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    since: timestamp('since', { withTimezone: true }),
    records: integer('records').notNull().default(0),
    error: text('error'),
  },
  (t) => [index('source_runs_source_started_idx').on(t.source, t.startedAt)],
);

export const signalSnapshots = pgTable(
  'signal_snapshots',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => catalogItems.id),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
    stars: integer('stars'),
    starVelocity7d: real('star_velocity_7d'),
    downloads7d: integer('downloads_7d'),
    lastCommitAt: timestamp('last_commit_at', { withTimezone: true }),
    openIssues: integer('open_issues'),
    medianIssueResponseHours: real('median_issue_response_hours'),
    contributors: integer('contributors'),
    mentionsFirsthand: integer('mentions_firsthand'),
    mentionsTotal: integer('mentions_total'),
  },
  (t) => [index('signal_snapshots_item_captured_idx').on(t.itemId, t.capturedAt)],
);

export const scorecards = pgTable(
  'scorecards',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => catalogItems.id),
    version: text('version').notNull(),
    gateResults: jsonb('gate_results').$type<GateResults>().notNull().default({}),
    securityFindings: jsonb('security_findings').$type<SecurityFinding[]>().notNull().default([]),
    evalSummary: jsonb('eval_summary').$type<EvalSummary>(),
    confidence: confidenceEnum('confidence').notNull().default('low'),
    reviewer: text('reviewer'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('scorecards_item_version_uq').on(t.itemId, t.version)],
);

export const evalRuns = pgTable(
  'eval_runs',
  {
    runId: text('run_id').primaryKey(),
    itemId: text('item_id').references(() => catalogItems.id),
    itemVersion: text('item_version'),
    baselineItemId: text('baseline_item_id').references(() => catalogItems.id),
    taskId: text('task_id').notNull(),
    taskSetVersion: text('task_set_version').notNull(),
    model: text('model').notNull(),
    claudeCodeVersion: text('claude_code_version').notNull(),
    withTool: boolean('with_tool').notNull(),
    success: boolean('success').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6, mode: 'number' }).notNull().default(0),
    wallSeconds: real('wall_seconds').notNull().default(0),
    errors: integer('errors').notNull().default(0),
    logsRef: text('logs_ref'),
    createdAt: createdAt(),
  },
  (t) => [index('eval_runs_item_idx').on(t.itemId, t.taskSetVersion)],
);

/** Append-only audit log of every status change (NFR-13). */
export const statusEvents = pgTable(
  'status_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => catalogItems.id),
    fromStatus: statusEnum('from_status'),
    toStatus: statusEnum('to_status').notNull(),
    actor: text('actor').notNull(),
    reason: text('reason').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('status_events_item_idx').on(t.itemId, t.createdAt)],
);

/** One row per Anthropic API call. */
export const budgetLedger = pgTable(
  'budget_ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    weekStart: date('week_start', { mode: 'string' }).notNull(),
    purpose: budgetPurposeEnum('purpose').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6, mode: 'number' }).notNull(),
    ref: text('ref'),
    createdAt: createdAt(),
  },
  (t) => [index('budget_ledger_week_purpose_idx').on(t.weekStart, t.purpose)],
);

export const snapshots = pgTable('snapshots', {
  version: text('version').primaryKey(),
  createdAt: createdAt(),
  itemCount: integer('item_count').notNull(),
  sha256: text('sha256').notNull(),
  publishedUrl: text('published_url'),
});

/** Claude Code changelog and release notes for the owner (FR-D1); not installable items. */
export const claudeCodeChanges = pgTable(
  'claude_code_changes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    source: sourceEnum('source').notNull(),
    externalId: text('external_id').notNull(),
    version: text('version').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    flags: text('flags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    url: text('url'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('claude_code_changes_source_external_id_uq').on(t.source, t.externalId)],
);
