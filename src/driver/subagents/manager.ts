import type { Logger } from '@guiiai/logg';

import type { LlmEndpoint, Usage } from '../../llm/types';
import type { ConversationEntry } from '../../unified-api/types';
import type { RunnerConfig } from '../runner';
import { createRunner } from '../runner';
import type { CahciuaTool } from '../tools';
import { createTurnContext } from '../turn-features';
import { runTurnStepLoop } from '../turn-loop';
import { createDefaultTurnCapabilities } from '../turn-state';
import type { ChatScope, TurnState } from '../turn-state';
import type { AgentMailbox } from './mailbox';
import { createFinalizeSubagentTool, createMessageMainTool, createMessageSubagentTool, createStartSubagentTool } from './tools';
import type { AgentId, SubagentState } from './types';

export interface SubagentManagerDeps {
  chatId: string;
  mailbox: AgentMailbox;
  model: LlmEndpoint;
  maxConcurrent: number;
  maxSteps: number;
  getScope: () => ChatScope;
  renderSystemPrompt: (state: SubagentState) => Promise<string>;
  createTools: (subagentId: AgentId) => CahciuaTool[];
  persistStep?: (agentId: AgentId, stepEntries: ConversationEntry[], usage: Usage, requestedAtMs: number) => Promise<void>;
  wakeMain: () => void;
  log: Logger;
}

const toRunnerConfig = (endpoint: LlmEndpoint): RunnerConfig => ({
  apiBaseUrl: endpoint.apiBaseUrl,
  apiKey: endpoint.apiKey,
  model: endpoint.model,
  apiFormat: endpoint.apiFormat ?? 'openai-chat',
  timeoutSec: endpoint.timeoutSec,
  thinking: endpoint.thinking,
  forceToolCall: endpoint.forceToolCall,
});

export const createSubagentManager = (deps: SubagentManagerDeps) => {
  let nextId = 1;
  const states = new Map<AgentId, SubagentState>();
  const runner = createRunner(toRunnerConfig(deps.model));

  const activeCount = () => [...states.values()].filter(s => s.status === 'running' || s.status === 'idle').length;

  const getSubagentStatus = (agentId: AgentId): { exists: boolean; status?: string } => {
    const state = states.get(agentId);
    return state ? { exists: true, status: state.status } : { exists: false };
  };

  const wakeAgent = (agentId: AgentId) => {
    if (agentId === 'main') {
      deps.wakeMain();
      return;
    }
    const state = states.get(agentId);
    if (!state || state.status === 'finalized' || state.status === 'failed') return;
    state.wakeRequested = true;
    void runSubagent(state);
  };

  const finalizeSubagent = (agentId: AgentId, message: string) => {
    const state = states.get(agentId);
    if (!state) return;
    state.status = 'finalized';
    state.finalMessage = message;
    state.updatedAtMs = Date.now();
    state.wakeRequested = false;
  };

  const toolDeps = {
    mailbox: deps.mailbox,
    wakeAgent,
    getSubagentStatus,
    startSubagent: (task: string, context: string | undefined, expectedOutput: string | undefined) => startSubagent(task, context, expectedOutput),
    finalizeSubagent,
    log: deps.log,
  };

  const mainTools = (): CahciuaTool[] => [
    createStartSubagentTool(toolDeps),
    createMessageSubagentTool(toolDeps),
  ];

  const subagentTools = (agentId: AgentId): CahciuaTool[] => [
    ...deps.createTools(agentId),
    createMessageMainTool(toolDeps, agentId),
    createFinalizeSubagentTool(toolDeps, agentId),
  ];

  const createSubagentTurn = async (state: SubagentState): Promise<TurnState> => {
    const scope = deps.getScope();
    return {
      id: `${state.id}-${Date.now()}`,
      kind: 'subagent',
      chatId: deps.chatId,
      agentId: state.id,
      scope,
      model: deps.model,
      rcAtStart: scope.rc(),
      trs: [],
      entries: state.entries,
      system: await deps.renderSystemPrompt(state),
      tools: subagentTools(state.id),
      step: 1,
      maxSteps: deps.maxSteps,
      pendingPrune: false,
      abortController: new AbortController(),
      capabilities: createDefaultTurnCapabilities('subagent'),
      loadedSkills: new Set(),
      reactionEmojis: [],
      flags: {
        wasOfflineAtStart: scope.offline(),
        interruptedByInput: false,
        sendMessageWasLengthLimited: false,
        modelStayedSilent: false,
      },
    };
  };

  const runSubagent = async (state: SubagentState): Promise<void> => {
    if (state.running) return;
    state.running = true;
    state.wakeRequested = false;
    state.status = 'running';
    state.updatedAtMs = Date.now();

    try {
      const turn = await createSubagentTurn(state);
      await runTurnStepLoop(createTurnContext(turn), {
        runner,
        executorChatId: `${deps.chatId}:${state.id}`,
        maxImagesAllowed: turn.model.maxImagesAllowed,
        pullExternalEntries: () => deps.mailbox.flush(state.id),
        shouldStop: () => state.status === 'finalized' || state.status === 'failed',
        persistStep: async (_, step) => {
          state.entries = [...state.entries, ...step.persistedEntries];
          state.updatedAtMs = step.requestedAtMs;
          await deps.persistStep?.(state.id, step.persistedEntries, step.usage, step.requestedAtMs);
        },
        log: deps.log,
      });
      if (state.status === 'running') state.status = 'idle';
    } catch (err) {
      state.status = 'failed';
      state.updatedAtMs = Date.now();
      const message = String(err instanceof Error ? err.message : err);
      deps.mailbox.enqueue({ fromAgentId: state.id, toAgentId: 'main', type: 'error', content: message, final: true });
      deps.wakeMain();
      deps.log.withError(err).error('Subagent failed');
    } finally {
      const status = state.status as SubagentState['status'];
      const shouldRestart = state.wakeRequested && status !== 'finalized' && status !== 'failed';
      state.running = false;
      if (shouldRestart)
        void runSubagent(state);
    }
  };

  function startSubagent(task: string, context: string | undefined, expectedOutput: string | undefined): { ok: true; id: AgentId } | { ok: false; error: string } {
    if (activeCount() >= deps.maxConcurrent)
      return { ok: false, error: `Subagent limit reached (${deps.maxConcurrent}).` };
    const id = `sa-${nextId++}` as AgentId;
    const now = Date.now();
    const state: SubagentState = {
      id,
      task,
      context,
      expectedOutput,
      status: 'running',
      createdAtMs: now,
      updatedAtMs: now,
      entries: [],
      running: false,
      wakeRequested: false,
    };
    states.set(id, state);
    deps.mailbox.enqueue({
      fromAgentId: 'main',
      toAgentId: id,
      type: 'task',
      content: [
        `Task: ${task}`,
        context ? `Context: ${context}` : '',
        expectedOutput ? `Expected output: ${expectedOutput}` : '',
      ].filter(Boolean).join('\n\n'),
    });
    wakeAgent(id);
    return { ok: true, id };
  }

  return { mainTools, getSubagentStatus, wakeAgent, startSubagent };
};

export type SubagentManager = ReturnType<typeof createSubagentManager>;
