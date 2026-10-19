import { runOne, type EvalContext, type EvalRunRecord } from './runner.js';
import type { EvalTask } from './tasks.js';
import type { ToolSetup } from './tools.js';

/**
 * Pilot (plan 9.1 rule 1): one task, once with the fast model and once with the strong model, to
 * measure real per-run cost before planning any batch. Uses the same runner, ledger and caps.
 */
export async function runPilot(
  ctx: EvalContext,
  input: { task: EvalTask; taskSetVersion: string; tool: ToolSetup; baselineItemId: string | null },
): Promise<EvalRunRecord[]> {
  const out: EvalRunRecord[] = [];
  for (const model of [ctx.config.MODEL_FAST, ctx.config.MODEL_STRONG]) {
    out.push(await runOne(ctx, { ...input, model, stage: 'pilot' }));
  }
  return out;
}
