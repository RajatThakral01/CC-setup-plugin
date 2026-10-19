import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectProfile } from '@cc-setup-agent/shared';
import { exists, readText } from './files.js';

/** Library → tag used for recommendations; detection reads package.json only, never source files. */
export const DATABASE_LIBS = [
  'prisma',
  '@prisma/client',
  'drizzle-orm',
  '@supabase/supabase-js',
  '@supabase/ssr',
  'mongoose',
  'mongodb',
  '@neondatabase/serverless',
  '@planetscale/database',
  '@vercel/postgres',
  'pg',
  'postgres',
  'mysql2',
  'redis',
  '@upstash/redis',
  'convex',
  'firebase',
  'firebase-admin',
];
export const INTEGRATION_LIBS = [
  'next-auth',
  '@auth/core',
  '@clerk/nextjs',
  '@auth0/nextjs-auth0',
  '@workos-inc/authkit-nextjs',
  'better-auth',
  'stripe',
  '@stripe/stripe-js',
  'resend',
  'next-sanity',
  '@sanity/client',
  'contentful',
  '@sentry/nextjs',
  'posthog-js',
  '@datadog/browser-rum',
];
const STYLING_LIBS = [
  'tailwindcss',
  'styled-components',
  '@emotion/react',
  'sass',
  '@mui/material',
  '@chakra-ui/react',
  '@heroui/react',
];

/** package.json scripts that hook recipes may call. */
const HOOK_SCRIPTS = ['lint', 'typecheck', 'type-check', 'format'];
const PRETTIER_CONFIGS = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.json5',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  '.prettierrc.toml',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.ts',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
  'prettier.config.ts',
];
const ESLINT_CONFIGS = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  '.eslintrc',
  '.eslintrc.json',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.yaml',
  '.eslintrc.yml',
];

const DEPLOY_CONFIGS = [
  'vercel.json',
  'netlify.toml',
  'wrangler.toml',
  'wrangler.json',
  'wrangler.jsonc',
  'open-next.config.ts',
];
/** Packages whose declared version is reported, so reasons can name them ("Tailwind CSS 4"). */
const VERSIONED_LIBS = ['next', 'react', 'typescript', 'eslint', 'prettier', '@biomejs/biome'];
const TEST_LIBS = ['vitest', 'jest', '@playwright/test', 'playwright', 'cypress'];

/**
 * True when pnpm-workspace.yaml declares at least one package glob. pnpm also uses the file for
 * settings only (create-next-app writes one with build settings), which is not a monorepo.
 */
export function pnpmWorkspaceHasPackages(yaml: string): boolean {
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^packages\s*:\s*(.*?)\s*(#.*)?$/.exec(lines[i]!);
    if (!m) continue;
    const inline = m[1] ?? '';
    if (inline !== '') return /^\[\s*['"]?[^\]\s'"]/.test(inline);
    for (const next of lines.slice(i + 1)) {
      if (/^\s*(#.*)?$/.test(next)) continue;
      return /^\s+-\s*['"]?[^\s'"#]/.test(next);
    }
    return false;
  }
  return false;
}

/** Host of the `origin` remote (or the first remote) in .git/config. */
export function gitRemoteHost(gitConfig: string | null): ProjectProfile['gitRemoteHost'] {
  if (!gitConfig) return null;
  const sections = gitConfig.split(/^\[/m);
  const remotes = sections.filter((s) => /^remote\s+"/.test(s));
  const origin = remotes.find((s) => /^remote\s+"origin"/.test(s)) ?? remotes[0];
  const url = origin ? /^\s*url\s*=\s*(\S+)/m.exec(origin)?.[1] : undefined;
  if (!url) return null;
  if (/github\.com[:/]/i.test(url)) return 'github';
  if (/gitlab\.com[:/]/i.test(url)) return 'gitlab';
  if (/bitbucket\.org[:/]/i.test(url)) return 'bitbucket';
  return 'other';
}

/** CLAUDE.md imports AGENTS.md outside our managed block (an `@AGENTS.md` line). */
export function importsAgentsMd(claudeMd: string | null): boolean {
  if (!claudeMd) return false;
  const start = claudeMd.indexOf('<!-- setup-agent:start -->');
  const end = claudeMd.indexOf('<!-- setup-agent:end -->');
  const outside =
    start !== -1 && end > start ? claudeMd.slice(0, start) + claudeMd.slice(end) : claudeMd;
  return /(^|\s)@(\.\/)?AGENTS\.md\b/m.test(outside);
}

const packageJsonSchema = (
  raw: string | null,
): {
  deps: Record<string, string>;
  workspaces: boolean;
  scripts: string[];
  prettierKey: boolean;
} => {
  if (!raw) return { deps: {}, workspaces: false, scripts: [], prettierKey: false };
  try {
    const p = JSON.parse(raw) as {
      dependencies?: unknown;
      devDependencies?: unknown;
      workspaces?: unknown;
      scripts?: unknown;
      prettier?: unknown;
    };
    const pick = (v: unknown) =>
      v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string'))
        : {};
    return {
      deps: { ...pick(p.dependencies), ...pick(p.devDependencies) } as Record<string, string>,
      workspaces: Array.isArray(p.workspaces)
        ? p.workspaces.length > 0
        : Boolean(
            p.workspaces &&
            typeof p.workspaces === 'object' &&
            Array.isArray((p.workspaces as { packages?: unknown }).packages) &&
            ((p.workspaces as { packages: unknown[] }).packages.length ?? 0) > 0,
          ),
      scripts: Object.keys(pick(p.scripts)),
      prettierKey: p.prettier !== undefined,
    };
  } catch {
    return { deps: {}, workspaces: false, scripts: [], prettierKey: false };
  }
};

async function anyExists(root: string, names: string[]): Promise<boolean> {
  for (const n of names) if (await exists(join(root, n))) return true;
  return false;
}

/** Workspace packages: first-level folders of apps/ and packages/ that have a package.json. */
async function workspacePackages(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const parent of ['apps', 'packages']) {
    const entries = await readdir(join(root, parent), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory() && (await exists(join(root, parent, e.name, 'package.json'))))
        out.push(`${parent}/${e.name}`);
    }
  }
  return out.sort();
}

export function mcpServerNames(mcpJson: string | null): string[] {
  if (!mcpJson) return [];
  try {
    const parsed = JSON.parse(mcpJson) as { mcpServers?: unknown };
    return parsed.mcpServers && typeof parsed.mcpServers === 'object'
      ? Object.keys(parsed.mcpServers).sort()
      : [];
  } catch {
    return [];
  }
}

/**
 * Detects the project's stack from metadata files only (package.json, lockfiles, config file names,
 * top-level folders). Never reads source file contents (NFR-1, NFR-8).
 */
export async function analyzeProject(root: string): Promise<ProjectProfile> {
  const pkg = packageJsonSchema(await readText(join(root, 'package.json')));
  const has = (name: string) => name in pkg.deps;
  const configExists = (base: string) =>
    anyExists(
      root,
      ['js', 'mjs', 'cjs', 'ts', 'mts'].map((ext) => `${base}.${ext}`),
    );

  const packageManager = (await exists(join(root, 'pnpm-lock.yaml')))
    ? 'pnpm'
    : (await exists(join(root, 'yarn.lock')))
      ? 'yarn'
      : (await anyExists(root, ['bun.lockb', 'bun.lock']))
        ? 'bun'
        : (await exists(join(root, 'package-lock.json')))
          ? 'npm'
          : null;
  const isNextjs = has('next') || (await configExists('next.config'));
  const app = await anyExists(root, ['app', 'src/app']);
  const pages = await anyExists(root, ['pages', 'src/pages']);
  const testRunners: ProjectProfile['testRunners'] = [];
  if (has('vitest') || (await configExists('vitest.config'))) testRunners.push('vitest');
  if (has('jest') || (await configExists('jest.config'))) testRunners.push('jest');
  if (has('@playwright/test') || has('playwright') || (await configExists('playwright.config')))
    testRunners.push('playwright');
  if (has('cypress') || (await configExists('cypress.config'))) testRunners.push('cypress');
  const styling = STYLING_LIBS.filter(has);
  if (await exists(join(root, 'components.json'))) styling.push('shadcn');
  const presentMarkers: string[] = [];
  const pnpmWorkspace = await readText(join(root, 'pnpm-workspace.yaml'));
  if (pnpmWorkspace !== null && pnpmWorkspaceHasPackages(pnpmWorkspace))
    presentMarkers.push('pnpm-workspace.yaml');
  for (const m of ['turbo.json', 'lerna.json', 'nx.json'])
    if (await exists(join(root, m))) presentMarkers.push(m);
  if (pkg.workspaces) presentMarkers.push('package.json workspaces');
  const mcpJson = await readText(join(root, '.mcp.json'));
  const biome = has('@biomejs/biome') || (await anyExists(root, ['biome.json', 'biome.jsonc']));
  const prettier = has('prettier') || pkg.prettierKey || (await anyExists(root, PRETTIER_CONFIGS));
  const eslint = has('eslint') || (await anyExists(root, ESLINT_CONFIGS));
  const databaseLibs = DATABASE_LIBS.filter(has);
  const integrations = INTEGRATION_LIBS.filter(has);
  const versioned = [
    ...VERSIONED_LIBS,
    ...TEST_LIBS,
    ...STYLING_LIBS,
    ...databaseLibs,
    ...integrations,
  ].filter(has);
  const deployConfigs: string[] = [];
  for (const f of DEPLOY_CONFIGS) if (await exists(join(root, f))) deployConfigs.push(f);
  const claudeMd = await readText(join(root, 'CLAUDE.md'));

  return {
    packageManager,
    isNextjs,
    nextVersion: pkg.deps['next']?.replace(/^[\^~>=<\s]+/, '') ?? null,
    router: app && pages ? 'both' : app ? 'app' : pages ? 'pages' : null,
    typescript: has('typescript') || (await exists(join(root, 'tsconfig.json'))),
    testRunners,
    styling: styling.sort(),
    databaseLibs,
    integrations,
    dependencyVersions: Object.fromEntries(
      [...new Set(versioned)].sort().map((n) => [n, pkg.deps[n]!]),
    ),
    deployConfigs,
    gitRemoteHost: gitRemoteHost(await readText(join(root, '.git', 'config'))),
    monorepo: {
      isMonorepo: presentMarkers.length > 0,
      markers: presentMarkers,
      packages: presentMarkers.length > 0 ? await workspacePackages(root) : [],
    },
    existingConfig: {
      claudeMd: claudeMd !== null,
      mcpJson: mcpJson !== null,
      claudeDir: await exists(join(root, '.claude')),
      settingsJson: await exists(join(root, '.claude', 'settings.json')),
      agentsDir: await exists(join(root, '.claude', 'agents')),
      skillsDir: await exists(join(root, '.claude', 'skills')),
      agentsMd: await exists(join(root, 'AGENTS.md')),
      claudeMdImportsAgentsMd: importsAgentsMd(claudeMd),
    },
    mcpServerNames: mcpServerNames(mcpJson),
    stacks: isNextjs ? ['nextjs'] : [],
    isGitRepo: await exists(join(root, '.git')),
    tooling: {
      // Prettier wins when both are configured: it's the more common formatter in Next.js apps.
      formatter: prettier ? 'prettier' : biome ? 'biome' : null,
      linter: eslint ? 'eslint' : biome ? 'biome' : null,
      scripts: HOOK_SCRIPTS.filter((s) => pkg.scripts.includes(s)),
    },
  };
}
