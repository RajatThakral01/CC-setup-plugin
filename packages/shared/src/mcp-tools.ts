/**
 * Input and output schemas for every plugin MCP tool (PRD 10.2, plan M7, plus backup_setup).
 * Every output carries `catalogVersion` (PRD 10.3). No schema accepts or returns secret values:
 * environment variables appear by name only.
 */
import { z } from 'zod';
import { envVarNameSchema, itemIdSchema } from './catalog.js';
import { categorySchema, confidenceSchema } from './enums.js';
import { snapshotItemSchema, snapshotStatusSchema } from './snapshot.js';

const catalogVersion = z.string().min(1);
const projectPath = z.string().min(1);
/** Paths returned to Claude are relative to the project root. */
const relativePath = z
  .string()
  .min(1)
  .refine(
    (p) => !p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p) && !p.split(/[\\/]/).includes('..'),
    {
      message: 'must be a relative path inside the project',
    },
  );

// analyze_project
export const analyzeProjectInputSchema = z.object({ path: projectPath });
export const projectProfileSchema = z.object({
  packageManager: z.enum(['pnpm', 'npm', 'yarn', 'bun']).nullable(),
  isNextjs: z.boolean(),
  nextVersion: z.string().nullable(),
  router: z.enum(['app', 'pages', 'both']).nullable(),
  typescript: z.boolean(),
  testRunners: z.array(z.enum(['vitest', 'jest', 'playwright', 'cypress'])),
  styling: z.array(z.string()),
  databaseLibs: z.array(z.string()),
  /** Detected auth, payments, email, CMS and observability libraries (package names). */
  integrations: z.array(z.string()),
  /** Declared version ranges of the detected libraries above (package name → range). */
  dependencyVersions: z.record(z.string(), z.string()).default({}),
  /** Deploy config files found at the root (vercel.json, netlify.toml, wrangler.toml, …). */
  deployConfigs: z.array(z.string()).default([]),
  /** Host of the git `origin` remote, from .git/config; null without a remote. */
  gitRemoteHost: z.enum(['github', 'gitlab', 'bitbucket', 'other']).nullable().default(null),
  monorepo: z.object({
    isMonorepo: z.boolean(),
    markers: z.array(z.string()),
    packages: z.array(relativePath),
  }),
  existingConfig: z.object({
    claudeMd: z.boolean(),
    mcpJson: z.boolean(),
    claudeDir: z.boolean(),
    settingsJson: z.boolean(),
    agentsDir: z.boolean(),
    skillsDir: z.boolean(),
    /** AGENTS.md at the root (create-next-app 16 writes one). */
    agentsMd: z.boolean().default(false),
    /** CLAUDE.md already imports AGENTS.md (`@AGENTS.md`) outside the managed block. */
    claudeMdImportsAgentsMd: z.boolean().default(false),
  }),
  mcpServerNames: z.array(z.string()),
  stacks: z.array(z.string()),
  isGitRepo: z.boolean(),
  /** Formatter, linter and the relevant package.json script names; used for hook recipes. */
  tooling: z.object({
    formatter: z.enum(['prettier', 'biome']).nullable(),
    linter: z.enum(['eslint', 'biome']).nullable(),
    scripts: z.array(z.string()),
  }),
});
export type ProjectProfile = z.infer<typeof projectProfileSchema>;
export const analyzeProjectOutputSchema = z.object({
  catalogVersion,
  profile: projectProfileSchema,
  /** Prominent warnings, e.g. a blocked item already installed (FR-U2). */
  warnings: z.array(z.string()),
});

// recommend_setup
export const setupAnswersSchema = z.object({
  goal: z.string().max(500),
  deployTarget: z.enum(['vercel', 'netlify', 'cloudflare', 'self_hosted', 'other', 'unknown']),
  budgetSensitivity: z.enum(['low', 'medium', 'high']),
  riskTolerance: z.enum(['low', 'medium', 'high']),
  workflow: z.enum(['test_first', 'standard', 'exploratory', 'other']),
  /** Inferred from the goal by the setup skill (not a separate question); drives the model rule. */
  complexity: z.enum(['simple', 'standard', 'complex']).optional(),
});
export type SetupAnswers = z.infer<typeof setupAnswersSchema>;
export const recommendSetupInputSchema = z.object({
  profile: projectProfileSchema,
  answers: setupAnswersSchema,
});
/** How well an item fits this project (separate from credibility, which is the gates' verdict). */
export const fitSchema = z.enum(['strong', 'good']);
export const recommendedItemSchema = z.object({
  id: itemIdSchema,
  name: z.string(),
  kind: z.string(),
  category: categorySchema,
  /** Human label for the category; internal category ids are never shown to users. */
  categoryLabel: z.string(),
  /** The specific project signal or answer that matched (e.g. "Tailwind CSS 4 in package.json"). */
  reason: z.string(),
  fit: fitSchema,
  /** Why the fit level was given. */
  fitReason: z.string(),
  /** Credibility from the gates (hygiene, provenance, health, security); not a fit judgement. */
  credibility: confidenceSchema,
  credibilitySummary: z.string(),
  tradeoff: z.string(),
  contextOverheadTokens: z.number().int().nonnegative().nullable(),
  contextOnUseTokens: z.number().int().nonnegative().nullable(),
});
/** A needed category where no catalog item clears the fit bar. */
export const categoryGapSchema = z.object({
  category: categorySchema,
  categoryLabel: z.string(),
  message: z.string(),
  detail: z.string(),
});
export const hookIdSchema = z.enum(['format-on-edit', 'lint-on-edit', 'typecheck-on-stop']);
export type HookId = z.infer<typeof hookIdSchema>;
export const hookProposalSchema = z.object({
  id: hookIdSchema,
  description: z.string(),
  reason: z.string(),
});
export type HookProposal = z.infer<typeof hookProposalSchema>;
export const excludedItemSchema = z.object({
  id: itemIdSchema,
  name: z.string(),
  reason: z.string(),
});
export const recommendSetupOutputSchema = z.object({
  catalogVersion,
  items: z.array(recommendedItemSchema),
  excluded: z.array(excludedItemSchema),
  /** Needed categories with no suitable item: nothing is recommended there (a bad fit is worse). */
  gaps: z.array(categoryGapSchema),
  /** Hook recipes that fit the project's tooling; each needs its own approval. */
  hooks: z.array(hookProposalSchema),
  model: z.object({
    model: z.string(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    costNote: z.string(),
  }),
  contextOverhead: z.object({
    /** Always-loaded tokens: MCP tool definitions plus skill, command and agent descriptions. */
    totalTokens: z.number().int().nonnegative(),
    /** Recommended items whose overhead couldn't be measured. */
    unknownItems: z.array(z.string()),
    thresholdTokens: z.number().int().positive(),
    warning: z.boolean(),
  }),
});
export type RecommendSetupOutput = z.infer<typeof recommendSetupOutputSchema>;

// explain_item
export const explainItemInputSchema = z.object({ id: z.string().min(1) });
export const explainItemOutputSchema = z.object({
  catalogVersion,
  item: snapshotItemSchema,
  alternatives: z.array(
    z.object({
      id: itemIdSchema,
      name: z.string(),
      status: snapshotStatusSchema,
      confidence: confidenceSchema,
    }),
  ),
});

// backup_setup
export const backupSetupInputSchema = z.object({ path: projectPath });
export const backupSetupOutputSchema = z.object({
  catalogVersion,
  backupId: z.string().min(1),
  files: z.array(relativePath),
});

// generate_config
export const generateConfigInputSchema = z.object({
  path: projectPath,
  approvedIds: z.array(itemIdSchema),
  /** Approved hook recipes from recommend_setup. */
  hookIds: z.array(hookIdSchema).default([]),
});
export const generatedFileSchema = z.object({
  path: relativePath,
  action: z.enum(['create', 'update', 'unchanged']),
  content: z.string(),
  diff: z.string(),
});
export const generateConfigOutputSchema = z.object({
  catalogVersion,
  /** Detected Claude Code version the config was generated for (NFR-9). */
  claudeCodeVersion: z.string(),
  files: z.array(generatedFileSchema),
  requiredEnvVars: z.array(envVarNameSchema),
  installCommands: z.array(z.string()),
  /**
   * Plugins the install commands add, at project scope (recorded in .claude/settings.json, which
   * the backup covers). Their downloaded copies live in Claude Code's user-level plugin cache.
   */
  plugins: z.array(z.object({ id: itemIdSchema, plugin: z.string(), marketplace: z.string() })),
  /** Approved hooks not added, with the reason (already installed, an existing hook does it). */
  skippedHooks: z.array(z.object({ id: hookIdSchema, reason: z.string() })),
});

// verify_setup
export const verifySetupInputSchema = z.object({ path: projectPath });
export const verifyResultSchema = z.object({
  item: z.string(),
  check: z.enum([
    'package_resolves',
    'server_starts',
    'env_present',
    'settings_parse',
    'duplicate_tools',
  ]),
  status: z.enum(['pass', 'fail']),
  error: z.string().optional(),
  fix: z.string().optional(),
  /** Extra context on a pass, e.g. "started with placeholder values for missing variables". */
  note: z.string().optional(),
});
export const verifySetupOutputSchema = z.object({
  catalogVersion,
  ok: z.boolean(),
  results: z.array(verifyResultSchema),
});

// check_updates
export const checkUpdatesInputSchema = z.object({ path: projectPath });
export const updateNoticeSchema = z.object({
  id: z.string(),
  type: z.enum(['blocked', 'deprecated', 'superseded', 'new_version', 'not_in_catalog']),
  severity: z.enum(['critical', 'warning', 'info']),
  message: z.string(),
  replacementId: itemIdSchema.optional(),
});
export const checkUpdatesOutputSchema = z.object({
  catalogVersion,
  notices: z.array(updateNoticeSchema),
});

// rollback_setup
export const rollbackSetupInputSchema = z.object({
  path: projectPath,
  backupId: z.string().min(1).optional(),
  /** Report what would be restored or removed, and which plugins to uninstall; change nothing. */
  dryRun: z.boolean().default(false),
});
export const rollbackSetupOutputSchema = z.object({
  catalogVersion,
  dryRun: z.boolean(),
  backupId: z.string(),
  restored: z.array(relativePath),
  removed: z.array(relativePath),
  /**
   * Plugins enabled in project settings after the backup was taken. Restoring settings disables
   * them for this project; the commands remove them completely.
   */
  plugins: z.array(z.object({ plugin: z.string(), uninstallCommand: z.string() })),
  /** Marketplaces declared in project settings after the backup was taken. */
  marketplaces: z.array(z.object({ name: z.string(), removeCommand: z.string() })),
});

// sync_catalog
export const syncCatalogInputSchema = z.object({});
export const syncCatalogOutputSchema = z.object({
  catalogVersion,
  generatedAt: z.iso.datetime(),
  ageDays: z.number().nonnegative(),
  stale: z.boolean(),
  updated: z.boolean(),
  itemCount: z.number().int().nonnegative(),
  warning: z.string().optional(),
});
