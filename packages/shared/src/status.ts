import { z } from 'zod';
import type { Status } from './enums.js';

/** `system` or `human:<name>`; only humans may move items into a recommended status. */
export const actorSchema = z
  .string()
  .regex(/^(system|human:[A-Za-z0-9._@-]{1,64})$/, 'actor must be "system" or "human:<name>"');
export type Actor = z.infer<typeof actorSchema>;

export const HUMAN_ONLY_TARGETS: ReadonlySet<Status> = new Set([
  'recommended',
  'recommended_provisional',
]);

/**
 * Allowed transitions (PRD FR-C7, plan 6.1). Anything not listed is invalid.
 * Unblocking (blocked → candidate) is human-only as well; see HUMAN_ONLY_TRANSITIONS.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<Status, readonly Status[]>> = {
  candidate: ['watchlist', 'recommended_provisional', 'recommended', 'blocked', 'rejected'],
  watchlist: [
    'candidate',
    'recommended_provisional',
    'recommended',
    'deprecated',
    'blocked',
    'rejected',
  ],
  recommended_provisional: ['recommended', 'watchlist', 'deprecated', 'blocked', 'rejected'],
  recommended: ['recommended_provisional', 'watchlist', 'deprecated', 'blocked'],
  deprecated: ['candidate', 'watchlist', 'blocked'],
  blocked: ['candidate'],
  rejected: ['candidate', 'blocked'],
};

const HUMAN_ONLY_TRANSITIONS: ReadonlySet<string> = new Set(['blocked->candidate']);

export type TransitionCheck = { ok: true } | { ok: false; reason: string };

export function isHumanActor(actor: string): boolean {
  return actor.startsWith('human:');
}

/** Pure validation; `transitionStatus` in packages/db calls this inside its transaction. */
export function checkTransition(from: Status, to: Status, actor: string): TransitionCheck {
  if (!actorSchema.safeParse(actor).success) {
    return { ok: false, reason: 'actor must be "system" or "human:<name>"' };
  }
  if (from === to) return { ok: false, reason: `item is already ${to}` };
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    return { ok: false, reason: `transition ${from} → ${to} is not allowed` };
  }
  if (HUMAN_ONLY_TARGETS.has(to) && !isHumanActor(actor)) {
    return { ok: false, reason: `only a human may set ${to}` };
  }
  if (HUMAN_ONLY_TRANSITIONS.has(`${from}->${to}`) && !isHumanActor(actor)) {
    return { ok: false, reason: `only a human may move ${from} → ${to}` };
  }
  return { ok: true };
}
