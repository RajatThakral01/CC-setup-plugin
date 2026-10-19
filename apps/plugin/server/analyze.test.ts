import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeProject } from './analyze.js';

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../../test/fixtures/projects/${name}`, import.meta.url));

describe('analyzeProject', () => {
  it('profiles a fresh Next.js app', async () => {
    expect(await analyzeProject(fixture('next-fresh'))).toEqual({
      packageManager: 'pnpm',
      isNextjs: true,
      nextVersion: '16.0.0',
      router: 'app',
      typescript: true,
      testRunners: ['vitest', 'playwright'],
      styling: ['tailwindcss'],
      databaseLibs: ['@prisma/client'],
      integrations: [],
      monorepo: { isMonorepo: false, markers: [], packages: [] },
      existingConfig: {
        claudeMd: false,
        mcpJson: false,
        claudeDir: false,
        settingsJson: false,
        agentsDir: false,
        skillsDir: false,
      },
      mcpServerNames: [],
      stacks: ['nextjs'],
      isGitRepo: false,
    });
  });

  it('sees existing config and integrations', async () => {
    const p = await analyzeProject(fixture('next-existing'));
    expect(p).toMatchObject({
      packageManager: 'npm',
      nextVersion: '15.5.0',
      databaseLibs: ['@supabase/supabase-js'],
      integrations: ['stripe'],
      existingConfig: { claudeMd: true, mcpJson: true },
      mcpServerNames: ['example-unknown-server'],
    });
  });

  it('detects monorepos and their packages', async () => {
    expect((await analyzeProject(fixture('next-monorepo'))).monorepo).toEqual({
      isMonorepo: true,
      markers: ['pnpm-workspace.yaml', 'turbo.json'],
      packages: ['apps/docs', 'apps/web', 'packages/ui'],
    });
  });

  it('reports a non-Next.js project as unsupported', async () => {
    expect(await analyzeProject(fixture('not-next'))).toMatchObject({
      isNextjs: false,
      stacks: [],
      packageManager: null,
    });
  });
});
