export type ImApiPlatform = 'telegram' | 'onebot';

export interface ImApiInvoker {
  platform: ImApiPlatform;
  invoke: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}

export interface ImApiPlatformInfo {
  description: string;
  methodDescription: string;
  paramsDescription: string;
  methodPattern: RegExp;
}
