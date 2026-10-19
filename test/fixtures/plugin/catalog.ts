import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import type { Snapshot, SnapshotItem } from '@cc-setup-agent/shared';

const checkedAt = '2026-10-18T00:00:00.000Z';
const gates = (g3: 'pass' | 'fail' = 'pass') => ({
  gate0_hygiene: { result: 'pass' as const, evidence: [], checkedAt },
  gate1_provenance: { result: 'pass' as const, evidence: [], checkedAt },
  gate2_health: { result: 'pass' as const, evidence: [], checkedAt },
  gate3_security: { result: g3, evidence: [], checkedAt },
});

function item(id: string, overrides: Partial<SnapshotItem>): SnapshotItem {
  return {
    id,
    name: id,
    kind: 'mcp_server',
    category: 'docs',
    stacks: ['nextjs'],
    sourceUrl: `https://github.com/example-org/${id}`,
    publisher: 'example-org',
    provenance: 'official_vendor',
    status: 'recommended',
    version: '1.0.0',
    install: {
      method: 'npx',
      package: `@example/${id.replace(/^example-/, '')}`,
      version: '1.0.0',
      envVars: [],
    },
    capabilities: [],
    contextOverheadTokens: 1000,
    supersedes: null,
    supersededBy: null,
    scorecard: { confidence: 'high', gates: gates(), securityFlags: 0, reviewedAt: checkedAt },
    evalSummary: null,
    lastChecked: checkedAt,
    ...overrides,
  };
}

/** Fake catalog covering every recommendation path. Obviously fake names (test/fixtures rule). */
export function fixtureSnapshot(generatedAt = '2026-10-19T02:00:00.000Z'): Snapshot {
  return {
    schemaVersion: 1,
    version: '2026.10.19-1',
    generatedAt,
    items: [
      item('example-docs-mcp', {
        install: { method: 'npx', package: '@example/docs-mcp', version: '1.2.0', envVars: [] },
        version: '1.2.0',
        contextOverheadTokens: 1200,
      }),
      item('example-docs-alt', {
        provenance: 'community',
        scorecard: {
          confidence: 'medium',
          gates: gates(),
          securityFlags: 0,
          reviewedAt: checkedAt,
        },
      }),
      item('example-playwright-mcp', {
        category: 'browser_testing',
        capabilities: ['browser', 'network'],
        contextOverheadTokens: 3000,
      }),
      item('example-vitest-skill', {
        kind: 'skill',
        category: 'unit_testing',
        install: {
          method: 'skill_copy',
          url: 'https://github.com/example-org/example-vitest-skill',
          envVars: [],
        },
        contextOverheadTokens: null,
      }),
      item('example-prisma-mcp', {
        category: 'database',
        provenance: 'community',
        scorecard: {
          confidence: 'medium',
          gates: gates(),
          securityFlags: 0,
          reviewedAt: checkedAt,
        },
      }),
      item('example-supabase-mcp', {
        category: 'database',
        install: {
          method: 'npx',
          package: '@example/supabase-mcp',
          version: '2.0.0',
          envVars: ['EXAMPLE_SUPABASE_TOKEN'],
        },
        version: '2.0.0',
      }),
      item('example-vercel-mcp', {
        category: 'deploy',
        install: { method: 'remote', url: 'https://mcp.example.test/vercel', envVars: [] },
      }),
      item('example-review-plugin', {
        kind: 'plugin',
        category: 'code_review',
        stacks: ['any'],
        sourceUrl: 'https://github.com/example-org/example-plugins/tree/main/plugins/review',
        install: {
          method: 'plugin',
          plugin: { marketplace: 'example-market', name: 'review' },
          envVars: [],
        },
        contextOverheadTokens: null,
      }),
      item('example-git-mcp', {
        category: 'git_github',
        stacks: ['any'],
        install: {
          method: 'uvx',
          package: 'example-git-mcp',
          version: '0.3.0',
          envVars: ['EXAMPLE_GIT_TOKEN'],
        },
        version: '0.3.0',
        capabilities: ['shell'],
      }),
      item('example-tailwind-ui', {
        category: 'ui_components',
        status: 'recommended_provisional',
        scorecard: { confidence: 'medium', gates: gates(), securityFlags: 0, reviewedAt: null },
      }),
      item('example-stripe-mcp', {
        category: 'payments',
        install: {
          method: 'npx',
          package: '@example/stripe-mcp',
          version: '3.1.0',
          envVars: ['EXAMPLE_STRIPE_KEY'],
        },
        version: '3.1.0',
      }),
      item('example-blocked-mcp', {
        status: 'blocked',
        category: null,
        install: { method: 'npx', package: '@example/blocked-mcp', version: '0.1.0', envVars: [] },
        scorecard: {
          confidence: 'low',
          gates: gates('fail'),
          securityFlags: 2,
          reviewedAt: checkedAt,
        },
      }),
      item('example-watch-mcp', { status: 'watchlist', category: 'search' }),
    ].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export interface SignedCatalogDir {
  dir: string;
  url: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

/** Writes a signed snapshot plus latest.json into a fresh temp folder (like the local store). */
export async function writeSignedCatalog(
  snapshot: Snapshot,
  keys?: { publicKeyPem: string; privateKeyPem: string },
): Promise<SignedCatalogDir> {
  const pair =
    keys ??
    (() => {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      return {
        privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      };
    })();
  const dir = await mkdtemp(join(tmpdir(), 'ccsa-catalog-'));
  await mkdir(dir, { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
  const name = `catalog-${snapshot.version}.json`;
  const signature = sign(null, bytes, pair.privateKeyPem).toString('base64');
  await writeFile(join(dir, name), bytes);
  await writeFile(join(dir, `${name}.sig`), `${signature}\n`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(
    join(dir, 'latest.json'),
    JSON.stringify({ version: snapshot.version, catalog: name, signature: `${name}.sig`, sha256 }),
  );
  return { dir, url: `file://${dir}/`, ...pair };
}
