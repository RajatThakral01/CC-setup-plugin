import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '@cc-setup-agent/core';
import type { Logger } from '@cc-setup-agent/core';
import { BudgetExceededError } from './errors.js';
import {
  assertBudget,
  budgetCapsFromConfig,
  recordSpend,
  remainingBudget,
  spendSummary,
} from './ledger.js';
import { budgetLedger } from './schema.js';
import { createTestDatabase, type TestDatabase } from './testing.js';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.cleanup();
});
beforeEach(async () => {
  await t.db.delete(budgetLedger);
});

const config = parseConfig({});
const caps = budgetCapsFromConfig(config);
const noTokens = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
};
const spend = (purpose: 'classify' | 'eval', costUsd: number, iso: string) =>
  recordSpend(t.db, config, {
    purpose,
    model: 'claude-haiku-5-5',
    usage: noTokens,
    costUsd,
    now: new Date(iso),
  });

describe('recordSpend', () => {
  it('computes cost from token usage and pricing', async () => {
    const cost = await recordSpend(t.db, config, {
      purpose: 'classify',
      model: 'claude-haiku-5-5',
      usage: { ...noTokens, inputTokens: 2000, outputTokens: 200 },
      ref: 'item:example-mcp-alpha',
    });
    expect(cost).toBeCloseTo(0.0003, 6);
    const rows = await t.db.select().from(budgetLedger);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purpose: 'classify',
      inputTokens: 2000,
      outputTokens: 200,
      costUsd: 0.0003,
    });
  });

  it('refuses Opus and unknown models', async () => {
    await expect(
      recordSpend(t.db, config, { purpose: 'eval', model: 'claude-opus-5-5', usage: noTokens }),
    ).rejects.toThrow(/forbidden/);
    await expect(
      recordSpend(t.db, config, { purpose: 'eval', model: 'claude-haiku-4-5', usage: noTokens }),
    ).rejects.toThrow(/ALLOWED_MODELS/);
  });

  it('assigns calls to ISO weeks in UTC', async () => {
    await spend('classify', 1, '2026-10-18T23:59:59.000Z'); // Sunday → week of 10-12
    await spend('classify', 2, '2026-10-19T00:00:00.000Z'); // Monday → week of 10-19
    expect((await remainingBudget(t.db, '2026-10-12', 'classify', caps)).remainingUsd).toBe(2);
    expect((await remainingBudget(t.db, '2026-10-19', 'classify', caps)).remainingUsd).toBe(1);
  });

  it('warns once total spend passes the warning threshold', async () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    await recordSpend(
      t.db,
      config,
      { purpose: 'eval', model: 'claude-sonnet-5-5', usage: noTokens, costUsd: 29 },
      logger,
    );
    expect(warn).not.toHaveBeenCalled();
    await recordSpend(
      t.db,
      config,
      { purpose: 'eval', model: 'claude-sonnet-5-5', usage: noTokens, costUsd: 1.5 },
      logger,
    );
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('assertBudget', () => {
  const now = new Date('2026-10-21T12:00:00.000Z');

  it('allows a call that fits', async () => {
    await expect(assertBudget(t.db, 'classify', 0.01, caps, { now })).resolves.toMatchObject({
      remainingUsd: 3,
    });
  });

  it('stops classification at its weekly share', async () => {
    await spend('classify', 2.995, '2026-10-20T00:00:00.000Z');
    await expect(assertBudget(t.db, 'classify', 0.01, caps, { now })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    // Evals still have their share.
    await expect(assertBudget(t.db, 'eval', 1, caps, { now })).resolves.toBeDefined();
  });

  it('stops everything at the weekly cap', async () => {
    await spend('eval', 17, '2026-10-20T00:00:00.000Z');
    await spend('classify', 3, '2026-10-20T00:00:00.000Z');
    await expect(assertBudget(t.db, 'eval', 0.0001, caps, { now })).rejects.toThrow(
      /purpose_weekly|weekly/,
    );
    await expect(assertBudget(t.db, 'classify', 0.0001, caps, { now })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
  });

  it('hard-stops at the total cap across weeks even when the week is fresh', async () => {
    await spend('eval', 17, '2026-09-28T10:00:00.000Z');
    await spend('eval', 17, '2026-10-05T10:00:00.000Z');
    await spend('eval', 5.5, '2026-10-12T10:00:00.000Z');
    const err = await assertBudget(t.db, 'eval', 1, caps, { now }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).limitedBy).toBe('total');
    expect((err as BudgetExceededError).remainingUsd).toBeCloseTo(0.5, 6);
  });

  it('reports spend for milestone reports', async () => {
    await spend('classify', 0.25, '2026-10-20T00:00:00.000Z');
    await spend('eval', 1, '2026-10-01T00:00:00.000Z');
    expect(await spendSummary(t.db, now)).toEqual({
      weekStart: '2026-10-19',
      weekUsd: 0.25,
      totalUsd: 1.25,
    });
  });
});
