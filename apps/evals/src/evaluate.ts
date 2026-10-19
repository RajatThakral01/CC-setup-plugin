import {
  and,
  eq,
  evalQueue,
  evalRuns,
  isNull,
  remainingBudget,
  budgetCapsFromConfig,
  scorecards,
  type DbOrTx,
} from '@cc-setup-agent/db';
import { isoWeekStart, type EvalSummary } from '@cc-setup-agent/shared';
import { estimateRunUsd } from './costs.js';
import { runOne, type EvalContext, type EvalRunRecord, type EvalStage } from './runner.js';
import type { EvalTask, TaskSet } from './tasks.js';
import type { ToolSetup } from './tools.js';

/** One stored run, as needed for baseline caching and summaries. */
export interface RunRow {
  taskId: string;
  success: boolean;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  wallSeconds: number;
}

/**
 * Baseline cache key (plan 9.1 rule 3): task, task-set version, model, Claude Code version and the
 * incumbent with its version (or "no tool"). Runs are reused until any part changes.
 */
export interface BaselineKey {
  taskId: string;
  taskSetVersion: string;
  model: string;
  claudeCodeVersion: string;
  incumbent: { id: string; version: string } | null;
}

export async function cachedBaselineRuns(db: DbOrTx, key: BaselineKey): Promise<RunRow[]> {
  const toolMatch = key.incumbent
    ? and(
        eq(evalRuns.itemId, key.incumbent.id),
        eq(evalRuns.itemVersion, key.incumbent.version),
        eq(evalRuns.withTool, true),
      )
    : and(isNull(evalRuns.itemId), eq(evalRuns.withTool, false));
  return db
    .select({
      taskId: evalRuns.taskId,
      success: evalRuns.success,
      costUsd: evalRuns.costUsd,
      inputTokens: evalRuns.inputTokens,
      outputTokens: evalRuns.outputTokens,
      wallSeconds: evalRuns.wallSeconds,
    })
    .from(evalRuns)
    .where(
      and(
        eq(evalRuns.taskId, key.taskId),
        eq(evalRuns.taskSetVersion, key.taskSetVersion),
        eq(evalRuns.model, key.model),
        eq(evalRuns.claudeCodeVersion, key.claudeCodeVersion),
        toolMatch,
      ),
    )
    .orderBy(evalRuns.createdAt);
}

const passRate = (runs: Array<{ success: boolean }>) =>
  runs.length === 0 ? 0 : runs.filter((r) => r.success).length / runs.length;
const passes = (runs: Array<{ success: boolean }>) => runs.length > 0 && passRate(runs) >= 0.5;

export interface EvaluationPlan {
  candidate: Extract<ToolSetup, { kind: 'mcp' | 'skill' }>;
  /** The current recommended item in the category (FR-E4), or null to compare against no tool. */
  incumbent: Extract<ToolSetup, { kind: 'mcp' | 'skill' }> | null;
  taskSet: TaskSet;
  /** Queue priority if the batch has to wait for budget. */
  priority?: number;
}

export type EvaluationResult =
  | { status: 'done'; summary: EvalSummary; runs: EvalRunRecord[]; stopReason: string | null }
  | { status: 'queued'; reason: string; runs: EvalRunRecord[] };

/**
 * Two-stage evaluation (plan 9.1): Stage A screens with the fast model (N runs per task) against
 * cached baseline runs, stopping early after the candidate fails `EVAL_EARLY_STOP_FAILS` tasks the
 * baseline passed. Only a candidate that leads by `EVAL_CONFIRM_THRESHOLD` gets Stage B (1 strong-
 * model run per task). Each batch is pre-flighted against the remaining weekly eval budget; one
 * that doesn't fit is queued (FR-E6).
 */
export async function evaluateCandidate(
  ctx: EvalContext,
  plan: EvaluationPlan,
): Promise<EvaluationResult> {
  const { config, db } = ctx;
  const runs: EvalRunRecord[] = [];
  const baselineTool: ToolSetup = plan.incumbent ?? { kind: 'none' };
  const incumbentKey = plan.incumbent
    ? { id: plan.incumbent.item.id, version: plan.incumbent.item.version }
    : null;
  const baselineItemId = plan.incumbent?.item.id ?? null;

  const keyFor = (task: EvalTask, model: string): BaselineKey => ({
    taskId: task.id,
    taskSetVersion: plan.taskSet.version,
    model,
    claudeCodeVersion: ctx.claudeCodeVersion,
    incumbent: incumbentKey,
  });

  /** Pre-flight for a batch: runs × measured average must fit the remaining eval budget. */
  const fits = async (model: string, count: number): Promise<string | null> => {
    if (count === 0) return null;
    const estimate = count * estimateRunUsd(model, await ctx.measured(), config.EVAL_RUN_MAX_USD);
    const left = await remainingBudget(
      db,
      isoWeekStart(ctx.now?.() ?? new Date()),
      'eval',
      budgetCapsFromConfig(config),
    );
    return estimate > left.remainingUsd
      ? `batch of ${count} ${model} run(s) needs ~USD ${estimate.toFixed(2)}, only USD ${left.remainingUsd.toFixed(2)} left (${left.limitedBy})`
      : null;
  };

  const queue = async (reason: string): Promise<EvaluationResult> => {
    await db
      .insert(evalQueue)
      .values({
        itemId: plan.candidate.item.id,
        category: plan.taskSet.category,
        priority: plan.priority ?? 0,
        reason,
      })
      .onConflictDoUpdate({
        target: evalQueue.itemId,
        set: { reason, priority: plan.priority ?? 0, queuedAt: new Date() },
      });
    ctx.logger.warn({ item: plan.candidate.item.id, reason }, 'eval batch queued');
    return { status: 'queued', reason, runs };
  };

  const run = async (task: EvalTask, tool: ToolSetup, model: string, stage: EvalStage) => {
    const r = await runOne(ctx, {
      task,
      taskSetVersion: plan.taskSet.version,
      tool,
      model,
      stage,
      baselineItemId: tool.kind === 'none' || tool === plan.incumbent ? null : baselineItemId,
    });
    runs.push(r);
    return r;
  };

  // Stage A: screening with the fast model.
  const fast = config.MODEL_FAST;
  const n = config.EVAL_SCREEN_RUNS;
  const stageA = { candidate: [] as RunRow[], baseline: [] as RunRow[] };
  let failedVsBaseline = 0;
  let stopReason: string | null = null;
  for (const task of plan.taskSet.tasks) {
    const cached = (await cachedBaselineRuns(db, keyFor(task, fast))).slice(0, n);
    const missing = n - cached.length;
    const why = await fits(fast, missing + n);
    if (why) return queue(why);
    const baseline = [...cached];
    for (let i = 0; i < missing; i++)
      baseline.push(await run(task, baselineTool, fast, 'baseline'));
    const candidate: RunRow[] = [];
    for (let i = 0; i < n; i++) candidate.push(await run(task, plan.candidate, fast, 'screen'));
    stageA.baseline.push(...baseline);
    stageA.candidate.push(...candidate);
    if (passes(baseline) && !passes(candidate)) failedVsBaseline++;
    if (failedVsBaseline >= config.EVAL_EARLY_STOP_FAILS) {
      stopReason = `stopped early: failed ${failedVsBaseline} task(s) the baseline passed`;
      break;
    }
  }

  const leadA = passRate(stageA.candidate) - passRate(stageA.baseline);
  let verdict: EvalSummary['verdict'];
  let final = stageA;
  let model = fast;
  if (stopReason) verdict = 'worse';
  else if (leadA >= config.EVAL_CONFIRM_THRESHOLD) {
    // Stage B: confirmation with the strong model, 1 run per task.
    const strong = config.MODEL_STRONG;
    const stageB = { candidate: [] as RunRow[], baseline: [] as RunRow[] };
    for (const task of plan.taskSet.tasks) {
      const cached = (await cachedBaselineRuns(db, keyFor(task, strong))).slice(0, 1);
      const why = await fits(strong, 1 - cached.length + 1);
      if (why) return queue(`Stage B: ${why}`);
      stageB.baseline.push(
        ...(cached.length > 0 ? cached : [await run(task, baselineTool, strong, 'baseline')]),
      );
      stageB.candidate.push(await run(task, plan.candidate, strong, 'confirm'));
    }
    const leadB = passRate(stageB.candidate) - passRate(stageB.baseline);
    verdict = leadB >= 0 ? 'better' : 'inconclusive';
    final = stageB;
    model = strong;
  } else verdict = leadA <= -config.EVAL_CONFIRM_THRESHOLD ? 'worse' : 'equal';

  const mean = (rows: RunRow[], f: (r: RunRow) => number) =>
    rows.length === 0 ? 0 : rows.reduce((s, r) => s + f(r), 0) / rows.length;
  const summary: EvalSummary = {
    taskSetVersion: plan.taskSet.version,
    model,
    claudeCodeVersion: ctx.claudeCodeVersion,
    baselineItemId,
    runs: final.candidate.length,
    successRate: passRate(final.candidate),
    baselineSuccessRate: passRate(final.baseline),
    meanTokens: mean(final.candidate, (r) => r.inputTokens + r.outputTokens),
    meanCostUsd: mean(final.candidate, (r) => r.costUsd),
    meanWallSeconds: mean(final.candidate, (r) => r.wallSeconds),
    contextOverheadTokens: plan.candidate.item.contextOverheadTokens,
    verdict,
  };
  await writeEvalSummary(db, plan.candidate.item.id, plan.candidate.item.version, summary);
  await db.delete(evalQueue).where(eq(evalQueue.itemId, plan.candidate.item.id));
  return { status: 'done', summary, runs, stopReason };
}

/** Stores the summary on the item's scorecard for its pinned version (shown in triage). */
export async function writeEvalSummary(
  db: DbOrTx,
  itemId: string,
  version: string,
  summary: EvalSummary,
): Promise<void> {
  await db
    .insert(scorecards)
    .values({ itemId, version, evalSummary: summary })
    .onConflictDoUpdate({
      target: [scorecards.itemId, scorecards.version],
      set: { evalSummary: summary, updatedAt: new Date() },
    });
}
