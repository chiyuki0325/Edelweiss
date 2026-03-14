import { mkdirSync, writeFileSync } from 'node:fs';

import type { Logger } from '@guiiai/logg';
import type { Message, Tool } from 'xsai';
import { chat, responseJSON } from 'xsai';

const DUMP_DIR = '/tmp/cahciua';
mkdirSync(DUMP_DIR, { recursive: true });

type AnyMsg = Record<string, any>;

export interface RunnerConfig {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
}

export const createRunner = (config: RunnerConfig) => {
  const chatCompletion = async (params: {
    messages: Message[];
    system?: string;
    tools?: Tool[];
  }) => {
    const res = await chat({
      baseURL: config.apiBaseUrl,
      apiKey: config.apiKey,
      model: config.model,
      messages: params.messages,
      tools: params.tools,
      system: params.system,
    });

    return await responseJSON<{
      choices: Array<{ finish_reason: string; message: AnyMsg }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    }>(res);
  };

  const runStepLoop = async (params: {
    chatId: string;
    messages: Message[];
    system: string;
    tools: Tool[];
    maxSteps: number;
    onStepComplete: (stepData: unknown[], usage: { prompt_tokens: number; completion_tokens: number }, requestedAtMs: number) => void;
    checkInterrupt: () => boolean;
    log: Logger;
  }): Promise<void> => {
    let currentMessages = params.messages;
    let step = 0;

    while (step < params.maxSteps) {
      step++;

      writeFileSync(`${DUMP_DIR}/${params.chatId}.request.json`, JSON.stringify({
        model: config.model,
        system: params.system,
        messages: currentMessages,
        tools: params.tools.map(t => ({ type: t.type, function: t.function })),
      }, null, 2));

      // Capture timestamp BEFORE the API call so events arriving during
      // the (potentially slow) request have receivedAtMs > requestedAtMs
      // and won't be missed by the self-loop check on the next turn.
      const stepRequestedAt = Date.now();

      const response = await chatCompletion({
        messages: currentMessages,
        system: params.system,
        tools: params.tools,
      });
      const choice = response.choices[0];

      if (!choice) {
        // Model stayed silent — persist empty TR to advance lastTrTime
        params.log.withFields({ chatId: params.chatId, step }).log('Model chose to stay silent (no choices)');
        params.onStepComplete([], response.usage, stepRequestedAt);
        break;
      }

      const assistantMsg = choice.message;
      const stepData: unknown[] = [assistantMsg];

      // Execute tools manually — we control this so every tool call and result
      // is visible in stepData and persisted in the TR.
      if (assistantMsg.tool_calls?.length) {
        for (const tc of assistantMsg.tool_calls) {
          const tool = params.tools.find(t => t.function.name === tc.function.name);
          try {
            const args = JSON.parse(tc.function.arguments);
            const result = tool
              ? await tool.execute(args, { messages: currentMessages, toolCallId: tc.id })
              : { error: `Unknown tool: ${tc.function.name}` };
            stepData.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: typeof result === 'string' ? result : JSON.stringify(result),
            });
          } catch (err) {
            params.log.withError(err).error(`Tool ${tc.function.name} failed`);
            stepData.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify({ error: String(err) }),
            });
          }
        }
      }

      params.log.withFields({
        chatId: params.chatId,
        step,
        finishReason: choice.finish_reason,
        hasToolCalls: !!assistantMsg.tool_calls?.length,
        newMessages: stepData.length,
        usage: response.usage,
      }).log('Step completed');

      params.onStepComplete(stepData, response.usage, stepRequestedAt);

      // No tool calls -> model is done
      if (!assistantMsg.tool_calls?.length) break;

      // Model wants to continue — check for interruption by new events.
      // The TR we just saved is already durable, so the next run will
      // include it along with the new events.
      if (params.checkInterrupt()) {
        params.log.withFields({ chatId: params.chatId, step }).log('Turn interrupted by new messages');
        break;
      }

      // No interruption — append step data and continue
      currentMessages = [...currentMessages, ...stepData] as Message[];
    }
  };

  return { runStepLoop };
};
