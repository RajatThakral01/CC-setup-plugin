import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLEAN_TOOLS, fixtureServerScript } from '../../../test/fixtures/mcp/server-template.js';
import {
  expand,
  packageSpecOf,
  referencedVars,
  verifySetup,
  type PackageResolver,
  type PackageSpec,
} from './verify.js';

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

  it('runs every check for a server and reports all failures together', async () => {
    // The owner's acceptance case: a version that doesn't exist and a missing API key.
    const root = await project({});
    const fakeNpx = join(root, 'npx');
    await writeFile(
      fakeNpx,
      `#!/bin/sh\nexec "${process.execPath}" "${join(root, 'server.cjs')}"\n`,
    );
    await chmod(fakeNpx, 0o755);
    await writeFile(
      join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          docs: {
            command: fakeNpx,
            args: ['-y', '@example/docs-mcp@0.0.0-does-not-exist'],
            env: { API_KEY: '${EXAMPLE_DOCS_KEY}' },
          },
        },
      }),
    );
    const asked: PackageSpec[] = [];
    const resolver: PackageResolver = async (spec) => {
      asked.push(spec);
      return { ok: false, error: `${spec.name}@${spec.version}: version not published` };
    };
    const results = (await verifySetup(root, {}, 10_000, resolver)).filter(
      (r) => r.item === 'docs',
    );
    expect(asked).toEqual([
      { ecosystem: 'npm', name: '@example/docs-mcp', version: '0.0.0-does-not-exist' },
    ]);
    expect(results.map((r) => [r.check, r.status])).toEqual([
      ['package_resolves', 'fail'],
      ['env_present', 'fail'],
      ['server_starts', 'pass'],
    ]);
    expect(results[0]?.fix).toContain('npm view @example/docs-mcp versions');
    expect(results[2]?.note).toContain('placeholder values for EXAMPLE_DOCS_KEY');
  });

  it('does not start a remote server that is missing its credentials', async () => {
    const root = await project({
      mcpServers: {
        remote: {
          type: 'http',
          url: 'https://mcp.example.invalid/mcp',
          headers: { Authorization: 'Bearer ${EXAMPLE_REMOTE_TOKEN}' },
        },
      },
    });
    const results = await verifySetup(root, {}, 5_000, async () => ({ ok: true }));
    expect(results.filter((r) => r.item === 'remote').map((r) => [r.check, r.status])).toEqual([
      ['env_present', 'fail'],
      ['server_starts', 'fail'],
    ]);
  });

  it('reports missing env vars by name only and still starts the local server', async () => {
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
      expect.objectContaining({ check: 'server_starts', status: 'pass' }),
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

describe('packageSpecOf', () => {
  it('reads pinned npx and uvx packages', () => {
    expect(packageSpecOf({ command: 'npx', args: ['-y', '@example/a@1.2.3'] })).toEqual({
      ecosystem: 'npm',
      name: '@example/a',
      version: '1.2.3',
    });
    expect(packageSpecOf({ command: 'npx', args: ['-y', 'example-b'] })).toEqual({
      ecosystem: 'npm',
      name: 'example-b',
      version: null,
    });
    expect(
      packageSpecOf({ command: 'uvx', args: ['--from', 'example-c==0.4.0', 'example-c'] }),
    ).toEqual({ ecosystem: 'pypi', name: 'example-c', version: '0.4.0' });
    expect(packageSpecOf({ command: process.execPath, args: ['server.cjs'] })).toBeNull();
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
