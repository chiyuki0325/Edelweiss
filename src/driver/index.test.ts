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
  runStepLoop: vi.fn(),
}));

vi.mock('./prompt', () => ({
  renderLateBindingPrompt: mocks.renderLateBindingPrompt,
  renderSubagentSystemPrompt: mocks.renderSubagentSystemPrompt,
  renderSystemPrompt: mocks.renderSystemPrompt,
}));

vi.mock('./runner', () => ({
  createRunner: vi.fn(() => ({ runStepLoop: mocks.runStepLoop })),
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
});

describe('createDriver debounce scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    mocks.renderLateBindingPrompt.mockClear();
    mocks.renderSubagentSystemPrompt.mockClear();
    mocks.renderSystemPrompt.mockClear();
    mocks.runStepLoop.mockReset();
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

    mocks.runStepLoop.mockImplementation(async params => {
      runCount++;
      if (runCount === 1) {
        await waitForAbort(params.signal);
        firstRunFinished();
        return;
      }
      await params.onStepComplete([], usage, Date.now());
    });

    const driver = createTestDriver({
      initialDelayMs: 1000,
      typingExtendMs: 200,
      maxDelayMs: 5000,
      typingExemptUsers: [],
    }, (chatId, isDebouncing) => {
      debounceStates.push({ chatId, isDebouncing });
    });

    try {
      driver.handleEvent('chat', rc(100));
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.runStepLoop).toHaveBeenCalledTimes(1);

      driver.handleEvent('chat', rc(100, 200));
      const firstCall = mocks.runStepLoop.mock.calls[0]![0] as { signal: AbortSignal };
      expect(firstCall.signal.aborted).toBe(true);
      await firstRunStopped;
      await vi.advanceTimersByTimeAsync(0);
      expect(debounceStates.at(-1)).toEqual({ chatId: 'chat', isDebouncing: true });

      await vi.advanceTimersByTimeAsync(199);
      expect(mocks.runStepLoop).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.runStepLoop).toHaveBeenCalledTimes(2);
    } finally {
      driver.stop();
    }
  });

  it('keeps the maxDelayMs deadline across interrupted calls', async () => {
    const secondRun = deferred();
    let runCount = 0;

    mocks.runStepLoop.mockImplementation(async params => {
      runCount++;
      if (runCount === 1) {
        await waitForAbort(params.signal);
        return;
      }
      if (runCount === 2) {
        await secondRun.promise;
        await params.onStepComplete([], usage, Date.now());
        return;
      }
      await params.onStepComplete([], usage, Date.now());
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
      expect(mocks.runStepLoop).toHaveBeenCalledTimes(1);

      driver.handleEvent('chat', rc(100, 200));
      const firstCall = mocks.runStepLoop.mock.calls[0]![0] as { signal: AbortSignal };
      expect(firstCall.signal.aborted).toBe(true);

      // The first message's maxDelayMs deadline is still t+3000. The
      // interrupted retry must not wait a fresh typingExtendMs window.
      await vi.advanceTimersByTimeAsync(1999);
      expect(mocks.runStepLoop).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.runStepLoop).toHaveBeenCalledTimes(2);

      const secondCall = mocks.runStepLoop.mock.calls[1]![0] as { signal: AbortSignal };
      driver.handleEvent('chat', rc(100, 200, 300));
      expect(secondCall.signal.aborted).toBe(false);

      secondRun.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.runStepLoop).toHaveBeenCalledTimes(2);
    } finally {
      driver.stop();
    }
  });
});
