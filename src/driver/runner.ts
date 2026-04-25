import { writeFileSync } from 'node:fs';

import type { Logger } from '@guiiai/logg';
import type { Message } from 'xsai';

import { DUMP_DIR, ensureDumpDir } from './constants';
import { prepareChatMessagesForSend, prepareAnthropicMessagesForSend, prepareResponsesInputForSend } from './context';
import { anthropicTRToMessages, responsesOutputToMessages, xsaiToolToAnthropicTool, xsaiToolToResponsesTool } from './convert';
import type { ResponseFunctionCallOutputItem, ResponseInputContent, ResponseInputItem, ResponseOutputFunctionCall, ResponseOutputItem } from './responses-types';
import { streamingChat } from './streaming';
import { streamingAnthropic } from './streaming-anthropic';
import { streamingResponses } from './streaming-responses';
import type { CahciuaTool } from './tools';
import { isToolResult } from './tools';
import type {
  AnthropicAssistantEntry,
  AnthropicTRDataEntry,
  AnthropicToolResultItem,
  ExtendedMessage,
  ProviderFormat,
  ResponsesTRDataItem,
  ThinkingConfig,
  TRAssistantEntry,
  TRDataEntry,
  TRToolResultEntry,
} from './types';

ensureDumpDir();

export interface RunnerConfig {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  apiFormat?: ProviderFormat;
  maxTokens?: number;
  timeoutSec?: number;
  thinking?: ThinkingConfig;
}

interface StepLoopParams {
  chatId: string;
  messages: Message[];
  system: string;
  tools: CahciuaTool[];
  maxSteps: number;
  maxImagesAllowed?: number;
  onStepComplete: (stepData: TRDataEntry[] | ResponsesTRDataItem[] | AnthropicTRDataEntry[], usage: { prompt_tokens: number; completion_tokens: number }, requestedAtMs: number) => void;
  checkInterrupt: () => boolean;
  log: Logger;
}

// Execute a tool call and return { id, content, requiresFollowUp }.
// Shared by both openai-chat and responses step loops.
const executeToolCall = async (
  id: string, name: string, args: string,
  tools: CahciuaTool[], log: Logger,
): Promise<{ id: string; content: string | ResponseInputContent[]; requiresFollowUp: boolean }> => {
  const tool = tools.find(t => t.function.name === name);
  try {
    const parsed = JSON.parse(args);
    const rawResult = tool
      ? await tool.execute(parsed, { toolCallId: id })
      : { content: JSON.stringify({ error: `Unknown tool: ${name}` }), requiresFollowUp: true };
    const { content, requiresFollowUp } = isToolResult(rawResult)
      ? rawResult
      : { content: JSON.stringify(rawResult), requiresFollowUp: true };
    return { id, content, requiresFollowUp };
  } catch (err) {
    log.withError(err).error(`Tool ${name} failed`);
    return { id, content: JSON.stringify({ error: String(err) }), requiresFollowUp: true };
  }
};

export const createRunner = (config: RunnerConfig) => {
  const apiFormat = config.apiFormat ?? 'openai-chat';
  const lastInputByChat = new Map<string, string[]>();

  const logPrefixRatio = (chatId: string, input: unknown[], log: Logger): void => {
    const curr = input.map(item => JSON.stringify(item));
    const prev = lastInputByChat.get(chatId) ?? [];
    lastInputByChat.set(chatId, curr);
    if (prev.length === 0) return;

    let prefixCount = 0;
    const minLen = Math.min(prev.length, curr.length);
    while (prefixCount < minLen && prev[prefixCount] === curr[prefixCount])
      prefixCount++;

    let prefixChars = 0, totalChars = 0;
    for (let i = 0; i < curr.length; i++) {
      const len = curr[i]!.length;
      totalChars += len;
      if (i < prefixCount) prefixChars += len;
    }
    const ratio = totalChars > 0 ? prefixChars / totalChars : 1;
    log.withFields({ prefixMessages: prefixCount, totalMessages: curr.length, prefixChars, totalChars, kvCachePrefixRatio: ratio.toFixed(3) }).log('KV cache prefix ratio');
  };

  const runStepLoop = async (params: StepLoopParams): Promise<void> => {
    if (apiFormat === 'responses') return await runStepLoopResponses(params);
    if (apiFormat === 'anthropic') return await runStepLoopAnthropic(params);
    return await runStepLoopChat(params);
  };

  const runStepLoopChat = async (params: StepLoopParams): Promise<void> => {
    let currentMessages = params.messages;

    for (let step = 1; step <= params.maxSteps; step++) {
      const messagesToSend = prepareChatMessagesForSend(currentMessages, params.maxImagesAllowed);

      writeFileSync(`${DUMP_DIR}/${params.chatId}.request.json`, JSON.stringify({
        model: config.model, system: params.system, messages: messagesToSend,
        tools: params.tools.map(t => ({ type: t.type, function: t.function })),
      }, null, 2));
      logPrefixRatio(params.chatId, messagesToSend, params.log);

      const stepRequestedAt = Date.now();
      const response = await streamingChat({
        baseURL: config.apiBaseUrl, apiKey: config.apiKey, model: config.model,
        messages: messagesToSend, system: params.system, tools: params.tools,
        thinking: config.thinking,
        log: params.log, label: `step:${step}`, timeoutSec: config.timeoutSec,
      });

      const choice = response.choices[0];
      if (!choice) {
        params.log.withFields({ chatId: params.chatId, step }).log('Model chose to stay silent (no choices)');
        params.onStepComplete([], response.usage, stepRequestedAt);
        break;
      }

      const assistantMsg = choice.message as ExtendedMessage;
      const stepData: TRDataEntry[] = [assistantMsg as TRAssistantEntry];
      const toolCalls = assistantMsg.tool_calls ?? [];

      let anyRequiresFollowUp = false;
      for (const tc of toolCalls) {
        const result = await executeToolCall(tc.id, tc.function.name, tc.function.arguments, params.tools, params.log);
        anyRequiresFollowUp ||= result.requiresFollowUp;
        stepData.push({ role: 'tool', tool_call_id: tc.id, content: result.content, requiresFollowUp: result.requiresFollowUp } as TRToolResultEntry);
      }

      params.log.withFields({
        chatId: params.chatId, step, finishReason: choice.finish_reason,
        hasToolCalls: toolCalls.length > 0, newMessages: stepData.length, usage: response.usage,
      }).log('Step completed');

      params.onStepComplete(stepData, response.usage, stepRequestedAt);

      if (!toolCalls.length || !anyRequiresFollowUp) {
        if (toolCalls.length && !anyRequiresFollowUp)
          params.log.withFields({ chatId: params.chatId, step }).log('All tool calls completed without follow-up');
        break;
      }
      if (params.checkInterrupt()) {
        params.log.withFields({ chatId: params.chatId, step }).log('Turn interrupted by new messages');
        break;
      }

      currentMessages = [...currentMessages, ...stepData] as Message[];
    }
  };

  const runStepLoopResponses = async (params: StepLoopParams): Promise<void> => {
    let currentMessages = params.messages;
    const responsesTools = params.tools.map(xsaiToolToResponsesTool);

    for (let step = 1; step <= params.maxSteps; step++) {
      const currentInput: (ResponseInputItem | ResponseOutputItem | ResponseFunctionCallOutputItem)[] = prepareResponsesInputForSend(currentMessages, params.maxImagesAllowed);

      writeFileSync(`${DUMP_DIR}/${params.chatId}.request.json`, JSON.stringify({
        model: config.model, instructions: params.system, input: currentInput, tools: responsesTools,
      }, null, 2));
      logPrefixRatio(params.chatId, currentInput, params.log);

      const stepRequestedAt = Date.now();
      const response = await streamingResponses({
        baseURL: config.apiBaseUrl, apiKey: config.apiKey, model: config.model,
        input: currentInput, instructions: params.system, tools: responsesTools,
        thinking: config.thinking,
        log: params.log, label: `step:${step}`, timeoutSec: config.timeoutSec,
      });

      if (response.output.length === 0) {
        params.log.withFields({ chatId: params.chatId, step }).log('Model chose to stay silent (no output)');
        params.onStepComplete([], { prompt_tokens: response.usage.input_tokens, completion_tokens: response.usage.output_tokens }, stepRequestedAt);
        break;
      }

      const stepData: ResponsesTRDataItem[] = [...response.output];
      const functionCalls = response.output.filter((item): item is ResponseOutputFunctionCall => item.type === 'function_call');
      const callOutputs: ResponseFunctionCallOutputItem[] = [];

      let anyRequiresFollowUp = false;
      for (const fc of functionCalls) {
        const result = await executeToolCall(fc.call_id, fc.name, fc.arguments, params.tools, params.log);
        anyRequiresFollowUp ||= result.requiresFollowUp;
        callOutputs.push({
          type: 'function_call_output',
          call_id: fc.call_id,
          output: result.content,
          requiresFollowUp: result.requiresFollowUp,
        });
      }
      stepData.push(...callOutputs);

      params.log.withFields({
        chatId: params.chatId, step, status: response.status,
        hasToolCalls: functionCalls.length > 0, outputItems: response.output.length, usage: response.usage,
      }).log('Step completed');

      params.onStepComplete(stepData, { prompt_tokens: response.usage.input_tokens, completion_tokens: response.usage.output_tokens }, stepRequestedAt);

      if (!functionCalls.length || !anyRequiresFollowUp) {
        if (functionCalls.length && !anyRequiresFollowUp)
          params.log.withFields({ chatId: params.chatId, step }).log('All tool calls completed without follow-up');
        break;
      }
      if (params.checkInterrupt()) {
        params.log.withFields({ chatId: params.chatId, step }).log('Turn interrupted by new messages');
        break;
      }

      currentMessages = [...currentMessages, ...responsesOutputToMessages(stepData)] as Message[];
    }
  };

  const runStepLoopAnthropic = async (params: StepLoopParams): Promise<void> => {
    let currentMessages = params.messages;
    const anthropicTools = params.tools.map(xsaiToolToAnthropicTool);

    for (let step = 1; step <= params.maxSteps; step++) {
      const messagesToSend = prepareAnthropicMessagesForSend(currentMessages, params.maxImagesAllowed);

      writeFileSync(`${DUMP_DIR}/${params.chatId}.request.json`, JSON.stringify({
        model: config.model, system: params.system, messages: messagesToSend, tools: anthropicTools,
      }, null, 2));
      logPrefixRatio(params.chatId, messagesToSend, params.log);

      const stepRequestedAt = Date.now();
      const response = await streamingAnthropic({
        baseURL: config.apiBaseUrl, apiKey: config.apiKey, model: config.model,
        messages: messagesToSend, system: params.system, tools: anthropicTools,
        maxTokens: config.maxTokens,
        thinking: config.thinking,
        log: params.log, label: `step:${step}`, timeoutSec: config.timeoutSec,
      });

      if (response.content.length === 0) {
        params.log.withFields({ chatId: params.chatId, step }).log('Model chose to stay silent (no content)');
        params.onStepComplete([], { prompt_tokens: response.usage.inputTokens, completion_tokens: response.usage.outputTokens }, stepRequestedAt);
        break;
      }

      const assistantEntry: AnthropicAssistantEntry = { role: 'assistant', content: response.content };
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use') as Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }>;

      const stepData: AnthropicTRDataEntry[] = [assistantEntry];
      const toolResultItems: AnthropicToolResultItem[] = [];
      let anyRequiresFollowUp = false;

      for (const toolUse of toolUseBlocks) {
        const result = await executeToolCall(toolUse.id, toolUse.name, JSON.stringify(toolUse.input), params.tools, params.log);
        anyRequiresFollowUp ||= result.requiresFollowUp;
        toolResultItems.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result.content,
          requiresFollowUp: result.requiresFollowUp,
        });
      }

      if (toolResultItems.length > 0)
        stepData.push({ role: 'user', content: toolResultItems });

      params.log.withFields({
        chatId: params.chatId, step, stopReason: response.stopReason,
        hasToolCalls: toolUseBlocks.length > 0, contentBlocks: response.content.length,
        usage: { prompt_tokens: response.usage.inputTokens, completion_tokens: response.usage.outputTokens },
      }).log('Step completed');

      params.onStepComplete(stepData, { prompt_tokens: response.usage.inputTokens, completion_tokens: response.usage.outputTokens }, stepRequestedAt);

      if (!toolUseBlocks.length || !anyRequiresFollowUp) {
        if (toolUseBlocks.length && !anyRequiresFollowUp)
          params.log.withFields({ chatId: params.chatId, step }).log('All tool calls completed without follow-up');
        break;
      }
      if (params.checkInterrupt()) {
        params.log.withFields({ chatId: params.chatId, step }).log('Turn interrupted by new messages');
        break;
      }

      currentMessages = [...currentMessages, ...anthropicTRToMessages(stepData)] as Message[];
    }
  };

  return { runStepLoop };
};
