/**
 * One-time cleanup script: strips dirty `altText` from attachment JSON
 * stored in the `events` table and clears the `image_alt_texts` table
 * (hash scheme changed from original-image hash to thumbnail hash).
 *
 * Usage: npx tsx scripts/cleanup-alt-text.ts [path-to-db]
 * Default db path: ./data/cahciua.db
 */
import Database from 'better-sqlite3';

const dbPath = process.argv[2] ?? './data/cahciua.db';
const db = new Database(dbPath);

console.log(`Opening database: ${dbPath}`);

// 1. Strip altText from attachments JSON in the events table
const rows = db.prepare(`
  SELECT id, attachments FROM events
  WHERE attachments IS NOT NULL
    AND json_type(attachments) = 'array'
`).all() as { id: number; attachments: string }[];

let updated = 0;
const updateStmt = db.prepare('UPDATE events SET attachments = ? WHERE id = ?');

const txn = db.transaction(() => {
  for (const row of rows) {
    const attachments = JSON.parse(row.attachments);
    let dirty = false;
    for (const att of attachments) {
      if ('altText' in att) {
        delete att.altText;
        dirty = true;
      }
    }
    if (dirty) {
      updateStmt.run(JSON.stringify(attachments), row.id);
      updated++;
    }
  }
});
txn();

console.log(`Stripped altText from ${updated} / ${rows.length} event rows`);

// 2. Clear image_alt_texts table
const deleted = db.prepare('DELETE FROM image_alt_texts').run();
console.log(`Deleted ${deleted.changes} rows from image_alt_texts`);

db.close();
console.log('Done.');
