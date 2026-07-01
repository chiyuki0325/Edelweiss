import { signal } from 'alien-signals';
import { describe, expect, it, vi } from 'vitest';

import { createMainTurnFeatures } from './main';
import type { MainTurnFeatureDeps } from './types';

const createLog = (): MainTurnFeatureDeps['log'] => {
  const logger = {
    withFields: vi.fn(() => logger),
    withError: vi.fn(() => logger),
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger as unknown as MainTurnFeatureDeps['log'];
};

const createDeps = (): MainTurnFeatureDeps => ({
  chatId: 'chat',
  chatConfig: {
    platform: 'telegram',
    primaryModel: {
      apiBaseUrl: '',
      apiKey: '',
      model: 'model',
    },
    primaryApiFormat: 'openai-chat',
    systemFiles: [],
    compaction: {
      maxContextEstTokens: 100_000,
      workingWindowEstTokens: 50_000,
    },
    subagents: {
      enabled: true,
      model: {
        apiBaseUrl: '',
        apiKey: '',
        model: 'model',
      },
      apiFormat: 'openai-chat',
      maxConcurrent: 1,
      maxSteps: 1,
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
    debounce: {
      initialDelayMs: 100,
      typingExtendMs: 100,
      maxDelayMs: 1000,
      typingExemptUsers: [],
    },
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
  },
  log: createLog(),
  rc: () => [],
  offline: vi.fn(),
  running: vi.fn(),
  lastProcessedMs: vi.fn(() => 0) as unknown as MainTurnFeatureDeps['lastProcessedMs'],
  cursorMs: () => undefined,
  summary: () => undefined,
  allSkills: new Map(),
  mailbox: {
    enqueue: vi.fn(),
    flush: vi.fn(() => []),
    poll: vi.fn(),
  } as unknown as MainTurnFeatureDeps['mailbox'],
  subagentManager: {
    mainTools: vi.fn(() => []),
    getSubagentStatus: vi.fn(),
    wakeAgent: vi.fn(),
    startSubagent: vi.fn(),
  } as unknown as MainTurnFeatureDeps['subagentManager'],
  loadTRs: vi.fn(async () => []),
  loadTurnResponses: vi.fn(async () => []),
  persistTurnResponse: vi.fn(),
  createCapabilityTools: vi.fn(() => []),
  createSendMessageTurnFlags: vi.fn(() => ({
    wasLengthLimited: false,
    inFocusMode: false,
  })),
  schedulerController: {
    clearAbortController: vi.fn(),
    markFailed: vi.fn(),
    onTurnSettled: vi.fn(),
  },
  getActiveBackgroundTasks: vi.fn(() => []),
  lastTRInterrupted: signal(false),
  focusMode: signal(false),
  nowString: () => '2026-01-01T00:00:00+00:00',
});

describe('createMainTurnFeatures', () => {
  it('keeps the fixed main-turn feature order visible in one place', () => {
    expect(createMainTurnFeatures(createDeps()).map(feature => feature.name)).toEqual([
      'context',
      'interruption',
      'reaction',
      'capability',
      'tools',
      'skill',
      'human-likeness',
      'prompt',
      'logging',
      'mailbox',
      'send-message',
      'persistence',
      'failure',
      'cleanup',
    ]);
  });
});
