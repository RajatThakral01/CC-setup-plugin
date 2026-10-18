import { posix } from 'node:path';
import { z } from 'zod';
import type { HttpClient, Logger } from '@cc-setup-agent/core';
import type { GithubClient, RepoFacts } from './github.js';
import type { CandidateDraft, FetchedRecord } from './types.js';
import { githubRepoFromRepositoryUrl, githubSourceUrl } from './urls.js';

const pluginSourceSchema = z.union([
  z.string(),
  z.looseObject({
    source: z.string(),
    repo: z.string().optional(),
    url: z.string().optional(),
    path: z.string().optional(),
    ref: z.string().optional(),
    package: z.string().optional(),
  }),
]);

export const marketplacePluginSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  source: pluginSourceSchema,
  author: z.looseObject({ name: z.string().optional() }).optional(),
  category: z.string().optional(),
  homepage: z.string().optional(),
});
export type MarketplacePlugin = z.infer<typeof marketplacePluginSchema>;

export const marketplaceFileSchema = z.looseObject({
  name: z.string(),
  owner: z.looseObject({ name: z.string().optional() }).optional(),
  metadata: z.looseObject({ pluginRoot: z.string().optional() }).optional(),
  plugins: z.array(marketplacePluginSchema),
});

/** Where a marketplace.json lives, parsed from its raw.githubusercontent.com URL. */
export interface MarketplaceLocation {
  url: string;
  fullName: string;
  ref: string;
}

export function parseMarketplaceUrl(url: string): MarketplaceLocation | undefined {
  const m =
    /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/\.claude-plugin\/marketplace\.json$/.exec(
      url,
    );
  return m ? { url, fullName: `${m[1]}/${m[2]}`, ref: m[3]! } : undefined;
}

/** Repo and optional folder a plugin entry points at; undefined for non-GitHub sources. */
export interface ResolvedPluginSource {
  fullName: string;
  ref?: string;
  path?: string;
  packageName?: string;
}

export function resolvePluginSource(
  plugin: MarketplacePlugin,
  location: MarketplaceLocation,
  pluginRoot: string | undefined,
): ResolvedPluginSource | undefined {
  const src = plugin.source;
  if (typeof src === 'string') {
    const joined = posix.normalize(posix.join(pluginRoot ?? '', src)).replace(/^\.\/?|\/$/g, '');
    if (joined.startsWith('..')) return undefined;
    return joined === '' || joined === '.'
      ? { fullName: location.fullName }
      : { fullName: location.fullName, ref: location.ref, path: joined };
  }
  const folder = src.path?.replace(/^\.?\/+|\/+$/g, '');
  switch (src.source) {
    case 'github': {
      if (!src.repo) return undefined;
      return folder
        ? { fullName: src.repo, ref: src.ref ?? 'HEAD', path: folder }
        : { fullName: src.repo };
    }
    case 'url':
    case 'git-subdir': {
      const repo = githubRepoFromRepositoryUrl(src.url);
      if (!repo) return undefined;
      const fullName = `${repo.owner}/${repo.repo}`;
      return folder ? { fullName, ref: src.ref ?? 'HEAD', path: folder } : { fullName };
    }
    default:
      return undefined;
  }
}

export interface MarketplacePayload {
  marketplace: { url: string; name: string; fullName: string };
  plugin: MarketplacePlugin;
  resolved: ResolvedPluginSource | null;
  repo: RepoFacts | null;
}

/** Every plugin listed in the configured marketplaces (FR-D5), enriched with repo facts. */
export async function fetchMarketplaces(
  deps: { http: HttpClient; github: GithubClient; logger: Logger },
  marketplaceUrls: string[],
): Promise<FetchedRecord[]> {
  const collected: Array<Omit<MarketplacePayload, 'repo'>> = [];
  const failures: string[] = [];
  for (const url of marketplaceUrls) {
    const location = parseMarketplaceUrl(url);
    if (!location) {
      failures.push(`${url}: not a raw.githubusercontent.com marketplace.json URL`);
      continue;
    }
    try {
      const file = await deps.http.getJson(url, marketplaceFileSchema);
      for (const plugin of file.plugins) {
        collected.push({
          marketplace: { url, name: file.name, fullName: location.fullName },
          plugin,
          resolved: resolvePluginSource(plugin, location, file.metadata?.pluginRoot) ?? null,
        });
      }
    } catch (error) {
      // One broken marketplace must not hide the others.
      deps.logger.error({ url, err: error }, 'marketplace fetch failed');
      failures.push(`${url}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  if (collected.length === 0 && failures.length > 0) {
    throw new Error(`all marketplaces failed: ${failures.join('; ')}`);
  }
  const facts = await deps.github.getReposBatch(
    collected.flatMap((c) => (c.resolved ? [c.resolved.fullName] : [])),
  );
  return collected.map((c) => {
    const repo = c.resolved ? (facts.get(c.resolved.fullName.toLowerCase()) ?? null) : null;
    const payload: MarketplacePayload = { ...c, repo };
    return {
      source: 'marketplace',
      externalId: `${c.marketplace.name}:${c.plugin.name}`,
      payload,
      repo,
    };
  });
}

export function normalizeMarketplace(payload: MarketplacePayload): CandidateDraft {
  const { plugin, resolved, repo } = payload;
  // A ref of HEAD means "default branch"; use the real branch name in canonical URLs.
  const ref = resolved?.ref === 'HEAD' ? repo?.defaultBranch : resolved?.ref;
  const folder = resolved?.path && ref ? { path: resolved.path, ref } : undefined;
  return {
    name: plugin.name,
    description: plugin.description ?? repo?.description ?? null,
    sourceUrl: repo ? githubSourceUrl(repo.fullName, folder?.ref, folder?.path) : null,
    packageName: resolved?.packageName ?? null,
    publisher: plugin.author?.name ?? repo?.owner ?? null,
    kind: 'plugin',
    repo,
    ...(folder ? { folder } : {}),
  };
}
