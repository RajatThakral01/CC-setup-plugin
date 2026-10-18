import { z } from 'zod';
import type { HttpClient, Logger } from '@cc-setup-agent/core';
import type { GithubClient, RepoFacts } from './github.js';
import type { CandidateDraft, FetchedRecord } from './types.js';
import { githubRepoFromRepositoryUrl, githubSourceUrl } from './urls.js';

const OFFICIAL_META = 'io.modelcontextprotocol.registry/official';

export const registryServerSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  title: z.string().optional(),
  version: z.string().optional(),
  repository: z
    .looseObject({
      url: z.string().optional(),
      source: z.string().optional(),
      subfolder: z.string().optional(),
    })
    .optional(),
  packages: z
    .array(
      z.looseObject({
        registryType: z.string().optional(),
        identifier: z.string().optional(),
        version: z.string().optional(),
      }),
    )
    .nullable()
    .optional(),
});

export const registryEntrySchema = z.looseObject({
  server: registryServerSchema,
  _meta: z
    .looseObject({
      [OFFICIAL_META]: z
        .looseObject({
          status: z.string().optional(),
          isLatest: z.boolean().optional(),
          updatedAt: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type RegistryEntry = z.infer<typeof registryEntrySchema>;

const registryPageSchema = z.object({
  servers: z.array(registryEntrySchema),
  metadata: z.looseObject({ nextCursor: z.string().nullable().optional() }).optional(),
});

/** What we store per Registry server: the entry plus GitHub facts for its repo (if any). */
export interface RegistryPayload {
  entry: RegistryEntry;
  repo: RepoFacts | null;
}

export interface RegistryOptions {
  registryUrl: string;
  maxPages: number;
}

/** Latest versions of servers updated since `since` (FR-D2), enriched with repo facts. */
export async function fetchRegistry(
  deps: { http: HttpClient; github: GithubClient; logger: Logger },
  options: RegistryOptions,
  since: Date,
): Promise<FetchedRecord[]> {
  const base = options.registryUrl.replace(/\/+$/, '');
  const entries: RegistryEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < options.maxPages; page++) {
    const params = new URLSearchParams({
      updated_since: since.toISOString(),
      limit: '100',
      version: 'latest',
    });
    if (cursor) params.set('cursor', cursor);
    const data = await deps.http.getJson(
      `${base}/servers?${params.toString()}`,
      registryPageSchema,
    );
    entries.push(...data.servers);
    cursor = data.metadata?.nextCursor ?? undefined;
    if (!cursor || data.servers.length === 0) break;
    if (page === options.maxPages - 1)
      deps.logger.warn({ pages: options.maxPages }, 'registry page limit reached');
  }
  // The Registry can list one server several times across pages; keep the last one seen.
  const byName = new Map(entries.map((e) => [e.server.name, e]));
  const repoNames = [...byName.values()]
    .map((e) => githubRepoFromRepositoryUrl(e.server.repository?.url))
    .filter((r) => r !== undefined)
    .map((r) => `${r.owner}/${r.repo}`);
  const facts = await deps.github.getReposBatch(repoNames);
  return [...byName.values()].map((entry) => {
    const ref = githubRepoFromRepositoryUrl(entry.server.repository?.url);
    const repo = ref ? (facts.get(`${ref.owner}/${ref.repo}`.toLowerCase()) ?? null) : null;
    const payload: RegistryPayload = { entry, repo };
    return { source: 'mcp_registry', externalId: entry.server.name, payload, repo };
  });
}

export function normalizeRegistry(payload: RegistryPayload): CandidateDraft {
  const { server } = payload.entry;
  const meta = payload.entry._meta?.[OFFICIAL_META];
  const repo = payload.repo;
  const subfolder = server.repository?.subfolder?.replace(/^\/+|\/+$/g, '');
  const npm = server.packages?.find((p) => p.registryType === 'npm' && p.identifier);
  return {
    name: server.title ?? server.name.split('/').at(-1) ?? server.name,
    description: server.description ?? repo?.description ?? null,
    sourceUrl: repo
      ? githubSourceUrl(
          repo.fullName,
          subfolder ? repo.defaultBranch : undefined,
          subfolder || undefined,
        )
      : null,
    packageName: npm?.identifier ?? null,
    publisher: repo?.owner ?? server.name.split('/')[0] ?? null,
    kind: 'mcp_server',
    repo,
    ...(repo && subfolder ? { folder: { path: subfolder, ref: repo.defaultBranch } } : {}),
    registry: {
      isLatest: meta?.isLatest === true,
      namespace: server.name.split('/')[0] ?? server.name,
      hasRepoUrl: Boolean(server.repository?.url),
    },
  };
}
