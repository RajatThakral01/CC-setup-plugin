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

function settingsKeys(raw: string | null, key: string, enabledOnly: boolean): string[] {
  if (raw === null) return [];
  try {
    const value = (JSON.parse(raw) as Record<string, unknown>)[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    return Object.entries(value)
      .filter(([, v]) => !enabledOnly || v === true)
      .map(([k]) => k)
      .sort();
  } catch {
    return [];
  }
}

export interface PluginChanges {
  plugins: Array<{ plugin: string; uninstallCommand: string }>;
  marketplaces: Array<{ name: string; removeCommand: string }>;
}

/**
 * Plugins and marketplaces declared in project settings since the backup (project-scope installs
 * write `enabledPlugins` and `extraKnownMarketplaces` in .claude/settings.json). Restoring the
 * settings file disables them for the project; the commands also remove the downloaded copy.
 */
export function pluginChanges(backedUp: string | null, current: string | null): PluginChanges {
  const before = new Set(settingsKeys(backedUp, 'enabledPlugins', true));
  const beforeMk = new Set(settingsKeys(backedUp, 'extraKnownMarketplaces', false));
  return {
    plugins: settingsKeys(current, 'enabledPlugins', true)
      .filter((p) => !before.has(p))
      .map((plugin) => ({
        plugin,
        uninstallCommand: `claude plugin uninstall ${plugin} --scope project`,
      })),
    marketplaces: settingsKeys(current, 'extraKnownMarketplaces', false)
      .filter((m) => !beforeMk.has(m))
      .map((name) => ({
        name,
        removeCommand: `claude plugin marketplace remove ${name} --scope project`,
      })),
  };
}

/**
 * Restores a backup (latest when no id is given): files that existed are copied back byte for
 * byte, tracked files that didn't exist are removed. Only paths listed in the manifest are touched.
 * With `dryRun`, nothing changes and the result says what would happen. Either way the result
 * lists plugins installed since the backup, with the commands that remove them (run those before
 * restoring: they edit .claude/settings.json, which the restore then puts back exactly).
 */
export async function rollbackSetup(
  root: string,
  backupId?: string,
  dryRun = false,
): Promise<
  { backupId: string; dryRun: boolean; restored: string[]; removed: string[] } & PluginChanges
> {
  const ids = await listBackups(root);
  const id = backupId ?? ids.at(-1);
  if (!id) throw new PluginError('no backups found in .claude/setup-agent/backups');
  if (!ids.includes(id)) throw new PluginError(`backup ${id} not found`);
  const dir = inside(root, `${BACKUP_DIR}/${id}`);
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')),
  );
  const settingsEntry = manifest.files.find((f) => f.path === '.claude/settings.json');
  const readOrNull = (p: string) => readFile(p, 'utf8').catch(() => null);
  const changes = pluginChanges(
    settingsEntry?.existed ? await readOrNull(join(dir, 'files', '.claude/settings.json')) : null,
    await readOrNull(inside(root, '.claude/settings.json')),
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
      if (!dryRun) {
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(src, dest);
      }
      restored.push(f.path);
    } else if (await exists(dest)) {
      if (!dryRun) await rm(dest);
      removed.push(f.path);
    }
  }
  return { backupId: id, dryRun, restored, removed, ...changes };
}
