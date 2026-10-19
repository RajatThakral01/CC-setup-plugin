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
});
