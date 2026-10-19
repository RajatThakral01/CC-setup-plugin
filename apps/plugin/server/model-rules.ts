/**
 * Model and effort rules for the plugin's recommendation to users (PRD FR-R6).
 *
 * This is the only file in the repo allowed to name Opus (`pnpm check:models` exempts exactly this
 * path). The rule against Opus covers the product's own API calls (classification, evals), not the
 * model a user is advised to run Claude Code with. Values are Claude Code model aliases.
 */
import type { RecommendSetupOutput, SetupAnswers } from '@cc-setup-agent/shared';

export type ModelRecommendation = RecommendSetupOutput['model'];

/** Anthropic API list prices, USD per million tokens (input / output), verified 2026-10-19. */
const PRICE_NOTE = {
  opus: 'Opus costs about twice Sonnet per token (USD 4 / 20 vs 2 / 10 per million input / output tokens).',
} as const;

/** Goal wording that marks complex or architecture-heavy work when `complexity` isn't given. */
const COMPLEX_GOAL =
  /\b(architect\w*|re-?architect\w*|migrat\w*|re-?platform\w*|large refactor\w*|rewrite|system design|distributed|complex)\b/i;

export function isComplexWork(answers: SetupAnswers): boolean {
  if (answers.complexity) return answers.complexity === 'complex';
  return COMPLEX_GOAL.test(answers.goal);
}

/**
 * Opus only for complex or architecture-heavy work and only when the user's budget answer allows
 * it (budget sensitivity `low`), always with a cost note. Everything else gets Sonnet.
 */
export function modelRecommendation(answers: SetupAnswers): ModelRecommendation {
  const complex = isComplexWork(answers);
  if (complex && answers.budgetSensitivity === 'low') {
    return {
      model: 'opus',
      effort: 'high',
      costNote: `For complex, architecture-heavy work. ${PRICE_NOTE.opus} Switch to sonnet (/model sonnet) for routine edits.`,
    };
  }
  if (complex && answers.budgetSensitivity === 'medium') {
    return {
      model: 'sonnet',
      effort: 'high',
      costNote: `Higher effort for complex work at moderate cost. Opus is an option for the hardest design sessions; ${PRICE_NOTE.opus}`,
    };
  }
  if (answers.budgetSensitivity === 'high') {
    return {
      model: 'sonnet',
      effort: 'medium',
      costNote: 'Good quality at moderate cost; use haiku for quick edits to save more.',
    };
  }
  if (answers.budgetSensitivity === 'low') {
    return {
      model: 'sonnet',
      effort: 'high',
      costNote: 'Higher effort spends more tokens per task for more thorough work.',
    };
  }
  return {
    model: 'sonnet',
    effort: 'medium',
    costNote: 'Balanced default for everyday Next.js work.',
  };
}
