import { describe, expect, it } from 'vitest';
import { computeCostUsd, computeRemaining, isoWeekStart, type BudgetCaps } from './budget.js';
import { DEFAULT_MODEL_PRICING } from './config.js';

const haiku = DEFAULT_MODEL_PRICING['claude-haiku-5-5']!;
const sonnet = DEFAULT_MODEL_PRICING['claude-sonnet-5-5']!;
const usage = (inputTokens: number, outputTokens: number, extra = {}) => ({
  inputTokens,
  outputTokens,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
  ...extra,
});

describe('isoWeekStart', () => {
  it.each([
    ['2026-10-19T00:00:00.000Z', '2026-10-19'], // Monday 00:00 UTC starts a week
    ['2026-10-18T23:59:59.999Z', '2026-10-12'], // Sunday 23:59 UTC is the previous week
    ['2026-10-25T23:59:59.999Z', '2026-10-19'],
    ['2026-10-26T00:00:00.000Z', '2026-10-26'],
    ['2026-01-01T12:00:00.000Z', '2025-12-29'], // week spanning a year boundary
    ['2024-02-29T08:00:00.000Z', '2024-02-26'], // leap day
  ])('%s → %s', (iso, expected) => {
    expect(isoWeekStart(new Date(iso))).toBe(expected);
  });

  it('uses UTC regardless of local offset', () => {
    // 2026-10-19T01:00+05:00 is still Sunday 20:00 UTC.
    expect(isoWeekStart(new Date('2026-10-19T01:00:00+05:00'))).toBe('2026-10-12');
  });
});

describe('computeCostUsd', () => {
  it('prices Haiku input and output', () => {
    // 50K in at $0.10/M + 50K out at $0.50/M
    expect(computeCostUsd(haiku, usage(50_000, 50_000))).toBeCloseTo(0.03, 6);
  });
  it('prices cache writes and reads', () => {
    const cost = computeCostUsd(
      sonnet,
      usage(0, 0, { cacheWrite5mTokens: 1_000_000, cacheReadTokens: 1_000_000 }),
    );
    expect(cost).toBeCloseTo(2.6, 6);
  });
  it('switches Haiku to the long-context tier above 100K prompt tokens', () => {
    expect(computeCostUsd(haiku, usage(100_000, 0))).toBeCloseTo(0.01, 6);
    expect(computeCostUsd(haiku, usage(100_001, 0))).toBeCloseTo(0.0500005, 6);
  });
  it('counts cached tokens toward the long-context threshold', () => {
    expect(computeCostUsd(haiku, usage(1, 0, { cacheReadTokens: 100_000 }))).toBeCloseTo(
      (1 * 0.5 + 100_000 * 0.05) / 1e6,
      5, // costs are rounded to 6 decimal places
    );
  });
});

describe('computeRemaining', () => {
  const caps: BudgetCaps = { weeklyUsd: 20, classifyWeeklyUsd: 3, totalUsd: 40, totalWarnUsd: 30 };

  it('limits classification by its weekly share', () => {
    expect(
      computeRemaining(caps, 'classify', { weekPurposeUsd: 1, weekAllUsd: 5, totalUsd: 5 }),
    ).toEqual({
      remainingUsd: 2,
      limitedBy: 'purpose_weekly',
      totalWarning: false,
    });
  });
  it('gives evals the rest of the weekly budget', () => {
    expect(
      computeRemaining(caps, 'eval', { weekPurposeUsd: 10, weekAllUsd: 12, totalUsd: 12 }),
    ).toMatchObject({
      remainingUsd: 7,
      limitedBy: 'purpose_weekly',
    });
  });
  it('is limited by the overall weekly cap', () => {
    expect(
      computeRemaining(caps, 'eval', { weekPurposeUsd: 1, weekAllUsd: 19.5, totalUsd: 19.5 }),
    ).toMatchObject({
      remainingUsd: 0.5,
      limitedBy: 'weekly',
    });
  });
  it('is limited by the total cap across weeks and warns past the threshold', () => {
    expect(
      computeRemaining(caps, 'eval', { weekPurposeUsd: 0, weekAllUsd: 0, totalUsd: 39 }),
    ).toEqual({
      remainingUsd: 1,
      limitedBy: 'total',
      totalWarning: true,
    });
  });
  it('never goes negative', () => {
    expect(
      computeRemaining(caps, 'classify', { weekPurposeUsd: 5, weekAllUsd: 5, totalUsd: 5 })
        .remainingUsd,
    ).toBe(0);
  });
});
