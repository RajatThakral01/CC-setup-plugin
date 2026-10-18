import type { Confidence, GateResults, Provenance } from '@cc-setup-agent/shared';

export interface PriorityInput {
  provenance: Provenance | null;
  confidence: Confidence | null;
  gates: GateResults | null;
  category: string | null;
  /** Recommended or provisional items already in this category for Next.js. */
  categoryCoverage: number;
}

/**
 * Triage queue priority (plan M5): provenance, health, confidence, and gaps in Next.js category
 * coverage. Security-flagged items sink but stay visible.
 */
export function priorityScore(i: PriorityInput): number {
  let score = 0;
  score +=
    i.provenance === 'anthropic' || i.provenance === 'official_vendor'
      ? 3
      : i.provenance === 'community'
        ? 1
        : 0;
  const health = i.gates?.gate2_health?.result;
  score += health === 'pass' ? 2 : health === 'soft_fail' ? 1 : 0;
  score += i.confidence === 'high' ? 3 : i.confidence === 'medium' ? 2 : 0;
  if (i.category) score += i.categoryCoverage === 0 ? 3 : i.categoryCoverage === 1 ? 1 : 0;
  if (i.gates?.gate3_security?.result === 'fail') score -= 5;
  if (i.gates?.gate0_hygiene?.result === 'fail') score -= 5;
  return score;
}
