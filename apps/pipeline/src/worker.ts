import { PgBoss } from 'pg-boss';
import type { PipelineContext } from './context.js';
import { formatDiscoveryReport, runDiscoveryJob } from './discovery/job.js';

export const DISCOVERY_QUEUE = 'discovery-daily';

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
  ctx.logger.info({ cron: ctx.config.DISCOVERY_CRON, queue: DISCOVERY_QUEUE }, 'worker started');
  return () => boss.stop({ graceful: true });
}
