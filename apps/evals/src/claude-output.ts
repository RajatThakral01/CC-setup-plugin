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

/** The last JSON object on stdout (Claude Code prints exactly one in json mode). */
export function parseClaudeOutput(stdout: string, fallbackModel: string): ClaudeRunResult | null {
  const start = stdout.indexOf('{');
  if (start === -1) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.slice(start));
  } catch {
    return null;
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
