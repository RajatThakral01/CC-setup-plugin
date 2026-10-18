import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHttpClient, createLogger } from '@cc-setup-agent/core';
import { catalogItems, eq, rawSourceRecords, statusEvents } from '@cc-setup-agent/db';
import { createTestDatabase, type TestDatabase } from '@cc-setup-agent/db/testing';
import { createFakeFetch, json, type Route } from '../../../../test/support/fake-fetch.js';
import { fakePackument, fakeRepo } from '../../../../test/fixtures/sources/github.js';
import { createGithubClient } from '../sources/github.js';
import { createNpmClient } from '../sources/npm.js';
import { importSeed } from './import.js';
import type { SeedEntry } from './seed-file.js';

const GH = 'https://api.github.com';
const NPM = 'https://registry.npmjs.org';

const routes: Record<string, Route> = {
  [`${GH}/repos/example-org/example-mcp-alpha`]: json(fakeRepo('example-org/example-mcp-alpha')),
  // Renamed repo: old name resolves to the new canonical name.
  [`${GH}/repos/example-org/example-old-name`]: json(fakeRepo('example-org/example-new-name')),
  [`${GH}/repos/example-org/example-new-name`]: json(fakeRepo('example-org/example-new-name')),
  [`${GH}/repos/example-org/example-archived`]: json(
    fakeRepo('example-org/example-archived', { archived: true }),
  ),
  [`${GH}/repos/example-org/example-plugins`]: json(fakeRepo('example-org/example-plugins')),
  [`${GH}/repos/example-org/example-plugins/contents/plugins/alpha?ref=main`]: json([
    { name: 'README.md', path: 'plugins/alpha/README.md', type: 'file' },
  ]),
  [`${GH}/repos/example-org/example-flaky`]: () => new Response('', { status: 500 }),
  [`${NPM}/example-mcp-npm`]: json(
    fakePackument('example-mcp-npm', {
      repository: 'git+https://github.com/example-org/example-mcp-alpha.git',
    }),
  ),
  [`${NPM}/@example%2Fmcp-scoped`]: json(fakePackument('@example/mcp-scoped')),
  [`${NPM}/example-deprecated`]: json(
    fakePackument('example-deprecated', { deprecated: 'use something else' }),
  ),
  [`${NPM}/example-npm-archived-repo`]: json(
    fakePackument('example-npm-archived-repo', {
      repository: 'https://github.com/example-org/example-archived',
    }),
  ),
};

const entries: SeedEntry[] = [
  {
    source_url: 'https://github.com/example-org/example-mcp-alpha',
    kind: 'mcp_server',
    category: 'browser_testing',
    note: 'fake alpha',
  },
  { source_url: 'https://github.com/example-org/example-old-name' },
  { source_url: 'https://github.com/example-org/example-new-name' },
  { source_url: 'https://github.com/example-org/example-archived' },
  { source_url: 'https://github.com/example-org/example-missing' },
  {
    source_url: 'https://github.com/example-org/example-plugins/tree/main/plugins/alpha',
    kind: 'plugin',
  },
  { source_url: 'https://github.com/example-org/example-plugins/tree/main/plugins/missing' },
  { source_url: 'https://www.npmjs.com/package/example-mcp-npm' },
  { source_url: 'https://www.npmjs.com/package/@example/mcp-scoped' },
  { source_url: 'https://www.npmjs.com/package/example-deprecated' },
  { source_url: 'https://www.npmjs.com/package/example-npm-archived-repo' },
  { source_url: 'https://www.npmjs.com/package/example-npm-missing' },
  { source_url: 'https://github.com/example-org/example-flaky' },
  { source_url: 'https://gitlab.com/example-org/elsewhere' },
];

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.cleanup();
});

function deps() {
  const { fetch } = createFakeFetch(routes);
  const http = createHttpClient({
    maxRetries: 1,
    baseDelayMs: 1,
    maxDelayMs: 1,
    timeoutMs: 1000,
    hostRateLimits: {},
    fetch,
    sleep: async () => undefined,
  });
  return {
    db: t.db,
    github: createGithubClient(http, 'test-token', GH),
    npm: createNpmClient(http, NPM),
    logger: createLogger({ level: 'silent' }),
  };
}

describe('importSeed', () => {
  let first: Awaited<ReturnType<typeof importSeed>>;
  beforeEach(async () => {
    first ??= await importSeed(deps(), entries);
  });

  it('creates candidates for resolvable, live sources', () => {
    expect(first.created.map((c) => c.id).sort()).toEqual([
      'example-mcp-npm',
      'example-mcp-scoped',
      'example-org-example-mcp-alpha',
      'example-org-example-new-name',
      'example-org-example-plugins-alpha',
    ]);
  });

  it('stores canonical source URLs from the API response', () => {
    const urls = Object.fromEntries(first.created.map((c) => [c.url, c.sourceUrl]));
    expect(urls['https://github.com/example-org/example-old-name']).toBe(
      'https://github.com/example-org/example-new-name',
    );
    expect(urls['https://github.com/example-org/example-plugins/tree/main/plugins/alpha']).toBe(
      'https://github.com/example-org/example-plugins/tree/main/plugins/alpha',
    );
    expect(urls['https://www.npmjs.com/package/@example/mcp-scoped']).toBe(
      'https://www.npmjs.com/package/@example/mcp-scoped',
    );
  });

  it('skips 404s, archived repos, deprecated packages and duplicates with reasons', () => {
    const skipped = Object.fromEntries(first.skipped.map((s) => [s.url, s.reason]));
    expect(skipped).toEqual({
      'https://github.com/example-org/example-new-name': 'duplicate',
      'https://github.com/example-org/example-archived': 'archived',
      'https://github.com/example-org/example-missing': 'not_found',
      'https://github.com/example-org/example-plugins/tree/main/plugins/missing': 'not_found',
      'https://www.npmjs.com/package/example-deprecated': 'deprecated',
      'https://www.npmjs.com/package/example-npm-archived-repo': 'archived',
      'https://www.npmjs.com/package/example-npm-missing': 'not_found',
    });
  });

  it('reports failures without stopping the run', () => {
    expect(first.failed.map((f) => f.url)).toEqual([
      'https://github.com/example-org/example-flaky',
      'https://gitlab.com/example-org/elsewhere',
    ]);
    expect(first.failed[1]?.reason).toMatch(/unsupported URL/);
  });

  it('writes items as candidates with seed hints, raw records and audit events', async () => {
    const [alpha] = await t.db
      .select()
      .from(catalogItems)
      .where(eq(catalogItems.id, 'example-org-example-mcp-alpha'));
    expect(alpha).toMatchObject({
      status: 'candidate',
      kind: 'mcp_server',
      category: 'browser_testing',
      publisher: 'example-org',
      classificationState: 'pending',
    });
    const raws = await t.db
      .select()
      .from(rawSourceRecords)
      .where(eq(rawSourceRecords.itemId, 'example-org-example-mcp-alpha'));
    expect(raws).toHaveLength(1);
    const npmItem = (
      await t.db.select().from(catalogItems).where(eq(catalogItems.id, 'example-mcp-scoped'))
    )[0];
    expect(npmItem).toMatchObject({ packageName: '@example/mcp-scoped', publisher: 'example' });
    const events = await t.db
      .select()
      .from(statusEvents)
      .where(eq(statusEvents.itemId, 'example-org-example-mcp-alpha'));
    expect(events).toEqual([
      expect.objectContaining({
        fromStatus: null,
        toStatus: 'candidate',
        reason: 'seed import: fake alpha',
      }),
    ]);
  });

  it('creates no duplicates on a second run', async () => {
    const before = await t.db.select().from(catalogItems);
    const second = await importSeed(deps(), entries);
    expect(second.created).toEqual([]);
    expect(second.skipped.filter((s) => s.reason === 'duplicate')).toHaveLength(6);
    const after = await t.db.select().from(catalogItems);
    expect(after).toHaveLength(before.length);
    const rawCount = (await t.db.select().from(rawSourceRecords)).length;
    await importSeed(deps(), entries);
    expect((await t.db.select().from(rawSourceRecords)).length).toBe(rawCount);
  });
});
