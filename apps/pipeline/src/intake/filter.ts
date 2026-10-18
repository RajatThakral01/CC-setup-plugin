import type { Vendors } from '../catalog-config.js';
import type { CandidateDraft } from '../sources/types.js';

export type IntakeReason =
  | 'not_latest'
  | 'no_repo_url'
  | 'repo_unavailable'
  | 'fork'
  | 'archived'
  | 'no_license'
  | 'no_description'
  | 'stars_below_min';

export interface IntakeDecision {
  pass: boolean;
  reasons: IntakeReason[];
  vendor: boolean;
}

export function isVendor(draft: CandidateDraft, vendors: Vendors): boolean {
  if (draft.repo && vendors.githubOrgs.has(draft.repo.owner.toLowerCase())) return true;
  const ns = draft.registry?.namespace.toLowerCase();
  return (
    ns !== undefined && vendors.registryNamespaces.some((v) => ns === v || ns.startsWith(`${v}.`))
  );
}

/**
 * Intake filter (PRD FR-D10, owner decision 2026-10-19): not a fork, not archived, has a licence
 * and a description, at least `minStars` stars unless the publisher is an allowlisted vendor.
 * Registry entries must also be the latest version and name a repository.
 */
export function evaluateIntake(
  draft: CandidateDraft,
  vendors: Vendors,
  minStars: number,
): IntakeDecision {
  const reasons: IntakeReason[] = [];
  if (draft.registry) {
    if (!draft.registry.isLatest) reasons.push('not_latest');
    if (!draft.registry.hasRepoUrl) reasons.push('no_repo_url');
  }
  const vendor = isVendor(draft, vendors);
  const repo = draft.repo;
  if (!repo) {
    if (!reasons.includes('no_repo_url')) reasons.push('repo_unavailable');
  } else {
    if (repo.fork) reasons.push('fork');
    if (repo.archived) reasons.push('archived');
    if (!repo.license) reasons.push('no_license');
    if (!vendor && repo.stars < minStars) reasons.push('stars_below_min');
  }
  if (!(draft.description ?? repo?.description ?? '').trim()) reasons.push('no_description');
  return { pass: reasons.length === 0, reasons, vendor };
}

export interface RankedDraft {
  vendor: boolean;
  starVelocity7d: number;
  stars: number;
  sourceUrl: string;
}

/** Daily-cap priority: vendor first, then star velocity, then stars; URL breaks ties. */
export function compareIntakePriority(a: RankedDraft, b: RankedDraft): number {
  if (a.vendor !== b.vendor) return a.vendor ? -1 : 1;
  if (a.starVelocity7d !== b.starVelocity7d) return b.starVelocity7d - a.starVelocity7d;
  if (a.stars !== b.stars) return b.stars - a.stars;
  return a.sourceUrl.localeCompare(b.sourceUrl);
}

/**
 * Stars gained per 7 days. With an earlier observation at least a day old, uses the difference;
 * otherwise falls back to the lifetime average since repo creation (at least one week).
 * Returns undefined when a recent observation exists and the value should be kept.
 */
export function starVelocity7d(
  stars: number,
  now: Date,
  previous: { stars: number; at: Date } | undefined,
  repoCreatedAt: string | null,
): number | undefined {
  const day = 86_400_000;
  if (previous) {
    const elapsed = now.getTime() - previous.at.getTime();
    if (elapsed < day) return undefined;
    return Math.round(((stars - previous.stars) / elapsed) * 7 * day * 100) / 100;
  }
  if (!repoCreatedAt) return 0;
  const ageDays = Math.max(7, (now.getTime() - Date.parse(repoCreatedAt)) / day);
  return Math.round((stars / ageDays) * 7 * 100) / 100;
}
