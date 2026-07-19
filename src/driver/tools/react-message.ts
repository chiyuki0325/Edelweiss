import type { CahciuaTool } from './types';
import { createTool } from './types';

export const createReactMessageTool = (
  emojis: string[],
  react: (messageId: string, emoji: string) => Promise<void>,
): CahciuaTool => createTool({
  name: 'react_message',
  execution: { lane: 'message' },
  description: 'Add a lightweight emoji reaction to a Telegram message. Use this as a low-disturbance alternative to send_message when a small acknowledgement, agreement, thanks, or amusement is enough.',
  parameters: {
    type: 'object',
    properties: {
      message_id: { type: 'string', description: 'A message id from the chat context to react to.' },
      emoji: { type: 'string', enum: emojis, description: 'The reaction emoji to add.' },
    },
    required: ['message_id', 'emoji'],
  },
  execute: async input => {
    const { message_id, emoji } = input as { message_id: string; emoji: string };
    if (!emojis.includes(emoji)) {
      return {
        content: JSON.stringify({ ok: false, error: `Reaction emoji is not allowed in this Telegram chat: ${emoji}` }),
        requiresFollowUp: true,
      };
    }
    await react(message_id, emoji);
    return {
      content: JSON.stringify({ ok: true, message_id, emoji }),
      requiresFollowUp: false,
    };
  },
});
