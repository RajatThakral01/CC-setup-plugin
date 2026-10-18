import { describe, expect, it } from 'vitest';
import { priorityScore } from './priority.js';

const checkedAt = '2026-10-19T00:00:00.000Z';
const g = (result: 'pass' | 'soft_fail' | 'fail') => ({ result, evidence: [], checkedAt });

describe('priorityScore', () => {
  it('rewards trusted provenance, health, confidence and uncovered categories', () => {
    const strong = priorityScore({
      provenance: 'official_vendor',
      confidence: 'high',
      gates: { gate2_health: g('pass') },
      category: 'database',
      categoryCoverage: 0,
    });
    const weak = priorityScore({
      provenance: 'community',
      confidence: 'low',
      gates: { gate2_health: g('soft_fail') },
      category: 'database',
      categoryCoverage: 3,
    });
    expect(strong).toBe(11);
    expect(weak).toBe(2);
  });
  it('sinks items that failed hygiene or security', () => {
    const base = {
      provenance: 'anthropic' as const,
      confidence: 'high' as const,
      category: 'docs',
      categoryCoverage: 1,
    };
    expect(priorityScore({ ...base, gates: { gate3_security: g('fail') } })).toBeLessThan(
      priorityScore({ ...base, gates: {} }),
    );
    expect(priorityScore({ ...base, gates: { gate0_hygiene: g('fail') } })).toBe(
      priorityScore({ ...base, gates: {} }) - 5,
    );
  });
});
