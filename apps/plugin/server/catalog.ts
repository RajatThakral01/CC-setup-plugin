import { createPublicKey, verify } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { snapshotSchema, type Snapshot } from '@cc-setup-agent/shared';
import { PluginError, sha256 } from './files.js';
import type { PluginSettings } from './settings.js';

const latestSchema = z.object({
  version: z.string(),
  catalog: z.string(),
  signature: z.string(),
  sha256: z.string(),
});

export const NO_CATALOG = 'none';

export interface LoadedCatalog {
  snapshot: Snapshot;
  ageDays: number;
  stale: boolean;
}

function verifySignature(publicKeyPem: string, bytes: Buffer, signatureBase64: string): boolean {
  try {
    return verify(
      null,
      bytes,
      createPublicKey(publicKeyPem),
      Buffer.from(signatureBase64.trim(), 'base64'),
    );
  } catch {
    return false;
  }
}

/** Validates signed snapshot bytes; throws on a bad signature, checksum or schema (NFR-5). */
export function verifySnapshot(
  publicKeyPem: string,
  bytes: Buffer,
  signature: string,
  expectedSha256?: string,
): Snapshot {
  if (!verifySignature(publicKeyPem, bytes, signature))
    throw new PluginError('catalog signature is invalid; refusing to use it');
  if (expectedSha256 && sha256(bytes) !== expectedSha256)
    throw new PluginError('catalog checksum does not match latest.json');
  const parsed = snapshotSchema.safeParse(JSON.parse(bytes.toString('utf8')));
  if (!parsed.success) throw new PluginError('catalog does not match the expected format');
  return parsed.data;
}

async function fetchBytes(base: string, name: string): Promise<Buffer> {
  if (!/^[A-Za-z0-9._-]+$/.test(name))
    throw new PluginError(`unexpected catalog file name ${name}`);
  const url = new URL(name, base.endsWith('/') ? base : `${base}/`);
  if (url.protocol === 'file:') return readFile(fileURLToPath(url));
  if (url.protocol !== 'https:') throw new PluginError('catalog URL must be https:// or file://');
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new PluginError(`catalog download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const paths = (dataDir: string) => ({
  dir: join(dataDir, 'catalog'),
  bytes: join(dataDir, 'catalog', 'current.json'),
  sig: join(dataDir, 'catalog', 'current.json.sig'),
});

export function ageInDays(generatedAt: string, now: Date): number {
  return Math.max(
    0,
    Math.round(((now.getTime() - Date.parse(generatedAt)) / 86_400_000) * 10) / 10,
  );
}

/** The cached catalog, re-verified on every load so a tampered file on disk is never used. */
export async function loadCatalog(
  settings: PluginSettings,
  now = new Date(),
): Promise<LoadedCatalog | null> {
  const p = paths(settings.dataDir);
  let bytes: Buffer;
  let sig: string;
  try {
    [bytes, sig] = await Promise.all([readFile(p.bytes), readFile(p.sig, 'utf8')]);
  } catch {
    return null;
  }
  const snapshot = verifySnapshot(settings.publicKeyPem, bytes, sig);
  const ageDays = ageInDays(snapshot.generatedAt, now);
  return { snapshot, ageDays, stale: ageDays > settings.staleAfterDays };
}

export interface SyncResult {
  catalog: LoadedCatalog | null;
  updated: boolean;
  warning?: string;
}

/**
 * Downloads `latest.json`, the catalog and its signature, verifies them with the embedded public key
 * and replaces the cached copy. On any failure the last valid catalog stays in use.
 */
export async function syncCatalog(settings: PluginSettings, now = new Date()): Promise<SyncResult> {
  const previous = await loadCatalog(settings, now).catch(() => null);
  if (!settings.catalogUrl) {
    return {
      catalog: previous,
      updated: false,
      warning:
        'No catalog source configured (CC_SETUP_AGENT_CATALOG_URL); using the cached catalog if any.',
    };
  }
  try {
    const latest = latestSchema.parse(
      JSON.parse((await fetchBytes(settings.catalogUrl, 'latest.json')).toString('utf8')),
    );
    if (previous && previous.snapshot.version === latest.version)
      return { catalog: previous, updated: false };
    const bytes = await fetchBytes(settings.catalogUrl, latest.catalog);
    const sig = (await fetchBytes(settings.catalogUrl, latest.signature)).toString('utf8');
    const snapshot = verifySnapshot(settings.publicKeyPem, bytes, sig, latest.sha256);
    const p = paths(settings.dataDir);
    await mkdir(p.dir, { recursive: true });
    // Write next to the target and rename, so a crash never leaves half a catalog.
    await writeFile(`${p.bytes}.tmp`, bytes);
    await writeFile(`${p.sig}.tmp`, sig);
    await rename(`${p.bytes}.tmp`, p.bytes);
    await rename(`${p.sig}.tmp`, p.sig);
    const ageDays = ageInDays(snapshot.generatedAt, now);
    return {
      catalog: { snapshot, ageDays, stale: ageDays > settings.staleAfterDays },
      updated: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      catalog: previous,
      updated: false,
      warning: `Catalog sync failed (${message}); ${previous ? `still using ${previous.snapshot.version}` : 'no catalog available'}.`,
    };
  }
}

export function staleWarning(c: LoadedCatalog | null, staleAfterDays: number): string | undefined {
  if (!c) return 'No catalog yet: run sync_catalog.';
  return c.stale
    ? `The catalog is ${c.ageDays} days old (over ${staleAfterDays}); recommendations may be out of date.`
    : undefined;
}
