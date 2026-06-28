import { createBackgroundTaskManager } from '../../background-task/manager';
import { getChatIds } from '../../config/config';
import { persistEvent } from '../../db';
import { isConfiguredChat } from '../../startup/chat-selection';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export default function registerBackgroundTaskManager({ get, register }: Registrar): void {
  register(TOKENS.BACKGROUND_TASK_MANAGER, () => {
    const config = get(TOKENS.CONFIG);
    const db = get(TOKENS.DB);
    const pipeline = get(TOKENS.PIPELINE);
    const bgTasksConfig = get(TOKENS.BG_TASKS_CONFIG);
    const configuredChatIds = new Set(getChatIds(config));
    return createBackgroundTaskManager({
      db,
      persistEvent: event => persistEvent(db, event),
      pushPipelineEvent: (chatId, event) => isConfiguredChat(configuredChatIds, chatId) ? pipeline.pushEvent(chatId, event) : [],
      handleDriverEvent: (chatId, rc) => get(TOKENS.DRIVER).handleEvent(chatId, rc),
      taskOutputDir: bgTasksConfig.outputDir,
      retentionCount: bgTasksConfig.retentionCount,
      logger: get(TOKENS.LOGGER),
    });
  });
}
