export const parseSSEStream = async <T>(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: T) => void,
): Promise<void> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let lineBuf = '';

  const processLine = (line: string) => {
    if (!line.startsWith('data: ')) return;

    const data = line.slice(6).trim();
    if (data === '[DONE]') return;

    onEvent(JSON.parse(data) as T);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    lineBuf += decoder.decode(value, { stream: true });
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop()!;

    for (const line of lines)
      processLine(line);
  }

  if (lineBuf)
    processLine(lineBuf);
};
