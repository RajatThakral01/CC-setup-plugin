import { describe, expect, it } from 'vitest';
import type { Classification } from './catalog.js';
import {
  categoryAgreement,
  categoryRulesSchema,
  ruleOpinion,
  type RuleInputs,
  type SecondOpinion,
} from './category-rules.js';

const rules = categoryRulesSchema.parse({
  version: 'rules-test',
  min_signals: 2,
  categories: {
    browser_testing: ['playwright', 'browser', 'end to end'],
    database: ['postgres', 'database'],
    auth: ['auth'],
  },
  vendors: { 'example-db-org': 'database' },
});

const inputs = (over: Partial<RuleInputs> = {}): RuleInputs => ({
  names: [],
  componentNames: [],
  keywords: [],
  topics: [],
  publisher: null,
  ...over,
});

describe('ruleOpinion', () => {
  it('needs min_signals distinct signals and a strict lead', () => {
    expect(ruleOpinion(inputs({ names: ['example-playwright'] }), rules).category).toBeNull();
    const r = ruleOpinion(
      inputs({ names: ['example-playwright'], componentNames: ['browser_click', 'browser_type'] }),
      rules,
    );
    expect(r.category).toBe('browser_testing');
    // browser_click and browser_type are one signal: same source, same keyword.
    expect(r.scores.browser_testing).toBe(2);
  });

  it('matches whole words and word sequences, including camelCase', () => {
    expect(ruleOpinion(inputs({ topics: ['authentic'] }), rules).signals).toHaveLength(0);
    const r = ruleOpinion(
      inputs({ keywords: ['End-to-End'], componentNames: ['runPlaywrightTest'] }),
      rules,
    );
    expect(r.signals.map((s) => s.term).sort()).toEqual(['end to end', 'playwright']);
  });

  it('counts the publisher map as one signal', () => {
    const r = ruleOpinion(inputs({ publisher: 'Example-DB-Org', topics: ['postgres'] }), rules);
    expect(r.category).toBe('database');
    expect(r.signals.map((s) => s.source).sort()).toEqual(['topic', 'vendor']);
  });

  it('has no opinion on a tie', () => {
    const r = ruleOpinion(
      inputs({ topics: ['postgres', 'playwright'], keywords: ['database', 'browser'] }),
      rules,
    );
    expect(r.category).toBeNull();
  });
});

const primary: Classification = {
  kind: 'mcp_server',
  category: 'browser_testing',
  stacks: ['any'],
  technologies: [],
  summary: 'Drives a browser.',
  provenanceGuess: 'official_vendor',
  relevant: true,
  model: 'claude-haiku-5-5',
  promptVersion: 'classify-v3',
  classifiedAt: '2026-10-20T00:00:00.000Z',
};
const second = (over: Partial<SecondOpinion> = {}): SecondOpinion => ({
  ...primary,
  model: 'claude-sonnet-5-5',
  inputHash: 'h1',
  ...over,
});
const noRules = ruleOpinion(inputs(), rules);

describe('categoryAgreement', () => {
  const agree = (over: Partial<Parameters<typeof categoryAgreement>[0]> = {}) =>
    categoryAgreement({
      category: 'browser_testing',
      categorySetBy: null,
      primary,
      primaryInputHash: 'h1',
      second: second(),
      rules: noRules,
      ...over,
    });

  it('agrees when both models match and the rules do not contradict', () => {
    expect(agree()).toMatchObject({ agreed: true });
  });

  it('accepts an owner-set category without opinions', () => {
    expect(agree({ categorySetBy: 'human:owner', primary: null, second: null })).toMatchObject({
      agreed: true,
      detail: 'set by owner',
    });
  });

  it('refuses a missing category', () => {
    expect(agree({ category: null })).toMatchObject({ agreed: false });
  });

  it('asks for a second opinion when it is missing, stale or from another prompt', () => {
    expect(agree({ second: null })).toMatchObject({ agreed: false, needsSecondOpinion: true });
    expect(agree({ second: second({ inputHash: 'old' }) })).toMatchObject({
      needsSecondOpinion: true,
    });
    expect(agree({ second: second({ promptVersion: 'classify-v2' }) })).toMatchObject({
      needsSecondOpinion: true,
    });
  });

  it('refuses when the models disagree on category or kind', () => {
    expect(agree({ second: second({ category: 'search' }) })).toMatchObject({
      agreed: false,
      needsSecondOpinion: false,
    });
    expect(agree({ second: second({ kind: 'skill' }) }).agreed).toBe(false);
  });

  it('refuses when the rules point elsewhere and give the category no signal', () => {
    const db = ruleOpinion(inputs({ topics: ['postgres'], keywords: ['database'] }), rules);
    expect(agree({ rules: db })).toMatchObject({ agreed: false, needsSecondOpinion: false });
    expect(agree({ rules: db }).detail).toContain('rules contradict');
  });

  it('accepts when the rules lean elsewhere but also support the category', () => {
    const mixed = ruleOpinion(
      inputs({ topics: ['postgres', 'playwright'], keywords: ['database'] }),
      rules,
    );
    expect(mixed.category).toBe('database');
    expect(agree({ rules: mixed }).agreed).toBe(true);
  });

  it('refuses a category that did not come from the current classification', () => {
    expect(agree({ category: 'auth' }).agreed).toBe(false);
    expect(agree({ primaryInputHash: null }).agreed).toBe(false);
  });
});
