import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Where eval logs go (plan 3.1). Local disk now; object storage later behind the same interface. */
export interface ArtifactStore {
  /** Stores a run's files and returns a reference for `eval_runs.logs_ref`. */
  putRun(runId: string, files: Record<string, string>): Promise<string>;
}

export function createLocalArtifactStore(dir: string): ArtifactStore {
  const root = resolve(dir);
  return {
    async putRun(runId, files) {
      if (!/^[a-z0-9-]+$/.test(runId)) throw new Error('invalid run id');
      const runDir = join(root, runId);
      await mkdir(runDir, { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        if (!/^[a-z0-9._-]+$/i.test(name)) throw new Error(`invalid artifact name ${name}`);
        await writeFile(join(runDir, name), content);
      }
      return `local:${runId}`;
    },
  };
}
