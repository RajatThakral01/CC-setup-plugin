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

    getReleases: (fullName, perPage) =>
      http.getJson(
        `${base}/repos/${enc(fullName)}/releases?per_page=${perPage}`,
        z.array(releaseSchema),
        { headers },
      ),
  };
}
