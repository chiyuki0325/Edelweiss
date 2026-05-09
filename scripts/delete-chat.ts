/**
 * Delete all records for a specific chat from the database.
 *
 * Usage: npx tsx scripts/delete-chat.ts <chat_id> [path-to-db]
 * Default db path: ./data/cahciua.db
 */
import * as readline from 'node:readline';

import Database from 'better-sqlite3';

const chatId = process.argv[2];
if (!chatId) {
  console.error('Usage: npx tsx scripts/delete-chat.ts <chat_id> [path-to-db]');
  process.exit(1);
}

const dbPath = process.argv[3] ?? './data/cahciua.db';
const db = new Database(dbPath);

const tables: { name: string; column: string }[] = [
  { name: 'messages', column: 'chat_id' },
  { name: 'events', column: 'chat_id' },
  { name: 'turn_responses', column: 'chat_id' },
  { name: 'turn_responses_v2', column: 'chat_id' },
  { name: 'subagents', column: 'chat_id' },
  { name: 'subagent_messages', column: 'chat_id' },
  { name: 'probe_responses', column: 'chat_id' },
  { name: 'probe_responses_v2', column: 'chat_id' },
  { name: 'compactions', column: 'chat_id' },
];

// Count records first
console.log(`Chat ID: ${chatId}`);
console.log(`Database: ${dbPath}\n`);

const counts: { name: string; count: number }[] = [];
let total = 0;

for (const { name, column } of tables) {
  const row = db.prepare(`SELECT COUNT(*) as c FROM ${name} WHERE ${column} = ?`).get(chatId) as { c: number };
  const count = row.c;
  counts.push({ name, count });
  total += count;
}

// background_tasks uses session_id
const bgRow = db.prepare(
  'SELECT COUNT(*) as c FROM background_tasks WHERE session_id = ? OR session_id LIKE ?',
).get(chatId, `${chatId}:%`) as { c: number };
counts.push({ name: 'background_tasks', count: bgRow.c });
total += bgRow.c;

console.log('Records to delete:\n');
for (const { name, count } of counts) {
  if (count > 0) console.log(`  ${name}: ${count}`);
}
console.log(`\n  TOTAL: ${total}\n`);

if (total === 0) {
  console.log('No records found for this chat. Nothing to delete.');
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Type the chat_id again to confirm deletion: ', answer => {
  rl.close();
  if (answer !== chatId) {
    console.log('Confirmation mismatch. Aborting.');
    process.exit(0);
  }

  const del = db.transaction(() => {
    for (const { name, column } of tables) {
      const info = db.prepare(`DELETE FROM ${name} WHERE ${column} = ?`).run(chatId);
      if (info.changes > 0) console.log(`  ${name}: ${info.changes} rows deleted`);
    }

    const bgInfo = db.prepare(
      'DELETE FROM background_tasks WHERE session_id = ? OR session_id LIKE ?',
    ).run(chatId, `${chatId}:%`);
    if (bgInfo.changes > 0) console.log(`  background_tasks: ${bgInfo.changes} rows deleted`);
  });

  del();
  console.log('\nDone.');
});
