import { spendSummary } from '@cc-setup-agent/db';
import { readSources, readVendors } from '../catalog-config.js';
import { classifyPending, type ClassifyReport } from '../classify/run.js';
import type { PipelineContext } from '../context.js';
import { runIntake, type IntakeReport } from '../intake/run.js';
import { runSources, SOURCE_NAMES, type SourceName, type SourceResult } from './run.js';

export interface DiscoveryJobOptions {
  sources?: readonly SourceName[];
  intake?: boolean;
  classify?: boolean;
}

export interface DiscoveryJobReport {
  sources: SourceResult[];
  intake?: IntakeReport;
  classify?: ClassifyReport;
  spend: { weekStart: string; weekUsd: number; totalUsd: number };
}

/** The daily job: discover → intake → classify. Each stage runs even if a source failed. */
export async function runDiscoveryJob(
  ctx: PipelineContext,
  options: DiscoveryJobOptions = {},
): Promise<DiscoveryJobReport> {
  const now = new Date();
  const sources = await runSources(
    { ...ctx, sources: await readSources() },
    options.sources ?? SOURCE_NAMES,
    now,
  );
  const report: DiscoveryJobReport = { sources, spend: await spendSummary(ctx.db) };
  if (options.intake !== false) {
    report.intake = await runIntake(ctx, {
      vendors: await readVendors(),
      minStars: ctx.config.INTAKE_MIN_STARS,
      dailyCap: ctx.config.INTAKE_DAILY_CAP,
      refreshLimit: ctx.config.INTAKE_REFRESH_LIMIT,
      now,
    });
  }
  if (options.classify !== false) {
    report.classify = await classifyPending({ ...ctx, llm: ctx.llm() });
  }
  report.spend = await spendSummary(ctx.db);
  if (report.spend.totalUsd >= ctx.config.TOTAL_BUDGET_WARN_USD) {
    ctx.logger.warn(
      { totalUsd: report.spend.totalUsd },
      'total Anthropic spend has passed the warning threshold',
    );
  }
  return report;
}

export function formatDiscoveryReport(r: DiscoveryJobReport): string {
  const lines: string[] = ['Sources:'];
  for (const s of r.sources)
    lines.push(
      `  ${s.ok ? 'ok    ' : 'FAILED'} ${s.source}  records=${s.records}${s.error ? `  error=${s.error}` : ''}`,
    );
  if (r.intake) {
    const i = r.intake;
    lines.push(
      `Intake: evaluated=${i.evaluated} accepted=${i.accepted.length} linked=${i.linked} deferred=${i.deferred} filtered=${i.filtered} not_applicable=${i.notApplicable} refreshed=${i.refreshed}`,
      `  filter reasons: ${
        Object.entries(i.reasonCounts)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ') || 'none'
      }`,
      ...i.accepted.map(
        (a) => `  + ${a.id}  ${a.sourceUrl}  (${a.source}${a.vendor ? ', vendor' : ''})`,
      ),
    );
  }
  if (r.classify) {
    const c = r.classify;
    lines.push(
      `Classify: classified=${c.classified} needs_manual=${c.needsManual} queued_by_budget=${c.queuedByBudget} failed=${c.failed} cost=USD ${c.costUsd.toFixed(4)}${c.stoppedBy ? `  stopped: ${c.stoppedBy}` : ''}`,
    );
  }
  lines.push(
    `Spend: this week USD ${r.spend.weekUsd.toFixed(4)}, total USD ${r.spend.totalUsd.toFixed(4)}`,
  );
  return lines.join('\n');
}
