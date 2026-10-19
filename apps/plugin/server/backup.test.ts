import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fixtureSnapshot } from '../../../test/fixtures/plugin/catalog.js';
import { backupSetup, rollbackSetup } from './backup.js';
import { generateConfig } from './generate.js';

async function copyFixture(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `ccsa-${name}-`));
  await cp(
    fileURLToPath(new URL(`../../../test/fixtures/projects/${name}`, import.meta.url)),
    dir,
    { recursive: true },
  );
  return dir;
}
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (rel: string) => {
    for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (child.startsWith('.claude/setup-agent')) continue;
      if (e.isDirectory()) await walk(child);
      else out[child] = (await readFile(join(root, child))).toString('base64');
    }
  };
  await walk('');
  return out;
}

describe('backup and rollback', () => {
  it('restores the original files exactly after a generated config is written', async () => {
    const root = await copyFixture('next-existing');
    await mkdir(join(root, '.claude', 'skills', 'mine'), { recursive: true });
    await writeFile(join(root, '.claude', 'skills', 'mine', 'SKILL.md'), 'my skill\n');
    const before = await snapshotTree(root);

    const manifest = await backupSetup(root, '2026.10.19-1');
    expect(
      manifest.files
        .filter((f) => f.existed)
        .map((f) => f.path)
        .sort(),
    ).toEqual(['.claude/skills/mine/SKILL.md', '.mcp.json', 'CLAUDE.md']);
    expect(manifest.files.find((f) => f.path === '.claude/settings.json')).toMatchObject({
      existed: false,
    });

    // What Claude Code would write after the user approves the diffs:
    const r = await generateConfig(root, fixtureSnapshot(), [
      'example-docs-mcp',
      'example-git-mcp',
    ]);
    for (const f of r.files) {
      await mkdir(dirname(join(root, f.path)), { recursive: true });
      await writeFile(join(root, f.path), f.content);
    }
    expect(await snapshotTree(root)).not.toEqual(before);

    const restored = await rollbackSetup(root);
    expect(restored.backupId).toBe(manifest.backupId);
    expect(restored.removed).toEqual(['.claude/settings.json']);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('reports plugins installed at project scope since the backup, with uninstall commands', async () => {
    const root = await copyFixture('next-fresh');
    await mkdir(join(root, '.claude'), { recursive: true });
    const original = JSON.stringify({ enabledPlugins: { 'example-old@example-mk': true } });
    await writeFile(join(root, '.claude', 'settings.json'), original);
    await backupSetup(root, '2026.10.19-1');
    // What `claude plugin install … --scope project` records in the project settings:
    await writeFile(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({
        enabledPlugins: {
          'example-old@example-mk': true,
          'example-review@example-mk': true,
          'example-off@example-mk': false,
        },
        extraKnownMarketplaces: {
          'example-mk': { source: { source: 'github', repo: 'example-org/example-mk' } },
        },
      }),
    );
    const preview = await rollbackSetup(root, undefined, true);
    expect(preview).toMatchObject({
      dryRun: true,
      restored: ['.claude/settings.json'],
      plugins: [
        {
          plugin: 'example-review@example-mk',
          uninstallCommand: 'claude plugin uninstall example-review@example-mk --scope project',
        },
      ],
      marketplaces: [
        {
          name: 'example-mk',
          removeCommand: 'claude plugin marketplace remove example-mk --scope project',
        },
      ],
    });
    // A dry run changes nothing.
    expect(await readFile(join(root, '.claude', 'settings.json'), 'utf8')).toContain(
      'example-review',
    );
    await rollbackSetup(root);
    expect(await readFile(join(root, '.claude', 'settings.json'), 'utf8')).toBe(original);
  });

  it('fails clearly without backups or with an unknown id', async () => {
    const root = await copyFixture('next-fresh');
    await expect(rollbackSetup(root)).rejects.toThrow(/no backups/);
    await backupSetup(root, 'none');
    await expect(rollbackSetup(root, 'nope')).rejects.toThrow(/not found/);
  });

  it('refuses a corrupted backup copy', async () => {
    const root = await copyFixture('next-existing');
    const m = await backupSetup(root, 'none');
    await writeFile(
      join(root, '.claude/setup-agent/backups', m.backupId, 'files', 'CLAUDE.md'),
      'tampered',
    );
    await expect(rollbackSetup(root)).rejects.toThrow(/corrupted/);
  });
});
