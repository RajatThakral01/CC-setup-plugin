import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readText } from './files.js';

export interface VerifyResult {
  item: string;
  check:
    'package_resolves' | 'server_starts' | 'env_present' | 'settings_parse' | 'duplicate_tools';
  status: 'pass' | 'fail';
  error?: string;
  fix?: string;
  note?: string;
}

/** A pinned package a stdio server runs (`npx -y pkg@1.2.3`, `uvx --from pkg==1.2.3 pkg`). */
export interface PackageSpec {
  ecosystem: 'npm' | 'pypi';
  name: string;
  version: string | null;
}

export type PackageResolver = (
  spec: PackageSpec,
) => Promise<{ ok: true } | { ok: false; error: string }>;

/** Value set for missing variables when starting a local server (never a real secret). */
export const PLACEHOLDER_VALUE = 'setup-agent-placeholder';

function splitNpmSpec(spec: string): { name: string; version: string | null } {
  const at = spec.lastIndexOf('@');
  return at > 0
    ? { name: spec.slice(0, at), version: spec.slice(at + 1) }
    : { name: spec, version: null };
}

/** The package a stdio entry runs through npx or uvx, or null for other commands. */
export function packageSpecOf(entry: { command?: string; args?: string[] }): PackageSpec | null {
  const args = entry.args ?? [];
  const cmd = entry.command?.split(/[\\/]/).at(-1);
  if (cmd === 'npx') {
    const pkgIndex = args.findIndex((a, i) => !a.startsWith('-') && args[i - 1] !== '--package');
    const flag = args.indexOf('--package');
    const spec = flag !== -1 ? args[flag + 1] : args[pkgIndex];
    return spec ? { ecosystem: 'npm', ...splitNpmSpec(spec) } : null;
  }
  if (cmd === 'uvx') {
    const from = args.indexOf('--from');
    const spec = from !== -1 ? args[from + 1] : args.find((a) => !a.startsWith('-'));
    if (!spec) return null;
    const m = /^([A-Za-z0-9._-]+)(?:\[[^\]]*\])?(?:(?:==|@)([^\s]+))?$/.exec(spec);
    return m ? { ecosystem: 'pypi', name: m[1]!, version: m[2] ?? null } : null;
  }
  return null;
}

/**
 * Default resolver: npm packages through `npm view` (honours the user's npm registry config),
 * PyPI packages through the PyPI JSON API. An existing package with a missing version prints
 * nothing from `npm view`, which counts as not found.
 */
export function defaultPackageResolver(pypiUrl: string, timeoutMs: number): PackageResolver {
  return async (spec) => {
    const label = `${spec.name}${spec.version ? `@${spec.version}` : ''}`;
    if (spec.ecosystem === 'npm') {
      return new Promise((resolve) => {
        execFile(
          'npm',
          ['view', label, 'version', '--json'],
          { timeout: timeoutMs, encoding: 'utf8' },
          (error, stdout, stderr) => {
            if (!error && stdout.trim() !== '') return resolve({ ok: true });
            const detail = /E404|404/.test(`${stderr}${error?.message ?? ''}`)
              ? 'package not found in the npm registry'
              : error
                ? (stderr.trim().split('\n').at(-1) ?? error.message)
                : 'version not published';
            resolve({ ok: false, error: `${label}: ${detail}` });
          },
        );
      });
    }
    const url = `${pypiUrl}/pypi/${encodeURIComponent(spec.name)}${spec.version ? `/${encodeURIComponent(spec.version)}` : ''}/json`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok ? { ok: true } : { ok: false, error: `${label}: PyPI answered ${res.status}` };
    } catch (error) {
      return {
        ok: false,
        error: `${label}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}

const VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Variables referenced as ${VAR} (without a default) anywhere in a server entry. */
export function referencedVars(entry: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(VAR_REF)) {
        if (m[2] === undefined) found.add(m[1]!);
      }
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(walk);
    }
  };
  walk(entry);
  return [...found].sort();
}

/** Expands ${VAR} and ${VAR:-default} the way Claude Code does for .mcp.json. */
export function expand(value: string, env: Record<string, string | undefined>): string {
  return value.replace(
    VAR_REF,
    (_m, name: string, fallback: string | undefined) => env[name] ?? fallback ?? '',
  );
}

type ServerEntry = {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};

async function listTools(
  name: string,
  entry: ServerEntry,
  cwd: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<string[]> {
  const client = new Client({ name: 'setup-agent-verify', version: '0.0.0' });
  try {
    if (entry.command) {
      const childEnv: Record<string, string> = { ...getDefaultEnvironment() };
      for (const [k, v] of Object.entries(entry.env ?? {})) childEnv[k] = expand(v, env);
      const transport = new StdioClientTransport({
        command: entry.command,
        args: (entry.args ?? []).map((a) => expand(a, env)),
        env: childEnv,
        cwd,
        stderr: 'ignore',
      });
      await client.connect(transport, { timeout: timeoutMs });
    } else if (entry.url) {
      const headers = Object.fromEntries(
        Object.entries(entry.headers ?? {}).map(([k, v]) => [k, expand(v, env)]),
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL(expand(entry.url, env)), {
          requestInit: { headers },
        }),
        { timeout: timeoutMs },
      );
    } else {
      throw new Error(`${name} has neither a command nor a url`);
    }
    const tools: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
      tools.push(...page.tools.map((t) => t.name));
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Checks the project's setup (FR-V1): settings parse; then, for every server, all checks run and
 * every failure is reported together: the pinned package version resolves, required env vars are
 * present (names only, values never read out), the server starts and lists its tools (a local
 * server missing variables is started with placeholder values, which is safe because nothing
 * real is sent; a remote one is not started); finally duplicate tool names. Runs the user's own
 * approved config on their machine, like Claude Code does.
 */
export async function verifySetup(
  root: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
  resolvePackage: PackageResolver = defaultPackageResolver('https://pypi.org', timeoutMs),
): Promise<VerifyResult[]> {
  const results: VerifyResult[] = [];
  const settings = await readText(join(root, '.claude', 'settings.json'));
  if (settings !== null) {
    try {
      JSON.parse(settings);
      results.push({ item: '.claude/settings.json', check: 'settings_parse', status: 'pass' });
    } catch (error) {
      results.push({
        item: '.claude/settings.json',
        check: 'settings_parse',
        status: 'fail',
        error: (error as Error).message,
        fix: 'Fix the JSON syntax in .claude/settings.json.',
      });
    }
  }
  const raw = await readText(join(root, '.mcp.json'));
  if (raw === null) return results;
  let servers: Record<string, ServerEntry>;
  try {
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, ServerEntry> };
    servers = parsed.mcpServers ?? {};
    results.push({ item: '.mcp.json', check: 'settings_parse', status: 'pass' });
  } catch (error) {
    results.push({
      item: '.mcp.json',
      check: 'settings_parse',
      status: 'fail',
      error: (error as Error).message,
      fix: 'Fix the JSON syntax in .mcp.json.',
    });
    return results;
  }

  const toolOwners = new Map<string, string[]>();
  for (const [name, entry] of Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))) {
    const spec = entry.command ? packageSpecOf(entry) : null;
    if (spec) {
      const resolved = spec.version
        ? await resolvePackage(spec)
        : ({ ok: false, error: `${spec.name} has no pinned version` } as const);
      results.push(
        resolved.ok
          ? { item: name, check: 'package_resolves', status: 'pass' }
          : {
              item: name,
              check: 'package_resolves',
              status: 'fail',
              error: resolved.error.slice(0, 300),
              fix: `Pin a published version of ${spec.name} in .mcp.json (check it with ${spec.ecosystem === 'npm' ? `npm view ${spec.name} versions` : `the PyPI page for ${spec.name}`}), or remove the server.`,
            },
      );
    }
    const missing = referencedVars(entry).filter((v) => !env[v]);
    if (missing.length > 0) {
      results.push({
        item: name,
        check: 'env_present',
        status: 'fail',
        error: `missing ${missing.join(', ')}`,
        fix: `Set ${missing.join(', ')} in your shell environment (never in .mcp.json), then restart Claude Code.`,
      });
    } else if (referencedVars(entry).length > 0)
      results.push({ item: name, check: 'env_present', status: 'pass' });
    if (missing.length > 0 && !entry.command) {
      results.push({
        item: name,
        check: 'server_starts',
        status: 'fail',
        error: `not started: the remote server needs ${missing.join(', ')}`,
        fix: `Set ${missing.join(', ')}, restart Claude Code and run verify again.`,
      });
      continue;
    }
    const runEnv = { ...env, ...Object.fromEntries(missing.map((v) => [v, PLACEHOLDER_VALUE])) };
    try {
      const tools = await listTools(name, entry, root, runEnv, timeoutMs);
      results.push({
        item: name,
        check: 'server_starts',
        status: 'pass',
        ...(missing.length > 0
          ? {
              note: `started with placeholder values for ${missing.join(', ')}; real calls need the real values`,
            }
          : {}),
      });
      for (const t of tools) toolOwners.set(t, [...(toolOwners.get(t) ?? []), name]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        item: name,
        check: 'server_starts',
        status: 'fail',
        error: message.slice(0, 300),
        fix: entry.command
          ? `Check that "${entry.command}" is installed and the package version exists; run the command from .mcp.json in a terminal to see its error. Or remove the server.`
          : 'Check the URL and any required headers or credentials. Or remove the server.',
      });
    }
  }
  for (const [tool, owners] of [...toolOwners].sort(([a], [b]) => a.localeCompare(b))) {
    if (owners.length > 1) {
      results.push({
        item: owners.join(', '),
        check: 'duplicate_tools',
        status: 'fail',
        error: `tool "${tool}" is provided by ${owners.join(' and ')}`,
        fix: 'Keep one of these servers; duplicate tool names confuse the model.',
      });
    }
  }
  return results;
}
