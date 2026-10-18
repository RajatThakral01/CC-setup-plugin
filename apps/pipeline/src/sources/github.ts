import { z } from 'zod';
import { HttpError, ResponseValidationError, type HttpClient } from '@cc-setup-agent/core';

/** Fields we rely on from the REST repo object; everything else is kept for the raw record. */
export const githubRepoSchema = z.looseObject({
  id: z.number().int(),
  full_name: z.string(),
  name: z.string(),
  owner: z.looseObject({ login: z.string(), type: z.string().optional() }),
  html_url: z.string(),
  description: z.string().nullable(),
  fork: z.boolean(),
  archived: z.boolean(),
  disabled: z.boolean().optional(),
  license: z.looseObject({ spdx_id: z.string().nullable().optional() }).nullable(),
  stargazers_count: z.number().int(),
  pushed_at: z.string().nullable(),
  created_at: z.string().optional(),
  default_branch: z.string(),
  topics: z.array(z.string()).optional(),
});
export type GithubRepo = z.infer<typeof githubRepoSchema>;

const contentsEntrySchema = z.looseObject({ name: z.string(), path: z.string(), type: z.string() });
export const githubDirectorySchema = z.array(contentsEntrySchema);
export type GithubDirectory = z.infer<typeof githubDirectorySchema>;

export const searchResponseSchema = z.looseObject({
  total_count: z.number().int(),
  incomplete_results: z.boolean().optional(),
  items: z.array(githubRepoSchema),
});

export const releaseSchema = z.looseObject({
  id: z.number().int(),
  tag_name: z.string(),
  name: z.string().nullable(),
  body: z.string().nullable(),
  html_url: z.string(),
  published_at: z.string().nullable(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
});
export type GithubRelease = z.infer<typeof releaseSchema>;

/** Source-independent repo facts used by the intake filter and health signals. */
export interface RepoFacts {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  fork: boolean;
  archived: boolean;
  /** SPDX id, `NOASSERTION` for an unrecognised licence file, or null when none was detected. */
  license: string | null;
  stars: number;
  pushedAt: string | null;
  createdAt: string | null;
  defaultBranch: string;
}

export function repoFactsFromRest(repo: GithubRepo): RepoFacts {
  return {
    id: repo.id,
    fullName: repo.full_name,
    owner: repo.owner.login,
    name: repo.name,
    description: repo.description,
    fork: repo.fork,
    archived: repo.archived,
    license: repo.license ? (repo.license.spdx_id ?? 'NOASSERTION') : null,
    stars: repo.stargazers_count,
    pushedAt: repo.pushed_at,
    createdAt: repo.created_at ?? null,
    defaultBranch: repo.default_branch,
  };
}

const graphqlRepoSchema = z
  .object({
    databaseId: z.number().int(),
    nameWithOwner: z.string(),
    name: z.string(),
    owner: z.object({ login: z.string() }),
    description: z.string().nullable(),
    isFork: z.boolean(),
    isArchived: z.boolean(),
    licenseInfo: z.object({ spdxId: z.string().nullable() }).nullable(),
    stargazerCount: z.number().int(),
    pushedAt: z.string().nullable(),
    createdAt: z.string(),
    defaultBranchRef: z.object({ name: z.string() }).nullable(),
  })
  .nullable();

const graphqlResponseSchema = z.object({
  data: z.record(z.string(), graphqlRepoSchema).nullable().optional(),
  errors: z.array(z.looseObject({ type: z.string().optional(), message: z.string() })).optional(),
});

const GRAPHQL_BATCH = 50;

export interface GithubClient {
  getRepo(owner: string, repo: string): Promise<GithubRepo>;
  /** Lists a directory; throws HttpError 404 if it doesn't exist. */
  getDirectory(fullName: string, path: string, ref: string): Promise<GithubDirectory>;
  /**
   * Looks up many repos in few GraphQL calls. Keys are lowercase `owner/name`; value null means
   * the repo does not exist or is not visible.
   */
  getReposBatch(fullNames: string[]): Promise<Map<string, RepoFacts | null>>;
  searchRepos(
    query: string,
    page: number,
    perPage: number,
  ): Promise<z.infer<typeof searchResponseSchema>>;
  /** README text (raw), for a repo root or a folder; undefined when there is none. */
  getReadme(fullName: string, folder?: { path: string; ref: string }): Promise<string | undefined>;
  getReleases(fullName: string, perPage: number): Promise<GithubRelease[]>;
  /** One file's raw text at `ref` (default branch when omitted); undefined when missing. */
  getFileText(fullName: string, path: string, ref?: string): Promise<string | undefined>;
  /** All paths in the tree at `ref`; `truncated` when GitHub cut the listing short. */
  getTree(fullName: string, ref: string): Promise<{ paths: string[]; truncated: boolean }>;
  getRepoHealth(fullName: string): Promise<RepoHealth | null>;
  /** Number of contributors (incl. anonymous), from the pagination of a one-per-page listing. */
  getContributorCount(fullName: string): Promise<number>;
}

const healthSchema = z.object({
  data: z
    .object({
      repository: z
        .object({
          diskUsage: z.number().nullable(),
          defaultBranchRef: z
            .object({
              name: z.string(),
              target: z
                .object({ oid: z.string().optional(), committedDate: z.string().optional() })
                .nullable(),
            })
            .nullable(),
          latestRelease: z
            .object({ tagName: z.string(), publishedAt: z.string().nullable() })
            .nullable(),
          releases: z.object({
            totalCount: z.number(),
            nodes: z.array(z.object({ publishedAt: z.string().nullable() })),
          }),
          issues: z.object({
            nodes: z.array(
              z.object({
                createdAt: z.string(),
                author: z.object({ login: z.string() }).nullable(),
                comments: z.object({
                  nodes: z.array(
                    z.object({
                      createdAt: z.string(),
                      author: z.object({ login: z.string() }).nullable(),
                    }),
                  ),
                }),
              }),
            ),
          }),
          openIssues: z.object({ totalCount: z.number() }),
          owner: z.object({
            login: z.string(),
            repositories: z.object({
              nodes: z.array(
                z.object({ nameWithOwner: z.string(), pushedAt: z.string().nullable() }),
              ),
            }),
          }),
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  errors: z.array(z.looseObject({ type: z.string().optional(), message: z.string() })).optional(),
});

/** Health signals for gates 0–2 (plan M4). */
export interface RepoHealth {
  diskUsageKb: number | null;
  defaultBranch: string | null;
  headSha: string | null;
  lastCommitAt: string | null;
  latestRelease: { tag: string; publishedAt: string | null } | null;
  releaseCount: number;
  releaseDates: string[];
  openIssues: number;
  /** Median hours from issue creation to the first comment by someone else, over recent issues. */
  medianIssueResponseHours: number | null;
  ownerLogin: string;
  /** Owner's other non-fork repos pushed within the last 180 days. */
  ownerMaintainedRepos: number;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function createGithubClient(http: HttpClient, token: string, apiUrl: string): GithubClient {
  const base = apiUrl.replace(/\/+$/, '');
  const headers = {
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'cc-setup-agent',
  };
  const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');

  async function rawText(url: string): Promise<string | undefined> {
    try {
      return await http.getText(url, {
        headers: { ...headers, accept: 'application/vnd.github.raw+json' },
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  return {
    getRepo: (owner, repo) =>
      http.getJson(`${base}/repos/${enc(owner)}/${enc(repo)}`, githubRepoSchema, { headers }),

    getDirectory: (fullName, path, ref) =>
      http.getJson(
        `${base}/repos/${enc(fullName)}/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`,
        githubDirectorySchema,
        { headers },
      ),

    async getReposBatch(fullNames) {
      const result = new Map<string, RepoFacts | null>();
      const unique = [...new Set(fullNames.map((n) => n.toLowerCase()))];
      for (let i = 0; i < unique.length; i += GRAPHQL_BATCH) {
        const batch = unique.slice(i, i + GRAPHQL_BATCH);
        const vars: Record<string, string> = {};
        const decls: string[] = [];
        const fields: string[] = [];
        batch.forEach((fullName, j) => {
          const [owner = '', name = ''] = fullName.split('/');
          vars[`o${j}`] = owner;
          vars[`n${j}`] = name;
          decls.push(`$o${j}: String!, $n${j}: String!`);
          fields.push(
            `r${j}: repository(owner: $o${j}, name: $n${j}) { databaseId nameWithOwner name owner { login } description isFork isArchived licenseInfo { spdxId } stargazerCount pushedAt createdAt defaultBranchRef { name } }`,
          );
        });
        const query = `query(${decls.join(', ')}) { ${fields.join(' ')} }`;
        const response = await http.request(`${base}/graphql`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ query, variables: vars }),
        });
        const parsed = graphqlResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
          throw new ResponseValidationError(
            `${base}/graphql`,
            parsed.error.issues.map((x) => x.message),
          );
        }
        const nonNotFound = (parsed.data.errors ?? []).filter((e) => e.type !== 'NOT_FOUND');
        if (!parsed.data.data && nonNotFound.length > 0) {
          throw new Error(`GitHub GraphQL error: ${nonNotFound[0]?.message ?? 'unknown'}`);
        }
        batch.forEach((fullName, j) => {
          const r = parsed.data.data?.[`r${j}`] ?? null;
          result.set(
            fullName,
            r === null
              ? null
              : {
                  id: r.databaseId,
                  fullName: r.nameWithOwner,
                  owner: r.owner.login,
                  name: r.name,
                  description: r.description,
                  fork: r.isFork,
                  archived: r.isArchived,
                  license: r.licenseInfo ? (r.licenseInfo.spdxId ?? 'NOASSERTION') : null,
                  stars: r.stargazerCount,
                  pushedAt: r.pushedAt,
                  createdAt: r.createdAt,
                  defaultBranch: r.defaultBranchRef?.name ?? 'main',
                },
          );
        });
      }
      return result;
    },

    searchRepos: (query, page, perPage) =>
      http.getJson(
        `${base}/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${perPage}&page=${page}`,
        searchResponseSchema,
        { headers },
      ),

    async getReadme(fullName, folder) {
      if (!folder) return rawText(`${base}/repos/${enc(fullName)}/readme`);
      for (const file of ['README.md', 'SKILL.md', 'readme.md']) {
        const text = await rawText(
          `${base}/repos/${enc(fullName)}/contents/${enc(`${folder.path}/${file}`)}?ref=${encodeURIComponent(folder.ref)}`,
        );
        if (text !== undefined) return text;
      }
      return undefined;
    },

    getFileText: (fullName, path, ref) =>
      rawText(
        `${base}/repos/${enc(fullName)}/contents/${enc(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`,
      ),

    async getTree(fullName, ref) {
      const data = await http.getJson(
        `${base}/repos/${enc(fullName)}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
        z.object({
          tree: z.array(z.looseObject({ path: z.string() })),
          truncated: z.boolean().optional(),
        }),
        { headers },
      );
      return { paths: data.tree.map((t) => t.path), truncated: data.truncated === true };
    },

    async getRepoHealth(fullName) {
      const [owner = '', name = ''] = fullName.split('/');
      const query = `query($o: String!, $n: String!) { repository(owner: $o, name: $n) {
        diskUsage
        defaultBranchRef { name target { ... on Commit { oid committedDate } } }
        latestRelease { tagName publishedAt }
        releases(first: 20, orderBy: { field: CREATED_AT, direction: DESC }) { totalCount nodes { publishedAt } }
        issues(first: 20, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { createdAt author { login } comments(first: 5) { nodes { createdAt author { login } } } } }
        openIssues: issues(states: OPEN) { totalCount }
        owner { login repositories(first: 100, ownerAffiliations: OWNER, isFork: false, orderBy: { field: PUSHED_AT, direction: DESC }) { nodes { nameWithOwner pushedAt } } }
      } }`;
      const response = await http.request(`${base}/graphql`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables: { o: owner, n: name } }),
      });
      const parsed = healthSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new ResponseValidationError(
          `${base}/graphql`,
          parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`),
        );
      }
      const r = parsed.data.data?.repository;
      if (!r) return null;
      const cutoff = Date.now() - 180 * 86_400_000;
      const responses = r.issues.nodes.flatMap((issue) => {
        const first = issue.comments.nodes.find((c) => c.author?.login !== issue.author?.login);
        return first
          ? [(Date.parse(first.createdAt) - Date.parse(issue.createdAt)) / 3_600_000]
          : [];
      });
      return {
        diskUsageKb: r.diskUsage,
        defaultBranch: r.defaultBranchRef?.name ?? null,
        headSha: r.defaultBranchRef?.target?.oid ?? null,
        lastCommitAt: r.defaultBranchRef?.target?.committedDate ?? null,
        latestRelease: r.latestRelease
          ? { tag: r.latestRelease.tagName, publishedAt: r.latestRelease.publishedAt }
          : null,
        releaseCount: r.releases.totalCount,
        releaseDates: r.releases.nodes.flatMap((n) => (n.publishedAt ? [n.publishedAt] : [])),
        openIssues: r.openIssues.totalCount,
        medianIssueResponseHours: median(responses),
        ownerLogin: r.owner.login,
        ownerMaintainedRepos: r.owner.repositories.nodes.filter(
          (n) =>
            n.nameWithOwner.toLowerCase() !== fullName.toLowerCase() &&
            n.pushedAt &&
            Date.parse(n.pushedAt) >= cutoff,
        ).length,
      };
    },

    async getContributorCount(fullName) {
      const response = await http.request(
        `${base}/repos/${enc(fullName)}/contributors?per_page=1&anon=1`,
        { headers },
      );
      const link = response.headers.get('link') ?? '';
      const last = /[?&]page=(\d+)>;\s*rel="last"/.exec(link);
      if (last?.[1]) {
        await response.body?.cancel();
        return Number(last[1]);
      }
      const body: unknown = await response.json().catch(() => []);
      return Array.isArray(body) ? body.length : 0;
    },

    getReleases: (fullName, perPage) =>
      http.getJson(
        `${base}/repos/${enc(fullName)}/releases?per_page=${perPage}`,
        z.array(releaseSchema),
        { headers },
      ),
  };
}
