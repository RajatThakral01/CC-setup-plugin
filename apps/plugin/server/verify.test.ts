import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLEAN_TOOLS, fixtureServerScript } from '../../../test/fixtures/mcp/server-template.js';
import { expand, referencedVars, verifySetup } from './verify.js';

async function project(mcp: unknown, settings?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ccsa-verify-'));
  await writeFile(join(root, 'server.cjs'), fixtureServerScript(CLEAN_TOOLS));
  await writeFile(join(root, '.mcp.json'), JSON.stringify(mcp));
  if (settings !== undefined) {
    await mkdir(join(root, '.claude'));
    await writeFile(join(root, '.claude', 'settings.json'), settings);
  }
  return root;
}

describe('verifySetup', () => {
  it('passes a working server with its env var present', async () => {
    const root = await project(
      {
        mcpServers: {
          good: {
            command: process.execPath,
            args: ['server.cjs'],
            env: { TOKEN: '${EXAMPLE_TOKEN}' },
          },
        },
      },
      '{}',
    );
    const results = await verifySetup(root, { EXAMPLE_TOKEN: 'set' }, 10_000);
    expect(results).toEqual([
      { item: '.claude/settings.json', check: 'settings_parse', status: 'pass' },
      { item: '.mcp.json', check: 'settings_parse', status: 'pass' },
      { item: 'good', check: 'env_present', status: 'pass' },
      { item: 'good', check: 'server_starts', status: 'pass' },
    ]);
  });

  it('reports a deliberately broken server with a fix', async () => {
    const root = await project({
      mcpServers: { broken: { command: process.execPath, args: ['does-not-exist.cjs'] } },
    });
    const results = await verifySetup(root, {}, 5_000);
    expect(results.find((r) => r.item === 'broken')).toMatchObject({
      check: 'server_starts',
      status: 'fail',
      fix: expect.stringContaining('run the command'),
    });
  });

  it('reports missing env vars by name only and skips starting the server', async () => {
    const root = await project({
      mcpServers: {
        needs: {
          command: process.execPath,
          args: ['server.cjs'],
          env: { K: '${EXAMPLE_MISSING}', D: '${EXAMPLE_DEFAULTED:-x}' },
        },
      },
    });
    const results = await verifySetup(root, { EXAMPLE_SECRET_VALUE: 'never-printed' }, 5_000);
    expect(results.filter((r) => r.item === 'needs')).toEqual([
      expect.objectContaining({
        check: 'env_present',
        status: 'fail',
        error: 'missing EXAMPLE_MISSING',
      }),
    ]);
    expect(JSON.stringify(results)).not.toContain('never-printed');
  });

  it('detects duplicate tool names and bad settings JSON', async () => {
    const entry = { command: process.execPath, args: ['server.cjs'] };
    const root = await project({ mcpServers: { a: entry, b: entry } }, '{ bad');
    const results = await verifySetup(root, {}, 10_000);
    expect(results).toContainEqual(
      expect.objectContaining({
        check: 'settings_parse',
        status: 'fail',
        item: '.claude/settings.json',
      }),
    );
    expect(results).toContainEqual(
      expect.objectContaining({ check: 'duplicate_tools', status: 'fail', item: 'a, b' }),
    );
  });
});

describe('env helpers', () => {
  it('finds required variables and expands defaults like Claude Code', () => {
    expect(referencedVars({ env: { A: '${X}', B: '${Y:-d}' }, args: ['--t=${Z}'] })).toEqual([
      'X',
      'Z',
    ]);
    expect(expand('${X}-${Y:-d}', { X: '1' })).toBe('1-d');
  });
});
