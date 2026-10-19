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

const packageJsonSchema = (
  raw: string | null,
): { deps: Record<string, string>; workspaces: boolean } => {
  if (!raw) return { deps: {}, workspaces: false };
  try {
    const p = JSON.parse(raw) as {
      dependencies?: unknown;
      devDependencies?: unknown;
      workspaces?: unknown;
    };
    const pick = (v: unknown) =>
      v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string'))
        : {};
    return {
      deps: { ...pick(p.dependencies), ...pick(p.devDependencies) } as Record<string, string>,
      workspaces: Boolean(p.workspaces),
    };
  } catch {
    return { deps: {}, workspaces: false };
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
  const markers = ['pnpm-workspace.yaml', 'turbo.json', 'lerna.json', 'nx.json'];
  const presentMarkers: string[] = [];
  for (const m of markers) if (await exists(join(root, m))) presentMarkers.push(m);
  if (pkg.workspaces) presentMarkers.push('package.json workspaces');
  const mcpJson = await readText(join(root, '.mcp.json'));

  return {
    packageManager,
    isNextjs,
    nextVersion: pkg.deps['next']?.replace(/^[\^~>=<\s]+/, '') ?? null,
    router: app && pages ? 'both' : app ? 'app' : pages ? 'pages' : null,
    typescript: has('typescript') || (await exists(join(root, 'tsconfig.json'))),
    testRunners,
    styling: styling.sort(),
    databaseLibs: DATABASE_LIBS.filter(has),
    integrations: INTEGRATION_LIBS.filter(has),
    monorepo: {
      isMonorepo: presentMarkers.length > 0,
      markers: presentMarkers,
      packages: presentMarkers.length > 0 ? await workspacePackages(root) : [],
    },
    existingConfig: {
      claudeMd: await exists(join(root, 'CLAUDE.md')),
      mcpJson: mcpJson !== null,
      claudeDir: await exists(join(root, '.claude')),
      settingsJson: await exists(join(root, '.claude', 'settings.json')),
      agentsDir: await exists(join(root, '.claude', 'agents')),
      skillsDir: await exists(join(root, '.claude', 'skills')),
    },
    mcpServerNames: mcpServerNames(mcpJson),
    stacks: isNextjs ? ['nextjs'] : [],
    isGitRepo: await exists(join(root, '.git')),
  };
}
