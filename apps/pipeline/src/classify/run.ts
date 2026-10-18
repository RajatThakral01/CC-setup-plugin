import type { LlmClient, Logger } from '@cc-setup-agent/core';
import {
  BudgetExceededError,
  and,
  asc,
  catalogItems,
  eq,
  isNull,
  ne,
  or,
  sql,
  statusEvents,
  type Db,
  type DbOrTx,
} from '@cc-setup-agent/db';
import { isNextjsRelevant, type AppConfig, type Classification } from '@cc-setup-agent/shared';
import type { GithubClient } from '../sources/github.js';
import type { NpmClient } from '../sources/npm.js';
import { parseSourceUrl } from '../sources/urls.js';
import {
  classifyTool,
  PROMPT_VERSION,
  type ClassifierInput,
  type ClassifyOutcome,
} from './classifier.js';

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
export const MAX_CONSECUTIVE_FAILURES = 3;

export async function fetchReadme(
  deps: Pick<ClassifyDeps, 'github' | 'npm' | 'logger'>,
  sourceUrl: string,
): Promise<string | null> {
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

/** README lookup plus one classification (with its single retry). */
export async function classifySource(
  deps: Pick<ClassifyDeps, 'llm' | 'github' | 'npm' | 'logger' | 'config'>,
  input: Omit<ClassifierInput, 'readme'>,
  ref: string,
): Promise<ClassifyOutcome> {
  const readme = await fetchReadme(deps, input.sourceUrl);
  return classifyTool(
    deps.llm,
    { ...input, readme },
    {
      model: deps.config.MODEL_FAST,
      maxTokens: deps.config.CLASSIFY_MAX_TOKENS,
      readmeChars: deps.config.CLASSIFY_README_CHARS,
      ref,
    },
  );
}

type ItemRow = typeof catalogItems.$inferSelect;

/**
 * Fields to update from a classification. Empty fields are always filled. On intake-created items
 * a field that still holds the previous classification's value is replaced too; seeded items keep
 * their owner-approved hints untouched.
 */
export function applyClassification(
  item: Pick<ItemRow, 'kind' | 'category' | 'stacks' | 'provenance' | 'classification'>,
  c: Classification,
  intakeCreated: boolean,
): Partial<typeof catalogItems.$inferInsert> {
  const prev = intakeCreated ? item.classification : null;
  const replaceable = <T>(current: T, previous: T | undefined) =>
    current === null || (prev !== null && JSON.stringify(current) === JSON.stringify(previous));
  return {
    kind: replaceable(item.kind, prev?.kind) ? c.kind : item.kind,
    category: replaceable(item.category, prev?.category) ? c.category : item.category,
    stacks:
      item.stacks.length === 0 || replaceable(item.stacks, prev?.stacks) ? c.stacks : item.stacks,
    provenance: replaceable(item.provenance, prev?.provenanceGuess)
      ? c.provenanceGuess
      : item.provenance,
    classification: c,
    classificationState: 'classified',
  };
}

/**
 * Out-of-scope stacks for an item. Only intake-created items are scoped automatically; items the
 * owner seeded were approved for Next.js and are never hidden by the classifier.
 */
export function outOfScopeFor(c: Classification, intakeCreated: boolean): string[] {
  return intakeCreated && !isNextjsRelevant(c) ? ['nextjs'] : [];
}

export async function isIntakeCreated(db: DbOrTx, itemId: string): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(statusEvents)
    .where(
      and(
        eq(statusEvents.itemId, itemId),
        isNull(statusEvents.fromStatus),
        sql`${statusEvents.reason} like 'discovery intake%'`,
      ),
    );
  return (row?.n ?? 0) > 0;
}

/**
 * Classifies `pending` items (FR-D9), oldest first, until done or out of budget. With `stale`,
 * also re-classifies items classified by an older prompt version.
 */
export async function classifyPending(
  deps: ClassifyDeps,
  options: { limit?: number; stale?: boolean } = {},
): Promise<ClassifyReport> {
  const report: ClassifyReport = {
    classified: 0,
    needsManual: 0,
    queuedByBudget: 0,
    failed: 0,
    costUsd: 0,
  };
  const pendingFilter = eq(catalogItems.classificationState, 'pending');
  const items = await deps.db
    .select()
    .from(catalogItems)
    .where(
      options.stale
        ? or(
            pendingFilter,
            and(
              eq(catalogItems.classificationState, 'classified'),
              ne(sql`${catalogItems.classification}->>'promptVersion'`, PROMPT_VERSION),
            ),
          )
        : pendingFilter,
    )
    .orderBy(asc(catalogItems.firstSeen), asc(catalogItems.id))
    .limit(options.limit ?? 10_000);

  let consecutiveFailures = 0;
  for (const [index, item] of items.entries()) {
    try {
      const outcome = await classifySource(
        deps,
        {
          name: item.name,
          publisher: item.publisher,
          sourceUrl: item.sourceUrl,
          kindHint: item.kind,
          description: item.description,
        },
        `classify:${item.id}`,
      );
      consecutiveFailures = 0;
      report.costUsd += outcome.costUsd;
      if (outcome.ok) {
        const intake = await isIntakeCreated(deps.db, item.id);
        await deps.db
          .update(catalogItems)
          .set({
            ...applyClassification(item, outcome.classification, intake),
            outOfScope: outOfScopeFor(outcome.classification, intake),
          })
          .where(eq(catalogItems.id, item.id));
        report.classified++;
      } else {
        // A failed re-classification keeps the previous result.
        if (item.classificationState === 'pending') {
          await deps.db
            .update(catalogItems)
            .set({ classificationState: 'needs_manual_classification' })
            .where(eq(catalogItems.id, item.id));
        }
        report.needsManual++;
        deps.logger.warn(
          { id: item.id, error: outcome.error },
          'classification needs manual review',
        );
      }
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        report.queuedByBudget = items.length - index;
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
        'classification call failed; item stays as it was',
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        report.stoppedBy = `${MAX_CONSECUTIVE_FAILURES} consecutive API failures`;
        break;
      }
    }
  }
  return report;
}
