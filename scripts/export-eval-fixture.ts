import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { loadConfig } from '../src/config/config';
import { setupLogger, useLogger } from '../src/config/logger';
import { createReadonlyDatabase } from '../src/db';
import {
  exportEvalFixtureFromDb,
  fixtureToXml,
  serializeEvalFixture,
} from '../src/evals/fixture-export';
import type { FixtureEventSelector } from '../src/evals/fixture-export';

interface Args {
  chatId: string;
  out: string;
  selector: FixtureEventSelector;
  name?: string;
  includeTurnResponses: boolean;
  turnResponsesAgentId?: string;
  turnResponsesBeforeMs?: number;
  turnResponsesAfterMs?: number;
  previewXml?: string;
}

const readFlagValue = (args: string[], flag: string): string | undefined => {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
  return value;
};

const hasFlag = (args: string[], flag: string): boolean =>
  args.includes(flag);

const readNumber = (args: string[], flag: string): number | undefined => {
  const raw = readFlagValue(args, flag);
  if (raw == null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid number for ${flag}: ${raw}`);
  return value;
};

const usage = () => [
  'Usage:',
  '  pnpm eval:fixture --chat <chatId> --from-message <id> --to-message <id> --out <file>',
  '  pnpm eval:fixture --chat <chatId> --from-ms <ms> --to-ms <ms> --out <file>',
  '  pnpm eval:fixture --chat <chatId> --messages <id,id,...> --out <file> [--include-replies] [--context-before N] [--context-after N]',
  '',
  'Options:',
  '  --name <name>                 Fixture name. Defaults to chatId.',
  '  --include-trs                 Include main-agent turn_responses_v2 in the selected time window.',
  '  --trs-agent <agentId>         Agent id for TR export. Defaults to main.',
  '  --trs-before-ms <ms>          Include TRs this much before selected events.',
  '  --trs-after-ms <ms>           Include TRs this much after selected events.',
  '  --preview-xml <file>          Also write rendered XML preview for manual inspection.',
].join('\n');

const parseArgs = (argv: string[]): Args => {
  const chatId = readFlagValue(argv, '--chat');
  const out = readFlagValue(argv, '--out');
  if (!chatId || !out) throw new Error(usage());

  const fromMessage = readFlagValue(argv, '--from-message');
  const toMessage = readFlagValue(argv, '--to-message');
  const fromMs = readNumber(argv, '--from-ms');
  const toMs = readNumber(argv, '--to-ms');
  const messages = readFlagValue(argv, '--messages');

  const modes = [
    fromMessage != null || toMessage != null,
    fromMs != null || toMs != null,
    messages != null,
  ].filter(Boolean).length;
  if (modes !== 1) throw new Error(`Choose exactly one selector mode.\n\n${usage()}`);

  let selector: FixtureEventSelector;
  if (fromMessage != null || toMessage != null) {
    if (!fromMessage || !toMessage) throw new Error('--from-message and --to-message must be provided together');
    selector = { type: 'messageRange', fromMessageId: fromMessage, toMessageId: toMessage };
  } else if (fromMs != null || toMs != null) {
    if (fromMs == null || toMs == null) throw new Error('--from-ms and --to-ms must be provided together');
    selector = { type: 'receivedRange', fromMs, toMs };
  } else {
    const ids = messages!.split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) throw new Error('--messages must contain at least one id');
    selector = {
      type: 'messages',
      messageIds: ids,
      includeReplies: hasFlag(argv, '--include-replies'),
      contextBefore: readNumber(argv, '--context-before'),
      contextAfter: readNumber(argv, '--context-after'),
    };
  }

  return {
    chatId,
    out,
    selector,
    name: readFlagValue(argv, '--name'),
    includeTurnResponses: hasFlag(argv, '--include-trs'),
    turnResponsesAgentId: readFlagValue(argv, '--trs-agent'),
    turnResponsesBeforeMs: readNumber(argv, '--trs-before-ms'),
    turnResponsesAfterMs: readNumber(argv, '--trs-after-ms'),
    previewXml: readFlagValue(argv, '--preview-xml'),
  };
};

const fixtureImportPath = (outFile: string): string => {
  const rel = relative(dirname(outFile), resolve(process.cwd(), 'src/evals')).replace(/\\/g, '/');
  return rel.startsWith('.') ? rel : `./${rel}`;
};

const main = async () => {
  setupLogger();
  const log = useLogger('eval-fixture');
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const db = createReadonlyDatabase(config.database.path, log);
  const out = resolve(process.cwd(), args.out);

  const { fixture, selected } = await exportEvalFixtureFromDb(db, {
    chatId: args.chatId,
    name: args.name,
    selector: args.selector,
    includeTurnResponses: args.includeTurnResponses,
    turnResponsesAgentId: args.turnResponsesAgentId,
    turnResponsesBeforeMs: args.turnResponsesBeforeMs,
    turnResponsesAfterMs: args.turnResponsesAfterMs,
  });

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, serializeEvalFixture(fixture, fixtureImportPath(out)));

  if (args.previewXml) {
    const previewPath = resolve(process.cwd(), args.previewXml);
    mkdirSync(dirname(previewPath), { recursive: true });
    writeFileSync(previewPath, fixtureToXml(fixture));
  }

  console.log(`Wrote fixture: ${out}`);
  console.log(`Events: ${selected.events.length}`);
  console.log(`Turn responses: ${fixture.turnResponses?.length ?? 0}`);
};

void main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
