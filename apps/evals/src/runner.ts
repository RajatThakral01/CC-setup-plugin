import { randomBytes } from 'node:crypto';
import { assertModelAllowed, type Logger } from '@cc-setup-agent/core';
import {
  and,
  assertBudget,
  budgetCapsFromConfig,
  budgetLedger,
  BudgetExceededError,
  eq,
  evalRuns,
  gte,
  recordSpend,
  sql,
  type Db,
} from '@cc-setup-agent/db';
import type { AppConfig } from '@cc-setup-agent/shared';
import type { ArtifactStore } from './artifacts.js';
import { parseClaudeOutput } from './claude-output.js';
import { estimateRunUsd, type MeasuredCosts } from './costs.js';
import type { EvalDriver, RunLimits } from './driver.js';
import type { EvalTask } from './tasks.js';
import { toolLabel, type ToolSetup } from './tools.js';

export type EvalStage = 'pilot' | 'screen' | 'confirm' | 'baseline';

export interface EvalContext {
  config: AppConfig;
  logger: Logger;
  db: Db;
  driver: EvalDriver;
  artifacts: ArtifactStore;
  /** Claude Code version inside the eval image (pinned on every run, FR-E5). */
  claudeCodeVersion: string;
  image: string;
  /** Measured mean cost per model, refreshed by the caller between batches. */
  measured: () => Promise<MeasuredCosts>;
  /**
   * An extra ceiling for a whole batch (e.g. an owner-approved amount): eval spend booked since
   * `since` may never exceed `limitUsd`, including runs booked at their cap after a timeout.
   */
  spendCeiling?: { limitUsd: number; since: Date };
  now?: () => Date;
}

export interface EvalRunRecord {
  runId: string;
  taskId: string;
  model: string;
  stage: EvalStage;
  itemId: string | null;
  success: boolean;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  wallSeconds: number;
  errors: string[];
  numTurns: number | null;
  subtype: string | null;
}

export function newRunId(): string {
  return `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(5).toString('hex')}`;
}

export function runLimits(config: AppConfig, maxBudgetUsd: number): RunLimits {
  return {
    maxTurns: config.EVAL_MAX_TURNS,
    timeoutSeconds: config.EVAL_TIMEOUT_SECONDS,
    maxBudgetUsd,
    setupTimeoutSeconds: config.EVAL_SETUP_TIMEOUT_SECONDS,
    checkTimeoutSeconds: config.EVAL_CHECK_TIMEOUT_SECONDS,
  };
}

/**
 * One paid eval run. Order: model allow-list → budget pre-flight with the measured average (or the
 * per-run cap before anything is measured) → run with `--max-budget-usd` capped at what is left →
 * ledger rows from Claude Code's reported usage (always, even when the run failed) → `eval_runs`.
 */
export async function runOne(
  ctx: EvalContext,
  input: {
    task: EvalTask;
    taskSetVersion: string;
    tool: ToolSetup;
    model: string;
    stage: EvalStage;
    baselineItemId: string | null;
  },
): Promise<EvalRunRecord> {
  const { config, db, logger } = ctx;
  assertModelAllowed(config, input.model);
  const estimate = estimateRunUsd(input.model, await ctx.measured(), config.EVAL_RUN_MAX_USD);
  const remaining = await assertBudget(db, 'eval', estimate, budgetCapsFromConfig(config), {
    logger,
    ...(ctx.now ? { now: ctx.now() } : {}),
  });
  let ceilingLeft = Infinity;
  if (ctx.spendCeiling) {
    const [row] = await db
      .select({ usd: sql<number>`coalesce(sum(${budgetLedger.costUsd}), 0)::float` })
      .from(budgetLedger)
      .where(
        and(eq(budgetLedger.purpose, 'eval'), gte(budgetLedger.createdAt, ctx.spendCeiling.since)),
      );
    ceilingLeft = ctx.spendCeiling.limitUsd - (row?.usd ?? 0);
    if (ceilingLeft < estimate)
      throw new BudgetExceededError('batch ceiling', Math.max(0, ceilingLeft), estimate);
  }
  // Hard stop inside Claude Code too: one run can never spend (or be booked at) more than is left.
  const maxBudgetUsd = Math.min(config.EVAL_RUN_MAX_USD, remaining.remainingUsd, ceilingLeft);
  const runId = newRunId();
  logger.info(
    {
      runId,
      task: input.task.id,
      model: input.model,
      tool: toolLabel(input.tool),
      stage: input.stage,
    },
    'eval run starting',
  );
  const outcome = await ctx.driver.run({
    runId,
    task: input.task,
    tool: input.tool,
    model: input.model,
    mode: 'agent',
    limits: runLimits(config, maxBudgetUsd),
  });

  const errors: string[] = [];
  if (!outcome.setup.ok) errors.push(`setup failed: ${outcome.setup.output.slice(-300)}`);
  const parsed = outcome.agent ? parseClaudeOutput(outcome.agent.stdout, input.model) : null;
  if (outcome.agent?.timedOut) errors.push('claude timed out');
  else if (outcome.agent && outcome.agent.exitCode !== 0)
    errors.push(`claude exited ${outcome.agent.exitCode}`);
  if (parsed && !parsed.completed) errors.push(`claude stopped: ${parsed.subtype}`);
  if (outcome.check?.timedOut) errors.push('check timed out');
  const refused = outcome.relay.filter((e) => e.kind === 'api' && e.refused === 'model');
  if (refused.length > 0)
    errors.push(`relay refused ${refused.length} request(s) for a forbidden model`);
  // Denied egress is logged, not counted as an agent error: Chromium's own background calls to
  // Google services are denied on every browser run.
  const egressDenied = [
    ...new Set(
      outcome.relay.filter((e) => e.kind === 'egress' && e.allowed === false).map((e) => e.host),
    ),
  ].sort();

  // Spend: Claude Code's own report per model. If it's missing but the API answered, record the
  // run's cap so the ledger never under-counts.
  const apiCalls = outcome.relay.filter((e) => e.kind === 'api' && e.status === 200).length;
  let costUsd = 0;
  if (parsed) {
    for (const s of parsed.spend) {
      const model = config.ALLOWED_MODELS.includes(s.model) ? s.model : input.model;
      costUsd += await recordSpend(
        db,
        config,
        {
          purpose: 'eval',
          model,
          usage: s.usage,
          ref: runId,
          ...(s.costUsd !== undefined ? { costUsd: s.costUsd } : {}),
          ...(ctx.now ? { now: ctx.now() } : {}),
        },
        logger,
      );
    }
  } else if (outcome.agent) {
    errors.push('claude output could not be parsed');
    if (apiCalls > 0) {
      costUsd = await recordSpend(
        db,
        config,
        {
          purpose: 'eval',
          model: input.model,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheWrite5mTokens: 0,
            cacheWrite1hTokens: 0,
            cacheReadTokens: 0,
          },
          costUsd: maxBudgetUsd,
          ref: `${runId} (unparsed output: cap recorded)`,
          ...(ctx.now ? { now: ctx.now() } : {}),
        },
        logger,
      );
    }
  }

  const success = outcome.setup.ok && outcome.check?.passed === true;
  const wallSeconds = outcome.agent?.wallSeconds ?? 0;
  const logsRef = await ctx.artifacts.putRun(runId, {
    'claude-stdout.json': outcome.agent?.stdout ?? '',
    'claude-stderr.txt': outcome.agent?.stderr ?? '',
    'setup.txt': outcome.setup.output,
    'check.txt': outcome.check?.output ?? '',
    'diff.patch': outcome.diff,
    'relay.jsonl': outcome.relay.map((e) => JSON.stringify(e)).join('\n'),
    'meta.json': JSON.stringify(
      {
        runId,
        task: input.task.id,
        taskSetVersion: input.taskSetVersion,
        model: input.model,
        stage: input.stage,
        tool: toolLabel(input.tool),
        toolVersion: input.tool.kind === 'none' ? null : input.tool.item.version,
        claudeCodeVersion: ctx.claudeCodeVersion,
        image: ctx.image,
        platform: outcome.platform,
        maxBudgetUsd,
        success,
        errors,
        egressDenied,
      },
      null,
      2,
    ),
  });
  const record: EvalRunRecord = {
    runId,
    taskId: input.task.id,
    model: input.model,
    stage: input.stage,
    itemId: input.tool.kind === 'none' ? null : input.tool.item.id,
    success,
    costUsd,
    inputTokens: parsed?.inputTokens ?? 0,
    outputTokens: parsed?.outputTokens ?? 0,
    wallSeconds,
    errors,
    numTurns: parsed?.numTurns ?? null,
    subtype: parsed?.subtype ?? null,
  };
  await db.insert(evalRuns).values({
    runId,
    itemId: record.itemId,
    itemVersion: input.tool.kind === 'none' ? null : input.tool.item.version,
    baselineItemId: input.baselineItemId,
    taskId: input.task.id,
    taskSetVersion: input.taskSetVersion,
    model: input.model,
    claudeCodeVersion: ctx.claudeCodeVersion,
    withTool: input.tool.kind !== 'none',
    success,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    costUsd,
    wallSeconds,
    errors: errors.length,
    logsRef,
    stage: input.stage,
    ...(ctx.now ? { createdAt: ctx.now() } : {}),
  });
  logger.info({ ...record, errors: errors.length }, 'eval run finished');
  return record;
}
