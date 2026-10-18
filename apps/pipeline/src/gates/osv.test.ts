import { describe, expect, it } from 'vitest';
import { json } from '../../../../test/support/fake-fetch.js';
import { fakeHttp } from '../../../../test/support/http.js';
import { osvFindings, osvSeverity, resolveDirectDeps } from './osv.js';
import { createNpmClient } from '../sources/npm.js';

const OSV = 'https://osv.example.test/v1';

describe('osvFindings', () => {
  it('queries the batch API and resolves severities', async () => {
    const { http } = fakeHttp({
      [`${OSV}/querybatch`]: json({
        results: [{ vulns: [{ id: 'GHSA-aaaa' }, { id: 'GHSA-bbbb' }] }, {}],
      }),
      [`${OSV}/vulns/GHSA-aaaa`]: json({
        id: 'GHSA-aaaa',
        summary: 'bad thing',
        database_specific: { severity: 'HIGH' },
      }),
      [`${OSV}/vulns/GHSA-bbbb`]: json({
        id: 'GHSA-bbbb',
        database_specific: { severity: 'MODERATE' },
      }),
    });
    const r = await osvFindings(http, OSV, [
      { ecosystem: 'npm', name: 'example-dep', version: '1.0.0' },
      { ecosystem: 'npm', name: 'example-clean', version: '2.0.0' },
    ]);
    expect(r.checked).toBe(2);
    expect(r.findings).toEqual([
      expect.objectContaining({
        severity: 'high',
        description: 'example-dep@1.0.0 has GHSA-aaaa: bad thing',
        evidence: 'https://osv.dev/vulnerability/GHSA-aaaa',
      }),
      expect.objectContaining({ severity: 'medium' }),
    ]);
  });

  it('skips the call when there is nothing to check', async () => {
    const { http, calls } = fakeHttp({});
    expect(await osvFindings(http, OSV, [])).toEqual({ findings: [], checked: 0 });
    expect(calls).toEqual([]);
  });

  it('maps CVSS scores when no label exists', () => {
    expect(osvSeverity({ id: 'x', severity: [{ type: 'CVSS_V3', score: '9.8' }] })).toBe(
      'critical',
    );
    expect(osvSeverity({ id: 'x' })).toBe('medium');
  });
});

describe('resolveDirectDeps', () => {
  it('resolves each range to the highest matching published version', async () => {
    const { http } = fakeHttp({
      'https://npm.example.test/example-dep': json({
        name: 'example-dep',
        'dist-tags': { latest: '2.0.0' },
        versions: {
          '1.0.0': { version: '1.0.0' },
          '1.4.2': { version: '1.4.2' },
          '2.0.0': { version: '2.0.0' },
        },
      }),
    });
    const npm = createNpmClient(http, 'https://npm.example.test');
    expect(
      await resolveDirectDeps(npm, { 'example-dep': '^1.0.0', 'example-missing': '^1.0.0' }),
    ).toEqual([{ ecosystem: 'npm', name: 'example-dep', version: '1.4.2' }]);
  });
});
