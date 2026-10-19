import { cp, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fixtureSnapshot } from '../../../test/fixtures/plugin/catalog.js';
import {
  BLOCK_END,
  BLOCK_START,
  generateConfig,
  mergeClaudeMd,
  mergeMcpJson,
  mergeSettings,
} from './generate.js';

const snapshot = fixtureSnapshot();
async function copyFixture(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `ccsa-${name}-`));
  await cp(
    fileURLToPath(new URL(`../../../test/fixtures/projects/${name}`, import.meta.url)),
    dir,
    { recursive: true },
  );
  return dir;
}
const approved = [
  'example-docs-mcp',
  'example-git-mcp',
  'example-supabase-mcp',
  'example-vercel-mcp',
  'example-review-plugin',
  'example-vitest-skill',
];

describe('generateConfig', () => {
  it('creates config for a fresh project (snapshot of generated files)', async () => {
    const root = await copyFixture('next-fresh');
    const r = await generateConfig(root, snapshot, approved);
    expect(r.files.map((f) => [f.path, f.action])).toEqual([
      ['CLAUDE.md', 'create'],
      ['.mcp.json', 'create'],
      ['.claude/settings.json', 'create'],
    ]);
    expect(r.requiredEnvVars).toEqual(['EXAMPLE_GIT_TOKEN', 'EXAMPLE_SUPABASE_TOKEN']);
    expect(r.installCommands).toEqual([
      'claude plugin marketplace add example-org/example-plugins',
      'claude plugin install review@example-market',
      'Copy the skill folder from https://github.com/example-org/example-vitest-skill into .claude/skills/example-vitest-skill/',
    ]);
    for (const f of r.files) expect(f.content).toMatchSnapshot(f.path);
    const mcp = JSON.parse(r.files[1]!.content) as {
      mcpServers: Record<string, { args?: string[]; env?: Record<string, string> }>;
    };
    expect(mcp.mcpServers['example-supabase-mcp']).toEqual({
      command: 'npx',
      args: ['-y', '@example/supabase-mcp@2.0.0'],
      env: { EXAMPLE_SUPABASE_TOKEN: '${EXAMPLE_SUPABASE_TOKEN}' },
    });
    // Pinned versions, never latest; placeholders, never values.
    expect(r.files[1]!.content).not.toMatch(/@latest|"latest"/);
    expect(r.files[0]!.diff).toMatch(/^--- \/dev\/null\n\+\+\+ b\/CLAUDE.md/);
  });

  it('never changes content outside the managed block, and keeps unknown servers', async () => {
    const root = await copyFixture('next-existing');
    const before = await readFile(join(root, 'CLAUDE.md'), 'utf8');
    const r = await generateConfig(root, snapshot, ['example-docs-mcp']);
    const claude = r.files.find((f) => f.path === 'CLAUDE.md')!;
    expect(claude.action).toBe('update');
    expect(claude.content.startsWith(before)).toBe(true);
    expect(claude.content.slice(claude.content.indexOf(BLOCK_END) + BLOCK_END.length)).toBe('\n');
    const mcp = JSON.parse(r.files.find((f) => f.path === '.mcp.json')!.content) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(mcp.mcpServers)).toEqual(['example-unknown-server', 'example-docs-mcp']);
    expect(mcp.mcpServers['example-unknown-server']).toEqual({
      command: 'node',
      args: ['./tools/my-server.js'],
    });
  });

  it('refuses unknown or non-recommended items', async () => {
    const root = await copyFixture('next-fresh');
    await expect(generateConfig(root, snapshot, ['example-missing'])).rejects.toThrow(
      /not in the catalog/,
    );
    await expect(generateConfig(root, snapshot, ['example-blocked-mcp'])).rejects.toThrow(
      /not recommended/,
    );
  });
});

describe('merges', () => {
  it('replaces only the text between the markers on re-run', () => {
    const user = '# Notes\n\nkeep me\n';
    const once = mergeClaudeMd(user, `${BLOCK_START}\nv1\n${BLOCK_END}`);
    const twice = mergeClaudeMd(`${once}\nafter\n`, `${BLOCK_START}\nv2\n${BLOCK_END}`);
    expect(twice).toBe(`# Notes\n\nkeep me\n\n${BLOCK_START}\nv2\n${BLOCK_END}\n\nafter\n`);
  });

  it('keeps every existing settings key and unions server lists', () => {
    const existing = JSON.stringify({
      model: 'sonnet',
      permissions: { allow: ['Bash(pnpm test)'], deny: ['Read(./.env)'] },
      enabledMcpjsonServers: ['mine'],
    });
    const merged = JSON.parse(mergeSettings(existing, ['example-docs-mcp', 'mine'])) as Record<
      string,
      unknown
    >;
    expect(merged).toEqual({
      model: 'sonnet',
      permissions: { allow: ['Bash(pnpm test)'], deny: ['Read(./.env)'] },
      enabledMcpjsonServers: ['mine', 'example-docs-mcp'],
    });
  });

  it('never drops unknown .mcp.json servers (randomised property test)', () => {
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const name = () => `server-${Math.floor(rand() * 50)}`;
    for (let run = 0; run < 300; run++) {
      const existing: Record<string, unknown> = {};
      for (let i = 0; i < Math.floor(rand() * 6); i++)
        existing[name()] = { command: 'node', args: [String(rand())] };
      const ours: Record<string, Record<string, unknown>> = {};
      for (let i = 0; i < Math.floor(rand() * 4); i++)
        ours[`example-${Math.floor(rand() * 5)}`] = { command: 'npx', args: ['-y', 'x@1.0.0'] };
      const merged = JSON.parse(
        mergeMcpJson(JSON.stringify({ mcpServers: existing, other: true }), ours),
      ) as { mcpServers: Record<string, unknown>; other: boolean };
      for (const [k, v] of Object.entries(existing))
        if (!(k in ours)) expect(merged.mcpServers[k]).toEqual(v);
      for (const k of Object.keys(ours)) expect(merged.mcpServers[k]).toEqual(ours[k]);
      expect(merged.other).toBe(true);
    }
  });

  it('refuses invalid existing JSON instead of overwriting it', () => {
    expect(() => mergeMcpJson('{ nope', {})).toThrow(/not valid JSON/);
  });
});
