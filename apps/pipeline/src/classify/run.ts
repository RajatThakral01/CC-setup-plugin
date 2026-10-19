import type { LlmClient, Logger } from '@cc-setup-agent/core';
import {
  BudgetExceededError,
  and,
  asc,
  catalogItems,
  desc,
  eq,
  inArray,
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
import {
  classificationInputHash,
  classifyTool,
  PROMPT_VERSION,
  type ClassifierInput,
  type ClassifyOutcome,
} from './classifier.js';
import { loadGoldSet, promptGate, PromptGateError, readGoldFile } from './gold.js';
import { fetchReadme } from './readme.js';

export { fetchReadme } from './readme.js';

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
  /** Items whose kind or category changed (an optional view in triage). */
  changes: ClassificationChange[];
  /** `--changed`: items skipped because their inputs and prompt version are unchanged. */
  unchanged: number;
}

/** Stop after this many consecutive API failures (e.g. a bad key) instead of hammering the API. */
export const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * README lookup plus one classification (with its single retry). Returns the hash of the inputs
 * the classifier saw. `readme` skips the lookup when the caller already fetched it.
 */
export async function classifySource(
  deps: Pick<ClassifyDeps, 'llm' | 'github' | 'npm' | 'logger' | 'config'>,
  input: Omit<ClassifierInput, 'readme'>,
  ref: string,
  options: { model?: string; promptVersion?: string; readme?: string | null } = {},
): Promise<ClassifyOutcome & { inputHash: string }> {
  const readme =
    options.readme !== undefined ? options.readme : await fetchReadme(deps, input.sourceUrl);
  const outcome = await classifyTool(
    deps.llm,
    { ...input, readme },
    {
      model: options.model ?? deps.config.MODEL_FAST,
      maxTokens: deps.config.CLASSIFY_MAX_TOKENS,
      readmeChars: deps.config.CLASSIFY_README_CHARS,
      ref,
      ...(options.promptVersion ? { promptVersion: options.promptVersion } : {}),
    },
  );
  return { ...outcome, inputHash: classificationInputHash({ ...input, readme }) };
}

/**
 * Refuses to classify with a prompt version that hasn't earned it (PRD FR-D9a): the version in use
 * is fine; a new one needs a gold-set score at least as good as the current one.
 */
export async function assertPromptApplicable(
  deps: Pick<ClassifyDeps, 'db' | 'config'>,
  loadGold = async () => loadGoldSet(deps.db, await readGoldFile()),
): Promise<void> {
  const gate = await promptGate(deps.db, PROMPT_VERSION, deps.config.MODEL_FAST, loadGold);
  if (!gate.ok) throw new PromptGateError(`prompt ${PROMPT_VERSION} not applied: ${gate.reason}`);
}

type ItemRow = typeof catalogItems.$inferSelect;

export type ApplyMode =
  /** Normal runs: fill empty fields; intake items also replace the previous classification's values. */
  | { kind: 'normal'; intakeCreated: boolean }
  /** Owner-requested re-classification of the whole catalog: replace everything not owner-set. */
  | { kind: 'all' };

/**
 * Fields to update from a classification. Owner-set kind or category (set in triage) is never
 * replaced. In a normal run, empty fields are always filled, and on intake-created items a field
 * that still holds the previous classification's value is replaced too; seed hints are kept. A
 * re-classification of everything (`all`) replaces kind, category and stacks unless owner-set.
 * Technologies always come from the newest classification (only the classifier sets them).
 */
export function applyClassification(
  item: Pick<
    ItemRow,
    | 'kind'
    | 'category'
    | 'stacks'
    | 'provenance'
    | 'classification'
    | 'kindSetBy'
    | 'categorySetBy'
    | 'technologiesSetBy'
  >,
  c: Classification,
  mode: ApplyMode,
): Partial<typeof catalogItems.$inferInsert> {
  const all = mode.kind === 'all';
  const prev = mode.kind === 'normal' && mode.intakeCreated ? item.classification : null;
  const replaceable = <T>(current: T, previous: T | undefined) =>
    all ||
    current === null ||
    (prev !== null && JSON.stringify(current) === JSON.stringify(previous));
  return {
    kind: !item.kindSetBy && replaceable(item.kind, prev?.kind) ? c.kind : item.kind,
    category:
      !item.categorySetBy && replaceable(item.category, prev?.category)
        ? c.category
        : item.category,
    stacks:
      item.stacks.length === 0 || replaceable(item.stacks, prev?.stacks) ? c.stacks : item.stacks,
    provenance:
      item.provenance === null ||
      (prev !== null && JSON.stringify(item.provenance) === JSON.stringify(prev.provenanceGuess))
        ? c.provenanceGuess
        : item.provenance,
    technologies: item.technologiesSetBy ? undefined : c.technologies,
    classification: c,
    classificationState: 'classified',
  };
}

export interface ClassificationChange {
  id: string;
  status: string;
  from: { kind: string | null; category: string | null };
  to: { kind: string | null; category: string | null };
}

/**
 * Out-of-scope stacks for an item. Only intake-created items are scoped automatically; items the
 * owner seeded were approved for Next.js and are never hidden by the classifier.
 */
export function outOfScopeFor(c: Classification, intakeCreated: boolean): string[] {
  return intakeCreated && !isNextjsRelevant(c) ? ['nextjs'] : [];
}

/** The human who approved the item into its current recommended status, if any. */
export async function ownerApprover(
  db: DbOrTx,
  item: Pick<ItemRow, 'id' | 'status'>,
): Promise<string | null> {
  if (item.status !== 'recommended' && item.status !== 'recommended_provisional') return null;
  const [event] = await db
    .select({ actor: statusEvents.actor })
    .from(statusEvents)
    .where(
      and(
        eq(statusEvents.itemId, item.id),
        eq(statusEvents.toStatus, item.status),
        ne(statusEvents.fromStatus, item.status),
      ),
    )
    .orderBy(desc(statusEvents.id))
    .limit(1);
  return event?.actor.startsWith('human:') ? event.actor : null;
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
 * also re-classifies items classified by an older prompt version. With `all`, re-classifies every
 * item that isn't rejected and replaces kind, category and stacks unless the owner set them.
 */
export async function classifyPending(
  deps: ClassifyDeps,
  options: {
    limit?: number;
    stale?: boolean;
    all?: boolean;
    /** Re-classify only items whose inputs (README, components, description) or prompt changed. */
    changed?: boolean;
    itemIds?: string[];
    /** Gold set loader for the prompt gate (tests). */
    loadGold?: Parameters<typeof assertPromptApplicable>[1];
  } = {},
): Promise<ClassifyReport> {
  await assertPromptApplicable(deps, options.loadGold);
  const report: ClassifyReport = {
    classified: 0,
    needsManual: 0,
    queuedByBudget: 0,
    failed: 0,
    costUsd: 0,
    changes: [],
    unchanged: 0,
  };
  const replaceAll = options.all === true || options.changed === true;
  const pendingFilter = eq(catalogItems.classificationState, 'pending');
  const items = await deps.db
    .select()
    .from(catalogItems)
    .where(
      replaceAll
        ? and(
            ne(catalogItems.status, 'rejected'),
            options.itemIds ? inArray(catalogItems.id, options.itemIds) : undefined,
          )
        : options.stale
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
      const input = {
        name: item.name,
        publisher: item.publisher,
        sourceUrl: item.sourceUrl,
        kindHint: item.kind,
        description: item.description,
        components: item.components,
      };
      const readme = await fetchReadme(deps, item.sourceUrl);
      if (
        options.changed &&
        item.classificationState === 'classified' &&
        item.classification?.promptVersion === PROMPT_VERSION &&
        item.classificationInputHash === classificationInputHash({ ...input, readme })
      ) {
        report.unchanged++;
        continue;
      }
      const outcome = await classifySource(deps, input, `classify:${item.id}`, { readme });
      consecutiveFailures = 0;
      report.costUsd += outcome.costUsd;
      if (outcome.ok) {
        const intake = await isIntakeCreated(deps.db, item.id);
        // An owner approval stays valid (M8.3): the kind and category it was approved with are
        // kept like owner-set fields, so a re-classification can't drop it from the catalog.
        const approver = await ownerApprover(deps.db, item);
        const update = applyClassification(
          approver
            ? {
                ...item,
                kindSetBy: item.kindSetBy ?? approver,
                categorySetBy: item.categorySetBy ?? approver,
              }
            : item,
          outcome.classification,
          replaceAll ? { kind: 'all' } : { kind: 'normal', intakeCreated: intake },
        );
        const changed = update.kind !== item.kind || update.category !== item.category;
        if (changed) {
          report.changes.push({
            id: item.id,
            status: item.status,
            from: { kind: item.kind, category: item.category },
            to: { kind: update.kind ?? null, category: update.category ?? null },
          });
        }
        await deps.db
          .update(catalogItems)
          .set({
            ...update,
            classificationInputHash: outcome.inputHash,
            outOfScope: outOfScopeFor(outcome.classification, intake),
            ...(changed
              ? {
                  classificationReview: {
                    previousKind: item.kind,
                    previousCategory: item.category,
                    promptVersion: outcome.classification.promptVersion,
                    changedAt: outcome.classification.classifiedAt,
                  },
                }
              : {}),
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

export type SecondOpinionResult =
  | { ok: true; costUsd: number; agreesOnCategory: boolean }
  | { ok: false; costUsd: number; reason: string };

/**
 * Strong-model second opinion (PRD FR-D9a) with the same prompt version and the same inputs as the
 * item's current classification. When the inputs changed since, nothing is asked: the item needs
 * re-classification first (`classify --changed`). Costs money; goes through the ledger.
 */
export async function requestSecondOpinion(
  deps: ClassifyDeps,
  item: ItemRow,
): Promise<SecondOpinionResult> {
  const primary = item.classification;
  if (!primary || !item.classificationInputHash)
    return { ok: false, costUsd: 0, reason: 'no current classification with recorded inputs' };
  const input = {
    name: item.name,
    publisher: item.publisher,
    sourceUrl: item.sourceUrl,
    kindHint: item.kind,
    description: item.description,
    components: item.components,
  };
  const readme = await fetchReadme(deps, item.sourceUrl);
  if (classificationInputHash({ ...input, readme }) !== item.classificationInputHash)
    return { ok: false, costUsd: 0, reason: 'inputs changed since classification' };
  const outcome = await classifySource(deps, input, `second-opinion:${item.id}`, {
    model: deps.config.MODEL_STRONG,
    promptVersion: primary.promptVersion,
    readme,
  });
  if (!outcome.ok) return { ok: false, costUsd: outcome.costUsd, reason: outcome.error };
  await deps.db
    .update(catalogItems)
    .set({ secondOpinion: { ...outcome.classification, inputHash: outcome.inputHash } })
    .where(eq(catalogItems.id, item.id));
  return {
    ok: true,
    costUsd: outcome.costUsd,
    agreesOnCategory: outcome.classification.category === item.category,
  };
}
