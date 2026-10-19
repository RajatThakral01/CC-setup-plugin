/**
 * Eval CLI: `pnpm evals <command>`. Thin wrapper; job logic lives in modules. Commands that call
 * the Anthropic API need `--confirm-spend`, so a typo never spends money.
 */
import { parseArgs } from 'node:util';
import {
  asc,
  evalQueue,
  remainingBudget,
  budgetCapsFromConfig,
  spendSummary,
} from '@cc-setup-agent/db';
import { categorySchema, isoWeekStart, type Category } from '@cc-setup-agent/shared';
import {
  createCommandContext,
  createRunContext,
  currentImage,
  type EvalCommandContext,
} from './context.js';
import {
  estimateRunUsd,
  formatWeeklyPlan,
  measuredCosts,
  weeklyPlan,
  type WeeklyPlanInput,
} from './costs.js';
import { EvalError } from './errors.js';
import { evaluateCandidate } from './evaluate.js';
import { findIncumbent, loadEvalItem } from './items.js';
import { runPilot } from './pilot.js';
import { newRunId, runLimits } from './runner.js';
import { sweepEvalContainers } from './sandbox/docker-driver.js';
import { buildImage, imageClaudeVersion } from './sandbox/image.js';
import { selftestTasks } from './selftest.js';
import { loadTaskSet } from './tasks.js';
import { createSkillFetcher, resolveToolSetup, type ToolSetup } from './tools.js';

const USAGE = `Usage: pnpm evals <command>

Commands:
  image                                   Build the eval image (fixture app, browsers, pinned Claude Code)
  selftest [--category c] [--task id]     Check each task: broken state fails, solution passes (no API calls)
  pilot --item <id> --task <id> --confirm-spend
                                          One run with MODEL_FAST and one with MODEL_STRONG (costs money)
  run --item <id> [--incumbent <id> | --no-incumbent] --confirm-spend
                                          Two-stage evaluation against the incumbent (costs money)
  plan [--category c]                     Weekly run plan from measured costs
  queue                                   Candidates waiting for budget
  cleanup                                 Remove eval containers and networks left by crashed runs`;

const out = (text: string) => process.stdout.write(`${text}\n`);

async function toolFor(
  c: EvalCommandContext,
  id: string,
): Promise<Extract<ToolSetup, { kind: 'mcp' | 'skill' }>> {
  const item = await loadEvalItem(c.db, id);
  const token = c.config.GITHUB_TOKEN;
  const setup = await resolveToolSetup(
    item,
    c.overrides,
    createSkillFetcher(c.http, {
      apiUrl: c.config.GITHUB_API_URL,
      rawUrl: c.config.GITHUB_RAW_URL,
      ...(token ? { token } : {}),
    }),
  );
  if (setup.kind === 'none') throw new EvalError(`${id} resolves to no tool`);
  return setup;
}

function requireSpend(flag: boolean | undefined): void {
  if (!flag)
    throw new EvalError('this command calls the Anthropic API; add --confirm-spend to run it');
}

async function planInput(c: EvalCommandContext, category: Category): Promise<WeeklyPlanInput> {
  const measured = await measuredCosts(c.db);
  const taskSet = await loadTaskSet(category);
  const total = (await spendSummary(c.db)).totalUsd;
  return {
    fastModel: c.config.MODEL_FAST,
    strongModel: c.config.MODEL_STRONG,
    fastRunUsd: estimateRunUsd(c.config.MODEL_FAST, measured, c.config.EVAL_RUN_MAX_USD),
    strongRunUsd: estimateRunUsd(c.config.MODEL_STRONG, measured, c.config.EVAL_RUN_MAX_USD),
    tasks: taskSet.tasks.length,
    screenRuns: c.config.EVAL_SCREEN_RUNS,
    weeklyEvalUsd: c.config.WEEKLY_BUDGET_USD - c.config.BUDGET_SPLIT_CLASSIFY_USD,
    totalRemainingUsd: Math.max(0, c.config.TOTAL_BUDGET_USD - total),
    headroom: 0.9,
  };
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      item: { type: 'string' },
      task: { type: 'string' },
      category: { type: 'string', default: 'browser_testing' },
      incumbent: { type: 'string' },
      'no-incumbent': { type: 'boolean' },
      'confirm-spend': { type: 'boolean' },
    },
  });
  if (!command || command === 'help' || command === '--help') {
    out(USAGE);
    return command ? 0 : 1;
  }
  const category = categorySchema.parse(values.category);
  const c = await createCommandContext();
  try {
    switch (command) {
      case 'image': {
        const { inputs } = await currentImage(c);
        out(
          `Building eval image (Claude Code ${inputs.claudeCodeVersion}, extra Playwright: ${inputs.playwrightVersions.join(', ') || 'none'})…`,
        );
        const tag = await buildImage(c.docker, inputs, c.config.EVAL_PLATFORM);
        out(`Built ${tag} with Claude Code ${await imageClaudeVersion(c.docker, tag)}`);
        return 0;
      }
      case 'selftest': {
        const ctx = await createRunContext(c, false);
        const taskSet = await loadTaskSet(category);
        out(`Task set ${taskSet.version} (${taskSet.tasks.length} tasks)`);
        const results = await selftestTasks(
          ctx.driver,
          taskSet,
          runLimits(c.config, 0),
          newRunId,
          values.task,
        );
        for (const r of results) {
          const ok = r.brokenFails && r.solutionPasses;
          out(
            `${ok ? 'PASS' : 'FAIL'} ${r.taskId}: broken state ${r.brokenFails ? 'fails' : 'PASSES'} the check; solution ${r.solutionPasses ? 'passes' : 'FAILS'}`,
          );
          if (!ok) out(r.detail);
        }
        return results.every((r) => r.brokenFails && r.solutionPasses) && results.length > 0
          ? 0
          : 1;
      }
      case 'pilot': {
        requireSpend(values['confirm-spend']);
        if (!values.item || !values.task) throw new EvalError('pilot needs --item and --task');
        const ctx = await createRunContext(c, true);
        const taskSet = await loadTaskSet(category);
        const task = taskSet.tasks.find((t) => t.id === values.task);
        if (!task) throw new EvalError(`no task ${values.task} in ${taskSet.version}`);
        const tool = await toolFor(c, values.item);
        const runs = await runPilot(ctx, {
          task,
          taskSetVersion: taskSet.version,
          tool,
          baselineItemId: null,
        });
        for (const r of runs)
          out(
            `${r.model}: ${r.success ? 'pass' : 'fail'}, USD ${r.costUsd.toFixed(4)}, ${r.inputTokens} in / ${r.outputTokens} out tokens, ${r.numTurns ?? '?'} turns, ${r.wallSeconds.toFixed(0)} s, ${r.subtype ?? 'no result'}${r.errors.length ? `; ${r.errors.join('; ')}` : ''} (run ${r.runId})`,
          );
        const p = await planInput(c, category);
        out('');
        out(formatWeeklyPlan(p, weeklyPlan(p)));
        return 0;
      }
      case 'run': {
        requireSpend(values['confirm-spend']);
        if (!values.item) throw new EvalError('run needs --item');
        const ctx = await createRunContext(c, true);
        const item = await loadEvalItem(c.db, values.item);
        const cat = item.category ?? category;
        const taskSet = await loadTaskSet(cat);
        const incumbentId = values['no-incumbent']
          ? null
          : (values.incumbent ?? (await findIncumbent(c.db, cat, item.id)));
        const result = await evaluateCandidate(ctx, {
          candidate: await toolFor(c, item.id),
          incumbent: incumbentId ? await toolFor(c, incumbentId) : null,
          taskSet,
        });
        out(
          result.status === 'queued'
            ? `Queued: ${result.reason}`
            : JSON.stringify(result.summary, null, 2),
        );
        if (result.status === 'done' && result.stopReason) out(result.stopReason);
        out(
          `${result.runs.length} run(s), USD ${result.runs.reduce((s, r) => s + r.costUsd, 0).toFixed(4)}`,
        );
        return 0;
      }
      case 'plan': {
        const p = await planInput(c, category);
        const left = await remainingBudget(
          c.db,
          isoWeekStart(new Date()),
          'eval',
          budgetCapsFromConfig(c.config),
        );
        out(formatWeeklyPlan(p, weeklyPlan(p)));
        out(
          `Eval budget left this week: USD ${left.remainingUsd.toFixed(2)} (limited by ${left.limitedBy})`,
        );
        return 0;
      }
      case 'queue': {
        const rows = await c.db.select().from(evalQueue).orderBy(asc(evalQueue.queuedAt));
        out(
          rows.length === 0
            ? 'Queue is empty.'
            : rows
                .map((r) => `${r.itemId} (${r.category}, priority ${r.priority}): ${r.reason}`)
                .join('\n'),
        );
        return 0;
      }
      case 'cleanup': {
        await sweepEvalContainers(c.docker);
        out('Removed leftover eval containers and networks.');
        return 0;
      }
      default:
        out(USAGE);
        return 1;
    }
  } finally {
    await c.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
