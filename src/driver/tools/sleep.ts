import type { CahciuaTool } from './types';
import { createTool } from './types';

const SLEEP_MAX_SECONDS = 300;

export const createSleepTool = (): CahciuaTool => createTool({
  name: 'sleep',
  execution: { lane: 'readonly' },
  description: 'Pause execution for a specified number of seconds before continuing. Use this to wait for an external process to finish, avoid busy-polling, or introduce a deliberate delay before the next action.',
  parameters: {
    type: 'object',
    properties: {
      seconds: {
        type: 'number',
        description: `Seconds to sleep. Must be between 1 and ${SLEEP_MAX_SECONDS}.`,
      },
      reason: {
        type: 'string',
        description: 'Brief note on why you are sleeping (not shown to anyone).',
      },
    },
    required: ['seconds'],
  },
  execute: async input => {
    const { seconds } = input as { seconds: number };
    const clamped = Math.max(1, Math.min(SLEEP_MAX_SECONDS, Math.round(seconds)));
    await new Promise<void>(resolve => setTimeout(resolve, clamped * 1000));
    return { content: JSON.stringify({ ok: true, slept_seconds: clamped }), requiresFollowUp: true };
  },
});
