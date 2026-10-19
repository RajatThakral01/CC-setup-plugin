import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DockerCli } from './docker.js';
import { checkPythonPlaywright, DOCKERFILE, PYTHON_PLAYWRIGHT_CHECK } from './image.js';

describe('eval image', () => {
  it('pins Python Playwright and installs its Chromium for Python skill helpers', () => {
    const dockerfile = readFileSync(DOCKERFILE, 'utf8');
    expect(dockerfile).toMatch(/^ARG PYTHON_PLAYWRIGHT_VERSION=\d+\.\d+\.\d+$/m);
    expect(dockerfile).toContain(
      'pip install --no-cache-dir "playwright==${PYTHON_PLAYWRIGHT_VERSION}"',
    );
    expect(dockerfile).toContain('/opt/pyenv/bin/python -m playwright install chromium');
    expect(dockerfile).toContain('PATH=/opt/pyenv/bin:$PATH');
  });

  it('checks Python Playwright offline in the image', async () => {
    const calls: string[][] = [];
    const docker = {
      exec: async (args: string[]) => {
        calls.push(args);
        return { code: 0, stdout: 'python-playwright ok\n', stderr: '' };
      },
    } as unknown as DockerCli;
    expect(await checkPythonPlaywright(docker, 'ccsa-eval:abc')).toEqual({
      ok: true,
      output: 'python-playwright ok',
    });
    expect(calls[0]).toEqual([
      'run',
      '--rm',
      '--network',
      'none',
      'ccsa-eval:abc',
      'python',
      '-c',
      PYTHON_PLAYWRIGHT_CHECK,
    ]);
    const failing = {
      exec: async () => ({ code: 1, stdout: '', stderr: 'ModuleNotFoundError: playwright' }),
    } as unknown as DockerCli;
    expect((await checkPythonPlaywright(failing, 'x')).ok).toBe(false);
  });
});
