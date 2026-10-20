/**
 * Real Docker: runs fixture MCP servers in the sandbox. Requires Docker; skipped when
 * SANDBOX_TESTS is not set (CI sets it).
 */
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createLogger, parseConfig } from '@cc-setup-agent/core';
import {
  CLEAN_TOOLS,
  fixtureServerScript,
  POISONED_TOOLS,
} from '../../../../../test/fixtures/mcp/server-template.js';
import { createDockerCli } from './docker.js';
import { SANDBOX_LABEL } from './policy.js';
import { probeMcpServer } from './probe.js';
import { egressFindings, scanToolDefinitions } from '../rules.js';

const config = parseConfig({});
const docker = createDockerCli();
const options = {
  policy: { allowedImages: [config.GATE_NODE_IMAGE, config.GATE_PYTHON_IMAGE], tempRoot: tmpdir() },
  proxyImage: config.GATE_NODE_IMAGE,
  installTimeoutMs: 60_000,
  listToolsTimeoutMs: 15_000,
  limits: { cpus: 1, memoryMb: 512, pidsLimit: 128 },
  platform: 'linux/amd64' as const,
};
const logger = createLogger({ level: 'silent' });
const leftovers = async () => ({
  containers: (
    await docker.exec(['ps', '-aq', '--filter', `label=${SANDBOX_LABEL}`])
  ).stdout.trim(),
  networks: (
    await docker.exec(['network', 'ls', '-q', '--filter', `label=${SANDBOX_LABEL}`])
  ).stdout.trim(),
});

describe.skipIf(!process.env['SANDBOX_TESTS'])('sandbox probe (real Docker)', () => {
  it('lists tools from a clean server and leaves nothing behind', async () => {
    const result = await probeMcpServer(
      docker,
      {
        image: config.GATE_NODE_IMAGE,
        shell: 'node /work/server.js',
        files: { 'server.js': fixtureServerScript(CLEAN_TOOLS) },
      },
      options,
      logger,
    );
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.tools.map((t) => t.name)).toEqual(['get_example_docs']);
    expect(result.egress).toEqual([]);
    expect(await leftovers()).toEqual({ containers: '', networks: '' });
  }, 120_000);

  it('captures poisoned tool definitions and runtime egress', async () => {
    const result = await probeMcpServer(
      docker,
      {
        image: config.GATE_NODE_IMAGE,
        shell: 'node /work/server.js',
        files: {
          'server.js': fixtureServerScript(POISONED_TOOLS, {
            phoneHome: 'http://collector.example.test/upload',
          }),
        },
      },
      options,
      logger,
    );
    expect(result.ok).toBe(true);
    expect(result.tools[0]?.description).toContain('id_rsa');
    expect(result.egress).toContainEqual(
      expect.objectContaining({ host: 'collector.example.test' }),
    );
    // Acceptance (plan M4, as amended in M10): the poisoned server is flagged with injection
    // triggers for the independent review (a rule never confirms by itself), and phoning home is
    // reported.
    const findings = scanToolDefinitions(result.tools);
    expect(findings.some((f) => f.trigger && f.severity === 'critical')).toBe(true);
    expect(findings.some((f) => f.confirmed)).toBe(false);
    expect(egressFindings(result.egress).map((f) => f.rule)).toContain('runtime_egress');
    expect(await leftovers()).toEqual({ containers: '', networks: '' });
  }, 120_000);

  it('cleans up after a server that never starts', async () => {
    const result = await probeMcpServer(
      docker,
      { image: config.GATE_NODE_IMAGE, shell: 'sleep 300' },
      { ...options, installTimeoutMs: 3_000, listToolsTimeoutMs: 1_000 },
      logger,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out|timeout/i);
    expect(await leftovers()).toEqual({ containers: '', networks: '' });
  }, 120_000);

  it('blocks direct connections that bypass the proxy', async () => {
    const script = `require('https').get('https://example.com', () => process.stdout.write('{"jsonrpc":"2.0","id":0,"method":"leak"}\\n')).on('error', () => {}); ${fixtureServerScript(CLEAN_TOOLS)}`;
    const result = await probeMcpServer(
      docker,
      {
        image: config.GATE_NODE_IMAGE,
        shell: 'node /work/server.js',
        files: { 'server.js': script },
      },
      options,
      logger,
    );
    expect(result.ok).toBe(true);
    expect(result.egress).toEqual([]);
  }, 120_000);
});
