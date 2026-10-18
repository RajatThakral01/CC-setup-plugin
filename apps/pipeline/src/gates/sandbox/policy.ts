import { realpathSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { AppError } from '@cc-setup-agent/core';

/**
 * Sandbox rules for every container that runs third-party code (owner decision 2026-10-19):
 * pinned official node/python images, no host folders except one throwaway temp dir, no secrets,
 * non-root user, all capabilities dropped, CPU/memory/pids limits, run-specific internal network,
 * always removed. `assertSandboxPolicy` enforces them on the exact `docker run` arguments.
 */

export const SANDBOX_LABEL = 'ccsa.sandbox';
export const SANDBOX_NETWORK_PREFIX = 'ccsa-net-';
export const SANDBOX_TEMP_PREFIX = 'ccsa-sandbox-';
export const CONTAINER_WORKDIR = '/work';

/** Environment variables a sandboxed container may receive. Nothing else, and never secrets. */
export const ENV_ALLOWLIST = new Set([
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'npm_config_cache',
  'npm_config_update_notifier',
  'npm_config_fund',
  'npm_config_audit',
  'PIP_DISABLE_PIP_VERSION_CHECK',
  'PIP_NO_CACHE_DIR',
  'PYTHONUSERBASE',
  'UV_CACHE_DIR',
  'UV_NO_PROGRESS',
]);

/** Values that look like credentials are refused even under an allowed name. */
const SECRET_VALUE =
  /(ghp_|gho_|ghs_|github_pat_|sk-ant-|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-|-----BEGIN)/;

const VALUE_FLAGS = new Set([
  '--name',
  '--label',
  '--network',
  '--user',
  '--cap-drop',
  '--security-opt',
  '--memory',
  '--cpus',
  '--pids-limit',
  '--tmpfs',
  '-v',
  '-w',
  '-e',
  '--stop-timeout',
  '--platform',
]);
const BOOLEAN_FLAGS = new Set(['--rm', '-i', '-d', '--read-only']);

export class SandboxPolicyError extends AppError {
  constructor(readonly violations: string[]) {
    super(`Sandbox policy violated: ${violations.join('; ')}`);
  }
}

export interface SandboxPolicy {
  /** Exact image references allowed (configured, digest-pinned). */
  allowedImages: readonly string[];
  /** Directory throwaway run folders are created under (os.tmpdir()). */
  tempRoot: string;
}

export interface ContainerSpec {
  name: string;
  runId: string;
  image: string;
  network: string;
  /** Host temp dir mounted at /work, or none. */
  workDir?: string;
  env: Record<string, string>;
  command: string[];
  interactive: boolean;
  detach: boolean;
  limits: { cpus: number; memoryMb: number; pidsLimit: number };
  platform: 'linux/amd64' | 'linux/arm64';
}

/** The only way `docker run` arguments are built. */
export function buildRunArgs(spec: ContainerSpec): string[] {
  const args = ['run', '--rm'];
  if (spec.interactive) args.push('-i');
  if (spec.detach) args.push('-d');
  args.push(
    '--name',
    spec.name,
    '--label',
    `${SANDBOX_LABEL}=${spec.runId}`,
    '--network',
    spec.network,
    '--user',
    '1000:1000',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '--memory',
    `${spec.limits.memoryMb}m`,
    '--cpus',
    String(spec.limits.cpus),
    '--pids-limit',
    String(spec.limits.pidsLimit),
    '--stop-timeout',
    '5',
    '--platform',
    spec.platform,
  );
  if (spec.workDir)
    args.push('-v', `${spec.workDir}:${CONTAINER_WORKDIR}`, '-w', CONTAINER_WORKDIR);
  for (const [key, value] of Object.entries(spec.env)) args.push('-e', `${key}=${value}`);
  args.push(spec.image, ...spec.command);
  return args;
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Throws SandboxPolicyError listing every violated rule. */
export function assertSandboxPolicy(args: readonly string[], policy: SandboxPolicy): void {
  const v: string[] = [];
  if (args[0] !== 'run') v.push('only `docker run` may start a container');
  const flags = new Map<string, string[]>();
  let i = 1;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('-')) break;
    if (BOOLEAN_FLAGS.has(a)) {
      flags.set(a, ['']);
    } else if (VALUE_FLAGS.has(a)) {
      const value = args[++i];
      if (value === undefined) v.push(`${a} has no value`);
      else flags.set(a, [...(flags.get(a) ?? []), value]);
    } else {
      // Covers --privileged, --cap-add, --device, --mount, --env-file, --network=host, -p, …
      v.push(`flag ${a} is not allowed`);
    }
  }
  const image = args[i];
  const one = (f: string) => flags.get(f)?.[0];

  if (!flags.has('--rm')) v.push('--rm is required');
  if (!image || !policy.allowedImages.includes(image))
    v.push(`image ${image ?? '(none)'} is not an allowed pinned image`);
  const user = one('--user');
  if (!user || /^(0|root)(:|$)/.test(user)) v.push('a non-root --user is required');
  if (one('--cap-drop') !== 'ALL') v.push('--cap-drop ALL is required');
  if (!flags.get('--security-opt')?.includes('no-new-privileges'))
    v.push('--security-opt no-new-privileges is required');
  for (const f of ['--memory', '--cpus', '--pids-limit'])
    if (!flags.has(f)) v.push(`${f} limit is required`);
  if (!one('--label')?.startsWith(`${SANDBOX_LABEL}=`))
    v.push(`--label ${SANDBOX_LABEL}=<run id> is required`);
  if (!one('--network')?.startsWith(SANDBOX_NETWORK_PREFIX))
    v.push(`--network must be a run-specific ${SANDBOX_NETWORK_PREFIX}* network`);
  if ((flags.get('--network')?.length ?? 0) > 1) v.push('only one --network is allowed');

  const volumes = flags.get('-v') ?? [];
  if (volumes.length > 1) v.push('at most one mount is allowed');
  for (const vol of volumes) {
    const [host, target, ...rest] = vol.split(':');
    const root = safeRealpath(policy.tempRoot);
    const real = host ? safeRealpath(host) : '';
    if (rest.length > 0 || target !== CONTAINER_WORKDIR)
      v.push(`mount must be <temp dir>:${CONTAINER_WORKDIR}`);
    if (!host || !(real.startsWith(root + sep) && basename(real).startsWith(SANDBOX_TEMP_PREFIX))) {
      v.push('only a throwaway sandbox temp directory may be mounted');
    }
  }
  for (const pair of flags.get('-e') ?? []) {
    const eq = pair.indexOf('=');
    // `-e NAME` without a value would copy the host's variable into the container.
    if (eq <= 0) v.push(`env ${pair} must be NAME=value`);
    else if (!ENV_ALLOWLIST.has(pair.slice(0, eq)))
      v.push(`env ${pair.slice(0, eq)} is not allowed`);
    else if (SECRET_VALUE.test(pair.slice(eq + 1)))
      v.push(`env ${pair.slice(0, eq)} looks like a secret`);
  }
  const platform = one('--platform');
  if (platform !== 'linux/amd64' && platform !== 'linux/arm64')
    v.push('--platform linux/amd64 or linux/arm64 is required');
  if (v.length > 0) throw new SandboxPolicyError(v);
}
