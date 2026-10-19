import { describe, expect, it } from 'vitest';
import {
  assertEvalPolicy,
  buildEvalRunArgs,
  PLACEHOLDER_API_KEY,
  type EvalContainerSpec,
} from './policy.js';

const images = { agentImage: 'ccsa-eval:abc', relayImage: 'node:22@sha256:' + 'a'.repeat(64) };
const agent: EvalContainerSpec = {
  role: 'agent',
  name: 'ccsa-eval-agent-x',
  runId: 'x',
  image: images.agentImage,
  network: 'ccsa-evalnet-x',
  env: { HOME: '/home/node', ANTHROPIC_API_KEY: PLACEHOLDER_API_KEY },
  command: ['sleep', 'infinity'],
  limits: { cpus: 2, memoryMb: 4096, pidsLimit: 2048 },
};
const relay: EvalContainerSpec = {
  ...agent,
  role: 'relay',
  name: 'ccsa-eval-relay-x',
  image: images.relayImage,
  env: { RELAY_UPSTREAM: 'https://api.example.invalid' },
  passApiKey: true,
  command: ['node', '-e', 'x'],
};

const violations = (args: string[], role: 'agent' | 'relay') => {
  try {
    assertEvalPolicy(args, images, role);
    return '';
  } catch (e) {
    return (e as Error).message;
  }
};

describe('eval sandbox policy', () => {
  it('accepts the agent and relay containers as built', () => {
    expect(violations(buildEvalRunArgs(agent), 'agent')).toBe('');
    expect(violations(buildEvalRunArgs(relay), 'relay')).toBe('');
  });

  it('passes the real key only as a bare name, never as a value', () => {
    const args = buildEvalRunArgs(relay);
    expect(args).toContain('ANTHROPIC_API_KEY');
    expect(args.join(' ')).not.toMatch(/ANTHROPIC_API_KEY=/);
  });

  it.each([
    ['a host mount', (a: string[]) => [a[0]!, '-v', '/:/host', ...a.slice(1)]],
    ['privileged', (a: string[]) => [a[0]!, '--privileged', ...a.slice(1)]],
    ['host network', (a: string[]) => a.map((x) => (x === 'ccsa-evalnet-x' ? 'host' : x))],
    ['root user', (a: string[]) => a.map((x) => (x === '1000:1000' ? '0:0' : x))],
    ['no --rm', (a: string[]) => a.filter((x) => x !== '--rm')],
    [
      'no memory limit',
      (a: string[]) => a.filter((x, i) => x !== '--memory' && a[i - 1] !== '--memory'),
    ],
    [
      'another image',
      (a: string[]) => a.map((x) => (x === images.agentImage ? 'ubuntu:latest' : x)),
    ],
    ['an env file', (a: string[]) => [a[0]!, '--env-file', '.env', ...a.slice(1)]],
  ])('refuses %s', (_name, mutate) => {
    expect(violations(mutate(buildEvalRunArgs(agent)), 'agent')).toMatch(/policy violated/);
  });

  it('never lets the agent container hold a real key', () => {
    const real = buildEvalRunArgs({
      ...agent,
      env: { ANTHROPIC_API_KEY: 'sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxx' },
    });
    expect(violations(real, 'agent')).toMatch(/looks like a secret/);
    const other = buildEvalRunArgs({ ...agent, env: { ANTHROPIC_API_KEY: 'anything-else' } });
    expect(violations(other, 'agent')).toMatch(/must be the placeholder/);
    const bare = buildEvalRunArgs({ ...agent, passApiKey: true });
    expect(violations(bare, 'agent')).toMatch(/only the relay may receive ANTHROPIC_API_KEY/);
  });

  it('refuses environment variables outside the role allowlist', () => {
    const args = buildEvalRunArgs({ ...agent, env: { GITHUB_TOKEN: 'x' } });
    expect(violations(args, 'agent')).toMatch(/GITHUB_TOKEN is not allowed/);
    expect(violations(buildEvalRunArgs({ ...relay, env: { HOME: '/' } }), 'relay')).toMatch(
      /HOME is not allowed for the relay/,
    );
  });
});
