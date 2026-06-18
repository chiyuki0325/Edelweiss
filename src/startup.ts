export const isConfiguredChat = (configuredChatIds: ReadonlySet<string>, chatId: string): boolean =>
  configuredChatIds.has(chatId);

export const selectStartupReplayChatIds = (
  knownChatIds: readonly string[],
  configuredChatIds: Iterable<string>,
): string[] => {
  const configured = new Set(configuredChatIds);
  return knownChatIds.filter(chatId => configured.has(chatId));
};

export const selectTelegramIngressChatIds = (
  knownChatIds: readonly string[],
  configuredTelegramChatIds: Iterable<string>,
): string[] => {
  const accepted = new Set(knownChatIds);
  for (const chatId of configuredTelegramChatIds)
    accepted.add(chatId);
  return [...accepted];
};
