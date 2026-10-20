import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, parseConfig } from '@cc-setup-agent/core';
import {
  BudgetExceededError,
  budgetLedger,
  catalogItems,
  eq,
  evalQueue,
  evalRuns,
  recordSpend,
  scorecards,
  sql,
} from '@cc-setup-agent/db';
import { createTestDatabase, type TestDatabase } from '@cc-setup-agent/db/testing';
import { isoWeekStart } from '@cc-setup-agent/shared';
import { createLocalArtifactStore } from './artifacts.js';
import { measuredCosts } from './costs.js';
import type { RunSpec } from './driver.js';
import { cachedBaselineRuns, evaluateCandidate } from './evaluate.js';
import { runOne, type EvalContext } from './runner.js';
import type { EvalTask, TaskSet } from './tasks.js';
import { createFakeDriver, type FakeRunBehaviour } from './testing.js';
import type { ToolSetup } from './tools.js';

let t: TestDatabase;
const FAST = 'claude-haiku-5-5';
const STRONG = 'claude-sonnet-5-5';

const item = (id: string, version: string) => ({
  id,
  kind: 'mcp_server' as const,
  install: { method: 'npx' as const, package: `@example/${id}`, version, envVars: [] },
  version,
  sourceUrl: `https://github.com/example-org/${id}`,
  contextOverheadTokens: 900,
});
const candidate: Extract<ToolSetup, { kind: 'mcp' }> = {
  kind: 'mcp',
  item: item('example-candidate-mcp', '1.0.0'),
  server: { command: 'npx', args: ['-y', '@example/candidate@1.0.0'] },
  prewarm: [],
};
const other: Extract<ToolSetup, { kind: 'mcp' }> = {
  ...candidate,
  item: item('example-other-mcp', '2.0.0'),
};
const incumbent: Extract<ToolSetup, { kind: 'mcp' }> = {
  ...candidate,
  item: item('example-incumbent-mcp', '3.0.0'),
};

const task = (id: string): EvalTask => ({
  id,
  category: 'browser_testing',
  version: 1,
  title: id,
  prompt: `Do ${id}`,
  dir: '/nonexistent',
  checkFiles: new Map(),
});
const taskSet = (n: number): TaskSet => ({
  category: 'browser_testing',
  version: 'browser_testing-v1-test0001',
  tasks: Array.from({ length: n }, (_, i) => task(`example-task-${i + 1}`)),
});

beforeAll(async () => {
  t = await createTestDatabase();
  for (const s of [candidate, other, incumbent])
    await t.db.insert(catalogItems).values({
      id: s.item.id,
      name: s.item.id,
      sourceUrl: s.item.sourceUrl,
      category: 'browser_testing',
    });
});
afterAll(async () => {
  await t?.cleanup();
});
beforeEach(async () => {
  await t.db.delete(evalRuns);
  await t.db.delete(evalQueue);
  await t.db.delete(scorecards);
  await t.db.delete(budgetLedger);
});

async function context(
  behaviour: (spec: RunSpec) => FakeRunBehaviour,
  env: Record<string, string> = {},
  claudeCodeVersion = '2.1.303',
) {
  const config = parseConfig({ EVAL_RUN_MAX_USD: '1.5', ...env });
  const driver = createFakeDriver(behaviour);
  const dir = await mkdtemp(join(tmpdir(), 'ccsa-evals-'));
  const ctx: EvalContext = {
    config,
    logger: createLogger({ level: 'silent' }),
    db: t.db,
    driver,
    artifacts: createLocalArtifactStore(dir),
    claudeCodeVersion,
    image: 'ccsa-eval:test',
    measured: () => measuredCosts(t.db),
  };
  return { ctx, driver, dir, config };
}

const ledgerTotal = async (purpose?: 'eval' | 'classify') => {
  const rows = await t.db
    .select({ v: sql<string>`coalesce(sum(${budgetLedger.costUsd}), 0)` })
    .from(budgetLedger)
    .where(purpose ? eq(budgetLedger.purpose, purpose) : sql`true`);
  return Number(rows[0]?.v ?? 0);
};

describe('runOne', () => {
  it('records ledger rows, the eval run and its artifacts', async () => {
    const { ctx, dir } = await context(() => ({ success: true, costUsd: 0.05 }));
    const r = await runOne(ctx, {
      task: task('example-task-1'),
      taskSetVersion: 'browser_testing-v1-test0001',
      tool: candidate,
      model: FAST,
      stage: 'pilot',
      baselineItemId: null,
    });
    expect(r).toMatchObject({ success: true, costUsd: 0.05, stage: 'pilot', errors: [] });
    const [row] = await t.db.select().from(evalRuns);
    expect(row).toMatchObject({
      itemId: 'example-candidate-mcp',
      itemVersion: '1.0.0',
      model: FAST,
      claudeCodeVersion: '2.1.303',
      taskSetVersion: 'browser_testing-v1-test0001',
      withTool: true,
      success: true,
      costUsd: 0.05,
      stage: 'pilot',
      logsRef: `local:${r.runId}`,
    });
    const [ledger] = await t.db.select().from(budgetLedger);
    expect(ledger).toMatchObject({ purpose: 'eval', model: FAST, costUsd: 0.05, ref: r.runId });
    const meta = JSON.parse(await readFile(join(dir, r.runId, 'meta.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(meta).toMatchObject({
      claudeCodeVersion: '2.1.303',
      image: 'ccsa-eval:test',
      toolVersion: '1.0.0',
    });
  });

  it('refuses Opus before anything runs', async () => {
    const { ctx, driver } = await context(() => ({ success: true, costUsd: 0 }));
    await expect(
      runOne(ctx, {
        task: task('x'),
        taskSetVersion: 'v',
        tool: candidate,
        model: 'claude-opus-5-5',
        stage: 'pilot',
        baselineItemId: null,
      }),
    ).rejects.toThrow(/forbidden/);
    expect(driver.calls).toHaveLength(0);
  });

  it('never lets an ISO week exceed the cap: pre-flight refusal plus a per-run hard stop', async () => {
    // Worst case: every run spends its whole --max-budget-usd.
    const { ctx, driver, config } = await context(
      (spec) => ({ success: true, costUsd: spec.limits.maxBudgetUsd }),
      { EVAL_RUN_MAX_USD: '5' },
    );
    await recordSpend(t.db, config, {
      purpose: 'classify',
      model: FAST,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        cacheReadTokens: 0,
      },
      costUsd: 3,
    });
    const input = {
      task: task('example-task-1'),
      taskSetVersion: 'v',
      tool: candidate,
      model: FAST,
      stage: 'screen' as const,
      baselineItemId: null,
    };
    let refused: unknown;
    for (let i = 0; i < 10 && !refused; i++)
      await runOne(ctx, input).catch((e: unknown) => (refused = e));
    expect(refused).toBeInstanceOf(BudgetExceededError);
    expect(driver.calls.map((c) => c.limits.maxBudgetUsd)).toEqual([5, 5, 5]);
    expect(await ledgerTotal('eval')).toBeLessThanOrEqual(17);
    expect(await ledgerTotal()).toBeLessThanOrEqual(20);
  });

  it('caps --max-budget-usd at the budget that is left', async () => {
    const { ctx, driver, config } = await context(() => ({ success: true, costUsd: 0.1 }));
    await recordSpend(t.db, config, {
      purpose: 'eval',
      model: FAST,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        cacheReadTokens: 0,
      },
      costUsd: 16,
    });
    await t.db.insert(evalRuns).values({
      runId: 'seed-run',
      taskId: 'x',
      taskSetVersion: 'v',
      model: FAST,
      claudeCodeVersion: '2.1.303',
      withTool: false,
      success: true,
      costUsd: 0.5,
    });
    await runOne(ctx, {
      task: task('x'),
      taskSetVersion: 'v',
      tool: candidate,
      model: FAST,
      stage: 'screen',
      baselineItemId: null,
    });
    expect(driver.calls[0]?.limits.maxBudgetUsd).toBe(1);
  });

  it('never lets a batch ceiling be exceeded, even when runs are booked at their cap', async () => {
    const { ctx, driver } = await context(() => ({ success: true, costUsd: 0.1 }));
    const since = new Date(Date.now() - 1000);
    // A measured mean of USD 0.10 per run (before measurement a run is estimated at the 1.50 cap).
    await t.db.insert(evalRuns).values({
      runId: 'measured-run',
      taskId: 'x',
      taskSetVersion: 'v',
      model: FAST,
      claudeCodeVersion: '2.1.303',
      withTool: false,
      success: true,
      costUsd: 0.1,
    });
    const capped = { ...ctx, spendCeiling: { limitUsd: 1, since } };
    const run = () =>
      runOne(capped, {
        task: task('x'),
        taskSetVersion: 'v',
        tool: candidate,
        model: FAST,
        stage: 'screen',
        baselineItemId: null,
      });
    // The ceiling (USD 1) binds below the per-run cap (USD 1.50): a timeout can book at most 1.
    await run();
    expect(driver.calls[0]?.limits.maxBudgetUsd).toBe(1);
    // USD 0.10 booked: the next run may book at most the 0.90 left.
    await run();
    expect(driver.calls[1]?.limits.maxBudgetUsd).toBeCloseTo(0.9, 6);
    await t.db.insert(budgetLedger).values({
      weekStart: isoWeekStart(new Date()),
      purpose: 'eval',
      model: FAST,
      costUsd: 0.75,
    });
    // 0.05 left, below the measured mean of 0.10: refused before running.
    await expect(run()).rejects.toThrow(/batch ceiling/);
    expect(driver.calls).toHaveLength(2);
  });

  it('records the run cap when the output is unreadable but the API answered', async () => {
    const { ctx } = await context(() => ({ success: false, costUsd: 0, stdout: 'crash' }));
    const r = await runOne(ctx, {
      task: task('x'),
      taskSetVersion: 'v',
      tool: candidate,
      model: FAST,
      stage: 'screen',
      baselineItemId: null,
    });
    expect(r.costUsd).toBe(1.5);
    expect(r.errors).toContain('claude output could not be parsed');
    expect(await ledgerTotal('eval')).toBe(1.5);
  });

  it('reports requests the relay refused for a forbidden model', async () => {
    const { ctx } = await context(() => ({
      success: true,
      costUsd: 0.01,
      relay: [{ kind: 'api', ts: 1, model: 'claude-opus-5-5', status: 403, refused: 'model' }],
    }));
    const r = await runOne(ctx, {
      task: task('x'),
      taskSetVersion: 'v',
      tool: candidate,
      model: FAST,
      stage: 'screen',
      baselineItemId: null,
    });
    expect(r.errors).toContain('relay refused 1 request(s) for a forbidden model');
  });
});

describe('evaluateCandidate', () => {
  const byTool = (pass: { candidate: boolean; baseline: boolean }) => (spec: RunSpec) => ({
    success:
      spec.tool.kind !== 'none' && spec.tool.item.id !== incumbent.item.id
        ? pass.candidate
        : pass.baseline,
    costUsd: 0.01,
  });

  it('caches baseline runs by key and reuses them for the next candidate', async () => {
    const a = await context(byTool({ candidate: true, baseline: true }));
    const r1 = await evaluateCandidate(a.ctx, { candidate, incumbent, taskSet: taskSet(2) });
    expect(r1.status).toBe('done');
    const stages = (calls: RunSpec[]) =>
      calls.map((c) => (c.tool === incumbent ? 'b' : 'c')).join('');
    expect(stages(a.driver.calls)).toBe('bbbccc'.repeat(2));

    const b = await context(byTool({ candidate: true, baseline: true }));
    await evaluateCandidate(b.ctx, { candidate: other, incumbent, taskSet: taskSet(2) });
    expect(b.driver.calls.every((c) => c.tool === other)).toBe(true);
    expect(b.driver.calls).toHaveLength(6);

    // A different Claude Code version is a different cache key: baselines run again.
    const c = await context(byTool({ candidate: true, baseline: true }), {}, '2.1.400');
    await evaluateCandidate(c.ctx, { candidate: other, incumbent, taskSet: taskSet(2) });
    expect(c.driver.calls.filter((x) => x.tool === incumbent)).toHaveLength(6);
    const cached = await cachedBaselineRuns(t.db, {
      taskId: 'example-task-1',
      taskSetVersion: 'browser_testing-v1-test0001',
      model: FAST,
      claudeCodeVersion: '2.1.303',
      incumbent: { id: incumbent.item.id, version: '3.0.0' },
    });
    expect(cached).toHaveLength(3);
    expect(
      await cachedBaselineRuns(t.db, {
        taskId: 'example-task-1',
        taskSetVersion: 'browser_testing-v1-test0001',
        model: FAST,
        claudeCodeVersion: '2.1.303',
        incumbent: { id: incumbent.item.id, version: '3.0.1' },
      }),
    ).toHaveLength(0);
  });

  it('stops Stage A early after failing two tasks the baseline passed', async () => {
    const { ctx, driver } = await context(byTool({ candidate: false, baseline: true }));
    const r = await evaluateCandidate(ctx, { candidate, incumbent, taskSet: taskSet(5) });
    expect(r.status).toBe('done');
    if (r.status !== 'done') return;
    expect(r.stopReason).toMatch(/failed 2 task/);
    expect(r.summary.verdict).toBe('worse');
    expect(driver.calls).toHaveLength(2 * 6);
    expect(driver.calls.every((c) => c.model === FAST)).toBe(true);
  });

  it('confirms a clear Stage A winner with the strong model and stores the summary', async () => {
    const { ctx, driver } = await context(byTool({ candidate: true, baseline: false }));
    const r = await evaluateCandidate(ctx, { candidate, incumbent, taskSet: taskSet(2) });
    expect(r.status === 'done' && r.summary).toMatchObject({
      model: STRONG,
      verdict: 'better',
      successRate: 1,
      baselineSuccessRate: 0,
      runs: 2,
      baselineItemId: incumbent.item.id,
      contextOverheadTokens: 900,
      claudeCodeVersion: '2.1.303',
    });
    expect(driver.calls.filter((c) => c.model === STRONG)).toHaveLength(4);
    const [card] = await t.db
      .select()
      .from(scorecards)
      .where(eq(scorecards.itemId, candidate.item.id));
    expect(card?.version).toBe('1.0.0');
    expect(card?.evalSummary?.verdict).toBe('better');
  });

  it('skips Stage B when the candidate does not lead by the threshold', async () => {
    const { ctx, driver } = await context(byTool({ candidate: true, baseline: true }));
    const r = await evaluateCandidate(ctx, { candidate, incumbent: null, taskSet: taskSet(2) });
    expect(r.status === 'done' && r.summary.verdict).toBe('equal');
    expect(driver.calls.every((c) => c.model === FAST)).toBe(true);
    expect(driver.calls.filter((c) => c.tool.kind === 'none')).toHaveLength(6);
  });

  it('queues the candidate when a batch does not fit the remaining budget (pre-flight)', async () => {
    const { ctx, driver, config } = await context(byTool({ candidate: true, baseline: true }));
    await recordSpend(t.db, config, {
      purpose: 'eval',
      model: FAST,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        cacheReadTokens: 0,
      },
      costUsd: 10,
    });
    const r = await evaluateCandidate(ctx, {
      candidate,
      incumbent,
      taskSet: taskSet(2),
      priority: 4,
    });
    expect(r).toMatchObject({ status: 'queued', reason: expect.stringMatching(/batch of 6/) });
    expect(driver.calls).toHaveLength(0);
    const [q] = await t.db.select().from(evalQueue);
    expect(q).toMatchObject({
      itemId: candidate.item.id,
      category: 'browser_testing',
      priority: 4,
    });
  });
});
