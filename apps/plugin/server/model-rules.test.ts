import { describe, expect, it } from 'vitest';
import type { SetupAnswers } from '@cc-setup-agent/shared';
import { isComplexWork, modelRecommendation } from './model-rules.js';

const base: SetupAnswers = {
  goal: 'marketing site',
  deployTarget: 'vercel',
  budgetSensitivity: 'medium',
  riskTolerance: 'medium',
  workflow: 'standard',
};

describe('modelRecommendation', () => {
  it('suggests Opus only for complex work when the budget allows it, with a cost note', () => {
    const r = modelRecommendation({ ...base, complexity: 'complex', budgetSensitivity: 'low' });
    expect(r.model).toBe('opus');
    expect(r.effort).toBe('high');
    expect(r.costNote).toMatch(/twice Sonnet per token/);
  });

  it('never suggests Opus when the budget is medium or high', () => {
    for (const budgetSensitivity of ['medium', 'high'] as const) {
      const r = modelRecommendation({ ...base, complexity: 'complex', budgetSensitivity });
      expect(r.model).toBe('sonnet');
    }
    expect(
      modelRecommendation({ ...base, complexity: 'complex', budgetSensitivity: 'medium' }).costNote,
    ).toMatch(/Opus is an option/);
  });

  it('never suggests Opus for simple or standard work, even with a low budget sensitivity', () => {
    for (const complexity of ['simple', 'standard'] as const) {
      expect(modelRecommendation({ ...base, complexity, budgetSensitivity: 'low' }).model).toBe(
        'sonnet',
      );
    }
    expect(modelRecommendation({ ...base, budgetSensitivity: 'low' }).model).toBe('sonnet');
  });

  it('infers complex work from the goal when complexity is not given', () => {
    expect(isComplexWork({ ...base, goal: 'Re-architect the data layer' })).toBe(true);
    expect(isComplexWork({ ...base, goal: 'Migrate from Pages to App router' })).toBe(true);
    expect(isComplexWork({ ...base, goal: 'landing page tweaks' })).toBe(false);
    expect(isComplexWork({ ...base, goal: 'architecture work', complexity: 'simple' })).toBe(false);
  });
});
