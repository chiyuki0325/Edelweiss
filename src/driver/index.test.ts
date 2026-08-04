import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDriver } from './index';
import type { ResolvedChatConfig, RuntimeConfig } from '../config/config';
import { setupLogger, useLogger } from '../config/logger';
import type { LlmEndpoint, Usage } from '../llm/types';
import type { RenderedContext } from '../rendering/types';

const mocks = vi.hoisted(() => ({
  renderLateBindingPrompt: vi.fn(async () => 'late-binding'),
  renderSubagentSystemPrompt: vi.fn(async () => 'subagent-system'),
  renderSystemPrompt: vi.fn(async () => 'system'),
  callModelStep: vi.fn(),
  executeToolStep: vi.fn(async () => []),
  runCompaction: vi.fn(),
}));

vi.mock('./compaction', () => ({
  runCompaction: mocks.runCompaction,
}));

vi.mock('./prompt', () => ({
  renderLateBindingPrompt: mocks.renderLateBindingPrompt,
  renderSubagentSystemPrompt: mocks.renderSubagentSystemPrompt,
  renderSystemPrompt: mocks.renderSystemPrompt,
}));

vi.mock('./runner', () => ({
  createRunner: vi.fn(() => ({
    callModelStep: mocks.callModelStep,
    executeToolStep: mocks.executeToolStep,
  })),
  pruneLengthLimitFailures: (entries: unknown[], pendingPrune: boolean) => ({ pruned: entries, pendingPrune }),
}));

setupLogger();

const endpoint: LlmEndpoint = {
  apiBaseUrl: 'https://llm.example.test',
  apiKey: 'test-key',
  model: 'test-model',
};

const runtimeConfig: RuntimeConfig = {
  shell: ['bash', '-lc'],
  writeFile: ['tee'],
  readFile: ['cat'],
  writeFileSizeLimit: 1024,
  readFileSizeLimit: 1024,
};

const usage: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: -1,
  cacheReadTokens: -1,
};

const chatConfig = (debounce: ResolvedChatConfig['debounce']): ResolvedChatConfig => ({
  platform: 'telegram',
  primaryModel: endpoint,
  primaryApiFormat: 'openai-chat',
  systemFiles: [],
  compaction: {
    maxContextEstTokens: 100_000,
    workingWindowEstTokens: 50_000,
  },
  subagents: {
    enabled: false,
    model: endpoint,
    apiFormat: 'openai-chat',
    maxConcurrent: 0,
    maxSteps: 0,
  },
  imageToText: {
    enabled: false,
    compress: false,
    pixelBudget: 75_000,
  },
  animationToText: {
    enabled: false,
    maxFrames: 0,
  },
  customEmojiToText: {
    enabled: false,
    maxFrames: 0,
  },
  debounce,
  blockedUserIds: [],
  humanLikeness: {
    trailingPeriod: false,
    denseClausePunctuation: false,
    multipleMarkdownBold: false,
    markdownList: false,
    markdownHeader: false,
    newline: false,
    notErshi: false,
  },
  tools: {
    bash: {
      backgroundThresholdSec: 30,
      compactOutput: false,
    },
    webSearch: {
      tavilyKey: '',
    },
  },
});

const rc = (...receivedAtMs: number[]): RenderedContext =>
  receivedAtMs.map(ms => ({
    receivedAtMs: ms,
    content: [{ type: 'text' as const, text: `message ${ms}` }],
  }));

const waitForAbort = async (signal?: AbortSignal) => {
  if (!signal || signal.aborted) return;
  await new Promise<void>(resolve => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
};

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
};

const createTestDriver = (
  debounce: ResolvedChatConfig['debounce'],
  onDebounceStateChange?: (chatId: string, isDebouncing: boolean) => void,
  overrides: Partial<Parameters<typeof createDriver>[1]> = {},
) => createDriver({
  chatIds: ['chat'],
  resolveChatConfig: () => chatConfig(debounce),
}, {
  loadTurnResponses: async () => [],
  persistTurnResponse: async () => {},
  sendMessage: async () => ({ messageId: 1, date: 1 }),
  loadCompaction: () => null,
  persistCompaction: () => {},
  setCompactCursor: () => undefined,
  runtimeConfig,
  loadMessageAttachments: () => undefined,
  downloadFile: async () => Buffer.alloc(0),
  resolveModel: () => endpoint,
  backgroundTask: {
    startTask: () => 1,
    killTask: () => ({ ok: true }),
    getActiveTasks: () => [],
    readTaskOutput: async () => ({ content: '', totalLines: 0, truncated: false }),
  },
  onDebounceStateChange,
  logger: useLogger('test'),
  ...overrides,
});

describe('createDriver debounce scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    mocks.renderLateBindingPrompt.mockClear();
    mocks.renderSubagentSystemPrompt.mockClear();
    mocks.renderSystemPrompt.mockClear();
    mocks.callModelStep.mockReset();
    mocks.executeToolStep.mockClear();
    mocks.runCompaction.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses typingExtendMs after new messages interrupt a running call', async () => {
    const debounceStates: Array<{ chatId: string; isDebouncing: boolean }> = [];
    let runCount = 0;
    let firstRunFinished!: () => void;
    const firstRunStopped = new Promise<void>(resolve => {
      firstRunFinished = resolve;
    });

    mocks.callModelStep.mockImplementation(async (_working, params) => {
      runCount++;
      if (runCount === 1) {
        await waitForAbort(params.signal);
        firstRunFinished();
        return { entries: [], toolCalls: [], usage, requestedAtMs: 0 };
      }
      return { entries: [], toolCalls: [], usage, requestedAtMs: Date.now() };
    });

    const driver = createTestDriver({
      initialDelayMs: 1000,
      typingExtendMs: 200,
      maxDelayMs: 5000,
      typingExemptUsers: [],
    }, (chatId, isDebouncing) => {
      debounceStates.push({ chatId, isDebouncing });
    }, {
      getChatName: vi.fn(async () => 'Test Chat'),
    });

    try {
      driver.handleEvent('chat', rc(100));
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.callModelStep).toHaveBeenCalledTimes(1);
      expect(mocks.renderSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({
        chatId: 'chat',
        chatName: 'Test Chat',
      }));

      driver.handleEvent('chat', rc(100, 200));
      const firstCall = mocks.callModelStep.mock.calls[0]![1] as { signal: AbortSignal };
      expect(firstCall.signal.aborted).toBe(true);
      await firstRunStopped;
      await vi.advanceTimersByTimeAsync(0);
      expect(debounceStates.at(-1)).toEqual({ chatId: 'chat', isDebouncing: true });

      await vi.advanceTimersByTimeAsync(199);
      expect(mocks.callModelStep).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.callModelStep).toHaveBeenCalledTimes(2);
    } finally {
      driver.stop();
    }
  });

  it('keeps the maxDelayMs deadline across interrupted calls', async () => {
    const secondRun = deferred();
    let runCount = 0;

    mocks.callModelStep.mockImplementation(async (_working, params) => {
      runCount++;
      if (runCount === 1) {
        await waitForAbort(params.signal);
        return { entries: [], toolCalls: [], usage, requestedAtMs: 0 };
      }
      if (runCount === 2) {
        await secondRun.promise;
        return { entries: [], toolCalls: [], usage, requestedAtMs: Date.now() };
      }
      return { entries: [], toolCalls: [], usage, requestedAtMs: Date.now() };
    });

    const driver = createTestDriver({
      initialDelayMs: 1000,
      typingExtendMs: 5000,
      maxDelayMs: 3000,
      typingExemptUsers: [],
    });

    try {
      driver.handleEvent('chat', rc(100));
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.callModelStep).toHaveBeenCalledTimes(1);

      driver.handleEvent('chat', rc(100, 200));
      const firstCall = mocks.callModelStep.mock.calls[0]![1] as { signal: AbortSignal };
      expect(firstCall.signal.aborted).toBe(true);

      // The first message's maxDelayMs deadline is still t+3000. The
      // interrupted retry must not wait a fresh typingExtendMs window.
      await vi.advanceTimersByTimeAsync(1999);
      expect(mocks.callModelStep).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.callModelStep).toHaveBeenCalledTimes(2);

      const secondCall = mocks.callModelStep.mock.calls[1]![1] as { signal: AbortSignal };
      driver.handleEvent('chat', rc(100, 200, 300));
      expect(secondCall.signal.aborted).toBe(false);

      secondRun.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.callModelStep).toHaveBeenCalledTimes(2);
    } finally {
      driver.stop();
    }
  });

  it('aborts turns while preparing reaction capabilities', async () => {
    let refreshCount = 0;
    const refreshAllowedReactionEmojis = vi.fn(async (_chatId: string, signal?: AbortSignal) => {
      refreshCount++;
      if (refreshCount === 1) {
        await waitForAbort(signal);
        return ['👍'];
      }
      return ['👍'];
    });

    mocks.callModelStep.mockResolvedValue({
      entries: [],
      toolCalls: [],
      usage,
      requestedAtMs: Date.now(),
    });

    const driver = createTestDriver({
      initialDelayMs: 1000,
      typingExtendMs: 200,
      maxDelayMs: 5000,
      typingExemptUsers: [],
    }, undefined, {
      refreshAllowedReactionEmojis,
      getAllowedReactionEmojis: () => [],
    });

    try {
      driver.handleEvent('chat', rc(100));
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(refreshAllowedReactionEmojis).toHaveBeenCalledTimes(1);
      expect(mocks.callModelStep).not.toHaveBeenCalled();

      driver.handleEvent('chat', rc(100, 200));
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.callModelStep).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(199);
      expect(mocks.callModelStep).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(refreshAllowedReactionEmojis).toHaveBeenCalledTimes(2);
      expect(mocks.callModelStep).toHaveBeenCalledTimes(1);
    } finally {
      driver.stop();
    }
  });

  it('manually compacts eligible history below the automatic high-water mark', async () => {
    const persistCompaction = vi.fn();
    mocks.runCompaction.mockImplementation(async params => ({
      oldCursorMs: params.oldCursorMs,
      newCursorMs: params.newCursorMs,
      summary: 'summary',
      inputTokens: 10,
      outputTokens: 5,
    }));
    const driver = createTestDriver({
      initialDelayMs: 1000,
      typingExtendMs: 200,
      maxDelayMs: 5000,
      typingExemptUsers: [],
    }, undefined, { persistCompaction });

    try {
      driver.handleEvent('chat', [
        { receivedAtMs: 50, content: [{ type: 'text', text: 'x'.repeat(20_000) }] },
        { receivedAtMs: 100, content: [{ type: 'text', text: 'x'.repeat(110_000) }] },
        { receivedAtMs: 200, content: [{ type: 'text', text: 'recent' }] },
      ]);

      await expect(driver.requestCompaction('chat')).resolves.toMatchObject({ status: 'completed' });
      expect(mocks.runCompaction).toHaveBeenCalledOnce();
      expect(mocks.runCompaction).toHaveBeenCalledWith(expect.objectContaining({
        chatId: 'chat',
        oldCursorMs: 0,
        newCursorMs: 100,
        rcWindow: [{ receivedAtMs: 50, content: [{ type: 'text', text: 'x'.repeat(20_000) }] }],
      }));
      expect(persistCompaction).toHaveBeenCalledOnce();
    } finally {
      driver.stop();
    }
  });

  it('blocks the chat loop and queues new messages until manual compaction finishes', async () => {
    const completion = deferred<{
      oldCursorMs: number;
      newCursorMs: number;
      summary: string;
      inputTokens: number;
      outputTokens: number;
    }>();
    let callCount = 0;
    mocks.callModelStep.mockImplementation(async (_working, params) => {
      callCount++;
      if (callCount === 1) await waitForAbort(params.signal);
      return { entries: [], toolCalls: [], usage, requestedAtMs: Date.now() };
    });
    mocks.runCompaction.mockImplementation(() => completion.promise);
    const driver = createTestDriver({
      initialDelayMs: 1000,
      typingExtendMs: 200,
      maxDelayMs: 5000,
      typingExemptUsers: [],
    });

    try {
      const initialRc: RenderedContext = [
        { receivedAtMs: 50, content: [{ type: 'text', text: 'x'.repeat(20_000) }] },
        { receivedAtMs: 100, content: [{ type: 'text', text: 'x'.repeat(110_000) }] },
        { receivedAtMs: 200, content: [{ type: 'text', text: 'recent' }] },
      ];
      driver.handleEvent('chat', initialRc);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(mocks.callModelStep).toHaveBeenCalledOnce();

      const firstCall = mocks.callModelStep.mock.calls[0]![1] as { signal: AbortSignal };
      const compaction = driver.requestCompaction('chat');
      expect(firstCall.signal.aborted).toBe(true);
      await vi.waitFor(() => expect(mocks.runCompaction).toHaveBeenCalledOnce());

      driver.handleEvent('chat', [
        ...initialRc,
        { receivedAtMs: 300, content: [{ type: 'text', text: 'arrived while compacting' }] },
      ]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.callModelStep).toHaveBeenCalledOnce();

      completion.resolve({
        oldCursorMs: 0,
        newCursorMs: 100,
        summary: 'summary',
        inputTokens: 10,
        outputTokens: 5,
      });
      await expect(compaction).resolves.toMatchObject({ status: 'completed' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(mocks.callModelStep).toHaveBeenCalledTimes(2);
    } finally {
      driver.stop();
    }
  });

  it('skips manual compaction when all context fits in the working window', async () => {
    const driver = createTestDriver({
      initialDelayMs: 1000,
      typingExtendMs: 200,
      maxDelayMs: 5000,
      typingExemptUsers: [],
    });

    try {
      driver.handleEvent('chat', rc(100, 200));
      await expect(driver.requestCompaction('chat')).resolves.toEqual({
        status: 'skipped',
        reason: 'within_working_window',
      });
      expect(mocks.runCompaction).not.toHaveBeenCalled();
    } finally {
      driver.stop();
    }
  });

  it('shares one in-flight task across concurrent manual compaction requests', async () => {
    const completion = deferred<{
      oldCursorMs: number;
      newCursorMs: number;
      summary: string;
      inputTokens: number;
      outputTokens: number;
    }>();
    mocks.runCompaction.mockImplementation(() => completion.promise);
    const driver = createTestDriver({
      initialDelayMs: 1000,
      typingExtendMs: 200,
      maxDelayMs: 5000,
      typingExemptUsers: [],
    });

    try {
      driver.handleEvent('chat', [
        { receivedAtMs: 50, content: [{ type: 'text', text: 'x'.repeat(20_000) }] },
        { receivedAtMs: 100, content: [{ type: 'text', text: 'x'.repeat(110_000) }] },
        { receivedAtMs: 200, content: [{ type: 'text', text: 'recent' }] },
      ]);

      const first = driver.requestCompaction('chat');
      const second = driver.requestCompaction('chat');
      expect(second).toBe(first);
      await vi.waitFor(() => expect(mocks.runCompaction).toHaveBeenCalledOnce());

      completion.resolve({
        oldCursorMs: 0,
        newCursorMs: 100,
        summary: 'summary',
        inputTokens: 10,
        outputTokens: 5,
      });
      await expect(first).resolves.toMatchObject({ status: 'completed' });
      await expect(second).resolves.toMatchObject({ status: 'completed' });
    } finally {
      driver.stop();
    }
  });
});
