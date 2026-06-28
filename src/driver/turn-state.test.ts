import { describe, expect, it } from 'vitest';

import { createDefaultTurnCapabilities, createSchedulerState } from './turn-state';

describe('driver turn state defaults', () => {
  it('enables chat-facing tools for main turns', () => {
    expect(createDefaultTurnCapabilities('main')).toMatchObject({
      canSendMessage: true,
      canDismissMessage: true,
      canReact: true,
      canStartSubagent: true,
      canMessageSubagent: true,
      canMessageMain: false,
      canFinalizeSubagent: false,
    });
  });

  it('keeps subagent turns isolated from chat-facing tools', () => {
    expect(createDefaultTurnCapabilities('subagent')).toMatchObject({
      canSendMessage: false,
      canDismissMessage: false,
      canReact: false,
      canStartSubagent: false,
      canMessageSubagent: false,
      canMessageMain: true,
      canFinalizeSubagent: true,
    });
  });

  it('initializes scheduler state without active timers or an active run', () => {
    expect(createSchedulerState()).toMatchObject({
      debounceWaiting: false,
      replyBatchDeadlineMs: null,
      startNextDebounceWithExtendDelay: false,
      lastTypingAtMs: 0,
      activeRunInterruptCursorMs: 0,
      activeRunRc: null,
      activeRunInterruptedByInput: false,
      abortController: null,
    });
  });
});
