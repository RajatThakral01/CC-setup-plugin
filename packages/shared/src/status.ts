import { z } from 'zod';
import type { Status } from './enums.js';

/**
 * `system`, `human:<name>` or `policy:<version>` (the approval policy, PRD 9.2a). Only a human or
 * the policy may move items into a recommended status.
 */
export const actorSchema = z
  .string()
  .regex(
    /^(system|human:[A-Za-z0-9._@-]{1,64}|policy:[a-z0-9][a-z0-9.-]{0,31})$/,
    'actor must be "system", "human:<name>" or "policy:<version>"',
  );
export type Actor = z.infer<typeof actorSchema>;

/** Statuses only an approver (a human or the approval policy) may set (PRD FR-C9). */
export const APPROVAL_TARGETS: ReadonlySet<Status> = new Set([
  'recommended',
  'recommended_provisional',
]);

/**
 * Allowed transitions (PRD FR-C7, plan 6.1). Anything not listed is invalid. Recommended items can
 * go back to candidate (eval regression or owner veto, PRD FR-P6/FR-P9). Unblocking
 * (blocked → candidate) is human-only; see HUMAN_ONLY_TRANSITIONS.
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
  recommended_provisional: [
    'candidate',
    'recommended',
    'watchlist',
    'deprecated',
    'blocked',
    'rejected',
  ],
  recommended: ['candidate', 'recommended_provisional', 'watchlist', 'deprecated', 'blocked'],
  deprecated: ['candidate', 'watchlist', 'blocked'],
  blocked: ['candidate'],
  rejected: ['candidate', 'blocked'],
};

/**
 * Unblocking needs a human, or the approval policy lifting its own vulnerable-dependency block on
 * a newer, clean version (PRD FR-P10; `transitionStatus` enforces those conditions).
 */
const UNBLOCK_TRANSITIONS: ReadonlySet<string> = new Set(['blocked->candidate']);

export type TransitionCheck = { ok: true } | { ok: false; reason: string };

export function isHumanActor(actor: string): boolean {
  return actor.startsWith('human:');
}

export function isPolicyActor(actor: string): boolean {
  return actor.startsWith('policy:');
}

/** The audit actor for a policy version, e.g. `policy:policy-v1`. */
export function policyActor(version: string): Actor {
  return actorSchema.parse(`policy:${version}`);
}

/** Pure validation; `transitionStatus` in packages/db calls this inside its transaction. */
export function checkTransition(from: Status, to: Status, actor: string): TransitionCheck {
  if (!actorSchema.safeParse(actor).success) {
    return { ok: false, reason: 'actor must be "system", "human:<name>" or "policy:<version>"' };
  }
  if (from === to) return { ok: false, reason: `item is already ${to}` };
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    return { ok: false, reason: `transition ${from} → ${to} is not allowed` };
  }
  if (APPROVAL_TARGETS.has(to) && !isHumanActor(actor) && !isPolicyActor(actor)) {
    return { ok: false, reason: `only a human or the approval policy may set ${to}` };
  }
  if (UNBLOCK_TRANSITIONS.has(`${from}->${to}`) && !isHumanActor(actor) && !isPolicyActor(actor)) {
    return { ok: false, reason: `only a human or the approval policy may move ${from} → ${to}` };
  }
  return { ok: true };
}
