import { and, eq, sql } from 'drizzle-orm';
import {
  computeCostUsd,
  computeRemaining,
  isoWeekStart,
  type AppConfig,
  type BudgetCaps,
  type BudgetPurpose,
  type RemainingBudget,
  type SpendTotals,
  type TokenUsage,
} from '@cc-setup-agent/shared';
import { assertModelAllowed, type Logger } from '@cc-setup-agent/core';
import type { DbOrTx } from './client.js';
import { BudgetExceededError } from './errors.js';
import { budgetLedger } from './schema.js';

export function budgetCapsFromConfig(config: AppConfig): BudgetCaps {
  return {
    weeklyUsd: config.WEEKLY_BUDGET_USD,
    classifyWeeklyUsd: config.BUDGET_SPLIT_CLASSIFY_USD,
    totalUsd: config.TOTAL_BUDGET_USD,
    totalWarnUsd: config.TOTAL_BUDGET_WARN_USD,
  };
}

export async function spendTotals(
  db: DbOrTx,
  weekStart: string,
  purpose: BudgetPurpose,
): Promise<SpendTotals> {
  const sum = sql<string>`coalesce(sum(${budgetLedger.costUsd}), 0)`;
  const [weekPurpose] = await db
    .select({ v: sum })
    .from(budgetLedger)
    .where(and(eq(budgetLedger.weekStart, weekStart), eq(budgetLedger.purpose, purpose)));
  const [weekAll] = await db
    .select({ v: sum })
    .from(budgetLedger)
    .where(eq(budgetLedger.weekStart, weekStart));
  const [total] = await db.select({ v: sum }).from(budgetLedger);
  return {
    weekPurposeUsd: Number(weekPurpose?.v ?? 0),
    weekAllUsd: Number(weekAll?.v ?? 0),
    totalUsd: Number(total?.v ?? 0),
  };
}

/** Remaining USD for a purpose in the given ISO week, honouring purpose, weekly and total caps. */
export async function remainingBudget(
  db: DbOrTx,
  weekStart: string,
  purpose: BudgetPurpose,
  caps: BudgetCaps,
): Promise<RemainingBudget> {
  return computeRemaining(caps, purpose, await spendTotals(db, weekStart, purpose));
}

/**
 * Pre-flight check before an API call. Throws BudgetExceededError if `estimatedUsd` does not fit.
 * Logs a warning once total spend has passed the warn threshold.
 */
export async function assertBudget(
  db: DbOrTx,
  purpose: BudgetPurpose,
  estimatedUsd: number,
  caps: BudgetCaps,
  options: { now?: Date; logger?: Logger } = {},
): Promise<RemainingBudget> {
  const remaining = await remainingBudget(
    db,
    isoWeekStart(options.now ?? new Date()),
    purpose,
    caps,
  );
  if (remaining.totalWarning) {
    options.logger?.warn(
      { totalWarnUsd: caps.totalWarnUsd },
      'total spend has passed the warning threshold',
    );
  }
  if (estimatedUsd > remaining.remainingUsd || remaining.remainingUsd <= 0) {
    throw new BudgetExceededError(remaining.limitedBy, remaining.remainingUsd, estimatedUsd);
  }
  return remaining;
}

export interface SpendRecord {
  purpose: BudgetPurpose;
  model: string;
  usage: TokenUsage;
  ref?: string;
  /** Use the cost reported by the API/CLI when available; otherwise computed from pricing. */
  costUsd?: number;
  now?: Date;
}

/** Writes one ledger row for an API call and returns its cost. */
export async function recordSpend(
  db: DbOrTx,
  config: AppConfig,
  record: SpendRecord,
  logger?: Logger,
): Promise<number> {
  assertModelAllowed(config, record.model);
  const pricing = config.MODEL_PRICING_JSON[record.model];
  if (!pricing) throw new Error(`No pricing configured for ${record.model}`);
  const costUsd = record.costUsd ?? computeCostUsd(pricing, record.usage);
  const now = record.now ?? new Date();
  await db.insert(budgetLedger).values({
    weekStart: isoWeekStart(now),
    purpose: record.purpose,
    model: record.model,
    inputTokens: record.usage.inputTokens,
    outputTokens: record.usage.outputTokens,
    cacheWriteTokens: record.usage.cacheWrite5mTokens + record.usage.cacheWrite1hTokens,
    cacheReadTokens: record.usage.cacheReadTokens,
    costUsd,
    ref: record.ref ?? null,
    createdAt: now,
  });
  const totals = await spendTotals(db, isoWeekStart(now), record.purpose);
  if (totals.totalUsd >= config.TOTAL_BUDGET_WARN_USD) {
    logger?.warn(
      { totalSpendUsd: totals.totalUsd, totalCapUsd: config.TOTAL_BUDGET_USD },
      'total Anthropic spend has passed the warning threshold',
    );
  }
  return costUsd;
}

/** Spend overview for reports. */
export async function spendSummary(
  db: DbOrTx,
  now = new Date(),
): Promise<{ weekStart: string; weekUsd: number; totalUsd: number }> {
  const weekStart = isoWeekStart(now);
  const t = await spendTotals(db, weekStart, 'classify');
  return { weekStart, weekUsd: t.weekAllUsd, totalUsd: t.totalUsd };
}
