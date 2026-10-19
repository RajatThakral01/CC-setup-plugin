import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pluginDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const read = (p: string) => readFileSync(p, 'utf8');
const TOOLS = [
  'sync_catalog',
  'analyze_project',
  'recommend_setup',
  'explain_item',
  'backup_setup',
  'generate_config',
  'verify_setup',
  'check_updates',
  'rollback_setup',
];

describe('plugin packaging', () => {
  it('has a manifest, an MCP declaration pointing at the bundle, and a local marketplace entry', () => {
    const manifest = JSON.parse(read(join(pluginDir, '.claude-plugin', 'plugin.json'))) as {
      name: string;
      version: string;
    };
    expect(manifest).toMatchObject({ name: 'setup-agent' });
    const mcp = JSON.parse(read(join(pluginDir, '.mcp.json'))) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    expect(mcp.mcpServers['setup-agent']).toMatchObject({
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/dist/server.js'],
    });
    expect(mcp.mcpServers['setup-agent']?.env['PLUGIN_DATA_DIR']).toBe('${CLAUDE_PLUGIN_DATA}');
    expect(read(join(pluginDir, 'build.mjs'))).toContain("outfile: 'dist/server.js'");
    const market = JSON.parse(read(join(repoRoot, '.claude-plugin', 'marketplace.json'))) as {
      plugins: Array<{ name: string; source: string }>;
    };
    expect(market.plugins).toEqual([
      expect.objectContaining({ name: 'setup-agent', source: './apps/plugin' }),
    ]);
  });

  it('ships the four commands and the setup skill, all with descriptions', () => {
    const commands = readdirSync(join(pluginDir, 'commands')).sort();
    expect(commands).toEqual(['explain.md', 'setup-check.md', 'setup-rollback.md', 'setup.md']);
    for (const c of commands)
      expect(read(join(pluginDir, 'commands', c))).toMatch(/^---\ndescription: .+/);
    expect(read(join(pluginDir, 'skills', 'setup-guide', 'SKILL.md'))).toMatch(
      /^---\nname: setup-guide\ndescription: .+/,
    );
  });

  it('only refers to tools the server actually has', () => {
    const texts = [
      read(join(pluginDir, 'skills', 'setup-guide', 'SKILL.md')),
      ...readdirSync(join(pluginDir, 'commands')).map((c) => read(join(pluginDir, 'commands', c))),
    ];
    const mentioned = new Set(
      texts
        .flatMap((t) => [...t.matchAll(/`([a-z]+_[a-z_]+)`/g)].map((m) => m[1]!))
        .filter((n) => n.includes('_') && !n.startsWith('setup_agent')),
    );
    for (const name of mentioned) {
      if (/^[a-z]+_(project|setup|catalog|item|config|updates)$/.test(name))
        expect(TOOLS).toContain(name);
    }
    expect([...mentioned].filter((n) => TOOLS.includes(n)).length).toBeGreaterThanOrEqual(8);
  });

  it('tells the model never to handle secret values and to approve per item', () => {
    const skill = read(join(pluginDir, 'skills', 'setup-guide', 'SKILL.md'));
    expect(skill).toMatch(/Never ask for, read, print or write secret values/);
    expect(skill).toMatch(/Approval is per item/);
    expect(skill).toMatch(/backup_setup/);
  });
});
