/** Test doubles for the eval harness: a fake driver that returns canned Claude Code JSON. */
import type { EvalDriver, RunOutcome, RunSpec } from './driver.js';
import type { RelayEvent } from './sandbox/relay-script.js';

export interface FakeRunBehaviour {
  success: boolean;
  costUsd: number;
  /** Model reported in `modelUsage` (default: the run's model). */
  model?: string;
  subtype?: string;
  /** Raw stdout instead of the canned JSON (e.g. to simulate unparseable output). */
  stdout?: string;
  relay?: RelayEvent[];
}

/** Canned `claude -p --output-format json` result in the documented shape. */
export function cannedClaudeJson(model: string, costUsd: number, subtype = 'success'): string {
  return JSON.stringify({
    type: 'result',
    subtype,
    is_error: subtype !== 'success',
    num_turns: 5,
    duration_ms: 1000,
    result: 'done',
    total_cost_usd: costUsd,
    usage: { input_tokens: 100, output_tokens: 50 },
    modelUsage: {
      [model]: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: costUsd,
      },
    },
  });
}

export function createFakeDriver(
  behaviour: (spec: RunSpec) => FakeRunBehaviour,
): EvalDriver & { calls: RunSpec[] } {
  const calls: RunSpec[] = [];
  return {
    calls,
    async run(spec): Promise<RunOutcome> {
      calls.push(spec);
      const b = behaviour(spec);
      return {
        setup: { ok: true, output: '' },
        agent: {
          stdout: b.stdout ?? cannedClaudeJson(b.model ?? spec.model, b.costUsd, b.subtype),
          stderr: '',
          exitCode: 0,
          wallSeconds: 12,
          timedOut: false,
        },
        check: { passed: b.success, exitCode: b.success ? 0 : 1, output: '', timedOut: false },
        relay: b.relay ?? [
          { kind: 'api', ts: 1, path: '/v1/messages', model: spec.model, status: 200 },
        ],
        diff: '',
        platform: 'linux/arm64',
      };
    },
  };
}
