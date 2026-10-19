import type {
  Category,
  ProjectProfile,
  RecommendSetupOutput,
  SetupAnswers,
  Snapshot,
  SnapshotItem,
} from '@cc-setup-agent/shared';
import { hookProposals } from './hooks.js';
import { modelRecommendation } from './model-rules.js';

/** Stable presentation order for categories. */
export const CATEGORY_ORDER: readonly Category[] = [
  'docs',
  'browser_testing',
  'unit_testing',
  'database',
  'deploy',
  'ui_components',
  'auth',
  'payments',
  'email',
  'cms',
  'observability',
  'code_review',
  'git_github',
  'search',
];

/** Labels shown to users; internal category ids never appear in the plan or CLAUDE.md. */
export const CATEGORY_LABEL: Record<Category, string> = {
  docs: 'Docs',
  browser_testing: 'Browser testing',
  unit_testing: 'Unit testing',
  database: 'Database',
  deploy: 'Deployment',
  ui_components: 'UI and design',
  auth: 'Authentication',
  payments: 'Payments',
  email: 'Email',
  cms: 'Content management',
  observability: 'Monitoring and errors',
  code_review: 'Code review',
  git_github: 'Git hosting',
  search: 'Web search',
};

/** Package → technology slug and display name, for detected-technology signals. */
const LIB_TECH: Record<string, { slug: string; label: string }> = {
  next: { slug: 'nextjs', label: 'Next.js' },
  react: { slug: 'react', label: 'React' },
  typescript: { slug: 'typescript', label: 'TypeScript' },
  tailwindcss: { slug: 'tailwind', label: 'Tailwind CSS' },
  '@mui/material': { slug: 'mui', label: 'MUI' },
  '@heroui/react': { slug: 'heroui', label: 'HeroUI' },
  '@chakra-ui/react': { slug: 'chakra', label: 'Chakra UI' },
  'styled-components': { slug: 'styledcomponents', label: 'styled-components' },
  '@emotion/react': { slug: 'emotion', label: 'Emotion' },
  sass: { slug: 'sass', label: 'Sass' },
  prisma: { slug: 'prisma', label: 'Prisma' },
  '@prisma/client': { slug: 'prisma', label: 'Prisma' },
  'drizzle-orm': { slug: 'drizzle', label: 'Drizzle' },
  '@supabase/supabase-js': { slug: 'supabase', label: 'Supabase' },
  '@supabase/ssr': { slug: 'supabase', label: 'Supabase' },
  mongoose: { slug: 'mongodb', label: 'MongoDB' },
  mongodb: { slug: 'mongodb', label: 'MongoDB' },
  '@neondatabase/serverless': { slug: 'neon', label: 'Neon' },
  '@planetscale/database': { slug: 'planetscale', label: 'PlanetScale' },
  '@vercel/postgres': { slug: 'postgres', label: 'PostgreSQL' },
  pg: { slug: 'postgres', label: 'PostgreSQL' },
  postgres: { slug: 'postgres', label: 'PostgreSQL' },
  mysql2: { slug: 'mysql', label: 'MySQL' },
  redis: { slug: 'redis', label: 'Redis' },
  '@upstash/redis': { slug: 'upstash', label: 'Upstash' },
  convex: { slug: 'convex', label: 'Convex' },
  firebase: { slug: 'firebase', label: 'Firebase' },
  'firebase-admin': { slug: 'firebase', label: 'Firebase' },
  'next-auth': { slug: 'authjs', label: 'Auth.js' },
  '@auth/core': { slug: 'authjs', label: 'Auth.js' },
  '@clerk/nextjs': { slug: 'clerk', label: 'Clerk' },
  '@auth0/nextjs-auth0': { slug: 'auth0', label: 'Auth0' },
  '@workos-inc/authkit-nextjs': { slug: 'workos', label: 'WorkOS' },
  'better-auth': { slug: 'betterauth', label: 'Better Auth' },
  stripe: { slug: 'stripe', label: 'Stripe' },
  '@stripe/stripe-js': { slug: 'stripe', label: 'Stripe' },
  resend: { slug: 'resend', label: 'Resend' },
  'next-sanity': { slug: 'sanity', label: 'Sanity' },
  '@sanity/client': { slug: 'sanity', label: 'Sanity' },
  contentful: { slug: 'contentful', label: 'Contentful' },
  '@sentry/nextjs': { slug: 'sentry', label: 'Sentry' },
  'posthog-js': { slug: 'posthog', label: 'PostHog' },
  '@datadog/browser-rum': { slug: 'datadog', label: 'Datadog' },
  vitest: { slug: 'vitest', label: 'Vitest' },
  jest: { slug: 'jest', label: 'Jest' },
  '@playwright/test': { slug: 'playwright', label: 'Playwright' },
  playwright: { slug: 'playwright', label: 'Playwright' },
  cypress: { slug: 'cypress', label: 'Cypress' },
  eslint: { slug: 'eslint', label: 'ESLint' },
  prettier: { slug: 'prettier', label: 'Prettier' },
  '@biomejs/biome': { slug: 'biome', label: 'Biome' },
};
const DEPLOY_LABEL: Record<string, string> = {
  vercel: 'Vercel',
  netlify: 'Netlify',
  cloudflare: 'Cloudflare',
};
const DEPLOY_CONFIG_TECH: Record<string, string> = {
  'vercel.json': 'vercel',
  'netlify.toml': 'netlify',
  'wrangler.toml': 'cloudflare',
  'wrangler.json': 'cloudflare',
  'wrangler.jsonc': 'cloudflare',
};
/** Spellings the classifier may use for the same technology. */
const TECH_ALIASES: Record<string, string> = {
  next: 'nextjs',
  tailwindcss: 'tailwind',
  postgresql: 'postgres',
  nextauth: 'authjs',
  mongo: 'mongodb',
  shadcnui: 'shadcn',
  sentryio: 'sentry',
  cloudflareworkers: 'cloudflare',
  cloudflarepages: 'cloudflare',
};
/** Generic words that never make an item vendor-specific. */
const GENERIC_TECH = new Set([
  'javascript',
  'typescript',
  'node',
  'nodejs',
  'web',
  'html',
  'css',
  'npm',
  'mcp',
  'claude',
  'claudecode',
  'anthropic',
  'ai',
  'llm',
  'any',
]);

/** Canonical technology slug: lowercase letters and digits, aliases resolved. */
export function techSlug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return TECH_ALIASES[s] ?? s;
}

const majorOf = (range: string) => /\d+/.exec(range)?.[0];

/**
 * Technologies this project uses or the user stated, each with the evidence shown to the user
 * ("Tailwind CSS 4 detected in package.json (tailwindcss ^4)"). The first signal per slug wins.
 */
export function projectTechnologies(
  profile: ProjectProfile,
  answers: SetupAnswers,
): Map<string, { label: string; signal: string }> {
  const out = new Map<string, { label: string; signal: string }>();
  const add = (slug: string, label: string, signal: string) => {
    if (!out.has(slug)) out.set(slug, { label, signal });
  };
  const deployLabel = DEPLOY_LABEL[answers.deployTarget];
  if (deployLabel) add(answers.deployTarget, deployLabel, `you said you deploy to ${deployLabel}`);
  for (const f of profile.deployConfigs) {
    const slug = DEPLOY_CONFIG_TECH[f];
    if (slug) add(slug, DEPLOY_LABEL[slug]!, `${f} found in the project root`);
  }
  const libs = [
    ...Object.keys(profile.dependencyVersions),
    ...profile.styling,
    ...profile.databaseLibs,
    ...profile.integrations,
  ];
  for (const pkg of [...new Set(libs)].sort()) {
    const tech = LIB_TECH[pkg];
    if (!tech) continue;
    const range = profile.dependencyVersions[pkg];
    const major = range ? majorOf(range) : undefined;
    add(
      tech.slug,
      tech.label,
      `${tech.label}${major ? ` ${major}` : ''} detected in package.json (${pkg}${range ? ` ${range}` : ''})`,
    );
  }
  if (profile.isNextjs && !out.has('nextjs'))
    add('nextjs', 'Next.js', 'Next.js config found in the project root');
  if (profile.styling.includes('shadcn'))
    add('shadcn', 'shadcn/ui', 'components.json (shadcn/ui) found in the project root');
  if (profile.isGitRepo) add('git', 'git', '.git folder found');
  if (profile.gitRemoteHost === 'github')
    add('github', 'GitHub', 'git remote origin is on github.com (.git/config)');
  if (profile.gitRemoteHost === 'gitlab')
    add('gitlab', 'GitLab', 'git remote origin is on gitlab.com (.git/config)');
  if (profile.gitRemoteHost === 'bitbucket')
    add('bitbucket', 'Bitbucket', 'git remote origin is on bitbucket.org (.git/config)');
  return out;
}

/** Vendor slugs used to spot vendor-specific items in snapshots made before classify-v3. */
const KNOWN_VENDORS = new Set([
  ...Object.values(LIB_TECH).map((t) => t.slug),
  'vercel',
  'netlify',
  'cloudflare',
  'github',
  'gitlab',
  'bitbucket',
  'shadcn',
]);

/** The technologies an item is tied to (vendor-specific when non-empty). */
export function itemTechnologies(item: SnapshotItem): string[] {
  const raw =
    item.technologies ??
    // Older snapshots carry no technologies: fall back to vendor names in the item's name.
    item.name.split(/[^A-Za-z0-9.]+/).filter((w) => KNOWN_VENDORS.has(techSlug(w)));
  return [...new Set(raw.map(techSlug))].filter((t) => t !== '' && !GENERIC_TECH.has(t)).sort();
}

interface Need {
  /** Specific evidence for the category, shown as the reason for vendor-neutral items. */
  signal: string;
  /** Vendor-neutral items don't fit (deploy, auth, payments, …: they target one platform). */
  requireVendorMatch: boolean;
  /** Plain-words description of what an item must match, for exclusion reasons. */
  mustMatch?: string;
}

/** Categories where only an item made for the stated or detected vendor fits. */
const VENDOR_CATEGORIES: ReadonlySet<Category> = new Set([
  'deploy',
  'auth',
  'payments',
  'email',
  'cms',
  'observability',
]);

const INTEGRATION_CATEGORY: Record<string, Category> = {
  'next-auth': 'auth',
  '@auth/core': 'auth',
  '@clerk/nextjs': 'auth',
  '@auth0/nextjs-auth0': 'auth',
  '@workos-inc/authkit-nextjs': 'auth',
  'better-auth': 'auth',
  stripe: 'payments',
  '@stripe/stripe-js': 'payments',
  resend: 'email',
  'next-sanity': 'cms',
  '@sanity/client': 'cms',
  contentful: 'cms',
  '@sentry/nextjs': 'observability',
  'posthog-js': 'observability',
  '@datadog/browser-rum': 'observability',
};

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Categories the project needs (per-category rules), each with the specific signal that calls
 * for it. A category with no specific signal is not needed: generic reasons are never used.
 */
export function neededCategories(
  profile: ProjectProfile,
  answers: SetupAnswers,
): Map<Category, Need> {
  const needed = new Map<Category, Need>();
  const tech = projectTechnologies(profile, answers);
  const signalOf = (slug: string) => tech.get(slug)?.signal;
  const add = (c: Category, signal: string, mustMatch?: string) => {
    if (needed.has(c)) return;
    needed.set(c, {
      signal: capitalise(signal),
      requireVendorMatch: VENDOR_CATEGORIES.has(c),
      ...(mustMatch ? { mustMatch } : {}),
    });
  };
  const nextjs = profile.stacks.includes('nextjs');
  if (nextjs) add('docs', signalOf('nextjs') ?? 'Next.js detected');
  if (answers.riskTolerance !== 'high')
    add('code_review', `you set risk tolerance to ${answers.riskTolerance}`);
  const host = profile.gitRemoteHost;
  if (host && host !== 'other') add('git_github', signalOf(host)!, `your git host (${host})`);
  if (!nextjs) return needed;

  const browser = profile.testRunners.filter((t) => t === 'playwright' || t === 'cypress');
  if (browser.length > 0) add('browser_testing', signalOf(browser[0]!)!);
  else if (answers.workflow === 'test_first')
    add('browser_testing', 'you chose a test-first workflow');
  else if (answers.riskTolerance === 'low')
    add('browser_testing', 'you set risk tolerance to low: verify pages in a real browser');
  const unit = profile.testRunners.filter((t) => t === 'vitest' || t === 'jest');
  if (unit.length > 0) add('unit_testing', signalOf(unit[0]!)!);
  else if (answers.workflow === 'test_first')
    add('unit_testing', 'you chose a test-first workflow');
  const db = profile.databaseLibs.find((l) => LIB_TECH[l]);
  if (db) add('database', signalOf(LIB_TECH[db]!.slug)!);
  const deploy =
    DEPLOY_LABEL[answers.deployTarget] !== undefined
      ? answers.deployTarget
      : answers.deployTarget === 'unknown'
        ? profile.deployConfigs.map((f) => DEPLOY_CONFIG_TECH[f]).find(Boolean)
        : undefined;
  if (deploy)
    add('deploy', signalOf(deploy)!, `your deploy target (${DEPLOY_LABEL[deploy] ?? deploy})`);
  const ui = ['shadcn', 'tailwindcss', '@mui/material', '@heroui/react', '@chakra-ui/react'].find(
    (s) => profile.styling.includes(s),
  );
  if (ui) add('ui_components', signalOf(ui === 'shadcn' ? 'shadcn' : LIB_TECH[ui]!.slug)!);
  for (const lib of profile.integrations) {
    const c = INTEGRATION_CATEGORY[lib];
    const t = LIB_TECH[lib];
    if (c && t) add(c, signalOf(t.slug)!, `a ${CATEGORY_LABEL[c].toLowerCase()} service you use`);
  }
  return needed;
}

type Fit =
  | { fit: 'strong'; reason: string; fitReason: string }
  | { fit: 'good'; reason: string; fitReason: string }
  | { fit: 'none'; why: string };

/**
 * Fit check (minimum bar = `good`): a vendor-specific item fits only when one of its technologies
 * is detected or stated; a vendor-neutral item fits a needed category unless the category needs a
 * vendor match (deploy and the hosted-service categories).
 */
export function fitOf(
  item: SnapshotItem,
  need: Need,
  tech: Map<string, { label: string; signal: string }>,
  category: Category,
): Fit {
  const techs = itemTechnologies(item);
  if (techs.length > 0) {
    const matched = techs.filter((t) => tech.has(t));
    if (matched.length > 0) {
      const m = tech.get(matched[0]!)!;
      return {
        fit: 'strong',
        reason: `${capitalise(m.signal)}.`,
        fitReason: `Made for ${m.label}, which this project uses.`,
      };
    }
    const target = need.mustMatch ? ` It doesn't match ${need.mustMatch}.` : '';
    return {
      fit: 'none',
      why: `Made for ${techs.join(', ')}, which isn't detected in this project or named in your answers.${target}`,
    };
  }
  if (need.requireVendorMatch)
    return {
      fit: 'none',
      why: `Not made for ${need.mustMatch ?? 'a service this project uses'}; ${CATEGORY_LABEL[category].toLowerCase()} items must match the platform you use.`,
    };
  return {
    fit: 'good',
    reason: `${need.signal}.`,
    fitReason: 'General-purpose: works with any project like this one.',
  };
}

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 } as const;
const PROVENANCE_RANK = { anthropic: 3, official_vendor: 3, community: 1 } as const;

function evalUplift(item: SnapshotItem): number {
  const e = item.evalSummary;
  if (!e || e.verdict !== 'better' || e.baselineSuccessRate === null) return 0;
  return Math.max(0, e.successRate - e.baselineSuccessRate);
}

function healthRank(item: SnapshotItem): number {
  const r = item.scorecard.gates.gate2_health?.result;
  return r === 'pass' ? 2 : r === 'soft_fail' ? 1 : 0;
}

/** Plan M7 order: eval uplift > confidence > provenance > health; lower context overhead, then id. */
export function compareItems(a: SnapshotItem, b: SnapshotItem): number {
  return (
    evalUplift(b) - evalUplift(a) ||
    CONFIDENCE_RANK[b.scorecard.confidence] - CONFIDENCE_RANK[a.scorecard.confidence] ||
    PROVENANCE_RANK[b.provenance] - PROVENANCE_RANK[a.provenance] ||
    healthRank(b) - healthRank(a) ||
    (a.contextOverheadTokens ?? 0) - (b.contextOverheadTokens ?? 0) ||
    a.id.localeCompare(b.id)
  );
}

function securityFlagged(item: SnapshotItem): boolean {
  return item.scorecard.securityFlags > 0 || item.scorecard.gates.gate3_security?.result === 'fail';
}

/** Why a vendor-matching item may not use the vendor preference, or null when it may. */
function affinityBlocker(item: SnapshotItem): string | null {
  if (securityFlagged(item)) return 'it has security flags';
  if (item.scorecard.confidence === 'low') return 'its confidence is low';
  return null;
}

function credibilitySummary(item: SnapshotItem): string {
  const g = item.scorecard.gates;
  const gate = (label: string, r: { result: string } | undefined) =>
    `${label} ${r?.result ?? 'not run'}`;
  const flags =
    item.scorecard.securityFlags > 0
      ? `; ${item.scorecard.securityFlags} security flag(s) reviewed by the maintainer`
      : '';
  return `credibility ${item.scorecard.confidence}; ${[gate('hygiene', g.gate0_hygiene), gate('provenance', g.gate1_provenance), gate('health', g.gate2_health), gate('security', g.gate3_security)].join(', ')}${flags}`;
}

/** Below this age (days since first publication) an item is called new. */
export const NEW_ITEM_DAYS = 180;
const DAY_MS = 86_400_000;

function tradeoff(item: SnapshotItem, now: Date): string {
  const parts: string[] = [];
  if (item.contextOverheadTokens) {
    const what =
      item.kind === 'mcp_server' ? 'tool definitions' : 'skill, command and agent descriptions';
    parts.push(`adds ~${item.contextOverheadTokens} tokens of ${what} to every request`);
  } else if (item.contextOverheadTokens === null) parts.push('context cost not measured');
  if (item.contextOnUseTokens)
    parts.push(`up to ~${item.contextOnUseTokens} more tokens while one of its skills is in use`);
  const risky = item.capabilities.filter(
    (c) => c === 'shell' || c === 'file_write' || c === 'network' || c === 'code_execution',
  );
  if (risky.length > 0) parts.push(`can use ${risky.join(', ')}`);
  if (item.install && item.install.envVars.length > 0)
    parts.push(`needs ${item.install.envVars.join(', ')}`);
  if (item.status === 'recommended_provisional')
    parts.push(
      'provisional: approved on gate, security and classification evidence; not yet confirmed by evals over 60 days',
    );
  if (item.firstPublishedAt) {
    const days = Math.floor((now.getTime() - Date.parse(item.firstPublishedAt)) / DAY_MS);
    if (days >= 0 && days < NEW_ITEM_DAYS)
      parts.push(`new: first published ${days} days ago, too new to judge long-term maintenance`);
  }
  return parts.length > 0 ? `${capitalise(parts.join('; '))}.` : 'No notable trade-offs.';
}

/**
 * Deterministic recommendation (plan M7, fit rules M8.2): only recommended or provisional items
 * that clear the fit bar, one per needed category, with excluded items and reasons, and a gap
 * entry for needed categories where nothing fits. Same input and snapshot give identical output.
 */
export function recommendSetup(
  snapshot: Snapshot,
  profile: ProjectProfile,
  answers: SetupAnswers,
  contextWarnTokens: number,
): RecommendSetupOutput {
  const needed = neededCategories(profile, answers);
  const tech = projectTechnologies(profile, answers);
  const now = new Date(snapshot.generatedAt);
  const nextjs = profile.stacks.includes('nextjs');
  const fitsStack = (item: SnapshotItem) =>
    nextjs
      ? item.stacks.some((s) => s === 'nextjs' || s === 'react' || s === 'any')
      : item.stacks.includes('any');
  const eligible = snapshot.items.filter(
    (i) =>
      (i.status === 'recommended' || i.status === 'recommended_provisional') &&
      i.category !== null &&
      fitsStack(i),
  );

  const items: RecommendSetupOutput['items'] = [];
  const excluded: RecommendSetupOutput['excluded'] = [];
  const gaps: RecommendSetupOutput['gaps'] = [];
  for (const category of CATEGORY_ORDER) {
    const label = CATEGORY_LABEL[category];
    const inCategory = eligible.filter((i) => i.category === category).sort(compareItems);
    const need = needed.get(category);
    if (!need) {
      for (const i of inCategory)
        excluded.push({
          id: i.id,
          name: i.name,
          reason: `Not needed: nothing in this project or your answers calls for ${label.toLowerCase()}.`,
        });
      continue;
    }
    const fits = inCategory.map((item) => ({ item, fit: fitOf(item, need, tech, category) }));
    const fitting = fits.filter(
      (f): f is { item: SnapshotItem; fit: Exclude<Fit, { fit: 'none' }> } => f.fit.fit !== 'none',
    );
    for (const f of fits)
      if (f.fit.fit === 'none')
        excluded.push({ id: f.item.id, name: f.item.name, reason: f.fit.why });
    if (fitting.length === 0) {
      gaps.push({
        category,
        categoryLabel: label,
        message: 'No suitable item in the catalog yet',
        detail:
          inCategory.length === 0
            ? `${need.signal}, but the catalog has no reviewed ${label.toLowerCase()} items yet.`
            : `${need.signal}, but none of the ${inCategory.length} reviewed ${label.toLowerCase()} item(s) fits this project, so none is recommended.`,
      });
      continue;
    }
    // A strong (vendor-matching) fit wins, but only when unflagged with at least medium
    // credibility; otherwise normal ranking applies among all fitting items and the plan says why.
    const strong = fitting.filter((f) => f.fit.fit === 'strong');
    const preferred = strong.filter((f) => affinityBlocker(f.item) === null);
    const skipped = strong.filter((f) => affinityBlocker(f.item) !== null);
    const pool = preferred.length > 0 ? preferred : fitting;
    const winner = pool[0]!;
    const skippedNote =
      preferred.length === 0 && skipped.length > 0
        ? ` ${skipped.map((f) => `${f.item.name} matches your stack but ${affinityBlocker(f.item)}`).join('; ')}, so normal ranking applies.`
        : '';
    items.push({
      id: winner.item.id,
      name: winner.item.name,
      kind: winner.item.kind,
      category,
      categoryLabel: label,
      reason: `${winner.fit.reason}${skippedNote}`,
      fit: winner.fit.fit,
      fitReason: winner.fit.fitReason,
      credibility: nextjs ? winner.item.scorecard.confidence : 'low',
      credibilitySummary: credibilitySummary(winner.item),
      tradeoff: tradeoff(winner.item, now),
      contextOverheadTokens: winner.item.contextOverheadTokens,
      contextOnUseTokens: winner.item.contextOnUseTokens,
    });
    for (const other of fitting) {
      if (other.item.id === winner.item.id) continue;
      const blocker = affinityBlocker(other.item);
      const strongOther = other.fit.fit === 'strong';
      const reason =
        preferred.length > 0 && !preferred.includes(other)
          ? strongOther && blocker
            ? `Matches your stack, but ${blocker}; ${winner.item.name} was chosen instead.`
            : `Overlaps with ${winner.item.name}, which is made for a technology you use.`
          : strongOther && blocker
            ? `Matches your stack, but ${blocker}, so it gets no vendor preference; ${winner.item.name} ranked higher.`
            : `Overlaps with ${winner.item.name} (${label.toLowerCase()}); ranked lower on evidence, credibility or context cost.`;
      excluded.push({ id: other.item.id, name: other.item.name, reason });
    }
  }
  const totalTokens = items.reduce((sum, i) => sum + (i.contextOverheadTokens ?? 0), 0);
  return {
    catalogVersion: snapshot.version,
    items,
    excluded: excluded.sort((a, b) => a.id.localeCompare(b.id)),
    gaps,
    hooks: hookProposals(profile),
    model: modelRecommendation(answers),
    contextOverhead: {
      totalTokens,
      unknownItems: items.filter((i) => i.contextOverheadTokens === null).map((i) => i.name),
      thresholdTokens: contextWarnTokens,
      warning: totalTokens > contextWarnTokens,
    },
  };
}
