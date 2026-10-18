import type { HttpClient, Logger } from '@cc-setup-agent/core';
import {
  and,
  claudeCodeChanges,
  desc,
  eq,
  rawSourceRecords,
  signalSnapshots,
  sourceRuns,
  upsertRawRecord,
  type Db,
} from '@cc-setup-agent/db';
import type { AppConfig } from '@cc-setup-agent/shared';
import type { SourcesFile } from '../catalog-config.js';
import { fetchChangeNotes, type ChangeNote } from '../sources/changelog.js';
import type { GithubClient } from '../sources/github.js';
import { fetchGithubSearch } from '../sources/github-search.js';
import { fetchMarketplaces } from '../sources/marketplace.js';
import { fetchRegistry } from '../sources/registry.js';
import type { FetchedRecord } from '../sources/types.js';
import { starVelocity7d } from '../intake/filter.js';

export const SOURCE_NAMES = ['changelog', 'registry', 'github_search', 'marketplaces'] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];

export interface DiscoveryDeps {
  db: Db;
  http: HttpClient;
  github: GithubClient;
  config: AppConfig;
  logger: Logger;
  sources: SourcesFile;
  sleep?: (ms: number) => Promise<void>;
}

export interface SourceResult {
  source: SourceName;
  ok: boolean;
  records: number;
  error?: string;
}

/** Start of the window for a source: last successful run (minus an hour of overlap) or the lookback. */
export async function sinceFor(
  db: Db,
  source: SourceName,
  now: Date,
  lookbackDays: number,
): Promise<Date> {
  const [last] = await db
    .select({ startedAt: sourceRuns.startedAt })
    .from(sourceRuns)
    .where(and(eq(sourceRuns.source, source), eq(sourceRuns.status, 'ok')))
    .orderBy(desc(sourceRuns.startedAt))
    .limit(1);
  return last
    ? new Date(last.startedAt.getTime() - 3_600_000)
    : new Date(now.getTime() - lookbackDays * 86_400_000);
}

/** Upserts fetched records, tracking stars and adding health snapshots for linked items. */
export async function storeRecords(db: Db, records: FetchedRecord[], now: Date): Promise<void> {
  for (const record of records) {
    await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          itemId: rawSourceRecords.itemId,
          stars: rawSourceRecords.stars,
          starsCheckedAt: rawSourceRecords.starsCheckedAt,
          starVelocity7d: rawSourceRecords.starVelocity7d,
        })
        .from(rawSourceRecords)
        .where(
          and(
            eq(rawSourceRecords.source, record.source),
            eq(rawSourceRecords.externalId, record.externalId),
          ),
        );
      const repo = record.repo ?? null;
      const previous =
        existing?.stars != null && existing.starsCheckedAt
          ? { stars: existing.stars, at: existing.starsCheckedAt }
          : undefined;
      const velocity = repo ? starVelocity7d(repo.stars, now, previous, repo.createdAt) : undefined;
      await upsertRawRecord(tx, {
        source: record.source,
        externalId: record.externalId,
        payload: record.payload,
        fetchedAt: now,
        ...(repo ? { stars: { count: repo.stars, checkedAt: now, velocity7d: velocity } } : {}),
      });
      if (existing?.itemId && repo) {
        await tx.insert(signalSnapshots).values({
          itemId: existing.itemId,
          capturedAt: now,
          stars: repo.stars,
          starVelocity7d: velocity ?? existing.starVelocity7d,
          lastCommitAt: repo.pushedAt ? new Date(repo.pushedAt) : null,
        });
      }
    });
  }
}

export async function storeChangeNotes(db: Db, notes: ChangeNote[], now: Date): Promise<void> {
  for (const note of notes) {
    await db
      .insert(claudeCodeChanges)
      .values({ ...note, fetchedAt: now })
      .onConflictDoUpdate({
        target: [claudeCodeChanges.source, claudeCodeChanges.externalId],
        set: {
          title: note.title,
          body: note.body,
          flags: note.flags,
          url: note.url,
          publishedAt: note.publishedAt,
          fetchedAt: now,
        },
      });
  }
}

async function fetchSource(
  deps: DiscoveryDeps,
  source: SourceName,
  since: Date,
  now: Date,
): Promise<number> {
  const c = deps.config;
  switch (source) {
    case 'changelog': {
      const notes = await fetchChangeNotes(deps, {
        rawUrl: c.GITHUB_RAW_URL,
        repo: c.CLAUDE_CODE_REPO,
        maxVersions: c.CHANGELOG_MAX_VERSIONS,
      });
      await storeChangeNotes(deps.db, notes, now);
      return notes.length;
    }
    case 'registry': {
      const records = await fetchRegistry(
        deps,
        { registryUrl: c.MCP_REGISTRY_URL, maxPages: c.REGISTRY_MAX_PAGES },
        since,
      );
      await storeRecords(deps.db, records, now);
      return records.length;
    }
    case 'github_search': {
      const records = await fetchGithubSearch(
        deps,
        {
          topics: c.GITHUB_SEARCH_TOPICS,
          windowDays: c.GITHUB_SEARCH_WINDOW_DAYS,
          maxPages: c.GITHUB_SEARCH_MAX_PAGES,
          intervalMs: c.GITHUB_SEARCH_INTERVAL_MS,
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
        },
        now,
      );
      await storeRecords(deps.db, records, now);
      return records.length;
    }
    case 'marketplaces': {
      const records = await fetchMarketplaces(
        deps,
        deps.sources.marketplaces.map((m) => m.url),
      );
      await storeRecords(deps.db, records, now);
      return records.length;
    }
  }
}

/**
 * Runs each source in turn. A failing source is recorded and skipped; the others still run (NFR-4).
 */
export async function runSources(
  deps: DiscoveryDeps,
  sources: readonly SourceName[] = SOURCE_NAMES,
  now = new Date(),
): Promise<SourceResult[]> {
  const results: SourceResult[] = [];
  for (const source of sources) {
    const since = await sinceFor(deps.db, source, now, deps.config.DISCOVERY_LOOKBACK_DAYS);
    const [run] = await deps.db
      .insert(sourceRuns)
      .values({ source, since, startedAt: now })
      .returning({ id: sourceRuns.id });
    try {
      const records = await fetchSource(deps, source, since, now);
      await deps.db
        .update(sourceRuns)
        .set({ status: 'ok', finishedAt: new Date(), records })
        .where(eq(sourceRuns.id, run!.id));
      results.push({ source, ok: true, records });
      deps.logger.info({ source, records }, 'source done');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      await deps.db
        .update(sourceRuns)
        .set({ status: 'failed', finishedAt: new Date(), error: message.slice(0, 2000) })
        .where(eq(sourceRuns.id, run!.id));
      results.push({ source, ok: false, records: 0, error: message });
      deps.logger.error({ source, err: error }, 'source failed; continuing with the others');
    }
  }
  return results;
}
