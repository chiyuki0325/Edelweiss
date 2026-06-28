import { describe, expect, it, vi } from 'vitest';

import { createDriverScheduler } from './scheduler';
import { createSchedulerState } from './turn-state';

describe('createDriverScheduler', () => {
  it('anchors reply batch deadline only once when interrupted repeatedly', () => {
    const state = createSchedulerState();
    let now = 1_000;
    const scheduler = createDriverScheduler(state, {
      maxDelayMs: 5_000,
      now: () => now,
    });

    scheduler.markInterruptedByInput();
    expect(state.replyBatchDeadlineMs).toBe(6_000);
    expect(state.startNextDebounceWithExtendDelay).toBe(true);
    expect(state.activeRunInterruptedByInput).toBe(true);

    now = 2_000;
    scheduler.markInterruptedByInput();
    expect(state.replyBatchDeadlineMs).toBe(6_000);
  });

  it('clears the deadline only for non-interrupted settled turns', () => {
    const interrupted = createSchedulerState();
    const interruptedScheduler = createDriverScheduler(interrupted, { maxDelayMs: 100 });
    interruptedScheduler.markInterruptedByInput();
    interruptedScheduler.onTurnSettled();
    expect(interrupted.replyBatchDeadlineMs).not.toBeNull();
    expect(interrupted.activeRunInterruptedByInput).toBe(false);

    const completed = createSchedulerState();
    const completedScheduler = createDriverScheduler(completed, { maxDelayMs: 100 });
    completedScheduler.ensureReplyBatchDeadline();
    completedScheduler.onTurnSettled();
    expect(completed.replyBatchDeadlineMs).toBeNull();
  });

  it('clears timers and waiting state', () => {
    vi.useFakeTimers();
    try {
      const state = createSchedulerState();
      const scheduler = createDriverScheduler(state, { maxDelayMs: 100 });
      state.debounceWaiting = true;
      state.debounceTimer = setTimeout(() => {}, 100);
      state.maxDelayTimer = setTimeout(() => {}, 100);

      scheduler.clearWaitingState();

      expect(state.debounceWaiting).toBe(false);
      expect(state.debounceTimer).toBeUndefined();
      expect(state.maxDelayTimer).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
