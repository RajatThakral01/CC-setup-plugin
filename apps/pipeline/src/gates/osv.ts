import semver from 'semver';
import { z } from 'zod';
import type { HttpClient } from '@cc-setup-agent/core';
import type { NpmClient } from '../sources/npm.js';
import type { Finding } from './rules.js';

const querybatchSchema = z.object({
  results: z.array(z.object({ vulns: z.array(z.object({ id: z.string() })).optional() })),
});
const vulnSchema = z.looseObject({
  id: z.string(),
  summary: z.string().optional(),
  database_specific: z.looseObject({ severity: z.string().optional() }).optional(),
  severity: z.array(z.object({ type: z.string(), score: z.string() })).optional(),
});

export interface PackageVersion {
  ecosystem: 'npm' | 'PyPI';
  name: string;
  version: string;
}

/** Severity from GHSA's database_specific field, else a CVSS v3 base score if present. */
export function osvSeverity(v: z.infer<typeof vulnSchema>): 'low' | 'medium' | 'high' | 'critical' {
  const label = v.database_specific?.severity?.toLowerCase();
  if (label === 'critical' || label === 'high' || label === 'low') return label;
  if (label === 'moderate' || label === 'medium') return 'medium';
  const score = v.severity
    ?.map((s) => Number(/\/?(\d+(\.\d+)?)$/.exec(s.score)?.[1]))
    .find((n) => Number.isFinite(n) && n <= 10);
  if (score !== undefined)
    return score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : 'low';
  return 'medium';
}

/**
 * Direct npm dependencies of a package version, each resolved to the highest published version
 * that satisfies its range (approximates what a fresh install gets; transitive deps not covered).
 */
export async function resolveDirectDeps(
  npm: NpmClient,
  deps: Record<string, string> | undefined,
): Promise<PackageVersion[]> {
  const out: PackageVersion[] = [];
  for (const [name, range] of Object.entries(deps ?? {}).slice(0, 60)) {
    try {
      const p = await npm.getPackument(name);
      const version = semver.maxSatisfying(Object.keys(p.versions), range);
      if (version) out.push({ ecosystem: 'npm', name, version });
    } catch {
      // Unresolvable dependency (git URL, removed package); OSV can't check it either.
    }
  }
  return out;
}

/** Known vulnerabilities for the given packages (PRD FR-C3). High and critical are flagged. */
export async function osvFindings(
  http: HttpClient,
  osvUrl: string,
  packages: PackageVersion[],
): Promise<{ findings: Finding[]; checked: number }> {
  if (packages.length === 0) return { findings: [], checked: 0 };
  const base = osvUrl.replace(/\/+$/, '');
  const response = await http.request(`${base}/querybatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      queries: packages.map((p) => ({
        package: { name: p.name, ecosystem: p.ecosystem },
        version: p.version,
      })),
    }),
  });
  const batch = querybatchSchema.parse(await response.json());
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const [i, result] of batch.results.entries()) {
    for (const { id } of result.vulns ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      const vuln = await http.getJson(`${base}/vulns/${encodeURIComponent(id)}`, vulnSchema);
      const severity = osvSeverity(vuln);
      const pkg = packages[i]!;
      findings.push({
        rule: 'vulnerable_dependency',
        severity,
        confirmed: false,
        description: `${pkg.name}@${pkg.version} has ${id}${vuln.summary ? `: ${vuln.summary}` : ''}`,
        evidence: `https://osv.dev/vulnerability/${id}`,
      });
    }
  }
  return { findings, checked: packages.length };
}
