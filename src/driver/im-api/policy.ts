import { getImApiPlatformInfo } from './descriptions';
import type { ImApiPlatform } from './types';
import { redactSecrets } from '../../http';

export const DEFAULT_MAX_RESULT_CHARS = 20_000;

const FORBIDDEN_PARAM_KEY = /^(?:token|api_?key|access_?token|secret|password|authorization|auth|cookie|cookies|session|api_?hash|bot_?token|credentials?)$/i;

// Actions that return credentials rather than chat data. This is a denylist
// against accidental credential disclosure, not an access-control allowlist.
const FORBIDDEN_METHODS: Record<ImApiPlatform, ReadonlySet<string>> = {
  telegram: new Set(),
  onebot: new Set(['get_credentials', 'get_cookies', 'get_csrf_token']),
};

// Methods that do not take a chat target. Injecting `chat_id` / `group_id` into
// them would add a meaningless parameter, so they are left untouched. This is a
// parameter-shape detail, not a method allowlist.
const TELEGRAM_TARGETLESS = new Set([
  'getMe',
  'getMyCommands',
  'getMyDefaultAdministratorRights',
  'getMyDescription',
  'getMyName',
  'getMyShortDescription',
  'getUpdates',
  'logOut',
  'close',
]);

const ONEBOT_TARGETLESS = new Set([
  'get_login_info',
  'get_status',
  'get_version_info',
  'get_friend_list',
  'get_group_list',
  'get_msg',
  'get_forward_msg',
]);

const assertSafeParams = (value: unknown, path: string): void => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeParams(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PARAM_KEY.test(key))
      throw new Error(`Refusing to send credential-like parameter "${path ? `${path}.` : ''}${key}"`);
    assertSafeParams(child, path ? `${path}.${key}` : key);
  }
};

export const assertSafeImApiParams = (params: Record<string, unknown>): Record<string, unknown> => {
  assertSafeParams(params, '');
  return params;
};

export const assertImApiMethod = (platform: ImApiPlatform, method: string): void => {
  const info = getImApiPlatformInfo(platform);
  if (!info.methodPattern.test(method))
    throw new Error(`Invalid ${platform} API method name: "${method}"`);
  if (FORBIDDEN_METHODS[platform].has(method))
    throw new Error(`Refusing to call credential-returning ${platform} API method: "${method}"`);
};

export const withDefaultTarget = (
  platform: ImApiPlatform,
  chatId: string,
  method: string,
  params: Record<string, unknown>,
): Record<string, unknown> => {
  if (platform === 'telegram') {
    if (params.chat_id === undefined && !TELEGRAM_TARGETLESS.has(method))
      return { chat_id: chatId, ...params };
    return params;
  }

  if (chatId.startsWith('private:')) {
    if (params.user_id === undefined && !ONEBOT_TARGETLESS.has(method)) {
      const userId = Number.parseInt(chatId.slice('private:'.length), 10);
      if (Number.isFinite(userId)) return { user_id: userId, ...params };
    }
    return params;
  }

  if (params.group_id === undefined && !ONEBOT_TARGETLESS.has(method)) {
    const groupId = Number.parseInt(chatId, 10);
    if (Number.isFinite(groupId)) return { group_id: groupId, ...params };
  }
  return params;
};

export const formatImApiResult = (
  result: { ok: true; platform: ImApiPlatform; method: string; data: unknown },
  maxChars: number,
): string => {
  const serialized = redactSecrets(JSON.stringify(result) ?? '{}');
  if (serialized.length <= maxChars) return serialized;

  const dataText = redactSecrets(JSON.stringify(result.data) ?? String(result.data));
  return redactSecrets(JSON.stringify({
    ok: result.ok,
    platform: result.platform,
    method: result.method,
    truncated: true,
    original_chars: serialized.length,
    data_preview: dataText.slice(0, maxChars),
  }));
};

export const formatImApiError = (platform: ImApiPlatform, method: string, error: unknown): string =>
  redactSecrets(JSON.stringify({
    ok: false,
    platform,
    method,
    error: error instanceof Error ? error.message : String(error),
  }));
