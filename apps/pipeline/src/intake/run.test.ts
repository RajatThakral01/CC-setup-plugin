import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLlmClient, createLogger, parseConfig, type MessagesApi } from '@cc-setup-agent/core';
import {
  catalogItems,
  createLedgerGuard,
  eq,
  insertCandidate,
  rawSourceRecords,
  signalSnapshots,
  statusEvents,
} from '@cc-setup-agent/db';
import { createTestDatabase, type TestDatabase } from '@cc-setup-agent/db/testing';
import { graphqlRoute } from '../../../../test/support/fake-fetch.js';
import { fakeHttp } from '../../../../test/support/http.js';
import { fakeRepo } from '../../../../test/fixtures/sources/github.js';
import { gqlRepo } from '../../../../test/fixtures/sources/graphql.js';
import { vendorsFromFile } from '../catalog-config.js';
import { storeRecords } from '../discovery/run.js';
import { createGithubClient, repoFactsFromRest, type RepoFacts } from '../sources/github.js';
import { createNpmClient } from '../sources/npm.js';
import type { RegistryPayload } from '../sources/registry.js';
import type { FetchedRecord } from '../sources/types.js';
import { runIntake } from './run.js';

const GH = 'https://api.github.test';
const vendors = vendorsFromFile({ github_orgs: ['example-vendor'], registry_namespaces: [] });
const logger = createLogger({ level: 'silent' });
const day1 = new Date('2026-10-19T03:00:00Z');
const day2 = new Date('2026-10-20T03:00:00Z');

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.cleanup();
});
beforeEach(async () => {
  await t.db.delete(signalSnapshots);
  await t.db.delete(rawSourceRecords);
  await t.db.delete(statusEvents);
  await t.db.delete(catalogItems);
});

function deps(graphqlRepos: Record<string, unknown> = {}) {
  const { http } = fakeHttp({ [`${GH}/graphql`]: graphqlRoute(graphqlRepos) });
  return { db: t.db, github: createGithubClient(http, 'test-token', GH), logger };
}

const options = (now: Date, dailyCap = 30) => ({
  vendors,
  minStars: 10,
  dailyCap,
  refreshLimit: 50,
  now,
});

function searchHit(fullName: string, overrides: Record<string, unknown> = {}): FetchedRecord {
  const repo = fakeRepo(fullName, overrides);
  return {
    source: 'github_repo',
    externalId: String(repo.id),
    payload: repo,
    repo: repoFactsFromRest(repo as never),
  };
}

function registryRecord(
  name: string,
  repo: RepoFacts | null,
  extra: Partial<RegistryPayload['entry']['server']> = {},
): FetchedRecord {
  const payload: RegistryPayload = {
    entry: {
      server: {
        name,
        description: `Fake ${name}`,
        ...(repo
          ? { repository: { url: `https://github.com/${repo.fullName}`, source: 'github' } }
          : {}),
        ...extra,
      },
      _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: true } },
    },
    repo,
  };
  return { source: 'mcp_registry', externalId: name, payload, repo };
}

const stateOf = async (externalId: string) =>
  (
    await t.db.select().from(rawSourceRecords).where(eq(rawSourceRecords.externalId, externalId))
  )[0];

describe('runIntake', () => {
  it('links records to existing items by URL (case-insensitive) or package name', async () => {
    await insertCandidate(
      t.db,
      {
        id: 'example-org-existing',
        name: 'existing',
        sourceUrl: 'https://github.com/Example-Org/Existing',
      },
      'system',
      'fixture',
    );
    await insertCandidate(
      t.db,
      {
        id: 'example-npm-item',
        name: '@example/pkg',
        sourceUrl: 'https://www.npmjs.com/package/@example/pkg',
        packageName: '@example/pkg',
      },
      'system',
      'fixture',
    );
    const hit = searchHit('example-org/existing');
    const reg = registryRecord(
      'test.example/pkg-server',
      repoFactsFromRest(fakeRepo('example-org/other-repo') as never),
      {
        packages: [{ registryType: 'npm', identifier: '@example/pkg' }],
      },
    );
    await storeRecords(t.db, [hit, reg], day1);
    const report = await runIntake(deps(), options(day1));
    expect(report.linked).toBe(2);
    expect(report.accepted).toEqual([]);
    expect(await stateOf(hit.externalId)).toMatchObject({
      intakeState: 'linked',
      itemId: 'example-org-existing',
    });
    expect(await stateOf('test.example/pkg-server')).toMatchObject({
      intakeState: 'linked',
      itemId: 'example-npm-item',
    });
    expect(await t.db.select().from(signalSnapshots)).toHaveLength(2);
  });

  it('filters records with reasons and accepts the rest as candidates', async () => {
    await storeRecords(
      t.db,
      [
        searchHit('example-org/good'),
        searchHit('example-org/forked', { fork: true }),
        searchHit('example-org/unlicensed', { license: null }),
        searchHit('example-org/tiny', { stargazers_count: 3 }),
        searchHit('example-vendor/tiny-official', { stargazers_count: 0 }),
        registryRecord('test.example/remote-only', null),
      ],
      day1,
    );
    const report = await runIntake(deps(), options(day1));
    expect(report.accepted.map((a) => a.id).sort()).toEqual([
      'example-org-good',
      'example-vendor-tiny-official',
    ]);
    expect(report.reasonCounts).toEqual({
      fork: 1,
      no_license: 1,
      stars_below_min: 1,
      no_repo_url: 1,
    });
    expect(await stateOf(searchHit('example-org/tiny').externalId)).toMatchObject({
      intakeState: 'filtered',
      intakeReasons: ['stars_below_min'],
    });
    const [item] = await t.db
      .select()
      .from(catalogItems)
      .where(eq(catalogItems.id, 'example-vendor-tiny-official'));
    expect(item).toMatchObject({ status: 'candidate', classificationState: 'pending' });
    const [event] = await t.db
      .select()
      .from(statusEvents)
      .where(eq(statusEvents.itemId, 'example-vendor-tiny-official'));
    expect(event?.reason).toBe('discovery intake: github_repo (vendor allowlist)');
  });

  it('caps new candidates per UTC day by priority, defers the rest, and takes them the next day', async () => {
    await storeRecords(
      t.db,
      [
        searchHit('example-org/popular', {
          stargazers_count: 900,
          created_at: '2025-01-01T00:00:00Z',
        }),
        searchHit('example-org/rising', {
          stargazers_count: 300,
          created_at: '2026-10-05T00:00:00Z',
        }),
        searchHit('example-vendor/official', { stargazers_count: 12 }),
      ],
      day1,
    );
    const first = await runIntake(deps(), options(day1, 2));
    // vendor first, then higher star velocity (rising: 300 stars in 2 weeks beats popular).
    expect(first.accepted.map((a) => a.id)).toEqual([
      'example-vendor-official',
      'example-org-rising',
    ]);
    expect(first.deferred).toBe(1);

    const sameDay = await runIntake(deps(), options(new Date('2026-10-19T20:00:00Z'), 2));
    expect(sameDay.accepted).toEqual([]);
    expect(sameDay.deferred).toBe(1);

    const nextDay = await runIntake(deps(), options(day2, 2));
    expect(nextDay.accepted.map((a) => a.id)).toEqual(['example-org-popular']);
    expect(await t.db.select().from(catalogItems)).toHaveLength(3);
  });

  it('creates one item when two sources describe the same repo, and is idempotent', async () => {
    const facts = repoFactsFromRest(fakeRepo('example-org/twin') as never);
    await storeRecords(
      t.db,
      [searchHit('example-org/twin'), registryRecord('test.example/twin', facts)],
      day1,
    );
    const first = await runIntake(deps(), options(day1));
    expect(first.accepted).toHaveLength(1);
    expect(first.linked).toBe(1);
    await storeRecords(
      t.db,
      [searchHit('example-org/twin'), registryRecord('test.example/twin', facts)],
      day2,
    );
    const second = await runIntake(deps(), options(day2));
    expect(second.accepted).toEqual([]);
    expect(await t.db.select().from(catalogItems)).toHaveLength(1);
  });

  it('re-checks star-filtered records and accepts them once they grow', async () => {
    const hit = searchHit('example-org/grower', { stargazers_count: 4 });
    await storeRecords(t.db, [hit], day1);
    expect((await runIntake(deps(), options(day1))).filtered).toBe(1);
    const report = await runIntake(
      deps({ 'example-org/grower': gqlRepo('example-org/grower', { stargazerCount: 25 }) }),
      options(day2),
    );
    expect(report.refreshed).toBe(1);
    expect(report.accepted.map((a) => a.id)).toEqual(['example-org-grower']);
    const row = await stateOf(hit.externalId);
    expect(row).toMatchObject({ stars: 25, intakeState: 'accepted' });
    expect(row?.starVelocity7d).toBeCloseTo(147, 0);
  });
});

describe('runIntake with pre-ranking classification', () => {
  function classifyDeps(byName: Record<string, { relevant: boolean; stacks: string[] }>) {
    const config = parseConfig({});
    const calls: string[] = [];
    const messages = {
      create: async (body: { messages: Array<{ content: string }> }) => {
        const name = /name: (.*)/.exec(body.messages[0]?.content ?? '')?.[1] ?? '';
        calls.push(name);
        const r = byName[name] ?? { relevant: true, stacks: ['nextjs'] };
        const out = {
          kind: 'mcp_server',
          category: 'docs',
          stacks: r.stacks,
          summary: 's',
          provenance_guess: 'community',
          relevant: r.relevant,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(out) }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 20 },
        };
      },
    } as unknown as MessagesApi;
    const llm = createLlmClient({ config, guard: createLedgerGuard(t.db, config), messages });
    const { http } = fakeHttp({});
    return {
      calls,
      classify: { llm, npm: createNpmClient(http, 'https://npm.example.test'), config },
    };
  }

  it('ranks Next.js-relevant records first and carries classification and scope into items', async () => {
    await storeRecords(
      t.db,
      [
        searchHit('example-vendor/kotlin-tool', { stargazers_count: 5000 }),
        searchHit('example-org/next-helper', { stargazers_count: 11 }),
        searchHit('example-org/any-tool', { stargazers_count: 20 }),
      ],
      day1,
    );
    const { calls, classify } = classifyDeps({
      'kotlin-tool': { relevant: true, stacks: [] },
      'next-helper': { relevant: true, stacks: ['nextjs'] },
      'any-tool': { relevant: true, stacks: ['any'] },
    });
    const report = await runIntake(
      { ...deps(), classify },
      { ...options(day1, 2), classifyDailyLimit: 300 },
    );
    expect(calls).toHaveLength(3);
    expect(report.recordsClassified).toBe(3);
    // Vendor + 5000 stars no longer beats relevance.
    expect(report.accepted.map((a) => a.id)).toEqual([
      'example-org-any-tool',
      'example-org-next-helper',
    ]);
    const [item] = await t.db
      .select()
      .from(catalogItems)
      .where(eq(catalogItems.id, 'example-org-next-helper'));
    expect(item).toMatchObject({
      classificationState: 'classified',
      category: 'docs',
      stacks: ['nextjs'],
      outOfScope: [],
    });

    const next = await runIntake(
      { ...deps(), classify },
      { ...options(day2, 2), classifyDailyLimit: 300 },
    );
    expect(calls).toHaveLength(3); // already classified records are not classified again
    expect(next.accepted.map((a) => a.id)).toEqual(['example-vendor-kotlin-tool']);
    const [kotlin] = await t.db
      .select()
      .from(catalogItems)
      .where(eq(catalogItems.id, 'example-vendor-kotlin-tool'));
    expect(kotlin?.outOfScope).toEqual(['nextjs']);
  });

  it('respects the daily classification limit', async () => {
    await storeRecords(
      t.db,
      [1, 2, 3, 4].map((i) => searchHit(`example-org/tool-${i}`)),
      day1,
    );
    const { calls, classify } = classifyDeps({});
    const report = await runIntake(
      { ...deps(), classify },
      { ...options(day1, 0), classifyDailyLimit: 2 },
    );
    expect(calls).toHaveLength(2);
    expect(report.recordsClassified).toBe(2);
    await runIntake(
      { ...deps(), classify },
      { ...options(new Date('2026-10-19T22:00:00Z'), 0), classifyDailyLimit: 2 },
    );
    expect(calls).toHaveLength(2);
  });
});
