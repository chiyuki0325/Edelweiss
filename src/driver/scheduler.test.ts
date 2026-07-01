import type { Logger } from '@guiiai/logg';
import { signal } from 'alien-signals';
import { describe, expect, it, vi } from 'vitest';

import { createDriverScheduler, createSchedulerStateController } from './scheduler';
import { createDefaultTurnCapabilities, createSchedulerState } from './turn-state';
import type { ChatScope, TurnState } from './turn-state';
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

describe('createSchedulerStateController', () => {
  it('anchors reply batch deadline only once when interrupted repeatedly', () => {
    const state = createSchedulerState();
    let now = 1_000;
    const scheduler = createSchedulerStateController(state, {
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
    const interruptedScheduler = createSchedulerStateController(interrupted, { maxDelayMs: 100 });
    interruptedScheduler.markInterruptedByInput();
    interruptedScheduler.onTurnSettled();
    expect(interrupted.replyBatchDeadlineMs).not.toBeNull();
    expect(interrupted.activeRunInterruptedByInput).toBe(false);

    const completed = createSchedulerState();
    const completedScheduler = createSchedulerStateController(completed, { maxDelayMs: 100 });
    completedScheduler.ensureReplyBatchDeadline();
    completedScheduler.onTurnSettled();
    expect(completed.replyBatchDeadlineMs).toBeNull();
  });

  it('clears timers and waiting state', () => {
    vi.useFakeTimers();
    try {
      const state = createSchedulerState();
      const scheduler = createSchedulerStateController(state, { maxDelayMs: 100 });
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

describe('createDriverScheduler', () => {
  it('starts debounced turns through the scheduler controller', async () => {
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
        lastProcessedMs: signal(0),
        failedRc: signal<RenderedContext | null>(null),
        lastTRInterrupted: signal(false),
        focusMode: signal(false),
        scheduler: state,
      }, {
        initialDelayMs: 100,
        typingExtendMs: 50,
        maxDelayMs: 1_000,
        startTurn,
        log: testLogger(),
      });

      rcSignal(rc(100));
      expect(state.debounceWaiting).toBe(true);
      await vi.advanceTimersByTimeAsync(99);
      expect(startTurn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(startTurn).toHaveBeenCalledTimes(1);

      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts the active turn when newer interrupting input arrives before the deadline', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const state = createSchedulerState();
      const rcSignal = signal<RenderedContext>([]);
      const running = signal(false);
      let activeTurn: TurnState | null = null;
      const scheduler = createDriverScheduler({
        chatId: 'chat',
        rc: rcSignal,
        offline: signal(false),
        running,
        lastProcessedMs: signal(0),
        failedRc: signal<RenderedContext | null>(null),
        lastTRInterrupted: signal(false),
        focusMode: signal(false),
        scheduler: state,
        getActiveTurn: () => activeTurn,
      }, {
        initialDelayMs: 100,
        typingExtendMs: 50,
        maxDelayMs: 1_000,
        startTurn: vi.fn(),
        log: testLogger(),
      });

      rcSignal(rc(100));
      const started = scheduler.beginTurn();
      expect(started?.rcAtStart).toHaveLength(1);
      const abortController = new AbortController();
      activeTurn = {
        id: 'turn',
        kind: 'main',
        chatId: 'chat',
        agentId: 'main',
        scope: {} as ChatScope,
        model: { apiBaseUrl: '', apiKey: '', model: '' },
        rcAtStart: started!.rcAtStart,
        trs: [],
        entries: [],
        system: '',
        tools: [],
        step: 1,
        maxSteps: Infinity,
        pendingPrune: false,
        abortController,
        capabilities: createDefaultTurnCapabilities('main'),
        loadedSkills: new Set(),
        reactionEmojis: [],
        flags: {
          wasOfflineAtStart: false,
          interruptedByInput: false,
          sendMessageWasLengthLimited: false,
          modelStayedSilent: false,
          inFocusMode: false,
        },
      };
      scheduler.attachAbortController(abortController);

      rcSignal(rc(100, 200));

      expect(abortController.signal.aborted).toBe(true);
      expect(activeTurn!.flags.interruptedByInput).toBe(true);
      expect(state.startNextDebounceWithExtendDelay).toBe(true);
      expect(state.replyBatchDeadlineMs).toBe(1_001_000);

      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not abort the active run when focus mode is active', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const state = createSchedulerState();
      const rcSignal = signal<RenderedContext>([]);
      const running = signal(false);
      const focusMode = signal(false);
      let activeTurn: TurnState | null = null;
      const scheduler = createDriverScheduler({
        chatId: 'chat',
        rc: rcSignal,
        offline: signal(false),
        running,
        lastProcessedMs: signal(0),
        failedRc: signal<RenderedContext | null>(null),
        lastTRInterrupted: signal(false),
        focusMode,
        scheduler: state,
        getActiveTurn: () => activeTurn,
      }, {
        initialDelayMs: 100,
        typingExtendMs: 50,
        maxDelayMs: 1_000,
        startTurn: vi.fn(),
        log: testLogger(),
      });

      rcSignal(rc(100));
      const started = scheduler.beginTurn();
      const abortController = new AbortController();
      activeTurn = {
        id: 'turn',
        kind: 'main',
        chatId: 'chat',
        agentId: 'main',
        scope: {} as ChatScope,
        model: { apiBaseUrl: '', apiKey: '', model: '' },
        rcAtStart: started!.rcAtStart,
        trs: [],
        entries: [],
        system: '',
        tools: [],
        step: 1,
        maxSteps: Infinity,
        pendingPrune: false,
        abortController,
        capabilities: createDefaultTurnCapabilities('main'),
        loadedSkills: new Set(),
        reactionEmojis: [],
        flags: {
          wasOfflineAtStart: false,
          interruptedByInput: false,
          sendMessageWasLengthLimited: false,
          modelStayedSilent: false,
          inFocusMode: true,
        },
      };
      scheduler.attachAbortController(abortController);

      focusMode(true);
      rcSignal(rc(100, 200));

      expect(abortController.signal.aborted).toBe(false);
      expect(activeTurn.flags.interruptedByInput).toBe(false);

      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips debounce and starts turn immediately when focus mode is active', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const state = createSchedulerState();
      const startTurn = vi.fn();
      const rcSignal = signal<RenderedContext>([]);
      const focusMode = signal(false);
      const scheduler = createDriverScheduler({
        chatId: 'chat',
        rc: rcSignal,
        offline: signal(false),
        running: signal(false),
        lastProcessedMs: signal(0),
        failedRc: signal<RenderedContext | null>(null),
        lastTRInterrupted: signal(false),
        focusMode,
        scheduler: state,
      }, {
        initialDelayMs: 5_000,
        typingExtendMs: 5_000,
        maxDelayMs: 30_000,
        startTurn,
        log: testLogger(),
      });

      // First message triggers debounce (not immediate start)
      rcSignal(rc(100));
      expect(state.debounceWaiting).toBe(true);
      expect(startTurn).not.toHaveBeenCalled();

      // Enabling focus mode should bypass debounce and start immediately
      focusMode(true);
      expect(startTurn).toHaveBeenCalledTimes(1);
      expect(state.debounceWaiting).toBe(false);

      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
