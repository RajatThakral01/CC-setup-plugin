import { z } from 'zod';
import type { HttpClient } from '@cc-setup-agent/core';

const repositorySchema = z
  .union([z.string(), z.looseObject({ url: z.string().optional() })])
  .optional();

const versionManifestSchema = z.looseObject({
  version: z.string(),
  description: z.string().optional(),
  deprecated: z.string().optional(),
  license: z.unknown().optional(),
  repository: repositorySchema,
  bin: z.unknown().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
});

export const npmPackumentSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  'dist-tags': z.looseObject({ latest: z.string().optional() }),
  versions: z.record(z.string(), versionManifestSchema),
  time: z.record(z.string(), z.string()).optional(),
  repository: repositorySchema,
  license: z.unknown().optional(),
  readme: z.string().optional(),
});
export type NpmPackument = z.infer<typeof npmPackumentSchema>;

export function repositoryUrl(repo: z.infer<typeof repositorySchema>): string | undefined {
  if (repo === undefined) return undefined;
  return typeof repo === 'string' ? repo : repo.url;
}

/** Latest version manifest, if the packument has one. */
export function latestManifest(p: NpmPackument) {
  const latest = p['dist-tags'].latest;
  return latest ? p.versions[latest] : undefined;
}

/**
 * Compact form for raw_source_records: full packuments carry every version and can be megabytes.
 */
export function trimPackument(p: NpmPackument): Record<string, unknown> {
  const latest = latestManifest(p);
  return {
    name: p.name,
    description: p.description ?? latest?.description,
    distTags: p['dist-tags'],
    created: p.time?.['created'],
    modified: p.time?.['modified'],
    latestPublishedAt: latest ? p.time?.[latest.version] : undefined,
    versionCount: Object.keys(p.versions).length,
    repository: p.repository ?? latest?.repository,
    license: p.license ?? latest?.license,
    latest,
  };
}

export interface NpmClient {
  getPackument(name: string): Promise<NpmPackument>;
}

export function npmPackageUrl(registryUrl: string, name: string): string {
  const encoded = name.startsWith('@')
    ? `@${encodeURIComponent(name.slice(1))}`
    : encodeURIComponent(name);
  return `${registryUrl.replace(/\/+$/, '')}/${encoded}`;
}

export function createNpmClient(http: HttpClient, registryUrl: string): NpmClient {
  return {
    getPackument: (name) => http.getJson(npmPackageUrl(registryUrl, name), npmPackumentSchema),
  };
}
