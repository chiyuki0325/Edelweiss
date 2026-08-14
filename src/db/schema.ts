import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import type { CanonicalAttachment, CanonicalForwardInfo, CanonicalUser, ContentNode, ServiceAction } from '../adaption-types';
import type { RuntimeEventData } from '../runtime-event';
import type { Attachment, ForwardInfo, MessageEntity, TelegramReactionSnapshotEntry } from '../telegram/message/types';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name'),
  username: text('username'),
  isBot: integer('is_bot', { mode: 'boolean' }).notNull(),
  isPremium: integer('is_premium', { mode: 'boolean' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const messages = sqliteTable('messages', {
  // Composite natural key: (chatId, messageId)
  chatId: text('chat_id').notNull(),
  messageId: integer('message_id').notNull(),

  senderId: text('sender_id').references(() => users.id),
  date: integer('date').notNull(),
  editDate: integer('edit_date'),
  text: text('text'),

  // Formatted text entities (bold, links, mentions, etc.) — stored as JSON
  entities: text('entities', { mode: 'json' }).$type<MessageEntity[]>(),

  // Reply & thread context
  replyToMessageId: integer('reply_to_message_id'),
  replyToTopId: integer('reply_to_top_id'),

  // Forward info — stored as JSON since the shape varies
  // (forwarded from user vs channel vs hidden, etc.)
  forwardInfo: text('forward_info', { mode: 'json' }).$type<ForwardInfo>(),

  // Media group (multiple photos/videos sent as album)
  mediaGroupId: text('media_group_id'),

  // Sent via inline bot
  viaBotId: text('via_bot_id'),

  // Media attachments — JSON array
  attachments: text('attachments', { mode: 'json' }).$type<Attachment[]>(),

  deletedAt: integer('deleted_at', { mode: 'timestamp' }),

  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, table => [
  uniqueIndex('messages_chat_message_idx').on(table.chatId, table.messageId),
]);

export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),

  chatId: text('chat_id').notNull(),
  type: text('type').notNull().$type<'message' | 'blocked_message' | 'edit' | 'delete' | 'service' | 'runtime' | 'reaction'>(),
  receivedAtMs: integer('received_at').notNull(),
  timestampSec: integer('timestamp').notNull(),
  utcOffsetMin: integer('utc_offset_min').notNull().default(480),

  // message/edit only (canonical string IDs)
  messageId: text('message_id'),
  senderId: text('sender_id'),
  // Denormalized plain text for SQL search — derived from content at persist time
  text: text('text'),

  // delete only (canonical string IDs)
  messageIds: text('message_ids', { mode: 'json' }).$type<string[]>(),

  // JSON fields
  sender: text('sender', { mode: 'json' }).$type<CanonicalUser>(),
  content: text('content', { mode: 'json' }).$type<ContentNode[]>(),
  attachments: text('attachments', { mode: 'json' }).$type<CanonicalAttachment[]>(),

  // message only (canonical string ID)
  replyToMessageId: text('reply_to_message_id'),
  forwardInfo: text('forward_info', { mode: 'json' }).$type<CanonicalForwardInfo>(),

  // Platform account identity, resolved by the platform adaptation layer
  isMyself: integer('is_myself', { mode: 'boolean' }),

  // Messages sent by this bot instance's send_message tool
  isSelfSent: integer('is_self_sent', { mode: 'boolean' }),

  // Service event action — JSON discriminated union
  serviceAction: text('service_action', { mode: 'json' }).$type<ServiceAction>(),

  // Runtime event data — JSON for runtime-originated events
  runtimeData: text('runtime_data', { mode: 'json' }).$type<RuntimeEventData>(),

  // Reaction event data — append-only increments derived from Telegram aggregate updates
  reactionData: text('reaction_data', { mode: 'json' }).$type<{ emoji: string; count: number }>(),
}, table => [
  index('events_chat_id_idx').on(table.chatId),
]);

export const messageReactionSnapshots = sqliteTable('message_reaction_snapshots', {
  chatId: text('chat_id').notNull(),
  messageId: text('message_id').notNull(),
  reactions: text('reactions', { mode: 'json' }).notNull().$type<TelegramReactionSnapshotEntry[]>(),
  updatedAtMs: integer('updated_at_ms').notNull(),
}, table => [
  uniqueIndex('message_reaction_snapshots_chat_message_idx').on(table.chatId, table.messageId),
]);

export const turnResponses = sqliteTable('turn_responses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull(),
  requestedAt: integer('requested_at').notNull(),
  provider: text('provider').notNull(),
  data: text('data', { mode: 'json' }).notNull().$type<unknown[]>(),
  sessionMeta: text('session_meta', { mode: 'json' }),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  reasoningSignatureCompat: text('reasoning_signature_compat').default(''),
}, table => [
  index('turn_responses_chat_requested_idx').on(table.chatId, table.requestedAt),
]);

export const turnResponsesV2 = sqliteTable('turn_responses_v2', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull(),
  agentId: text('agent_id').notNull().default('main'),
  requestedAt: integer('requested_at').notNull(),
  entries: text('entries').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  modelName: text('model_name').notNull().default(''),
}, table => [
  index('turn_responses_v2_chat_agent_requested_idx').on(table.chatId, table.agentId, table.requestedAt),
  index('turn_responses_v2_chat_requested_idx').on(table.chatId, table.requestedAt),
]);

export const subagents = sqliteTable('subagents', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull(),
  agentId: text('agent_id').notNull(),
  task: text('task').notNull(),
  status: text('status').notNull(),
  modelName: text('model_name').notNull().default(''),
  createdAtMs: integer('created_at_ms').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
  finalMessage: text('final_message'),
}, table => [
  uniqueIndex('subagents_chat_agent_idx').on(table.chatId, table.agentId),
  index('subagents_chat_status_idx').on(table.chatId, table.status),
]);

export const subagentMessages = sqliteTable('subagent_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull(),
  fromAgentId: text('from_agent_id').notNull(),
  toAgentId: text('to_agent_id').notNull(),
  type: text('type').notNull(),
  content: text('content').notNull(),
  final: integer('final', { mode: 'boolean' }).notNull().default(false),
  createdAtMs: integer('created_at_ms').notNull(),
  deliveredAtMs: integer('delivered_at_ms'),
}, table => [
  index('subagent_messages_chat_to_idx').on(table.chatId, table.toAgentId),
]);

export const compactions = sqliteTable('compactions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull(),
  oldCursorMs: integer('old_cursor_ms').notNull(),
  newCursorMs: integer('new_cursor_ms').notNull(),
  summary: text('summary').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  createdAt: integer('created_at').notNull(),
}, table => [
  index('compactions_chat_id_idx').on(table.chatId),
]);

export const imageAltTexts = sqliteTable('image_alt_texts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  imageHash: text('image_hash').notNull(),
  altText: text('alt_text').notNull(),
  altTextTokens: integer('alt_text_tokens').notNull(),
  stickerSetName: text('sticker_set_name'),
  seedSystemPrompt: text('seed_system_prompt'),
  seedUserText: text('seed_user_text'),
  createdAt: integer('created_at').notNull(),
}, table => [
  uniqueIndex('image_alt_texts_hash_idx').on(table.imageHash),
]);

export const imageConversations = sqliteTable('image_conversations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull(),
  imageId: text('image_id').notNull(),
  sourceFingerprint: text('source_fingerprint').notNull(),
  imageHash: text('image_hash').notNull(),
  preparedImageBase64: text('prepared_image_base64').notNull(),
  systemPrompt: text('system_prompt').notNull(),
  initialUserText: text('initial_user_text').notNull(),
  initialResponse: text('initial_response').notNull(),
  initialOutputTokens: integer('initial_output_tokens').notNull().default(0),
  modelName: text('model_name').notNull().default(''),
  currentGeneration: integer('current_generation').notNull().default(0),
  createdAtMs: integer('created_at_ms').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
}, table => [
  uniqueIndex('image_conversations_chat_image_idx').on(table.chatId, table.imageId),
]);

export const imageConversationTurns = sqliteTable('image_conversation_turns', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  conversationId: integer('conversation_id').notNull().references(() => imageConversations.id),
  generation: integer('generation').notNull(),
  sequence: integer('sequence').notNull(),
  question: text('question').notNull(),
  answer: text('answer').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  modelName: text('model_name').notNull().default(''),
  createdAtMs: integer('created_at_ms').notNull(),
}, table => [
  uniqueIndex('image_conversation_turns_generation_sequence_idx')
    .on(table.conversationId, table.generation, table.sequence),
  index('image_conversation_turns_conversation_idx').on(table.conversationId),
]);

export const backgroundTasks = sqliteTable('background_tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull(),
  typeName: text('type_name').notNull(),
  intention: text('intention'),
  timeoutMs: integer('timeout_ms').notNull(),
  completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
  params: text('params', { mode: 'json' }).notNull().$type<unknown>(),
  checkpoint: text('checkpoint', { mode: 'json' }).$type<unknown>(),
  startedMs: integer('started_ms').notNull(),
  lastUpdatedMs: integer('last_updated_ms').notNull(),
  finalSummary: text('final_summary'),
  fullOutputPath: text('full_output_path'),
}, table => [
  index('background_tasks_session_idx').on(table.sessionId),
  index('background_tasks_completed_idx').on(table.completed),
]);
