import type { Logger } from '@guiiai/logg';

import type {
  ResponseOutputFunctionCall,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseStreamEvent,
  ResponseTool,
  ResponsesResult,
} from './responses-types';
import { parseSSEStream } from './sse';

export interface StreamingResponsesParams {
  baseURL: string;
  apiKey: string;
  model: string;
  input: unknown[];
  instructions?: string;
  tools?: ResponseTool[];
  timeoutSec?: number;
  log: Logger;
  label: string;
}

export interface StreamingResponsesResult {
  output: ResponseOutputItem[];
  usage: { input_tokens: number; output_tokens: number };
  status: string;
}

// Parse a Responses API SSE stream into a StreamingResponsesResult.
// Logs content/reasoning/tool_call deltas as they arrive.
export const streamingResponses = async (params: StreamingResponsesParams): Promise<StreamingResponsesResult> => {
  const { log, label } = params;
  const abortController = new AbortController();
  const timeout = params.timeoutSec
    ? setTimeout(() => abortController.abort(new Error(`responses request timed out after ${params.timeoutSec}s`)), params.timeoutSec * 1000)
    : undefined;

  try {
    const body = JSON.stringify({
      model: params.model,
      input: params.input,
      ...(params.instructions ? { instructions: params.instructions } : {}),
      ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
      stream: true,
    });

    const url = `${params.baseURL.replace(/\/$/, '')}/responses`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${params.apiKey}`,
      },
      body,
      signal: abortController.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Responses API ${res.status}: ${text}`);
    }

    const stream = res.body;
    if (!stream) throw new Error('SSE response has no body');

    // Accumulated state
    const output: ResponseOutputItem[] = [];
    let usage = { input_tokens: 0, output_tokens: 0 };
    let status = '';

    // Logging buffers
    let textBuf = '';
    let reasoningBuf = '';

    const flushTextBuf = () => {
      if (textBuf) {
        log.withFields({ label, text: textBuf }).log('content delta');
        textBuf = '';
      }
    };

    const flushReasoningBuf = () => {
      if (reasoningBuf) {
        log.withFields({ label, reasoning: reasoningBuf }).log('reasoning delta');
        reasoningBuf = '';
      }
    };

    const processEvent = (event: ResponseStreamEvent) => {
      switch (event.type) {
      case 'response.output_item.added': {
      // Initialize the output item slot
        const outputIndex = event.output_index as number;
        const item = event.item as ResponseOutputItem;
        output[outputIndex] = item;
        if (item.type === 'function_call') {
          flushTextBuf();
          flushReasoningBuf();
          log.withFields({ label, tool: item.name }).log('tool call start');
        }
        break;
      }

      case 'response.output_text.delta': {
        const oi = event.output_index as number;
        const ci = event.content_index as number;
        const d = event.delta as string;
        textBuf += d;
        const msgItem = output[oi] as ResponseOutputMessage | undefined;
        if (msgItem?.type === 'message' && msgItem.content[ci]) {
          const block = msgItem.content[ci]!;
          if (block.type === 'output_text')
            block.text += d;
        }
        break;
      }

      case 'response.function_call_arguments.delta': {
        const oi = event.output_index as number;
        const d = event.delta as string;
        const fcItem = output[oi] as ResponseOutputFunctionCall | undefined;
        if (fcItem?.type === 'function_call')
          fcItem.arguments += d;
        break;
      }

      case 'response.reasoning_summary_text.delta': {
        reasoningBuf += event.delta as string;
        break;
      }

      case 'response.output_item.done': {
      // Replace with the final item from the server
        output[event.output_index as number] = event.item as ResponseOutputItem;
        break;
      }

      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed': {
        const resp = event.response as ResponsesResult;
        status = resp.status;
        if (resp.usage) {
          usage = {
            input_tokens: resp.usage.input_tokens,
            output_tokens: resp.usage.output_tokens,
          };
        }
        if (resp.output) {
          output.length = 0;
          output.push(...resp.output);
        }
        break;
      }

      case 'error':
        log.withFields({ label, error: event.message }).error('Responses API stream error');
        break;

      default:
        break;
      }
    };

    await parseSSEStream(stream, processEvent);
    flushTextBuf();
    flushReasoningBuf();

    return { output, usage, status };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};
