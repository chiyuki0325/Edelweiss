// Dedup logic is platform-agnostic and shared with OneBot; the implementation
// lives in src/ingress/message-dedup.ts. Re-exported here so existing Telegram
// imports (telegram/message barrel) keep working.
export { createMessageDedup } from '../../ingress/message-dedup';
