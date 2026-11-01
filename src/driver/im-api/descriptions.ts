import type { ImApiPlatform, ImApiPlatformInfo } from './types';

const TELEGRAM: ImApiPlatformInfo = {
  description: 'Call the Telegram Bot API for the current Telegram chat. NEVER use this to send messages or reactions.',
  methodDescription: 'Telegram Bot API method name, camelCase. Example: getChatMember',
  paramsDescription: 'Raw Bot API parameters. Never include tokens, API keys, sessions, or API base URLs.',
  methodPattern: /^[A-Za-z][A-Za-z0-9]*$/,
};

const ONEBOT: ImApiPlatformInfo = {
  description: 'Call the OneBot 11 API for the current QQ chat. NEVER use this to send messages.',
  methodDescription: 'OneBot 11 action name, snake_case. Example: get_group_member_list',
  paramsDescription: 'Raw OneBot action parameters. Never include tokens, access tokens, or API endpoints.',
  methodPattern: /^[a-z][a-z0-9_]*$/,
};

const PLATFORM_INFO: Record<ImApiPlatform, ImApiPlatformInfo> = {
  telegram: TELEGRAM,
  onebot: ONEBOT,
};

export const getImApiPlatformInfo = (platform: ImApiPlatform): ImApiPlatformInfo =>
  PLATFORM_INFO[platform];
