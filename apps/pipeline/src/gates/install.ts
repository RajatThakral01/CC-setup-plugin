import { z } from 'zod';
import { HttpError, type HttpClient } from '@cc-setup-agent/core';
import type { Install } from '@cc-setup-agent/shared';
import type { GithubClient } from '../sources/github.js';
import {
  latestManifest,
  repositoryUrl,
  type NpmClient,
  type NpmPackument,
} from '../sources/npm.js';
import { githubRepoFromRepositoryUrl } from '../sources/urls.js';
import { registryEntrySchema, type RegistryPayload } from '../sources/registry.js';
import type { MarketplacePayload } from '../sources/marketplace.js';

/** Strict shapes for values that end up inside a sandbox `sh -c` command. */
export const NPM_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
export const PYPI_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/;

const pypiSchema = z.looseObject({
  info: z.looseObject({
    name: z.string(),
    version: z.string(),
    license: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  }),
});

export interface ResolvedInstall {
  install: Install | null;
  /** Version the scorecard is for: package version, registry version, release tag or commit. */
  version: string;
  npm?: { packument: NpmPackument; version: string };
  pypi?: { name: string; version: string; license: string | null; readmeLength: number };
  /** Where the install came from, for evidence. */
  via: string;
}

export interface InstallInputs {
  kind: string | null;
  sourceUrl: string;
  packageName: string | null;
  registry: RegistryPayload | null;
  marketplace: MarketplacePayload | null;
  repoFullName: string | null;
  folder: { path: string; ref: string } | null;
  /** Fallback version: latest release tag or `sha-<commit>`. */
  repoVersion: string;
}

export interface InstallDeps {
  http: HttpClient;
  npm: NpmClient;
  github: GithubClient;
  pypiUrl: string;
  /** MCP Registry base URL, for finding a server's packages by its repository. */
  registryUrl?: string;
}

/**
 * Finds the latest MCP Registry entry whose repository is this repo (and subfolder, for folder
 * items). Searches by repo name, then matches the repository URL exactly.
 */
export async function findRegistryServer(
  http: HttpClient,
  registryUrl: string,
  fullName: string,
  subfolder: string | null,
): Promise<RegistryPayload['entry'] | null> {
  const name = fullName.split('/')[1] ?? fullName;
  const params = new URLSearchParams({ search: name, version: 'latest', limit: '100' });
  const page = await http.getJson(
    `${registryUrl.replace(/\/+$/, '')}/servers?${params.toString()}`,
    z.object({ servers: z.array(registryEntrySchema) }),
  );
  const matches = page.servers.filter((e) => {
    const repo = githubRepoFromRepositoryUrl(e.server.repository?.url);
    if (!repo || `${repo.owner}/${repo.repo}`.toLowerCase() !== fullName.toLowerCase())
      return false;
    const sub = e.server.repository?.subfolder?.replace(/^\/+|\/+$/g, '') ?? null;
    return subfolder === null || sub === null || sub === subfolder;
  });
  return matches[0] ?? null;
}

async function npmInstall(
  deps: InstallDeps,
  name: string,
  envVars: string[],
  via: string,
): Promise<ResolvedInstall | null> {
  if (!NPM_NAME.test(name)) return null;
  try {
    const packument = await deps.npm.getPackument(name);
    const latest = latestManifest(packument);
    if (!latest || latest.deprecated || !SAFE_VERSION.test(latest.version)) return null;
    return {
      install: { method: 'npx', package: name, version: latest.version, envVars },
      version: latest.version,
      npm: { packument, version: latest.version },
      via,
    };
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}

async function pypiInstall(
  deps: InstallDeps,
  name: string,
  envVars: string[],
  via: string,
): Promise<ResolvedInstall | null> {
  if (!PYPI_NAME.test(name)) return null;
  try {
    const data = await deps.http.getJson(
      `${deps.pypiUrl.replace(/\/+$/, '')}/pypi/${encodeURIComponent(name)}/json`,
      pypiSchema,
    );
    if (!SAFE_VERSION.test(data.info.version)) return null;
    return {
      install: { method: 'uvx', package: data.info.name, version: data.info.version, envVars },
      version: data.info.version,
      pypi: {
        name: data.info.name,
        version: data.info.version,
        license: data.info.license ?? null,
        readmeLength: data.info.description?.length ?? 0,
      },
      via,
    };
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}

const envNames = (vars: unknown): string[] =>
  Array.isArray(vars)
    ? vars.flatMap((v) =>
        v &&
        typeof v === 'object' &&
        'name' in v &&
        typeof v.name === 'string' &&
        /^[A-Z_][A-Z0-9_]*$/.test(v.name)
          ? [v.name]
          : [],
      )
    : [];

/** `name = "..."` from the [project] table of a pyproject.toml. */
export function pyprojectName(toml: string): string | undefined {
  const project = /^\[project\]\s*$([\s\S]*?)(^\[|$(?![\s\S]))/m.exec(toml)?.[1] ?? '';
  return /^\s*name\s*=\s*["']([^"']+)["']/m.exec(project)?.[1];
}

/**
 * How an item is installed, with an exact version (FR-G6). MCP servers: npm package, Registry
 * packages (npm first, then PyPI), Registry remote, or a package published from the repo.
 */
export async function resolveInstall(
  deps: InstallDeps,
  input: InstallInputs,
): Promise<ResolvedInstall> {
  const fallback: ResolvedInstall = { install: null, version: input.repoVersion, via: 'none' };
  if (input.kind === 'plugin') {
    const m = input.marketplace;
    return {
      ...fallback,
      install: m
        ? {
            method: 'plugin',
            plugin: { marketplace: m.marketplace.name, name: m.plugin.name },
            envVars: [],
          }
        : { method: 'manual', url: input.sourceUrl, envVars: [] },
      via: m ? 'marketplace' : 'repo',
    };
  }
  if (input.kind === 'skill')
    return {
      ...fallback,
      install: { method: 'skill_copy', url: input.sourceUrl, envVars: [] },
      via: 'repo',
    };
  if (input.kind !== 'mcp_server')
    return {
      ...fallback,
      install: { method: 'manual', url: input.sourceUrl, envVars: [] },
      via: 'repo',
    };

  if (input.packageName) {
    const r = await npmInstall(deps, input.packageName, [], 'npm package');
    if (r) return r;
  }
  let server = input.registry?.entry.server;
  if (!server && deps.registryUrl && input.repoFullName) {
    server = (
      await findRegistryServer(
        deps.http,
        deps.registryUrl,
        input.repoFullName,
        input.folder?.path ?? null,
      ).catch(() => null)
    )?.server;
  }
  if (server) {
    for (const type of ['npm', 'pypi'] as const) {
      const pkg = server.packages?.find((p) => p.registryType === type && p.identifier);
      if (!pkg?.identifier) continue;
      const vars = envNames((pkg as Record<string, unknown>)['environmentVariables']);
      const r =
        type === 'npm'
          ? await npmInstall(deps, pkg.identifier, vars, 'MCP Registry')
          : await pypiInstall(deps, pkg.identifier, vars, 'MCP Registry');
      if (r) return r;
    }
    const remote = (server as Record<string, unknown>)['remotes'];
    const url = Array.isArray(remote)
      ? (remote[0] as { url?: unknown } | undefined)?.url
      : undefined;
    if (typeof url === 'string' && /^https:\/\//.test(url)) {
      return {
        install: { method: 'remote', url, envVars: [] },
        version: server.version ?? input.repoVersion,
        via: 'MCP Registry remote',
      };
    }
  }
  if (input.repoFullName) {
    const base = input.folder ? `${input.folder.path}/` : '';
    const ref = input.folder?.ref;
    const pkgJson = await deps.github.getFileText(input.repoFullName, `${base}package.json`, ref);
    if (pkgJson) {
      try {
        const p = JSON.parse(pkgJson) as { name?: unknown; private?: unknown };
        if (typeof p.name === 'string' && p.private !== true) {
          const r = await npmInstall(deps, p.name, [], 'package.json in repo');
          // Only trust the npm package if it points back at this repo.
          const repoRef = r?.npm
            ? githubRepoFromRepositoryUrl(
                repositoryUrl(
                  r.npm.packument.repository ?? latestManifest(r.npm.packument)?.repository,
                ),
              )
            : undefined;
          if (
            r &&
            repoRef &&
            `${repoRef.owner}/${repoRef.repo}`.toLowerCase() === input.repoFullName.toLowerCase()
          )
            return r;
        }
      } catch {
        // Malformed package.json: fall through.
      }
    }
    const pyproject = await deps.github.getFileText(
      input.repoFullName,
      `${base}pyproject.toml`,
      ref,
    );
    const pyName = pyproject ? pyprojectName(pyproject) : undefined;
    if (pyName) {
      const r = await pypiInstall(deps, pyName, [], 'pyproject.toml in repo');
      if (r) return r;
    }
  }
  return fallback;
}

/** Shell command for the sandbox; only ever built from values matching the strict patterns above. */
export function sandboxShell(install: Install): string | null {
  const q = (s: string) => `'${s}'`;
  if (
    install.method === 'npx' &&
    install.package &&
    install.version &&
    NPM_NAME.test(install.package) &&
    SAFE_VERSION.test(install.version)
  ) {
    return `exec npx -y ${q(`${install.package}@${install.version}`)}`;
  }
  if (
    install.method === 'uvx' &&
    install.package &&
    install.version &&
    PYPI_NAME.test(install.package) &&
    SAFE_VERSION.test(install.version)
  ) {
    return `python -m pip install --user -q uv && exec /work/.local/bin/uvx --from ${q(`${install.package}==${install.version}`)} ${q(install.package)}`;
  }
  return null;
}
