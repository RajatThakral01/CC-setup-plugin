import { PgBoss } from 'pg-boss';
import type { PipelineContext } from './context.js';
import { formatDiscoveryReport, runDiscoveryJob } from './discovery/job.js';
import { readVendors } from './catalog-config.js';
import { runGates } from './gates/run.js';
import { readPolicy } from './catalog-config.js';
import { runCurationJob, runScheduledEvals, runWeeklyDigest } from './policy/jobs.js';

export const DISCOVERY_QUEUE = 'discovery-daily';
export const GATES_QUEUE = 'gates-daily';
export const POLICY_QUEUE = 'policy-daily';
export const EVALS_QUEUE = 'evals-weekly';
export const DIGEST_QUEUE = 'digest-weekly';

/** Long-running worker: schedules the daily discovery job (02:00 UTC by default) and runs it. */
export async function startWorker(ctx: PipelineContext): Promise<() => Promise<void>> {
  const boss = new PgBoss(ctx.config.DATABASE_URL);
  boss.on('error', (error) => ctx.logger.error({ err: error }, 'pg-boss error'));
  await boss.start();
  await boss.createQueue(DISCOVERY_QUEUE);
  await boss.schedule(DISCOVERY_QUEUE, ctx.config.DISCOVERY_CRON, {}, { tz: 'UTC' });
  await boss.work(DISCOVERY_QUEUE, async () => {
    const report = await runDiscoveryJob(ctx);
    ctx.logger.info({ summary: formatDiscoveryReport(report) }, 'discovery job finished');
  });
  // Gates for new candidates, plus the 30-day re-check of recommended items (FR-C8).
  await boss.createQueue(GATES_QUEUE);
  await boss.schedule(GATES_QUEUE, ctx.config.GATES_CRON, {}, { tz: 'UTC' });
  await boss.work(GATES_QUEUE, async () => {
    const deps = { ...ctx, vendors: await readVendors() };
    const pending = await runGates(deps, { mode: 'pending' });
    const recheck = await runGates(deps, { mode: 'recheck' });
    ctx.logger.info({ pending: pending.length, recheck: recheck.length }, 'gates job finished');
  });
  // Autonomous curation (PRD 9.2a): daily re-classification and policy, weekly evals and digest.
  const evalsCron = (await readPolicy()).auto_evals.cron;
  for (const [queue, cron, job] of [
    [POLICY_QUEUE, ctx.config.POLICY_CRON, runCurationJob],
    [EVALS_QUEUE, evalsCron, runScheduledEvals],
    [DIGEST_QUEUE, ctx.config.DIGEST_CRON, runWeeklyDigest],
  ] as const) {
    await boss.createQueue(queue);
    await boss.schedule(queue, cron, {}, { tz: 'UTC' });
    await boss.work(queue, async () => job(ctx));
  }
  ctx.logger.info(
    {
      discovery: ctx.config.DISCOVERY_CRON,
      gates: ctx.config.GATES_CRON,
      policy: ctx.config.POLICY_CRON,
      evals: evalsCron,
      digest: ctx.config.DIGEST_CRON,
    },
    'worker started',
  );
  return () => boss.stop({ graceful: true });
}
