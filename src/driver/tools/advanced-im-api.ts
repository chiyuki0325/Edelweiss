import type { Logger } from '@guiiai/logg';

import { createTool } from './types';
import type { CahciuaTool } from './types';
import { getImApiPlatformInfo } from '../im-api/descriptions';
import {
  assertImApiMethod,
  assertSafeImApiParams,
  DEFAULT_MAX_RESULT_CHARS,
  formatImApiError,
  formatImApiResult,
  withDefaultTarget,
} from '../im-api/policy';
import type { ImApiInvoker, ImApiPlatform } from '../im-api/types';

export interface AdvancedImApiToolDeps {
  platform: ImApiPlatform;
  chatId: string;
  invoker: ImApiInvoker;
  log: Logger;
  maxResultChars?: number;
}

export const createAdvancedImApiTool = (deps: AdvancedImApiToolDeps): CahciuaTool => {
  const { platform, chatId, invoker, log } = deps;
  const info = getImApiPlatformInfo(platform);
  const maxResultChars = deps.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;

  return createTool({
    name: 'advanced_im_api',
    execution: { lane: 'serial' },
    description: info.description,
    parameters: {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          description: info.methodDescription,
        },
        params: {
          type: 'object',
          additionalProperties: true,
          description: info.paramsDescription,
        },
      },
      required: ['method'],
    },
    execute: async input => {
      const { method, params } = input as { method: string; params?: Record<string, unknown> };
      const startedAtMs = Date.now();
      try {
        assertImApiMethod(platform, method);
        const safeParams = assertSafeImApiParams(params ?? {});
        const targetedParams = withDefaultTarget(platform, chatId, method, safeParams);
        const data = await invoker.invoke(method, targetedParams);
        const content = formatImApiResult({ ok: true, platform, method, data }, maxResultChars);
        log.withFields({
          platform,
          method,
          paramKeys: Object.keys(safeParams),
          durationMs: Date.now() - startedAtMs,
          resultChars: content.length,
        }).log('advanced_im_api called');
        return { content, requiresFollowUp: true };
      } catch (err) {
        log.withError(err).withFields({
          platform,
          method,
          paramKeys: typeof params === 'object' && params !== null ? Object.keys(params) : [],
          durationMs: Date.now() - startedAtMs,
        }).warn('advanced_im_api failed');
        return { content: formatImApiError(platform, method, err), requiresFollowUp: true };
      }
    },
  });
};
