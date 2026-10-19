import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import { AppError } from '@cc-setup-agent/core';
import {
  and,
  catalogItems,
  classifierEvals,
  desc,
  eq,
  inArray,
  ne,
  or,
  sql,
  type Db,
} from '@cc-setup-agent/db';
import {
  categorySchema,
  itemIdSchema,
  kindSchema,
  type Category,
  type Classification,
  type Kind,
} from '@cc-setup-agent/shared';
import { CATALOG_DIR } from '../catalog-config.js';
import { classifyTool, PROMPT_VERSION, PROMPTS } from './classifier.js';
import { fetchReadme } from './readme.js';
import type { ClassifyDeps } from './run.js';

/**
 * The classification gold set (PRD FR-D9a): owner-locked fields from the database, plus the
 * frozen file `catalog/classification-gold.yaml` (kind and category of items the owner approved,
 * as they were when approved). Owner-locked fields win over the file.
 */
export const goldFileSchema = z.object({
  items: z
    .array(
      z.object({
        id: itemIdSchema,
        kind: kindSchema.optional(),
        category: categorySchema.nullable().optional(),
        source: z.string().min(1),
      }),
    )
    .default([]),
});

export interface GoldEntry {
  id: string;
  kind?: Kind;
  category?: Category | null;
  source: string;
}

export const readGoldFile = async (path = `${CATALOG_DIR}/classification-gold.yaml`) =>
  goldFileSchema.parse(parse(await readFile(path, 'utf8')) ?? {}).items;

export async function loadGoldSet(db: Db, fileEntries: GoldEntry[]): Promise<GoldEntry[]> {
  const locked = await db
    .select({
      id: catalogItems.id,
      kind: catalogItems.kind,
      category: catalogItems.category,
      kindSetBy: catalogItems.kindSetBy,
      categorySetBy: catalogItems.categorySetBy,
    })
    .from(catalogItems)
    .where(
      or(
        sql`${catalogItems.kindSetBy} is not null`,
        sql`${catalogItems.categorySetBy} is not null`,
      ),
    );
  const byId = new Map(fileEntries.map((e) => [e.id, { ...e }]));
  for (const r of locked) {
    const entry: GoldEntry = byId.get(r.id) ?? { id: r.id, source: 'owner-locked' };
    if (r.kindSetBy && r.kind) entry.kind = r.kind;
    if (r.categorySetBy) entry.category = r.category;
    entry.source = `owner-locked (${[r.kindSetBy && 'kind', r.categorySetBy && 'category'].filter(Boolean).join(', ')})`;
    byId.set(r.id, entry);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function goldSetHash(entries: GoldEntry[]): string {
  const material = JSON.stringify(entries.map((e) => [e.id, e.kind ?? null, e.category ?? null]));
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/** Compares a classification with a gold entry, only on the fields the entry has. */
export function scoreAgainstGold(
  gold: GoldEntry,
  c: Pick<Classification, 'kind' | 'category'> | null,
): { correct: boolean; mismatches: string[] } {
  if (!c) return { correct: false, mismatches: ['no classification'] };
  const mismatches: string[] = [];
  if (gold.kind !== undefined && gold.kind !== c.kind)
    mismatches.push(`kind ${c.kind} (gold ${gold.kind})`);
  if (gold.category !== undefined && gold.category !== c.category)
    mismatches.push(`category ${c.category ?? 'none'} (gold ${gold.category ?? 'none'})`);
  return { correct: mismatches.length === 0, mismatches };
}

export interface PromptEvalReport {
  promptVersion: string;
  model: string;
  goldSetHash: string;
  goldSize: number;
  correct: number;
  score: number;
  costUsd: number;
  details: Array<{ id: string; correct: boolean; mismatches: string[]; source: string }>;
}

/** Scores one prompt version on the gold set and records the result (`classify:eval`). */
export async function evaluatePrompt(
  deps: ClassifyDeps,
  gold: GoldEntry[],
  options: { promptVersion?: string; model?: string } = {},
): Promise<PromptEvalReport> {
  const promptVersion = options.promptVersion ?? PROMPT_VERSION;
  if (!PROMPTS[promptVersion]) throw new PromptGateError(`unknown prompt version ${promptVersion}`);
  const model = options.model ?? deps.config.MODEL_FAST;
  if (gold.length === 0)
    throw new PromptGateError('the gold set is empty: lock a field in triage or add entries');
  const items = await deps.db
    .select()
    .from(catalogItems)
    .where(
      inArray(
        catalogItems.id,
        gold.map((g) => g.id),
      ),
    );
  const byId = new Map(items.map((i) => [i.id, i]));
  const report: PromptEvalReport = {
    promptVersion,
    model,
    goldSetHash: goldSetHash(gold),
    goldSize: gold.length,
    correct: 0,
    score: 0,
    costUsd: 0,
    details: [],
  };
  for (const entry of gold) {
    const item = byId.get(entry.id);
    if (!item) {
      report.details.push({
        id: entry.id,
        correct: false,
        mismatches: ['item missing'],
        source: entry.source,
      });
      continue;
    }
    const readme = await fetchReadme(deps, item.sourceUrl);
    const outcome = await classifyTool(
      deps.llm,
      {
        name: item.name,
        publisher: item.publisher,
        sourceUrl: item.sourceUrl,
        kindHint: null,
        description: item.description,
        components: item.components,
        readme,
      },
      {
        model,
        promptVersion,
        maxTokens: deps.config.CLASSIFY_MAX_TOKENS,
        readmeChars: deps.config.CLASSIFY_README_CHARS,
        ref: `classify-eval:${promptVersion}:${item.id}`,
      },
    );
    report.costUsd += outcome.costUsd;
    const score = scoreAgainstGold(entry, outcome.ok ? outcome.classification : null);
    if (score.correct) report.correct++;
    report.details.push({ id: entry.id, ...score, source: entry.source });
  }
  report.score = report.correct / gold.length;
  await deps.db.insert(classifierEvals).values({
    promptVersion,
    model,
    goldSetHash: report.goldSetHash,
    goldSize: report.goldSize,
    correct: report.correct,
    score: report.score,
    details: report.details,
    costUsd: report.costUsd,
  });
  return report;
}

export class PromptGateError extends AppError {}

/** The prompt version most non-rejected items are classified with (the one in use). */
export async function appliedPromptVersion(db: Db): Promise<string | null> {
  const [row] = await db
    .select({
      version: sql<string>`${catalogItems.classification}->>'promptVersion'`,
      n: sql<number>`count(*)::int`,
    })
    .from(catalogItems)
    .where(
      and(ne(catalogItems.status, 'rejected'), sql`${catalogItems.classification} is not null`),
    )
    .groupBy(sql`${catalogItems.classification}->>'promptVersion'`)
    .orderBy(desc(sql`count(*)`))
    .limit(1);
  return row?.version ?? null;
}

async function latestScore(db: Db, version: string, model: string, goldHash: string) {
  const [row] = await db
    .select({ score: classifierEvals.score, createdAt: classifierEvals.createdAt })
    .from(classifierEvals)
    .where(
      and(
        eq(classifierEvals.promptVersion, version),
        eq(classifierEvals.model, model),
        eq(classifierEvals.goldSetHash, goldHash),
      ),
    )
    .orderBy(desc(classifierEvals.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * May `version` be applied (PRD FR-D9a)? Yes when it is already the version in use. A new version
 * needs a gold-set score at least as good as the current version's, on the same gold set and model.
 */
export async function promptGate(
  db: Db,
  version: string,
  model: string,
  loadGold: () => Promise<GoldEntry[]>,
): Promise<{ ok: boolean; reason: string }> {
  const applied = await appliedPromptVersion(db);
  if (applied === null || applied === version)
    return { ok: true, reason: `${version} is the prompt in use` };
  const hash = goldSetHash(await loadGold());
  const [next, current] = await Promise.all([
    latestScore(db, version, model, hash),
    latestScore(db, applied, model, hash),
  ]);
  if (!next || !current)
    return {
      ok: false,
      reason: `score both prompts first: pnpm run pipeline classify:eval --prompt ${!next ? version : applied} (gold set ${hash})`,
    };
  return next.score >= current.score
    ? {
        ok: true,
        reason: `${version} scores ${next.score.toFixed(3)} ≥ ${applied} ${current.score.toFixed(3)}`,
      }
    : {
        ok: false,
        reason: `${version} scores ${next.score.toFixed(3)} < ${applied} ${current.score.toFixed(3)}; not applied`,
      };
}
