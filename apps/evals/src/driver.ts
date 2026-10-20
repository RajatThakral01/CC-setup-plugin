import type { RelayEvent } from './sandbox/relay-script.js';
import type { EvalTask } from './tasks.js';
import type { ToolSetup } from './tools.js';

/** `agent`: Claude Code solves the task. `solution`/`none`: harness self-test, no API calls. */
export type RunMode = 'agent' | 'solution' | 'none';

export interface RunLimits {
  maxTurns: number;
  timeoutSeconds: number;
  /** Passed to `claude --max-budget-usd`. */
  maxBudgetUsd: number;
  setupTimeoutSeconds: number;
  checkTimeoutSeconds: number;
  /**
   * Wall-clock limit for any single Bash command or MCP tool call inside the agent (M8.3): the model
   * may otherwise ask for up to 600 s per command, longer than the whole run.
   */
  commandTimeoutSeconds: number;
}

export interface RunSpec {
  runId: string;
  task: EvalTask;
  tool: ToolSetup;
  model: string;
  mode: RunMode;
  limits: RunLimits;
}

export interface RunOutcome {
  setup: { ok: boolean; output: string };
  agent: {
    stdout: string;
    stderr: string;
    exitCode: number;
    wallSeconds: number;
    timedOut: boolean;
  } | null;
  check: { passed: boolean; exitCode: number; output: string; timedOut: boolean } | null;
  relay: RelayEvent[];
  /** `git diff` of the app after the run (task changes only; hidden checks excluded). */
  diff: string;
  platform: string | null;
}

/** Runs one task in a fresh, isolated environment and always cleans up after itself. */
export interface EvalDriver {
  run(spec: RunSpec): Promise<RunOutcome>;
}

export const MCP_CONFIG_PATH = '/home/node/.eval/mcp.json';

/**
 * Headless Claude Code arguments (verified for 2.1.303: `claude --help`, plus `--max-turns`,
 * which is defined but hidden from help). Strict MCP config, so only the tool under test loads.
 */
export function buildClaudeArgs(spec: RunSpec): string[] {
  return [
    '-p',
    spec.task.prompt,
    '--model',
    spec.model,
    '--max-turns',
    String(spec.limits.maxTurns),
    '--max-budget-usd',
    String(spec.limits.maxBudgetUsd),
    // stream-json (needs --verbose in print mode, verified in the 2.1.303 binary): the transcript
    // is written as it happens, so a run killed at the timeout still shows its last tool calls.
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--mcp-config',
    MCP_CONFIG_PATH,
  ];
}

/** The `--mcp-config` file content: only the tool under test (or nothing for a baseline). */
export function mcpConfigFor(tool: ToolSetup): string {
  const servers = tool.kind === 'mcp' ? { [tool.item.id]: tool.server } : {};
  return `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
}
