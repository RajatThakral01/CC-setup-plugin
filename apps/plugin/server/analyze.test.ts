import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mkdir } from 'node:fs/promises';
import {
  analyzeProject,
  gitRemoteHost,
  importsAgentsMd,
  pnpmWorkspaceHasPackages,
} from './analyze.js';

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
      dependencyVersions: {
        '@playwright/test': '^1.50.0',
        '@prisma/client': '^6.0.0',
        eslint: '^9.0.0',
        next: '^16.0.0',
        prettier: '^3.0.0',
        react: '^19.0.0',
        tailwindcss: '^4.0.0',
        typescript: '^5.9.0',
        vitest: '^3.0.0',
      },
      deployConfigs: [],
      gitRemoteHost: null,
      monorepo: { isMonorepo: false, markers: [], packages: [] },
      existingConfig: {
        claudeMd: false,
        mcpJson: false,
        claudeDir: false,
        settingsJson: false,
        agentsDir: false,
        skillsDir: false,
        agentsMd: false,
        claudeMdImportsAgentsMd: false,
      },
      mcpServerNames: [],
      stacks: ['nextjs'],
      isGitRepo: false,
      tooling: { formatter: 'prettier', linter: 'eslint', scripts: ['lint', 'typecheck'] },
    });
  });

  it('detects Biome from its config file, and no tooling when there is none', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccsa-biome-'));
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { next: '16.0.0' } }),
    );
    expect((await analyzeProject(dir)).tooling).toEqual({
      formatter: null,
      linter: null,
      scripts: [],
    });
    await writeFile(join(dir, 'biome.json'), '{}');
    expect((await analyzeProject(dir)).tooling).toEqual({
      formatter: 'biome',
      linter: 'biome',
      scripts: [],
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

  it('profiles a create-next-app 16 project: AGENTS.md, settings-only pnpm workspace', async () => {
    const p = await analyzeProject(fixture('next16-default'));
    expect(p.existingConfig).toMatchObject({
      agentsMd: true,
      claudeMd: false,
      claudeMdImportsAgentsMd: false,
    });
    expect(p.monorepo).toEqual({ isMonorepo: false, markers: [], packages: [] });
    expect(p.dependencyVersions['tailwindcss']).toBe('^4');
    expect(p.tooling.linter).toBe('eslint');
  });

  it('reads deploy config files and the git remote host', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccsa-remote-'));
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { next: '16.0.0' } }),
    );
    await writeFile(join(dir, 'vercel.json'), '{}');
    await mkdir(join(dir, '.git'));
    await writeFile(
      join(dir, '.git', 'config'),
      '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:example-org/example-app.git\n',
    );
    const p = await analyzeProject(dir);
    expect(p.deployConfigs).toEqual(['vercel.json']);
    expect(p.gitRemoteHost).toBe('github');
    expect(p.isGitRepo).toBe(true);
  });
});

describe('detection helpers', () => {
  it('treats pnpm-workspace.yaml as a monorepo only when it lists packages', () => {
    expect(pnpmWorkspaceHasPackages('packages:\n  - apps/*\n')).toBe(true);
    expect(pnpmWorkspaceHasPackages("packages: ['apps/*']\n")).toBe(true);
    expect(pnpmWorkspaceHasPackages('ignoredBuiltDependencies:\n  - sharp\n')).toBe(false);
    expect(pnpmWorkspaceHasPackages('packages: []\n')).toBe(false);
    expect(pnpmWorkspaceHasPackages('packages:\n\nonlyBuiltDependencies:\n  - x\n')).toBe(false);
    expect(pnpmWorkspaceHasPackages('')).toBe(false);
  });

  it('finds the origin remote host', () => {
    expect(gitRemoteHost(null)).toBeNull();
    expect(gitRemoteHost('[core]\n\tbare = false\n')).toBeNull();
    expect(gitRemoteHost('[remote "origin"]\n\turl = https://gitlab.com/x/y.git\n')).toBe('gitlab');
    expect(gitRemoteHost('[remote "origin"]\n\turl = https://git.example.test/x/y\n')).toBe(
      'other',
    );
  });

  it('spots an AGENTS.md import outside the managed block only', () => {
    expect(importsAgentsMd('@AGENTS.md\n\n# Rules\n')).toBe(true);
    expect(
      importsAgentsMd('<!-- setup-agent:start -->\n@AGENTS.md\n<!-- setup-agent:end -->\n'),
    ).toBe(false);
    expect(importsAgentsMd('See AGENTS.md for rules.')).toBe(false);
  });
});
