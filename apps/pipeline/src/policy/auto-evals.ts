import type { Logger } from '@cc-setup-agent/core';
import {
  BudgetExceededError,
  budgetCapsFromConfig,
  remainingBudget,
  spendSummary,
  type Db,
} from '@cc-setup-agent/db';
import {
  cachedBaselineRuns,
  createCommandContext,
  createRunContext,
  createSkillFetcher,
  estimateRunUsd,
  evaluateCandidate,
  loadEvalItem,
  loadTaskSet,
  measuredCosts,
  resolveToolSetup,
  type EvaluationResult,
  type TaskSet,
} from '@cc-setup-agent/evals';
import {
  evalNeed,
  isoWeekStart,
  type AppConfig,
  type ApprovalPolicy,
  type Category,
  type CategoryRules,
} from '@cc-setup-agent/shared';
import { AppError } from '@cc-setup-agent/core';
import { loadPolicyFacts, type ItemFacts } from './facts.js';

export class AutoEvalError extends AppError {}

/**
 * Can the harness run this item without credentials or extra network access? npx MCP servers
 * (pinned package) and skills copied at a pinned commit; nothing needing env vars (FR-E7).
 */
export function evalReady(f: ItemFacts['facts']): { ready: boolean; reason: string } {
  const i = f.install;
  if (!i) return { ready: false, reason: 'no install details' };
  if (i.envVars.length > 0) return { ready: false, reason: `needs ${i.envVars.join(', ')}` };
  if (f.kind === 'mcp_server' && i.method === 'npx' && i.package && i.version)
    return { ready: true, reason: `npx ${i.package}@${i.version}` };
  if (
    f.kind === 'skill' &&
    i.method === 'skill_copy' &&
    /^sha-[0-9a-f]{7,40}$/.test(f.pinnedVersion ?? '')
  )
    return { ready: true, reason: `skill at ${f.pinnedVersion}` };
  return {
    ready: false,
    reason: `${f.kind ?? 'unknown kind'} via ${i.method} is not evaluable yet`,
  };
}

const relevance = (stacks: string[]) =>
  stacks.includes('nextjs') || stacks.includes('react') ? 2 : stacks.includes('any') ? 1 : 0;

/** Most promising first (FR-P7): Next.js relevance, then vendor, star velocity, stars, id. */
export function comparePromise(a: ItemFacts, b: ItemFacts, policy: ApprovalPolicy): number {
  const vendor = (x: ItemFacts) =>
    x.facts.provenance && policy.vendor_tier_provenances.includes(x.facts.provenance) ? 1 : 0;
  return (
    relevance(b.facts.stacks) - relevance(a.facts.stacks) ||
    vendor(b) - vendor(a) ||
    (b.starVelocity7d ?? 0) - (a.starVelocity7d ?? 0) ||
    (b.stars ?? 0) - (a.stars ?? 0) ||
    a.item.id.localeCompare(b.item.id)
  );
}

export interface PlannedEval {
  id: string;
  category: Category;
  incumbentId: string | null;
  /** Worst case: Stage A and Stage B for the candidate. */
  candidateUsd: number;
  /** Baseline runs not yet cached for this category and incumbent (paid once). */
  baselineUsd: number;
  why: string;
}

export interface AutoEvalPlan {
  weekStart: string;
  policyVersion: string;
  batch: PlannedEval[];
  estimateUsd: number;
  budget: {
    weeklyEvalLeftUsd: number;
    totalLeftUsd: number;
    reserveUsd: number;
    plannableUsd: number;
  };
  /** Eval-worthy items left for a later week, with the reason. */
  deferred: Array<{ id: string; reason: string }>;
  /** Categories with eval-worthy items but no task set. */
  noTasks: Array<{ category: string; items: number }>;
}

export interface AutoEvalDeps {
  db: Db;
  config: AppConfig;
  logger: Logger;
  policy: ApprovalPolicy;
  rules: CategoryRules;
  /** Task set per category (tests inject); default loads apps/evals/tasks. */
  taskSet?: (category: Category) => Promise<TaskSet | null>;
}

const defaultTaskSet = async (category: Category) => loadTaskSet(category).catch(() => null);

/**
 * Picks this week's batch (FR-P7): per category with a task set, the most promising eval-ready
 * items for which an eval is the missing evidence, up to `per_category`, added while the worst-case
 * estimate (Stage A + Stage B + uncached baselines) fits the plannable budget: the weekly eval
 * budget left and the total budget left minus the reserve, times the headroom.
 */
export async function planAutoEvals(
  deps: AutoEvalDeps,
  now = new Date(),
  /** An extra ceiling for this batch (e.g. the amount the owner approved). */
  maxUsd?: number,
): Promise<AutoEvalPlan> {
  const { config, policy } = deps;
  const facts = await loadPolicyFacts(deps.db, deps.rules, now);
  const byId = new Map(facts.map((f) => [f.item.id, f]));
  const worthy = facts.filter(
    (f) => f.facts.category && evalNeed(f.facts, policy).worth && evalReady(f.facts).ready,
  );
  const weekStart = isoWeekStart(now);
  const weekly = await remainingBudget(deps.db, weekStart, 'eval', budgetCapsFromConfig(config));
  const spent = (await spendSummary(deps.db)).totalUsd;
  const reserve = policy.auto_evals.total_reserve_usd;
  const totalLeft = Math.max(0, config.TOTAL_BUDGET_USD - spent - reserve);
  const plannable = Math.min(
    Math.min(weekly.remainingUsd, totalLeft) * policy.auto_evals.headroom,
    maxUsd ?? Infinity,
  );

  const measured = await measuredCosts(deps.db);
  const fast = estimateRunUsd(config.MODEL_FAST, measured, config.EVAL_RUN_MAX_USD);
  const strong = estimateRunUsd(config.MODEL_STRONG, measured, config.EVAL_RUN_MAX_USD);
  const n = config.EVAL_SCREEN_RUNS;

  const plan: AutoEvalPlan = {
    weekStart,
    policyVersion: policy.version,
    batch: [],
    estimateUsd: 0,
    budget: {
      weeklyEvalLeftUsd: weekly.remainingUsd,
      totalLeftUsd: Math.max(0, config.TOTAL_BUDGET_USD - spent),
      reserveUsd: reserve,
      plannableUsd: plannable,
    },
    deferred: [],
    noTasks: [],
  };
  const categories = [...new Set(worthy.map((f) => f.facts.category!))].sort();
  for (const category of categories) {
    const items = worthy
      .filter((f) => f.facts.category === category)
      .sort((a, b) => comparePromise(a, b, policy));
    const taskSet = await (deps.taskSet ?? defaultTaskSet)(category);
    if (!taskSet) {
      plan.noTasks.push({ category, items: items.length });
      continue;
    }
    // A vendor-specific item is only judged on tasks that use its technology.
    const fitting = items.filter(
      (f) =>
        (f.item.technologies ?? []).length === 0 ||
        (f.item.technologies ?? []).some((t) => taskSet.technologies.includes(t)),
    );
    for (const f of items.filter((x) => !fitting.includes(x)))
      plan.deferred.push({
        id: f.item.id,
        reason: `needs ${(f.item.technologies ?? []).join(', ')}; the ${category} tasks use ${taskSet.technologies.join(', ') || 'no specific technology'}`,
      });
    items.splice(0, items.length, ...fitting);
    const tasks = taskSet.tasks.length;
    const baselineCost = new Map<string, number>();
    let picked = 0;
    for (const f of items) {
      if (picked >= policy.auto_evals.per_category) {
        plan.deferred.push({
          id: f.item.id,
          reason: `per-category limit (${policy.auto_evals.per_category})`,
        });
        continue;
      }
      const incumbentId = f.facts.incumbentId;
      const key = incumbentId ?? '(no tool)';
      let baselineUsd = 0;
      if (!baselineCost.has(key)) {
        const incumbent = incumbentId ? byId.get(incumbentId) : undefined;
        const incumbentKey = incumbentId
          ? { id: incumbentId, version: incumbent?.facts.pinnedVersion ?? 'unknown' }
          : null;
        for (const task of taskSet.tasks) {
          for (const [model, want, price] of [
            [config.MODEL_FAST, n, fast],
            [config.MODEL_STRONG, 1, strong],
          ] as const) {
            const cached = await cachedBaselineRuns(deps.db, {
              taskId: task.id,
              taskSetVersion: taskSet.version,
              model,
              claudeCodeVersion: config.EVAL_CLAUDE_CODE_VERSION,
              incumbent: incumbentKey,
            });
            baselineUsd += Math.max(0, want - cached.length) * price;
          }
        }
      }
      const candidateUsd = tasks * n * fast + tasks * strong;
      const cost = candidateUsd + baselineUsd;
      if (plan.estimateUsd + cost > plannable) {
        plan.deferred.push({
          id: f.item.id,
          reason: `budget: needs ~USD ${cost.toFixed(2)}, ${Math.max(0, plannable - plan.estimateUsd).toFixed(2)} plannable left`,
        });
        continue;
      }
      baselineCost.set(key, baselineUsd);
      plan.batch.push({
        id: f.item.id,
        category,
        incumbentId,
        candidateUsd,
        baselineUsd,
        why: `${evalReady(f.facts).reason}; ${f.facts.provenance ?? 'unknown'} provenance; stacks ${f.facts.stacks.join(', ') || 'none'}; star velocity ${f.starVelocity7d ?? 'n/a'}`,
      });
      plan.estimateUsd += cost;
      picked++;
    }
  }
  return plan;
}

export function formatAutoEvalPlan(p: AutoEvalPlan): string {
  const usd = (x: number) => `USD ${x.toFixed(2)}`;
  return [
    `# Scheduled eval plan, week of ${p.weekStart} (${p.policyVersion})`,
    '',
    `Budget: weekly eval budget left ${usd(p.budget.weeklyEvalLeftUsd)}; total budget left ${usd(p.budget.totalLeftUsd)} (reserve ${usd(p.budget.reserveUsd)} kept for classification); plannable ${usd(p.budget.plannableUsd)}.`,
    `Planned batch: ${p.batch.length} item(s), worst-case estimate ${usd(p.estimateUsd)} (every candidate reaching Stage B).`,
    '',
    ...(p.batch.length === 0
      ? ['Nothing to evaluate this week.']
      : [
          '| Item | Category | Against | Candidate | Baselines | Why |',
          '| --- | --- | --- | --- | --- | --- |',
          ...p.batch.map(
            (b) =>
              `| ${b.id} | ${b.category} | ${b.incumbentId ?? 'no tool'} | ${usd(b.candidateUsd)} | ${usd(b.baselineUsd)} | ${b.why.replace(/\|/g, '/')} |`,
          ),
        ]),
    '',
    ...(p.deferred.length > 0
      ? ['Deferred to a later week:', ...p.deferred.map((d) => `- ${d.id}: ${d.reason}`), '']
      : []),
    ...(p.noTasks.length > 0
      ? [
          'Eval-worthy items in categories without a task set (not evaluable yet):',
          ...p.noTasks.map((c) => `- ${c.category}: ${c.items} item(s)`),
          '',
        ]
      : []),
  ].join('\n');
}

export type AutoEvalExecutor = (entry: PlannedEval) => Promise<EvaluationResult>;

/**
 * Runs the planned batch (FR-P7). The plan and its estimate are logged (and returned for the
 * reports file) before anything is spent. Scheduled runs need no confirmation; manual runs need
 * `confirmSpend`. Every run still goes through the harness's per-batch pre-flight and the ledger,
 * so the weekly and total caps hold even if the estimate is wrong.
 */
export async function runAutoEvals(
  deps: AutoEvalDeps,
  options: {
    trigger: 'scheduled' | 'manual';
    confirmSpend?: boolean;
    dryRun?: boolean;
    maxUsd?: number;
    execute?: AutoEvalExecutor;
    onPlan?: (plan: AutoEvalPlan, text: string) => Promise<void>;
    now?: Date;
  },
): Promise<{
  plan: AutoEvalPlan;
  results: Array<{ id: string; result?: EvaluationResult; error?: string }>;
}> {
  const plan = await planAutoEvals(deps, options.now, options.maxUsd);
  const text = formatAutoEvalPlan(plan);
  deps.logger.info(
    { batch: plan.batch.map((b) => b.id), estimateUsd: plan.estimateUsd, budget: plan.budget },
    'scheduled eval plan',
  );
  await options.onPlan?.(plan, text);
  if (options.dryRun || plan.batch.length === 0) return { plan, results: [] };
  if (options.trigger === 'manual' && !options.confirmSpend)
    throw new AutoEvalError(
      'auto-evals calls the Anthropic API; add --confirm-spend or use --dry-run',
    );
  // The plan's ceiling is enforced on every run, not only when planning (booked spend counts,
  // including runs booked at their cap after a timeout).
  const ceiling = { limitUsd: plan.budget.plannableUsd, since: new Date() };
  const own = options.execute ? null : await createEvalExecutor(ceiling);
  const execute = options.execute ?? own!.execute;
  const results: Array<{ id: string; result?: EvaluationResult; error?: string }> = [];
  try {
    await runBatch(plan, execute, results, deps.logger);
  } finally {
    await own?.close();
  }
  return { plan, results };
}

async function runBatch(
  plan: AutoEvalPlan,
  execute: AutoEvalExecutor,
  results: Array<{ id: string; result?: EvaluationResult; error?: string }>,
  logger: Logger,
): Promise<void> {
  for (const entry of plan.batch) {
    try {
      const result = await execute(entry);
      results.push({ id: entry.id, result });
      logger.info({ id: entry.id, status: result.status }, 'scheduled eval done');
      if (result.status === 'queued') break; // budget reached: the rest waits for next week
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        results.push({ id: entry.id, error: error.message });
        logger.warn({ id: entry.id, err: error.message }, 'batch ceiling reached; batch stopped');
        break;
      }
      const message = error instanceof Error ? error.message : String(error);
      results.push({ id: entry.id, error: message });
      logger.error({ id: entry.id, err: error }, 'scheduled eval failed');
    }
  }
}

/** The real executor: the M9 two-stage harness in Docker. Opens its own eval context. */
export async function createEvalExecutor(spendCeiling?: {
  limitUsd: number;
  since: Date;
}): Promise<{
  execute: AutoEvalExecutor;
  close: () => Promise<void>;
}> {
  const c = await createCommandContext();
  const ctx = { ...(await createRunContext(c, true)), ...(spendCeiling ? { spendCeiling } : {}) };
  const fetchSkill = createSkillFetcher(c.http, {
    apiUrl: c.config.GITHUB_API_URL,
    rawUrl: c.config.GITHUB_RAW_URL,
    ...(c.config.GITHUB_TOKEN ? { token: c.config.GITHUB_TOKEN } : {}),
  });
  const tool = async (id: string) =>
    resolveToolSetup(await loadEvalItem(c.db, id), c.overrides, fetchSkill);
  return {
    execute: async (entry) =>
      evaluateCandidate(ctx, {
        candidate: await tool(entry.id),
        incumbent: entry.incumbentId ? await tool(entry.incumbentId) : null,
        taskSet: await loadTaskSet(entry.category),
      }),
    close: c.close,
  };
}
