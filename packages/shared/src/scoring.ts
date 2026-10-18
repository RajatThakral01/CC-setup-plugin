import type { GateId, GateResult } from './catalog.js';
import type { Confidence } from './enums.js';

type Outcome = GateResult['result'];

/** Points per gate outcome (plan M4: weights table in packages/shared). Max 100. */
export const GATE_WEIGHTS: Readonly<Record<GateId, Readonly<Record<Outcome, number>>>> = {
  gate0_hygiene: { pass: 30, soft_fail: 15, not_run: 10, fail: 0 },
  gate1_provenance: { pass: 20, soft_fail: 10, not_run: 5, fail: 0 },
  gate2_health: { pass: 25, soft_fail: 10, not_run: 5, fail: 0 },
  gate3_security: { pass: 25, soft_fail: 10, not_run: 5, fail: 0 },
};

export const CONFIDENCE_THRESHOLDS = { high: 85, medium: 55 } as const;

/**
 * Overall confidence (FR-C6). A failed hygiene or security gate means low; a security or hygiene
 * gate that could not run caps the result at medium.
 */
export function computeConfidence(gates: Partial<Record<GateId, Pick<GateResult, 'result'>>>): {
  confidence: Confidence;
  score: number;
} {
  const outcome = (g: GateId): Outcome => gates[g]?.result ?? 'not_run';
  const score = (Object.keys(GATE_WEIGHTS) as GateId[]).reduce(
    (sum, g) => sum + GATE_WEIGHTS[g][outcome(g)],
    0,
  );
  if (outcome('gate0_hygiene') === 'fail' || outcome('gate3_security') === 'fail')
    return { confidence: 'low', score };
  let confidence: Confidence =
    score >= CONFIDENCE_THRESHOLDS.high
      ? 'high'
      : score >= CONFIDENCE_THRESHOLDS.medium
        ? 'medium'
        : 'low';
  if (
    confidence === 'high' &&
    (outcome('gate0_hygiene') === 'not_run' || outcome('gate3_security') === 'not_run')
  )
    confidence = 'medium';
  return { confidence, score };
}
