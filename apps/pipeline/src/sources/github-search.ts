import type { Logger } from '@cc-setup-agent/core';
import { repoFactsFromRest, type GithubClient, type GithubRepo } from './github.js';
import type { CandidateDraft, FetchedRecord } from './types.js';
import { githubSourceUrl } from './urls.js';

export interface GithubSearchOptions {
  topics: string[];
  windowDays: number;
  maxPages: number;
  /** Pause between search calls; the search API allows 30 requests a minute. */
  intervalMs: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Repos with the configured topics pushed within the window (FR-D3). */
export async function fetchGithubSearch(
  deps: { github: GithubClient; logger: Logger },
  options: GithubSearchOptions,
  now: Date,
): Promise<FetchedRecord[]> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const since = new Date(now.getTime() - options.windowDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const byId = new Map<number, GithubRepo>();
  let first = true;
  for (const topic of options.topics) {
    for (let page = 1; page <= options.maxPages; page++) {
      if (!first) await sleep(options.intervalMs);
      first = false;
      const data = await deps.github.searchRepos(`topic:${topic} pushed:>=${since}`, page, 100);
      for (const repo of data.items) byId.set(repo.id, repo);
      // Search returns at most 1000 results per query.
      if (data.items.length < 100 || page * 100 >= Math.min(data.total_count, 1000)) break;
    }
  }
  deps.logger.info({ repos: byId.size }, 'github search done');
  return [...byId.values()].map((repo) => ({
    source: 'github_repo',
    externalId: String(repo.id),
    payload: repo,
    repo: repoFactsFromRest(repo),
  }));
}

/** Normalizes a stored GitHub repo payload (search hit or seed import, incl. folder items). */
export function normalizeGithubRepo(payload: unknown): CandidateDraft | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as { repo?: GithubRepo; path?: string; ref?: string } & Partial<GithubRepo>;
  const repo = p.repo ?? (p.full_name ? (p as GithubRepo) : undefined);
  if (!repo) return null;
  const facts = repoFactsFromRest(repo);
  const folder = p.repo && p.path && p.ref ? { path: p.path, ref: p.ref } : undefined;
  return {
    name: folder ? (folder.path.split('/').at(-1) ?? repo.name) : repo.name,
    description: repo.description,
    sourceUrl: githubSourceUrl(repo.full_name, folder?.ref, folder?.path),
    packageName: null,
    publisher: repo.owner.login,
    kind: null,
    repo: facts,
    ...(folder ? { folder } : {}),
  };
}
