import { z } from 'zod';
import type { TokenUsage } from '@cc-setup-agent/shared';

/**
 * `claude -p --output-format json` result (docs: headless; field names confirmed in the 2.1.303
 * binary: `num_turns`, `is_error`, `total_cost_usd`, `modelUsage`, subtypes `success`,
 * `error_max_turns`, `error_max_budget_usd`). Parsed leniently: unknown fields are kept, missing
 * optional fields default, so a CLI update doesn't lose the cost of a run.
 */
const modelUsageSchema = z.looseObject({
  inputTokens: z.number().nonnegative().default(0),
  outputTokens: z.number().nonnegative().default(0),
  cacheReadInputTokens: z.number().nonnegative().default(0),
  cacheCreationInputTokens: z.number().nonnegative().default(0),
  costUSD: z.number().nonnegative().optional(),
});
export const claudeResultSchema = z.looseObject({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean().default(false),
  num_turns: z.number().int().nonnegative().optional(),
  duration_ms: z.number().nonnegative().optional(),
  result: z.string().optional(),
  total_cost_usd: z.number().nonnegative().optional(),
  usage: z
    .looseObject({
      input_tokens: z.number().nonnegative().default(0),
      output_tokens: z.number().nonnegative().default(0),
      cache_creation_input_tokens: z.number().nonnegative().default(0),
      cache_read_input_tokens: z.number().nonnegative().default(0),
    })
    .optional(),
  modelUsage: z.record(z.string(), modelUsageSchema).optional(),
});

export interface ModelSpend {
  model: string;
  usage: TokenUsage;
  /** Cost reported by Claude Code for this model, when given. */
  costUsd: number | undefined;
}

export interface ClaudeRunResult {
  /** Claude Code finished normally (not an error, max-turns or max-budget stop). */
  completed: boolean;
  subtype: string;
  numTurns: number | null;
  totalCostUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  /** Per-model usage for the budget ledger. */
  spend: ModelSpend[];
}

const toUsage = (u: z.output<typeof modelUsageSchema>): TokenUsage => ({
  inputTokens: u.inputTokens,
  outputTokens: u.outputTokens,
  cacheWrite5mTokens: u.cacheCreationInputTokens,
  cacheWrite1hTokens: 0,
  cacheReadTokens: u.cacheReadInputTokens,
});

const jsonLines = (stdout: string): unknown[] =>
  stdout.split('\n').flatMap((line) => {
    const t = line.trim();
    if (!t.startsWith('{')) return [];
    try {
      return [JSON.parse(t) as unknown];
    } catch {
      return [];
    }
  });

/**
 * The run's result: the `result` line of `--output-format stream-json` (M8.3), or the single
 * object of `--output-format json`. Null when the run was killed before Claude Code wrote it.
 */
export function parseClaudeOutput(stdout: string, fallbackModel: string): ClaudeRunResult | null {
  let raw: unknown = [...jsonLines(stdout)]
    .reverse()
    .find((o) => (o as { type?: unknown } | null)?.type === 'result');
  if (raw === undefined) {
    const start = stdout.indexOf('{');
    if (start === -1) return null;
    try {
      raw = JSON.parse(stdout.slice(start));
    } catch {
      return null;
    }
  }
  const parsed = claudeResultSchema.safeParse(raw);
  if (!parsed.success) return null;
  const r = parsed.data;
  let spend: ModelSpend[];
  if (r.modelUsage && Object.keys(r.modelUsage).length > 0) {
    spend = Object.entries(r.modelUsage)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([model, u]) => ({ model, usage: toUsage(u), costUsd: u.costUSD }));
  } else {
    const u = r.usage;
    spend = [
      {
        model: fallbackModel,
        usage: {
          inputTokens: u?.input_tokens ?? 0,
          outputTokens: u?.output_tokens ?? 0,
          cacheWrite5mTokens: u?.cache_creation_input_tokens ?? 0,
          cacheWrite1hTokens: 0,
          cacheReadTokens: u?.cache_read_input_tokens ?? 0,
        },
        costUsd: r.total_cost_usd,
      },
    ];
  }
  const sum = (f: (u: TokenUsage) => number) => spend.reduce((s, m) => s + f(m.usage), 0);
  return {
    completed: r.subtype === 'success' && !r.is_error,
    subtype: r.subtype,
    numTurns: r.num_turns ?? null,
    totalCostUsd: r.total_cost_usd ?? null,
    inputTokens: sum((u) => u.inputTokens + u.cacheWrite5mTokens + u.cacheReadTokens),
    outputTokens: sum((u) => u.outputTokens),
    spend,
  };
}

export interface ToolCall {
  name: string;
  /** The call's input, as JSON, cut to 300 characters. */
  input: string;
  /** No tool result came back before the transcript ended (the agent was killed during it). */
  pending: boolean;
}

/**
 * The last tool calls in a stream-json transcript, oldest first (M8.3: timeout diagnosis). A call
 * without a matching tool result was still running when the transcript ended.
 */
export function lastToolCalls(stdout: string, n = 5): ToolCall[] {
  const calls: Array<ToolCall & { id: string }> = [];
  const answered = new Set<string>();
  for (const o of jsonLines(stdout)) {
    const msg = (o as { type?: string; message?: { content?: unknown } }) ?? {};
    const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (msg.type === 'assistant' && block['type'] === 'tool_use')
        calls.push({
          id: String(block['id'] ?? ''),
          name: String(block['name'] ?? '?'),
          input: JSON.stringify(block['input'] ?? {}).slice(0, 300),
          pending: true,
        });
      if (msg.type === 'user' && block['type'] === 'tool_result')
        answered.add(String(block['tool_use_id'] ?? ''));
    }
  }
  return calls.map(({ id, ...c }) => ({ ...c, pending: !answered.has(id) })).slice(-n);
}
