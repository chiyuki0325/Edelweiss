import { assertImApiMethod } from './policy';
import type { ImApiInvoker } from './types';
import type { OneBotApiClient } from '../../onebot/server';

export const createOneBotImApiInvoker = (getApi: () => OneBotApiClient | null): ImApiInvoker => ({
  platform: 'onebot',
  invoke: async (method, params) => {
    assertImApiMethod('onebot', method);
    const api = getApi();
    if (!api) throw new Error('OneBot is disconnected; cannot call the API');
    return await api.callAction(method, params);
  },
});
