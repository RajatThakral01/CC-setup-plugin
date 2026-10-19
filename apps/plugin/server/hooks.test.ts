import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProjectProfile } from '@cc-setup-agent/shared';
import { hookRecipes, mergeHooks, type HookRecipe } from './hooks.js';

const profile = (tooling: Partial<ProjectProfile['tooling']>, over: Partial<ProjectProfile> = {}) =>
  ({
    packageManager: 'pnpm',
    typescript: true,
    tooling: { formatter: null, linter: null, scripts: [], ...tooling },
    ...over,
  }) as ProjectProfile;

const byId = (recipes: HookRecipe[], id: string) => recipes.find((r) => r.id === id)!;

/** A project folder plus a fake package-manager binary that logs its arguments. */
async function sandbox(bin: string, exitCode: number) {
  const dir = await mkdtemp(join(tmpdir(), 'ccsa-hook-'));
  const binDir = join(dir, 'bin');
  await mkdir(binDir);
  const logFile = join(dir, 'calls.log');
  await writeFile(
    join(binDir, bin),
    `#!/bin/sh\necho "$@" >> "${logFile}"\necho "problem in $*" >&2\nexit ${exitCode}\n`,
  );
  await chmod(join(binDir, bin), 0o755);
  const run = (command: string, input: unknown) =>
    spawnSync('sh', ['-c', command], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env['PATH'] ?? ''}`,
        CLAUDE_PROJECT_DIR: dir,
      },
    });
  const calls = async () => (await readFile(logFile, 'utf8').catch(() => '')).trim();
  return { dir, run, calls };
}

describe('hookRecipes', () => {
  it('offers format, lint and typecheck hooks matching the detected tooling', () => {
    const r = hookRecipes(
      profile({ formatter: 'prettier', linter: 'eslint', scripts: ['lint', 'typecheck'] }),
    );
    expect(r.map((h) => [h.id, h.event, h.matcher])).toEqual([
      ['format-on-edit', 'PostToolUse', 'Edit|Write'],
      ['lint-on-edit', 'PostToolUse', 'Edit|Write'],
      ['typecheck-on-stop', 'Stop', undefined],
    ]);
    expect(byId(r, 'format-on-edit').command).toContain('"pnpm",["exec","prettier","--write"');
    expect(byId(r, 'typecheck-on-stop').command).toContain('"pnpm",["run","typecheck"]');
    for (const h of r) expect(h.command).toMatch(new RegExp(`# setup-agent:${h.id}$`));
  });

  it('uses Biome, npm and tsc when that is what the project has', () => {
    const r = hookRecipes(
      profile({ formatter: 'biome', linter: 'biome' }, { packageManager: 'npm' }),
    );
    expect(byId(r, 'format-on-edit').command).toContain(
      '"npx",["--no-install","biome","format","--write"]',
    );
    expect(byId(r, 'lint-on-edit').command).toContain('"npx",["--no-install","biome","lint"]');
    expect(byId(r, 'typecheck-on-stop').command).toContain(
      '"npx",["--no-install","tsc","--noEmit"]',
    );
  });

  it('offers nothing for a project without a formatter, linter or TypeScript', () => {
    expect(hookRecipes(profile({}, { typescript: false }))).toEqual([]);
  });
});

describe('generated hook commands (run with fake tools)', () => {
  const recipes = hookRecipes(
    profile({ formatter: 'prettier', linter: 'eslint', scripts: ['typecheck'] }),
  );

  it('formats the edited file and ignores files the formatter does not handle', async () => {
    const s = await sandbox('pnpm', 0);
    const cmd = byId(recipes, 'format-on-edit').command;
    const file = join(s.dir, 'app', 'page.tsx');
    expect(s.run(cmd, { tool_name: 'Edit', tool_input: { file_path: file } }).status).toBe(0);
    expect(s.run(cmd, { tool_name: 'Write', tool_input: { file_path: 'x.png' } }).status).toBe(0);
    expect(await s.calls()).toBe(`exec prettier --write --log-level silent ${file}`);
  });

  it('never blocks on a formatter failure', async () => {
    const s = await sandbox('pnpm', 1);
    const r = s.run(byId(recipes, 'format-on-edit').command, {
      tool_input: { file_path: 'a.ts' },
    });
    expect(r.status).toBe(0);
  });

  it('feeds lint errors back to Claude with exit code 2', async () => {
    const s = await sandbox('pnpm', 1);
    const r = s.run(byId(recipes, 'lint-on-edit').command, { tool_input: { file_path: 'a.ts' } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('problem in exec eslint --no-warn-ignored a.ts');
    const clean = await sandbox('pnpm', 0);
    expect(
      clean.run(byId(recipes, 'lint-on-edit').command, { tool_input: { file_path: 'a.ts' } })
        .status,
    ).toBe(0);
  });

  it('type-checks on Stop, but not again while a stop hook is already active', async () => {
    const s = await sandbox('pnpm', 1);
    const cmd = byId(recipes, 'typecheck-on-stop').command;
    expect(s.run(cmd, { hook_event_name: 'Stop', stop_hook_active: true }).status).toBe(0);
    expect(await s.calls()).toBe('');
    const r = s.run(cmd, { hook_event_name: 'Stop', stop_hook_active: false });
    expect(r.status).toBe(2);
    expect(await s.calls()).toBe('run typecheck');
  });
});

describe('mergeHooks', () => {
  const recipes = hookRecipes(
    profile({ formatter: 'prettier', linter: 'eslint', scripts: ['typecheck'] }),
  );
  const userHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] };

  it('appends our groups and never changes existing hooks', () => {
    const existing = { PreToolUse: [userHook], PostToolUse: [userHook] };
    const before = JSON.stringify(existing);
    const r = mergeHooks(existing, recipes);
    expect(JSON.stringify(existing)).toBe(before);
    expect(r.added).toEqual(['format-on-edit', 'lint-on-edit', 'typecheck-on-stop']);
    expect(r.hooks['PreToolUse']).toEqual([userHook]);
    expect((r.hooks['PostToolUse'] as unknown[])[0]).toEqual(userHook);
    expect(r.hooks['PostToolUse']).toHaveLength(3);
  });

  it('is idempotent: a second merge adds nothing', () => {
    const once = mergeHooks(undefined, recipes).hooks;
    const twice = mergeHooks(once, recipes);
    expect(twice.added).toEqual([]);
    expect(twice.hooks).toEqual(once);
    expect(twice.skipped.map((s) => s.reason)).toEqual([
      'already installed',
      'already installed',
      'already installed',
    ]);
  });

  it('skips a recipe when an existing hook already runs the same tool', () => {
    const existing = {
      PostToolUse: [
        { matcher: 'Edit', hooks: [{ type: 'command', command: 'npx prettier --write "$F"' }] },
      ],
    };
    const r = mergeHooks(existing, recipes);
    expect(r.skipped).toEqual([
      { id: 'format-on-edit', reason: 'an existing PostToolUse hook already does this' },
    ]);
    expect(r.added).toEqual(['lint-on-edit', 'typecheck-on-stop']);
  });

  it('leaves malformed hook config alone', () => {
    expect(() => mergeHooks([], recipes)).toThrow(/not an object/);
    const r = mergeHooks({ Stop: 'oops' }, recipes);
    expect(r.hooks['Stop']).toBe('oops');
    expect(r.skipped[0]?.id).toBe('typecheck-on-stop');
  });
});
