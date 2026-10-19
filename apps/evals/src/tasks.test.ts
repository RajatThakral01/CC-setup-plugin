import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TASKS_ROOT, loadTaskSet } from './tasks.js';

describe('browser_testing task set', () => {
  it('has five tasks, each with a prompt and hidden check files', async () => {
    const set = await loadTaskSet('browser_testing');
    expect(set.tasks.map((t) => t.id)).toEqual([
      'contact-e2e-test',
      'contact-form-submit',
      'counter-increment',
      'nav-about-link',
      'product-search',
    ]);
    expect(set.version).toMatch(/^browser_testing-v1-[0-9a-f]{8}$/);
    for (const t of set.tasks) {
      expect(t.prompt.length).toBeGreaterThan(50);
      expect([...t.checkFiles.keys()]).toEqual(
        expect.arrayContaining(['check.sh', 'playwright.config.ts', 'stop-servers.sh']),
      );
      // Prompts never leak the check files.
      expect(t.prompt).not.toMatch(/\.check\.ts|eval-check/);
    }
  });

  it('changes the version when any task file changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccsa-tasks-'));
    await cp(join(DEFAULT_TASKS_ROOT, 'browser_testing'), join(root, 'browser_testing'), {
      recursive: true,
    });
    const before = (await loadTaskSet('browser_testing', root)).version;
    await writeFile(
      join(root, 'browser_testing', 'counter-increment', 'task.md'),
      'changed prompt',
    );
    expect((await loadTaskSet('browser_testing', root)).version).not.toBe(before);
  });

  it('refuses a category without a task set', async () => {
    await expect(loadTaskSet('cms')).rejects.toThrow(/no task set for category cms/);
  });
});
