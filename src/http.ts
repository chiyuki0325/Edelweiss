const secrets = new Set<string>();

export const registerHttpSecret = (secret: string) => {
  if (secret) secrets.add(secret);
};

// Mask every registered secret with an equal-length run of '*'. Exported so
// call sites that throw their own errors (e.g. OneBot's multi-branch downloader,
// whose base64/local-path/url logic does not fit httpGetBuffer) can redact
// credentials without routing through HttpError.
export const redactSecrets = (text: string): string => {
  let result = text;
  for (const secret of secrets) {
    result = result.replaceAll(secret, '*'.repeat(secret.length));
  }
  return result;
};

export class HttpError extends Error {
  constructor(public readonly status: number, url: string) {
    super(`HTTP ${status}: ${redactSecrets(url)}`);
    this.name = 'HttpError';
  }
}

export const httpGetBuffer = async (url: string, timeoutMs?: number): Promise<Buffer> => {
  const resp = await fetch(url, timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : undefined);
  if (!resp.ok) throw new HttpError(resp.status, url);
  return Buffer.from(await resp.arrayBuffer());
};
