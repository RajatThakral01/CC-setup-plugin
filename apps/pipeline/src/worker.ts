import { PgBoss } from 'pg-boss';
import type { PipelineContext } from './context.js';
import { formatDiscoveryReport, runDiscoveryJob } from './discovery/job.js';
import { readVendors } from './catalog-config.js';
import { runGates } from './gates/run.js';

export const DISCOVERY_QUEUE = 'discovery-daily';
export const GATES_QUEUE = 'gates-daily';

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
  ctx.logger.info(
    { discovery: ctx.config.DISCOVERY_CRON, gates: ctx.config.GATES_CRON },
    'worker started',
  );
  return () => boss.stop({ graceful: true });
}
