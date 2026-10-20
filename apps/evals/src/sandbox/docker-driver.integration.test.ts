import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createLogger, parseConfig } from '@cc-setup-agent/core';
import { loadTaskSet } from '../tasks.js';
import { createDockerCli } from './docker.js';
import { createDockerDriver } from './docker-driver.js';
import { EVAL_LABEL, PLACEHOLDER_API_KEY } from './policy.js';

// Real Docker, no API calls: a fake `claude` inside the pinned node image (CI sets SANDBOX_TESTS=1).
const enabled = process.env['SANDBOX_TESTS'] === '1';
const config = parseConfig({});
const docker = createDockerCli();
const tasksRoot = fileURLToPath(new URL('../../../../test/fixtures/evals/tasks', import.meta.url));

const limits = {
  maxTurns: 3,
  timeoutSeconds: 60,
  maxBudgetUsd: 0.5,
  setupTimeoutSeconds: 60,
  checkTimeoutSeconds: 60,
  commandTimeoutSeconds: 30,
};
const makeDriver = () =>
  createDockerDriver(
    docker,
    {
      agentImage: config.GATE_NODE_IMAGE,
      relayImage: config.GATE_NODE_IMAGE,
      apiKey: 'test-real-key-never-in-agent',
      apiUpstream: 'https://api.example.invalid',
      allowedModels: config.ALLOWED_MODELS,
      modelFast: config.MODEL_FAST,
      modelStrong: config.MODEL_STRONG,
      egressAllowlist: ['registry.npmjs.org'],
      limits: { cpus: 1, memoryMb: 512, pidsLimit: 256 },
      claudeBinary: '/home/node/fake-claude',
      appDir: '/home/node',
    },
    createLogger({ level: 'silent' }),
  );

describe.runIf(enabled)('eval Docker driver (real Docker, fake claude)', () => {
  it('runs setup, agent and hidden check in isolation, then removes everything', async () => {
    const task = (await loadTaskSet('browser_testing', tasksRoot)).tasks[0]!;
    const driver = makeDriver();
    const runId = `test-${Date.now().toString(36)}`;
    const out = await driver.run({
      runId,
      task,
      tool: { kind: 'none' },
      model: config.MODEL_FAST,
      mode: 'agent',
      limits,
    });
    expect(out.setup.ok).toBe(true);
    expect(out.agent?.exitCode).toBe(0);
    expect(out.check?.passed).toBe(true);
    const seen = JSON.parse(out.check!.output) as Record<string, unknown>;
    expect(seen).toMatchObject({
      key: PLACEHOLDER_API_KEY,
      base: expect.stringMatching(/^http:\/\/ccsa-eval-relay-/),
      opus: config.MODEL_STRONG,
      review: config.MODEL_FAST,
      direct: 'blocked',
      proxy: '403',
    });
    expect(seen['argv']).toEqual(
      expect.arrayContaining([
        '--max-turns',
        '3',
        '--max-budget-usd',
        '0.5',
        '--strict-mcp-config',
      ]),
    );
    expect(out.relay).toContainEqual(
      expect.objectContaining({ kind: 'egress', host: 'evil.example.invalid', allowed: false }),
    );
    const left = await docker.exec(['ps', '-aq', '--filter', `label=${EVAL_LABEL}=${runId}`]);
    expect(left.stdout.trim()).toBe('');
    const nets = await docker.exec([
      'network',
      'ls',
      '-q',
      '--filter',
      `label=${EVAL_LABEL}=${runId}`,
    ]);
    expect(nets.stdout.trim()).toBe('');
  }, 180_000);

  it('installs a whole setup: files in the app, servers in the MCP config, plugins by --plugin-dir', async () => {
    const task = (await loadTaskSet('browser_testing', tasksRoot)).tasks[0]!;
    const out = await makeDriver().run({
      runId: `test-${Date.now().toString(36)}`,
      task,
      tool: {
        kind: 'setup',
        label: 'recommended setup (catalog test)',
        items: [],
        servers: { 'example-mcp-alpha': { command: 'node', args: ['-e', '0'] } },
        prewarm: [['true']],
        files: [
          { path: 'CLAUDE.md', content: Buffer.from('# managed block\n') },
          { path: '.claude/settings.json', content: Buffer.from('{"hooks":{}}\n') },
        ],
        plugins: [
          {
            id: 'example-plugin-gamma',
            files: [
              {
                path: '.claude-plugin/plugin.json',
                content: Buffer.from('{"name":"example-plugin-gamma"}'),
              },
            ],
          },
        ],
      },
      model: config.MODEL_FAST,
      mode: 'agent',
      limits,
    });
    expect(out.setup.ok).toBe(true);
    expect(JSON.parse(out.check!.output)).toMatchObject({
      claudeMd: '# managed block\n',
      settings: '{"hooks":{}}\n',
      mcp: { mcpServers: { 'example-mcp-alpha': { command: 'node', args: ['-e', '0'] } } },
      plugin: '{"name":"example-plugin-gamma"}',
      argv: expect.arrayContaining(['--plugin-dir', '/home/node/.eval-plugins']),
    });
  }, 180_000);
});
