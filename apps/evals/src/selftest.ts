import type { EvalDriver, RunLimits } from './driver.js';
import type { TaskSet } from './tasks.js';

export interface SelftestResult {
  taskId: string;
  /** The broken starting state must fail its check. */
  brokenFails: boolean;
  /** The known-good solution must pass it. */
  solutionPasses: boolean;
  detail: string;
}

/**
 * Proves every task's check is deterministic and meaningful (plan M9 acceptance): setup alone →
 * check fails; setup + `solution.sh` → check passes. Runs in the eval sandbox, no API calls.
 */
export async function selftestTasks(
  driver: EvalDriver,
  taskSet: TaskSet,
  limits: RunLimits,
  newRunId: () => string,
  only?: string,
): Promise<SelftestResult[]> {
  const results: SelftestResult[] = [];
  for (const task of taskSet.tasks) {
    if (only && task.id !== only) continue;
    const base = { task, tool: { kind: 'none' } as const, model: 'none', limits };
    const broken = await driver.run({ ...base, runId: newRunId(), mode: 'none' });
    const solved = await driver.run({ ...base, runId: newRunId(), mode: 'solution' });
    const brokenFails = broken.setup.ok && broken.check !== null && !broken.check.passed;
    const solutionPasses = solved.setup.ok && solved.check?.passed === true;
    results.push({
      taskId: task.id,
      brokenFails,
      solutionPasses,
      detail: [
        brokenFails
          ? ''
          : `broken state: ${broken.setup.ok ? 'check passed' : broken.setup.output.slice(-400)}`,
        solutionPasses
          ? ''
          : `solution: ${solved.setup.ok ? (solved.check?.output ?? '').slice(-1500) : solved.setup.output.slice(-400)}`,
      ]
        .filter(Boolean)
        .join('\n'),
    });
  }
  return results;
}
