import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Logger } from '@cc-setup-agent/core';
import type { DockerCli } from './docker.js';
import {
  assertSandboxPolicy,
  buildRunArgs,
  SANDBOX_LABEL,
  SANDBOX_NETWORK_PREFIX,
  SANDBOX_TEMP_PREFIX,
  type ContainerSpec,
  type SandboxPolicy,
} from './policy.js';
import { PROXY_PORT, PROXY_SCRIPT } from './proxy-script.js';

/** A tool definition as returned by `tools/list`. */
export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
  [key: string]: unknown;
}

export interface EgressEvent {
  host: string;
  port: number;
  at: number;
  /** `install` before the server answered initialize; `runtime` afterwards. */
  phase: 'install' | 'runtime';
}

export interface ProbeResult {
  ok: boolean;
  tools: ToolDefinition[];
  error?: string;
  egress: EgressEvent[];
  stderrTail: string;
  durationMs: number;
}

export interface SandboxRunCommand {
  image: string;
  /** Command run inside the container via `sh -c`; built only from validated values. */
  shell: string;
  /** Files written into the run's temp dir (mounted at /work) before start. */
  files?: Record<string, string>;
}

export interface ProbeOptions {
  policy: SandboxPolicy;
  proxyImage: string;
  installTimeoutMs: number;
  listToolsTimeoutMs: number;
  limits: ContainerSpec['limits'];
  platform: ContainerSpec['platform'];
}

/** Starts a detached container after checking the sandbox policy. */
async function startDetached(
  docker: DockerCli,
  spec: ContainerSpec,
  policy: SandboxPolicy,
): Promise<void> {
  const args = buildRunArgs(spec);
  assertSandboxPolicy(args, policy);
  const r = await docker.exec(args, { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`docker run failed: ${r.stderr.trim().slice(0, 300)}`);
}

/** Removes sandbox containers and networks left behind by crashed runs. */
export async function sweepSandboxes(docker: DockerCli, runId?: string): Promise<void> {
  const filter = `label=${SANDBOX_LABEL}${runId ? `=${runId}` : ''}`;
  const containers = (await docker.exec(['ps', '-aq', '--filter', filter])).stdout
    .split('\n')
    .filter(Boolean);
  if (containers.length > 0) await docker.exec(['rm', '-f', '-v', ...containers]);
  const networks = (await docker.exec(['network', 'ls', '-q', '--filter', filter])).stdout
    .split('\n')
    .filter(Boolean);
  if (networks.length > 0) await docker.exec(['network', 'rm', ...networks]);
}

export function parseEgress(logs: string, initializedAt: number | undefined): EgressEvent[] {
  return logs.split('\n').flatMap((line) => {
    try {
      const o = JSON.parse(line) as { ts?: number; host?: string; port?: number };
      if (typeof o.host !== 'string' || typeof o.ts !== 'number') return [];
      return [
        {
          host: o.host,
          port: o.port ?? 0,
          at: o.ts,
          phase: initializedAt !== undefined && o.ts >= initializedAt ? 'runtime' : 'install',
        },
      ];
    } catch {
      return [];
    }
  });
}

/**
 * Installs and starts an MCP server in a sandbox, connects with the MCP SDK over stdio, lists its
 * tools, and records egress through the logging proxy. Containers, network and temp dir are always
 * removed, also on failure and timeout.
 */
export async function probeMcpServer(
  docker: DockerCli,
  command: SandboxRunCommand,
  options: ProbeOptions,
  logger: Logger,
): Promise<ProbeResult> {
  const started = Date.now();
  const runId = randomBytes(6).toString('hex');
  const network = `${SANDBOX_NETWORK_PREFIX}${runId}`;
  const proxyName = `ccsa-proxy-${runId}`;
  const targetName = `ccsa-target-${runId}`;
  const workDir = await mkdtemp(join(options.policy.tempRoot, SANDBOX_TEMP_PREFIX));
  await chmod(workDir, 0o777);
  for (const [name, content] of Object.entries(command.files ?? {})) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`invalid sandbox file name ${name}`);
    await writeFile(join(workDir, name), content, { mode: 0o644 });
  }
  const proxyUrl = `http://${proxyName}:${PROXY_PORT}`;
  let client: Client | undefined;
  let stderrTail = '';
  let initializedAt: number | undefined;
  let egressLogs: string;
  const result: Omit<ProbeResult, 'egress' | 'stderrTail' | 'durationMs'> = {
    ok: false,
    tools: [],
  };
  let killer: NodeJS.Timeout | undefined;

  try {
    const net = await docker.exec([
      'network',
      'create',
      '--internal',
      '--label',
      `${SANDBOX_LABEL}=${runId}`,
      network,
    ]);
    if (net.code !== 0) throw new Error(`network create failed: ${net.stderr.trim()}`);
    await startDetached(
      docker,
      {
        name: proxyName,
        runId,
        image: options.proxyImage,
        network,
        env: {},
        command: ['node', '-e', PROXY_SCRIPT],
        interactive: false,
        detach: true,
        limits: { cpus: 0.5, memoryMb: 256, pidsLimit: 64 },
        platform: options.platform,
      },
      options.policy,
    );
    // Only the proxy reaches the outside world; the target sits on the internal network alone.
    const connect = await docker.exec(['network', 'connect', 'bridge', proxyName]);
    if (connect.code !== 0)
      throw new Error(`proxy network connect failed: ${connect.stderr.trim()}`);
    await waitForProxy(docker, proxyName);

    const targetArgs = buildRunArgs({
      name: targetName,
      runId,
      image: command.image,
      network,
      workDir,
      env: {
        HOME: '/work',
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        https_proxy: proxyUrl,
        npm_config_cache: '/work/.npm',
        npm_config_update_notifier: 'false',
        npm_config_fund: 'false',
        npm_config_audit: 'false',
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
        PIP_NO_CACHE_DIR: '1',
        PYTHONUSERBASE: '/work/.local',
        UV_CACHE_DIR: '/work/.uv-cache',
        UV_NO_PROGRESS: '1',
      },
      command: ['sh', '-c', command.shell],
      interactive: true,
      detach: false,
      limits: options.limits,
      platform: options.platform,
    });
    assertSandboxPolicy(targetArgs, options.policy);

    const transport = new StdioClientTransport({
      command: 'docker',
      args: targetArgs,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });
    client = new Client({ name: 'cc-setup-agent-gates', version: '0.0.0' });
    const totalMs = options.installTimeoutMs + options.listToolsTimeoutMs + 15_000;
    killer = setTimeout(() => void docker.exec(['rm', '-f', targetName]), totalMs);

    await client.connect(transport, { timeout: options.installTimeoutMs });
    initializedAt = Date.now();
    const tools: ToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, {
        timeout: options.listToolsTimeoutMs,
      });
      tools.push(...(page.tools as ToolDefinition[]));
      cursor = page.nextCursor;
    } while (cursor && tools.length < 1000);
    result.ok = true;
    result.tools = tools;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    logger.info({ runId, error: result.error }, 'sandbox probe failed');
  } finally {
    if (killer) clearTimeout(killer);
    await client?.close().catch(() => undefined);
    egressLogs = (await docker.exec(['logs', proxyName]).catch(() => ({ stdout: '' }))).stdout;
    await docker.exec(['rm', '-f', '-v', targetName, proxyName]).catch(() => undefined);
    await sweepSandboxes(docker, runId).catch((e: unknown) =>
      logger.error({ err: e, runId }, 'sandbox cleanup failed'),
    );
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
  return {
    ...result,
    egress: parseEgress(egressLogs, initializedAt),
    stderrTail,
    durationMs: Date.now() - started,
  };
}

async function waitForProxy(docker: DockerCli, proxyName: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if ((await docker.exec(['logs', proxyName])).stdout.includes('"ready":true')) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('egress proxy did not start');
}

export function defaultTempRoot(): string {
  return tmpdir();
}
