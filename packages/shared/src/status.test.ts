import { describe, expect, it } from 'vitest';
import { STATUSES, type Status } from './enums.js';
import { ALLOWED_TRANSITIONS, APPROVAL_TARGETS, checkTransition, policyActor } from './status.js';

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
      !APPROVAL_TARGETS.has(to) &&
      !(from === 'blocked' && to === 'candidate');
    expect(checkTransition(from, to, 'system').ok).toBe(allowed);
  });

  it.each(pairs)('%s → %s follows the table for the policy actor', (from, to) => {
    const allowed = from !== to && ALLOWED_TRANSITIONS[from].includes(to);
    expect(checkTransition(from, to, 'policy:policy-v1').ok).toBe(allowed);
  });

  it('refuses recommended by system with a clear reason', () => {
    expect(checkTransition('candidate', 'recommended', 'system')).toEqual({
      ok: false,
      reason: 'only a human or the approval policy may set recommended',
    });
    expect(checkTransition('candidate', 'recommended_provisional', 'system').ok).toBe(false);
  });

  it('lets the policy approve, demote and (with DB-enforced conditions) unblock', () => {
    expect(checkTransition('candidate', 'recommended_provisional', 'policy:policy-v1').ok).toBe(
      true,
    );
    expect(checkTransition('recommended_provisional', 'candidate', 'policy:policy-v1').ok).toBe(
      true,
    );
    expect(checkTransition('blocked', 'candidate', 'policy:policy-v1').ok).toBe(true);
    expect(checkTransition('blocked', 'candidate', 'system').ok).toBe(false);
  });

  it('refuses malformed actors', () => {
    expect(checkTransition('candidate', 'watchlist', 'admin').ok).toBe(false);
    expect(checkTransition('candidate', 'recommended', 'human:').ok).toBe(false);
    expect(checkTransition('candidate', 'recommended', 'humanoid:x').ok).toBe(false);
    expect(checkTransition('candidate', 'recommended', 'policy:').ok).toBe(false);
    expect(checkTransition('candidate', 'recommended', 'policy:V1 x').ok).toBe(false);
  });

  it('builds policy actors and refuses bad versions', () => {
    expect(policyActor('policy-v1')).toBe('policy:policy-v1');
    expect(() => policyActor('Policy v1')).toThrow();
  });

  it('never allows leaving blocked except back to candidate', () => {
    for (const to of STATUSES) {
      if (to !== 'candidate') expect(checkTransition('blocked', to, 'human:owner').ok).toBe(false);
    }
  });
});
