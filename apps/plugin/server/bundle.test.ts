import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { fixtureSnapshot, writeSignedCatalog } from '../../../test/fixtures/plugin/catalog.js';

const pluginDir = fileURLToPath(new URL('..', import.meta.url));
const bundle = join(pluginDir, 'dist', 'server.js');

beforeAll(() => {
  execFileSync(process.execPath, ['build.mjs'], { cwd: pluginDir, stdio: 'pipe' });
}, 60_000);

describe('bundled plugin server (stdio, as Claude Code runs it)', () => {
  it('contains no database or pipeline code', async () => {
    const code = await readFile(bundle, 'utf8');
    // Markers of the libraries' own code (package names alone appear in the detection lists).
    expect(code).not.toMatch(/drizzle-orm\/|pgTable\(|pg-boss|anthropic-version|pg-protocol/);
  });

  it('starts over stdio, lists its tools and answers calls', async () => {
    const catalog = await writeSignedCatalog(fixtureSnapshot());
    const client = new Client({ name: 'bundle-test', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [bundle],
        env: {
          PATH: process.env['PATH'] ?? '',
          PLUGIN_DATA_DIR: await mkdtemp(join(tmpdir(), 'ccsa-data-')),
          CC_SETUP_AGENT_CATALOG_URL: catalog.url,
        },
        stderr: 'ignore',
      }),
    );
    try {
      expect((await client.listTools()).tools).toHaveLength(9);
      // The fixture catalog is signed with a throwaway key, so the embedded production key must reject it.
      const sync = (await client.callTool({ name: 'sync_catalog', arguments: {} })) as {
        content: Array<{ text: string }>;
      };
      expect(JSON.parse(sync.content[0]!.text)).toMatchObject({
        catalogVersion: 'none',
        warning: expect.stringMatching(/signature is invalid/),
      });
      const fixture = fileURLToPath(
        new URL('../../../test/fixtures/projects/next-fresh', import.meta.url),
      );
      const analyzed = (await client.callTool({
        name: 'analyze_project',
        arguments: { path: fixture },
      })) as { content: Array<{ text: string }> };
      expect(JSON.parse(analyzed.content[0]!.text)).toMatchObject({ profile: { isNextjs: true } });
    } finally {
      await client.close();
    }
  }, 30_000);
});
