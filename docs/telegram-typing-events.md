# Telegram Typing Events: Server-Side Delivery Mechanism

How to reliably receive real-time `UpdateChannelUserTyping` / `UpdateChatUserTyping` events from Telegram's MTProto API without a full GUI client running.

## Problem

A gramjs script listening for typing events via raw update handlers only receives them sporadically. The events arrive briefly after connecting, then stop — unless an Android/desktop client is simultaneously viewing the same chat. A single `markAsRead` call is insufficient to maintain delivery.

## Root Cause

Telegram's server does **not** have an explicit "subscribe to typing events for chat X" API. The server decides whether to push ephemeral updates (typing, online status) to a connection based on the **client's online status**, which decays over time without periodic renewal.

The Android client maintains this status through a combination of periodic heartbeats — not a single one-shot call.

## What the Android Client Does

Source: `TMessagesProj/src/main/java/org/telegram/messenger/` (Telegram Android 11.x)

### 1. Online Status Heartbeat (most critical)

In `MessagesController.updateTimerProc()`, the client sends `account.updateStatus(offline=false)` every ~55 seconds while the app is in the foreground and the screen is on:

```java
// Conditions: app in foreground, screen on, not paused
if (Math.abs(System.currentTimeMillis() - lastStatusUpdateTime) >= 55000 || offlineSent) {
    TL_account.updateStatus req = new TL_account.updateStatus();
    req.offline = false;
    getConnectionsManager().sendRequest(req, ...);
}
```

When the app goes to background or screen turns off: `account.updateStatus(offline=true)`.

**This is the single most important signal.** Without it, the server considers the client offline after some timeout and stops pushing ephemeral updates entirely.

### 2. Read History (on chat open)

When entering a chat, `ChatActivity` triggers `messages.readHistory` (basic group) or `channels.readHistory` (supergroup/channel). This signals "the user is viewing this specific chat" but is a one-shot — it does not maintain the subscription.

### 3. Channel Difference Polling (supergroups/channels)

For channels and supergroups, `ChatActivity.onFragmentCreate()` calls `startShortPoll()` which registers the channel for periodic `updates.getChannelDifference` requests. The server's response includes a `timeout` field indicating when to re-poll. This polling:
- Fetches incremental updates (including typing events in `other_updates`)
- Signals continued interest in the channel
- Stops when `ChatActivity` is destroyed (`startShortPoll(chat, classGuid, true)`)

### 4. Secondary Signals

| Mechanism | API Call | Frequency | Purpose |
|-----------|----------|-----------|---------|
| Message views | `messages.getMessagesViews` | Every 5s (batched) | Reports viewed messages while chat is open |
| Online count | `messages.getOnlines` | Every 5 min (megagroups) | Fetches online member count |
| Network resume | native `resumeNetwork` | On app resume / screen on | Restores full connection priority |

### 5. Background Transition

When the app pauses:
1. `markDialogAsReadNow()` — flush pending read receipts
2. `setOpenedDialogId(0, 0)` — clear active dialog
3. `cancelTyping()` — cancel outgoing typing indicator
4. `account.updateStatus(offline=true)` — go offline
5. `native_pauseNetwork()` — reduce connection priority

## Solution for gramjs Scripts

Replicate the three essential mechanisms:

```typescript
// (1) Online heartbeat — every 50s
await client.invoke(new Api.account.UpdateStatus({ offline: false }));
setInterval(() => {
  client.invoke(new Api.account.UpdateStatus({ offline: false }));
}, 50_000);

// (2) Mark chat as read — one-shot on start
await client.markAsRead(peer);

// (3) For supergroups: periodic getChannelDifference
const poll = async () => {
  const result = await client.invoke(new Api.updates.GetChannelDifference({
    channel: inputChannel,
    filter: new Api.ChannelMessagesFilterEmpty(),
    pts: channelPts,
    limit: 100,
    force: false,
  }));
  const nextSec = result.timeout ?? 30;
  if (result.pts) channelPts = result.pts;
  setTimeout(poll, nextSec * 1000);
};
```

### Priority

1. **`account.updateStatus` heartbeat** — without this, nothing else matters. The server gates all ephemeral update delivery on online status.
2. **`markAsRead`** — secondary signal of chat interest.
3. **`getChannelDifference` polling** — for supergroups/channels, provides both a subscription signal and a fallback delivery path for typing events (they appear in `other_updates`).

### Cleanup on Exit

```typescript
await client.invoke(new Api.account.UpdateStatus({ offline: true }));
await client.disconnect();
```

## Production Implementation

`scripts/watch-typing.ts` is the behavior baseline and diagnostic tool. It implements all three essential mechanisms with proper error handling and cleanup.

The production path mirrors that behavior in:
- `src/telegram/typing-poll.ts` — debounce-scoped typing presence manager. The first active watch starts a shared `account.updateStatus(offline=false)` heartbeat every 50 seconds, each watched chat is primed with `markAsRead(peer)`, and supergroups/channels additionally run `updates.getChannelDifference` using the server-provided timeout.
- `src/telegram/userbot.ts` — raw MTProto update handler for `UpdateChannelUserTyping` and `UpdateChatUserTyping`.
- `src/telegram/typing-action.ts` — shared "typing-like" action classifier used by both raw updates and channel-difference fallback extraction.

The main bot does **not** keep typing presence permanently active. Driver debounce scheduling calls `startTypingPolling(chatId)` while a reply is waiting and `stopTypingPolling(chatId)` when the debounce window ends. This keeps the userbot behavior close to an official client viewing the chat only while the bot is deciding whether to reply.

## Why `markAsRead` Alone Fails

`readHistory` is a one-shot acknowledgment ("I've read up to message N"). It does not establish a persistent subscription. The server's internal "client is interested in this chat" state decays. Only the periodic `account.updateStatus` heartbeat maintains the "client is online" flag that gates ephemeral update delivery.

The Android client never relies on a single call — it continuously asserts online status through the 55s heartbeat loop for the entire duration the app is in the foreground.
