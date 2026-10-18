import { HttpError, type Logger } from '@cc-setup-agent/core';
import {
  findItemByKeys,
  insertCandidate,
  uniqueItemId,
  upsertRawRecord,
  type Db,
  type NewCatalogItem,
} from '@cc-setup-agent/db';
import type { GithubClient, GithubRepo } from '../sources/github.js';
import { latestManifest, repositoryUrl, trimPackument, type NpmClient } from '../sources/npm.js';
import {
  githubRepoFromRepositoryUrl,
  githubSourceUrl,
  npmSourceUrl,
  parseSourceUrl,
  slugify,
} from '../sources/urls.js';
import type { SeedEntry } from './seed-file.js';

export type SkipReason = 'not_found' | 'archived' | 'deprecated' | 'duplicate';

export interface SeedReport {
  created: Array<{ url: string; id: string; sourceUrl: string }>;
  skipped: Array<{ url: string; reason: SkipReason; detail: string }>;
  failed: Array<{ url: string; reason: string }>;
}

export interface SeedDeps {
  db: Db;
  github: GithubClient;
  npm: NpmClient;
  logger: Logger;
}

type Outcome =
  | { kind: 'created'; id: string; sourceUrl: string }
  | { kind: 'skipped'; reason: SkipReason; detail: string };

const SEED_ACTOR = 'system';

function isNotFound(error: unknown): boolean {
  return error instanceof HttpError && error.status === 404;
}

/**
 * Imports seed entries as `candidate` items with real metadata (plan M2). Idempotent:
 * existing items are reported as duplicates, raw records are refreshed in place.
 */
export async function importSeed(deps: SeedDeps, entries: SeedEntry[]): Promise<SeedReport> {
  const report: SeedReport = { created: [], skipped: [], failed: [] };
  for (const entry of entries) {
    const url = entry.source_url;
    try {
      const outcome = await importOne(deps, entry);
      if (outcome.kind === 'created') {
        report.created.push({ url, id: outcome.id, sourceUrl: outcome.sourceUrl });
        deps.logger.info({ url, id: outcome.id }, 'seed item created');
      } else {
        report.skipped.push({ url, reason: outcome.reason, detail: outcome.detail });
        deps.logger.info({ url, reason: outcome.reason }, 'seed item skipped');
      }
    } catch (error) {
      if (isNotFound(error)) {
        report.skipped.push({ url, reason: 'not_found', detail: 'source returned 404' });
        deps.logger.info({ url }, 'seed item skipped: not found');
        continue;
      }
      const reason = error instanceof Error ? error.message : 'unknown error';
      report.failed.push({ url, reason });
      deps.logger.error({ url, err: error }, 'seed item failed');
    }
  }
  return report;
}

async function importOne(deps: SeedDeps, entry: SeedEntry): Promise<Outcome> {
  const ref = parseSourceUrl(entry.source_url);
  if (!ref) throw new Error('unsupported URL: expected a GitHub repo/folder or npm package page');
  return ref.type === 'github'
    ? importGithub(deps, entry, ref.owner, ref.repo, ref.ref, ref.path)
    : importNpm(deps, entry, ref.name);
}

function hints(entry: SeedEntry): Pick<NewCatalogItem, 'kind' | 'category'> {
  return { kind: entry.kind ?? null, category: entry.category ?? null };
}

async function importGithub(
  deps: SeedDeps,
  entry: SeedEntry,
  owner: string,
  repoName: string,
  ref: string | undefined,
  path: string | undefined,
): Promise<Outcome> {
  const repo = await deps.github.getRepo(owner, repoName);
  if (repo.archived)
    return { kind: 'skipped', reason: 'archived', detail: `${repo.full_name} is archived` };

  let directory: unknown;
  if (ref && path) {
    directory = await deps.github.getDirectory(repo.full_name, path, ref);
  }
  const sourceUrl = githubSourceUrl(repo.full_name, ref, path);
  const externalId = path ? `${repo.id}:${ref}/${path}` : String(repo.id);
  const payload = path ? { repo, path, ref, directory } : repo;

  return deps.db.transaction(async (tx) => {
    const existing = await findItemByKeys(tx, { sourceUrl });
    if (existing) {
      await upsertRawRecord(tx, { source: 'github_repo', externalId, payload });
      return { kind: 'skipped', reason: 'duplicate', detail: `already imported as ${existing.id}` };
    }
    const id = await uniqueItemId(
      tx,
      path
        ? slugify(repo.owner.login, repo.name, path.split('/').at(-1) ?? path)
        : slugify(repo.owner.login, repo.name),
    );
    await insertCandidate(
      tx,
      {
        id,
        name: path ? (path.split('/').at(-1) ?? repo.name) : repo.name,
        description: repo.description,
        sourceUrl,
        publisher: repo.owner.login,
        ...hints(entry),
      },
      SEED_ACTOR,
      seedReason(entry),
    );
    await upsertRawRecord(tx, { source: 'github_repo', externalId, payload, itemId: id });
    return { kind: 'created', id, sourceUrl };
  });
}

async function importNpm(deps: SeedDeps, entry: SeedEntry, name: string): Promise<Outcome> {
  const packument = await deps.npm.getPackument(name);
  const latest = latestManifest(packument);
  if (latest?.deprecated) {
    return {
      kind: 'skipped',
      reason: 'deprecated',
      detail: `npm marks ${name}@${latest.version} deprecated`,
    };
  }
  const repoRef = githubRepoFromRepositoryUrl(
    repositoryUrl(packument.repository ?? latest?.repository),
  );
  let repo: GithubRepo | undefined;
  if (repoRef) {
    try {
      repo = await deps.github.getRepo(repoRef.owner, repoRef.repo);
    } catch (error) {
      // A stale repository link doesn't invalidate a live package; note it and continue.
      if (!isNotFound(error)) throw error;
      deps.logger.warn({ name }, 'npm repository link points at a missing GitHub repo');
    }
    if (repo?.archived) {
      return {
        kind: 'skipped',
        reason: 'archived',
        detail: `source repo ${repo.full_name} is archived`,
      };
    }
  }
  const sourceUrl = npmSourceUrl(packument.name);

  return deps.db.transaction(async (tx) => {
    const existing = await findItemByKeys(tx, { sourceUrl, packageName: packument.name });
    if (existing) {
      await upsertRawRecord(tx, {
        source: 'npm_package',
        externalId: packument.name,
        payload: trimPackument(packument),
      });
      return { kind: 'skipped', reason: 'duplicate', detail: `already imported as ${existing.id}` };
    }
    const id = await uniqueItemId(tx, slugify(packument.name.replace(/^@/, '')));
    await insertCandidate(
      tx,
      {
        id,
        name: packument.name,
        description: packument.description ?? latest?.description ?? null,
        sourceUrl,
        packageName: packument.name,
        publisher: packument.name.startsWith('@')
          ? packument.name.slice(1).split('/')[0]!
          : (repo?.owner.login ?? null),
        ...hints(entry),
      },
      SEED_ACTOR,
      seedReason(entry),
    );
    await upsertRawRecord(tx, {
      source: 'npm_package',
      externalId: packument.name,
      payload: trimPackument(packument),
      itemId: id,
    });
    if (repo) {
      // Kept for health signals later; not linked because a monorepo may back several packages.
      await upsertRawRecord(tx, {
        source: 'github_repo',
        externalId: String(repo.id),
        payload: repo,
      });
    }
    return { kind: 'created', id, sourceUrl };
  });
}

function seedReason(entry: SeedEntry): string {
  return entry.note ? `seed import: ${entry.note}`.slice(0, 500) : 'seed import';
}

/** Plain-text report for the CLI. */
export function formatSeedReport(report: SeedReport): string {
  const lines = [
    `Created: ${report.created.length}  Skipped: ${report.skipped.length}  Failed: ${report.failed.length}`,
    '',
    ...report.created.map((c) => `  created  ${c.id}  ${c.sourceUrl}`),
    ...report.skipped.map((s) => `  skipped  ${s.reason}  ${s.url}  (${s.detail})`),
    ...report.failed.map((f) => `  failed   ${f.url}  (${f.reason})`),
  ];
  return lines.join('\n');
}
