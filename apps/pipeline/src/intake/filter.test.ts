import { describe, expect, it } from 'vitest';
import { vendorsFromFile } from '../catalog-config.js';
import type { RepoFacts } from '../sources/github.js';
import type { CandidateDraft } from '../sources/types.js';
import { compareIntakePriority, evaluateIntake, starVelocity7d } from './filter.js';

const vendors = vendorsFromFile({
  github_orgs: ['Example-Vendor'],
  registry_namespaces: ['com.example-vendor'],
});

function repo(overrides: Partial<RepoFacts> = {}): RepoFacts {
  return {
    id: 1,
    fullName: 'example-org/example-tool',
    owner: 'example-org',
    name: 'example-tool',
    description: 'Fake tool',
    fork: false,
    archived: false,
    license: 'MIT',
    stars: 50,
    pushedAt: '2026-10-10T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    defaultBranch: 'main',
    ...overrides,
  };
}

function draft(overrides: Partial<CandidateDraft> = {}): CandidateDraft {
  return {
    name: 'example-tool',
    description: 'Fake tool',
    sourceUrl: 'https://github.com/example-org/example-tool',
    packageName: null,
    publisher: 'example-org',
    kind: null,
    repo: repo(),
    ...overrides,
  };
}

describe('evaluateIntake', () => {
  it('passes a healthy, licensed, popular repo', () => {
    expect(evaluateIntake(draft(), vendors, 10)).toEqual({
      pass: true,
      reasons: [],
      vendor: false,
    });
  });

  it.each([
    [{ fork: true }, 'fork'],
    [{ archived: true }, 'archived'],
    [{ license: null }, 'no_license'],
    [{ stars: 9 }, 'stars_below_min'],
  ] as const)('rejects %o with %s', (repoOverrides, reason) => {
    expect(evaluateIntake(draft({ repo: repo(repoOverrides) }), vendors, 10).reasons).toEqual([
      reason,
    ]);
  });

  it('accepts exactly the minimum star count', () => {
    expect(evaluateIntake(draft({ repo: repo({ stars: 10 }) }), vendors, 10).pass).toBe(true);
  });

  it('counts an unrecognised licence file as a licence', () => {
    expect(
      evaluateIntake(draft({ repo: repo({ license: 'NOASSERTION' }) }), vendors, 10).pass,
    ).toBe(true);
  });

  it('requires a description from the source or the repo', () => {
    const d = draft({ description: null, repo: repo({ description: '  ' }) });
    expect(evaluateIntake(d, vendors, 10).reasons).toEqual(['no_description']);
    expect(evaluateIntake(draft({ description: null }), vendors, 10).pass).toBe(true);
  });

  it('lets allowlisted vendors skip only the star threshold (case-insensitive)', () => {
    const v = draft({ repo: repo({ owner: 'example-vendor', stars: 0 }) });
    expect(evaluateIntake(v, vendors, 10)).toEqual({ pass: true, reasons: [], vendor: true });
    const archived = draft({ repo: repo({ owner: 'EXAMPLE-VENDOR', stars: 0, archived: true }) });
    expect(evaluateIntake(archived, vendors, 10)).toEqual({
      pass: false,
      reasons: ['archived'],
      vendor: true,
    });
  });

  it('applies registry rules: latest version and a repository URL', () => {
    const reg = (
      r: Partial<NonNullable<CandidateDraft['registry']>>,
      d: Partial<CandidateDraft> = {},
    ) =>
      draft({
        registry: { isLatest: true, namespace: 'io.github.example-org', hasRepoUrl: true, ...r },
        ...d,
      });
    expect(evaluateIntake(reg({ isLatest: false }), vendors, 10).reasons).toEqual(['not_latest']);
    expect(
      evaluateIntake(reg({ hasRepoUrl: false }, { repo: null, sourceUrl: null }), vendors, 10)
        .reasons,
    ).toEqual(['no_repo_url']);
  });

  it('treats allowlisted registry namespaces (and sub-namespaces) as vendors', () => {
    const d = draft({
      repo: repo({ stars: 1 }),
      registry: { isLatest: true, namespace: 'com.example-vendor.tools', hasRepoUrl: true },
    });
    expect(evaluateIntake(d, vendors, 10)).toMatchObject({ pass: true, vendor: true });
  });

  it('rejects records whose repo could not be resolved', () => {
    expect(evaluateIntake(draft({ repo: null, sourceUrl: null }), vendors, 10).reasons).toEqual([
      'repo_unavailable',
    ]);
  });
});

describe('compareIntakePriority', () => {
  it('orders vendor first, then star velocity, then stars, then URL', () => {
    const items = [
      { vendor: false, starVelocity7d: 5, stars: 100, sourceUrl: 'c' },
      { vendor: true, starVelocity7d: 0, stars: 1, sourceUrl: 'v' },
      { vendor: false, starVelocity7d: 9, stars: 10, sourceUrl: 'b' },
      { vendor: false, starVelocity7d: 5, stars: 200, sourceUrl: 'a' },
      { vendor: false, starVelocity7d: 5, stars: 200, sourceUrl: 'aa' },
    ];
    expect([...items].sort(compareIntakePriority).map((i) => i.sourceUrl)).toEqual([
      'v',
      'b',
      'a',
      'aa',
      'c',
    ]);
  });
});

describe('starVelocity7d', () => {
  const now = new Date('2026-10-19T00:00:00Z');
  it('uses the difference from an observation at least a day old', () => {
    expect(starVelocity7d(70, now, { stars: 50, at: new Date('2026-10-17T00:00:00Z') }, null)).toBe(
      70,
    );
  });
  it('keeps the old value when the last observation is under a day old', () => {
    expect(
      starVelocity7d(70, now, { stars: 50, at: new Date('2026-10-18T12:00:00Z') }, null),
    ).toBeUndefined();
  });
  it('falls back to the lifetime average, counting at least a week', () => {
    expect(starVelocity7d(70, now, undefined, '2026-10-05T00:00:00Z')).toBe(35);
    expect(starVelocity7d(70, now, undefined, '2026-10-18T00:00:00Z')).toBe(70);
    expect(starVelocity7d(70, now, undefined, null)).toBe(0);
  });
});
