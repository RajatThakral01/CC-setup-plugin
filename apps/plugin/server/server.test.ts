import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { fixtureSnapshot, writeSignedCatalog } from '../../../test/fixtures/plugin/catalog.js';
import { createServer } from './index.js';
import { settingsFromEnv } from './settings.js';

async function connect(
  catalogUrl: string | undefined,
  publicKeyPem: string,
  claudeCodeVersion: string | null = '2.1.303',
) {
  const settings = {
    ...settingsFromEnv({}),
    dataDir: await mkdtemp(join(tmpdir(), 'ccsa-data-')),
    catalogUrl,
    publicKeyPem,
  };
  const server = createServer(settings, {}, { claudeCodeVersion: async () => claudeCodeVersion });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    return {
      isError: r.isError === true,
      text: r.content[0]!.text,
      json: () => JSON.parse(r.content[0]!.text) as Record<string, unknown>,
    };
  };
  return { client, call };
}

async function copyFixture(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `ccsa-${name}-`));
  await cp(
    fileURLToPath(new URL(`../../../test/fixtures/projects/${name}`, import.meta.url)),
    dir,
    { recursive: true },
  );
  return dir;
}

describe('plugin MCP server', () => {
  it('exposes the nine tools within the 2,000-token budget (NFR-2)', async () => {
    const { client } = await connect(undefined, 'unused');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'analyze_project',
      'backup_setup',
      'check_updates',
      'explain_item',
      'generate_config',
      'recommend_setup',
      'rollback_setup',
      'sync_catalog',
      'verify_setup',
    ]);
    expect(Math.ceil(JSON.stringify(tools).length / 4)).toBeLessThan(2000);
  });

  it('runs the core journey on a fresh project', async () => {
    const c = await writeSignedCatalog(fixtureSnapshot());
    const { call } = await connect(c.url, c.publicKeyPem);
    const root = await copyFixture('next-fresh');

    const sync = (await call('sync_catalog')).json();
    expect(sync).toMatchObject({ catalogVersion: '2026.10.19-1', updated: true, itemCount: 13 });

    const analyzed = (await call('analyze_project', { path: root })).json() as {
      catalogVersion: string;
      profile: unknown;
      warnings: string[];
    };
    expect(analyzed.catalogVersion).toBe('2026.10.19-1');
    expect(analyzed.warnings).toEqual([]);

    const answers = {
      goal: 'marketing site',
      deployTarget: 'vercel',
      budgetSensitivity: 'medium',
      riskTolerance: 'medium',
      workflow: 'standard',
    };
    const rec = (await call('recommend_setup', { profile: analyzed.profile, answers })).json() as {
      items: Array<{ id: string }>;
    };
    const again = (await call('recommend_setup', { profile: analyzed.profile, answers })).text;
    expect(JSON.stringify(rec, null, 2)).toBe(again);
    const ids = rec.items.map((i) => i.id);
    expect(ids).toContain('example-docs-mcp');

    const backup = (await call('backup_setup', { path: root })).json() as {
      backupId: string;
      files: string[];
    };
    expect(backup.files).toEqual([]);
    const generated = (await call('generate_config', { path: root, approvedIds: ids })).json() as {
      files: Array<{ path: string; content: string }>;
      catalogVersion: string;
    };
    expect(generated.catalogVersion).toBe('2026.10.19-1');
    for (const f of generated.files) {
      await mkdir(dirname(join(root, f.path)), { recursive: true });
      await writeFile(join(root, f.path), f.content);
    }
    const explained = (await call('explain_item', { id: 'example-docs-mcp' })).json() as {
      alternatives: Array<{ id: string }>;
    };
    expect(explained.alternatives.map((a) => a.id)).toEqual(['example-docs-alt']);

    const updates = (await call('check_updates', { path: root })).json() as { notices: unknown[] };
    expect(updates.notices).toEqual([]);

    const rolled = (await call('rollback_setup', { path: root })).json() as {
      backupId: string;
      removed: string[];
    };
    expect(rolled.backupId).toBe(backup.backupId);
    expect(rolled.removed.sort()).toEqual(['.claude/settings.json', '.mcp.json', 'CLAUDE.md']);
  });

  it('warns about an installed blocked item on the next run', async () => {
    const c = await writeSignedCatalog(fixtureSnapshot());
    const { call } = await connect(c.url, c.publicKeyPem);
    await call('sync_catalog');
    const root = await copyFixture('next-blocked');
    const analyzed = (await call('analyze_project', { path: root })).json() as {
      warnings: string[];
    };
    expect(analyzed.warnings).toEqual([expect.stringMatching(/example-blocked-mcp is BLOCKED/)]);
    const updates = (await call('check_updates', { path: root })).json() as {
      notices: Array<{ type: string }>;
    };
    expect(updates.notices[0]?.type).toBe('blocked');
  });

  it('refuses to generate config for unsupported Claude Code versions (NFR-9)', async () => {
    const c = await writeSignedCatalog(fixtureSnapshot());
    const root = await copyFixture('next-fresh');
    for (const [version, message] of [
      ['1.0.128', /too old/],
      ['2.2.0', /newer than setup-agent has been verified against/],
      [null, /Couldn't detect the Claude Code version/],
    ] as const) {
      const { call } = await connect(c.url, c.publicKeyPem, version);
      await call('sync_catalog');
      const r = await call('generate_config', { path: root, approvedIds: ['example-docs-mcp'] });
      expect(r).toMatchObject({ isError: true, text: expect.stringMatching(message) });
      expect(r.text).toContain('no config was generated');
    }
    const { call } = await connect(c.url, c.publicKeyPem, '2.0.14 (Claude Code)');
    await call('sync_catalog');
    const ok = await call('generate_config', { path: root, approvedIds: ['example-docs-mcp'] });
    expect(ok.json()['claudeCodeVersion']).toBe('2.0.14');
  });

  it('returns clear errors instead of throwing', async () => {
    const { call } = await connect(undefined, 'unused');
    expect(await call('recommend_setup', { profile: {}, answers: {} })).toMatchObject({
      isError: true,
    });
    const noCatalog = await call('explain_item', { id: 'x' });
    expect(noCatalog).toMatchObject({
      isError: true,
      text: 'No catalog yet. Call sync_catalog first.',
    });
    expect(await call('analyze_project', { path: 'relative/path' })).toMatchObject({
      isError: true,
      text: expect.stringMatching(/absolute path/),
    });
  });
});
