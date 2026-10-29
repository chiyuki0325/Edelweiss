import type { Logger } from '@guiiai/logg';
import { describe, expect, it, vi } from 'vitest';

import { aiMessage, humanMessage, toolMessage, type DriverMessage, type DriverToolCall } from './messages';
import { createTurnContext } from './turn-features';
import { runTurnStepLoop } from './turn-loop';
import { createDefaultTurnCapabilities } from './turn-state';
import type { ChatScope, TurnState } from './turn-state';
import type { Usage } from '../llm/types';

const log = {
  withFields: vi.fn(() => log),
  log: vi.fn(),
} as unknown as Logger;

const usage: Usage = {
  inputTokens: 1,
  outputTokens: 2,
  cacheCreationTokens: -1,
  cacheReadTokens: -1,
};

const userText = (text: string): DriverMessage => humanMessage(text);

const assistantToolCall = (text: string) =>
  aiMessage({ content: text, tool_calls: [{ id: 'call-1', name: 'tool', args: {} }] });

const toolResult = (payload: string, requiresFollowUp: boolean) =>
  toolMessage('call-1', payload, requiresFollowUp);

const createTurn = (): TurnState => ({
  id: 'turn-1',
  kind: 'main',
  chatId: 'chat',
  agentId: 'main',
  scope: {} as ChatScope,
  model: {
    apiBaseUrl: 'https://llm.example.test',
    apiKey: 'key',
    model: 'model',
  },
  rcAtStart: [],
  trs: [],
  entries: [userText('initial')],
  system: 'system',
  tools: [],
  step: 1,
  maxSteps: 2,
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

describe('runTurnStepLoop', () => {
  it('persists transformed entries while continuing with raw entries', async () => {
    const turn = createTurn();
    const rawMessage = assistantToolCall('raw thinking');
    const rawToolResult = toolResult('needs follow-up', true);
    const rawEntries = [rawMessage, rawToolResult];
    const persistedEntries = [toolResult('persisted only', true)];
    const seenWorkingLengths: number[] = [];
    const afterModelCall = vi.fn();
    const afterToolResults = vi.fn();
    const runner = {
      callModelStep: vi.fn(async (working: DriverMessage[]) => {
        seenWorkingLengths.push(working.length);
        if (seenWorkingLengths.length === 1) {
          return {
            entries: [rawMessage],
            toolCalls: [rawMessage.tool_calls![0]! as DriverToolCall],
            usage,
            requestedAtMs: 100,
          };
        }
        return {
          entries: [],
          toolCalls: [],
          usage,
          requestedAtMs: 200,
        };
      }),
      executeToolStep: vi.fn(async () =>
        seenWorkingLengths.length === 1 ? [rawToolResult] : []),
    };
    const persisted: DriverMessage[][] = [];

    await runTurnStepLoop(createTurnContext(turn), {
      runner,
      executorChatId: 'chat',
      log,
      features: [{
        name: 'observer',
        afterModelCall,
        afterToolResults,
      }],
      transformStepEntries: () => persistedEntries,
      persistStep: (_, step) => {
        persisted.push(step.persistedEntries);
      },
    });

    expect(seenWorkingLengths).toEqual([1, 3]);
    expect(persisted).toEqual([persistedEntries, []]);
    expect(turn.entries).toEqual([userText('initial'), ...rawEntries]);
    expect(turn.flags.modelStayedSilent).toBe(true);
    expect(afterModelCall).toHaveBeenCalledTimes(2);
    expect(afterToolResults).toHaveBeenCalledTimes(1);
  });
});
