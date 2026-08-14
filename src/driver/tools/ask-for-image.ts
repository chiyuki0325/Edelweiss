import type { CahciuaTool } from './types';
import { createTool } from './types';

export const createAskForImageTool = (deps: {
  ask: (imageId: string, question: string) => Promise<{ answer: string; historyReset: boolean }>;
}): CahciuaTool => createTool({
  name: 'ask_for_image',
  execution: { lane: 'serial' },
  description: 'Ask a follow-up question about an image conversation created by an image-id or read_image.',
  parameters: {
    type: 'object',
    properties: {
      image_id: { type: 'string', minLength: 1, description: 'The image-id shown in chat context or returned by read_image.' },
      question: { type: 'string', minLength: 1, description: 'A focused follow-up question about the image.' },
    },
    required: ['image_id', 'question'],
  },
  execute: async input => {
    const { image_id, question } = input as { image_id: string; question: string };
    try {
      const result = await deps.ask(image_id, question);
      return {
        content: JSON.stringify({
          ok: true,
          image_id,
          answer: result.answer,
          history_reset: result.historyReset,
        }),
        requiresFollowUp: true,
      };
    } catch (err) {
      return {
        content: JSON.stringify({ ok: false, error: String(err instanceof Error ? err.message : err) }),
        requiresFollowUp: true,
      };
    }
  },
});
