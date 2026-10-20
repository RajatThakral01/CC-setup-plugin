import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@cc-setup-agent/core';
import {
  buildClaudeArgs,
  mcpConfigFor,
  MCP_CONFIG_PATH,
  PLUGINS_DIR,
  type EvalDriver,
  type RunOutcome,
  type RunSpec,
} from '../driver.js';
import { EvalError } from '../errors.js';
import type { DockerCli } from './docker.js';
import {
  API_KEY_VAR,
  assertEvalPolicy,
  buildEvalRunArgs,
  EVAL_LABEL,
  EVAL_NETWORK_PREFIX,
  PLACEHOLDER_API_KEY,
  type EvalContainerSpec,
} from './policy.js';
import { parseRelayLog, PROXY_PORT, RELAY_PORT, RELAY_SCRIPT } from './relay-script.js';

export const APP_DIR = '/home/node/app';
const MAX_DIFF = 200_000;

export interface DockerDriverOptions {
  agentImage: string;
  relayImage: string;
  /** Real API key; handed only to the relay container, and only for `agent` runs. */
  apiKey: string | undefined;
  apiUpstream: string;
  allowedModels: string[];
  modelFast: string;
  modelStrong: string;
  egressAllowlist: string[];
  limits: EvalContainerSpec['limits'];
  platform?: EvalContainerSpec['platform'];
  /** Binary run for `agent` mode (the real `claude`; tests use a fake). */
  claudeBinary?: string;
  /** The fixture app inside the image (default APP_DIR). */
  appDir?: string;
}

/** Writes a file into the container as the container user (no host mounts). */
const WRITE_JS =
  "const fs=require('fs'),p=require('path');fs.mkdirSync(p.dirname(process.argv[1]),{recursive:true});fs.writeFileSync(process.argv[1],fs.readFileSync(0));fs.chmodSync(process.argv[1],parseInt(process.argv[2],8));";

/** Removes eval containers and networks left behind by crashed runs. */
export async function sweepEvalContainers(docker: DockerCli, runId?: string): Promise<void> {
  const filter = `label=${EVAL_LABEL}${runId ? `=${runId}` : ''}`;
  const ids = (await docker.exec(['ps', '-aq', '--filter', filter])).stdout
    .split('\n')
    .filter(Boolean);
  if (ids.length > 0) await docker.exec(['rm', '-f', '-v', ...ids]);
  const nets = (await docker.exec(['network', 'ls', '-q', '--filter', filter])).stdout
    .split('\n')
    .filter(Boolean);
  if (nets.length > 0) await docker.exec(['network', 'rm', ...nets]);
}

export function createDockerDriver(
  docker: DockerCli,
  options: DockerDriverOptions,
  logger: Logger,
): EvalDriver {
  const policy = { agentImage: options.agentImage, relayImage: options.relayImage };
  const appDir = options.appDir ?? APP_DIR;
  const checkDir = `${appDir}/.eval-check`;

  const start = async (spec: EvalContainerSpec, env?: Record<string, string>) => {
    const args = buildEvalRunArgs(spec);
    assertEvalPolicy(args, policy, spec.role);
    const r = await docker.exec(args, { timeoutMs: 120_000, ...(env ? { env } : {}) });
    if (r.code !== 0) throw new EvalError(`docker run failed: ${r.stderr.trim().slice(0, 300)}`);
  };

  return {
    async run(spec: RunSpec): Promise<RunOutcome> {
      if (!/^[a-z0-9-]{6,64}$/.test(spec.runId)) throw new EvalError('invalid run id');
      const id = spec.runId;
      const network = `${EVAL_NETWORK_PREFIX}${id}`;
      const relay = `ccsa-eval-relay-${id}`;
      const agent = `ccsa-eval-agent-${id}`;
      const exec = (argv: string[], timeoutSeconds: number, input?: Buffer | string) =>
        docker.exec(
          ['exec', ...(input !== undefined ? ['-i'] : []), '-w', appDir, agent, ...argv],
          { timeoutMs: timeoutSeconds * 1000, ...(input !== undefined ? { input } : {}) },
        );
      const put = async (path: string, content: Buffer | string, mode = '644') => {
        const r = await exec(['node', '-e', WRITE_JS, path, mode], 60, content);
        if (r.code !== 0) throw new EvalError(`writing ${path} failed: ${r.stderr.trim()}`);
      };
      const out: RunOutcome = {
        setup: { ok: false, output: '' },
        agent: null,
        check: null,
        relay: [],
        diff: '',
        platform: null,
      };
      try {
        const net = await docker.exec([
          'network',
          'create',
          '--internal',
          '--label',
          `${EVAL_LABEL}=${id}`,
          network,
        ]);
        if (net.code !== 0) throw new EvalError(`network create failed: ${net.stderr.trim()}`);
        const giveKey = spec.mode === 'agent';
        if (giveKey && !options.apiKey) throw new EvalError(`${API_KEY_VAR} is not set`);
        await start(
          {
            role: 'relay',
            name: relay,
            runId: id,
            image: options.relayImage,
            network,
            env: {
              RELAY_UPSTREAM: options.apiUpstream,
              ALLOWED_MODELS: options.allowedModels.join(','),
              ALLOW_HOSTS: options.egressAllowlist.join(','),
            },
            passApiKey: giveKey,
            command: ['node', '-e', RELAY_SCRIPT],
            limits: { cpus: 0.5, memoryMb: 256, pidsLimit: 64 },
            ...(options.platform ? { platform: options.platform } : {}),
          },
          giveKey ? { [API_KEY_VAR]: options.apiKey! } : undefined,
        );
        const connect = await docker.exec(['network', 'connect', 'bridge', relay]);
        if (connect.code !== 0)
          throw new EvalError(`relay network connect failed: ${connect.stderr.trim()}`);
        await waitForRelay(docker, relay);

        const proxyUrl = `http://${relay}:${PROXY_PORT}`;
        const noProxy = `localhost,127.0.0.1,::1,${relay}`;
        await start({
          role: 'agent',
          name: agent,
          runId: id,
          image: options.agentImage,
          network,
          env: {
            HOME: '/home/node',
            HTTP_PROXY: proxyUrl,
            HTTPS_PROXY: proxyUrl,
            http_proxy: proxyUrl,
            https_proxy: proxyUrl,
            NO_PROXY: noProxy,
            no_proxy: noProxy,
            ANTHROPIC_BASE_URL: `http://${relay}:${RELAY_PORT}`,
            ANTHROPIC_API_KEY: PLACEHOLDER_API_KEY,
            // Every model alias resolves to an allowed model (the relay refuses anything else).
            ANTHROPIC_DEFAULT_OPUS_MODEL: options.modelStrong,
            ANTHROPIC_DEFAULT_FABLE_MODEL: options.modelStrong,
            ANTHROPIC_DEFAULT_SONNET_MODEL: options.modelStrong,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: options.modelFast,
            CLAUDE_CODE_SUBAGENT_MODEL: spec.model,
            // The official security-guidance plugin reviews with a hard-coded Opus model, which the
            // relay refuses; its documented override points it at the run's own model (M10).
            SECURITY_REVIEW_MODEL: spec.model,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            DISABLE_AUTOUPDATER: '1',
            DISABLE_TELEMETRY: '1',
            DISABLE_ERROR_REPORTING: '1',
            NEXT_TELEMETRY_DISABLED: '1',
            // One hung command (a foreground server, a long test run) can't eat the run: Bash
            // and MCP tool calls stop at the command limit and the agent gets the error back.
            BASH_DEFAULT_TIMEOUT_MS: String(spec.limits.commandTimeoutSeconds * 1000),
            BASH_MAX_TIMEOUT_MS: String(spec.limits.commandTimeoutSeconds * 1000),
            MCP_TOOL_TIMEOUT: String(spec.limits.commandTimeoutSeconds * 1000),
          },
          command: ['sleep', 'infinity'],
          limits: options.limits,
          ...(options.platform ? { platform: options.platform } : {}),
        });

        await put('/home/node/.eval/setup.sh', await readFile(join(spec.task.dir, 'setup.sh')));
        const setup = await exec(
          ['bash', '/home/node/.eval/setup.sh'],
          spec.limits.setupTimeoutSeconds,
        );
        out.setup = { ok: setup.code === 0, output: tail(setup.stdout + setup.stderr) };
        if (!out.setup.ok) return out;

        await put(MCP_CONFIG_PATH, mcpConfigFor(spec.tool));
        if (spec.tool.kind === 'mcp') {
          for (const argv of spec.tool.prewarm) {
            const r = await exec(argv, spec.limits.setupTimeoutSeconds);
            if (r.code !== 0) {
              out.setup = { ok: false, output: tail(`tool prewarm failed: ${r.stderr}`) };
              return out;
            }
          }
        } else if (spec.tool.kind === 'skill') {
          const name = spec.tool.item.id;
          for (const f of spec.tool.files)
            await put(`${appDir}/.claude/skills/${name}/${f.path}`, f.content);
        } else if (spec.tool.kind === 'plugin') {
          for (const f of spec.tool.files)
            await put(`${PLUGINS_DIR}/${spec.tool.item.id}/${f.path}`, f.content);
        } else if (spec.tool.kind === 'setup') {
          for (const argv of spec.tool.prewarm) {
            const r = await exec(argv, spec.limits.setupTimeoutSeconds);
            if (r.code !== 0) {
              out.setup = { ok: false, output: tail(`tool prewarm failed: ${r.stderr}`) };
              return out;
            }
          }
          for (const f of spec.tool.files) await put(`${appDir}/${f.path}`, f.content);
          for (const p of spec.tool.plugins)
            for (const f of p.files) await put(`${PLUGINS_DIR}/${p.id}/${f.path}`, f.content);
        }

        if (spec.mode === 'agent') {
          const started = Date.now();
          const r = await exec(
            [options.claudeBinary ?? 'claude', ...buildClaudeArgs(spec)],
            spec.limits.timeoutSeconds,
          );
          out.agent = {
            stdout: r.stdout,
            stderr: tail(r.stderr),
            exitCode: r.code,
            wallSeconds: (Date.now() - started) / 1000,
            timedOut: r.timedOut,
          };
          // Stop anything the agent left running before the hidden check starts.
          await exec(['pkill', '-f', 'bin/claude'], 30);
        } else if (spec.mode === 'solution') {
          await put(
            '/home/node/.eval/solution.sh',
            await readFile(join(spec.task.dir, 'solution.sh')),
          );
          const r = await exec(
            ['bash', '/home/node/.eval/solution.sh'],
            spec.limits.setupTimeoutSeconds,
          );
          if (r.code !== 0) {
            out.setup = { ok: false, output: tail(`solution failed: ${r.stderr}`) };
            return out;
          }
        }

        // Hidden checks go in only now, so the agent never saw them.
        for (const [rel, abs] of spec.task.checkFiles)
          await put(`${checkDir}/${rel}`, await readFile(abs), rel.endsWith('.sh') ? '755' : '644');
        const check = await exec(['bash', `${checkDir}/check.sh`], spec.limits.checkTimeoutSeconds);
        out.check = {
          passed: check.code === 0 && !check.timedOut,
          exitCode: check.code,
          output: tail(check.stdout + check.stderr),
          timedOut: check.timedOut,
        };
        const diff = await exec(
          [
            'bash',
            '-c',
            "git add -A -N . && git diff -- . ':(exclude).eval-check' ':(exclude).claude' ':(exclude)test-results' ':(exclude).next'",
          ],
          60,
        );
        out.diff = diff.stdout.slice(0, MAX_DIFF);
        return out;
      } finally {
        const logs = await docker.exec(['logs', relay]).catch(() => null);
        if (logs) out.relay = parseRelayLog(logs.stdout);
        const platform = await docker
          .exec(['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', options.agentImage])
          .catch(() => null);
        out.platform = platform?.code === 0 ? platform.stdout.trim() : null;
        await docker.exec(['rm', '-f', '-v', agent, relay]).catch(() => undefined);
        await docker.exec(['network', 'rm', network]).catch(() => undefined);
        await sweepEvalContainers(docker, id).catch((error: unknown) =>
          logger.warn({ error: String(error), runId: id }, 'eval cleanup sweep failed'),
        );
      }
    },
  };
}

function tail(text: string, max = 20_000): string {
  return text.length > max ? text.slice(-max) : text;
}

async function waitForRelay(docker: DockerCli, name: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const r = await docker.exec(['logs', name]);
    if (r.stdout.includes('"ready":"relay"') && r.stdout.includes('"ready":"proxy"')) return;
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new EvalError('eval relay did not start');
}
