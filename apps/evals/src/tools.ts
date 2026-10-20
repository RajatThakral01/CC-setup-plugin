import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { HttpClient } from '@cc-setup-agent/core';
import type { Install, Kind } from '@cc-setup-agent/shared';
import { EvalError } from './errors.js';

export const DEFAULT_TOOLS_FILE = fileURLToPath(new URL('../tools.yaml', import.meta.url));

const overrideSchema = z.object({
  args: z.array(z.string()).default([]),
  playwrightBrowsers: z.array(z.string().regex(/^[0-9A-Za-z.-]+$/)).default([]),
});
const toolsFileSchema = z.object({ items: z.record(z.string(), overrideSchema).default({}) });
export type ToolOverrides = Record<string, z.output<typeof overrideSchema>>;

export async function loadToolOverrides(path = DEFAULT_TOOLS_FILE): Promise<ToolOverrides> {
  return toolsFileSchema.parse(parseYaml(await readFile(path, 'utf8')) ?? {}).items;
}

/** The catalog facts a run needs about the tool under test. */
export interface EvalItem {
  id: string;
  kind: Kind | null;
  install: Install | null;
  /** Pinned version from `item_versions` (package version, or `sha-<commit>` for repo items). */
  version: string;
  sourceUrl: string;
  contextOverheadTokens: number | null;
}

export type ToolSetup =
  | { kind: 'none' }
  | {
      kind: 'mcp';
      item: EvalItem;
      /** `.mcp.json`-style server entry passed with `--mcp-config` (`--strict-mcp-config`). */
      server: Record<string, unknown>;
      /** Commands run before Claude starts (not timed), e.g. warming the npx cache. */
      prewarm: string[][];
    }
  | { kind: 'skill'; item: EvalItem; files: Array<{ path: string; content: Buffer }> };

export const toolLabel = (t: ToolSetup) => (t.kind === 'none' ? 'no tool' : t.item.id);

const SAFE_NAME = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const SAFE_VERSION = /^[0-9A-Za-z.+_-]+$/;

/**
 * Builds the run setup for a catalog item from its pinned install details (FR-E5: exact versions).
 * Items that need third-party credentials can't be evaluated yet (FR-E7 is P1).
 */
export async function resolveToolSetup(
  item: EvalItem,
  overrides: ToolOverrides,
  fetchSkill: (item: EvalItem) => Promise<Array<{ path: string; content: Buffer }>>,
): Promise<ToolSetup> {
  const install = item.install;
  if (!install) throw new EvalError(`${item.id} has no install details`);
  if (install.envVars.length > 0)
    throw new EvalError(
      `${item.id} needs ${install.envVars.join(', ')}; items needing accounts are not evaluated (FR-E7)`,
    );
  const extra = overrides[item.id]?.args ?? [];
  if (item.kind === 'mcp_server' && install.method === 'npx') {
    const pkg = install.package;
    const version = install.version;
    if (!pkg || !version || !SAFE_NAME.test(pkg) || !SAFE_VERSION.test(version))
      throw new EvalError(`${item.id} has no pinned npm package`);
    const spec = `${pkg}@${version}`;
    return {
      kind: 'mcp',
      item,
      server: { command: 'npx', args: ['-y', spec, ...extra] },
      prewarm: [['npm', 'exec', '--yes', `--package=${spec}`, '--', 'true']],
    };
  }
  if (item.kind === 'mcp_server' && install.method === 'remote' && install.url)
    return { kind: 'mcp', item, server: { type: 'http', url: install.url }, prewarm: [] };
  if (install.method === 'skill_copy') {
    const files = await fetchSkill(item);
    if (!files.some((f) => /(^|\/)skill\.md$/i.test(f.path)))
      throw new EvalError(`${item.id}: no SKILL.md in the fetched skill folder`);
    return { kind: 'skill', item, files };
  }
  throw new EvalError(`${item.id}: install method ${install.method} isn't supported in evals yet`);
}

const treeSchema = z.looseObject({
  sha: z.string(),
  truncated: z.boolean().optional(),
  tree: z.array(z.looseObject({ path: z.string(), type: z.string(), size: z.number().optional() })),
});
const commitSchema = z.looseObject({ sha: z.string().regex(/^[0-9a-f]{40}$/) });

/**
 * Parses `https://github.com/<owner>/<repo>/tree/<ref>/<path>`, or a repo root
 * `https://github.com/<owner>/<repo>` (a skill that lives at the root of its repo; path '').
 */
export function parseTreeUrl(
  url: string,
): { repo: string; ref: string | null; path: string } | null {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/tree\/([^/]+)\/(.+?)\/?$/.exec(url);
  if (m) return { repo: m[1]!, ref: m[2]!, path: m[3]! };
  const root = /^https:\/\/github\.com\/([^/]+\/[^/.]+?)(?:\.git)?\/?$/.exec(url);
  return root ? { repo: root[1]!, ref: null, path: '' } : null;
}

/** Text skills can be large (testdino's guides are ~2 MB of Markdown); binaries are skipped. */
const MAX_SKILL_BYTES = 4_000_000;
const MAX_SKILL_FILE_BYTES = 512_000;
/** Repo-root skills: repository plumbing and binary files are not part of the skill. */
const SKIP_IN_ROOT_SKILL =
  /^(\.git\/|\.github\/|node_modules\/)|\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|mp4|mov|woff2?)$/i;

/**
 * Downloads a skill folder at the item's pinned commit (`sha-<commit>`), never a moving branch.
 * Files are data only on the host; they are used only inside the eval container.
 */
export function createSkillFetcher(
  http: HttpClient,
  options: { apiUrl: string; rawUrl: string; token?: string },
): (item: EvalItem) => Promise<Array<{ path: string; content: Buffer }>> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
  };
  return async (item) => {
    const where = parseTreeUrl(item.install?.url ?? item.sourceUrl);
    if (!where) throw new EvalError(`${item.id}: skill URL is not a GitHub repo or folder URL`);
    const pinned = /^sha-([0-9a-f]{7,40})$/.exec(item.version)?.[1];
    if (!pinned) throw new EvalError(`${item.id}: pinned version ${item.version} is not a commit`);
    const commit = await http.getJson(
      `${options.apiUrl}/repos/${where.repo}/commits/${pinned}`,
      commitSchema,
      { headers },
    );
    const tree = await http.getJson(
      `${options.apiUrl}/repos/${where.repo}/git/trees/${commit.sha}?recursive=1`,
      treeSchema,
      { headers },
    );
    if (tree.truncated) throw new EvalError(`${item.id}: repository tree too large to list`);
    const prefix = where.path ? `${where.path}/` : '';
    const atRoot = prefix === '';
    const blobs = tree.tree.filter(
      (e) =>
        e.type === 'blob' &&
        e.path.startsWith(prefix) &&
        (!atRoot || (!SKIP_IN_ROOT_SKILL.test(e.path) && (e.size ?? 0) <= MAX_SKILL_FILE_BYTES)),
    );
    if (atRoot && !blobs.some((b) => /^skill\.md$/i.test(b.path)))
      throw new EvalError(`${item.id}: no SKILL.md at the root of ${where.repo}`);
    const total = blobs.reduce((s, b) => s + (b.size ?? 0), 0);
    if (blobs.length === 0)
      throw new EvalError(`${item.id}: skill folder ${where.path || '(repo root)'} is empty`);
    if (total > MAX_SKILL_BYTES) throw new EvalError(`${item.id}: skill is over 4 MB`);
    const files: Array<{ path: string; content: Buffer }> = [];
    for (const b of blobs) {
      const res = await http.request(
        `${options.rawUrl}/${where.repo}/${commit.sha}/${b.path.split('/').map(encodeURIComponent).join('/')}`,
      );
      files.push({
        path: b.path.slice(prefix.length),
        content: Buffer.from(await res.arrayBuffer()),
      });
    }
    return files;
  };
}
