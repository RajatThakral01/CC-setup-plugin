import { describe, expect, it } from 'vitest';
import type { ProjectProfile, SetupAnswers, Snapshot, SnapshotItem } from '@cc-setup-agent/shared';
import { fixtureSnapshot } from '../../../test/fixtures/plugin/catalog.js';
import { itemTechnologies, projectTechnologies, recommendSetup, techSlug } from './recommend.js';

const profile: ProjectProfile = {
  packageManager: 'pnpm',
  isNextjs: true,
  nextVersion: '16.0.0',
  router: 'app',
  typescript: true,
  testRunners: ['vitest', 'playwright'],
  styling: ['tailwindcss'],
  databaseLibs: ['@prisma/client'],
  integrations: ['stripe'],
  dependencyVersions: {
    next: '^16.0.0',
    tailwindcss: '^4.0.0',
    '@prisma/client': '^6.0.0',
    stripe: '^17.0.0',
    vitest: '^3.0.0',
    '@playwright/test': '^1.50.0',
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
  isGitRepo: true,
  tooling: { formatter: 'prettier', linter: 'eslint', scripts: ['lint', 'typecheck'] },
};
const answers: SetupAnswers = {
  goal: 'marketing site',
  deployTarget: 'vercel',
  budgetSensitivity: 'medium',
  riskTolerance: 'medium',
  workflow: 'standard',
};
const snapshot = fixtureSnapshot();
const prismaItem = snapshot.items.find((i) => i.id === 'example-prisma-mcp')!;
const reasonOf = (out: ReturnType<typeof recommendSetup>, id: string) =>
  out.excluded.find((e) => e.id === id)?.reason;

describe('recommendSetup', () => {
  const r = recommendSetup(snapshot, profile, answers, 15000);

  it('picks one fitting item per needed category in a fixed order', () => {
    expect(r.items.map((i) => [i.category, i.id])).toEqual([
      ['docs', 'example-docs-mcp'],
      ['browser_testing', 'example-playwright-mcp'],
      ['unit_testing', 'example-vitest-skill'],
      ['database', 'example-prisma-mcp'],
      ['deploy', 'example-vercel-mcp'],
      ['ui_components', 'example-tailwind-ui'],
      ['payments', 'example-stripe-mcp'],
      ['code_review', 'example-review-plugin'],
    ]);
    expect(r.gaps).toEqual([]);
  });

  it('only fits a deploy item that matches the stated deploy target', () => {
    expect(reasonOf(r, 'example-cloudflare-skills')).toBe(
      "Made for cloudflare, which isn't detected in this project or named in your answers. It doesn't match your deploy target (Vercel).",
    );
    expect(reasonOf(r, 'example-generic-deploy')).toMatch(
      /^Not made for your deploy target \(Vercel\); deployment items must match/,
    );
    const cf = recommendSetup(snapshot, profile, { ...answers, deployTarget: 'cloudflare' }, 15000);
    expect(cf.items.find((i) => i.category === 'deploy')?.id).toBe('example-cloudflare-skills');
    expect(reasonOf(cf, 'example-vercel-mcp')).toMatch(/^Made for vercel/);
  });

  it('fits vendor-specific items only when that vendor is detected', () => {
    expect(reasonOf(r, 'example-supabase-mcp')).toBe(
      "Made for supabase, which isn't detected in this project or named in your answers.",
    );
    // No GitHub remote: the git hosting category isn't needed at all.
    expect(reasonOf(r, 'example-git-mcp')).toMatch(/^Not needed/);
    const gh = recommendSetup(snapshot, { ...profile, gitRemoteHost: 'github' }, answers, 15000);
    expect(gh.items.find((i) => i.category === 'git_github')).toMatchObject({
      id: 'example-git-mcp',
      fit: 'strong',
      reason: 'Git remote origin is on github.com (.git/config).',
    });
  });

  it('recommends nothing for a needed category where no item fits, and says so', () => {
    const netlify = recommendSetup(
      snapshot,
      profile,
      { ...answers, deployTarget: 'netlify' },
      15000,
    );
    expect(netlify.items.map((i) => i.category)).not.toContain('deploy');
    expect(netlify.gaps).toEqual([
      {
        category: 'deploy',
        categoryLabel: 'Deployment',
        message: 'No suitable item in the catalog yet',
        detail:
          'You said you deploy to Netlify, but none of the 3 reviewed deployment item(s) fits this project, so none is recommended.',
      },
    ]);
  });

  it('names the specific signal that matched, never generic text', () => {
    const byCat = Object.fromEntries(r.items.map((i) => [i.category, i]));
    expect(byCat['ui_components']?.reason).toBe(
      'Tailwind CSS 4 detected in package.json (tailwindcss ^4.0.0).',
    );
    expect(byCat['database']?.reason).toBe(
      'Prisma 6 detected in package.json (@prisma/client ^6.0.0).',
    );
    expect(byCat['deploy']?.reason).toBe('You said you deploy to Vercel.');
    expect(byCat['docs']?.reason).toBe('Next.js 16 detected in package.json (next ^16.0.0).');
    expect(byCat['code_review']?.reason).toBe('You set risk tolerance to medium.');
    for (const i of r.items) expect(i.reason).not.toMatch(/is a git repository|Catches issues/);
  });

  it('shows fit and credibility separately', () => {
    const db = r.items.find((i) => i.category === 'database')!;
    expect(db).toMatchObject({
      fit: 'strong',
      fitReason: 'Made for Prisma, which this project uses.',
      credibility: 'medium',
    });
    expect(db.credibilitySummary).toMatch(/^credibility medium; hygiene pass/);
    expect(r.items.find((i) => i.category === 'docs')).toMatchObject({
      fit: 'good',
      credibility: 'high',
    });
    expect(r.items.every((i) => !('confidence' in i))).toBe(true);
  });

  it('counts skill and plugin context overhead and lists what it could not measure', () => {
    const skill = r.items.find((i) => i.id === 'example-vitest-skill')!;
    expect(skill.tradeoff).toContain(
      'Adds ~150 tokens of skill, command and agent descriptions to every request',
    );
    expect(skill.tradeoff).toContain('up to ~2000 more tokens while one of its skills is in use');
    expect(r.contextOverhead).toEqual({
      totalTokens: 1200 + 3000 + 150 + 1000 * 4,
      unknownItems: ['example-review-plugin'],
      thresholdTokens: 15000,
      warning: false,
    });
    expect(recommendSetup(snapshot, profile, answers, 5000).contextOverhead.warning).toBe(true);
  });

  it('words provisional as approved-before-evals and calls an item new only when it is', () => {
    const ui = r.items.find((i) => i.id === 'example-tailwind-ui')!;
    expect(ui.tradeoff).toContain(
      'provisional: approved on gate, security and classification evidence; not yet confirmed by evals over 60 days',
    );
    expect(ui.tradeoff).toContain('new: first published 48 days ago');
    const old = recommendSetup(
      {
        ...snapshot,
        items: snapshot.items.map((i) =>
          i.id === 'example-tailwind-ui'
            ? { ...i, firstPublishedAt: '2023-01-01T00:00:00.000Z' }
            : i,
        ),
      },
      profile,
      answers,
      15000,
    ).items.find((i) => i.id === 'example-tailwind-ui')!;
    expect(old.tradeoff).toContain(
      'provisional: approved on gate, security and classification evidence; not yet confirmed by evals over 60 days',
    );
    expect(old.tradeoff).not.toMatch(/new|too new/);
  });

  it('reports trade-offs: env vars and risky capabilities', () => {
    const gh = recommendSetup(snapshot, { ...profile, gitRemoteHost: 'github' }, answers, 15000);
    const git = gh.items.find((i) => i.id === 'example-git-mcp')!;
    expect(git.tradeoff).toContain('needs EXAMPLE_GIT_TOKEN');
    expect(git.tradeoff).toContain('can use shell');
  });

  it('is byte-identical across runs (FR-R8)', () => {
    expect(JSON.stringify(recommendSetup(fixtureSnapshot(), profile, answers, 15000))).toBe(
      JSON.stringify(r),
    );
  });

  it('skips categories the project does not need', () => {
    const minimal = recommendSetup(
      snapshot,
      {
        ...profile,
        testRunners: [],
        styling: [],
        databaseLibs: [],
        integrations: [],
        dependencyVersions: { next: '16.0.1' },
        isGitRepo: false,
      },
      { ...answers, deployTarget: 'self_hosted' },
      15000,
    );
    expect(minimal.items.map((i) => i.category)).toEqual(['docs', 'code_review']);
  });

  it('offers only stack-independent items at low credibility for unsupported stacks', () => {
    const py = recommendSetup(
      snapshot,
      { ...profile, isNextjs: false, stacks: [], gitRemoteHost: 'github' },
      answers,
      15000,
    );
    expect(py.items.map((i) => i.id)).toEqual(['example-review-plugin', 'example-git-mcp']);
    expect(py.items.every((i) => i.credibility === 'low')).toBe(true);
  });

  it('takes its model suggestion from the model rules', () => {
    expect(r.model.model).toBe('sonnet');
    expect(
      recommendSetup(
        snapshot,
        profile,
        { ...answers, complexity: 'complex', budgetSensitivity: 'low' },
        15000,
      ).model.model,
    ).toBe('opus');
  });
});

describe('technology matching', () => {
  it('normalises spellings', () => {
    expect(techSlug('Next.js')).toBe('nextjs');
    expect(techSlug('TailwindCSS')).toBe('tailwind');
    expect(techSlug('Cloudflare Workers')).toBe('cloudflare');
    expect(techSlug('react-native')).toBe('reactnative');
  });

  it('ignores generic words and falls back to vendor names for older snapshots', () => {
    const base = snapshot.items[0]!;
    expect(itemTechnologies({ ...base, technologies: ['TypeScript', 'MCP', 'Prisma'] })).toEqual([
      'prisma',
    ]);
    expect(itemTechnologies({ ...base, technologies: null, name: 'cloudflare-deploy' })).toEqual([
      'cloudflare',
    ]);
    expect(itemTechnologies({ ...base, technologies: null, name: 'skills' })).toEqual([]);
  });

  it('reads deploy config files when the deploy target is unknown', () => {
    const t = projectTechnologies(
      { ...profile, deployConfigs: ['wrangler.toml'] },
      {
        ...answers,
        deployTarget: 'unknown',
      },
    );
    expect(t.get('cloudflare')?.signal).toBe('wrangler.toml found in the project root');
    const r = recommendSetup(
      snapshot,
      { ...profile, deployConfigs: ['wrangler.toml'] },
      { ...answers, deployTarget: 'unknown' },
      15000,
    );
    expect(r.items.find((i) => i.category === 'deploy')?.id).toBe('example-cloudflare-skills');
  });
});

describe('vendor matching', () => {
  const withPrisma = (overrides: Partial<SnapshotItem>): Snapshot => ({
    ...snapshot,
    items: snapshot.items.map((i) => (i.id === 'example-prisma-mcp' ? { ...i, ...overrides } : i)),
  });
  const database = (s: Snapshot) => {
    const out = recommendSetup(s, profile, answers, 15000);
    return {
      item: out.items.find((i) => i.category === 'database')!,
      prisma: out.excluded.find((e) => e.id === 'example-prisma-mcp'),
      sql: out.excluded.find((e) => e.id === 'example-sql-mcp'),
    };
  };

  it('prefers the item made for a detected library over a higher-ranked general one', () => {
    const { item, sql } = database(snapshot);
    expect(item.id).toBe('example-prisma-mcp');
    expect(sql?.reason).toMatch(/made for a technology you use/);
  });

  it('ignores the vendor preference for a security-flagged item and says why', () => {
    const { item, prisma } = database(
      withPrisma({ scorecard: { ...prismaItem.scorecard, securityFlags: 1 } }),
    );
    expect(item.id).toBe('example-sql-mcp');
    expect(item.reason).toContain(
      'example-prisma-mcp matches your stack but it has security flags',
    );
    expect(item.reason).toContain('normal ranking applies');
    expect(prisma?.reason).toMatch(/Matches your stack, but it has security flags/);
  });

  it('ignores the vendor preference for a low-credibility item', () => {
    const { item } = database(
      withPrisma({ scorecard: { ...prismaItem.scorecard, confidence: 'low' } }),
    );
    expect(item.id).toBe('example-sql-mcp');
    expect(item.reason).toContain('its confidence is low');
  });
});
