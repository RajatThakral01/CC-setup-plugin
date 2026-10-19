import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import { approvalPolicySchema, categoryRulesSchema } from '@cc-setup-agent/shared';

export const CATALOG_DIR = fileURLToPath(new URL('../../../catalog/', import.meta.url));

export const vendorsFileSchema = z.object({
  github_orgs: z.array(z.string().min(1)).default([]),
  registry_namespaces: z.array(z.string().min(1)).nullable().default([]),
});

export interface Vendors {
  githubOrgs: ReadonlySet<string>;
  registryNamespaces: readonly string[];
}

export function vendorsFromFile(file: z.infer<typeof vendorsFileSchema>): Vendors {
  return {
    githubOrgs: new Set(file.github_orgs.map((o) => o.toLowerCase())),
    registryNamespaces: (file.registry_namespaces ?? []).map((n) => n.toLowerCase()),
  };
}

export const sourcesFileSchema = z.object({
  marketplaces: z.array(z.object({ url: z.url(), note: z.string().optional() })).default([]),
});
export type SourcesFile = z.infer<typeof sourcesFileSchema>;

async function readYaml<T extends z.ZodType>(path: string, schema: T): Promise<z.output<T>> {
  return schema.parse(parse(await readFile(path, 'utf8')) ?? {});
}

export const readVendors = async (dir = CATALOG_DIR) =>
  vendorsFromFile(await readYaml(`${dir}/vendors.yaml`, vendorsFileSchema));
export const readSources = (dir = CATALOG_DIR) =>
  readYaml(`${dir}/sources.yaml`, sourcesFileSchema);
export const readPolicy = (dir = CATALOG_DIR) =>
  readYaml(`${dir}/policy.yaml`, approvalPolicySchema);
export const readCategoryRules = (dir = CATALOG_DIR) =>
  readYaml(`${dir}/category-rules.yaml`, categoryRulesSchema);
