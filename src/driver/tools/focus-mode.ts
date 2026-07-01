import type { CahciuaTool } from './types';
import { createTool } from './types';
import type { DriverSignal, TurnState } from '../turn-state';

export const createEnterFocusTool = (opts: {
  focusMode: DriverSignal<boolean>;
  getActiveTurn: () => TurnState | null;
}): CahciuaTool => createTool({
  name: 'enter_focus',
  description: 'Enter focus mode so your current task is not interrupted by new messages. Use this when you need to complete multi-step work (fetch a link, research a topic, run commands) without being disturbed.',
  parameters: { type: 'object', properties: {} },
  execute: () => {
    opts.focusMode(true);
    const turn = opts.getActiveTurn();
    if (turn) turn.flags.inFocusMode = true;
    return { content: JSON.stringify({ ok: true }), requiresFollowUp: true };
  },
});
