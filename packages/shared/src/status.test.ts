import { describe, expect, it } from 'vitest';
import { STATUSES, type Status } from './enums.js';
import { ALLOWED_TRANSITIONS, checkTransition, HUMAN_ONLY_TARGETS } from './status.js';

const pairs = STATUSES.flatMap((from) => STATUSES.map((to) => [from, to] as [Status, Status]));

describe('checkTransition', () => {
  it.each(pairs)('%s → %s follows the table for a human actor', (from, to) => {
    const allowed = from !== to && ALLOWED_TRANSITIONS[from].includes(to);
    expect(checkTransition(from, to, 'human:owner').ok).toBe(allowed);
  });

  it.each(pairs)('%s → %s follows the table for the system actor', (from, to) => {
    const allowed =
      from !== to &&
      ALLOWED_TRANSITIONS[from].includes(to) &&
      !HUMAN_ONLY_TARGETS.has(to) &&
      !(from === 'blocked' && to === 'candidate');
    expect(checkTransition(from, to, 'system').ok).toBe(allowed);
  });

  it('refuses recommended by system with a clear reason', () => {
    expect(checkTransition('candidate', 'recommended', 'system')).toEqual({
      ok: false,
      reason: 'only a human may set recommended',
    });
    expect(checkTransition('candidate', 'recommended_provisional', 'system').ok).toBe(false);
  });

  it('refuses malformed actors', () => {
    expect(checkTransition('candidate', 'watchlist', 'admin').ok).toBe(false);
    expect(checkTransition('candidate', 'recommended', 'human:').ok).toBe(false);
    expect(checkTransition('candidate', 'recommended', 'humanoid:x').ok).toBe(false);
  });

  it('never allows leaving blocked except back to candidate', () => {
    for (const to of STATUSES) {
      if (to !== 'candidate') expect(checkTransition('blocked', to, 'human:owner').ok).toBe(false);
    }
  });
});
