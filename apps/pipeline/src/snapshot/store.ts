import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppError } from '@cc-setup-agent/core';

/** Files that make up one published snapshot. */
export interface SnapshotFiles {
  version: string;
  /** `catalog-<version>.json` */
  catalog: Buffer;
  /** Detached Ed25519 signature of `catalog`, base64. */
  signature: string;
  sha256: string;
}

/** Pointer the plugin reads first to find the newest snapshot. */
export interface LatestPointer {
  version: string;
  catalog: string;
  signature: string;
  sha256: string;
}

/** Where snapshots are published (plan 3.1: storage behind an interface). */
export interface SnapshotStore {
  readonly kind: string;
  /** Writes the snapshot and the `latest.json` pointer; returns the location of the catalog file. */
  publish(files: SnapshotFiles): Promise<string>;
}

export const catalogFileName = (version: string) => `catalog-${version}.json`;

/** Local directory store (owner decision 2026-10-19: no remote publishing yet). */
export class LocalSnapshotStore implements SnapshotStore {
  readonly kind = 'local';
  readonly dir: string;
  constructor(dir: string) {
    this.dir = resolve(dir);
  }
  async publish(files: SnapshotFiles): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const name = catalogFileName(files.version);
    await writeFile(join(this.dir, name), files.catalog);
    await writeFile(join(this.dir, `${name}.sig`), `${files.signature}\n`);
    await writeFile(join(this.dir, `${name}.sha256`), `${files.sha256}  ${name}\n`);
    const pointer: LatestPointer = {
      version: files.version,
      catalog: name,
      signature: `${name}.sig`,
      sha256: files.sha256,
    };
    // Pointer last, so a reader never sees a pointer to files that aren't written yet.
    await writeFile(join(this.dir, 'latest.json'), `${JSON.stringify(pointer, null, 2)}\n`);
    return pathToFileURL(join(this.dir, name)).toString();
  }
}

export class SnapshotStoreUnavailableError extends AppError {}

/**
 * GitHub release asset store, kept behind the interface for later. Publishing needs a write token,
 * which the owner has decided not to provide yet, so it refuses clearly instead of half-working.
 */
export class GithubReleaseSnapshotStore implements SnapshotStore {
  readonly kind = 'github-release';
  publish(): Promise<string> {
    return Promise.reject(
      new SnapshotStoreUnavailableError(
        'SNAPSHOT_STORE=github-release is not available yet (distribution deferred; it needs a write token). Use SNAPSHOT_STORE=local.',
      ),
    );
  }
}

export function createSnapshotStore(config: {
  SNAPSHOT_STORE: 'local' | 'github-release';
  SNAPSHOT_LOCAL_DIR: string;
}): SnapshotStore {
  return config.SNAPSHOT_STORE === 'local'
    ? new LocalSnapshotStore(config.SNAPSHOT_LOCAL_DIR)
    : new GithubReleaseSnapshotStore();
}
