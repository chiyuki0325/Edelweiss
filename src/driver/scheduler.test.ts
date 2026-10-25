import type { Logger } from '@guiiai/logg';
import { signal } from 'alien-signals';
import { describe, expect, it, vi } from 'vitest';

import {
  createDriverScheduler,
  createSchedulerStateController,
  evaluateScheduling,
} from './scheduler';
import type { SchedulingSnapshot } from './scheduler';
import { createSchedulerState } from './turn-state';
import type { RenderedContext } from '../rendering/types';

const testLogger = (): Logger => {
  const logger = {
    withFields: vi.fn(() => logger),
    log: vi.fn(),
  };
  return logger as unknown as Logger;
};

const rc = (...receivedAtMs: number[]): RenderedContext =>
  receivedAtMs.map(ms => ({
    receivedAtMs: ms,
    content: [{ type: 'text' as const, text: `message ${ms}` }],
  }));

const snapshot = (overrides: Partial<SchedulingSnapshot> = {}): SchedulingSnapshot => ({
  rc: rc(100),
  offline: false,
  running: false,
  chatLoopBlocked: false,
  lastProcessedMs: 0,
  lastTRInterrupted: false,
  failedRc: null,
  focusMode: false,
  debounceWaiting: false,
  replyBatchDeadlineMs: null,
  startNextDebounceWithExtendDelay: false,
  lastTypingAtMs: 0,
  activeRunRc: null,
  activeRunInterruptCursorMs: 0,
  ...overrides,
});

const schedulingConfig = {
  initialDelayMs: 100,
  typingExtendMs: 50,
  maxDelayMs: 1_000,
};

describe('evaluateScheduling', () => {
  it('waits for ordinary input, then starts when debounce expires', () => {
    expect(evaluateScheduling(snapshot(), 'context-updated', 1_000, schedulingConfig))
      .toMatchObject({ type: 'wait', delayMs: 100, deadlineMs: 2_000 });
    expect(evaluateScheduling(snapshot({
      debounceWaiting: true,
      replyBatchDeadlineMs: 2_000,
      lastTypingAtMs: -10_000,
    }), 'timer', 1_100, schedulingConfig))
      .toMatchObject({ type: 'start', reason: 'debounce-completed' });
  });

  it('extends recent typing without exceeding the batch deadline', () => {
    expect(evaluateScheduling(snapshot({
      debounceWaiting: true,
      replyBatchDeadlineMs: 1_120,
      lastTypingAtMs: 1_090,
    }), 'timer', 1_100, schedulingConfig))
      .toMatchObject({ type: 'wait', delayMs: 20, deadlineMs: 1_120 });
    expect(evaluateScheduling(snapshot({
      debounceWaiting: true,
      replyBatchDeadlineMs: 1_120,
      lastTypingAtMs: 1_110,
    }), 'timer', 1_120, schedulingConfig))
      .toMatchObject({ type: 'start', reason: 'max-delay-reached' });
  });

  it('interrupts a running turn only for eligible newer input', () => {
    const activeRc = rc(100);
    const running = snapshot({
      rc: rc(100, 200),
      running: true,
      activeRunRc: activeRc,
      activeRunInterruptCursorMs: 100,
    });
    expect(evaluateScheduling(running, 'context-updated', 1_000, schedulingConfig))
      .toMatchObject({ type: 'interrupt', reason: 'new-input' });
    expect(evaluateScheduling({ ...running, focusMode: true }, 'context-updated', 1_000, schedulingConfig))
      .toMatchObject({ type: 'idle', reason: 'turn-running' });
  });
});

describe('createSchedulerStateController', () => {
  it('keeps an interrupted batch deadline and clears a completed one', () => {
    const state = createSchedulerState();
    const scheduler = createSchedulerStateController(state, {
      maxDelayMs: 100,
      now: () => 1_000,
    });

    scheduler.markInterruptedByInput();
    const deadline = state.replyBatchDeadlineMs;
    scheduler.onTurnSettled();
    expect(state.replyBatchDeadlineMs).toBe(deadline);

    scheduler.startActiveRun([], 0);
    scheduler.onTurnSettled();
    expect(state.replyBatchDeadlineMs).toBeNull();
  });
});

describe('createDriverScheduler', () => {
  it('starts a debounced turn from an explicit context update', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const state = createSchedulerState();
      const startTurn = vi.fn();
      const rcSignal = signal<RenderedContext>([]);
      const scheduler = createDriverScheduler({
        chatId: 'chat',
        rc: rcSignal,
        offline: signal(false),
        running: signal(false),
        chatLoopBlocked: signal(false),
        lastProcessedMs: signal(0),
        failedRc: signal<RenderedContext | null>(null),
        lastTRInterrupted: signal(false),
        focusMode: signal(false),
        scheduler: state,
      }, {
        ...schedulingConfig,
        startTurn,
        log: testLogger(),
      });

      rcSignal(rc(100));
      scheduler.onContextUpdated();
      expect(state.debounceWaiting).toBe(true);

      await vi.advanceTimersByTimeAsync(100);
      expect(startTurn).toHaveBeenCalledTimes(1);

      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts the active turn when explicit context update adds newer input', () => {
    const state = createSchedulerState();
    const rcSignal = signal<RenderedContext>(rc(100));
    const running = signal(false);
    const scheduler = createDriverScheduler({
      chatId: 'chat',
      rc: rcSignal,
      offline: signal(false),
      running,
      chatLoopBlocked: signal(false),
      lastProcessedMs: signal(0),
      failedRc: signal<RenderedContext | null>(null),
      lastTRInterrupted: signal(false),
      focusMode: signal(false),
      scheduler: state,
    }, {
      ...schedulingConfig,
      startTurn: vi.fn(),
      log: testLogger(),
    });

    scheduler.beginTurn();
    const abortController = new AbortController();
    scheduler.attachAbortController(abortController);
    rcSignal(rc(100, 200));
    scheduler.onContextUpdated();

    expect(abortController.signal.aborted).toBe(true);
    expect(state.startNextDebounceWithExtendDelay).toBe(true);

    scheduler.stop();
  });
});
