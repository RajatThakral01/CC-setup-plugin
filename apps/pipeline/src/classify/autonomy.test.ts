import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLlmClient, createLogger, parseConfig, type MessagesApi } from '@cc-setup-agent/core';
import {
  budgetLedger,
  catalogItems,
  classifierEvals,
  createLedgerGuard,
  eq,
  insertCandidate,
  statusEvents,
  transitionStatus,
} from '@cc-setup-agent/db';
import { createTestDatabase, type TestDatabase } from '@cc-setup-agent/db/testing';
import { fakeHttp } from '../../../../test/support/http.js';
import { createGithubClient } from '../sources/github.js';
import { createNpmClient } from '../sources/npm.js';
import { PROMPT_VERSION } from './classifier.js';
import {
  evaluatePrompt,
  goldSetHash,
  loadGoldSet,
  promptGate,
  readGoldFile,
  scoreAgainstGold,
  type GoldEntry,
} from './gold.js';
import { classifyPending, requestSecondOpinion } from './run.js';

const GH = 'https://api.github.test';
let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.cleanup();
});
beforeEach(async () => {
  await t.db.delete(budgetLedger);
  await t.db.delete(classifierEvals);
  await t.db.delete(statusEvents);
  await t.db.delete(catalogItems);
});

const reply = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: 'mcp_server',
    category: 'browser_testing',
    stacks: ['any'],
    technologies: [],
    summary: 'Drives a browser.',
    provenance_guess: 'official_vendor',
    relevant: true,
    ...over,
  });

function setup(replies: string[] = []) {
  const config = parseConfig({});
  const readme = { text: '# Example MCP\nDrives a browser.' };
  const create = vi.fn(async (req: { model: string }) => ({
    content: [{ type: 'text', text: replies.shift() ?? reply() }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1000, output_tokens: 50 },
    model: req.model,
  }));
  const llm = createLlmClient({
    config,
    guard: createLedgerGuard(t.db, config),
    messages: { create } as unknown as MessagesApi,
  });
  const { http } = fakeHttp({
    [`${GH}/repos/example-org/example-mcp/readme`]: () => new Response(readme.text),
  });
  return {
    readme,
    create,
    deps: {
      db: t.db,
      llm,
      github: createGithubClient(http, 'test-token', GH),
      npm: createNpmClient(http, 'https://npm.example.test'),
      config,
      logger: createLogger({ level: 'silent' }),
    },
  };
}

const ID = 'example-mcp';
const add = (extra: Partial<typeof catalogItems.$inferInsert> = {}) =>
  insertCandidate(
    t.db,
    { id: ID, name: ID, sourceUrl: 'https://github.com/example-org/example-mcp', ...extra },
    'system',
    'fixture',
  );
const item = async () =>
  (await t.db.select().from(catalogItems).where(eq(catalogItems.id, ID)))[0]!;
const noGold = async (): Promise<GoldEntry[]> => [];

describe('classify --changed (PRD FR-D9a)', () => {
  it('records the input hash, then skips items whose inputs did not change', async () => {
    await add();
    const { deps, create, readme } = setup();
    expect(await classifyPending(deps, { changed: true, loadGold: noGold })).toMatchObject({
      classified: 1,
      unchanged: 0,
    });
    const hash = (await item()).classificationInputHash;
    expect(hash).toMatch(/^[0-9a-f]{32}$/);

    expect(await classifyPending(deps, { changed: true, loadGold: noGold })).toMatchObject({
      classified: 0,
      unchanged: 1,
    });
    expect(create).toHaveBeenCalledTimes(1);

    readme.text = '# Example MCP\nNow also queries Postgres.';
    expect(await classifyPending(deps, { changed: true, loadGold: noGold })).toMatchObject({
      classified: 1,
    });
    expect((await item()).classificationInputHash).not.toBe(hash);
  });

  it('re-classifies when components change, and never touches owner-set fields', async () => {
    await add({ category: 'docs', categorySetBy: 'human:owner' });
    const { deps } = setup();
    await classifyPending(deps, { changed: true, loadGold: noGold });
    await t.db
      .update(catalogItems)
      .set({
        components: {
          tools: [{ name: 'browser_click', description: 'Click' }],
          skills: [],
          commands: [],
          agents: [],
          mcpServers: 0,
          collectedAt: new Date().toISOString(),
        },
      })
      .where(eq(catalogItems.id, ID));
    expect((await classifyPending(deps, { changed: true, loadGold: noGold })).classified).toBe(1);
    expect((await item()).category).toBe('docs');
  });
});

describe('owner approvals stay valid', () => {
  it('keeps the kind and category an owner approved, but not a policy approval', async () => {
    await add({ kind: 'skill', category: 'auth' });
    await transitionStatus(t.db, ID, 'recommended_provisional', 'human:owner', 'looks right');
    const { deps } = setup([reply({ kind: 'skill', category: null })]);
    await classifyPending(deps, { changed: true, loadGold: noGold });
    expect(await item()).toMatchObject({ kind: 'skill', category: 'auth', categorySetBy: null });

    await t.db.delete(statusEvents);
    await t.db.delete(catalogItems);
    await add({ kind: 'skill', category: 'auth' });
    await transitionStatus(t.db, ID, 'recommended_provisional', 'policy:policy-v1', 'auto');
    await classifyPending(setup([reply({ kind: 'skill', category: null })]).deps, {
      changed: true,
      loadGold: noGold,
    });
    expect((await item()).category).toBeNull();
  });
});

describe('second opinion', () => {
  it('asks MODEL_STRONG with the same prompt and inputs, and stores it with the hash', async () => {
    await add();
    const { deps, create } = setup();
    await classifyPending(deps, { changed: true, loadGold: noGold });
    const result = await requestSecondOpinion(deps, await item());
    expect(result).toMatchObject({ ok: true, agreesOnCategory: true });
    expect(create.mock.calls.at(-1)?.[0].model).toBe('claude-sonnet-5-5');
    const row = await item();
    expect(row.secondOpinion).toMatchObject({
      model: 'claude-sonnet-5-5',
      promptVersion: PROMPT_VERSION,
      category: 'browser_testing',
      inputHash: row.classificationInputHash,
    });
    const ledger = await t.db.select().from(budgetLedger);
    expect(ledger.map((r) => [r.ref, r.model, r.purpose])).toContainEqual([
      `second-opinion:${ID}`,
      'claude-sonnet-5-5',
      'classify',
    ]);
  });

  it('asks nothing when the inputs changed since the classification', async () => {
    await add();
    const { deps, create, readme } = setup();
    await classifyPending(deps, { changed: true, loadGold: noGold });
    readme.text = 'changed';
    expect(await requestSecondOpinion(deps, await item())).toMatchObject({
      ok: false,
      reason: 'inputs changed since classification',
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('asks nothing without a classification that recorded its inputs', async () => {
    await add();
    const { deps } = setup();
    expect(await requestSecondOpinion(deps, await item())).toMatchObject({ ok: false });
  });
});

describe('gold set and prompt gate', () => {
  it('merges owner-locked fields over the frozen file', async () => {
    await add({ kind: 'skill', kindSetBy: 'human:owner', category: 'search' });
    const gold = await loadGoldSet(t.db, [
      { id: ID, kind: 'mcp_server', category: 'browser_testing', source: 'owner-approved' },
      { id: 'example-skill-beta', category: 'docs', source: 'owner-approved' },
    ]);
    expect(gold).toEqual([
      {
        id: 'example-mcp',
        kind: 'skill',
        category: 'browser_testing',
        source: 'owner-locked (kind)',
      },
      { id: 'example-skill-beta', category: 'docs', source: 'owner-approved' },
    ]);
  });

  it('scores only the fields a gold entry has', () => {
    const gold: GoldEntry = { id: ID, category: 'docs', source: 'x' };
    expect(scoreAgainstGold(gold, { kind: 'plugin', category: 'docs' }).correct).toBe(true);
    expect(scoreAgainstGold(gold, { kind: 'plugin', category: null })).toEqual({
      correct: false,
      mismatches: ['category none (gold docs)'],
    });
  });

  it('parses the committed gold file', async () => {
    const entries = await readGoldFile();
    expect(entries.length).toBeGreaterThan(0);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
  });

  it('scores a prompt version on the gold set and records it', async () => {
    await add();
    const { deps } = setup([reply(), reply({ category: 'search' })]);
    const gold: GoldEntry[] = [{ id: ID, category: 'browser_testing', source: 'owner-approved' }];
    const first = await evaluatePrompt(deps, gold);
    expect(first).toMatchObject({
      correct: 1,
      score: 1,
      goldSize: 1,
      promptVersion: PROMPT_VERSION,
    });
    const second = await evaluatePrompt(deps, gold);
    expect(second.score).toBe(0);
    expect(await t.db.select().from(classifierEvals)).toHaveLength(2);
    await expect(evaluatePrompt(deps, [])).rejects.toThrow(/gold set is empty/);
  });

  it('lets the prompt in use run, and gates a new one on its score', async () => {
    await add({
      classification: {
        kind: 'mcp_server',
        category: 'docs',
        stacks: [],
        technologies: [],
        summary: 's',
        provenanceGuess: 'community',
        relevant: true,
        model: 'claude-haiku-5-5',
        promptVersion: 'classify-v0',
        classifiedAt: new Date().toISOString(),
      },
      classificationState: 'classified',
    });
    const gold: GoldEntry[] = [{ id: ID, category: 'docs', source: 'x' }];
    const hash = goldSetHash(gold);
    const load = async () => gold;
    expect(await promptGate(t.db, 'classify-v0', 'claude-haiku-5-5', load)).toMatchObject({
      ok: true,
    });
    // A new version without scores is refused.
    expect(await promptGate(t.db, PROMPT_VERSION, 'claude-haiku-5-5', load)).toMatchObject({
      ok: false,
    });
    const score = (promptVersion: string, s: number) =>
      t.db.insert(classifierEvals).values({
        promptVersion,
        model: 'claude-haiku-5-5',
        goldSetHash: hash,
        goldSize: 1,
        correct: s,
        score: s,
      });
    await score('classify-v0', 1);
    await score(PROMPT_VERSION, 0);
    expect(await promptGate(t.db, PROMPT_VERSION, 'claude-haiku-5-5', load)).toMatchObject({
      ok: false,
    });
    const { deps } = setup();
    await expect(classifyPending(deps, { changed: true, loadGold: load })).rejects.toThrow(
      /not applied/,
    );
    await score(PROMPT_VERSION, 1);
    expect(await promptGate(t.db, PROMPT_VERSION, 'claude-haiku-5-5', load)).toMatchObject({
      ok: true,
    });
  });
});
