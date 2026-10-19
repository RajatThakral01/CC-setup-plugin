import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { exists, inside, PluginError, sha256, toPosix } from './files.js';

export const BACKUP_DIR = '.claude/setup-agent/backups';
/** Files the setup may change; folders are copied recursively. */
export const TRACKED_FILES = ['CLAUDE.md', '.mcp.json', '.claude/settings.json'];
export const TRACKED_DIRS = ['.claude/agents', '.claude/skills'];

const manifestSchema = z.object({
  backupId: z.string(),
  createdAt: z.string(),
  catalogVersion: z.string(),
  files: z.array(
    z.object({ path: z.string(), existed: z.boolean(), sha256: z.string().nullable() }),
  ),
});
export type BackupManifest = z.infer<typeof manifestSchema>;

async function listFiles(root: string, rel: string): Promise<string[]> {
  const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...(await listFiles(root, child)));
    else if (e.isFile()) out.push(child);
  }
  return out;
}

export function newBackupId(now: Date): string {
  return `${now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}-${randomBytes(2).toString('hex')}`;
}

/**
 * Copies existing setup files into `.claude/setup-agent/backups/<id>/` with a manifest, recording
 * tracked files that don't exist yet so rollback can remove them. Writes nowhere else.
 */
export async function backupSetup(
  root: string,
  catalogVersion: string,
  now = new Date(),
): Promise<BackupManifest> {
  const backupId = newBackupId(now);
  const target = inside(root, `${BACKUP_DIR}/${backupId}`);
  await mkdir(target, { recursive: true });
  const paths = [...TRACKED_FILES];
  for (const d of TRACKED_DIRS) paths.push(...(await listFiles(root, d)));
  const files: BackupManifest['files'] = [];
  for (const rel of paths) {
    const src = inside(root, rel);
    if (await exists(src)) {
      const dest = join(target, 'files', rel);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(src, dest);
      files.push({ path: toPosix(rel), existed: true, sha256: sha256(await readFile(src)) });
    } else {
      files.push({ path: toPosix(rel), existed: false, sha256: null });
    }
  }
  const manifest: BackupManifest = {
    backupId,
    createdAt: now.toISOString(),
    catalogVersion,
    files,
  };
  await writeFile(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function listBackups(root: string): Promise<string[]> {
  const entries = await readdir(inside(root, BACKUP_DIR), { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Restores a backup (latest when no id is given): files that existed are copied back byte for
 * byte, tracked files that didn't exist are removed. Only paths listed in the manifest are touched.
 */
export async function rollbackSetup(
  root: string,
  backupId?: string,
): Promise<{ backupId: string; restored: string[]; removed: string[] }> {
  const ids = await listBackups(root);
  const id = backupId ?? ids.at(-1);
  if (!id) throw new PluginError('no backups found in .claude/setup-agent/backups');
  if (!ids.includes(id)) throw new PluginError(`backup ${id} not found`);
  const dir = inside(root, `${BACKUP_DIR}/${id}`);
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')),
  );
  const restored: string[] = [];
  const removed: string[] = [];
  for (const f of manifest.files) {
    const dest = inside(root, f.path);
    if (f.existed) {
      const src = join(dir, 'files', f.path);
      const bytes = await readFile(src);
      if (f.sha256 && sha256(bytes) !== f.sha256)
        throw new PluginError(
          `backup copy of ${f.path} is corrupted; nothing restored past this point`,
        );
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(src, dest);
      restored.push(f.path);
    } else if (await exists(dest)) {
      await rm(dest);
      removed.push(f.path);
    }
  }
  return { backupId: id, restored, removed };
}
