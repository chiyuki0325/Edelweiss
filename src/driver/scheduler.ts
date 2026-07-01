import type { Logger } from '@guiiai/logg';
import { computed, effect } from 'alien-signals';

import { latestExternalEventMs, latestInterruptingExternalEventMs } from './context';
import type { DriverSignal, SchedulerState, TurnState } from './turn-state';
import type { RenderedContext } from '../rendering/types';

const TYPING_VALIDITY_MS = 6000;

export interface SchedulerStateControllerOptions {
  maxDelayMs: number;
  now?: () => number;
}

export const createSchedulerStateController = (
  state: SchedulerState,
  options: SchedulerStateControllerOptions,
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
    state.abortLocked = false;
    state.pendingAbort = false;
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

export interface DriverSchedulerScope {
  chatId: string;
  rc: DriverSignal<RenderedContext>;
  offline: DriverSignal<boolean>;
  running: DriverSignal<boolean>;
  lastProcessedMs: DriverSignal<number>;
  lastTRInterrupted: DriverSignal<boolean>;
  failedRc: DriverSignal<RenderedContext | null>;
  focusMode: DriverSignal<boolean>;
  scheduler: SchedulerState;
  getActiveTurn?: () => TurnState | null;
}

export interface DriverSchedulerOptions {
  initialDelayMs: number;
  typingExtendMs: number;
  maxDelayMs: number;
  startTurn: () => void;
  onDebounceStateChange?: (chatId: string, isDebouncing: boolean) => void;
  log: Logger;
  now?: () => number;
}

export interface StartedTurnInfo {
  rcAtStart: RenderedContext;
  wasOffline: boolean;
}

export const createDriverScheduler = (
  scope: DriverSchedulerScope,
  options: DriverSchedulerOptions,
) => {
  const now = options.now ?? Date.now;
  const state = scope.scheduler;
  const stateController = createSchedulerStateController(state, {
    maxDelayMs: options.maxDelayMs,
    now,
  });

  const notifyDebounceStopped = (): void => {
    if (state.debounceWaiting)
      options.onDebounceStateChange?.(scope.chatId, false);
  };

  const needsReply = computed(() => {
    const rcVal = scope.rc();
    if (rcVal.length === 0) return false;
    if (rcVal === scope.failedRc()) return false;
    if (scope.lastTRInterrupted()) return true;
    if (scope.offline()) {
      const after = scope.lastProcessedMs();
      return rcVal.some(seg =>
        !seg.isMyself && (!!seg.mentionsMe || !!seg.repliesToMe) && seg.receivedAtMs > after);
    }
    return latestExternalEventMs(rcVal, scope.lastProcessedMs()) != null;
  });

  const hasInterruptingInputDuringActiveRun = (rcVal = scope.rc()): boolean => {
    const interruptAfterMs = Math.max(scope.lastProcessedMs(), state.activeRunInterruptCursorMs);
    return state.activeRunRc != null
      && rcVal !== state.activeRunRc
      && latestInterruptingExternalEventMs(rcVal, interruptAfterMs) != null;
  };

  const abortActiveRunForInput = (): void => {
    stateController.markInterruptedByInput();
    const activeTurn = scope.getActiveTurn?.();
    if (activeTurn)
      activeTurn.flags.interruptedByInput = true;
    if (state.abortLocked) {
      state.pendingAbort = true;
      return;
    }
    if (state.abortController) {
      state.abortController.abort(new Error('New messages arrived, aborting current call'));
      state.abortController = null;
    }
  };

  const startTurn = (): void => {
    options.startTurn();
  };

  const debounceTimerCallback = (): void => {
    if (
      state.debounceWaiting
      && now() - state.lastTypingAtMs < TYPING_VALIDITY_MS
      && !stateController.isReplyBatchDeadlineExpired()
    ) {
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.debounceTimer = setTimeout(
        debounceTimerCallback,
        Math.min(options.typingExtendMs, stateController.replyBatchRemainingMs()),
      );
      return;
    }
    startTurn();
  };

  const extendDebounce = (): void => {
    if (!state.debounceWaiting || scope.running()) return;
    const remainingMs = stateController.replyBatchRemainingMs();
    if (remainingMs <= 0) {
      startTurn();
      return;
    }
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(
      debounceTimerCallback,
      Math.min(options.typingExtendMs, remainingMs),
    );
  };

  const notifyTyping = (): void => {
    state.lastTypingAtMs = now();
    extendDebounce();
  };

  const disposeReplyEffect = effect(() => {
    const rcVal = scope.rc();
    const isRunning = scope.running();

    if (isRunning) {
      notifyDebounceStopped();
      stateController.clearWaitingState();
      if (
        hasInterruptingInputDuringActiveRun(rcVal)
        && !stateController.isReplyBatchDeadlineExpired()
        && !scope.focusMode()
      ) {
        abortActiveRunForInput();
      }
      return;
    }

    if (!needsReply()) {
      notifyDebounceStopped();
      stateController.resetIdleBatch();
      if (scope.focusMode()) scope.focusMode(false);
      return;
    }

    if (scope.focusMode()) {
      notifyDebounceStopped();
      stateController.resetIdleBatch();
      startTurn();
      return;
    }

    const hasInterruptingExternalInput =
      latestInterruptingExternalEventMs(rcVal, scope.lastProcessedMs()) != null;
    if (!hasInterruptingExternalInput) {
      notifyDebounceStopped();
      stateController.resetIdleBatch();
      startTurn();
      return;
    }

    if (!state.debounceWaiting) {
      const debounceDelayMs = state.startNextDebounceWithExtendDelay
        ? options.typingExtendMs
        : options.initialDelayMs;
      state.startNextDebounceWithExtendDelay = false;
      const remainingMs = stateController.replyBatchRemainingMs();
      if (remainingMs <= 0) {
        startTurn();
        return;
      }
      const effectiveDebounceDelayMs = Math.min(debounceDelayMs, remainingMs);
      state.debounceWaiting = true;
      options.onDebounceStateChange?.(scope.chatId, true);
      state.debounceTimer = setTimeout(debounceTimerCallback, effectiveDebounceDelayMs);
      state.maxDelayTimer = setTimeout(startTurn, remainingMs);
      options.log.withFields({
        chatId: scope.chatId,
        debounceDelayMs: effectiveDebounceDelayMs,
        initialDelayMs: options.initialDelayMs,
        typingExtendMs: options.typingExtendMs,
        maxDelayMs: options.maxDelayMs,
        replyBatchDeadlineMs: state.replyBatchDeadlineMs,
      }).log('Debounce started');
    } else {
      const remainingMs = stateController.replyBatchRemainingMs();
      if (remainingMs <= 0) {
        startTurn();
        return;
      }
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.debounceTimer = setTimeout(
        debounceTimerCallback,
        Math.min(options.typingExtendMs, remainingMs),
      );
    }
  });

  const beginTurn = (): StartedTurnInfo | null => {
    if (scope.running()) return null;
    stateController.clearDebounceTimers();
    notifyDebounceStopped();
    state.debounceWaiting = false;
    if (scope.focusMode()) scope.focusMode(false);

    const wasOffline = scope.offline();
    const rcAtStart = scope.rc();
    stateController.startActiveRun(
      rcAtStart,
      latestInterruptingExternalEventMs(rcAtStart, scope.lastProcessedMs()) ?? scope.lastProcessedMs(),
    );
    scope.running(true);
    return { rcAtStart, wasOffline };
  };

  const attachAbortController = (abortController: AbortController): void => {
    state.abortController = abortController;
  };

  const clearAbortController = (abortController?: AbortController): void => {
    if (!abortController || state.abortController === abortController)
      state.abortController = null;
  };

  const stop = (): void => {
    notifyDebounceStopped();
    stateController.clearWaitingState();
    state.abortController = null;
    disposeReplyEffect();
  };

  return {
    ...stateController,
    beginTurn,
    attachAbortController,
    clearAbortController,
    extendDebounce,
    notifyTyping,
    markFailed: (rc: RenderedContext) => scope.failedRc(rc),
    wake: startTurn,
    stop,
  };
};
