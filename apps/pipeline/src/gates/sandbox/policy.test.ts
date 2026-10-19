import { mkdtempSync } from 'node:fs';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertSandboxPolicy,
  buildRunArgs,
  SandboxPolicyError,
  type ContainerSpec,
} from './policy.js';

const IMAGE = 'node:22-bookworm-slim@sha256:' + 'a'.repeat(64);
const policy = { allowedImages: [IMAGE], tempRoot: tmpdir() };
const workDir = mkdtempSync(join(tmpdir(), 'ccsa-sandbox-'));

const spec: ContainerSpec = {
  name: 'ccsa-target-test',
  runId: 'test',
  image: IMAGE,
  network: 'ccsa-net-test',
  workDir,
  env: { HOME: '/work', HTTPS_PROXY: 'http://ccsa-proxy-test:3128' },
  command: ['sh', '-c', 'echo hi'],
  interactive: true,
  detach: false,
  limits: { cpus: 1, memoryMb: 512, pidsLimit: 128 },
  platform: 'linux/amd64' as const,
};
const good = buildRunArgs(spec);

function violations(args: string[]): string[] {
  try {
    assertSandboxPolicy(args, policy);
    return [];
  } catch (e) {
    if (e instanceof SandboxPolicyError) return e.violations;
    throw e;
  }
}
const without = (flag: string, hasValue = true) => {
  const i = good.indexOf(flag);
  const copy = [...good];
  copy.splice(i, hasValue ? 2 : 1);
  return copy;
};
const withExtra = (...extra: string[]) => {
  const copy = [...good];
  copy.splice(1, 0, ...extra);
  return copy;
};
const replaceValue = (flag: string, value: string) =>
  good.map((a, i) => (good[i - 1] === flag ? value : a));

describe('sandbox policy', () => {
  it('accepts the arguments built by buildRunArgs', () => {
    expect(violations(good)).toEqual([]);
  });

  it.each([
    ['--rm', false, /--rm is required/],
    ['--user', true, /non-root --user/],
    ['--cap-drop', true, /--cap-drop ALL/],
    ['--security-opt', true, /no-new-privileges/],
    ['--memory', true, /--memory limit/],
    ['--cpus', true, /--cpus limit/],
    ['--pids-limit', true, /--pids-limit limit/],
    ['--label', true, /--label ccsa.sandbox/],
    ['--network', true, /run-specific/],
    ['--platform', true, /--platform linux/],
  ] as const)('refuses to start without %s', (flag, hasValue, message) => {
    expect(violations(without(flag, hasValue)).join('\n')).toMatch(message);
  });

  it.each([
    ['root user', replaceValue('--user', 'root'), /non-root/],
    ['uid 0', replaceValue('--user', '0:0'), /non-root/],
    ['host network', replaceValue('--network', 'host'), /run-specific/],
    [
      'unpinned image',
      good.map((a) => (a === IMAGE ? 'node:22' : a)),
      /not an allowed pinned image/,
    ],
    [
      'unofficial image',
      good.map((a) => (a === IMAGE ? 'evil/node@sha256:' + 'b'.repeat(64) : a)),
      /not an allowed pinned image/,
    ],
    ['privileged', withExtra('--privileged'), /--privileged is not allowed/],
    ['cap-add', withExtra('--cap-add', 'NET_ADMIN'), /--cap-add is not allowed/],
    ['env file', withExtra('--env-file', '.env'), /--env-file is not allowed/],
    ['--mount', withExtra('--mount', 'type=bind,src=/,dst=/host'), /--mount is not allowed/],
    ['published port', withExtra('-p', '8080:80'), /-p is not allowed/],
    [
      'home folder mount',
      replaceValue('-v', `${process.env['HOME'] ?? '/root'}:/work`),
      /throwaway sandbox temp directory/,
    ],
    [
      'temp root itself',
      replaceValue('-v', `${tmpdir()}:/work`),
      /throwaway sandbox temp directory/,
    ],
    ['second mount', withExtra('-v', `${workDir}:/work`), /at most one mount/],
    ['mount elsewhere', replaceValue('-v', `${workDir}:/etc`), /<temp dir>:\/work/],
    ['host env passthrough', withExtra('-e', 'ANTHROPIC_API_KEY'), /must be NAME=value/],
    ['secret env', withExtra('-e', 'GITHUB_TOKEN=x'), /GITHUB_TOKEN is not allowed/],
    [
      'secret-looking value',
      withExtra('-e', 'HOME=ghp_abcdefghijklmnopqrstuvwxyz0123456789'),
      /looks like a secret/,
    ],
    ['not docker run', ['exec', ...good.slice(1)], /only `docker run`/],
  ])('refuses %s', (_name, args, message) => {
    expect(violations(args).join('\n')).toMatch(message);
  });
});

describe('sandbox boundary', () => {
  it('is the only code (with the eval sandbox) that runs docker or spawns MCP stdio servers', () => {
    const src = fileURLToPath(new URL('../../../../../', import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (['node_modules', 'dist', 'fixtures'].includes(entry)) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) {
          const rel = relative(src, full);
          if (rel.includes(join('gates', 'sandbox'))) continue;
          // The eval harness has its own sandbox module with its own policy (apps/evals/src/sandbox).
          if (rel.startsWith(join('apps', 'evals', 'src', 'sandbox'))) continue;
          // The plugin's verify_setup starts the user's own approved servers on their machine,
          // exactly as Claude Code would; that is not third-party evaluation in the pipeline.
          if (rel === join('apps', 'plugin', 'server', 'verify.ts')) continue;
          const text = readFileSync(full, 'utf8');
          if (
            /StdioClientTransport|spawn\(\s*['"]docker|execFile\w*\(\s*['"]docker|createDockerCli\(\s*['"]/.test(
              text,
            )
          )
            offenders.push(rel);
        }
      }
    };
    walk(join(src, 'apps'));
    walk(join(src, 'packages'));
    expect(offenders).toEqual([]);
  });
});
