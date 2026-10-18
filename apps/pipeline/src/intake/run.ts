import type { Logger } from '@cc-setup-agent/core';
import {
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
import type { Source } from '@cc-setup-agent/shared';
import type { Vendors } from '../catalog-config.js';
import type { GithubClient, RepoFacts } from '../sources/github.js';
import type { CandidateDraft } from '../sources/types.js';
import { slugify } from '../sources/urls.js';
import {
  compareIntakePriority,
  evaluateIntake,
  starVelocity7d,
  type IntakeReason,
} from './filter.js';
import { normalizeRecord } from './normalize.js';

export const INTAKE_REASON_PREFIX = 'discovery intake';

export interface IntakeDeps {
  db: Db;
  github: GithubClient;
  logger: Logger;
}

export interface IntakeOptions {
  vendors: Vendors;
  minStars: number;
  dailyCap: number;
  refreshLimit: number;
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

  passing.sort((a, b) =>
    compareIntakePriority(
      {
        vendor: a.vendor,
        starVelocity7d: a.row.starVelocity7d ?? 0,
        stars: a.draft.repo?.stars ?? 0,
        sourceUrl: a.draft.sourceUrl,
      },
      {
        vendor: b.vendor,
        starVelocity7d: b.row.starVelocity7d ?? 0,
        stars: b.draft.repo?.stars ?? 0,
        sourceUrl: b.draft.sourceUrl,
      },
    ),
  );

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
      await insertCandidate(
        tx,
        {
          id,
          name: draft.name,
          description: draft.description,
          sourceUrl: draft.sourceUrl,
          packageName: draft.packageName,
          publisher: draft.publisher,
          kind: draft.kind,
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
