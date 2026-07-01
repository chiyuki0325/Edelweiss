import { signal } from 'alien-signals';
import { describe, expect, it } from 'vitest';

import { createEnterFocusTool } from './focus-mode';
import { createDefaultTurnCapabilities } from '../turn-state';
import type { TurnState } from '../turn-state';

const createTurn = (): TurnState => ({
  id: 'test',
  kind: 'main',
  chatId: 'chat',
  agentId: 'main',
  scope: null as unknown as TurnState['scope'],
  model: { apiBaseUrl: '', apiKey: '', model: '' },
  rcAtStart: [],
  trs: [],
  entries: [],
  system: '',
  tools: [],
  step: 1,
  maxSteps: Infinity,
  pendingPrune: false,
  abortController: new AbortController(),
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
});

describe('createEnterFocusTool', () => {
  it('sets focusMode signal and turn flag, returns requiresFollowUp', async () => {
    const focusMode = signal(false);
    const turn = createTurn();
    const tool = createEnterFocusTool({ focusMode, getActiveTurn: () => turn });

    const result = await tool.execute({}, { toolCallId: 'tc1' });

    expect(focusMode()).toBe(true);
    expect(turn.flags.inFocusMode).toBe(true);
    expect(result.requiresFollowUp).toBe(true);
    expect(JSON.parse(result.content as string)).toEqual({ ok: true });
  });

  it('does not throw when no active turn', async () => {
    const focusMode = signal(false);
    const tool = createEnterFocusTool({ focusMode, getActiveTurn: () => null });

    const result = await tool.execute({}, { toolCallId: 'tc1' });

    expect(focusMode()).toBe(true);
    expect(result.requiresFollowUp).toBe(true);
  });
});
