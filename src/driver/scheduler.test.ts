import type { Logger } from '@guiiai/logg';
import { signal } from 'alien-signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

    scheduler.beginTurn('context-updated');
    const abortController = new AbortController();
    scheduler.attachAbortController(abortController);
    rcSignal(rc(100, 200));
    scheduler.onContextUpdated();

    expect(abortController.signal.aborted).toBe(true);
    expect(state.startNextDebounceWithExtendDelay).toBe(true);

    scheduler.stop();
  });
});

describe('offline mode', () => {
  const mention = { ...rc(100)[0]!, mentionsMe: true };
  const reply = { ...rc(100)[0]!, repliesToMe: true };

  const setup = () => {
    const state = createSchedulerState();
    const rcSignal = signal<RenderedContext>([]);
    const offline = signal(true);
    const lastProcessedMs = signal(0);
    const lastTRInterrupted = signal(false);
    const startTurn = vi.fn(() => {
      const abortController = new AbortController();
      scheduler.attachAbortController(abortController);
      return abortController;
    });
    const scheduler = createDriverScheduler({
      chatId: 'chat',
      rc: rcSignal,
      offline,
      running: signal(false),
      chatLoopBlocked: signal(false),
      lastProcessedMs,
      failedRc: signal<RenderedContext | null>(null),
      lastTRInterrupted,
      focusMode: signal(false),
      scheduler: state,
    }, {
      ...schedulingConfig,
      startTurn,
      log: testLogger(),
    });
    return { scheduler, state, rcSignal, offline, lastProcessedMs, lastTRInterrupted, startTurn };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { trigger: 'mention', segment: mention },
    { trigger: 'reply', segment: reply },
  ])('returns online after completing a turn triggered by a $trigger', async ({ segment }) => {
    const { scheduler, rcSignal, offline, lastProcessedMs, startTurn } = setup();
    rcSignal([segment]);
    scheduler.onContextUpdated();
    await vi.advanceTimersByTimeAsync(schedulingConfig.initialDelayMs);
    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(offline()).toBe(true);

    lastProcessedMs(100);
    expect(scheduler.finishTurn(startTurn.mock.results[0]!.value, true)).toBe(true);
    expect(offline()).toBe(false);
  });

  it.each([
    { label: 'ordinary input', context: rc(100) },
    { label: 'a pending mention', context: [mention] },
  ])('stays offline after a wake with $label', ({ context }) => {
    const { scheduler, rcSignal, offline, lastProcessedMs, startTurn } = setup();
    rcSignal(context);
    scheduler.wake();
    expect(startTurn).toHaveBeenCalledTimes(1);

    lastProcessedMs(100);
    expect(scheduler.finishTurn(startTurn.mock.results[0]!.value, true)).toBe(false);
    expect(offline()).toBe(true);
  });

  it('stays offline after resuming an interrupted tool loop without a new external mention or reply', async () => {
    const { scheduler, rcSignal, offline, lastProcessedMs, lastTRInterrupted, startTurn } = setup();
    rcSignal([mention, { ...reply, receivedAtMs: 150, isMyself: true }, ...rc(200)]);
    lastProcessedMs(100);
    lastTRInterrupted(true);
    scheduler.onStateUpdated();
    await vi.advanceTimersByTimeAsync(schedulingConfig.initialDelayMs);
    expect(startTurn).toHaveBeenCalledTimes(1);

    lastProcessedMs(200);
    lastTRInterrupted(false);
    expect(scheduler.finishTurn(startTurn.mock.results[0]!.value, true)).toBe(false);
    expect(offline()).toBe(true);
  });

  it.each([true, false])('preserves setOffline(%s) during a mention turn', newOffline => {
    const { scheduler, rcSignal, offline, lastProcessedMs, startTurn } = setup();
    rcSignal([mention]);
    scheduler.onContextUpdated();
    expect(startTurn).toHaveBeenCalledTimes(1);

    scheduler.setOffline(newOffline);
    lastProcessedMs(100);
    expect(scheduler.finishTurn(startTurn.mock.results[0]!.value, true)).toBe(false);
    expect(offline()).toBe(newOffline);
  });

  it('stays offline when an eligible turn fails to complete', () => {
    const { scheduler, rcSignal, offline, startTurn } = setup();
    const context = [mention];
    rcSignal(context);
    scheduler.onContextUpdated();
    expect(startTurn).toHaveBeenCalledTimes(1);

    scheduler.markFailed(context);
    expect(scheduler.finishTurn(startTurn.mock.results[0]!.value, false)).toBe(false);
    expect(offline()).toBe(true);
  });

  it.each([false, true])('stays offline until an interrupted mention turn completes a retry (abort lock: %s)', abortLocked => {
    const { scheduler, state, rcSignal, offline, lastProcessedMs, startTurn } = setup();
    rcSignal([mention]);
    scheduler.onContextUpdated();
    expect(startTurn).toHaveBeenCalledTimes(1);
    const firstRun = startTurn.mock.results[0]!.value;

    state.abortLocked = abortLocked;
    rcSignal([mention, ...rc(200)]);
    scheduler.onContextUpdated();
    expect(state.activeRunInterruptedByInput).toBe(true);
    expect(firstRun.signal.aborted).toBe(!abortLocked);
    expect(scheduler.finishTurn(firstRun, true)).toBe(false);
    expect(offline()).toBe(true);

    expect(startTurn).toHaveBeenCalledTimes(2);
    lastProcessedMs(200);
    expect(scheduler.finishTurn(startTurn.mock.results[1]!.value, true)).toBe(true);
    expect(offline()).toBe(false);
  });
});
