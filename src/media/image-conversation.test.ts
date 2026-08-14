import { describe, expect, it, vi } from 'vitest';

import { createImageConversationManager } from './image-conversation';
import type { ImageConversationModelCallParams, ImageConversationRecord, ImageConversationStore, ImageConversationTurn } from './image-conversation';
import type { LlmEndpoint } from '../llm/types';

const model: LlmEndpoint = { apiBaseUrl: 'https://example.test', apiKey: 'key', model: 'vision' };

const createStore = (): ImageConversationStore & {
  conversations: ImageConversationRecord[];
  turns: Array<ImageConversationTurn & { conversationId: number }>;
} => {
  const conversations: ImageConversationRecord[] = [];
  const turns: Array<ImageConversationTurn & { conversationId: number }> = [];
  return {
    conversations,
    turns,
    load: (chatId, imageId) => conversations.find(c => c.chatId === chatId && c.imageId === imageId) ?? null,
    create: record => {
      const created = { ...record, id: conversations.length + 1 };
      conversations.push(created);
      return created;
    },
    loadTurns: (conversationId, generation) => turns
      .filter(turn => turn.conversationId === conversationId && turn.generation === generation)
      .sort((a, b) => a.sequence - b.sequence),
    appendTurn: params => {
      const conversation = conversations.find(c => c.id === params.conversationId)!;
      expect(conversation.currentGeneration).toBe(params.expectedGeneration);
      const generation = params.reset ? conversation.currentGeneration + 1 : conversation.currentGeneration;
      const sequence = turns.filter(turn => turn.conversationId === conversation.id && turn.generation === generation).length + 1;
      turns.push({ conversationId: conversation.id, generation, sequence, ...params.turn });
      conversation.currentGeneration = generation;
      conversation.updatedAtMs = params.turn.createdAtMs;
      return { generation, sequence };
    },
  };
};

const logger = {
  withContext() { return this; },
} as any;

const startParams = {
  chatId: 'chat',
  sourceKey: 'read_image:file_id:1:0:high',
  imageHash: 'hash',
  preparedImage: Buffer.from('image'),
  systemPrompt: 'THE EXACT HIGH DETAIL PROMPT',
  initialUserText: 'Describe this image.',
  model,
  label: 'read-image',
};

describe('ImageConversationManager', () => {
  it('persists the exact prompt used by the first call and reuses the same identity', async () => {
    const store = createStore();
    const callModel = vi.fn(async ({ systemPrompt }) => ({
      text: `description from ${systemPrompt}`,
      usage: { inputTokens: 10, outputTokens: 5 },
    }));
    const manager = createImageConversationManager({ store, logger, callModel });

    const first = await manager.start(startParams);
    const second = await manager.start(startParams);

    expect(first).toMatchObject({ description: 'description from THE EXACT HIGH DETAIL PROMPT', reused: false });
    expect(second).toMatchObject({ imageId: first.imageId, reused: true });
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(store.conversations[0]).toMatchObject({
      systemPrompt: 'THE EXACT HIGH DETAIL PROMPT',
      initialUserText: 'Describe this image.',
      initialResponse: 'description from THE EXACT HIGH DETAIL PROMPT',
    });
  });

  it('replays the initial image conversation and all turns when asking follow-ups', async () => {
    const store = createStore();
    const calls: any[] = [];
    const manager = createImageConversationManager({
      store,
      logger,
      callModel: async params => {
        calls.push(params);
        return { text: `answer-${calls.length}`, usage: { inputTokens: 20, outputTokens: 3 } };
      },
    });
    const session = await manager.start({ ...startParams, initialResponse: 'initial alt text' });

    await manager.ask({ chatId: 'chat', imageId: session.imageId, question: 'first?', model, maxContextEstTokens: 10_000 });
    await manager.ask({ chatId: 'chat', imageId: session.imageId, question: 'second?', model, maxContextEstTokens: 10_000 });

    expect(calls).toHaveLength(2);
    expect(calls[1].systemPrompt).toBe('THE EXACT HIGH DETAIL PROMPT');
    expect(calls[1].entries.map((entry: any) => entry.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(calls[1].entries[2].parts[0].text).toBe('first?');
    expect(calls[1].entries[3].parts[0].text).toBe('answer-1');
  });

  it('switches generation only after an over-limit reset call succeeds', async () => {
    const store = createStore();
    const callModel = vi.fn(async (_params: ImageConversationModelCallParams) => ({ text: 'new answer', usage: { inputTokens: 10, outputTokens: 2 } }));
    const manager = createImageConversationManager({ store, logger, callModel });
    const session = await manager.start({ ...startParams, initialResponse: 'initial alt text' });

    const result = await manager.ask({ chatId: 'chat', imageId: session.imageId, question: 'question', model, maxContextEstTokens: 1 });

    expect(result.historyReset).toBe(true);
    expect(store.conversations[0]!.currentGeneration).toBe(1);
    expect(store.turns[0]).toMatchObject({ generation: 1, sequence: 1, question: 'question' });
    expect((callModel.mock.calls[0]![0] as any).entries).toHaveLength(3);
  });

  it('keeps the current generation when a reset call fails', async () => {
    const store = createStore();
    const manager = createImageConversationManager({
      store,
      logger,
      callModel: async () => { throw new Error('upstream unavailable'); },
    });
    const session = await manager.start({ ...startParams, initialResponse: 'initial alt text' });

    await expect(manager.ask({ chatId: 'chat', imageId: session.imageId, question: 'question', model, maxContextEstTokens: 1 }))
      .rejects.toThrow('upstream unavailable');
    expect(store.conversations[0]!.currentGeneration).toBe(0);
    expect(store.turns).toHaveLength(0);
  });
});
