import { BudgetExceededError, budgetCapsFromConfig, remainingBudget } from '@cc-setup-agent/db';
import { isoWeekStart, type SetupEval } from '@cc-setup-agent/shared';
import { estimateRunUsd } from './costs.js';
import { cachedBaselineRuns, type RunRow } from './evaluate.js';
import { runOne, type EvalContext, type EvalRunRecord } from './runner.js';
import type { SetupArmReport, SetupTool } from './setup-arm.js';
import type { TaskSet } from './tasks.js';

export interface ArmStats {
  runs: number;
  passed: number;
  successRate: number;
  meanTokens: number;
  meanWallSeconds: number;
  meanCostUsd: number;
  costUsd: number;
}

export interface SetupCategoryResult {
  category: string;
  taskSetVersion: string;
  setup: ArmStats;
  baseline: ArmStats;
  /** Setup success rate minus default success rate. */
  lead: number;
}

export interface SetupComparison {
  model: string;
  categories: SetupCategoryResult[];
  overall: { setup: ArmStats; baseline: ArmStats; lead: number };
  /** Close (|lead| under the confirmation threshold) or categories pointing different ways. */
  ambiguous: boolean;
  /** Set when the budget stopped the comparison early; results cover the runs made. */
  stopped: string | null;
  newRuns: EvalRunRecord[];
}

export function armStats(rows: RunRow[]): ArmStats {
  const n = rows.length;
  const mean = (f: (r: RunRow) => number) => (n === 0 ? 0 : rows.reduce((s, r) => s + f(r), 0) / n);
  const passed = rows.filter((r) => r.success).length;
  return {
    runs: n,
    passed,
    successRate: n === 0 ? 0 : passed / n,
    meanTokens: mean((r) => r.inputTokens + r.outputTokens),
    meanWallSeconds: mean((r) => r.wallSeconds),
    meanCostUsd: mean((r) => r.costUsd),
    costUsd: rows.reduce((s, r) => s + r.costUsd, 0),
  };
}

/**
 * Recommended setup vs default setup (PRD 17.2 #11, success metric "eval uplift"): per task,
 * `runs` runs with no tool (cached when the key matches) and `runs` with the whole setup, same
 * model. Every run goes through `runOne`, so budget pre-flight, reservations, batch ceiling and the
 * timeout-is-failure rule are identical on both sides. A budget stop ends the comparison cleanly.
 */
export async function compareSetup(
  ctx: EvalContext,
  input: { taskSets: TaskSet[]; setup: SetupTool; runs: number; model: string },
): Promise<SetupComparison> {
  const { config, db } = ctx;
  const newRuns: EvalRunRecord[] = [];
  const perCategory = new Map<string, { version: string; setup: RunRow[]; baseline: RunRow[] }>();
  let stopped: string | null = null;

  const toRow = (r: EvalRunRecord): RunRow => ({
    taskId: r.taskId,
    success: r.success,
    costUsd: r.costUsd,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    wallSeconds: r.wallSeconds,
  });

  outer: for (const set of input.taskSets) {
    const bucket = { version: set.version, setup: [] as RunRow[], baseline: [] as RunRow[] };
    perCategory.set(set.category, bucket);
    for (const task of set.tasks) {
      const cached = (
        await cachedBaselineRuns(db, {
          taskId: task.id,
          taskSetVersion: set.version,
          model: input.model,
          claudeCodeVersion: ctx.claudeCodeVersion,
          incumbent: null,
        })
      ).slice(0, input.runs);
      const needed = input.runs - cached.length + input.runs;
      const estimate =
        needed * estimateRunUsd(input.model, await ctx.measured(), config.EVAL_RUN_MAX_USD);
      const left = await remainingBudget(
        db,
        isoWeekStart(ctx.now?.() ?? new Date()),
        'eval',
        budgetCapsFromConfig(config),
      );
      if (estimate > left.remainingUsd) {
        stopped = `${set.category}/${task.id}: ${needed} run(s) need ~USD ${estimate.toFixed(2)}, only USD ${left.remainingUsd.toFixed(2)} left (${left.limitedBy})`;
        break outer;
      }
      bucket.baseline.push(...cached);
      try {
        for (let i = cached.length; i < input.runs; i++) {
          const r = await runOne(ctx, {
            task,
            taskSetVersion: set.version,
            tool: { kind: 'none' },
            model: input.model,
            stage: 'baseline',
            baselineItemId: null,
          });
          newRuns.push(r);
          bucket.baseline.push(toRow(r));
        }
        for (let i = 0; i < input.runs; i++) {
          const r = await runOne(ctx, {
            task,
            taskSetVersion: set.version,
            tool: input.setup,
            model: input.model,
            stage: 'setup',
            baselineItemId: null,
          });
          newRuns.push(r);
          bucket.setup.push(toRow(r));
        }
      } catch (error) {
        if (!(error instanceof BudgetExceededError)) throw error;
        stopped = `${set.category}/${task.id}: ${error.message}`;
        break outer;
      }
    }
  }

  const categories: SetupCategoryResult[] = [...perCategory].map(([category, b]) => {
    const setup = armStats(b.setup);
    const baseline = armStats(b.baseline);
    return {
      category,
      taskSetVersion: b.version,
      setup,
      baseline,
      lead: setup.successRate - baseline.successRate,
    };
  });
  const setup = armStats([...perCategory.values()].flatMap((b) => b.setup));
  const baseline = armStats([...perCategory.values()].flatMap((b) => b.baseline));
  const lead = setup.successRate - baseline.successRate;
  const signs = new Set(categories.filter((c) => c.setup.runs > 0).map((c) => Math.sign(c.lead)));
  const ambiguous =
    Math.abs(lead) < config.EVAL_CONFIRM_THRESHOLD || (signs.has(1) && signs.has(-1));
  return {
    model: input.model,
    categories,
    overall: { setup, baseline, lead },
    ambiguous,
    stopped,
    newRuns,
  };
}

const arm4 = (a: ArmStats): SetupEval['setup'] => ({
  runs: a.runs,
  successRate: a.successRate,
  meanTokens: a.meanTokens,
  meanCostUsd: a.meanCostUsd,
  meanWallSeconds: a.meanWallSeconds,
});

/** The summary stored in `setup_evals` and published in the next snapshot (M10). */
export function toSetupEval(
  c: SetupComparison,
  setup: SetupArmReport,
  measuredAt: Date,
  tasks: number,
): SetupEval {
  return {
    measuredAt: measuredAt.toISOString(),
    model: c.model,
    catalogVersion: setup.catalogVersion,
    tasks,
    setup: arm4(c.overall.setup),
    default: arm4(c.overall.baseline),
    categories: c.categories.map((k) => ({
      category: k.category,
      setupSuccessRate: k.setup.successRate,
      defaultSuccessRate: k.baseline.successRate,
    })),
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const usd = (x: number) => `USD ${x.toFixed(4)}`;
const arm = (a: ArmStats) =>
  `${a.passed}/${a.runs} (${pct(a.successRate)}) | ${Math.round(a.meanTokens).toLocaleString('en-US')} | ${a.meanWallSeconds.toFixed(0)} s | ${usd(a.meanCostUsd)}`;

/** Markdown report of a setup comparison. */
export function formatSetupReport(c: SetupComparison, setup: SetupArmReport, when: string): string {
  const lines = [
    `# Recommended setup vs default setup (${when})`,
    '',
    `Model ${c.model}; catalog ${setup.catalogVersion}. Per arm: passed/runs (success rate) | mean tokens | mean wall time | mean cost per run.`,
    '',
    '| Category | Recommended setup | Default setup | Lead |',
    '| --- | --- | --- | --- |',
    ...c.categories.map(
      (k) =>
        `| ${k.category} | ${arm(k.setup)} | ${arm(k.baseline)} | ${k.lead >= 0 ? '+' : ''}${pct(k.lead)} |`,
    ),
    `| **all** | ${arm(c.overall.setup)} | ${arm(c.overall.baseline)} | ${c.overall.lead >= 0 ? '+' : ''}${pct(c.overall.lead)} |`,
    '',
    `Cost of this comparison: setup ${usd(c.overall.setup.costUsd)}, default ${usd(c.overall.baseline.costUsd)} (default includes cached runs, if any).`,
    `Result: ${c.ambiguous ? 'close or mixed (confirmation with the strong model would decide)' : c.overall.lead > 0 ? 'the recommended setup is ahead' : 'the default setup is ahead'}.`,
    ...(c.stopped ? [`Stopped early: ${c.stopped}`] : []),
    '',
    '## The setup',
    '',
    `- Answers: ${JSON.stringify(setup.answers)}`,
    `- Recommended: ${setup.recommended.join(', ') || 'nothing'}`,
    `- Installed in the eval: ${setup.installed.join(', ') || 'nothing'}`,
    ...setup.skipped.map((s) => `- Not installable in the eval sandbox: ${s.id} (${s.reason})`),
    `- Hooks: ${setup.hooks.join(', ') || 'none'}`,
    `- Gaps: ${setup.gaps.join(', ') || 'none'}`,
    `- Files written before each run: ${setup.files.join(', ')}`,
    '',
  ];
  return lines.join('\n');
}
