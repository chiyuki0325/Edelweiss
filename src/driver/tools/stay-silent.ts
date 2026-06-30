import type { CahciuaTool } from './types';
import { createTool } from './types';

export const createStaySilentTool = (): CahciuaTool => createTool({
  name: 'stay_silent',
  description: 'Mark this evaluation as a deliberate choice to stay silent. Use only when you have considered the chat and decided not to speak. Equivalent to making no tool call when send_message is otherwise unrestricted.',
  parameters: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Brief internal note on why you are staying silent (not shown to anyone).' },
    },
  },
  execute: _input => ({ content: JSON.stringify({ ok: true }), requiresFollowUp: false }),
});
