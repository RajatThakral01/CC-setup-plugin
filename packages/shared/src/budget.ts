import { z } from 'zod';
import type { ModelPricing } from './config.js';
import type { BudgetPurpose } from './enums.js';

export const tokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheWrite5mTokens: z.number().int().nonnegative().default(0),
  cacheWrite1hTokens: z.number().int().nonnegative().default(0),
  cacheReadTokens: z.number().int().nonnegative().default(0),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

/** Monday 00:00 UTC of the ISO week containing `date`, as YYYY-MM-DD. */
export function isoWeekStart(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayFromMonday = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayFromMonday);
  return d.toISOString().slice(0, 10);
}

/** USD cost of one call. Uses the long-context tier when the whole prompt exceeds its threshold. */
export function computeCostUsd(pricing: ModelPricing, usage: TokenUsage): number {
  const promptTokens =
    usage.inputTokens + usage.cacheWrite5mTokens + usage.cacheWrite1hTokens + usage.cacheReadTokens;
  const tier =
    pricing.longContext && promptTokens > pricing.longContext.thresholdTokens
      ? pricing.longContext
      : pricing;
  const cost =
    usage.inputTokens * tier.inputPerMTok +
    usage.outputTokens * tier.outputPerMTok +
    usage.cacheWrite5mTokens * tier.cacheWrite5mPerMTok +
    usage.cacheWrite1hTokens * tier.cacheWrite1hPerMTok +
    usage.cacheReadTokens * tier.cacheReadPerMTok;
  return Math.round((cost / 1_000_000) * 1e6) / 1e6;
}

export interface BudgetCaps {
  weeklyUsd: number;
  classifyWeeklyUsd: number;
  totalUsd: number;
  totalWarnUsd: number;
}

export interface SpendTotals {
  /** Spend this ISO week for the purpose being checked. */
  weekPurposeUsd: number;
  /** Spend this ISO week across all purposes. */
  weekAllUsd: number;
  /** Spend across all weeks and purposes. */
  totalUsd: number;
}

export interface RemainingBudget {
  remainingUsd: number;
  limitedBy: 'purpose_weekly' | 'weekly' | 'total';
  totalWarning: boolean;
}

export function purposeWeeklyCap(caps: BudgetCaps, purpose: BudgetPurpose): number {
  return purpose === 'classify' ? caps.classifyWeeklyUsd : caps.weeklyUsd - caps.classifyWeeklyUsd;
}

/** The tightest of the three caps wins. */
export function computeRemaining(
  caps: BudgetCaps,
  purpose: BudgetPurpose,
  spent: SpendTotals,
): RemainingBudget {
  const options: Array<[RemainingBudget['limitedBy'], number]> = [
    ['purpose_weekly', purposeWeeklyCap(caps, purpose) - spent.weekPurposeUsd],
    ['weekly', caps.weeklyUsd - spent.weekAllUsd],
    ['total', caps.totalUsd - spent.totalUsd],
  ];
  const [limitedBy, remaining] = options.reduce((a, b) => (b[1] < a[1] ? b : a));
  return {
    remainingUsd: Math.max(0, Math.round(remaining * 1e6) / 1e6),
    limitedBy,
    totalWarning: spent.totalUsd >= caps.totalWarnUsd,
  };
}
