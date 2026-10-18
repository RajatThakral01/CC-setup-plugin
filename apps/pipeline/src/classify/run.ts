import type { LlmClient, Logger } from '@cc-setup-agent/core';
import { BudgetExceededError, asc, catalogItems, eq, type Db } from '@cc-setup-agent/db';
import type { AppConfig, Classification } from '@cc-setup-agent/shared';
import type { GithubClient } from '../sources/github.js';
import type { NpmClient } from '../sources/npm.js';
import { parseSourceUrl } from '../sources/urls.js';
import { classifyTool } from './classifier.js';

export interface ClassifyDeps {
  db: Db;
  llm: LlmClient;
  github: GithubClient;
  npm: NpmClient;
  config: AppConfig;
  logger: Logger;
}

export interface ClassifyReport {
  classified: number;
  needsManual: number;
  /** Left pending because the classification budget ran out (queued for next week). */
  queuedByBudget: number;
  failed: number;
  costUsd: number;
  stoppedBy?: string;
}

/** Stop after this many consecutive API failures (e.g. a bad key) instead of hammering the API. */
const MAX_CONSECUTIVE_FAILURES = 3;

async function fetchReadme(deps: ClassifyDeps, sourceUrl: string): Promise<string | null> {
  const ref = parseSourceUrl(sourceUrl);
  try {
    if (ref?.type === 'github') {
      const folder = ref.path && ref.ref ? { path: ref.path, ref: ref.ref } : undefined;
      return (await deps.github.getReadme(`${ref.owner}/${ref.repo}`, folder)) ?? null;
    }
    if (ref?.type === 'npm') return (await deps.npm.getPackument(ref.name)).readme ?? null;
  } catch (error) {
    // A missing README lowers classification quality but must not block it.
    deps.logger.warn({ sourceUrl, err: error }, 'readme fetch failed; classifying without it');
  }
  return null;
}

/** Fills only fields that are still empty, so owner-approved seed hints always win. */
export function applyClassification(
  item: Pick<typeof catalogItems.$inferSelect, 'kind' | 'category' | 'stacks' | 'provenance'>,
  c: Classification,
): Partial<typeof catalogItems.$inferInsert> {
  return {
    kind: item.kind ?? c.kind,
    category: item.category ?? c.category,
    stacks: item.stacks.length > 0 ? item.stacks : c.stacks,
    provenance: item.provenance ?? c.provenanceGuess,
    classification: c,
    classificationState: 'classified',
  };
}

/** Classifies every `pending` item (FR-D9), oldest first, until done or out of budget. */
export async function classifyPending(
  deps: ClassifyDeps,
  options: { limit?: number } = {},
): Promise<ClassifyReport> {
  const report: ClassifyReport = {
    classified: 0,
    needsManual: 0,
    queuedByBudget: 0,
    failed: 0,
    costUsd: 0,
  };
  const pending = await deps.db
    .select()
    .from(catalogItems)
    .where(eq(catalogItems.classificationState, 'pending'))
    .orderBy(asc(catalogItems.firstSeen), asc(catalogItems.id))
    .limit(options.limit ?? 10_000);

  let consecutiveFailures = 0;
  for (const [index, item] of pending.entries()) {
    const readme = await fetchReadme(deps, item.sourceUrl);
    try {
      const outcome = await classifyTool(
        deps.llm,
        {
          name: item.name,
          publisher: item.publisher,
          sourceUrl: item.sourceUrl,
          kindHint: item.kind,
          description: item.description,
          readme,
        },
        {
          model: deps.config.MODEL_FAST,
          maxTokens: deps.config.CLASSIFY_MAX_TOKENS,
          readmeChars: deps.config.CLASSIFY_README_CHARS,
          ref: `classify:${item.id}`,
        },
      );
      consecutiveFailures = 0;
      report.costUsd += outcome.costUsd;
      if (outcome.ok) {
        await deps.db
          .update(catalogItems)
          .set(applyClassification(item, outcome.classification))
          .where(eq(catalogItems.id, item.id));
        report.classified++;
      } else {
        await deps.db
          .update(catalogItems)
          .set({ classificationState: 'needs_manual_classification' })
          .where(eq(catalogItems.id, item.id));
        report.needsManual++;
        deps.logger.warn(
          { id: item.id, error: outcome.error },
          'classification needs manual review',
        );
      }
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        report.queuedByBudget = pending.length - index;
        report.stoppedBy = error.message;
        deps.logger.warn(
          { queued: report.queuedByBudget, limitedBy: error.limitedBy },
          'classification budget exhausted; rest stays queued',
        );
        break;
      }
      report.failed++;
      consecutiveFailures++;
      deps.logger.error(
        { id: item.id, err: error },
        'classification call failed; item stays pending',
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        report.stoppedBy = `${MAX_CONSECUTIVE_FAILURES} consecutive API failures`;
        break;
      }
    }
  }
  return report;
}
