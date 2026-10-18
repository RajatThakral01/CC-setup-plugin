import type { BudgetGuard, Logger } from '@cc-setup-agent/core';
import type { AppConfig } from '@cc-setup-agent/shared';
import type { Db } from './client.js';
import { assertBudget, budgetCapsFromConfig, recordSpend } from './ledger.js';

/** BudgetGuard over the ledger: weekly, purpose and total caps, one row per call. */
export function createLedgerGuard(db: Db, config: AppConfig, logger?: Logger): BudgetGuard {
  const caps = budgetCapsFromConfig(config);
  return {
    async preflight(purpose, estimatedUsd) {
      await assertBudget(db, purpose, estimatedUsd, caps, logger ? { logger } : {});
    },
    record(purpose, model, usage, ref) {
      return recordSpend(db, config, { purpose, model, usage, ...(ref ? { ref } : {}) }, logger);
    },
  };
}
