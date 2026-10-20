import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parse, stringify } from 'yaml';
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
  type RuleOpinion,
  type SecondOpinion,
} from '@cc-setup-agent/shared';
import { CATALOG_DIR } from '../catalog-config.js';
import { classifyTool, PROMPT_VERSION, PROMPTS } from './classifier.js';
import { fetchReadme } from './readme.js';
import type { ClassifyDeps } from './run.js';

/**
 * The classification gold set (PRD FR-D9a), in two tiers that are scored separately:
 * - `owner`: owner-locked fields from the database, plus the frozen owner approvals in
 *   `catalog/classification-gold.yaml` (`items`). Owner-locked fields win.
 * - `agreement`: frozen high-agreement labels (`agreement_items`): items where Haiku, Sonnet
 *   (same inputs and prompt) and the deterministic rules all gave the same kind and category.
 *   Machine labels, clearly marked; they are kept as written so a later prompt is scored against
 *   them, not against itself.
 */
const goldItemSchema = z.object({
  id: itemIdSchema,
  kind: kindSchema.optional(),
  category: categorySchema.nullable().optional(),
  source: z.string().min(1),
});
export const goldFileSchema = z.object({
  items: z.array(goldItemSchema).default([]),
  agreement_items: z.array(goldItemSchema).default([]),
});

export type GoldTier = 'owner' | 'agreement';
export const GOLD_TIERS: readonly GoldTier[] = ['owner', 'agreement'];

export interface GoldEntry {
  id: string;
  kind?: Kind;
  category?: Category | null;
  source: string;
  tier: GoldTier;
}

export const GOLD_FILE = `${CATALOG_DIR}/classification-gold.yaml`;

export async function readGoldFile(path = GOLD_FILE): Promise<GoldEntry[]> {
  const file = goldFileSchema.parse(parse(await readFile(path, 'utf8')) ?? {});
  return [
    ...file.items.map((e) => ({ ...e, tier: 'owner' as const })),
    ...file.agreement_items.map((e) => ({ ...e, tier: 'agreement' as const })),
  ];
}

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
  const owner = new Map(fileEntries.filter((e) => e.tier === 'owner').map((e) => [e.id, { ...e }]));
  for (const r of locked) {
    const entry: GoldEntry = owner.get(r.id) ?? {
      id: r.id,
      source: 'owner-locked',
      tier: 'owner',
    };
    if (r.kindSetBy && r.kind) entry.kind = r.kind;
    if (r.categorySetBy) entry.category = r.category;
    entry.source = `owner-locked (${[r.kindSetBy && 'kind', r.categorySetBy && 'category'].filter(Boolean).join(', ')})`;
    owner.set(r.id, entry);
  }
  // An owner label always wins over a machine label for the same item.
  const agreement = fileEntries.filter((e) => e.tier === 'agreement' && !owner.has(e.id));
  return [...owner.values(), ...agreement].sort(
    (a, b) => a.tier.localeCompare(b.tier) || a.id.localeCompare(b.id),
  );
}

export function goldSetHash(entries: GoldEntry[]): string {
  const material = JSON.stringify(
    entries.map((e) => [e.tier, e.id, e.kind ?? null, e.category ?? null]),
  );
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

const ofTier = (gold: GoldEntry[], tier: GoldTier) => gold.filter((g) => g.tier === tier);

/** Compares a classification with a gold entry, only on the fields the entry has. */
export function scoreAgainstGold(
  gold: Pick<GoldEntry, 'kind' | 'category'>,
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

/**
 * A high-agreement label (PRD FR-D9a, M8.3): Haiku and Sonnet, from the same inputs and prompt,
 * give the same kind and a category, and the rules hold that same category as their opinion.
 */
export function agreementLabel(
  primary: Classification | null,
  primaryInputHash: string | null,
  second: SecondOpinion | null,
  rules: Pick<RuleOpinion, 'category'>,
): { kind: Kind; category: Category } | null {
  if (!primary || !second || !primaryInputHash || primary.category === null) return null;
  if (second.inputHash !== primaryInputHash || second.promptVersion !== primary.promptVersion)
    return null;
  if (second.kind !== primary.kind || second.category !== primary.category) return null;
  if (rules.category !== primary.category) return null;
  return { kind: primary.kind, category: primary.category };
}

/**
 * Adds new high-agreement labels to the gold file's `agreement_items` (existing ones are kept as
 * written; owner labels are never touched). Returns the entries added.
 */
export async function growAgreementGold(
  candidates: Array<{ id: string; label: { kind: Kind; category: Category } }>,
  date: string,
  path = GOLD_FILE,
): Promise<GoldEntry[]> {
  const text = await readFile(path, 'utf8');
  const file = goldFileSchema.parse(parse(text) ?? {});
  const known = new Set([...file.items, ...file.agreement_items].map((e) => e.id));
  const added = candidates
    .filter((c) => !known.has(c.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => ({
      id: c.id,
      kind: c.label.kind,
      category: c.label.category,
      source: `high-agreement (haiku + sonnet + rules) ${date}`,
    }));
  if (added.length === 0) return [];
  const marker = '\n# Machine labels, not owner labels';
  const head = text.includes(marker) ? text.slice(0, text.indexOf(marker)) : text.trimEnd();
  const agreement = [...file.agreement_items, ...added].sort((a, b) => a.id.localeCompare(b.id));
  await writeFile(
    path,
    `${head.trimEnd()}\n${marker}: Haiku, Sonnet and the keyword rules all agreed.\n# Frozen as written; scored as a separate tier. Added by \`classify:gold --grow\`.\n${stringify({ agreement_items: agreement })}`,
    'utf8',
  );
  return added.map((a) => ({ ...a, tier: 'agreement' as const }));
}

export interface TierScore {
  tier: GoldTier;
  goldSetHash: string;
  goldSize: number;
  correct: number;
  score: number;
}

export interface PromptEvalReport {
  promptVersion: string;
  model: string;
  tiers: TierScore[];
  costUsd: number;
  details: Array<{
    id: string;
    tier: GoldTier;
    correct: boolean;
    mismatches: string[];
    source: string;
  }>;
}

/** Scores one prompt version on every gold tier and records one row per tier (`classify:eval`). */
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
  const report: PromptEvalReport = { promptVersion, model, tiers: [], costUsd: 0, details: [] };
  const costByTier = new Map<GoldTier, number>();
  for (const entry of gold) {
    const item = byId.get(entry.id);
    if (!item) {
      report.details.push({
        id: entry.id,
        tier: entry.tier,
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
    costByTier.set(entry.tier, (costByTier.get(entry.tier) ?? 0) + outcome.costUsd);
    const score = scoreAgainstGold(entry, outcome.ok ? outcome.classification : null);
    report.details.push({ id: entry.id, tier: entry.tier, ...score, source: entry.source });
  }
  for (const tier of GOLD_TIERS) {
    const entries = ofTier(gold, tier);
    if (entries.length === 0) continue;
    const correct = report.details.filter((d) => d.tier === tier && d.correct).length;
    const row: TierScore = {
      tier,
      goldSetHash: goldSetHash(entries),
      goldSize: entries.length,
      correct,
      score: correct / entries.length,
    };
    report.tiers.push(row);
    await deps.db.insert(classifierEvals).values({
      promptVersion,
      model,
      ...row,
      details: report.details.filter((d) => d.tier === tier),
      costUsd: costByTier.get(tier) ?? 0,
    });
  }
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

async function latestScore(
  db: Db,
  version: string,
  model: string,
  tier: GoldTier,
  goldHash: string,
) {
  const [row] = await db
    .select({ score: classifierEvals.score, createdAt: classifierEvals.createdAt })
    .from(classifierEvals)
    .where(
      and(
        eq(classifierEvals.promptVersion, version),
        eq(classifierEvals.model, model),
        eq(classifierEvals.tier, tier),
        eq(classifierEvals.goldSetHash, goldHash),
      ),
    )
    .orderBy(desc(classifierEvals.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * May `version` be applied (PRD FR-D9a)? Yes when it is already the version in use. A new version
 * needs, on every gold tier, a score at least as good as the current version's on the same labels
 * and model.
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
  const gold = await loadGold();
  const reasons: string[] = [];
  for (const tier of GOLD_TIERS) {
    const entries = ofTier(gold, tier);
    if (entries.length === 0) continue;
    const hash = goldSetHash(entries);
    const [next, current] = await Promise.all([
      latestScore(db, version, model, tier, hash),
      latestScore(db, applied, model, tier, hash),
    ]);
    if (!next || !current)
      return {
        ok: false,
        reason: `score both prompts first: pnpm run pipeline classify:eval --prompt ${!next ? version : applied} (${tier} gold set ${hash})`,
      };
    if (next.score < current.score)
      return {
        ok: false,
        reason: `${version} scores ${next.score.toFixed(3)} < ${applied} ${current.score.toFixed(3)} on the ${tier} labels; not applied`,
      };
    reasons.push(`${tier} ${next.score.toFixed(3)} ≥ ${current.score.toFixed(3)}`);
  }
  return { ok: true, reason: `${version} vs ${applied}: ${reasons.join(', ')}` };
}
