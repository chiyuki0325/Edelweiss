import type { SchedulerState } from './turn-state';
import type { RenderedContext } from '../rendering/types';

export interface DriverSchedulerOptions {
  maxDelayMs: number;
  now?: () => number;
}

export const createDriverScheduler = (
  state: SchedulerState,
  options: DriverSchedulerOptions,
) => {
  const now = options.now ?? Date.now;

  const clearDebounceTimers = (): void => {
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
      state.debounceTimer = undefined;
    }
    if (state.maxDelayTimer) {
      clearTimeout(state.maxDelayTimer);
      state.maxDelayTimer = undefined;
    }
  };

  const ensureReplyBatchDeadline = (): number => {
    state.replyBatchDeadlineMs ??= now() + options.maxDelayMs;
    return state.replyBatchDeadlineMs;
  };

  const replyBatchRemainingMs = (): number =>
    Math.max(0, ensureReplyBatchDeadline() - now());

  const isReplyBatchDeadlineExpired = (): boolean =>
    state.replyBatchDeadlineMs != null && now() >= state.replyBatchDeadlineMs;

  const markInterruptedByInput = (): void => {
    state.activeRunInterruptedByInput = true;
    state.startNextDebounceWithExtendDelay = true;
    ensureReplyBatchDeadline();
  };

  const startActiveRun = (
    rcAtStart: RenderedContext,
    interruptCursorMs: number,
  ): void => {
    state.activeRunRc = rcAtStart;
    state.activeRunInterruptCursorMs = interruptCursorMs;
    state.activeRunInterruptedByInput = false;
  };

  const onTurnSettled = (): void => {
    if (!state.activeRunInterruptedByInput)
      state.replyBatchDeadlineMs = null;
    state.activeRunRc = null;
    state.activeRunInterruptCursorMs = 0;
    state.activeRunInterruptedByInput = false;
  };

  const clearWaitingState = (): void => {
    clearDebounceTimers();
    state.debounceWaiting = false;
  };

  const resetIdleBatch = (): void => {
    clearWaitingState();
    state.startNextDebounceWithExtendDelay = false;
    state.replyBatchDeadlineMs = null;
  };

  return {
    clearDebounceTimers,
    ensureReplyBatchDeadline,
    replyBatchRemainingMs,
    isReplyBatchDeadlineExpired,
    markInterruptedByInput,
    startActiveRun,
    onTurnSettled,
    clearWaitingState,
    resetIdleBatch,
  };
};
