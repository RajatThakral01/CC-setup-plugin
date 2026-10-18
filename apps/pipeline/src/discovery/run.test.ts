import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, parseConfig } from '@cc-setup-agent/core';
import { claudeCodeChanges, rawSourceRecords, sourceRuns } from '@cc-setup-agent/db';
import { createTestDatabase, type TestDatabase } from '@cc-setup-agent/db/testing';
import { graphqlRoute, json, text } from '../../../../test/support/fake-fetch.js';
import { fakeHttp } from '../../../../test/support/http.js';
import { gqlRepo } from '../../../../test/fixtures/sources/graphql.js';
import { createGithubClient } from '../sources/github.js';
import { runSources, sinceFor } from './run.js';

const GH = 'https://api.github.test';
const RAW = 'https://raw.example.test';
const REG = 'https://registry.example.test/v0.1';
const fixture = (name: string) =>
  readFileSync(new URL(`../../../../test/fixtures/sources/${name}`, import.meta.url), 'utf8');
const now = new Date('2026-10-19T02:00:00.000Z');

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.cleanup();
});

describe('runSources', () => {
  it('records each source run and keeps going when one source fails (NFR-4)', async () => {
    const config = parseConfig({
      GITHUB_API_URL: GH,
      GITHUB_RAW_URL: RAW,
      MCP_REGISTRY_URL: REG,
      CLAUDE_CODE_REPO: 'example-org/example-cli',
      DISCOVERY_LOOKBACK_DAYS: '7',
    });
    const registryUrl = `${REG}/servers?updated_since=2026-10-12T02%3A00%3A00.000Z&limit=100&version=latest`;
    const marketplaceUrl =
      'https://raw.githubusercontent.com/example-org/broken/main/.claude-plugin/marketplace.json';
    const { http } = fakeHttp({
      [`${RAW}/example-org/example-cli/main/CHANGELOG.md`]: text(fixture('changelog.md')),
      [`${GH}/repos/example-org/example-cli/releases?per_page=30`]: json([]),
      [registryUrl]: text(fixture('registry-page.json')),
      [`${GH}/graphql`]: graphqlRoute({
        'example-org/example-mcp-alpha': gqlRepo('example-org/example-mcp-alpha'),
      }),
      [marketplaceUrl]: () => new Response('', { status: 503 }),
    });
    const deps = {
      db: t.db,
      http,
      github: createGithubClient(http, 'test-token', GH),
      config,
      logger: createLogger({ level: 'silent' }),
      sources: { marketplaces: [{ url: marketplaceUrl }] },
    };
    const results = await runSources(deps, ['changelog', 'marketplaces', 'registry'], now);
    expect(results).toEqual([
      { source: 'changelog', ok: true, records: 3 },
      expect.objectContaining({
        source: 'marketplaces',
        ok: false,
        records: 0,
        error: expect.stringMatching(/all marketplaces failed/),
      }),
      { source: 'registry', ok: true, records: 3 },
    ]);
    const runs = await t.db.select().from(sourceRuns);
    expect(runs.map((r) => [r.source, r.status])).toEqual([
      ['changelog', 'ok'],
      ['marketplaces', 'failed'],
      ['registry', 'ok'],
    ]);
    expect(await t.db.select().from(rawSourceRecords)).toHaveLength(3);
    const notes = await t.db.select().from(claudeCodeChanges);
    expect(notes.map((n) => [n.version, n.flags])).toEqual([
      ['9.9.3', ['mcp', 'settings']],
      ['9.9.2', ['plugins', 'hooks']],
      ['9.9.1', []],
    ]);

    // The next run starts from the last success (minus an hour); the failed source keeps the lookback.
    expect(
      (await sinceFor(t.db, 'registry', new Date('2026-10-20T02:00:00Z'), 7)).toISOString(),
    ).toBe('2026-10-19T01:00:00.000Z');
    expect(
      (await sinceFor(t.db, 'marketplaces', new Date('2026-10-20T02:00:00Z'), 7)).toISOString(),
    ).toBe('2026-10-13T02:00:00.000Z');

    // A second run upserts instead of duplicating.
    await runSources(deps, ['changelog', 'registry'], new Date('2026-10-19T03:00:00Z'));
    expect(await t.db.select().from(rawSourceRecords)).toHaveLength(3);
    expect(await t.db.select().from(claudeCodeChanges)).toHaveLength(3);
  });
});
