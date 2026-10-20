import type { Install } from '@cc-setup-agent/shared';

/**
 * What a plugin bundles besides its skills, commands and agents (gate 3, M8.3): MCP servers from
 * `.mcp.json` and the config files Claude Code reads. A plugin's `.mcp.json` is a map of servers,
 * either at the top level or under `mcpServers` (both are seen in official marketplaces).
 */

/** Config files whose text gate 3 scans, at most this many per item. */
export const MAX_CONFIG_FILES = 20;

export function configPaths(paths: string[]): string[] {
  return paths
    .filter((p) =>
      /(^|\/)(\.mcp\.json|\.lsp\.json|hooks\/hooks\.json|\.claude-plugin\/plugin\.json)$/.test(p),
    )
    .sort()
    .slice(0, MAX_CONFIG_FILES);
}

export type BundledServer =
  | { name: string; type: 'npm' | 'pypi'; package: string; version: string | null }
  | { name: string; type: 'remote'; url: string }
  | { name: string; type: 'other'; command: string };

const obj = (x: unknown): Record<string, unknown> | null =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
const strings = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [];

/** Exact versions only: `1.2.3`, `0.0.83-beta.1`; never `latest`, ranges or tags. */
const EXACT = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;

/** `@scope/name@1.2.3` → name and version (null when missing or not exact). */
export function splitNpmSpec(spec: string): { package: string; version: string | null } {
  const at = spec.lastIndexOf('@');
  if (at <= 0) return { package: spec, version: null };
  const version = spec.slice(at + 1);
  return { package: spec.slice(0, at), version: EXACT.test(version) ? version : null };
}

function serverFrom(name: string, s: Record<string, unknown>): BundledServer {
  const url = typeof s['url'] === 'string' ? s['url'] : null;
  if (
    url &&
    (s['type'] === 'http' ||
      s['type'] === 'sse' ||
      s['type'] === 'streamable-http' ||
      !s['command'])
  )
    return { name, type: 'remote', url };
  const command = typeof s['command'] === 'string' ? s['command'] : '';
  const args = strings(s['args']);
  if (command === 'npx' || command.endsWith('/npx')) {
    const spec = args.find((a) => !a.startsWith('-'));
    if (spec) return { name, type: 'npm', ...splitNpmSpec(spec) };
  }
  if (command === 'uvx' || command.endsWith('/uvx')) {
    const from = args.indexOf('--from');
    const spec = from >= 0 ? args[from + 1] : args.find((a) => !a.startsWith('-'));
    if (spec) {
      const [pkg, version] = spec.split('==');
      return {
        name,
        type: 'pypi',
        package: pkg!,
        version: version && EXACT.test(version) ? version : null,
      };
    }
  }
  return { name, type: 'other', command: [command, ...args].join(' ').trim() || '(none)' };
}

/** Servers in one `.mcp.json` text; an unparsable file yields none (gate 0 doesn't need it). */
export function parseBundledServers(text: string): BundledServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const root = obj(parsed);
  if (!root) return [];
  const map = obj(root['mcpServers']) ?? root;
  return Object.entries(map).flatMap(([name, value]) => {
    const s = obj(value);
    return s && (typeof s['command'] === 'string' || typeof s['url'] === 'string')
      ? [serverFrom(name, s)]
      : [];
  });
}

/** Install details for probing a bundled server in the sandbox (pinned packages only). */
export function bundledInstall(s: BundledServer): Install | null {
  if ((s.type === 'npm' || s.type === 'pypi') && s.version)
    return {
      method: s.type === 'npm' ? 'npx' : 'uvx',
      package: s.package,
      version: s.version,
      envVars: [],
    };
  return null;
}

export const describeBundled = (s: BundledServer) =>
  s.type === 'remote'
    ? `${s.name} (remote ${s.url})`
    : s.type === 'other'
      ? `${s.name} (${s.command})`
      : `${s.name} (${s.type} ${s.package}@${s.version ?? 'unpinned'})`;
