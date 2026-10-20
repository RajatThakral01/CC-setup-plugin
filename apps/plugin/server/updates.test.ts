import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fixtureSnapshot } from '../../../test/fixtures/plugin/catalog.js';
import { blockedWarnings, checkUpdates } from './updates.js';

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../../test/fixtures/projects/${name}`, import.meta.url));

describe('checkUpdates', () => {
  it('lists blocked items first, then version updates and unknown servers', async () => {
    const notices = await checkUpdates(fixture('next-blocked'), fixtureSnapshot());
    expect(notices.map((n) => [n.id, n.type, n.severity])).toEqual([
      ['example-blocked-mcp', 'blocked', 'critical'],
      ['example-docs-mcp', 'new_version', 'info'],
    ]);
    expect(notices[0]?.message).toMatch(/BLOCKED/);
  });

  it('labels servers that are not in the catalog', async () => {
    expect(await checkUpdates(fixture('next-existing'), fixtureSnapshot())).toEqual([
      expect.objectContaining({
        id: 'example-unknown-server',
        type: 'not_in_catalog',
        severity: 'info',
      }),
    ]);
  });

  it('produces the blocked warning shown on the next run', async () => {
    expect(await blockedWarnings(fixture('next-blocked'), fixtureSnapshot())).toEqual([
      expect.stringMatching(/example-blocked-mcp is BLOCKED/),
    ]);
    expect(await blockedWarnings(fixture('next-fresh'), fixtureSnapshot())).toEqual([]);
  });

  it('warns about a version that stays blocked after its item was unblocked (FR-P10)', async () => {
    const snapshot = {
      ...fixtureSnapshot(),
      blockedVersions: [
        {
          id: 'example-docs-mcp',
          name: 'Example Docs MCP',
          package: '@example/docs-mcp',
          sourceUrl: 'https://github.com/example-org/example-docs-mcp',
          versions: ['1.0.0'],
          reason: 'blocked for security; a newer version fixed it',
        },
      ],
    };
    const notices = await checkUpdates(fixture('next-blocked'), snapshot);
    expect(notices.find((n) => n.id === 'example-docs-mcp')).toMatchObject({
      type: 'blocked',
      severity: 'critical',
      message: expect.stringMatching(/1\.0\.0 is BLOCKED/),
    });
    expect(await blockedWarnings(fixture('next-blocked'), snapshot)).toHaveLength(2);
  });
});
