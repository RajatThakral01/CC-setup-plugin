import { describe, expect, it } from 'vitest';
import { estimateRunUsd, weeklyPlan } from './costs.js';

describe('cost estimates', () => {
  it('uses the measured mean, or the per-run cap before anything is measured', () => {
    const measured = new Map([['fast', { meanUsd: 0.04, runs: 2 }]]);
    expect(estimateRunUsd('fast', measured, 1.5)).toBe(0.04);
    expect(estimateRunUsd('strong', measured, 1.5)).toBe(1.5);
  });

  it('computes the weekly run plan from per-run costs', () => {
    const plan = weeklyPlan({
      fastModel: 'fast',
      strongModel: 'strong',
      fastRunUsd: 0.1,
      strongRunUsd: 1,
      tasks: 5,
      screenRuns: 3,
      weeklyEvalUsd: 17,
      totalRemainingUsd: 39,
      headroom: 0.9,
    });
    expect(plan).toEqual({
      baselineStageAUsd: 1.5,
      baselineStageBUsd: 5,
      candidateStageAUsd: 1.5,
      candidateStageBUsd: 5,
      candidateFullUsd: 6.5,
      firstCandidateUsd: 13,
      plannableWeeklyUsd: 15.3,
      candidatesPerWeekWorstCase: 2,
      candidatesPerWeekScreenOnly: 10,
      candidatesFirstWeek: 1,
      candidatesUntilTotalCap: 4,
    });
  });
});
