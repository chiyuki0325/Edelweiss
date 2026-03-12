import dotenv from 'dotenv';

import { adaptDelete, adaptEdit, adaptMessage } from './adaptation';
import { loadEnv } from './config/env';
import { setupLogger, useLogger } from './config/logger';
import { createDatabase, loadEvents, loadKnownChatIds, lookupChatId, persistEvent, persistMessage, persistMessageDelete, persistMessageEdit, runMigrations } from './db';
import { createEmptyIC, reduce } from './projection';
import type { IntermediateContext } from './projection';
import { createTelegramManager } from './telegram';
import { loadSession } from './telegram/session';

dotenv.config();
setupLogger();

const logger = useLogger('cahciua');

const main = async () => {
  const env = loadEnv();

  const db = createDatabase(env.DB_PATH, logger);
  runMigrations(db, logger);

  // Cold-start: replay events per chat to rebuild IC
  const sessions = new Map<string, IntermediateContext>();
  for (const chatId of loadKnownChatIds(db)) {
    let ic = createEmptyIC(chatId);
    const events = loadEvents(db, chatId);
    for (const event of events)
      ic = reduce(ic, event);
    sessions.set(chatId, ic);
    logger.withFields({ chatId, events: events.length, nodes: ic.nodes.length, users: ic.users.size }).log('Replayed session');
  }
  logger.withFields({ sessions: sessions.size }).log('Cold start complete');

  const telegram = createTelegramManager({
    botToken: env.TELEGRAM_BOT_TOKEN,
    apiId: env.TELEGRAM_API_ID,
    apiHash: env.TELEGRAM_API_HASH,
    session: loadSession(env.TELEGRAM_SESSION),
    initialChatIds: loadKnownChatIds(db),
    resolveChatId: messageIds => lookupChatId(db, messageIds),
  }, logger);

  telegram.onMessage(msg => {
    logger.withFields({
      source: msg.source,
      chatId: msg.chatId,
      messageId: msg.messageId,
      sender: msg.sender?.username ?? msg.sender?.firstName ?? msg.sender?.id ?? 'unknown',
      text: msg.text.length > 100 ? `${msg.text.slice(0, 100)}...` : msg.text,
      length: msg.text.length,
    }).log('Message received');

    const event = adaptMessage(msg);

    try {
      persistEvent(db, event);
    } catch (err) {
      logger.withError(err).error('Failed to persist event');
    }

    try {
      persistMessage(db, msg);
    } catch (err) {
      logger.withError(err).error('Failed to persist message');
    }

    const ic = sessions.get(event.chatId) ?? createEmptyIC(event.chatId);
    sessions.set(event.chatId, reduce(ic, event));
  });

  telegram.onMessageEdit(edit => {
    logger.withFields({
      chatId: edit.chatId,
      messageId: edit.messageId,
      sender: edit.sender?.username ?? edit.sender?.firstName ?? edit.sender?.id ?? 'unknown',
      text: edit.text.length > 100 ? `${edit.text.slice(0, 100)}...` : edit.text,
      length: edit.text.length,
    }).log('Message edited');

    const event = adaptEdit(edit);

    try {
      persistEvent(db, event);
    } catch (err) {
      logger.withError(err).error('Failed to persist event');
    }

    try {
      persistMessageEdit(db, edit);
    } catch (err) {
      logger.withError(err).error('Failed to persist message edit');
    }

    const ic = sessions.get(event.chatId) ?? createEmptyIC(event.chatId);
    sessions.set(event.chatId, reduce(ic, event));
  });

  telegram.onMessageDelete(del => {
    logger.withFields({
      chatId: del.chatId ?? 'unknown',
      messageIds: del.messageIds,
    }).log('Message deleted');

    const event = adaptDelete(del);

    try {
      persistEvent(db, event);
    } catch (err) {
      logger.withError(err).error('Failed to persist event');
    }

    try {
      persistMessageDelete(db, del);
    } catch (err) {
      logger.withError(err).error('Failed to persist message delete');
    }

    const ic = sessions.get(event.chatId) ?? createEmptyIC(event.chatId);
    sessions.set(event.chatId, reduce(ic, event));
  });

  const shutdown = async () => {
    logger.log('Shutting down...');
    await telegram.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await telegram.start();
  logger.log('Cahciua is running');
};

main().catch(err => {
  logger.withError(err).error('Fatal error');
  process.exit(1);
});
