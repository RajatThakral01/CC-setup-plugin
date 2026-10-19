import { join } from 'node:path';
import { z } from 'zod';
import type { Snapshot, SnapshotItem } from '@cc-setup-agent/shared';
import { unifiedDiff } from './diff.js';
import { PluginError, readText } from './files.js';

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

/** Deep-merges settings: keeps every existing key, unions permission and server lists. */
export function mergeSettings(existing: string | null, serverNames: string[]): string {
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
  return `${JSON.stringify(merged, null, 2)}\n`;
}

function file(path: string, before: string | null, after: string): GeneratedFile {
  return {
    path,
    action: before === null ? 'create' : before === after ? 'unchanged' : 'update',
    content: after,
    diff: unifiedDiff(path, before, after),
  };
}

/**
 * Builds the config for the approved items and returns contents and diffs; never writes (plan M7).
 * Outputs are validated against the Claude Code config shapes before they are returned (FR-G9).
 */
export async function generateConfig(
  root: string,
  snapshot: Snapshot,
  approvedIds: string[],
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
  if (Object.keys(servers).length > 0 || mcpJson !== null) {
    // Validate what we generate; servers the user added by hand are kept as they are.
    mcpJsonSchema.parse({ mcpServers: servers });
    const next = mergeMcpJson(mcpJson, servers);
    files.push(file('.mcp.json', mcpJson, next));
    const nextSettings = mergeSettings(settings, Object.keys(servers));
    settingsSchema.parse(JSON.parse(nextSettings));
    files.push(file('.claude/settings.json', settings, nextSettings));
  }
  return { files, requiredEnvVars, installCommands };
}
