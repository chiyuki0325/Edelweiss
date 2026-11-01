import type { Bot } from 'grammy';

import { assertImApiMethod } from './policy';
import type { ImApiInvoker } from './types';

type RawApi = Record<string, (...args: unknown[]) => Promise<unknown>>;

export const createTelegramImApiInvoker = (getBot: () => Bot): ImApiInvoker => ({
  platform: 'telegram',
  invoke: async (method, params) => {
    assertImApiMethod('telegram', method);
    const raw = getBot().api.raw as unknown as RawApi;
    const call = raw[method];
    if (typeof call !== 'function')
      throw new Error(`Unknown Telegram Bot API method: "${method}"`);
    // grammY's zero-parameter methods are pre-bound with an empty payload; passing
    // `{}` there would be interpreted as an AbortSignal. Call bare when empty.
    return Object.keys(params).length === 0 ? await call() : await call(params);
  },
});
