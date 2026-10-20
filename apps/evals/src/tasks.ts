import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { categorySchema, type Category } from '@cc-setup-agent/shared';
import { EvalError } from './errors.js';

/** Task folders live in `apps/evals/tasks/<category>/<task-id>/` (plan M9 9.2). */
export const DEFAULT_TASKS_ROOT = fileURLToPath(new URL('../tasks', import.meta.url));
/**
 * Bumped when the harness changes run behaviour, so cached baselines from the old harness are never
 * compared with new runs. 2 (M8.3): stream-json transcripts and a per-command time limit.
 */
export const HARNESS_REVISION = 2;
/** Hidden files shared by every check in a category (copied with the task's own `check/`). */
const SHARED_CHECK_DIR = '_check';

const taskSetFileSchema = z.object({
  category: categorySchema,
  version: z.number().int().positive(),
  /** Products the tasks exercise (lowercase, as in item technologies); empty = vendor-neutral. */
  technologies: z.array(z.string()).default([]),
});
const metaSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  category: categorySchema,
  version: z.number().int().positive(),
  title: z.string().min(1),
});

export interface EvalTask {
  id: string;
  category: Category;
  version: number;
  title: string;
  /** The prompt given to Claude Code (`task.md`). */
  prompt: string;
  dir: string;
  /** Hidden check files (relative path → absolute path), copied in only after the agent finishes. */
  checkFiles: Map<string, string>;
}

export interface TaskSet {
  technologies: string[];
  category: Category;
  /** `<category>-v<n>-<hash>`: changes whenever any task file changes (FR-E5). */
  version: string;
  tasks: EvalTask[];
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(full)));
    else if (e.isFile()) out.push(full);
  }
  return out.sort();
}

const exists = async (p: string) => (await stat(p).catch(() => null)) !== null;
const posix = (p: string) => p.split(sep).join('/');

/** Loads and validates a category's task set; the version hashes every file in it. */
export async function loadTaskSet(category: Category, root = DEFAULT_TASKS_ROOT): Promise<TaskSet> {
  const dir = join(root, category);
  if (!(await exists(join(dir, 'taskset.yaml'))))
    throw new EvalError(`no task set for category ${category} (expected ${dir}/taskset.yaml)`);
  const set = taskSetFileSchema.parse(parseYaml(await readFile(join(dir, 'taskset.yaml'), 'utf8')));
  if (set.category !== category)
    throw new EvalError(`taskset.yaml category ${set.category} doesn't match folder ${category}`);

  const hash = createHash('sha256');
  // A harness change that affects how runs behave invalidates cached baselines too (FR-E5).
  hash.update(`harness:${HARNESS_REVISION}\0`);
  for (const file of await filesUnder(dir)) {
    hash.update(posix(relative(dir, file)));
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }

  const shared = join(dir, SHARED_CHECK_DIR);
  const sharedFiles = (await exists(shared)) ? await filesUnder(shared) : [];
  const tasks: EvalTask[] = [];
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!e.isDirectory() || e.name === SHARED_CHECK_DIR) continue;
    const taskDir = join(dir, e.name);
    for (const required of ['meta.yaml', 'task.md', 'setup.sh', 'check.sh', 'solution.sh'])
      if (!(await exists(join(taskDir, required))))
        throw new EvalError(`task ${e.name} is missing ${required}`);
    const meta = metaSchema.parse(parseYaml(await readFile(join(taskDir, 'meta.yaml'), 'utf8')));
    if (meta.id !== e.name || meta.category !== category)
      throw new EvalError(`task ${e.name}: meta.yaml id/category don't match its folder`);
    const checkFiles = new Map<string, string>();
    for (const f of sharedFiles) checkFiles.set(posix(relative(shared, f)), f);
    const own = join(taskDir, 'check');
    if (await exists(own))
      for (const f of await filesUnder(own)) checkFiles.set(posix(relative(own, f)), f);
    checkFiles.set('check.sh', join(taskDir, 'check.sh'));
    tasks.push({
      ...meta,
      prompt: (await readFile(join(taskDir, 'task.md'), 'utf8')).trim(),
      dir: taskDir,
      checkFiles,
    });
  }
  if (tasks.length === 0) throw new EvalError(`task set ${category} has no tasks`);
  return {
    category,
    technologies: set.technologies,
    version: `${category}-v${set.version}-${hash.digest('hex').slice(0, 8)}`,
    tasks,
  };
}
