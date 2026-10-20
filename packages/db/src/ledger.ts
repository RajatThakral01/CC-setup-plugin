import { and, eq, sql } from 'drizzle-orm';
import {
  actorSchema,
  computeCostUsd,
  computeRemaining,
  isoWeekStart,
  type Actor,
  type AppConfig,
  type BudgetCaps,
  type BudgetPurpose,
  type RemainingBudget,
  type SpendTotals,
  type TokenUsage,
} from '@cc-setup-agent/shared';
import { assertModelAllowed, type Logger } from '@cc-setup-agent/core';
import type { Db, DbOrTx } from './client.js';
import { BudgetExceededError } from './errors.js';
import { budgetLedger, budgetLedgerCorrections } from './schema.js';

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

/**
 * Holds a run's cap in the ledger before it starts (M8.3, owner decision): the reservation counts
 * against every cap while the run is in flight, and `settleReservation` replaces it with the
 * actual usage afterwards, also after a timeout. Returns the reservation id.
 */
export async function reserveSpend(
  db: DbOrTx,
  config: AppConfig,
  hold: { purpose: BudgetPurpose; model: string; costUsd: number; ref: string; now?: Date },
): Promise<number> {
  assertModelAllowed(config, hold.model);
  const now = hold.now ?? new Date();
  const [row] = await db
    .insert(budgetLedger)
    .values({
      weekStart: isoWeekStart(now),
      purpose: hold.purpose,
      model: hold.model,
      costUsd: hold.costUsd,
      ref: hold.ref,
      reservation: true,
      createdAt: now,
    })
    .returning({ id: budgetLedger.id });
  return row!.id;
}

/**
 * Releases a reservation and books what was actually used, in one transaction. With no usage
 * records the reservation is simply released (nothing was spent). Returns the booked cost.
 */
export async function settleReservation(
  db: Db,
  config: AppConfig,
  reservationId: number,
  actual: SpendRecord[],
  logger?: Logger,
): Promise<number> {
  return db.transaction(async (tx) => {
    await tx
      .delete(budgetLedger)
      .where(and(eq(budgetLedger.id, reservationId), eq(budgetLedger.reservation, true)));
    let total = 0;
    for (const record of actual) total += await recordSpend(tx, config, record, logger);
    return total;
  });
}

/**
 * Re-books one ledger row at a corrected amount (M10, owner decision only): the row keeps counting
 * against the caps at its new amount, and `budget_ledger_corrections` keeps the old amount and ref,
 * the actor and the reason. Reservations can't be corrected (they are settled by the runner).
 */
export async function correctSpend(
  db: Db,
  correction: { ledgerId: number; costUsd: number; ref: string; actor: Actor; reason: string },
): Promise<void> {
  actorSchema.parse(correction.actor);
  if (!(correction.costUsd >= 0)) throw new Error('corrected cost must be a non-negative number');
  if (correction.reason.trim() === '') throw new Error('a correction needs a reason');
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(budgetLedger)
      .where(eq(budgetLedger.id, correction.ledgerId))
      .for('update');
    if (!row) throw new Error(`ledger row ${correction.ledgerId} not found`);
    if (row.reservation) throw new Error(`ledger row ${correction.ledgerId} is a reservation`);
    await tx.insert(budgetLedgerCorrections).values({
      ledgerId: row.id,
      oldCostUsd: row.costUsd,
      oldRef: row.ref,
      newCostUsd: correction.costUsd,
      newRef: correction.ref,
      actor: correction.actor,
      reason: correction.reason,
    });
    await tx
      .update(budgetLedger)
      .set({ costUsd: correction.costUsd, ref: correction.ref })
      .where(eq(budgetLedger.id, row.id));
  });
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
