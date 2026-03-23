import { readFileSync } from 'fs';

import type { Logger } from '@guiiai/logg';

interface ContactUser {
  id: string;
  firstName?: string;
  lastName?: string;
  deleted?: boolean;
}

export const loadContacts = (logger: Logger): Map<string, string> => {
  const path = process.env.CONTACTS_PATH ?? 'contacts.json';
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      logger.withFields({ path }).warn('Contacts file not found, skipping');
      return new Map();
    }
    throw err;
  }

  let data: { users?: ContactUser[] };
  try {
    data = JSON.parse(raw);
  } catch (err) {
    logger.withError(err).error('Failed to parse contacts file');
    return new Map();
  }

  const map = new Map<string, string>();
  for (const user of data.users ?? []) {
    if (user.deleted) continue;
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
    if (name) map.set(user.id, name);
  }

  logger.withFields({ count: map.size }).log('Loaded contacts');
  return map;
};
