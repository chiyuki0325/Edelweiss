/**
 * Watch Telegram Bot API reaction updates with explicit allowed_updates.
 *
 * Usage: npx tsx scripts/watch-reaction-bot.ts
 */
import { Format, initLogger, LogLevel, useGlobalLogger } from '@guiiai/logg';
import { Bot } from 'grammy';
import type { ReactionType, Update } from 'grammy/types';

import { loadConfig } from '../src/config/config';

const reactionToText = (reaction: ReactionType): string => {
  switch (reaction.type) {
  case 'emoji': return reaction.emoji;
  case 'custom_emoji': return `custom:${reaction.custom_emoji_id}`;
  case 'paid': return 'paid';
  }
};

const reactionsToText = (reactions: ReactionType[]): string =>
  reactions.map(reactionToText).join(' ') || '-';

const now = (): string => new Date().toLocaleTimeString('zh-CN', { hour12: false });

const describeUpdate = (update: Update): string => {
  if (update.message_reaction) {
    const reaction = update.message_reaction;
    const actor = reaction.user
      ? `user:${reaction.user.id}${reaction.user.username ? ` @${reaction.user.username}` : ''}`
      : reaction.actor_chat
        ? `chat:${reaction.actor_chat.id} ${reaction.actor_chat.title ?? ''}`.trim()
        : 'unknown';
    return [
      'message_reaction',
      `chat=${reaction.chat.id}`,
      `msg=${reaction.message_id}`,
      `actor=${actor}`,
      `old=[${reactionsToText(reaction.old_reaction)}]`,
      `new=[${reactionsToText(reaction.new_reaction)}]`,
    ].join(' ');
  }

  if (update.message_reaction_count) {
    const reaction = update.message_reaction_count;
    const counts = reaction.reactions
      .map(count => `${reactionToText(count.type)}:${count.total_count}`)
      .join(' ') || '-';
    return [
      'message_reaction_count',
      `chat=${reaction.chat.id}`,
      `msg=${reaction.message_id}`,
      `counts=[${counts}]`,
    ].join(' ');
  }

  return `update=${JSON.stringify(update)}`;
};

const main = async () => {
  initLogger(LogLevel.Log, Format.Pretty);
  const log = useGlobalLogger('watch-reaction-bot');
  const config = loadConfig();
  if (!config.telegram?.botToken)
    throw new Error('telegram.botToken is required');

  const bot = new Bot(config.telegram.botToken);
  let offset: number | undefined;

  log.log('Watching Bot API reaction updates');

  const shutdown = () => {
    log.log('Shutting down...');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (true) {
    const updates = await bot.api.getUpdates({
      offset,
      timeout: 10,
      allowed_updates: ['message', 'edited_channel_post', 'callback_query', 'message_reaction', 'message_reaction_count'],
    });

    if (updates.length > 0)
      log.withFields({ count: updates.length }).log('Updates received');

    for (const update of updates) {
      console.log(`[${now()}] ${describeUpdate(update)}`);
      offset = update.update_id + 1;
    }
  }
};

main().catch(err => {
  useGlobalLogger('watch-reaction-bot').withError(err).error('Fatal error');
  process.exit(1);
});
