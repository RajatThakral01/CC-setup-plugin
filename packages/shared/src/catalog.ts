import { z } from 'zod';
import {
  capabilitySchema,
  categorySchema,
  classificationStateSchema,
  confidenceSchema,
  kindSchema,
  provenanceSchema,
  statusSchema,
} from './enums.js';

/** Stable slug: lowercase letters, digits and single dashes. */
export const itemIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'id must be a lowercase slug');

/** Environment variable names only; values are never stored (FR-G7). */
export const envVarNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'must be an env var name');

/** Pinned version string; `latest` and ranges are refused (FR-G6). */
export const pinnedVersionSchema = z
  .string()
  .min(1)
  .refine((v) => v.toLowerCase() !== 'latest' && !/^[~^=]|[*<>|]|\s|(^|\.)x(\.|$)/i.test(v), {
    message: 'must be an exact version, never latest or a range',
  });

export const installSchema = z.object({
  method: z.enum(['npx', 'uvx', 'docker', 'remote', 'plugin', 'skill_copy', 'manual']),
  package: z.string().min(1).optional(),
  version: pinnedVersionSchema.optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  url: z.url().optional(),
  plugin: z.object({ marketplace: z.string().min(1), name: z.string().min(1) }).optional(),
  envVars: z.array(envVarNameSchema).default([]),
});
export type Install = z.infer<typeof installSchema>;

/** LLM classification stored with model and prompt version (FR-D9). */
/** Stack tags classification may assign; `any` means stack-independent. */
export const STACK_TAGS = ['nextjs', 'react', 'node', 'python', 'any'] as const;

export const classificationSchema = z.object({
  kind: kindSchema,
  category: categorySchema.nullable(),
  stacks: z.array(z.string()),
  /** Products or services the project must use for the tool to help (classify-v3 and later). */
  technologies: z.array(z.string()).default([]),
  summary: z.string(),
  provenanceGuess: provenanceSchema,
  /** False when the tool is not something a developer adds to a Claude Code setup. */
  relevant: z.boolean(),
  model: z.string(),
  promptVersion: z.string(),
  classifiedAt: z.iso.datetime(),
});
export type Classification = z.infer<typeof classificationSchema>;

const componentSchema = z.object({ name: z.string(), description: z.string() });
/**
 * What an item adds to Claude Code, found by the gates: MCP tools (from the sandbox probe) and
 * the skills, commands and agents in its tree (from frontmatter). Used for classification and
 * the context-overhead estimate. Descriptions are truncated third-party text.
 */
export const itemComponentsSchema = z.object({
  tools: z.array(componentSchema).default([]),
  skills: z.array(componentSchema).default([]),
  commands: z.array(componentSchema).default([]),
  agents: z.array(componentSchema).default([]),
  /** The plugin bundles MCP servers whose tools weren't listed. */
  mcpServers: z.number().int().nonnegative().default(0),
  collectedAt: z.iso.datetime(),
});
export type ItemComponents = z.infer<typeof itemComponentsSchema>;

/** A reclassification that changed kind or category, kept until the owner reviews it. */
export const classificationReviewSchema = z.object({
  previousKind: z.string().nullable(),
  previousCategory: z.string().nullable(),
  promptVersion: z.string(),
  changedAt: z.iso.datetime(),
});
export type ClassificationReview = z.infer<typeof classificationReviewSchema>;

/** Stack tags that make a tool useful in a Next.js project (owner decision 2026-10-19). */
export const NEXTJS_SCOPE_TAGS: readonly string[] = ['nextjs', 'react', 'any'];

/** Relevant to the Next.js stack: a real setup item tagged nextjs, react or stack-independent. */
export function isNextjsRelevant(c: Pick<Classification, 'relevant' | 'stacks'>): boolean {
  return c.relevant && c.stacks.some((s) => NEXTJS_SCOPE_TAGS.includes(s));
}

export const catalogItemSchema = z.object({
  id: itemIdSchema,
  name: z.string().min(1),
  description: z.string().nullable(),
  kind: kindSchema.nullable(),
  category: categorySchema.nullable(),
  stacks: z.array(z.string()),
  sourceUrl: z.url(),
  packageName: z.string().nullable(),
  publisher: z.string().nullable(),
  provenance: provenanceSchema.nullable(),
  capabilities: z.array(capabilitySchema),
  install: installSchema.nullable(),
  contextOverheadTokens: z.number().int().nonnegative().nullable(),
  status: statusSchema,
  supersedes: itemIdSchema.nullable(),
  supersededBy: itemIdSchema.nullable(),
  classificationState: classificationStateSchema,
  classification: classificationSchema.nullable(),
  firstSeen: z.iso.datetime(),
  lastChecked: z.iso.datetime().nullable(),
});
export type CatalogItem = z.infer<typeof catalogItemSchema>;

export const gateIdSchema = z.enum([
  'gate0_hygiene',
  'gate1_provenance',
  'gate2_health',
  'gate3_security',
]);
export type GateId = z.infer<typeof gateIdSchema>;

export const gateResultSchema = z.object({
  result: z.enum(['pass', 'soft_fail', 'fail', 'not_run']),
  evidence: z.array(
    z.object({ label: z.string(), url: z.url().optional(), detail: z.string().optional() }),
  ),
  notes: z.string().optional(),
  checkedAt: z.iso.datetime(),
});
export type GateResult = z.infer<typeof gateResultSchema>;

export const gateResultsSchema = z.partialRecord(gateIdSchema, gateResultSchema);
export type GateResults = z.infer<typeof gateResultsSchema>;

export const securityFindingSchema = z.object({
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
  description: z.string(),
  evidence: z.string().optional(),
});
export type SecurityFinding = z.infer<typeof securityFindingSchema>;

export const evalSummarySchema = z.object({
  taskSetVersion: z.string(),
  model: z.string(),
  claudeCodeVersion: z.string(),
  baselineItemId: itemIdSchema.nullable(),
  runs: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(1),
  baselineSuccessRate: z.number().min(0).max(1).nullable(),
  meanTokens: z.number().nonnegative(),
  meanCostUsd: z.number().nonnegative(),
  meanWallSeconds: z.number().nonnegative(),
  contextOverheadTokens: z.number().int().nonnegative().nullable(),
  verdict: z.enum(['better', 'equal', 'worse', 'inconclusive']),
});
export type EvalSummary = z.infer<typeof evalSummarySchema>;

export const scorecardSchema = z.object({
  itemId: itemIdSchema,
  version: z.string(),
  gateResults: gateResultsSchema,
  securityFindings: z.array(securityFindingSchema),
  evalSummary: evalSummarySchema.nullable(),
  confidence: confidenceSchema,
  reviewer: z.string().nullable(),
  reviewedAt: z.iso.datetime().nullable(),
});
export type Scorecard = z.infer<typeof scorecardSchema>;
