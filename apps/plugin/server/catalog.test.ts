import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixtureSnapshot, writeSignedCatalog } from '../../../test/fixtures/plugin/catalog.js';
import { loadCatalog, syncCatalog } from './catalog.js';
import { settingsFromEnv, type PluginSettings } from './settings.js';

async function settingsFor(url: string | undefined, publicKeyPem: string): Promise<PluginSettings> {
  return {
    ...settingsFromEnv({}),
    dataDir: await mkdtemp(join(tmpdir(), 'ccsa-data-')),
    catalogUrl: url,
    publicKeyPem,
  };
}
const now = new Date('2026-10-20T02:00:00.000Z');

describe('syncCatalog', () => {
  it('downloads, verifies and caches the signed catalog', async () => {
    const c = await writeSignedCatalog(fixtureSnapshot());
    const settings = await settingsFor(c.url, c.publicKeyPem);
    const r = await syncCatalog(settings, now);
    expect(r).toMatchObject({ updated: true, catalog: { ageDays: 1, stale: false } });
    expect(r.catalog?.snapshot.items.length).toBe(13);
    expect((await syncCatalog(settings, now)).updated).toBe(false);
    expect((await loadCatalog(settings, now))?.snapshot.version).toBe('2026.10.19-1');
  });

  it('rejects a tampered catalog and keeps the last valid one', async () => {
    const c = await writeSignedCatalog(fixtureSnapshot());
    const settings = await settingsFor(c.url, c.publicKeyPem);
    await syncCatalog(settings, now);
    const newer = { ...fixtureSnapshot(), version: '2026.10.20-1' };
    const evil = await writeSignedCatalog(newer, {
      publicKeyPem: c.publicKeyPem,
      privateKeyPem: c.privateKeyPem,
    });
    const file = join(evil.dir, 'catalog-2026.10.20-1.json');
    const bytes = await readFile(file, 'utf8');
    await writeFile(file, bytes.replace('"high"', '"low"'));
    const r = await syncCatalog({ ...settings, catalogUrl: evil.url }, now);
    expect(r.updated).toBe(false);
    expect(r.warning).toMatch(/signature is invalid/);
    expect(r.catalog?.snapshot.version).toBe('2026.10.19-1');
  });

  it('rejects a catalog signed with another key', async () => {
    const c = await writeSignedCatalog(fixtureSnapshot());
    const other = await writeSignedCatalog(fixtureSnapshot());
    const r = await syncCatalog(await settingsFor(other.url, c.publicKeyPem), now);
    expect(r.catalog).toBeNull();
    expect(r.warning).toMatch(/signature is invalid.*no catalog available/);
  });

  it('refuses a tampered cached copy on load', async () => {
    const c = await writeSignedCatalog(fixtureSnapshot());
    const settings = await settingsFor(c.url, c.publicKeyPem);
    await syncCatalog(settings, now);
    const cached = join(settings.dataDir, 'catalog', 'current.json');
    await writeFile(
      cached,
      (await readFile(cached, 'utf8')).replace('example-docs-mcp', 'example-evil-mcp'),
    );
    await expect(loadCatalog(settings, now)).rejects.toThrow(/signature is invalid/);
  });

  it('warns when stale or not configured', async () => {
    const c = await writeSignedCatalog(fixtureSnapshot('2026-10-01T00:00:00.000Z'));
    const settings = await settingsFor(c.url, c.publicKeyPem);
    expect((await syncCatalog(settings, now)).catalog).toMatchObject({ stale: true });
    const none = await syncCatalog(await settingsFor(undefined, c.publicKeyPem), now);
    expect(none).toMatchObject({
      catalog: null,
      warning: expect.stringMatching(/No catalog source configured/),
    });
  });

  it('ignores unexpanded placeholders in settings', () => {
    expect(
      settingsFromEnv({
        CC_SETUP_AGENT_CATALOG_URL: '${CC_SETUP_AGENT_CATALOG_URL}',
        PLUGIN_DATA_DIR: '',
      }).catalogUrl,
    ).toBeUndefined();
  });
});
