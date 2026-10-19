import type {
  Category,
  ProjectProfile,
  RecommendSetupOutput,
  SetupAnswers,
  Snapshot,
  SnapshotItem,
} from '@cc-setup-agent/shared';

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

/** Detected library or deploy target → name fragment of the preferred vendor's items. */
const AFFINITY: Record<string, string> = {
  prisma: 'prisma',
  '@prisma/client': 'prisma',
  'drizzle-orm': 'drizzle',
  '@supabase/supabase-js': 'supabase',
  '@supabase/ssr': 'supabase',
  mongoose: 'mongodb',
  mongodb: 'mongodb',
  '@neondatabase/serverless': 'neon',
  '@planetscale/database': 'planetscale',
  redis: 'redis',
  '@upstash/redis': 'upstash',
  convex: 'convex',
  firebase: 'firebase',
  'firebase-admin': 'firebase',
  vercel: 'vercel',
  netlify: 'netlify',
  cloudflare: 'cloudflare',
  '@clerk/nextjs': 'clerk',
  '@auth0/nextjs-auth0': 'auth0',
  '@workos-inc/authkit-nextjs': 'workos',
  stripe: 'stripe',
  '@stripe/stripe-js': 'stripe',
  resend: 'resend',
  'next-sanity': 'sanity',
  '@sanity/client': 'sanity',
  contentful: 'contentful',
  '@sentry/nextjs': 'sentry',
  'posthog-js': 'posthog',
  '@datadog/browser-rum': 'datadog',
  tailwindcss: 'tailwind',
  shadcn: 'shadcn',
  '@mui/material': 'mui',
  '@heroui/react': 'heroui',
};

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

/** Categories the project needs, each with the reason shown to the user. */
export function neededCategories(
  profile: ProjectProfile,
  answers: SetupAnswers,
): Map<Category, { reason: string; affinity: string[] }> {
  const needed = new Map<Category, { reason: string; affinity: string[] }>();
  const add = (c: Category, reason: string, affinity: string[] = []) => {
    const prev = needed.get(c);
    needed.set(c, {
      reason: prev ? prev.reason : reason,
      affinity: [...(prev?.affinity ?? []), ...affinity],
    });
  };
  const nextjs = profile.stacks.includes('nextjs');
  add(
    'docs',
    nextjs
      ? 'Keeps Next.js and library docs current inside Claude Code.'
      : 'Up-to-date library docs help on any stack.',
  );
  add('code_review', 'Catches issues before you commit.');
  if (profile.isGitRepo) add('git_github', 'The project is a git repository.');
  if (!nextjs) return needed;

  const browser = profile.testRunners.filter((t) => t === 'playwright' || t === 'cypress');
  if (browser.length > 0) add('browser_testing', `Detected ${browser.join(' and ')}.`);
  else if (answers.workflow === 'test_first')
    add('browser_testing', 'You prefer a test-first workflow.');
  else if (answers.riskTolerance === 'low')
    add('browser_testing', 'Low risk tolerance: verify pages in a real browser.');
  const unit = profile.testRunners.filter((t) => t === 'vitest' || t === 'jest');
  if (unit.length > 0) add('unit_testing', `Detected ${unit.join(' and ')}.`);
  else if (answers.workflow === 'test_first')
    add('unit_testing', 'You prefer a test-first workflow.');
  if (profile.databaseLibs.length > 0) {
    add(
      'database',
      `Detected ${profile.databaseLibs.join(', ')}.`,
      profile.databaseLibs.flatMap((l) => (AFFINITY[l] ? [AFFINITY[l]] : [])),
    );
  }
  if (['vercel', 'netlify', 'cloudflare'].includes(answers.deployTarget)) {
    add('deploy', `You deploy to ${answers.deployTarget}.`, [answers.deployTarget]);
  }
  if (
    profile.styling.some(
      (s) =>
        s === 'tailwindcss' || s === 'shadcn' || s === '@mui/material' || s === '@heroui/react',
    )
  ) {
    add(
      'ui_components',
      `Detected ${profile.styling.join(', ')}.`,
      profile.styling.flatMap((l) => (AFFINITY[l] ? [AFFINITY[l]] : [])),
    );
  }
  for (const lib of profile.integrations) {
    const c = INTEGRATION_CATEGORY[lib];
    if (c) add(c, `Detected ${lib}.`, AFFINITY[lib] ? [AFFINITY[lib]] : []);
  }
  return needed;
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

function matchesAffinity(item: SnapshotItem, affinity: string[]): boolean {
  const hay = `${item.id} ${item.name} ${item.publisher ?? ''}`.toLowerCase();
  return affinity.some((a) => hay.includes(a));
}

function scorecardSummary(item: SnapshotItem): string {
  const g = item.scorecard.gates;
  const gate = (label: string, r: { result: string } | undefined) =>
    `${label} ${r?.result ?? 'not run'}`;
  const flags =
    item.scorecard.securityFlags > 0
      ? `; ${item.scorecard.securityFlags} security flag(s) reviewed by the maintainer`
      : '';
  return `confidence ${item.scorecard.confidence}; ${[gate('hygiene', g.gate0_hygiene), gate('provenance', g.gate1_provenance), gate('health', g.gate2_health), gate('security', g.gate3_security)].join(', ')}${flags}`;
}

function tradeoff(item: SnapshotItem): string {
  const parts: string[] = [];
  if (item.contextOverheadTokens)
    parts.push(`adds ~${item.contextOverheadTokens} tokens of tool definitions to every request`);
  const risky = item.capabilities.filter(
    (c) => c === 'shell' || c === 'file_write' || c === 'network' || c === 'code_execution',
  );
  if (risky.length > 0) parts.push(`can use ${risky.join(', ')}`);
  if (item.install && item.install.envVars.length > 0)
    parts.push(`needs ${item.install.envVars.join(', ')}`);
  if (item.status === 'recommended_provisional')
    parts.push('provisional: too new to judge long-term maintenance');
  return parts.length > 0 ? `${parts.join('; ')}.` : 'No notable trade-offs.';
}

/** Model and effort rules. Recommends Sonnet or Haiku only (project rule: no Opus in product code). */
export function modelRecommendation(answers: SetupAnswers): RecommendSetupOutput['model'] {
  if (answers.budgetSensitivity === 'high') {
    return {
      model: 'sonnet',
      effort: 'medium',
      costNote: 'Good quality at moderate cost; use haiku for quick edits to save more.',
    };
  }
  if (answers.budgetSensitivity === 'low') {
    return {
      model: 'sonnet',
      effort: 'high',
      costNote:
        'Higher effort spends more tokens per task for more thorough work; a larger model is available if you need it.',
    };
  }
  return {
    model: 'sonnet',
    effort: 'medium',
    costNote: 'Balanced default for everyday Next.js work.',
  };
}

/**
 * Deterministic recommendation (plan M7): only recommended or provisional items, one per needed
 * category, with excluded items and reasons. Same input and snapshot give identical output.
 */
export function recommendSetup(
  snapshot: Snapshot,
  profile: ProjectProfile,
  answers: SetupAnswers,
  contextWarnTokens: number,
): RecommendSetupOutput {
  const needed = neededCategories(profile, answers);
  const nextjs = profile.stacks.includes('nextjs');
  const fits = (item: SnapshotItem) =>
    nextjs
      ? item.stacks.some((s) => s === 'nextjs' || s === 'react' || s === 'any')
      : item.stacks.includes('any');
  const eligible = snapshot.items.filter(
    (i) =>
      (i.status === 'recommended' || i.status === 'recommended_provisional') &&
      i.category !== null &&
      fits(i),
  );

  const items: RecommendSetupOutput['items'] = [];
  const excluded: RecommendSetupOutput['excluded'] = [];
  for (const category of CATEGORY_ORDER) {
    const inCategory = eligible.filter((i) => i.category === category).sort(compareItems);
    const need = needed.get(category);
    if (!need) {
      for (const i of inCategory)
        excluded.push({
          id: i.id,
          name: i.name,
          reason: `Not needed: nothing in this project calls for ${category.replace('_', ' ')}.`,
        });
      continue;
    }
    if (inCategory.length === 0) continue;
    const preferred =
      need.affinity.length > 0 ? inCategory.filter((i) => matchesAffinity(i, need.affinity)) : [];
    const pool = preferred.length > 0 ? preferred : inCategory;
    const winner = pool[0]!;
    items.push({
      id: winner.id,
      name: winner.name,
      category,
      reason: preferred.length > 0 ? `${need.reason} Matches your stack.` : need.reason,
      scorecardSummary: scorecardSummary(winner),
      tradeoff: tradeoff(winner),
      confidence: nextjs ? winner.scorecard.confidence : 'low',
      contextOverheadTokens: winner.contextOverheadTokens,
    });
    for (const other of inCategory) {
      if (other.id === winner.id) continue;
      const reason =
        preferred.length > 0 && !preferred.includes(other)
          ? `Overlaps with ${winner.name}, which matches the libraries you use.`
          : `Overlaps with ${winner.name} (${category.replace('_', ' ')}); ranked lower on evidence, confidence or context cost.`;
      excluded.push({ id: other.id, name: other.name, reason });
    }
  }
  const totalTokens = items.reduce((sum, i) => sum + (i.contextOverheadTokens ?? 0), 0);
  return {
    catalogVersion: snapshot.version,
    items,
    excluded: excluded.sort((a, b) => a.id.localeCompare(b.id)),
    model: modelRecommendation(answers),
    contextOverhead: {
      totalTokens,
      thresholdTokens: contextWarnTokens,
      warning: totalTokens > contextWarnTokens,
    },
  };
}
