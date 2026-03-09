export const createMessageDedup = (maxSize = 10000) => {
  const seen = new Set<string>();
  const queue: string[] = [];

  return {
    tryAdd(chatId: string, messageId: number): boolean {
      const key = `${chatId}:${messageId}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      queue.push(key);
      while (queue.length > maxSize) {
        const old = queue.shift()!;
        seen.delete(old);
      }
      return true;
    },
  };
};
