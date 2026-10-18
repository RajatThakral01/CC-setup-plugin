import { AppError } from '@cc-setup-agent/core';

export class ItemNotFoundError extends AppError {
  constructor(readonly itemId: string) {
    super(`Catalog item ${itemId} not found`);
  }
}

export class InvalidTransitionError extends AppError {
  constructor(
    readonly itemId: string,
    readonly from: string,
    readonly to: string,
    reason: string,
  ) {
    super(`Cannot change ${itemId} from ${from} to ${to}: ${reason}`);
  }
}

/** Raised before a call when it would exceed the weekly, purpose or total budget. */
export class BudgetExceededError extends AppError {
  constructor(
    readonly limitedBy: string,
    readonly remainingUsd: number,
    readonly requestedUsd: number,
  ) {
    super(
      `Budget exhausted (${limitedBy} cap): requested USD ${requestedUsd.toFixed(6)}, remaining USD ${remainingUsd.toFixed(6)}`,
    );
  }
}
