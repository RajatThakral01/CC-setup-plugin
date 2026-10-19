import { z } from 'zod';
import { classificationSchema, type Classification } from './catalog.js';
import { categorySchema, CATEGORIES, type Category } from './enums.js';

/**
 * Deterministic category rules (PRD FR-D9a): keywords matched against names, component names,
 * package keywords and repo topics, plus a publisher → category map. Lives in
 * `catalog/category-rules.yaml`.
 */
export const categoryRulesSchema = z.object({
  version: z.string().min(1),
  /** The rules hold an opinion only when the top category has this many distinct signals. */
  min_signals: z.number().int().min(1).default(2),
  categories: z.partialRecord(categorySchema, z.array(z.string().min(1))).default({}),
  /** Publisher (GitHub org, lowercase) → the single category its products belong to. */
  vendors: z.record(z.string(), categorySchema).default({}),
});
export type CategoryRules = z.output<typeof categoryRulesSchema>;

export interface RuleInputs {
  /** Item name and id. */
  names: string[];
  /** MCP tool, skill, command and agent names. */
  componentNames: string[];
  /** npm keywords and marketplace keywords/tags. */
  keywords: string[];
  /** GitHub repo topics. */
  topics: string[];
  publisher: string | null;
}

export type RuleSource = 'name' | 'component' | 'keyword' | 'topic' | 'vendor';
export interface RuleSignal {
  category: Category;
  source: RuleSource;
  term: string;
}
export interface RuleOpinion {
  /** The rules' category, or null when they have no clear opinion. */
  category: Category | null;
  signals: RuleSignal[];
  scores: Partial<Record<Category, number>>;
}

const tokens = (s: string): string[] =>
  s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** True when the keyword's tokens appear contiguously in the text's tokens. */
function matches(textTokens: string[], keyword: string): boolean {
  const k = tokens(keyword);
  if (k.length === 0) return false;
  for (let i = 0; i + k.length <= textTokens.length; i++)
    if (k.every((t, j) => textTokens[i + j] === t)) return true;
  return false;
}

/** The rules' view of an item: one signal per distinct (source, keyword); see `min_signals`. */
export function ruleOpinion(inputs: RuleInputs, rules: CategoryRules): RuleOpinion {
  const signals: RuleSignal[] = [];
  const seen = new Set<string>();
  const add = (category: Category, source: RuleSource, term: string) => {
    const key = `${category}|${source}|${term}`;
    if (seen.has(key)) return;
    seen.add(key);
    signals.push({ category, source, term });
  };
  const sources: Array<[RuleSource, string[]]> = [
    ['name', inputs.names],
    ['component', inputs.componentNames],
    ['keyword', inputs.keywords],
    ['topic', inputs.topics],
  ];
  for (const [source, texts] of sources) {
    const list = texts.map(tokens);
    for (const category of CATEGORIES) {
      for (const keyword of rules.categories[category] ?? []) {
        if (list.some((t) => matches(t, keyword))) add(category, source, keyword.toLowerCase());
      }
    }
  }
  const vendor = inputs.publisher ? rules.vendors[inputs.publisher.toLowerCase()] : undefined;
  if (vendor) add(vendor, 'vendor', inputs.publisher!.toLowerCase());

  const scores: Partial<Record<Category, number>> = {};
  for (const s of signals) scores[s.category] = (scores[s.category] ?? 0) + 1;
  const ranked = (Object.entries(scores) as Array<[Category, number]>).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const [top, second] = ranked;
  const category =
    top && top[1] >= rules.min_signals && (!second || top[1] > second[1]) ? top[0] : null;
  return { category, signals, scores };
}

/** A strong-model classification, tied to the inputs it saw (PRD FR-D9a). */
export const secondOpinionSchema = classificationSchema.extend({ inputHash: z.string() });
export type SecondOpinion = z.infer<typeof secondOpinionSchema>;

export interface AgreementInput {
  /** The item's current category and whether the owner set it. */
  category: Category | null;
  categorySetBy: string | null;
  /** Fast-model classification and the input hash it was made from (null for older items). */
  primary: Classification | null;
  primaryInputHash: string | null;
  second: SecondOpinion | null;
  rules: RuleOpinion;
}

export interface Agreement {
  agreed: boolean;
  /** True when only the strong-model second opinion is missing (or stale). */
  needsSecondOpinion: boolean;
  detail: string;
}

const describeRules = (r: RuleOpinion) =>
  r.signals.length === 0
    ? 'rules: no signals'
    : `rules: ${r.category ?? 'no clear category'} (${r.signals
        .slice(0, 6)
        .map((s) => `${s.source} "${s.term}" → ${s.category}`)
        .join(', ')}${r.signals.length > 6 ? ', …' : ''})`;

/**
 * Is the item's category agreed? Owner-set categories are. Otherwise both model opinions, made
 * from the same inputs and prompt version, must match on kind and category, and the rules must
 * not point to another category while giving this one no signal at all.
 */
export function categoryAgreement(a: AgreementInput): Agreement {
  const no = (detail: string, needsSecondOpinion = false): Agreement => ({
    agreed: false,
    needsSecondOpinion,
    detail,
  });
  if (a.category === null) return no('no category');
  if (a.categorySetBy) return { agreed: true, needsSecondOpinion: false, detail: 'set by owner' };
  if (!a.primary || a.primary.category !== a.category)
    return no(`category ${a.category} did not come from the current classification`);
  if (!a.primaryInputHash)
    return no('classification inputs not recorded yet (re-classification pending)');
  const contradicted =
    a.rules.category !== null &&
    a.rules.category !== a.category &&
    (a.rules.scores[a.category] ?? 0) === 0;
  if (contradicted) return no(`rules contradict ${a.category}; ${describeRules(a.rules)}`);
  const s = a.second;
  if (!s || s.inputHash !== a.primaryInputHash || s.promptVersion !== a.primary.promptVersion)
    return no('second opinion pending', true);
  if (s.category !== a.category || s.kind !== a.primary.kind)
    return no(
      `models disagree: ${a.primary.model} says ${a.primary.kind}/${a.category}, ${s.model} says ${s.kind}/${s.category ?? 'no category'}`,
    );
  return {
    agreed: true,
    needsSecondOpinion: false,
    detail: `${a.primary.model} and ${s.model} agree on ${a.primary.kind}/${a.category}; ${describeRules(a.rules)}`,
  };
}
