import { and, evalRuns, gt, ne, sql, type DbOrTx } from '@cc-setup-agent/db';

/** Mean measured cost per model over recorded eval runs that spent money (cap bookings excluded). */
export type MeasuredCosts = Map<string, { meanUsd: number; runs: number }>;

export async function measuredCosts(db: DbOrTx): Promise<MeasuredCosts> {
  const rows = await db
    .select({
      model: evalRuns.model,
      mean: sql<string>`avg(${evalRuns.costUsd})`,
      runs: sql<string>`count(*)`,
    })
    .from(evalRuns)
    // A cap booking (usage unknown) is a ceiling, not a measurement.
    .where(and(gt(evalRuns.costUsd, 0), ne(evalRuns.costSource, 'cap')))
    .groupBy(evalRuns.model);
  return new Map(rows.map((r) => [r.model, { meanUsd: Number(r.mean), runs: Number(r.runs) }]));
}

/**
 * Cost estimate for one run (plan 9.1 rule 5): the measured average for the model; before any run
 * of that model is measured, the per-run hard cap (never a guess).
 */
export function estimateRunUsd(model: string, measured: MeasuredCosts, capUsd: number): number {
  const m = measured.get(model);
  return m && m.runs > 0 ? m.meanUsd : capUsd;
}

export interface WeeklyPlanInput {
  fastModel: string;
  strongModel: string;
  fastRunUsd: number;
  strongRunUsd: number;
  tasks: number;
  screenRuns: number;
  /** Weekly eval share: WEEKLY_BUDGET_USD − BUDGET_SPLIT_CLASSIFY_USD. */
  weeklyEvalUsd: number;
  /** Left under the whole-build cap (TOTAL_BUDGET_USD − spent). */
  totalRemainingUsd: number;
  /** Fraction of the budget planned, leaving headroom for cost variance. */
  headroom: number;
}

export interface WeeklyPlan {
  baselineStageAUsd: number;
  baselineStageBUsd: number;
  candidateStageAUsd: number;
  candidateStageBUsd: number;
  /** A candidate that goes through both stages. */
  candidateFullUsd: number;
  /** First candidate in a category also pays for the (then cached) baseline runs. */
  firstCandidateUsd: number;
  plannableWeeklyUsd: number;
  /** Candidates per week once baselines are cached, assuming every one reaches Stage B. */
  candidatesPerWeekWorstCase: number;
  /** Candidates per week if they stop after Stage A (no Stage B confirmation). */
  candidatesPerWeekScreenOnly: number;
  /** First week: baselines plus this many full candidates. */
  candidatesFirstWeek: number;
  /** Full candidates (with first-time baselines) the remaining total budget covers. */
  candidatesUntilTotalCap: number;
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

/** Weekly run plan from measured per-run costs (plan 9.1 rule 1). */
export function weeklyPlan(p: WeeklyPlanInput): WeeklyPlan {
  const baselineStageAUsd = p.tasks * p.screenRuns * p.fastRunUsd;
  const baselineStageBUsd = p.tasks * p.strongRunUsd;
  const candidateStageAUsd = p.tasks * p.screenRuns * p.fastRunUsd;
  const candidateStageBUsd = p.tasks * p.strongRunUsd;
  const candidateFullUsd = candidateStageAUsd + candidateStageBUsd;
  const baselines = baselineStageAUsd + baselineStageBUsd;
  const plannable = p.weeklyEvalUsd * p.headroom;
  const per = (budget: number, cost: number) =>
    cost > 0 ? Math.max(0, Math.floor(budget / cost)) : 0;
  const totalPlannable = p.totalRemainingUsd * p.headroom;
  return {
    baselineStageAUsd: round(baselineStageAUsd),
    baselineStageBUsd: round(baselineStageBUsd),
    candidateStageAUsd: round(candidateStageAUsd),
    candidateStageBUsd: round(candidateStageBUsd),
    candidateFullUsd: round(candidateFullUsd),
    firstCandidateUsd: round(baselines + candidateFullUsd),
    plannableWeeklyUsd: round(plannable),
    candidatesPerWeekWorstCase: per(plannable, candidateFullUsd),
    candidatesPerWeekScreenOnly: per(plannable, candidateStageAUsd),
    candidatesFirstWeek: per(plannable - baselines, candidateFullUsd),
    candidatesUntilTotalCap: per(totalPlannable - baselines, candidateFullUsd),
  };
}

export function formatWeeklyPlan(p: WeeklyPlanInput, plan: WeeklyPlan): string {
  const usd = (n: number) => `USD ${n.toFixed(4)}`;
  return [
    `Per-run cost: ${p.fastModel} ${usd(p.fastRunUsd)}, ${p.strongModel} ${usd(p.strongRunUsd)}`,
    `Category: ${p.tasks} tasks; Stage A ${p.screenRuns} ${p.fastModel} runs per task; Stage B 1 ${p.strongModel} run per task`,
    `Baseline (once per incumbent and cache key): Stage A ${usd(plan.baselineStageAUsd)}, Stage B ${usd(plan.baselineStageBUsd)}`,
    `Candidate: Stage A ${usd(plan.candidateStageAUsd)}, Stage B ${usd(plan.candidateStageBUsd)}, both ${usd(plan.candidateFullUsd)}`,
    `Plannable per week (${Math.round(p.headroom * 100)}% of USD ${p.weeklyEvalUsd}): ${usd(plan.plannableWeeklyUsd)}`,
    `First week (baselines + candidates): ${plan.candidatesFirstWeek} candidate(s), first one costs ${usd(plan.firstCandidateUsd)} with baselines`,
    `Later weeks: ${plan.candidatesPerWeekWorstCase} candidate(s) if all reach Stage B, ${plan.candidatesPerWeekScreenOnly} if they stop after Stage A`,
    `Until the total cap (USD ${p.totalRemainingUsd.toFixed(2)} left): ${plan.candidatesUntilTotalCap} full candidate(s) including baselines`,
  ].join('\n');
}
