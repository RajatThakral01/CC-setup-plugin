import { z } from 'zod';
import {
  evalSummarySchema,
  gateIdSchema,
  gateResultSchema,
  installSchema,
  itemIdSchema,
} from './catalog.js';
import {
  capabilitySchema,
  categorySchema,
  confidenceSchema,
  kindSchema,
  provenanceSchema,
} from './enums.js';

/** Statuses a published snapshot may contain (plan M6: no candidate or rejected). */
export const SNAPSHOT_STATUSES = [
  'recommended',
  'recommended_provisional',
  'watchlist',
  'deprecated',
  'blocked',
] as const;
export const snapshotStatusSchema = z.enum(SNAPSHOT_STATUSES);

/** `YYYY.MM.DD-N`, N starting at 1. */
export const snapshotVersionSchema = z
  .string()
  .regex(/^\d{4}\.\d{2}\.\d{2}-[1-9]\d*$/, 'snapshot version must be YYYY.MM.DD-N');

const RECOMMENDABLE = new Set(['recommended', 'recommended_provisional']);

export const snapshotItemSchema = z
  .object({
    id: itemIdSchema,
    name: z.string().min(1),
    kind: kindSchema,
    /** Nullable only for items published for warnings (watchlist, deprecated, blocked). */
    category: categorySchema.nullable(),
    stacks: z.array(z.string()),
    sourceUrl: z.url(),
    publisher: z.string().nullable(),
    provenance: provenanceSchema,
    status: snapshotStatusSchema,
    version: z.string().min(1),
    install: installSchema.nullable(),
    capabilities: z.array(capabilitySchema),
    /** Tokens always in context: MCP tool definitions, or skill/command/agent descriptions. */
    contextOverheadTokens: z.number().int().nonnegative().nullable(),
    /** Extra tokens when used: the largest skill or command body that loads on invocation. */
    contextOnUseTokens: z.number().int().nonnegative().nullable().default(null),
    /** One-line plain description (classifier summary or the source's description). */
    summary: z.string().nullable().default(null),
    /**
     * Products, services or libraries the project must use for this item to help (e.g. a Prisma
     * server → prisma). Empty for tools that work on any project; null when not classified yet.
     */
    technologies: z.array(z.string()).nullable().default(null),
    /** When the repo or package was first published, for "too new to judge" notes. */
    firstPublishedAt: z.iso.datetime().nullable().default(null),
    supersedes: itemIdSchema.nullable(),
    supersededBy: itemIdSchema.nullable(),
    scorecard: z.object({
      confidence: confidenceSchema,
      gates: z.partialRecord(gateIdSchema, gateResultSchema),
      securityFlags: z.number().int().nonnegative(),
      reviewedAt: z.iso.datetime().nullable(),
    }),
    evalSummary: evalSummarySchema.nullable(),
    lastChecked: z.iso.datetime(),
  })
  .superRefine((item, ctx) => {
    if (!RECOMMENDABLE.has(item.status)) return;
    if (item.category === null)
      ctx.addIssue({
        code: 'custom',
        path: ['category'],
        message: 'recommended items need a category',
      });
    if (item.install === null)
      ctx.addIssue({
        code: 'custom',
        path: ['install'],
        message: 'recommended items need install details',
      });
    if (item.stacks.length === 0)
      ctx.addIssue({
        code: 'custom',
        path: ['stacks'],
        message: 'recommended items need at least one stack',
      });
  });
export type SnapshotItem = z.infer<typeof snapshotItemSchema>;

export const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: snapshotVersionSchema,
    generatedAt: z.iso.datetime(),
    items: z.array(snapshotItemSchema),
  })
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    s.items.forEach((item, i) => {
      if (seen.has(item.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', i, 'id'],
          message: `duplicate id ${item.id}`,
        });
      }
      seen.add(item.id);
    });
  });
export type Snapshot = z.infer<typeof snapshotSchema>;
