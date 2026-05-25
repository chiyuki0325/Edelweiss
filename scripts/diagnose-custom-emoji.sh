#!/usr/bin/env bash
set -euo pipefail

# Read-only diagnostic for Telegram custom emoji ID/cache mismatches.
# Intended to run on production from /root/Edelweiss, but accepts a repo path:
#   bash scripts/diagnose-custom-emoji.sh /root/Edelweiss

ROOT="${1:-/root/Edelweiss}"
DB="${DB:-$ROOT/data/cahciua.db}"
CONFIG="${CONFIG_PATH:-$ROOT/config.yaml}"
LIMIT="${LIMIT:-80}"

cd "$ROOT"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

need sqlite3
need node

if [[ ! -f "$DB" ]]; then
  echo "database not found: $DB" >&2
  exit 1
fi

if [[ ! -f "$CONFIG" ]]; then
  echo "config not found: $CONFIG" >&2
  exit 1
fi

echo "== Environment =="
printf 'root: %s\n' "$ROOT"
printf 'db: %s\n' "$DB"
printf 'config: %s\n' "$CONFIG"
printf 'head: '
git rev-parse --short HEAD 2>/dev/null || true
echo

echo "== Code Hotspots =="
grep -RIn \
  -e "custom_emoji_id" \
  -e "MessageEntityCustomEmoji" \
  -e "getCustomEmojiStickers" \
  src/telegram src/index.ts src/adaptation 2>/dev/null || true
echo

TMP_IDS="$(mktemp)"
trap 'rm -f "$TMP_IDS"' EXIT

echo "== Local Event Fallbacks =="
sqlite3 -readonly -header -column "$DB" <<SQL
WITH custom_nodes AS (
  SELECT
    e.id AS event_id,
    e.chat_id,
    e.message_id,
    e.text AS message_text,
    json_extract(j.value, '$.customEmojiId') AS emoji_id,
    json_extract(j.value, '$.children[0].text') AS fallback
  FROM events e, json_tree(e.content) j
  WHERE json_valid(j.value)
    AND json_extract(j.value, '$.type') = 'custom_emoji'
)
SELECT
  event_id,
  chat_id,
  message_id,
  emoji_id,
  fallback,
  substr(message_text, 1, 60) AS message
FROM custom_nodes
ORDER BY event_id DESC
LIMIT $LIMIT;
SQL
echo

sqlite3 -readonly "$DB" <<SQL > "$TMP_IDS"
WITH custom_nodes AS (
  SELECT json_extract(j.value, '$.customEmojiId') AS emoji_id
  FROM events e, json_tree(e.content) j
  WHERE json_valid(j.value)
    AND json_extract(j.value, '$.type') = 'custom_emoji'
)
SELECT DISTINCT emoji_id
FROM custom_nodes
WHERE emoji_id IS NOT NULL
ORDER BY emoji_id;
SQL

echo "== Cache Joined With Fallbacks =="
sqlite3 -readonly -header -column "$DB" <<SQL
WITH custom_nodes AS (
  SELECT
    json_extract(j.value, '$.customEmojiId') AS emoji_id,
    json_extract(j.value, '$.children[0].text') AS fallback,
    COUNT(*) AS seen
  FROM events e, json_tree(e.content) j
  WHERE json_valid(j.value)
    AND json_extract(j.value, '$.type') = 'custom_emoji'
  GROUP BY emoji_id, fallback
)
SELECT
  c.emoji_id,
  c.fallback,
  c.seen,
  i.sticker_set_name AS cache_pack,
  substr(i.alt_text, 1, 90) AS cache_alt
FROM custom_nodes c
LEFT JOIN image_alt_texts i ON i.image_hash = 'emoji:' || c.emoji_id
ORDER BY c.emoji_id, c.fallback;
SQL
echo

echo "== Orphan Emoji Cache Rows =="
sqlite3 -readonly -header -column "$DB" <<SQL
WITH event_ids AS (
  SELECT DISTINCT json_extract(j.value, '$.customEmojiId') AS emoji_id
  FROM events e, json_tree(e.content) j
  WHERE json_valid(j.value)
    AND json_extract(j.value, '$.type') = 'custom_emoji'
)
SELECT
  i.image_hash,
  i.sticker_set_name,
  substr(i.alt_text, 1, 90) AS alt_text
FROM image_alt_texts i
LEFT JOIN event_ids e ON i.image_hash = 'emoji:' || e.emoji_id
WHERE i.image_hash LIKE 'emoji:%'
  AND e.emoji_id IS NULL
ORDER BY i.id DESC
LIMIT $LIMIT;
SQL
echo

echo "== Telegram Bot API getCustomEmojiStickers =="
IDS_FILE="$TMP_IDS" CONFIG_FILE="$CONFIG" node <<'NODE'
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const yaml = require('yaml');

const ids = fs.readFileSync(process.env.IDS_FILE, 'utf8')
  .split(/\r?\n/)
  .map(s => s.trim())
  .filter(Boolean);

if (ids.length === 0) {
  console.log('no custom emoji ids found in events');
  process.exit(0);
}

const config = yaml.parse(fs.readFileSync(process.env.CONFIG_FILE, 'utf8'));
const token = config?.telegram?.botToken;
if (!token) {
  console.log('telegram.botToken not found in config');
  process.exit(0);
}

const tokenHash = createHash('sha256').update(token).digest('hex').slice(0, 12);
console.log(`token_sha256_prefix=${tokenHash} ids=${ids.length}`);

const chunks = [];
for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));

const post = async (chunk) => {
  const res = await fetch(`https://api.telegram.org/bot${token}/getCustomEmojiStickers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ custom_emoji_ids: chunk }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(JSON.stringify(body));
  return body.result ?? [];
};

const main = async () => {
  const rows = [];
  for (const chunk of chunks) rows.push(...await post(chunk));

  const byId = new Map(rows.map(s => [s.custom_emoji_id, s]));
  console.log([
    'requested_id',
    'api_found',
    'api_custom_emoji_id',
    'api_emoji',
    'api_set_name',
    'is_animated',
    'is_video',
    'file_unique_id',
  ].join('\t'));

  for (const id of ids) {
    const s = byId.get(id);
    console.log([
      id,
      s ? 'yes' : 'no',
      s?.custom_emoji_id ?? '',
      s?.emoji ?? '',
      s?.set_name ?? '',
      String(Boolean(s?.is_animated)),
      String(Boolean(s?.is_video)),
      s?.file_unique_id ?? '',
    ].join('\t'));
  }
};

main().catch(err => {
  console.error(`telegram api check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
NODE

