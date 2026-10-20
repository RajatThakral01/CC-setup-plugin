import type { GateResult, Provenance } from '@cc-setup-agent/shared';
import type { RepoFacts, RepoHealth } from '../sources/github.js';
import type { ResolvedInstall } from './install.js';
import type { Finding } from './rules.js';
import type { ToolDefinition } from './sandbox/probe.js';

export const MIN_README_CHARS = 200;
export const HEALTHY_DAYS = 90;
export const ABANDONED_DAYS = 180;
export const MIN_MAINTAINED_REPOS = 3;

/**
 * `failed`: the package could not be installed (unresolvable or missing), a hard failure.
 * `needs_config`: installed but would not start without credentials, arguments or a different
 * entry point; start is unverified (soft). `auth_required`: remote server refused anonymous access.
 */
export type StartStatus =
  'ok' | 'failed' | 'needs_config' | 'auth_required' | 'not_applicable' | 'not_attempted';

export interface GateFacts {
  kind: string | null;
  sourceUrl: string;
  repo: RepoFacts | null;
  health: RepoHealth | null;
  readmeLength: number;
  structure: {
    checked: boolean;
    hasSkillMd: boolean;
    hasPluginManifest: boolean;
    /** A LICENSE/COPYING file anywhere in the item's tree (repo, or folder for folder items). */
    licenseFile: boolean;
    /** `license:` from SKILL.md frontmatter, if any. */
    frontmatterLicense: string | null;
  };
  install: ResolvedInstall;
  start: { status: StartStatus; detail?: string; tools: ToolDefinition[] };
  vendor: boolean;
  contributors: number | null;
  weeklyDownloads: number | null;
  findings: Finding[];
  /** What gate 3 could scan: tool definitions, instruction text, config files, packages. */
  scanned: { tools: boolean; text: boolean; config?: boolean; packages: number };
  /** MCP servers a plugin bundles, and those whose tools could not be checked (M8.3). */
  bundled?: { servers: number; unprobed: string[] };
  now: Date;
}

type Evidence = GateResult['evidence'];
const ev = (label: string, detail?: string, url?: string): Evidence[number] => ({
  label,
  ...(detail !== undefined ? { detail } : {}),
  ...(url ? { url } : {}),
});

function licenseOf(f: GateFacts): string | null {
  if (f.repo?.license) return f.repo.license;
  // Skill and plugin collections often keep licences per folder or in SKILL.md frontmatter.
  if (f.structure.licenseFile) return 'licence file in the item tree';
  if (f.structure.frontmatterLicense) return f.structure.frontmatterLicense;
  const npmLicense =
    f.install.npm?.packument.license ??
    f.install.npm?.packument.versions[f.install.npm.version]?.license;
  if (typeof npmLicense === 'string' && npmLicense) return npmLicense;
  return f.install.pypi?.license || null;
}

export interface Gate0Outcome {
  result: GateResult;
  /** Hard failures; any of them rejects the item (FR-C0). */
  failures: string[];
}

/** Gate 0, hygiene: licence, README, real code, an installable artifact, installs and starts. */
export function gate0(f: GateFacts): Gate0Outcome {
  const failures: string[] = [];
  const notes: string[] = [];
  const evidence: Evidence = [ev('source', undefined, f.sourceUrl)];

  const license = licenseOf(f);
  if (license) evidence.push(ev('licence', license));
  else failures.push('no licence');

  evidence.push(ev('README length', String(f.readmeLength)));
  if (f.readmeLength < MIN_README_CHARS)
    failures.push(`README shorter than ${MIN_README_CHARS} characters`);

  if (f.repo) {
    if (f.repo.fork) failures.push('repository is a fork');
    if (f.health?.diskUsageKb === 0) failures.push('repository is empty');
  }

  if (f.kind === 'mcp_server') {
    const method = f.install.install?.method;
    if (method === 'npx' || method === 'uvx' || method === 'remote') {
      evidence.push(
        ev(
          'install',
          `${method} ${f.install.install?.package ?? f.install.install?.url ?? ''}${f.install.version ? ` @ ${f.install.version}` : ''} (via ${f.install.via})`,
        ),
      );
    } else if (f.health?.latestRelease) {
      // FR-C0 asks for "a release or published package"; a GitHub release counts even when we
      // can't run it (Go binary, Docker image).
      evidence.push(
        ev(
          'install',
          `release ${f.health.latestRelease.tag} (no npm, PyPI or remote install found)`,
        ),
      );
    } else {
      // Not a hygiene failure we can prove: we just couldn't find how to install it. Without install
      // details the item can't be recommended anyway (the snapshot needs them).
      notes.push('install method unknown: no npm/PyPI package, remote endpoint or release found');
    }
  } else if (f.kind === 'skill' && f.structure.checked && !f.structure.hasSkillMd) {
    failures.push('no SKILL.md found');
  } else if (
    f.kind === 'plugin' &&
    f.structure.checked &&
    !f.structure.hasPluginManifest &&
    f.install.via !== 'marketplace'
  ) {
    failures.push('no .claude-plugin/plugin.json found and not listed in a marketplace');
  }
  if (f.health?.latestRelease) evidence.push(ev('latest release', f.health.latestRelease.tag));

  switch (f.start.status) {
    case 'ok':
      evidence.push(ev('starts', `listTools returned ${f.start.tools.length} tool(s)`));
      break;
    case 'failed':
      failures.push(`did not install: ${f.start.detail ?? 'unknown error'}`);
      break;
    case 'auth_required':
      notes.push('remote server needs credentials; start not verified');
      break;
    case 'needs_config':
      notes.push(
        `installed but did not start without configuration; start not verified: ${f.start.detail ?? 'unknown'}`,
      );
      break;
    case 'not_attempted':
      if (f.kind === 'mcp_server')
        notes.push(`start not verified: ${f.start.detail ?? 'no runnable install'}`);
      break;
    case 'not_applicable':
      break;
  }
  const result: GateResult['result'] =
    failures.length > 0 ? 'fail' : notes.length > 0 ? 'soft_fail' : 'pass';
  return {
    failures,
    result: {
      result,
      evidence,
      ...(failures.length + notes.length > 0 ? { notes: [...failures, ...notes].join('; ') } : {}),
      checkedAt: f.now.toISOString(),
    },
  };
}

/** Gate 1, provenance (FR-C1): Anthropic, an allowlisted vendor, or community. Soft gate. */
export function gate1(f: GateFacts): { result: GateResult; provenance: Provenance } {
  const owner = f.repo?.owner ?? f.health?.ownerLogin ?? null;
  const provenance: Provenance =
    owner?.toLowerCase() === 'anthropics'
      ? 'anthropic'
      : f.vendor
        ? 'official_vendor'
        : 'community';
  const maintained = f.health?.ownerMaintainedRepos ?? null;
  const evidence: Evidence = [ev('publisher', owner ?? 'unknown'), ev('provenance', provenance)];
  if (maintained !== null)
    evidence.push(ev("owner's other maintained repos (180 days)", String(maintained)));
  const ok = provenance !== 'community' || (maintained ?? 0) >= MIN_MAINTAINED_REPOS;
  return {
    provenance,
    result: {
      result: owner === null ? 'not_run' : ok ? 'pass' : 'soft_fail',
      evidence,
      ...(ok
        ? {}
        : {
            notes: `community publisher with fewer than ${MIN_MAINTAINED_REPOS} other maintained repos`,
          }),
      checkedAt: f.now.toISOString(),
    },
  };
}

/** Gate 2, health (FR-C2): last commit, releases, issue response, contributors, downloads. */
export function gate2(f: GateFacts): {
  result: GateResult;
  abandoned: boolean;
  lastCommitAt: string | null;
} {
  const lastCommitAt =
    f.health?.lastCommitAt ??
    f.repo?.pushedAt ??
    (f.install.npm ? (f.install.npm.packument.time?.[f.install.npm.version] ?? null) : null);
  const evidence: Evidence = [];
  if (lastCommitAt) evidence.push(ev('last commit', lastCommitAt));
  if (f.health) {
    const recent = f.health.releaseDates.filter(
      (d) => Date.parse(d) >= f.now.getTime() - ABANDONED_DAYS * 86_400_000,
    ).length;
    evidence.push(ev('releases (last 180 days)', String(recent)));
    if (f.health.medianIssueResponseHours !== null)
      evidence.push(
        ev('median issue response (hours)', f.health.medianIssueResponseHours.toFixed(1)),
      );
    evidence.push(ev('open issues', String(f.health.openIssues)));
  }
  if (f.contributors !== null) evidence.push(ev('contributors', String(f.contributors)));
  if (f.weeklyDownloads !== null)
    evidence.push(ev('npm downloads (last week)', String(f.weeklyDownloads)));
  if (!lastCommitAt)
    return {
      abandoned: false,
      lastCommitAt: null,
      result: { result: 'not_run', evidence, checkedAt: f.now.toISOString() },
    };
  const ageDays = (f.now.getTime() - Date.parse(lastCommitAt)) / 86_400_000;
  const abandoned = ageDays > ABANDONED_DAYS;
  return {
    abandoned,
    lastCommitAt,
    result: {
      result: ageDays <= HEALTHY_DAYS ? 'pass' : 'soft_fail',
      evidence,
      ...(ageDays > HEALTHY_DAYS
        ? { notes: `no commit for ${Math.floor(ageDays)} days${abandoned ? ' (abandoned)' : ''}` }
        : {}),
      checkedAt: f.now.toISOString(),
    },
  };
}

/** Findings that count for the gate: vulnerabilities only from high upward (plan M4). */
export function countedFindings(findings: Finding[]): Finding[] {
  return findings.filter(
    (x) => x.rule !== 'vulnerable_dependency' || x.severity === 'high' || x.severity === 'critical',
  );
}

/**
 * Gate 3, security (FR-C3). Flagged items never pass. A finding confirmed by the independent review
 * blocks; one the review couldn't confirm blocks as suspected (M10 safeguard a).
 */
export function gate3(f: GateFacts): { result: GateResult; block: boolean; suspected: boolean } {
  const counted = countedFindings(f.findings);
  const block = counted.some((x) => x.confirmed);
  const suspected = !block && counted.some((x) => x.suspected === true);
  const severe = counted.some((x) => x.severity === 'high' || x.severity === 'critical');
  const medium = counted.some((x) => x.severity === 'medium');
  const scannedAnything =
    f.scanned.tools || f.scanned.text || f.scanned.config === true || f.scanned.packages > 0;
  const unprobed = f.bundled?.unprobed ?? [];
  const evidence: Evidence = [
    ev('tool definitions scanned', f.scanned.tools ? String(f.start.tools.length) : 'no'),
    ev('instruction text scanned', f.scanned.text ? 'yes' : 'no'),
    ev('config files scanned', f.scanned.config ? 'yes' : 'no'),
    ev('packages checked in OSV', String(f.scanned.packages)),
    ...(f.bundled && f.bundled.servers > 0
      ? [
          ev(
            'bundled MCP servers',
            `${f.bundled.servers} (${f.bundled.servers - unprobed.length} probed)`,
          ),
        ]
      : []),
    ...unprobed.map((u) => ev('bundled server not verified', u)),
    ...f.findings.map((x) =>
      ev(
        `${x.severity}: ${x.rule}`,
        x.description,
        x.evidence?.startsWith('https://') ? x.evidence : undefined,
      ),
    ),
  ];
  // A bundled server whose tools we couldn't check is a gap: never a pass.
  const result: GateResult['result'] =
    block || severe
      ? 'fail'
      : medium || (scannedAnything && unprobed.length > 0)
        ? 'soft_fail'
        : scannedAnything
          ? 'pass'
          : 'not_run';
  return {
    block,
    suspected,
    result: {
      result,
      evidence,
      ...(block
        ? { notes: 'confirmed prompt injection: blocked' }
        : suspected
          ? { notes: 'suspected prompt injection: blocked until a clean re-check' }
          : severe
            ? { notes: 'flagged: needs a written override to approve' }
            : unprobed.length > 0
              ? { notes: `bundled MCP server(s) not verified: ${unprobed.join('; ')}` }
              : {}),
      checkedAt: f.now.toISOString(),
    },
  };
}
