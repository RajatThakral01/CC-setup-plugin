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
  check: 'server_starts' | 'env_present' | 'settings_parse' | 'duplicate_tools';
  status: 'pass' | 'fail';
  error?: string;
  fix?: string;
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
 * Checks the project's setup (FR-V1): settings parse, required env vars are present (names only,
 * values never read out), each configured MCP server starts and lists its tools, no duplicate tool
 * names. Runs the user's own approved config on their machine, like Claude Code does.
 */
export async function verifySetup(
  root: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
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
    const missing = referencedVars(entry).filter((v) => !env[v]);
    if (missing.length > 0) {
      results.push({
        item: name,
        check: 'env_present',
        status: 'fail',
        error: `missing ${missing.join(', ')}`,
        fix: `Set ${missing.join(', ')} in your shell environment (never in .mcp.json), then restart Claude Code.`,
      });
      continue;
    }
    if (referencedVars(entry).length > 0)
      results.push({ item: name, check: 'env_present', status: 'pass' });
    try {
      const tools = await listTools(name, entry, root, env, timeoutMs);
      results.push({ item: name, check: 'server_starts', status: 'pass' });
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
