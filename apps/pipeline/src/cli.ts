/**
 * Pipeline CLI: `pnpm run pipeline <command> [options]`. Thin wrapper; job logic lives in modules.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError } from '@cc-setup-agent/core';
import { spendSummary } from '@cc-setup-agent/db';
import { readVendors } from './catalog-config.js';
import { classifyPending } from './classify/run.js';
import { createContext, type PipelineContext } from './context.js';
import { formatDiscoveryReport, runDiscoveryJob } from './discovery/job.js';
import { SOURCE_NAMES, type SourceName } from './discovery/run.js';
import { runIntake } from './intake/run.js';
import { formatSeedReport, importSeed } from './seed/import.js';
import { readSeedFile } from './seed/seed-file.js';
import { startWorker } from './worker.js';
import { runGates, type GateSelection } from './gates/run.js';
import { publishSnapshot } from './snapshot/run.js';
import { createSnapshotStore } from './snapshot/store.js';

const DEFAULT_SEED_FILE = fileURLToPath(new URL('../../../catalog/seed.yaml', import.meta.url));

const USAGE = `Usage: pnpm run pipeline <command>

Commands:
  seed [--file <path>]                 Import catalog/seed.yaml as candidate items
  discover [--source <name>]...        Run discovery sources, then intake and classification
           [--no-intake] [--no-classify]  Sources: ${SOURCE_NAMES.join(', ')}
  intake                               Re-run the intake filter over stored raw records
  classify [--limit <n>] [--stale | --all]     Classify pending items; --stale also redoes older prompt versions;
                                       --all re-classifies every non-rejected item (owner-set fields kept),
                                       --all --item <id>... only those items (costs money)
  gates [--item <id>]... | --pending | --recheck  [--limit <n>]
                                       Run credibility gates 0-3 (Docker sandbox for MCP servers)
  snapshot                             Build, sign and publish a catalog snapshot (SNAPSHOT_STORE)
  worker                               Start the scheduler (daily discovery at DISCOVERY_CRON, UTC)
  spend                                Show Anthropic spend this ISO week and in total`;

async function withContext<T>(fn: (ctx: PipelineContext) => Promise<T>): Promise<T> {
  const ctx = createContext();
  try {
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

const out = (text: string) => process.stdout.write(`${text}\n`);

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'seed': {
      const { values } = parseArgs({ args: rest, options: { file: { type: 'string' } } });
      const entries = await readSeedFile(values.file ? resolve(values.file) : DEFAULT_SEED_FILE);
      return withContext(async (ctx) => {
        const report = await importSeed(ctx, entries);
        out(formatSeedReport(report));
        return report.failed.length > 0 ? 1 : 0;
      });
    }
    case 'discover': {
      const { values } = parseArgs({
        args: rest,
        options: {
          source: { type: 'string', multiple: true },
          'no-intake': { type: 'boolean' },
          'no-classify': { type: 'boolean' },
        },
      });
      const unknown = (values.source ?? []).filter(
        (s) => !(SOURCE_NAMES as readonly string[]).includes(s),
      );
      if (unknown.length > 0)
        throw new Error(
          `Unknown source(s): ${unknown.join(', ')}. Valid: ${SOURCE_NAMES.join(', ')}`,
        );
      return withContext(async (ctx) => {
        const report = await runDiscoveryJob(ctx, {
          ...(values.source ? { sources: values.source as SourceName[] } : {}),
          intake: !values['no-intake'],
          classify: !values['no-classify'],
        });
        out(formatDiscoveryReport(report));
        return report.sources.some((s) => !s.ok) ? 1 : 0;
      });
    }
    case 'intake':
      return withContext(async (ctx) => {
        const report = await runIntake(
          { ...ctx, classify: { llm: ctx.llm(), npm: ctx.npm, config: ctx.config } },
          {
            vendors: await readVendors(),
            minStars: ctx.config.INTAKE_MIN_STARS,
            dailyCap: ctx.config.INTAKE_DAILY_CAP,
            refreshLimit: ctx.config.INTAKE_REFRESH_LIMIT,
            classifyDailyLimit: ctx.config.CLASSIFY_DAILY_RECORD_LIMIT,
          },
        );
        out(JSON.stringify({ ...report, accepted: report.accepted.map((a) => a.id) }, null, 2));
        return 0;
      });
    case 'classify': {
      const { values } = parseArgs({
        args: rest,
        options: {
          limit: { type: 'string' },
          stale: { type: 'boolean' },
          all: { type: 'boolean' },
          item: { type: 'string', multiple: true },
        },
      });
      return withContext(async (ctx) => {
        const report = await classifyPending(
          { ...ctx, llm: ctx.llm() },
          {
            ...(values.limit ? { limit: Number(values.limit) } : {}),
            stale: values.stale === true,
            all: values.all === true,
            ...(values.item ? { itemIds: values.item } : {}),
          },
        );
        out(JSON.stringify(report, null, 2));
        return report.failed > 0 ? 1 : 0;
      });
    }
    case 'gates': {
      const { values } = parseArgs({
        args: rest,
        options: {
          item: { type: 'string', multiple: true },
          pending: { type: 'boolean' },
          recheck: { type: 'boolean' },
          limit: { type: 'string' },
        },
      });
      const selection: GateSelection = values.item
        ? { itemIds: values.item }
        : { mode: values.recheck ? 'recheck' : 'pending' };
      return withContext(async (ctx) => {
        const reports = await runGates(
          { ...ctx, vendors: await readVendors() },
          selection,
          values.limit ? { limit: Number(values.limit) } : {},
        );
        for (const r of reports) {
          out(
            `${r.error ? 'ERROR ' : ''}${r.id} @ ${r.version}  confidence=${r.confidence}  ${Object.entries(
              r.results,
            )
              .map(([k, v]) => `${k.replace(/_.*/, '')}=${v}`)
              .join(
                ' ',
              )}${r.statusChange ? `  → ${r.statusChange.to} (${r.statusChange.reason})` : ''}${r.error ? `  ${r.error}` : ''}`,
          );
        }
        out(`Gated ${reports.length} item(s); ${reports.filter((r) => r.error).length} error(s).`);
        return reports.some((r) => r.error) ? 1 : 0;
      });
    }
    case 'snapshot':
      return withContext(async (ctx) => {
        const r = await publishSnapshot({ ...ctx, store: createSnapshotStore(ctx.config) });
        out(`Snapshot ${r.version}: ${r.itemCount} item(s) ${JSON.stringify(r.byStatus)}`);
        out(`sha256 ${r.sha256}`);
        out(`Published to ${r.location}`);
        for (const s of r.skipped) out(`  skipped ${s.id}: ${s.reason}`);
        return 0;
      });
    case 'spend':
      return withContext(async (ctx) => {
        const s = await spendSummary(ctx.db);
        out(
          `Week of ${s.weekStart}: USD ${s.weekUsd.toFixed(4)} of ${ctx.config.WEEKLY_BUDGET_USD}. ` +
            `Total: USD ${s.totalUsd.toFixed(4)} of ${ctx.config.TOTAL_BUDGET_USD} (warn at ${ctx.config.TOTAL_BUDGET_WARN_USD}).`,
        );
        return 0;
      });
    case 'worker': {
      const ctx = createContext();
      const stop = await startWorker(ctx);
      const shutdown = async () => {
        await stop();
        await ctx.close();
      };
      process.once('SIGINT', () => void shutdown());
      process.once('SIGTERM', () => void shutdown());
      return new Promise<number>(() => undefined);
    }
    default:
      process.stderr.write(`${USAGE}\n`);
      return command === undefined || command === '--help' ? 0 : 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      error instanceof ConfigError
        ? `${error.message}\n`
        : `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
