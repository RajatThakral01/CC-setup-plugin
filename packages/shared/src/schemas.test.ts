import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { installSchema, pinnedVersionSchema, itemIdSchema } from './catalog.js';
import { snapshotSchema } from './snapshot.js';
import {
  generateConfigOutputSchema,
  recommendSetupInputSchema,
  setupAnswersSchema,
} from './mcp-tools.js';

const fixture: unknown = JSON.parse(
  readFileSync(new URL('../../../test/fixtures/catalog/snapshot.json', import.meta.url), 'utf8'),
);

describe('snapshot schema', () => {
  it('round-trips the fixture catalog', () => {
    const parsed = snapshotSchema.parse(fixture);
    const again = snapshotSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(again).toEqual(parsed);
    expect(again.items.map((i) => i.id)).toEqual(['example-mcp-alpha', 'example-skill-beta']);
  });

  const mutate = (
    fn: (s: Record<string, unknown> & { items: Array<Record<string, unknown>> }) => void,
  ) => {
    const copy = structuredClone(fixture) as Record<string, unknown> & {
      items: Array<Record<string, unknown>>;
    };
    fn(copy);
    return snapshotSchema.safeParse(copy).success;
  };

  it('rejects candidate and rejected items', () => {
    expect(mutate((s) => (s.items[0]!['status'] = 'candidate'))).toBe(false);
    expect(mutate((s) => (s.items[0]!['status'] = 'rejected'))).toBe(false);
  });
  it('rejects a bad version format', () => {
    expect(mutate((s) => (s.version = '2026-10-19'))).toBe(false);
    expect(mutate((s) => (s.version = '2026.10.19-0'))).toBe(false);
  });
  it('rejects duplicate ids', () => {
    expect(mutate((s) => s.items.push(structuredClone(s.items[0]!)))).toBe(false);
  });
  it('rejects unknown categories and missing fields', () => {
    expect(mutate((s) => (s.items[0]!['category'] = 'everything'))).toBe(false);
    expect(mutate((s) => delete s.items[0]!['install'])).toBe(false);
  });
});

describe('catalog field schemas', () => {
  it.each(['1.2.3', 'v2.0.0', '0.0.1-beta.1', 'abc1234'])('accepts pinned version %s', (v) => {
    expect(pinnedVersionSchema.safeParse(v).success).toBe(true);
  });
  it.each(['latest', 'LATEST', '^1.2.3', '~1.2', '>=1', '1.x', '*', '1.2 || 2'])(
    'refuses %s',
    (v) => {
      expect(pinnedVersionSchema.safeParse(v).success).toBe(false);
    },
  );
  it('refuses env var values posing as names', () => {
    expect(installSchema.safeParse({ method: 'npx', envVars: ['TOKEN=abc'] }).success).toBe(false);
  });
  it('validates slugs', () => {
    expect(itemIdSchema.safeParse('example-mcp-alpha').success).toBe(true);
    expect(itemIdSchema.safeParse('Example_MCP').success).toBe(false);
  });
});

describe('MCP tool schemas', () => {
  it('validates setup answers', () => {
    expect(
      setupAnswersSchema.safeParse({
        goal: 'marketing site',
        deployTarget: 'vercel',
        budgetSensitivity: 'medium',
        riskTolerance: 'low',
        workflow: 'test_first',
      }).success,
    ).toBe(true);
    expect(recommendSetupInputSchema.safeParse({ profile: {}, answers: {} }).success).toBe(false);
  });
  it('refuses absolute or escaping paths in generated files', () => {
    const base = {
      catalogVersion: '2026.10.19-1',
      claudeCodeVersion: '2.1.303',
      requiredEnvVars: [],
      installCommands: [],
      skippedHooks: [],
    };
    const file = { action: 'create', content: '', diff: '' };
    expect(
      generateConfigOutputSchema.safeParse({ ...base, files: [{ ...file, path: '.mcp.json' }] })
        .success,
    ).toBe(true);
    expect(
      generateConfigOutputSchema.safeParse({ ...base, files: [{ ...file, path: '/etc/passwd' }] })
        .success,
    ).toBe(false);
    expect(
      generateConfigOutputSchema.safeParse({ ...base, files: [{ ...file, path: '../x' }] }).success,
    ).toBe(false);
  });
});
