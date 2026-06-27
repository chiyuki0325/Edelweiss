# RC 变更会触发什么

本文列出 `RenderedContext`（下文简称 RC）变更后可能发生的副作用，以及对应代码位置。

这里的“RC 变更”分两种：

1. Pipeline 内部重新渲染并保存了新的 RC。
2. Driver 收到新的 RC，并写入每个聊天自己的 `rc` signal。

只有第二种会触发 Driver 的自动回复、打断、压缩等逻辑。Pipeline 里只更新 RC，但没有调用 `driver.handleEvent()` 时，Driver 不会立刻知道。

## RC 在哪里被改

### 普通事件进入 Pipeline

代码位置：

- `src/pipeline.ts` 的 `pushEvent()`
- `src/telegram/live-handlers.ts` 的 Telegram `onMessage` / `onMessageEdit` / `onMessageDelete`
- `src/telegram/live-handlers.ts` 的 Telegram `onReactionUpdate`
- `src/telegram/event-sink.ts` 的 `publish()`
- `src/onebot/startup.ts` 的 OneBot `onEvent`
- `src/background-task/manager.ts` 的 `completionFlow()`

发生的事：

- Projection 用事件更新 IC。
- Rendering 从 IC 生成新 RC。
- Pipeline 保存新 RC。
- 如果旧 RC 和新 RC 的 XML 不同，会写一条 RC diff 日志。
- 调用方通常会把新 RC 交给 `driver.handleEvent(chatId, rc)`。

后台任务完成比较特殊：它会先写任务输出和 RuntimeEvent，再 `pushPipelineEvent()`，最后把 RC 交给 Driver。代码位置是 `src/background-task/manager.ts` 的 `completionFlow()`。

### 冷启动回放

代码位置：

- `src/pipeline.ts` 的 `replayChat()`
- `src/startup/index.ts` 启动流程里给 Driver 回放已有 session 的循环
- OneBot 启动后拉取历史消息并 `replayChat()`

发生的事：

- 从 DB 读事件，重建 IC，再渲染 RC。
- Pipeline 保存 RC，并写 `Replayed session` 日志。
- 启动流程随后把每个已有 RC 交给 `driver.handleEvent()`，所以未处理的新消息仍然可能触发 Driver。

### Compact cursor 改变

代码位置：

- `src/driver/index.ts` 的 `disposeCursorEffect`
- `src/container/index.ts` 注入给 Driver 的 `setCompactCursor`
- `src/pipeline.ts` 的 `setCompactCursor()`

发生的事：

- Driver 的 `compactionMeta` 变化后，`cursorMs` 变化。
- `disposeCursorEffect` 调用 `pipeline.setCompactCursor(chatId, cursor)`。
- Pipeline 用新 cursor 重新渲染 RC，过滤 cursor 之前的片段。
- 如果产生新 RC，Driver 再把它写回自己的 `rc` signal。

这意味着一次压缩完成后，可能又触发一轮 Driver 的 RC 相关判断。

### Bot 自己发出的 Telegram 消息

代码位置：

- `src/telegram/driver-hooks.ts` 的 `injectSyntheticEvent()`

发生的事：

- `send_message` 工具通过 Telegram 发消息后，会构造一个 synthetic event。
- 这个 event 会进入 Pipeline，并标记 `isSelfSent = true`。
- 当前代码通过 Telegram event sink 持久化、seed 空 reaction snapshot、hydrate cached alt text、再 `pipeline.pushEvent()`，不调用 `driver.handleEvent()`。

所以 bot 自己发出的消息会更新 Pipeline 的 RC，但不会马上让 Driver 再跑一轮。后续其他事件或启动回放仍会看到这段 RC。

### Telegram reaction 更新

代码位置：

- `src/telegram/bot.ts` 的 `message_reaction` / `message_reaction_count` Bot API handlers
- `src/telegram/manager.ts` 的 reaction ingress queue 分支
- `src/telegram/userbot.ts` 的 `fetchMessageReactions()`
- `src/telegram/live-handlers.ts` 的 `onReactionUpdate`
- `src/db/persistence.ts` 的 `message_reaction_snapshots` snapshot helpers

发生的事：

- Bot API polling 显式订阅 `allowed_updates: ['message', 'message_reaction', 'message_reaction_count']`。
- `message_reaction` 会带 actor 和 `old_reaction` / `new_reaction`，可以直接 diff 出该 actor 新增了哪些 emoji。
- `message_reaction_count` 只带 aggregate counts；reaction ingress queue 会在进入业务 handler 前用 userbot 的 `messages.getMessageReactionsList` 拉取完整 `(emoji, sender)` actor snapshot。
- `src/telegram/live-handlers.ts` 处理 reaction update 时，把新的 actor snapshot 和 `message_reaction_snapshots` 里的上一份 snapshot 做 diff。
- 只有新增的 `(emoji, sender)` pair 才构造 append-only canonical `reaction` event。
- 撤销或减少只更新 snapshot，不进入 IC。
- 如果 message 没有上一份 actor snapshot，第一次 actor snapshot 只用于建立基线，避免把历史 reactions 当成新事件。
- 对 configured chat，reaction event 会 `pipeline.pushEvent()`，从而更新 Pipeline 内部 RC 和 RC diff 日志。
- live reaction ingress **不调用** `driver.handleEvent(chatId, rc)`，所以不会启动 debounce、不会打断正在运行的 LLM call，也不会立即触发 compaction。

Rendering 会把 reaction 渲染成 passive segment，例如：

```xml
<event type="reaction_added" t="..." message_id="123" emoji="👍" sender="..."/>
```

这个 segment 带 `isPassiveEvent = true`。冷启动回放时已有 RC 仍会交给 Driver，但 Driver 的 `latestExternalEventMs()` / `latestInterruptingExternalEventMs()` 会忽略 passive segment，避免单独的历史 reaction 唤醒模型。

## Driver 收到新 RC 后的副作用

Driver 的入口是：

- `src/driver/index.ts` 的 `handleEvent(chatId, newRC)`

如果 `chatId` 不在配置里，直接忽略。否则写入该聊天的 `rc` signal。

## 流程图：RC 变更后的主要路径

下面是普通人读代码时最容易迷路的部分。这里用“待回复批次”表示一组尚未处理完的外部聊天消息。

```text
Pipeline 产出新 RC
        |
        v
driver.handleEvent(chatId, rc)
        |
        v
写入该聊天的 rc signal
        |
        v
reply effect 被唤醒
        |
        +--> 没有待处理输入 / 只有自己消息 / 当前 RC 是失败锁住的 RC
        |        |
        |        v
        |     清理 debounce timer，结束
        |
        +--> 只有 RuntimeEvent 等非聊天打断事件
        |        |
        |        v
        |     不等 debounce，直接 executeLlmCall()
        |
        +--> 有外部聊天消息，且当前没有 LLM call
        |        |
        |        v
        |     如果没有待回复批次 deadline：
        |       设置 deadline = 现在 + maxDelayMs
        |        |
        |        v
        |     启动/延长 debounce timer
        |       - 首次等 initialDelayMs
        |       - 新消息或 typing 等 typingExtendMs
        |       - 但都不能超过 deadline
        |
        +--> 有外部聊天消息，且 LLM call 正在运行
                 |
                 +--> deadline 还没到
                 |        |
                 |        v
                 |     abort 当前 call
                 |     保留同一个 deadline
                 |     下一轮 debounce 用 typingExtendMs
                 |
                 +--> deadline 已到
                          |
                          v
                       不 abort
                       让当前 call 结束，避免一直被插话打断
```

LLM call 结束后的清理：

```text
executeLlmCall() 结束
        |
        +--> 是因为新外部消息打断
        |        |
        |        v
        |     保留当前待回复批次 deadline
        |     重新调度下一次 call
        |
        +--> 不是因为新外部消息打断
                 |
                 v
              清掉 deadline
              后续仍未处理的新消息会成为下一批
```

### 判断是否需要回复

代码位置：

- `src/driver/index.ts` 的 `needsReply`
- `src/driver/context.ts` 的 `latestExternalEventMs()`
- `src/driver/context.ts` 的 `latestInterruptingExternalEventMs()`

判断规则：

- 空 RC 不回复。
- 如果当前 RC 等于上次失败时的 RC，不自动重试。
- 在线模式下，只要 `lastProcessedMs` 之后有非自己的事件，就可能回复。
- 离线模式下，只有 `@mention` 或回复 bot 才会回复。
- `isRuntimeEvent` 会唤醒 Driver，但不会打断正在运行的 LLM call。
- `isMyself` 的片段不会触发回复。
- `isPassiveEvent` 的片段不会触发回复，也不会打断正在运行的 LLM call。当前用于 Telegram reaction event。

### 等待一小段时间再回复

代码位置：

- `src/driver/index.ts` 的 `disposeReplyEffect`
- `src/driver/index.ts` 的 `debounceTimerCallback`
- `src/telegram/driver-hooks.ts` 的 `onDebounceStateChange`
- `src/telegram/manager.ts` 的 `startTypingPolling()` / `stopTypingPolling()`

发生的事：

- 如果新 RC 里有外部聊天消息，Driver 会启动 debounce timer。
- 第一条待处理外部消息会创建一个待回复批次 deadline：`Date.now() + maxDelayMs`。
- 第一次等待 `initialDelayMs`，但不会超过 deadline。
- 等待期间又来了新 RC，会清掉原 debounce timer，改等 `typingExtendMs`，也不会超过 deadline。
- `maxDelayMs` 是这一批消息的硬上限；等待期间的新消息不会重置它。
- Telegram 聊天开始等待时，会启动 typing polling；等待结束或取消时停止。
- 如果最近有用户 typing，timer 到点后还会再延长一次 `typingExtendMs`，同样受 deadline 限制。

### 打断正在运行的 LLM call

代码位置：

- `src/driver/index.ts` 的 `disposeReplyEffect`
- `src/driver/index.ts` 的 `hasInterruptingInputDuringActiveRun()`
- `src/driver/index.ts` 创建 `AbortController` 后的复查
- `src/driver/runner.ts` 的 `runStepLoop()`

发生的事：

- 如果 LLM call 正在运行，Driver 看到新的外部聊天消息，会 abort 当前 `AbortController`。
- 只有当前 run 开始之后的新外部聊天消息会打断。
- 打断只发生在当前待回复批次 deadline 之前；deadline 到了以后，普通新消息不会继续 abort 当前 call。
- RuntimeEvent 不打断当前 call，只是让下一轮有机会处理。
- 打断后下一轮等待使用 `typingExtendMs`，不是重新用 `initialDelayMs`，并且沿用原来的 deadline。
- 如果新消息正好出现在 `running(true)` 后、`AbortController` 建好前，创建 controller 后会再检查一次，避免漏掉。

Runner 内部还有一步级别的检查：每个 step 完成后，`checkInterrupt()` 会读当前 `rc()`；如果和本轮开始时不同，并且有新的外部事件，就停止继续 tool loop。deadline 到了以后，普通聊天消息不再让这个检查中断当前 loop；RuntimeEvent 仍可在 step 边界唤醒下一轮处理。

这个 deadline 不在 `send_message` 工具里重置。它属于 Driver 调度状态，因为一轮 LLM 可能静默、可能失败、可能调用多个工具，也可能根本不调用 `send_message`。

### 立即启动 LLM call

代码位置：

- `src/driver/index.ts` 的 `disposeReplyEffect`
- `src/driver/index.ts` 的 `executeLlmCall()`
- `src/driver/runner.ts` 的 `runStepLoop()`

发生的事：

- 如果需要回复，但没有“打断性”的外部聊天消息，例如 RuntimeEvent，Driver 不走 debounce，直接启动 LLM call。
- `executeLlmCall()` 会清掉 debounce timer，并停止 typing polling。
- 它读取当前 RC、TR、compaction summary，组装上下文。
- 主模型运行后，每一步结果会通过 `persistTurnResponse()` 写入 DB，并更新 `lastProcessedMs`。
- 工具调用可能继续产生副作用，比如发消息、下载文件、启动后台任务。

### 失败后不对同一份 RC 自动重试

代码位置：

- `src/driver/index.ts` 的 `failedRc`
- `src/driver/index.ts` 的 `executeLlmCall()` catch 分支
- `src/driver/index.ts` 的 `needsReply`

发生的事：

- LLM call 抛错后，Driver 把本轮开始时的 RC 记到 `failedRc`。
- `needsReply` 发现当前 RC 就是 `failedRc` 时返回 false。
- 只有后续新 RC 到来，才会再次尝试。

### 离线模式自动恢复

代码位置：

- `src/driver/index.ts` 的 `executeLlmCall()` finally 分支
- `src/driver/index.ts` 的 `setOfflineMode()`
- `src/telegram/live-handlers.ts` 的 `/offline` / `/online` 命令处理

发生的事：

- 离线模式下，只有 mention 或回复 bot 会让 RC 触发回复。
- 如果一次 LLM call 是在离线模式下触发的，call 结束后会自动把该聊天切回在线。
- 如果用户在 call 正在运行时发送 `/offline`，当前 call 不会被取消。

## RC 变更还会触发压缩检查

代码位置：

- `src/driver/index.ts` 的 `disposeCompactionEffect`
- `src/driver/context.ts` 的 `composeContext()`
- `src/driver/context.ts` 的 `findWorkingWindowCursor()`
- `src/driver/compaction.ts` 的 `runCompaction()`

发生的事：

- 每次 Driver 的 `rc` signal 变更，compaction effect 都会被唤醒。
- 空 RC 不检查。
- 如果压缩已经在跑，不重复启动。
- 如果这次 RC 和上次检查过的是同一个对象，不重复检查。
- 真正检查放在 `setTimeout(..., 0)` 里跑，避免卡住 signal effect。
- 它读取 TR，调用 `composeContext()` 估算上下文长度。
- 如果没超过 `compaction.maxContextEstTokens`，什么都不做。
- 如果超过阈值，计算新的 cursor，调用压缩模型生成 summary。
- 压缩结果通过 `persistCompaction()` 写 DB。
- `compactionMeta` 更新后，cursor effect 会让 Pipeline 用新 cursor 重新渲染 RC。

## 不会立刻发生的事

- 只调用 `pipeline.pushEvent()`，但不调用 `driver.handleEvent()`：Driver 不会立刻回复、打断或压缩。
- `isMyself` 片段：不会触发回复判断。
- `isSelfSent` 片段：在组装 LLM 上下文时会被 `composeContext()` 过滤，避免 bot 自己通过 `send_message` 发出的内容和 TR 重复。
- RuntimeEvent：会唤醒 Driver，但不会打断正在运行的 LLM call。
- 未配置聊天：`driver.handleEvent()` 直接忽略。

## 快速查代码

- RC 类型：`src/rendering/types.ts`
- RC 渲染：`src/rendering/index.ts`
- Pipeline 保存 RC：`src/pipeline.ts`
- Driver RC signal 与 effects：`src/driver/index.ts`
- 回复判断辅助函数：`src/driver/context.ts`
- LLM step loop：`src/driver/runner.ts`
- Telegram typing polling：`src/telegram/manager.ts` + `src/telegram/typing-poll.ts`
- 后台任务完成产生 RuntimeEvent：`src/background-task/manager.ts`
