// Platform-agnostic (chatId, messageId) dedup with a bounded LRU. Used by both
// Telegram (bot vs userbot duplicate delivery) and OneBot (live ingress vs
// cold-start history pull overlap). messageId accepts string | number so it
// works with platform-native numeric IDs and canonical string IDs alike.
export const createMessageDedup = (maxSize = 10000) => {
  const seen = new Set<string>();
  const queue: string[] = [];

  return {
    tryAdd(chatId: string, messageId: string | number): boolean {
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

export type MessageDedup = ReturnType<typeof createMessageDedup>;
