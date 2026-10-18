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

export const snapshotItemSchema = z.object({
  id: itemIdSchema,
  name: z.string().min(1),
  kind: kindSchema,
  category: categorySchema,
  stacks: z.array(z.string()).min(1),
  sourceUrl: z.url(),
  publisher: z.string().nullable(),
  provenance: provenanceSchema,
  status: snapshotStatusSchema,
  version: z.string().min(1),
  install: installSchema,
  capabilities: z.array(capabilitySchema),
  contextOverheadTokens: z.number().int().nonnegative().nullable(),
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
