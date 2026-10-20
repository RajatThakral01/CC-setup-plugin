/**
 * Pipeline CLI: `pnpm run pipeline <command> [options]`. Thin wrapper; job logic lives in modules.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError } from '@cc-setup-agent/core';
import { liftVeto, spendSummary, vetoItem } from '@cc-setup-agent/db';
import { isoWeekStart } from '@cc-setup-agent/shared';
import { readCategoryRules, readPolicy, readVendors } from './catalog-config.js';
import {
  agreementLabel,
  evaluatePrompt,
  growAgreementGold,
  loadGoldSet,
  readGoldFile,
} from './classify/gold.js';
import { loadPolicyFacts } from './policy/facts.js';
import { classifyPending } from './classify/run.js';
import { runAutoEvals } from './policy/auto-evals.js';
import { writeDigest } from './policy/jobs.js';
import { formatPolicyReport, runPolicy } from './policy/run.js';
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
  classify [--limit <n>] [--stale | --changed | --all]
                                       Classify pending items (costs money); --stale also redoes older prompt
                                       versions; --changed only items whose README, components or description
                                       changed (input hash); --all every non-rejected item (owner-set fields
                                       kept), --all --item <id>... only those items
  classify:eval [--prompt <version>] [--model strong]
                                       Score a prompt version on each gold tier and record it (costs money)
  classify:gold [--grow]               Show gold-set sizes; --grow adds new high-agreement labels
  policy [--dry-run] [--no-second-opinions] [--item <id>]...
                                       Run the approval policy (catalog/policy.yaml); second opinions cost money
  digest [--week YYYY-MM-DD]           Write the weekly policy digest to REPORTS_DIR
  veto | unveto --item <id>... --reason "<why>" --by <owner name>
                                       Owner veto (same audited path as the triage button)
  auto-evals --dry-run | --confirm-spend [--max-usd <n>]
                                       Plan (and run) this week's scheduled eval batch
  gates [--item <id>]... | --pending | --recheck | --all  [--limit <n>]
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
          changed: { type: 'boolean' },
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
            changed: values.changed === true,
            all: values.all === true,
            ...(values.item ? { itemIds: values.item } : {}),
          },
        );
        out(JSON.stringify(report, null, 2));
        return report.failed > 0 ? 1 : 0;
      });
    }
    case 'veto':
    case 'unveto': {
      const { values } = parseArgs({
        args: rest,
        options: {
          item: { type: 'string', multiple: true },
          reason: { type: 'string' },
          by: { type: 'string' },
        },
      });
      if (!values.item?.length || !values.reason || !values.by)
        throw new Error(`${command} needs --item <id>... --reason "<why>" --by <owner name>`);
      return withContext(async (ctx) => {
        for (const id of values.item!) {
          if (command === 'veto') {
            const status = await vetoItem(ctx.db, id, `human:${values.by}`, values.reason!);
            out(`${id}: vetoed (now ${status})`);
          } else {
            await liftVeto(ctx.db, id, `human:${values.by}`, values.reason!);
            out(`${id}: veto lifted`);
          }
        }
        return 0;
      });
    }
    case 'classify:eval': {
      const { values } = parseArgs({
        args: rest,
        options: { prompt: { type: 'string' }, model: { type: 'string' } },
      });
      return withContext(async (ctx) => {
        const gold = await loadGoldSet(ctx.db, await readGoldFile());
        const r = await evaluatePrompt({ ...ctx, llm: ctx.llm() }, gold, {
          ...(values.prompt ? { promptVersion: values.prompt } : {}),
          ...(values.model === 'strong' ? { model: ctx.config.MODEL_STRONG } : {}),
        });
        for (const t of r.tiers)
          out(
            `${r.promptVersion} with ${r.model}, ${t.tier} labels: ${t.correct}/${t.goldSize} correct (score ${t.score.toFixed(3)}), gold set ${t.goldSetHash}`,
          );
        out(`USD ${r.costUsd.toFixed(4)}`);
        for (const d of r.details.filter((x) => !x.correct))
          out(`  wrong (${d.tier}): ${d.id} (${d.source}): ${d.mismatches.join('; ')}`);
        return 0;
      });
    }
    case 'classify:gold': {
      const { values } = parseArgs({ args: rest, options: { grow: { type: 'boolean' } } });
      return withContext(async (ctx) => {
        const facts = await loadPolicyFacts(ctx.db, await readCategoryRules(), new Date());
        const candidates = facts.flatMap((f) => {
          const label = agreementLabel(
            f.item.classification,
            f.item.classificationInputHash,
            f.item.secondOpinion,
            f.rules,
          );
          return label ? [{ id: f.item.id, label }] : [];
        });
        const added = values.grow
          ? await growAgreementGold(candidates, new Date().toISOString().slice(0, 10))
          : [];
        const gold = await loadGoldSet(ctx.db, await readGoldFile());
        out(
          `High-agreement candidates now: ${candidates.length}; added: ${added.length}${values.grow ? '' : ' (use --grow to write them)'}`,
        );
        for (const tier of ['owner', 'agreement'] as const)
          out(`${tier} labels: ${gold.filter((g) => g.tier === tier).length}`);
        return 0;
      });
    }
    case 'policy': {
      const { values } = parseArgs({
        args: rest,
        options: {
          'dry-run': { type: 'boolean' },
          'no-second-opinions': { type: 'boolean' },
          item: { type: 'string', multiple: true },
        },
      });
      return withContext(async (ctx) => {
        const secondOpinions = !values['no-second-opinions'];
        const apply = !values['dry-run'];
        const report = await runPolicy(
          {
            db: ctx.db,
            config: ctx.config,
            logger: ctx.logger,
            github: ctx.github,
            npm: ctx.npm,
            policy: await readPolicy(),
            rules: await readCategoryRules(),
            ...(secondOpinions ? { llm: ctx.llm() } : {}),
          },
          { apply, secondOpinions, ...(values.item ? { itemIds: values.item } : {}) },
        );
        out(formatPolicyReport(report, apply));
        return report.outcomes.some((o) => o.error) ? 1 : 0;
      });
    }
    case 'digest': {
      const { values } = parseArgs({ args: rest, options: { week: { type: 'string' } } });
      return withContext(async (ctx) => {
        const week = isoWeekStart(values.week ? new Date(`${values.week}T00:00:00Z`) : new Date());
        out(`Digest written to ${await writeDigest(ctx, week)}`);
        return 0;
      });
    }
    case 'auto-evals': {
      const { values } = parseArgs({
        args: rest,
        options: {
          'dry-run': { type: 'boolean' },
          'confirm-spend': { type: 'boolean' },
          'max-usd': { type: 'string' },
        },
      });
      return withContext(async (ctx) => {
        const { plan, results } = await runAutoEvals(
          { ...ctx, policy: await readPolicy(), rules: await readCategoryRules() },
          {
            trigger: 'manual',
            dryRun: values['dry-run'] === true,
            confirmSpend: values['confirm-spend'] === true,
            ...(values['max-usd'] ? { maxUsd: Number(values['max-usd']) } : {}),
            onPlan: async (_p, text) => {
              out(text);
            },
          },
        );
        for (const r of results)
          out(
            `${r.id}: ${r.error ?? (r.result?.status === 'done' ? r.result.summary.verdict : `queued (${r.result?.status === 'queued' ? r.result.reason : ''})`)}`,
          );
        return plan.batch.length > 0 && results.some((r) => r.error) ? 1 : 0;
      });
    }
    case 'gates': {
      const { values } = parseArgs({
        args: rest,
        options: {
          item: { type: 'string', multiple: true },
          pending: { type: 'boolean' },
          recheck: { type: 'boolean' },
          all: { type: 'boolean' },
          limit: { type: 'string' },
        },
      });
      const selection: GateSelection = values.item
        ? { itemIds: values.item }
        : { mode: values.all ? 'all' : values.recheck ? 'recheck' : 'pending' };
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
