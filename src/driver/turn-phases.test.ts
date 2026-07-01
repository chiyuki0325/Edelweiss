import { describe, expect, it, vi } from 'vitest';

import { TurnPreparationSkipped } from './turn-features';
import { runTurn, type TurnPhases } from './turn-phases';
import { createDefaultTurnCapabilities } from './turn-state';
import type { ChatScope, TurnState } from './turn-state';

const createTurn = (): TurnState => ({
  id: 'turn-1',
  kind: 'main',
  chatId: 'chat',
  agentId: 'main',
  scope: {} as ChatScope,
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

const createPhases = (overrides: Partial<TurnPhases> = {}): TurnPhases => ({
  prepareTurn: vi.fn(),
  runSteps: vi.fn(),
  finishTurn: vi.fn(),
  failTurn: vi.fn(),
  cleanupTurn: vi.fn(),
  ...overrides,
});

describe('runTurn', () => {
  it('routes real errors through failTurn and cleanupTurn', async () => {
    const turn = createTurn();
    const error = new Error('boom');
    const phases = createPhases({
      runSteps: vi.fn(async () => { throw error; }),
    });

    await expect(runTurn(turn, phases)).rejects.toThrow(error);

    expect(phases.failTurn).toHaveBeenCalledWith(expect.objectContaining({ turn }), error);
    expect(phases.cleanupTurn).toHaveBeenCalledWith(expect.objectContaining({ turn }));
    expect(phases.finishTurn).not.toHaveBeenCalled();
  });

  it('treats aborts as silent interruptions', async () => {
    const turn = createTurn();
    const phases = createPhases({
      prepareTurn: vi.fn(async () => {
        turn.abortController.abort(new Error('interrupted'));
      }),
    });

    await runTurn(turn, phases);

    expect(turn.flags.interruptedByInput).toBe(true);
    expect(phases.runSteps).not.toHaveBeenCalled();
    expect(phases.failTurn).not.toHaveBeenCalled();
    expect(phases.cleanupTurn).toHaveBeenCalledWith(expect.objectContaining({ turn }));
  });

  it('skips empty prepared turns without marking failure', async () => {
    const turn = createTurn();
    const phases = createPhases({
      prepareTurn: vi.fn(async () => { throw new TurnPreparationSkipped(); }),
    });

    await runTurn(turn, phases);

    expect(phases.runSteps).not.toHaveBeenCalled();
    expect(phases.failTurn).not.toHaveBeenCalled();
    expect(phases.cleanupTurn).toHaveBeenCalledWith(expect.objectContaining({ turn }));
  });
});
