import { BudgetExceededError, buildDigest } from '@cc-setup-agent/db';
import { isoWeekStart } from '@cc-setup-agent/shared';
import { readCategoryRules, readPolicy } from '../catalog-config.js';
import { classifyPending } from '../classify/run.js';
import type { PipelineContext } from '../context.js';
import { runAutoEvals } from './auto-evals.js';
import { renderDigestMarkdown, writeReport } from './digest.js';
import { formatPolicyReport, runPolicy } from './run.js';

const triageUrl = (ctx: Pick<PipelineContext, 'config'>) =>
  `http://${ctx.config.TRIAGE_HOST}:${ctx.config.TRIAGE_PORT}`;

/** Writes the digest for the ISO week starting `weekStart` (PRD FR-P8); returns the file path. */
export async function writeDigest(
  ctx: Pick<PipelineContext, 'db' | 'config'>,
  weekStart: string,
): Promise<string> {
  const digest = await buildDigest(ctx.db, weekStart);
  return writeReport(
    ctx.config.REPORTS_DIR,
    `digest-${weekStart}.md`,
    renderDigestMarkdown(digest, triageUrl(ctx)),
  );
}

/**
 * Daily curation (after the gates): re-classify items whose inputs changed, then run the approval
 * policy with second opinions. A budget stop in classification doesn't stop the policy: items
 * without a fresh classification simply stay unapproved.
 */
export async function runCurationJob(ctx: PipelineContext): Promise<void> {
  try {
    const c = await classifyPending({ ...ctx, llm: ctx.llm() }, { changed: true });
    ctx.logger.info(
      { classified: c.classified, unchanged: c.unchanged, costUsd: c.costUsd },
      'classify --changed finished',
    );
  } catch (error) {
    if (!(error instanceof BudgetExceededError)) throw error;
    ctx.logger.warn({ err: error.message }, 'classification budget reached');
  }
  const report = await runPolicy(
    { ...ctx, policy: await readPolicy(), rules: await readCategoryRules(), llm: ctx.llm() },
    { apply: true, secondOpinions: true },
  );
  ctx.logger.info({ summary: formatPolicyReport(report, true) }, 'policy run finished');
}

/** Weekly scheduled evals (PRD FR-P7): the plan is written to REPORTS_DIR before any spend. */
export async function runScheduledEvals(ctx: PipelineContext): Promise<void> {
  const now = new Date();
  await runAutoEvals(
    { ...ctx, policy: await readPolicy(), rules: await readCategoryRules() },
    {
      trigger: 'scheduled',
      now,
      onPlan: async (plan, text) => {
        await writeReport(ctx.config.REPORTS_DIR, `eval-plan-${plan.weekStart}.md`, text);
      },
    },
  );
}

export async function runWeeklyDigest(ctx: PipelineContext): Promise<void> {
  // The digest covers the week that just ended (the job runs on Monday morning).
  const lastWeek = isoWeekStart(new Date(Date.now() - 7 * 86_400_000));
  ctx.logger.info({ path: await writeDigest(ctx, lastWeek) }, 'weekly digest written');
}
