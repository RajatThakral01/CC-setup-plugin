import { describe, expect, it } from 'vitest';
import type { ProjectProfile, SetupAnswers } from '@cc-setup-agent/shared';
import { fixtureSnapshot } from '../../../test/fixtures/plugin/catalog.js';
import { recommendSetup } from './recommend.js';

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
  isGitRepo: true,
};
const answers: SetupAnswers = {
  goal: 'marketing site',
  deployTarget: 'vercel',
  budgetSensitivity: 'medium',
  riskTolerance: 'medium',
  workflow: 'standard',
};
const snapshot = fixtureSnapshot();

describe('recommendSetup', () => {
  const r = recommendSetup(snapshot, profile, answers, 15000);

  it('picks one item per needed category in a fixed order', () => {
    expect(r.items.map((i) => [i.category, i.id])).toEqual([
      ['docs', 'example-docs-mcp'],
      ['browser_testing', 'example-playwright-mcp'],
      ['unit_testing', 'example-vitest-skill'],
      ['database', 'example-prisma-mcp'],
      ['deploy', 'example-vercel-mcp'],
      ['ui_components', 'example-tailwind-ui'],
      ['payments', 'example-stripe-mcp'],
      ['code_review', 'example-review-plugin'],
      ['git_github', 'example-git-mcp'],
    ]);
  });

  it('prefers the item matching the project libraries over a higher-ranked one', () => {
    expect(r.items.find((i) => i.category === 'database')?.reason).toContain('Matches your stack');
    expect(r.excluded.find((e) => e.id === 'example-supabase-mcp')?.reason).toMatch(
      /matches the libraries you use/,
    );
  });

  it('explains every excluded item and never offers blocked, watchlist or candidate items', () => {
    expect(r.excluded.find((e) => e.id === 'example-docs-alt')?.reason).toMatch(
      /Overlaps with example-docs-mcp/,
    );
    const all = [...r.items.map((i) => i.id), ...r.excluded.map((e) => e.id)];
    expect(all).not.toContain('example-blocked-mcp');
    expect(all).not.toContain('example-watch-mcp');
  });

  it('reports trade-offs, scorecard summaries and context overhead', () => {
    const git = r.items.find((i) => i.id === 'example-git-mcp')!;
    expect(git.tradeoff).toContain('needs EXAMPLE_GIT_TOKEN');
    expect(git.tradeoff).toContain('can use shell');
    expect(r.items.find((i) => i.id === 'example-tailwind-ui')?.tradeoff).toContain('provisional');
    expect(git.scorecardSummary).toMatch(/^confidence high; hygiene pass/);
    expect(r.contextOverhead).toEqual({
      totalTokens: 1200 + 3000 + 1000 * 5,
      thresholdTokens: 15000,
      warning: false,
    });
    expect(recommendSetup(snapshot, profile, answers, 5000).contextOverhead.warning).toBe(true);
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
        isGitRepo: false,
      },
      { ...answers, deployTarget: 'self_hosted' },
      15000,
    );
    expect(minimal.items.map((i) => i.category)).toEqual(['docs', 'code_review']);
  });

  it('offers only stack-independent items at low confidence for unsupported stacks', () => {
    const py = recommendSetup(
      snapshot,
      { ...profile, isNextjs: false, stacks: [] },
      answers,
      15000,
    );
    expect(py.items.map((i) => i.id)).toEqual(['example-review-plugin', 'example-git-mcp']);
    expect(py.items.every((i) => i.confidence === 'low')).toBe(true);
  });

  it('recommends Sonnet-class models only', () => {
    for (const budgetSensitivity of ['low', 'medium', 'high'] as const) {
      expect(['sonnet', 'haiku']).toContain(
        recommendSetup(snapshot, profile, { ...answers, budgetSensitivity }, 15000).model.model,
      );
    }
  });
});
