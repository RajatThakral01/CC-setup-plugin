import { EvalError } from '../errors.js';

/**
 * Rules for every eval container (plan M9 9.2, NFR-6), enforced on the exact `docker run`
 * arguments by `assertEvalPolicy`, a strict allowlist like the gate sandbox's:
 * - only the built eval image (agent container) or the pinned node image (relay);
 * - no host mounts at all (files go in through `docker exec -i` as the container user);
 * - non-root, all capabilities dropped, no-new-privileges, CPU/memory/pids limits;
 * - one run-specific internal network; only the relay is also attached to the default bridge;
 * - environment from an allowlist; the API key only as a bare `-e ANTHROPIC_API_KEY` (value taken
 *   from the docker CLI's own environment, never on the command line) and only for the relay;
 * - always `--rm`, labelled with the run id, force-removed after the run.
 */
export const EVAL_LABEL = 'ccsa.eval';
export const EVAL_NETWORK_PREFIX = 'ccsa-evalnet-';
export const API_KEY_VAR = 'ANTHROPIC_API_KEY';

export const AGENT_ENV_ALLOWLIST = new Set([
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'ANTHROPIC_BASE_URL',
  // Placeholder only; the relay swaps in the real key.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_AUTOUPDATER',
  'DISABLE_TELEMETRY',
  'DISABLE_ERROR_REPORTING',
  'NEXT_TELEMETRY_DISABLED',
  'CI',
  // Per-command limits inside the agent (M8.3; names verified in the Claude Code 2.1.303 binary).
  'BASH_DEFAULT_TIMEOUT_MS',
  'BASH_MAX_TIMEOUT_MS',
  'MCP_TOOL_TIMEOUT',
]);
export const RELAY_ENV_ALLOWLIST = new Set(['RELAY_UPSTREAM', 'ALLOWED_MODELS', 'ALLOW_HOSTS']);

/** The placeholder key the agent container gets instead of the real one. */
export const PLACEHOLDER_API_KEY = 'eval-placeholder-key-replaced-by-relay';

const SECRET_VALUE =
  /(ghp_|gho_|ghs_|github_pat_|sk-ant-|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-|-----BEGIN)/;

export interface EvalContainerSpec {
  role: 'agent' | 'relay';
  name: string;
  runId: string;
  image: string;
  network: string;
  env: Record<string, string>;
  /** Relay only: receive the API key from the docker CLI's environment. */
  passApiKey?: boolean;
  command: string[];
  limits: { cpus: number; memoryMb: number; pidsLimit: number };
  platform?: 'linux/amd64' | 'linux/arm64';
}

export function buildEvalRunArgs(spec: EvalContainerSpec): string[] {
  const args = [
    'run',
    '-d',
    '--rm',
    '--init',
    '--name',
    spec.name,
    '--label',
    `${EVAL_LABEL}=${spec.runId}`,
    '--network',
    spec.network,
    '--user',
    '1000:1000',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--memory',
    `${spec.limits.memoryMb}m`,
    '--cpus',
    String(spec.limits.cpus),
    '--pids-limit',
    String(spec.limits.pidsLimit),
  ];
  // Chromium needs more shared memory than Docker's 64 MB default.
  if (spec.role === 'agent') args.push('--shm-size', '1g');
  else args.push('--read-only');
  if (spec.platform) args.push('--platform', spec.platform);
  for (const [k, v] of Object.entries(spec.env)) args.push('-e', `${k}=${v}`);
  if (spec.passApiKey) args.push('-e', API_KEY_VAR);
  args.push(spec.image, ...spec.command);
  return args;
}

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
  '--shm-size',
  '--platform',
  '-e',
]);
const BOOLEAN_FLAGS = new Set(['-d', '--rm', '--init', '--read-only']);

/** Throws listing every violated rule. */
export function assertEvalPolicy(
  args: readonly string[],
  policy: { agentImage: string; relayImage: string },
  role: 'agent' | 'relay',
): void {
  const v: string[] = [];
  if (args[0] !== 'run') v.push('only `docker run` may start a container');
  const flags = new Map<string, string[]>();
  let i = 1;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('-')) break;
    if (BOOLEAN_FLAGS.has(a)) flags.set(a, ['']);
    else if (VALUE_FLAGS.has(a)) {
      const value = args[++i];
      if (value === undefined) v.push(`${a} has no value`);
      else flags.set(a, [...(flags.get(a) ?? []), value]);
    } else v.push(`flag ${a} is not allowed`);
  }
  const image = args[i];
  const one = (f: string) => flags.get(f)?.[0];
  const expected = role === 'relay' ? policy.relayImage : policy.agentImage;
  if (image !== expected) v.push(`image ${image ?? '(none)'} is not the ${role} image`);
  if (!flags.has('--rm')) v.push('--rm is required');
  const user = one('--user');
  if (!user || /^(0|root)(:|$)/.test(user)) v.push('a non-root --user is required');
  if (one('--cap-drop') !== 'ALL') v.push('--cap-drop ALL is required');
  if (!flags.get('--security-opt')?.includes('no-new-privileges'))
    v.push('--security-opt no-new-privileges is required');
  for (const f of ['--memory', '--cpus', '--pids-limit'])
    if (!flags.has(f)) v.push(`${f} limit is required`);
  if (!one('--label')?.startsWith(`${EVAL_LABEL}=`))
    v.push(`--label ${EVAL_LABEL}=<run id> is required`);
  if (!one('--network')?.startsWith(EVAL_NETWORK_PREFIX) || flags.get('--network')!.length > 1)
    v.push(`exactly one run-specific ${EVAL_NETWORK_PREFIX}* --network is required`);
  const allow = role === 'relay' ? RELAY_ENV_ALLOWLIST : AGENT_ENV_ALLOWLIST;
  for (const pair of flags.get('-e') ?? []) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      if (!(pair === API_KEY_VAR && role === 'relay'))
        v.push(`env ${pair} must be NAME=value (only the relay may receive ${API_KEY_VAR})`);
      continue;
    }
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (!allow.has(name)) v.push(`env ${name} is not allowed for the ${role} container`);
    else if (SECRET_VALUE.test(value)) v.push(`env ${name} looks like a secret`);
    else if (name === API_KEY_VAR && value !== PLACEHOLDER_API_KEY)
      v.push(`${API_KEY_VAR} in the agent container must be the placeholder`);
  }
  if (v.length > 0) throw new EvalError(`Eval sandbox policy violated: ${v.join('; ')}`);
}
