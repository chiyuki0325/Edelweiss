import type { ToolExecuteResult } from 'xsai';

export interface ToolResult {
  content: unknown;
  requiresFollowUp: boolean;
}

export const isToolResult = (v: unknown): v is ToolResult =>
  typeof v === 'object' && v !== null && 'requiresFollowUp' in v;

// Our tool execute interface — only toolCallId, no messages context.
export interface CahciuaToolExecuteOptions {
  toolCallId: string;
}

export interface CahciuaTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
  execute: (input: unknown, options: CahciuaToolExecuteOptions) => Promise<ToolExecuteResult> | ToolExecuteResult;
}

export const createSendMessageTool = (
  send: (text: string, replyTo?: string) => Promise<{ messageId: string }>,
): CahciuaTool => ({
  type: 'function',
  function: {
    name: 'send_message',
    description: 'Send a message in the current conversation.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message to send.' },
        reply_to: { type: 'string', description: 'A message id to reply to.' },
        await_response: {
          type: 'boolean',
          description: 'Set to true if you need to perform additional actions after this message (e.g., send another message, use another tool). Defaults to false.',
        },
      },
      required: ['text'],
    },
  },
  execute: async input => {
    const { text, reply_to, await_response } = input as { text: string; reply_to?: string; await_response?: boolean };
    const result = await send(text, reply_to);
    return {
      content: { ok: true, message_id: result.messageId },
      requiresFollowUp: await_response ?? false,
    };
  },
});
