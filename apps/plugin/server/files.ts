import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

export class PluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Resolves and checks a project path: absolute, existing directory. */
export async function projectRoot(path: string): Promise<string> {
  if (!isAbsolute(path))
    throw new PluginError('path must be an absolute path to the project folder');
  const root = resolve(path);
  const s = await stat(root).catch(() => null);
  if (!s?.isDirectory()) throw new PluginError(`not a folder: ${root}`);
  return root;
}

/** Joins a relative path to the project root, refusing anything that escapes it. */
export function inside(root: string, rel: string): string {
  const full = resolve(root, normalize(rel));
  const r = relative(root, full);
  if (r === '' || r.startsWith('..') || isAbsolute(r))
    throw new PluginError(`path outside the project: ${rel}`);
  return full;
}

export const toPosix = (p: string) => p.split(sep).join('/');

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
