import { join } from 'node:path';
import { z } from 'zod';
import type { Snapshot, SnapshotItem } from '@cc-setup-agent/shared';
import type { HookId } from '@cc-setup-agent/shared';
import { analyzeProject } from './analyze.js';
import { unifiedDiff } from './diff.js';
import { PluginError, readText } from './files.js';
import { hookRecipes, mergeHooks, type HookMergeResult, type HookRecipe } from './hooks.js';

export const BLOCK_START = '<!-- setup-agent:start -->';
export const BLOCK_END = '<!-- setup-agent:end -->';
const SETTINGS_SCHEMA_URL = 'https://json.schemastore.org/claude-code-settings.json';

/** Shapes verified against Claude Code 2.1.302 docs (docs/DECISIONS.md, M0). */
const stdioServerSchema = z.looseObject({
  type: z.literal('stdio').optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
const httpServerSchema = z.looseObject({
  type: z.enum(['http', 'streamable-http', 'sse']),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
});
export const mcpJsonSchema = z.looseObject({
  mcpServers: z.record(z.string(), z.union([stdioServerSchema, httpServerSchema])),
});
const hookGroupSchema = z.looseObject({
  matcher: z.string().optional(),
  hooks: z.array(
    z.looseObject({
      type: z.literal('command'),
      command: z.string().min(1),
      timeout: z.number().int().positive().optional(),
    }),
  ),
});
export const hooksSchema = z.record(z.string(), z.array(hookGroupSchema));
export const settingsSchema = z.looseObject({
  permissions: z
    .looseObject({
      allow: z.array(z.string()).optional(),
      ask: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
    .optional(),
  enabledMcpjsonServers: z.array(z.string()).optional(),
  hooks: z.record(z.string(), z.unknown()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export interface GeneratedFile {
  path: string;
  action: 'create' | 'update' | 'unchanged';
  content: string;
  diff: string;
}

export interface GenerateResult {
  files: GeneratedFile[];
  requiredEnvVars: string[];
  installCommands: string[];
  skippedHooks: HookMergeResult['skipped'];
}

/** `.mcp.json` entry for an item, with pinned versions and env placeholders only (FR-G6, FR-G7). */
export function mcpServerEntry(item: SnapshotItem): Record<string, unknown> | null {
  const install = item.install;
  if (!install) return null;
  const env = Object.fromEntries(install.envVars.map((v) => [v, `\${${v}}`]));
  const withEnv = Object.keys(env).length > 0 ? { env } : {};
  if (install.method === 'npx' && install.package && install.version) {
    return { command: 'npx', args: ['-y', `${install.package}@${install.version}`], ...withEnv };
  }
  if (install.method === 'uvx' && install.package && install.version) {
    return {
      command: 'uvx',
      args: ['--from', `${install.package}==${install.version}`, install.package],
      ...withEnv,
    };
  }
  if (install.method === 'remote' && install.url) return { type: 'http', url: install.url };
  return null;
}

function repoFromUrl(url: string): string | null {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)/.exec(url);
  return m?.[1] ?? null;
}

/** Commands or steps for items that aren't MCP servers (plugins, skills, manual items). */
export function installSteps(item: SnapshotItem): string[] {
  const install = item.install;
  if (!install) return [];
  if (install.method === 'plugin' && install.plugin) {
    const repo = repoFromUrl(item.sourceUrl);
    return [
      ...(repo ? [`claude plugin marketplace add ${repo}`] : []),
      `claude plugin install ${install.plugin.name}@${install.plugin.marketplace}`,
    ];
  }
  if (install.method === 'skill_copy')
    return [`Copy the skill folder from ${item.sourceUrl} into .claude/skills/${item.id}/`];
  if (install.method === 'manual')
    return [`Follow the install steps at ${install.url ?? item.sourceUrl}`];
  return [];
}

function managedBlock(items: SnapshotItem[], envVars: string[], version: string): string {
  const lines = [
    BLOCK_START,
    `## Claude Code setup (managed by setup-agent, catalog ${version})`,
    '',
    'Tools chosen for this project:',
    ...items.map((i) => `- **${i.name}** (${i.category ?? i.kind}): ${i.sourceUrl}`),
  ];
  if (envVars.length > 0)
    lines.push(
      '',
      `Environment variables these tools need (set them in your shell, never in this file): ${envVars.join(', ')}.`,
    );
  lines.push(
    '',
    'Edit outside this block freely; setup-agent only replaces the text between the markers.',
    BLOCK_END,
  );
  return lines.join('\n');
}

/** Replaces only the managed block (or appends one); content outside it is preserved exactly (FR-G8). */
export function mergeClaudeMd(existing: string | null, block: string): string {
  if (existing === null) return `${block}\n`;
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END);
  if (start !== -1 && end > start)
    return existing.slice(0, start) + block + existing.slice(end + BLOCK_END.length);
  const sep =
    existing.length === 0 || existing.endsWith('\n\n')
      ? ''
      : existing.endsWith('\n')
        ? '\n'
        : '\n\n';
  return `${existing}${sep}${block}\n`;
}

/** Adds or updates our servers by name; every other server is kept untouched. */
export function mergeMcpJson(
  existing: string | null,
  servers: Record<string, Record<string, unknown>>,
): string {
  let base: Record<string, unknown> = {};
  if (existing !== null) {
    try {
      base = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      throw new PluginError('.mcp.json is not valid JSON; fix it before generating config');
    }
  }
  const current = (
    base['mcpServers'] && typeof base['mcpServers'] === 'object' ? base['mcpServers'] : {}
  ) as Record<string, unknown>;
  return `${JSON.stringify({ ...base, mcpServers: { ...current, ...servers } }, null, 2)}\n`;
}

const union = (a: unknown, b: string[]) => [
  ...new Set([
    ...(Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []),
    ...b,
  ]),
];

/**
 * Deep-merges settings: keeps every existing key, unions permission and server lists, and appends
 * approved hook recipes without touching existing hooks.
 */
export function mergeSettings(
  existing: string | null,
  serverNames: string[],
  recipes: HookRecipe[] = [],
): string {
  return mergeSettingsDetailed(existing, serverNames, recipes).content;
}

export function mergeSettingsDetailed(
  existing: string | null,
  serverNames: string[],
  recipes: HookRecipe[],
): { content: string; skippedHooks: HookMergeResult['skipped'] } {
  let base: Record<string, unknown> = existing === null ? { $schema: SETTINGS_SCHEMA_URL } : {};
  if (existing !== null) {
    try {
      base = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      throw new PluginError(
        '.claude/settings.json is not valid JSON; fix it before generating config',
      );
    }
  }
  const merged: Record<string, unknown> = { ...base };
  if (serverNames.length > 0)
    merged['enabledMcpjsonServers'] = union(base['enabledMcpjsonServers'], serverNames);
  const perms = (
    base['permissions'] && typeof base['permissions'] === 'object' ? base['permissions'] : null
  ) as Record<string, unknown> | null;
  if (perms)
    merged['permissions'] = {
      ...perms,
      allow: union(perms['allow'], []),
      deny: union(perms['deny'], []),
    };
  let skippedHooks: HookMergeResult['skipped'] = [];
  if (recipes.length > 0) {
    const r = mergeHooks(base['hooks'], recipes);
    if (r.added.length > 0) merged['hooks'] = r.hooks;
    skippedHooks = r.skipped;
  }
  return { content: `${JSON.stringify(merged, null, 2)}\n`, skippedHooks };
}

function file(path: string, before: string | null, after: string): GeneratedFile {
  return {
    path,
    action: before === null ? 'create' : before === after ? 'unchanged' : 'update',
    content: after,
    diff: unifiedDiff(path, before, after),
  };
}

/** Recipes for the approved hook ids; refuses ids that don't fit this project's tooling. */
async function approvedRecipes(root: string, hookIds: HookId[]): Promise<HookRecipe[]> {
  const available = hookRecipes(await analyzeProject(root));
  const missing = hookIds.filter((id) => !available.some((r) => r.id === id));
  if (missing.length > 0)
    throw new PluginError(`hook recipe doesn't fit this project's tooling: ${missing.join(', ')}`);
  return available.filter((r) => hookIds.includes(r.id));
}

/**
 * Builds the config for the approved items and returns contents and diffs; never writes (plan M7).
 * Outputs are validated against the Claude Code config shapes before they are returned (FR-G9).
 */
export async function generateConfig(
  root: string,
  snapshot: Snapshot,
  approvedIds: string[],
  hookIds: HookId[] = [],
): Promise<GenerateResult> {
  const byId = new Map(snapshot.items.map((i) => [i.id, i]));
  const unknown = approvedIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) throw new PluginError(`not in the catalog: ${unknown.join(', ')}`);
  const items = [...new Set(approvedIds)]
    .map((id) => byId.get(id)!)
    .sort((a, b) => a.id.localeCompare(b.id));
  const notRecommended = items.filter(
    (i) => i.status !== 'recommended' && i.status !== 'recommended_provisional',
  );
  if (notRecommended.length > 0)
    throw new PluginError(
      `not recommended, can't be installed: ${notRecommended.map((i) => `${i.id} (${i.status})`).join(', ')}`,
    );

  const servers: Record<string, Record<string, unknown>> = {};
  const installCommands: string[] = [];
  for (const item of items) {
    const entry = item.kind === 'mcp_server' ? mcpServerEntry(item) : null;
    if (entry) servers[item.id] = entry;
    else installCommands.push(...installSteps(item));
  }
  const requiredEnvVars = [...new Set(items.flatMap((i) => i.install?.envVars ?? []))].sort();

  const [claudeMd, mcpJson, settings] = await Promise.all([
    readText(join(root, 'CLAUDE.md')),
    readText(join(root, '.mcp.json')),
    readText(join(root, '.claude', 'settings.json')),
  ]);
  const files: GeneratedFile[] = [
    file(
      'CLAUDE.md',
      claudeMd,
      mergeClaudeMd(claudeMd, managedBlock(items, requiredEnvVars, snapshot.version)),
    ),
  ];
  const recipes = hookIds.length > 0 ? await approvedRecipes(root, hookIds) : [];
  if (Object.keys(servers).length > 0 || mcpJson !== null) {
    // Validate what we generate; servers the user added by hand are kept as they are.
    mcpJsonSchema.parse({ mcpServers: servers });
    const next = mergeMcpJson(mcpJson, servers);
    files.push(file('.mcp.json', mcpJson, next));
  }
  let skippedHooks: HookMergeResult['skipped'] = [];
  if (Object.keys(servers).length > 0 || mcpJson !== null || recipes.length > 0) {
    const merged = mergeSettingsDetailed(settings, Object.keys(servers), recipes);
    settingsSchema.parse(JSON.parse(merged.content));
    // Our hook groups must match the verified hooks shape (event → [{matcher?, hooks: [...]}]).
    hooksSchema.parse({
      PostToolUse: [],
      Stop: [],
      ...Object.fromEntries(
        recipes.map((r) => [r.event, mergeHooks(undefined, [r]).hooks[r.event]]),
      ),
    });
    skippedHooks = merged.skippedHooks;
    files.push(file('.claude/settings.json', settings, merged.content));
  }
  return { files, requiredEnvVars, installCommands, skippedHooks };
}
