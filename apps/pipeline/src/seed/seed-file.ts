import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import { categorySchema, kindSchema } from '@cc-setup-agent/shared';

export const seedEntrySchema = z.object({
  source_url: z.url(),
  note: z.string().optional(),
  /** Owner-approved hints; classification never overrides them. */
  kind: kindSchema.optional(),
  category: categorySchema.optional(),
});
export type SeedEntry = z.infer<typeof seedEntrySchema>;

export const seedFileSchema = z.array(seedEntrySchema);

export async function readSeedFile(path: string): Promise<SeedEntry[]> {
  const parsed: unknown = parse(await readFile(path, 'utf8'));
  return seedFileSchema.parse(parsed ?? []);
}
