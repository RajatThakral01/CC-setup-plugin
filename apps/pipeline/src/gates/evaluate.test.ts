import { describe, expect, it } from 'vitest';
import { computeConfidence } from '@cc-setup-agent/shared';
import { POISONED_TOOLS, CLEAN_TOOLS } from '../../../../test/fixtures/mcp/server-template.js';
import { fakePackument } from '../../../../test/fixtures/sources/github.js';
import type { RepoFacts, RepoHealth } from '../sources/github.js';
import { gate0, gate1, gate2, gate3, type GateFacts } from './evaluate.js';
import { installScriptFindings, scanToolDefinitions, type Finding } from './rules.js';
import { statusChangeFor } from './run.js';

const now = new Date('2026-10-19T00:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

const repo: RepoFacts = {
  id: 1,
  fullName: 'example-org/example-mcp',
  owner: 'example-org',
  name: 'example-mcp',
  description: 'Fake',
  fork: false,
  archived: false,
  license: 'MIT',
  stars: 100,
  pushedAt: daysAgo(3),
  createdAt: daysAgo(400),
  defaultBranch: 'main',
};
const health: RepoHealth = {
  diskUsageKb: 500,
  defaultBranch: 'main',
  headSha: 'abcdef1234',
  lastCommitAt: daysAgo(3),
  latestRelease: { tag: 'v1.0.0', publishedAt: daysAgo(10) },
  releaseCount: 5,
  releaseDates: [daysAgo(10), daysAgo(70)],
  openIssues: 4,
  medianIssueResponseHours: 6,
  ownerLogin: 'example-org',
  ownerMaintainedRepos: 7,
};

function facts(overrides: Partial<GateFacts> = {}): GateFacts {
  return {
    kind: 'mcp_server',
    sourceUrl: 'https://github.com/example-org/example-mcp',
    repo,
    health,
    readmeLength: 2000,
    structure: {
      checked: false,
      hasSkillMd: false,
      hasPluginManifest: false,
      licenseFile: false,
      frontmatterLicense: null,
    },
    install: {
      install: { method: 'npx', package: 'example-mcp', version: '1.0.0', envVars: [] },
      version: '1.0.0',
      via: 'npm package',
      npm: { packument: fakePackument('example-mcp') as never, version: '1.0.0' },
    },
    start: { status: 'ok', tools: CLEAN_TOOLS },
    vendor: false,
    contributors: 12,
    weeklyDownloads: 5000,
    findings: [],
    scanned: { tools: true, text: false, packages: 3 },
    now,
    ...overrides,
  };
}
const all = (f: GateFacts) => ({
  gate0_hygiene: gate0(f).result,
  gate1_provenance: gate1(f).result,
  gate2_health: gate2(f).result,
  gate3_security: gate3(f).result,
});

describe('clean fixture', () => {
  it('passes every gate with high confidence', () => {
    const f = facts();
    expect(Object.values(all(f)).map((g) => g.result)).toEqual(['pass', 'pass', 'pass', 'pass']);
    expect(computeConfidence(all(f)).confidence).toBe('high');
    expect(gate1(f).provenance).toBe('community');
  });
});

describe('gate 0: hygiene', () => {
  it.each([
    ['no licence', { repo: { ...repo, license: null } }, 'no licence'],
    ['short README', { readmeLength: 50 }, 'README shorter'],
    ['fork', { repo: { ...repo, fork: true } }, 'fork'],
    ['empty repo', { health: { ...health, diskUsageKb: 0 } }, 'empty'],
    [
      'fails to install',
      { start: { status: 'failed' as const, detail: 'requirements are unsatisfiable', tools: [] } },
      'did not install',
    ],
  ])('hard-fails on %s', (_name, overrides, message) => {
    const r = gate0(facts(overrides as Partial<GateFacts>));
    expect(r.result.result).toBe('fail');
    expect(r.failures.join(' ')).toContain(message);
  });

  it('counts a GitHub release as the published artifact when nothing can be run', () => {
    const r = gate0(
      facts({
        install: { install: null, version: 'v1.0.0', via: 'none' },
        start: {
          status: 'not_attempted',
          tools: [],
          detail: 'no npm, PyPI or remote install found',
        },
      }),
    );
    expect(r.failures).toEqual([]);
    expect(r.result.result).toBe('soft_fail');
  });

  it('soft-fails, without rejecting, when no install method can be found', () => {
    const r = gate0(
      facts({
        install: { install: null, version: 'sha-1', via: 'none' },
        health: { ...health, latestRelease: null },
        start: { status: 'not_attempted', tools: [] },
      }),
    );
    expect(r.failures).toEqual([]);
    expect(r.result).toMatchObject({ result: 'soft_fail' });
    expect(r.result.notes).toContain('install method unknown');
  });

  it('soft-fails when the server installed but needs configuration to start', () => {
    const r = gate0(
      facts({
        start: { status: 'needs_config', tools: [], detail: 'Error: EXAMPLE_API_KEY is required' },
      }),
    );
    expect(r).toMatchObject({ failures: [], result: { result: 'soft_fail' } });
  });

  it('accepts a licence from SKILL.md frontmatter', () => {
    expect(
      gate0(
        facts({
          repo: { ...repo, license: null },
          structure: {
            checked: true,
            hasSkillMd: true,
            hasPluginManifest: false,
            licenseFile: false,
            frontmatterLicense: 'Apache-2.0',
          },
        }),
      ).failures,
    ).toEqual([]);
  });

  it('accepts a licence file inside a folder item', () => {
    expect(
      gate0(
        facts({
          repo: { ...repo, license: null },
          structure: {
            checked: true,
            hasSkillMd: true,
            hasPluginManifest: false,
            licenseFile: true,
            frontmatterLicense: null,
          },
        }),
      ).failures,
    ).toEqual([]);
  });

  it('soft-fails when a remote server needs credentials', () => {
    const r = gate0(
      facts({
        install: {
          install: { method: 'remote', url: 'https://x.test/mcp', envVars: [] },
          version: '1',
          via: 'MCP Registry remote',
        },
        start: { status: 'auth_required', tools: [] },
      }),
    );
    expect(r.result.result).toBe('soft_fail');
  });

  it('requires SKILL.md for skills when the tree was checked', () => {
    const skill = facts({
      kind: 'skill',
      install: { install: { method: 'skill_copy', envVars: [] }, version: 'sha-1', via: 'repo' },
      start: { status: 'not_applicable', tools: [] },
    });
    expect(
      gate0({
        ...skill,
        structure: {
          checked: true,
          hasSkillMd: false,
          hasPluginManifest: false,
          licenseFile: false,
          frontmatterLicense: null,
        },
      }).failures,
    ).toEqual(['no SKILL.md found']);
    expect(
      gate0({
        ...skill,
        structure: {
          checked: true,
          hasSkillMd: true,
          hasPluginManifest: false,
          licenseFile: false,
          frontmatterLicense: null,
        },
      }).result.result,
    ).toBe('pass');
  });
});

describe('gate 1: provenance', () => {
  it('recognises Anthropic, vendors and established community authors', () => {
    expect(gate1(facts({ repo: { ...repo, owner: 'anthropics' } })).provenance).toBe('anthropic');
    expect(gate1(facts({ vendor: true }))).toMatchObject({
      provenance: 'official_vendor',
      result: { result: 'pass' },
    });
    expect(gate1(facts({ health: { ...health, ownerMaintainedRepos: 1 } })).result.result).toBe(
      'soft_fail',
    );
  });
});

describe('gate 2: health', () => {
  it('passes recent activity, soft-fails stale and flags abandoned repos', () => {
    expect(gate2(facts()).abandoned).toBe(false);
    const stale = gate2(facts({ health: { ...health, lastCommitAt: daysAgo(120) } }));
    expect(stale).toMatchObject({ abandoned: false, result: { result: 'soft_fail' } });
    const abandoned = gate2(facts({ health: { ...health, lastCommitAt: daysAgo(200) } }));
    expect(abandoned).toMatchObject({ abandoned: true, result: { result: 'soft_fail' } });
    expect(abandoned.result.notes).toContain('abandoned');
  });
});

describe('gate 3: security', () => {
  const vuln = (severity: Finding['severity']): Finding => ({
    rule: 'vulnerable_dependency',
    severity,
    confirmed: false,
    description: 'example-dep@1.0.0 has GHSA-x',
  });

  it('blocks the poisoned fixture', () => {
    const r = gate3(
      facts({
        start: { status: 'ok', tools: POISONED_TOOLS },
        findings: scanToolDefinitions(POISONED_TOOLS),
      }),
    );
    expect(r).toMatchObject({ block: true, result: { result: 'fail' } });
    expect(computeConfidence({ ...all(facts()), gate3_security: r.result }).confidence).toBe('low');
  });

  it('fails without blocking on a high-severity vulnerable dependency', () => {
    expect(gate3(facts({ findings: [vuln('high')] }))).toMatchObject({
      block: false,
      result: { result: 'fail' },
    });
  });

  it('ignores moderate vulnerabilities but soft-fails on install scripts', () => {
    expect(gate3(facts({ findings: [vuln('medium')] })).result.result).toBe('pass');
    expect(
      gate3(facts({ findings: installScriptFindings({ postinstall: 'x' }, 'p') })).result.result,
    ).toBe('soft_fail');
  });

  it('reports not_run when nothing could be scanned', () => {
    expect(
      gate3(facts({ scanned: { tools: false, text: false, packages: 0 } })).result.result,
    ).toBe('not_run');
  });
});

describe('confidence', () => {
  it('caps at medium when hygiene or security could not be fully checked', () => {
    expect(
      computeConfidence({
        gate0_hygiene: { result: 'pass' },
        gate1_provenance: { result: 'pass' },
        gate2_health: { result: 'pass' },
      }).confidence,
    ).toBe('medium');
    expect(computeConfidence({}).confidence).toBe('low');
  });
});

describe('statusChangeFor', () => {
  const ok = { block: false, hygieneFailures: [], abandoned: false };
  it('maps gate outcomes to status changes', () => {
    expect(statusChangeFor('candidate', { ...ok, block: true })?.to).toBe('blocked');
    expect(statusChangeFor('candidate', { ...ok, hygieneFailures: ['no licence'] })?.to).toBe(
      'rejected',
    );
    expect(statusChangeFor('recommended', { ...ok, hygieneFailures: ['no licence'] })?.to).toBe(
      'watchlist',
    );
    expect(statusChangeFor('recommended', { ...ok, abandoned: true })?.to).toBe('watchlist');
    expect(statusChangeFor('candidate', { ...ok, abandoned: true })).toBeNull();
    expect(statusChangeFor('candidate', ok)).toBeNull();
  });
  it('lifts system rejections when hygiene passes, but never human ones', () => {
    expect(statusChangeFor('rejected', { ...ok, rejectedBySystem: true })?.to).toBe('candidate');
    expect(statusChangeFor('rejected', { ...ok, rejectedBySystem: false })).toBeNull();
  });
});
