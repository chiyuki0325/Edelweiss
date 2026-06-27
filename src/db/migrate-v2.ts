import type { Logger } from '@guiiai/logg';
import { sql } from 'drizzle-orm';

import type { DB } from './client';
import { codec } from './codec';
import { turnResponses, turnResponsesV2 } from './schema';
import type { ChatCompletionsEntry } from '../unified-api/chat-types';
import {
  migrateChatEntries,
  migrateResponsesEntries,
  type MigrationFunctionCallOutput,
  type MigrationToolMessage,
} from '../unified-api/migrations';
import type { ResponsesDataItem } from '../unified-api/responses-types';
import type { ConversationEntry } from '../unified-api/types';

const migrateRowEntries = (provider: string, data: unknown): ConversationEntry[] => {
  if (!Array.isArray(data))
    throw new Error(`v1 row has non-array data (provider=${provider})`);
  if (provider === 'openai-chat')
    return migrateChatEntries(data as (ChatCompletionsEntry | MigrationToolMessage)[]);
  if (provider === 'responses')
    return migrateResponsesEntries(data as (ResponsesDataItem | MigrationFunctionCallOutput)[]);
  throw new Error(`Unknown provider in v1 row: ${provider}`);
};

/**
 * One-shot backfill of turn_responses → turn_responses_v2.
 * Runs inside a single transaction; any failure rolls back and rethrows.
 * Skipped if the v2 table already contains rows.
 */
export const migrateV1ToV2 = async (db: DB, logger: Logger): Promise<void> => {
  const log = logger.withContext('migrate-v2');

  const v2TurnCount = db.select({ c: sql<number>`count(*)` }).from(turnResponsesV2).get()?.c ?? 0;
  if (v2TurnCount > 0) {
    log.log('v2 tables already populated — skipping backfill');
    return;
  }

  const v1Turns = db.select().from(turnResponses).all();
  if (v1Turns.length === 0) {
    log.log('no v1 rows — skipping backfill');
    return;
  }

  log.withFields({ turns: v1Turns.length }).log('Backfilling v1 → v2');

  const turnInserts = await Promise.all(v1Turns.map(async row => ({
    chatId: row.chatId,
    requestedAt: row.requestedAt,
    entries: await codec.stringify(migrateRowEntries(row.provider, row.data)),
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    modelName: '',
  })));

  db.transaction(tx => {
    for (const t of turnInserts) tx.insert(turnResponsesV2).values(t).run();
  });

  log.log('Backfill complete');
};
