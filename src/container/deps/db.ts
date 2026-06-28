import { createDatabase, runMigrations } from '../../db';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export default function registerDb({ get, register }: Registrar): void {
  register(TOKENS.DB, () => {
    const config = get(TOKENS.CONFIG);
    const log = get(TOKENS.LOGGER);
    const db = createDatabase(config.database.path, log);
    runMigrations(db, log);
    return db;
  });
}
