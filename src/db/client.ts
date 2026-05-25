import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Logger } from '@guiiai/logg';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import * as schema from './schema';

export type DB = ReturnType<typeof createDatabase>;

const openDatabase = (dbPath: string, logger: Logger, readonly: boolean) => {
  const log = logger.withContext('db');

  const sqlite = new Database(dbPath, readonly ? { readonly: true, fileMustExist: true } : undefined);
  if (!readonly) sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema });

  log.withFields({ path: dbPath, readonly }).log('Database opened');

  return db;
};

export const createDatabase = (dbPath: string, logger: Logger) => {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  return openDatabase(dbPath, logger, false);
};

export const createReadonlyDatabase = (dbPath: string, logger: Logger) =>
  openDatabase(dbPath, logger, true);

export const runMigrations = (db: DB, logger: Logger) => {
  const log = logger.withContext('db');

  // foreign_keys must be OFF during migrations (DDL may drop/recreate referenced tables)
  // and cannot be toggled inside a transaction, so we set it before Drizzle's BEGIN
  db.run(sql`PRAGMA foreign_keys = OFF`);

  try {
    log.log('Running migrations...');
    migrate(db, { migrationsFolder: './drizzle' });
    log.log('Migrations complete');
  } finally {
    db.run(sql`PRAGMA foreign_keys = ON`);
  }
};
