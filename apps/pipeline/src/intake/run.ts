import type { LlmClient, Logger } from '@cc-setup-agent/core';
import {
  BudgetExceededError,
  and,
  asc,
  eq,
  findItemByKeys,
  gte,
  inArray,
  insertCandidate,
  isNull,
  rawSourceRecords,
  signalSnapshots,
  sql,
  statusEvents,
  uniqueItemId,
  type Db,
  type DbOrTx,
} from '@cc-setup-agent/db';
import {
  isNextjsRelevant,
  type AppConfig,
  type Classification,
  type Source,
} from '@cc-setup-agent/shared';
import { PROMPT_VERSION } from '../classify/classifier.js';
import { classifySource, MAX_CONSECUTIVE_FAILURES, outOfScopeFor } from '../classify/run.js';
import type { NpmClient } from '../sources/npm.js';
import type { Vendors } from '../catalog-config.js';
import type { GithubClient, RepoFacts } from '../sources/github.js';
import type { CandidateDraft } from '../sources/types.js';
import { slugify } from '../sources/urls.js';
import {
  compareIntakePriority,
  evaluateIntake,
  starVelocity7d,
  type IntakeReason,
  type Relevance,
} from './filter.js';
import { normalizeRecord } from './normalize.js';

export const INTAKE_REASON_PREFIX = 'discovery intake';

export interface IntakeDeps {
  db: Db;
  github: GithubClient;
  logger: Logger;
  /** When present, filter-passing records are classified before ranking (owner decision). */
  classify?: { llm: LlmClient; npm: NpmClient; config: AppConfig };
}

export interface IntakeOptions {
  vendors: Vendors;
  minStars: number;
  dailyCap: number;
  refreshLimit: number;
  /** Filter-passing records classified per UTC day (CLASSIFY_DAILY_RECORD_LIMIT). */
  classifyDailyLimit?: number;
  now?: Date;
}

export interface IntakeReport {
  evaluated: number;
  accepted: Array<{ id: string; sourceUrl: string; source: Source; vendor: boolean }>;
  linked: number;
  deferred: number;
  filtered: number;
  notApplicable: number;
  refreshed: number;
  reasonCounts: Partial<Record<IntakeReason, number>>;
  recordsClassified: number;
  classifyCostUsd: number;
  classifyStoppedBy?: string;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Candidates created by intake since UTC midnight; counts toward the daily cap. */
export async function acceptedToday(db: DbOrTx, now: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(statusEvents)
    .where(
      and(
        isNull(statusEvents.fromStatus),
        gte(statusEvents.createdAt, startOfUtcDay(now)),
        sql`${statusEvents.reason} like ${`${INTAKE_REASON_PREFIX}%`}`,
      ),
    );
  return row?.n ?? 0;
}

function itemIdBase(draft: CandidateDraft): string {
  const repo = draft.repo;
  if (!repo) return slugify(draft.name);
  return draft.folder
    ? slugify(repo.owner, repo.name, draft.folder.path.split('/').at(-1) ?? draft.folder.path)
    : slugify(repo.owner, repo.name);
}

async function snapshot(
  tx: DbOrTx,
  itemId: string,
  repo: RepoFacts | null,
  velocity: number | null,
  now: Date,
) {
  if (!repo) return;
  await tx.insert(signalSnapshots).values({
    itemId,
    capturedAt: now,
    stars: repo.stars,
    starVelocity7d: velocity,
    lastCommitAt: repo.pushedAt ? new Date(repo.pushedAt) : null,
  });
}

/** Replaces the repo facts inside a stored payload after a refresh. */
function withRepo(source: Source, payload: unknown, repo: RepoFacts): unknown {
  if (source === 'github_repo') {
    const p = payload as Record<string, unknown>;
    return {
      ...p,
      stargazers_count: repo.stars,
      archived: repo.archived,
      fork: repo.fork,
      description: repo.description,
      pushed_at: repo.pushedAt,
    };
  }
  return { ...(payload as Record<string, unknown>), repo };
}

/**
 * Re-checks records filtered only for low stars, oldest first, so growing tools become
 * candidates without waiting for a source to list them again (owner decision 2026-10-19).
 */
async function refreshStarFiltered(deps: IntakeDeps, limit: number, now: Date): Promise<number> {
  if (limit === 0) return 0;
  const stale = new Date(now.getTime() - 20 * 3_600_000);
  const rows = await deps.db
    .select()
    .from(rawSourceRecords)
    .where(
      and(
        eq(rawSourceRecords.intakeState, 'filtered'),
        isNull(rawSourceRecords.itemId),
        sql`${rawSourceRecords.intakeReasons} = ARRAY['stars_below_min']::text[]`,
        sql`coalesce(${rawSourceRecords.starsCheckedAt}, 'epoch') < ${stale}`,
      ),
    )
    .orderBy(asc(rawSourceRecords.intakeCheckedAt))
    .limit(limit);
  const drafts = rows.flatMap((r) => {
    const d = normalizeRecord(r.source, r.payload);
    return d?.repo ? [{ row: r, fullName: d.repo.fullName }] : [];
  });
  if (drafts.length === 0) return 0;
  const facts = await deps.github.getReposBatch(drafts.map((d) => d.fullName));
  let refreshed = 0;
  for (const { row, fullName } of drafts) {
    const repo = facts.get(fullName.toLowerCase());
    if (!repo) continue;
    const previous =
      row.stars !== null && row.starsCheckedAt
        ? { stars: row.stars, at: row.starsCheckedAt }
        : undefined;
    const velocity = starVelocity7d(repo.stars, now, previous, repo.createdAt);
    await deps.db
      .update(rawSourceRecords)
      .set({
        payload: withRepo(row.source, row.payload, repo),
        stars: repo.stars,
        starsCheckedAt: now,
        ...(velocity !== undefined ? { starVelocity7d: velocity } : {}),
      })
      .where(eq(rawSourceRecords.id, row.id));
    refreshed++;
  }
  return refreshed;
}

/**
 * Daily intake (PRD FR-D10): links records to existing items, applies the filter, and creates at
 * most `dailyCap` new candidates per UTC day in priority order. Idempotent.
 */
export async function runIntake(deps: IntakeDeps, options: IntakeOptions): Promise<IntakeReport> {
  const now = options.now ?? new Date();
  const report: IntakeReport = {
    evaluated: 0,
    accepted: [],
    linked: 0,
    deferred: 0,
    filtered: 0,
    notApplicable: 0,
    refreshed: await refreshStarFiltered(deps, options.refreshLimit, now),
    reasonCounts: {},
    recordsClassified: 0,
    classifyCostUsd: 0,
  };

  const rows = await deps.db
    .select()
    .from(rawSourceRecords)
    .where(
      and(
        isNull(rawSourceRecords.itemId),
        inArray(rawSourceRecords.intakeState, ['pending', 'filtered', 'deferred']),
      ),
    )
    .orderBy(asc(rawSourceRecords.id));

  const setState = (
    id: number,
    state: 'linked' | 'filtered' | 'deferred' | 'not_applicable' | 'accepted',
    reasons: string[],
    itemId?: string,
  ) =>
    deps.db
      .update(rawSourceRecords)
      .set({
        intakeState: state,
        intakeReasons: reasons,
        intakeCheckedAt: now,
        ...(itemId ? { itemId } : {}),
      })
      .where(eq(rawSourceRecords.id, id));

  const passing: Array<{
    row: (typeof rows)[number];
    draft: CandidateDraft & { sourceUrl: string };
    vendor: boolean;
  }> = [];
  for (const row of rows) {
    report.evaluated++;
    let draft: CandidateDraft | null;
    try {
      draft = normalizeRecord(row.source, row.payload);
    } catch (error) {
      deps.logger.warn({ id: row.id, err: error }, 'unparseable raw record');
      draft = null;
    }
    if (!draft) {
      await setState(row.id, 'not_applicable', ['not_an_entity']);
      report.notApplicable++;
      continue;
    }
    const existing = await findItemByKeys(deps.db, {
      ...(draft.sourceUrl ? { sourceUrl: draft.sourceUrl } : {}),
      ...(draft.packageName ? { packageName: draft.packageName } : {}),
    });
    if (existing) {
      await setState(row.id, 'linked', [], existing.id);
      await snapshot(deps.db, existing.id, draft.repo, row.starVelocity7d, now);
      report.linked++;
      continue;
    }
    const decision = evaluateIntake(draft, options.vendors, options.minStars);
    if (!decision.pass || !draft.sourceUrl) {
      for (const r of decision.reasons) report.reasonCounts[r] = (report.reasonCounts[r] ?? 0) + 1;
      await setState(row.id, 'filtered', decision.reasons);
      report.filtered++;
      continue;
    }
    passing.push({ row, draft: { ...draft, sourceUrl: draft.sourceUrl }, vendor: decision.vendor });
  }

  const relevanceOf = (c: Classification | null): Relevance =>
    c === null || c.promptVersion !== PROMPT_VERSION
      ? 'unknown'
      : isNextjsRelevant(c)
        ? 'relevant'
        : 'irrelevant';
  const rank = (p: (typeof passing)[number]) => ({
    relevance: relevanceOf(p.row.classification),
    vendor: p.vendor,
    starVelocity7d: p.row.starVelocity7d ?? 0,
    stars: p.draft.repo?.stars ?? 0,
    sourceUrl: p.draft.sourceUrl,
  });

  // Classify the most promising unclassified records first, so relevance is known before ranking.
  if (deps.classify) {
    passing.sort((a, b) => compareIntakePriority(rank(a), rank(b)));
    await classifyRecords(
      deps,
      deps.classify,
      passing,
      options.classifyDailyLimit ?? 0,
      now,
      report,
    );
  }
  passing.sort((a, b) => compareIntakePriority(rank(a), rank(b)));

  let remaining = Math.max(0, options.dailyCap - (await acceptedToday(deps.db, now)));
  for (const { row, draft, vendor } of passing) {
    await deps.db.transaction(async (tx) => {
      // Another record in this run may already have created the same entity.
      const existing = await findItemByKeys(tx, {
        sourceUrl: draft.sourceUrl,
        ...(draft.packageName ? { packageName: draft.packageName } : {}),
      });
      if (existing) {
        await tx
          .update(rawSourceRecords)
          .set({
            intakeState: 'linked',
            intakeReasons: [],
            intakeCheckedAt: now,
            itemId: existing.id,
          })
          .where(eq(rawSourceRecords.id, row.id));
        report.linked++;
        return;
      }
      if (remaining === 0) {
        await tx
          .update(rawSourceRecords)
          .set({ intakeState: 'deferred', intakeReasons: ['daily_cap'], intakeCheckedAt: now })
          .where(eq(rawSourceRecords.id, row.id));
        report.deferred++;
        return;
      }
      const id = await uniqueItemId(tx, itemIdBase(draft));
      const c = row.classification;
      await insertCandidate(
        tx,
        {
          id,
          name: draft.name,
          description: draft.description,
          sourceUrl: draft.sourceUrl,
          packageName: draft.packageName,
          publisher: draft.publisher,
          kind: draft.kind ?? c?.kind ?? null,
          // A record classified before ranking carries its result into the item.
          ...(c
            ? {
                category: c.category,
                stacks: c.stacks,
                // Absent on classifications made before classify-v3: unknown, not vendor-neutral.
                technologies: (c.technologies as string[] | undefined) ?? null,
                provenance: c.provenanceGuess,
                classification: c,
                classificationState: 'classified' as const,
                outOfScope: outOfScopeFor(c, true),
              }
            : {}),
        },
        'system',
        `${INTAKE_REASON_PREFIX}: ${row.source}${vendor ? ' (vendor allowlist)' : ''}`,
        now,
      );
      await tx
        .update(rawSourceRecords)
        .set({ intakeState: 'accepted', intakeReasons: [], intakeCheckedAt: now, itemId: id })
        .where(eq(rawSourceRecords.id, row.id));
      await snapshot(tx, id, draft.repo, row.starVelocity7d, now);
      remaining--;
      report.accepted.push({ id, sourceUrl: draft.sourceUrl, source: row.source, vendor });
    });
  }
  return report;
}

async function classifiedToday(db: DbOrTx, now: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(rawSourceRecords)
    .where(gte(rawSourceRecords.classifiedAt, startOfUtcDay(now)));
  return row?.n ?? 0;
}

/**
 * Classifies filter-passing records in the given order, up to the daily limit and the budget.
 * Results are stored on the record and reused when it becomes an item.
 */
async function classifyRecords(
  deps: IntakeDeps,
  classify: NonNullable<IntakeDeps['classify']>,
  passing: Array<{
    row: typeof rawSourceRecords.$inferSelect;
    draft: CandidateDraft & { sourceUrl: string };
  }>,
  dailyLimit: number,
  now: Date,
  report: IntakeReport,
): Promise<void> {
  let remaining = Math.max(0, dailyLimit - (await classifiedToday(deps.db, now)));
  let consecutiveFailures = 0;
  for (const entry of passing) {
    if (remaining === 0) break;
    const { row, draft } = entry;
    if (row.classification?.promptVersion === PROMPT_VERSION) continue;
    try {
      const outcome = await classifySource(
        { ...classify, github: deps.github, logger: deps.logger },
        {
          name: draft.name,
          publisher: draft.publisher,
          sourceUrl: draft.sourceUrl,
          kindHint: draft.kind,
          description: draft.description,
          components: null,
        },
        `classify-record:${row.source}:${row.externalId}`,
      );
      consecutiveFailures = 0;
      remaining--;
      report.classifyCostUsd += outcome.costUsd;
      if (outcome.ok) {
        await deps.db
          .update(rawSourceRecords)
          .set({ classification: outcome.classification, classifiedAt: now })
          .where(eq(rawSourceRecords.id, row.id));
        entry.row = { ...row, classification: outcome.classification, classifiedAt: now };
        report.recordsClassified++;
      } else {
        // Counted against the daily limit; ranked as unknown relevance.
        await deps.db
          .update(rawSourceRecords)
          .set({ classifiedAt: now })
          .where(eq(rawSourceRecords.id, row.id));
      }
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        report.classifyStoppedBy = error.message;
        deps.logger.warn({ limitedBy: error.limitedBy }, 'record classification stopped by budget');
        return;
      }
      consecutiveFailures++;
      deps.logger.error({ id: row.id, err: error }, 'record classification failed');
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        report.classifyStoppedBy = `${MAX_CONSECUTIVE_FAILURES} consecutive API failures`;
        return;
      }
    }
  }
}
