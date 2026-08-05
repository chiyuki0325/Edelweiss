import { createJinaFetcher } from './jina';
import type { InstantViewFetcher, WebFetchConfig, WebFetcher } from './types';

export type { InstantViewFetcher, WebFetcher, WebFetchConfig, WebFetchProvider, WebFetchResult } from './types';

export const WEB_FETCH_HOST_SUBSTITUTIONS: Readonly<Record<string, string>> = {
  'x.com': 'i.fixupx.com',
  'www.x.com': 'i.fixupx.com',
  'twitter.com': 'i.fxtwitter.com',
  'www.twitter.com': 'i.fxtwitter.com',
};

export const substituteWebFetchHost = (value: string): string => {
  const url = new URL(value);
  const replacement = WEB_FETCH_HOST_SUBSTITUTIONS[url.hostname.toLowerCase()];
  if (replacement) url.hostname = replacement;
  return url.toString();
};

export interface WebFetcherDeps {
  instantView?: InstantViewFetcher;
  onInstantViewError?: (error: unknown, url: string) => void;
}

/** Instant View first, with the configured provider retained as a transparent fallback. */
export const createWebFetcher = (config: WebFetchConfig, deps: WebFetcherDeps = {}): WebFetcher => {
  const fallback = (() => {
    switch (config.provider) {
    case 'jina':
      return createJinaFetcher({ apiKey: config.jina.apiKey });
    }
  })();

  return {
    fetch: async requestedUrl => {
      const fetchUrl = substituteWebFetchHost(requestedUrl);
      if (deps.instantView) {
        try {
          const result = await deps.instantView.fetch(fetchUrl);
          if (result) return { url: requestedUrl, content: result.content, ...result.title ? { title: result.title } : {} };
        } catch (err) {
          deps.onInstantViewError?.(err, fetchUrl);
        }
      }

      const result = await fallback.fetch(fetchUrl);
      return { ...result, url: requestedUrl };
    },
  };
};
