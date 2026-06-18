import type { Logger } from '@guiiai/logg';

import { loadConfig } from '../src/config/config';
import { loadContacts } from '../src/contacts';
import { createDatabase, createReadonlyDatabase, loadCompaction, loadEvents, migrateV1ToV2, runMigrations } from '../src/db';
import { createEmptyIC, reduce } from '../src/projection';
import { rcToXml, render } from '../src/rendering';
import type { RenderParams } from '../src/rendering';

interface Args {
  chatId: string;
  dbPath?: string;
  respectCompaction: boolean;
  botUserId?: string;
  migrate: boolean;
}

const silentLogger: Logger = {
  withContext: () => silentLogger,
  withFields: () => silentLogger,
  withError: () => silentLogger,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  verbose: () => undefined,
} as unknown as Logger;

const usage = () => [
  'Usage:',
  '  pnpm debug:rc --chat <chatId>',
  '  pnpm debug:rc <chatId>',
  '',
  'Options:',
  '  --db <path>              Override config.database.path.',
  '  --respect-compaction     Render the same compacted viewport used on startup.',
  '  --bot-user-id <id>       Override bot user id used for myself/mention rendering.',
  '  --migrate                Run DB migrations before rendering. Default is read-only.',
].join('\n');

const readFlagValue = (args: string[], flag: string): string | undefined => {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
  return value;
};

const parseArgs = (argv: string[]): Args => {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    process.exit(0);
  }

  const valueFlags = new Set(['--chat', '--db', '--bot-user-id']);
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (valueFlags.has(arg)) {
      i++;
      continue;
    }
    if (!arg.startsWith('--')) positionals.push(arg);
  }

  const chatId = readFlagValue(argv, '--chat') ?? positionals[0];
  if (!chatId) throw new Error(usage());
  const allowedPositionals = readFlagValue(argv, '--chat') ? 0 : 1;
  if (positionals.length > allowedPositionals)
    throw new Error(`Unexpected positional arguments: ${positionals.slice(allowedPositionals).join(' ')}`);

  return {
    chatId,
    dbPath: readFlagValue(argv, '--db'),
    respectCompaction: argv.includes('--respect-compaction'),
    botUserId: readFlagValue(argv, '--bot-user-id'),
    migrate: argv.includes('--migrate'),
  };
};

const escapeXmlAttr = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const formatXmlFragment = (xml: string): string => {
  const tokens = xml.match(/<[^>]+>|[^<]+/g) ?? [];
  const lines: string[] = [];
  let depth = 0;

  for (const raw of tokens) {
    const token = raw.trim();
    if (!token) continue;

    if (token.startsWith('</')) depth = Math.max(0, depth - 1);

    const indent = '  '.repeat(depth);
    if (token.startsWith('<')) {
      lines.push(`${indent}${token}`);
      if (!token.startsWith('</') && !token.endsWith('/>') && !token.startsWith('<?') && !token.startsWith('<!'))
        depth++;
    } else {
      for (const line of token.split('\n').map(part => part.trim()).filter(Boolean))
        lines.push(`${indent}${line}`);
    }
  }

  return lines.join('\n');
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const dbPath = args.dbPath ?? config.database.path;
  const db = args.migrate
    ? createDatabase(dbPath, silentLogger)
    : createReadonlyDatabase(dbPath, silentLogger);
  if (args.migrate) {
    runMigrations(db, silentLogger);
    await migrateV1ToV2(db, silentLogger);
  }

  const compaction = args.respectCompaction ? loadCompaction(db, args.chatId) : null;
  const events = loadEvents(db, args.chatId, compaction?.newCursorMs);

  let ic = createEmptyIC(args.chatId);
  for (const event of events)
    ic = reduce(ic, event);

  const botUserId = args.botUserId ?? config.telegram?.botToken.split(':')[0];
  const renderParams: RenderParams = {
    ...(botUserId && { botUserId }),
    contactNames: loadContacts(silentLogger),
    ...(compaction && { compactCursorMs: compaction.newCursorMs }),
  };

  const rc = render(ic, renderParams);
  const body = formatXmlFragment(rcToXml(rc));
  const attrs = [
    `chat-id="${escapeXmlAttr(args.chatId)}"`,
    `events="${events.length}"`,
    `segments="${rc.length}"`,
    ...(compaction ? [`compact-cursor-ms="${compaction.newCursorMs}"`] : []),
  ];

  console.error(`Rendered RC for chat ${args.chatId}: ${events.length} events, ${rc.length} segments`);
  if (compaction) console.error(`Compaction cursor: ${compaction.newCursorMs}`);
  console.log(`<rendered-context ${attrs.join(' ')}>`);
  if (body) console.log(body.split('\n').map(line => `  ${line}`).join('\n'));
  console.log('</rendered-context>');
};

try {
  await main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  if (message.includes('no such column'))
    console.error('The database schema may be older than this checkout. Re-run with --migrate to opt in to migrations, or run the main app first.');
  process.exitCode = 1;
}
