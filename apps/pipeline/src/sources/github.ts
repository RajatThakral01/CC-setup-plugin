import { z } from 'zod';
import type { HttpClient } from '@cc-setup-agent/core';

const API = 'https://api.github.com';

/** Fields we rely on; everything else is kept for the raw record. */
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

export interface GithubClient {
  getRepo(owner: string, repo: string): Promise<GithubRepo>;
  /** Lists a directory; throws HttpError 404 if it doesn't exist and a validation error if it's a file. */
  getDirectory(fullName: string, path: string, ref: string): Promise<GithubDirectory>;
}

export function createGithubClient(http: HttpClient, token: string): GithubClient {
  const headers = {
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'cc-setup-agent',
  };
  const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');
  return {
    getRepo: (owner, repo) =>
      http.getJson(`${API}/repos/${enc(owner)}/${enc(repo)}`, githubRepoSchema, { headers }),
    getDirectory: (fullName, path, ref) =>
      http.getJson(
        `${API}/repos/${enc(fullName)}/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`,
        githubDirectorySchema,
        { headers },
      ),
  };
}
