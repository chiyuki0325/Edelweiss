export class HttpError extends Error {
  constructor(public readonly status: number, url: string) {
    super(`HTTP ${status}: ${url}`);
    this.name = 'HttpError';
  }
}

export const httpGetBuffer = async (url: string): Promise<Buffer> => {
  const resp = await fetch(url);
  if (!resp.ok) throw new HttpError(resp.status, url);
  return Buffer.from(await resp.arrayBuffer());
};
