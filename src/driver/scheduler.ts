import type { Logger } from '@guiiai/logg';

import { latestExternalEventMs, latestInterruptingExternalEventMs } from './context';
import type { DriverSignal, SchedulerState, TurnState } from './turn-state';
import type { RenderedContext } from '../rendering/types';

const TYPING_VALIDITY_MS = 6000;

/*
 * Driver 调度架构
 *
 * RC 更新 ----------> onContextUpdated() ----+
 * typing -----------> notifyTyping() --------+
 * 状态恢复 ----------> onStateUpdated() ------+
 * offline -----------> setOffline() ----------+
 * compaction --------> setChatLoopBlocked() --+--> evaluateAndApply(cause)
 * mailbox / 手动唤醒 -> wake() ----------------+             |
 *                                                            v
 *                                                 readSnapshot() + now()
 *                                                            |
 *                                                            v
 *                                         evaluateScheduling(...) [纯判断]
 *                                                            |
 *                     +--------------+--------------+--------------+
 *                     |              |              |              |
 *                     v              v              v              v
 *                   idle           wait         interrupt        start
 *                                    |              |              |
 *                             debounceTimer   AbortController      v
 *                                    |                       beginTurn()
 *                               timer 到期                          |
 *                                    |                             v
 *                                    |                        startTurn()
 *                                    |                             |
 *                                    |                         Turn 执行
 *                                    |                             |
 *                                    v                             v
 *                       evaluateAndApply('timer')             finishTurn()
 *                                                                  |
 *                                                                  v
 *                                             evaluateAndApply('turn-settled')
 */

export interface SchedulerStateControllerOptions {
  maxDelayMs: number;
  now?: () => number;
}

/**
 * 一次回复可能经历等待、被新消息打断、重新等待，最后才真正结束。
 * 这部分集中记住这段过程里会跨多次判断保留下来的状态。
 */
export const createSchedulerStateController = (
  state: SchedulerState,
  options: SchedulerStateControllerOptions,
) => {
  const now = options.now ?? Date.now;

  /** Scheduler 只有这一只等待 Timer，它对应当前安排好的下次判断时间。 */
  const clearDebounceTimers = (): void => {
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
      state.debounceTimer = undefined;
    }
  };

  /**
   * 一批消息第一次进入等待时会定下最晚回复时间。
   * 后面的 typing、Timer 重排和 Turn 重启都沿用这个时间点。
   *
   * 例如 maxDelay 是 30 秒：
   * t=0s 来了第一条消息，deadline 定在 t=30s；
   * t=4s 又来了消息，debounce 可以继续后移，deadline 仍是 t=30s；
   * t=28s 再来消息，这次最多只剩 2 秒等待；
   * t=30s 到达上限，这一批消息开始进入 Turn。
   *
   * 这是一段有上限的退避：新输入会延长当前等待，整批消息的上限保持不变。
   */
  const ensureReplyBatchDeadline = (): number => {
    state.replyBatchDeadlineMs ??= now() + options.maxDelayMs;
    return state.replyBatchDeadlineMs;
  };

  /** debounce 重排真正可用的时间，是当前时刻到 deadline 的这段余量。 */
  const replyBatchRemainingMs = (): number =>
    Math.max(0, ensureReplyBatchDeadline() - now());

  /** 这里查看的是已经形成的回复批次是否走到了 deadline。 */
  const isReplyBatchDeadlineExpired = (): boolean =>
    state.replyBatchDeadlineMs != null && now() >= state.replyBatchDeadlineMs;

  /**
   * Turn 被新消息打断时，这批消息还没有结束。
   * 下一轮会沿用原 deadline，并使用更适合连续输入的 typing 延迟 typingDelayMs
   */
  const markInterruptedByInput = (): void => {
    state.activeRunInterruptedByInput = true;
    state.startNextDebounceWithExtendDelay = true;
    ensureReplyBatchDeadline();
  };

  /**
   * Turn 启动时会留下当时的 RC 和时间游标。
   * 后续判断据此区分本轮已经看到的内容和运行期间到达的新输入。
   */
  const startActiveRun = (
    rcAtStart: RenderedContext,
    interruptCursorMs: number,
  ): void => {
    state.activeRunRc = rcAtStart;
    state.activeRunInterruptCursorMs = interruptCursorMs;
    state.activeRunInterruptedByInput = false;
  };

  /**
   * Turn 结束后，活动运行留下的临时信息也随之结束。
   * 输入打断过的回复仍属于原批次，正常完成的回复则同时结束 deadline。
   */
  const onTurnSettled = (): void => {
    state.abortLocked = false;
    state.pendingAbort = false;
    if (!state.activeRunInterruptedByInput)
      state.replyBatchDeadlineMs = null;
    state.activeRunRc = null;
    state.activeRunInterruptCursorMs = 0;
    state.activeRunInterruptedByInput = false;
  };

  /** 等待态同时包括 Timer 和对外公开的 debounce 标记。 */
  const clearWaitingState = (): void => {
    clearDebounceTimers();
    state.debounceWaiting = false;
  };

  /** 当前 RC 已经没有待处理回复时，这一批输入也完整结束。 */
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
  chatLoopBlocked: DriverSignal<boolean>;
  scheduler: SchedulerState;
  getActiveTurn?: () => TurnState | null;
}

export interface DriverSchedulerOptions {
  initialDelayMs: number;
  typingExtendMs: number;
  maxDelayMs: number;
  startTurn: (turn: StartedTurnInfo) => void;
  onDebounceStateChange?: (chatId: string, isDebouncing: boolean) => void;
  log: Logger;
  now?: () => number;
}

export interface StartedTurnInfo {
  rcAtStart: RenderedContext;
  wasOffline: boolean;
}

export type SchedulingCause =
  | 'context-updated' // 新 RC 已经写入
  | 'typing' // typing 活动或 debounce 延长请求
  | 'turn-settled' // 上一个 Turn 已经收尾
  | 'offline-changed' // 回复范围发生变化
  | 'compaction-changed' // compaction 接管或交还 chat loop
  | 'state-updated' // 持久化状态完成异步恢复
  | 'timer' // debounce Timer 到期
  | 'wake'; // mailbox 等内部事件请求启动 Turn

export type SchedulingDecision =
  | { type: 'idle'; reason: string; resetBatch: boolean } // 当前没有动作
  | { type: 'wait'; reason: string; delayMs: number; deadlineMs: number } // 仍在退避窗口内
  | { type: 'interrupt'; reason: 'new-input' | 'compaction'; deadlineMs?: number } // 当前 Turn 进入收尾
  | { type: 'start'; reason: string }; // 当前快照可以启动 Turn

export interface SchedulingSnapshot {
  rc: RenderedContext;
  offline: boolean;
  running: boolean;
  chatLoopBlocked: boolean;
  lastProcessedMs: number;
  lastTRInterrupted: boolean;
  failedRc: RenderedContext | null;
  focusMode: boolean;
  debounceWaiting: boolean;
  replyBatchDeadlineMs: number | null;
  startNextDebounceWithExtendDelay: boolean;
  lastTypingAtMs: number;
  activeRunRc: RenderedContext | null;
  activeRunInterruptCursorMs: number;
}

export interface SchedulingConfig {
  initialDelayMs: number;
  typingExtendMs: number;
  maxDelayMs: number;
}

/**
 * 调度开始时先回答一个最基本的问题：当前 RC 里有没有需要处理的消息。
 * （offline 模式收窄了这个范围，只有新的 mention 或 reply 会进入下一步。
 */
const needsReply = (snapshot: SchedulingSnapshot): boolean => {
  const { rc } = snapshot;
  if (rc.length === 0) return false;
  if (rc === snapshot.failedRc) return false;
  if (snapshot.lastTRInterrupted) return true;
  if (snapshot.offline) {
    return rc.some(seg =>
      !seg.isMyself
      && (!!seg.mentionsMe || !!seg.repliesToMe)
      && seg.receivedAtMs > snapshot.lastProcessedMs);
  }
  return latestExternalEventMs(rc, snapshot.lastProcessedMs) != null;
};

/**
 * Turn 运行期间的新输入由起点 RC 和时间游标共同确认。
 * RC 引用变化说明上下文更新过，游标则划出本轮已经处理过的时间边界。
 */
const hasInterruptingInputDuringActiveRun = (snapshot: SchedulingSnapshot): boolean => {
  const interruptAfterMs = Math.max(
    snapshot.lastProcessedMs,
    snapshot.activeRunInterruptCursorMs,
  );
  return snapshot.activeRunRc != null
    && snapshot.rc !== snapshot.activeRunRc
    && latestInterruptingExternalEventMs(snapshot.rc, interruptAfterMs) != null;
};

/**
 * 到这里，外部状态已经收拢成一个快照。
 * 这个函数只按顺序回答一件事：现在应该 idle、wait、interrupt 还是 start。
 */
export const evaluateScheduling = (
  snapshot: SchedulingSnapshot,
  cause: SchedulingCause,
  nowMs: number,
  config: SchedulingConfig,
): SchedulingDecision => {
  const deadlineMs = snapshot.replyBatchDeadlineMs ?? nowMs + config.maxDelayMs;
  const deadlineExpired = nowMs >= deadlineMs;

  // Compaction 拿到 chat loop 后，正在运行的 Turn 会进入中断收尾。
  if (snapshot.chatLoopBlocked) {
    return snapshot.running
      ? { type: 'interrupt', reason: 'compaction' }
      : { type: 'idle', reason: 'compaction-blocked', resetBatch: false };
  }

  if (snapshot.running) {
    // Turn 已经在跑时，新输入通常会触发中断。focus mode 或 deadline 到达后，
    // 当前 Turn 会继续完成，这一批回复也就有了稳定的收束点。
    if (
      hasInterruptingInputDuringActiveRun(snapshot)
      && !deadlineExpired
      && !snapshot.focusMode
    ) {
      return { type: 'interrupt', reason: 'new-input', deadlineMs };
    }
    return { type: 'idle', reason: 'turn-running', resetBatch: false };
  }

  if (cause === 'wake')
    return { type: 'start', reason: 'explicit-wake' };

  if (!needsReply(snapshot))
    return { type: 'idle', reason: 'nothing-to-process', resetBatch: true };

  if (snapshot.focusMode)
    return { type: 'start', reason: 'focus-mode' };

  const hasInterruptingExternalInput =
    latestInterruptingExternalEventMs(snapshot.rc, snapshot.lastProcessedMs) != null;
  if (!hasInterruptingExternalInput)
    return { type: 'start', reason: 'non-interrupting-input' };

  if (deadlineExpired)
    return { type: 'start', reason: 'max-delay-reached' };

  const typingIsRecent = nowMs - snapshot.lastTypingAtMs < TYPING_VALIDITY_MS;
  if (cause === 'timer' && !typingIsRecent)
    return { type: 'start', reason: 'debounce-completed' };

  const preferredDelayMs =
    snapshot.debounceWaiting
    || snapshot.startNextDebounceWithExtendDelay
    || cause === 'typing'
      ? config.typingExtendMs
      : config.initialDelayMs;

  return {
    type: 'wait',
    reason: typingIsRecent ? 'typing' : 'debouncing',
    // typing 可以把这次等待往后延，但整批消息仍受同一个 deadline 约束。
    delayMs: Math.min(preferredDelayMs, Math.max(0, deadlineMs - nowMs)),
    deadlineMs,
  };
};

export const createDriverScheduler = (
  scope: DriverSchedulerScope,
  options: DriverSchedulerOptions,
) => {
  const now = options.now ?? Date.now;
  const state = scope.scheduler;
  let stopped = false;
  const stateController = createSchedulerStateController(state, {
    maxDelayMs: options.maxDelayMs,
    now,
  });

  const readSnapshot = (): SchedulingSnapshot => ({
    rc: scope.rc(),
    offline: scope.offline(),
    running: scope.running(),
    chatLoopBlocked: scope.chatLoopBlocked(),
    lastProcessedMs: scope.lastProcessedMs(),
    lastTRInterrupted: scope.lastTRInterrupted(),
    failedRc: scope.failedRc(),
    focusMode: scope.focusMode(),
    debounceWaiting: state.debounceWaiting,
    replyBatchDeadlineMs: state.replyBatchDeadlineMs,
    startNextDebounceWithExtendDelay: state.startNextDebounceWithExtendDelay,
    lastTypingAtMs: state.lastTypingAtMs,
    activeRunRc: state.activeRunRc,
    activeRunInterruptCursorMs: state.activeRunInterruptCursorMs,
  });

  const notifyDebounceStopped = (): void => {
    if (state.debounceWaiting)
      options.onDebounceStateChange?.(scope.chatId, false);
  };

  /**
   * interrupt 决定走到这里时，当前 Turn 仍然属于这批消息。
   * 普通情况下 AbortController 会结束调用；abort lock 生效时，
   * pendingAbort 会把这次中断留到受保护区段结束之后。
   */
  const interruptActiveRun = (decision: Extract<SchedulingDecision, { type: 'interrupt' }>): void => {
    if (decision.reason === 'new-input') {
      stateController.markInterruptedByInput();
      if (decision.deadlineMs != null)
        state.replyBatchDeadlineMs = decision.deadlineMs;
    }
    const activeTurn = scope.getActiveTurn?.();
    if (activeTurn && decision.reason === 'new-input')
      activeTurn.flags.interruptedByInput = true;
    if (state.abortLocked) {
      state.pendingAbort = true;
      return;
    }
    if (state.abortController) {
      const message = decision.reason === 'compaction'
        ? 'Context compaction requested, aborting current call'
        : 'New messages arrived, aborting current call';
      state.abortController.abort(new Error(message));
      state.abortController = null;
    }
  };

  /**
   * 到这里时，“该不该做”已经判断完了，剩下的是把决定落到运行状态。
   * idle 结束当前等待，wait 约定下一次判断，interrupt 通知活动 Turn 收尾，
   * start 则占住 chat loop，把这一轮交给 runner。
   */
  const applyDecision = (decision: SchedulingDecision): void => {
    switch (decision.type) {
    case 'idle':
      notifyDebounceStopped();
      if (decision.resetBatch) {
        stateController.resetIdleBatch();
        if (scope.focusMode()) scope.focusMode(false);
      } else {
        stateController.clearWaitingState();
      }
      return;

    case 'wait': {
      state.replyBatchDeadlineMs = decision.deadlineMs;
      state.startNextDebounceWithExtendDelay = false;
      if (!state.debounceWaiting) {
        state.debounceWaiting = true;
        options.onDebounceStateChange?.(scope.chatId, true);
      }
      stateController.clearDebounceTimers();
      state.debounceWaiting = true;
      state.debounceTimer = setTimeout(() => {
        state.debounceTimer = undefined;
        // Timer 只负责把调度器叫醒；等待期间发生的变化会由新快照统一判断。
        evaluateAndApply('timer');
      }, decision.delayMs);
      options.log.withFields({
        chatId: scope.chatId,
        debounceDelayMs: decision.delayMs,
        initialDelayMs: options.initialDelayMs,
        typingExtendMs: options.typingExtendMs,
        maxDelayMs: options.maxDelayMs,
        replyBatchDeadlineMs: state.replyBatchDeadlineMs,
        reason: decision.reason,
      }).log('Debounce scheduled');
      return;
    }

    case 'interrupt':
      notifyDebounceStopped();
      stateController.clearWaitingState();
      interruptActiveRun(decision);
      return;

    case 'start':
      notifyDebounceStopped();
      stateController.clearWaitingState();
      {
        const turn = beginTurn();
        if (turn) options.startTurn(turn);
      }
      return;
    }
  };

  /**
   * 不管变化来自消息、typing、Timer 还是 Turn 收尾，
   * 到这里以后走的都是同一段“拍快照、做判断、执行答案”。
   */
  const evaluateAndApply = (cause: SchedulingCause): void => {
    if (stopped) return;
    const decision = evaluateScheduling(readSnapshot(), cause, now(), {
      initialDelayMs: options.initialDelayMs,
      typingExtendMs: options.typingExtendMs,
      maxDelayMs: options.maxDelayMs,
    });
    applyDecision(decision);
  };

  /** 新 RC 到这里时已经写入 scope，接下来会重新判断它是否值得一次回复。 */
  const onContextUpdated = (): void => {
    evaluateAndApply('context-updated');
  };

  /** typing 只留下最近活动时间，具体要等多久仍由同一套调度策略决定。 */
  const notifyTyping = (): void => {
    state.lastTypingAtMs = now();
    evaluateAndApply('typing');
  };

  /** 已经进入等待后，外部延长请求和 typing 走的是同一条路径。 */
  const extendDebounce = (): void => {
    evaluateAndApply('typing');
  };

  /** offline 状态一变，mention 和 reply 的回复资格也会跟着重新计算。 */
  const setOffline = (offline: boolean): void => {
    scope.offline(offline);
    evaluateAndApply('offline-changed');
  };

  /** compaction 接管或交还 chat loop 时，当前 Turn 的去留会马上重新判断。 */
  const setChatLoopBlocked = (blocked: boolean): void => {
    scope.chatLoopBlocked(blocked);
    evaluateAndApply('compaction-changed');
  };

  /** 持久化状态晚于 Scope 恢复时，当前 RC 会带着补齐后的信息再判断一次。 */
  const onStateUpdated = (): void => {
    evaluateAndApply('state-updated');
  };

  function beginTurn(): StartedTurnInfo | null {
    // 所有启动来源都会经过这次检查，因此同一 chat 同时只有一个 Turn。
    if (scope.running() || scope.chatLoopBlocked()) return null;
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
  }

  const finishTurn = (abortController: AbortController, wasOffline: boolean): void => {
    stateController.onTurnSettled();
    clearAbortController(abortController);
    if (scope.focusMode()) scope.focusMode(false);
    if (wasOffline) scope.offline(false);
    scope.running(false);
    evaluateAndApply('turn-settled');
  };

  const attachAbortController = (abortController: AbortController): void => {
    state.abortController = abortController;
  };

  const clearAbortController = (abortController?: AbortController): void => {
    if (!abortController || state.abortController === abortController)
      state.abortController = null;
  };

  /** Scheduler 停止后，等待 Timer、debounce 状态和中断引用一起结束生命周期。 */
  const stop = (): void => {
    stopped = true;
    notifyDebounceStopped();
    stateController.clearWaitingState();
    state.abortController = null;
  };

  return {
    ...stateController,
    beginTurn,
    attachAbortController,
    clearAbortController,
    extendDebounce,
    notifyTyping,
    onContextUpdated,
    onStateUpdated,
    setOffline,
    setChatLoopBlocked,
    finishTurn,
    markFailed: (rc: RenderedContext) => scope.failedRc(rc),
    wake: () => evaluateAndApply('wake'),
    stop,
  };
};
