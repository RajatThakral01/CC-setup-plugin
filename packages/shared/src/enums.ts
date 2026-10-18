import { z } from 'zod';

export const KINDS = [
  'mcp_server',
  'skill',
  'plugin',
  'subagent',
  'hook_recipe',
  'model_setting',
  'claude_code_feature',
] as const;
export const kindSchema = z.enum(KINDS);
export type Kind = z.infer<typeof kindSchema>;

/** Plan M1 starting set plus auth, payments, email, cms (owner decision 2026-10-19). */
export const CATEGORIES = [
  'docs',
  'browser_testing',
  'unit_testing',
  'database',
  'deploy',
  'ui_components',
  'code_review',
  'git_github',
  'observability',
  'search',
  'auth',
  'payments',
  'email',
  'cms',
] as const;
export const categorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof categorySchema>;

export const PROVENANCES = ['official_vendor', 'community', 'anthropic'] as const;
export const provenanceSchema = z.enum(PROVENANCES);
export type Provenance = z.infer<typeof provenanceSchema>;

/** Lifecycle from PRD FR-C7. */
export const STATUSES = [
  'candidate',
  'watchlist',
  'recommended_provisional',
  'recommended',
  'deprecated',
  'blocked',
  'rejected',
] as const;
export const statusSchema = z.enum(STATUSES);
export type Status = z.infer<typeof statusSchema>;

export const CAPABILITIES = [
  'shell',
  'file_read',
  'file_write',
  'network',
  'browser',
  'database',
  'code_execution',
] as const;
export const capabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof capabilitySchema>;

/** Where a raw source record came from. One external ID namespace per source. */
export const SOURCES = [
  'github_repo',
  'npm_package',
  'mcp_registry',
  'marketplace',
  'claude_code_changelog',
  'claude_code_release',
] as const;
export const sourceSchema = z.enum(SOURCES);
export type Source = z.infer<typeof sourceSchema>;

export const CONFIDENCES = ['low', 'medium', 'high'] as const;
export const confidenceSchema = z.enum(CONFIDENCES);
export type Confidence = z.infer<typeof confidenceSchema>;

export const BUDGET_PURPOSES = ['classify', 'eval'] as const;
export const budgetPurposeSchema = z.enum(BUDGET_PURPOSES);
export type BudgetPurpose = z.infer<typeof budgetPurposeSchema>;

export const CLASSIFICATION_STATES = [
  'pending',
  'classified',
  'needs_manual_classification',
] as const;
export const classificationStateSchema = z.enum(CLASSIFICATION_STATES);
export type ClassificationState = z.infer<typeof classificationStateSchema>;

/**
 * Intake state of a raw record (PRD FR-D10): `pending` not yet evaluated, `accepted` became a
 * candidate, `linked` matched an existing item, `filtered` failed the filter, `deferred` passed
 * but hit the daily cap, `not_applicable` backs an item without being an entity of its own.
 */
export const INTAKE_STATES = [
  'pending',
  'accepted',
  'linked',
  'filtered',
  'deferred',
  'not_applicable',
] as const;
export const intakeStateSchema = z.enum(INTAKE_STATES);
export type IntakeState = z.infer<typeof intakeStateSchema>;

export const STACKS = ['nextjs'] as const;
