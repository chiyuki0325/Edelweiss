# Edelweiss Agent Guide

Reference for contributors and coding agents working on the Edelweiss codebase. Improve code when you touch it; avoid one-off patterns.

**Maintenance rule**: When you add, rename, or remove a file, change a key pattern, or complete a milestone — update this file in the same commit. Outdated docs are worse than no docs.

## What Is Edelweiss

Edelweiss is a Telegram / QQ group chat bot built on the **Deterministic Context Pipeline (DCP)** architecture from Cahciua. DCP constructs LLM context through a three-layer pure-function pipeline:

1. **Adaptation**: Platform Event → CanonicalIMEvent (anti-corruption layer).
2. **Projection**: `IC' = Reducers(IC, CanonicalIMEvent)` — pure-function state machine producing an Intermediate Context (IC).
3. **Rendering**: `RC = Render(IC, RenderParams)` — serialization with viewport filtering, producing Rendered Context (RC).

The Driver layer sits after Rendering: it merges RC (chat context) with its own TRs (bot responses, tool results) by timestamp to assemble the final LLM API request. Driver owns tool call loops, reactive scheduling, and context compaction. Supports three API formats: OpenAI Chat Completions (`openai-chat`, via xsai with SSE streaming), OpenAI Responses API (`responses`, via direct fetch with SSE streaming), and Anthropic Messages API (`anthropic-messages`, via direct fetch with SSE streaming). TRs are stored as provider-agnostic `ConversationEntry[]` via the unified API layer; format conversion happens at API boundaries when composing context or sending requests.

Key design goals: KV Cache friendly (append-only history, static system prompt, epoch-based compaction), group chat native (message batching, multi-user identity tracking, anti-injection via XML fencing), autonomous reply (bot decides whether to respond via Tool Call, not synchronous response).

## Current Progress

| Layer | Status | Notes |
|-------|--------|-------|
| Telegram integration | Done | Bot + userbot, dedup, fileId merge, credential redaction, per-session ingress queue, blocking image-to-text (spoiler photos require manual `read_image`), blocking animation-to-text, blocking custom-emoji-to-text, send message reactions via bot, receive message reactions via Bot API updates with 500ms add/remove debounce, fetch reaction actors via userbot for count-only updates |
| OneBot integration | Done | OneBot 11 reverse WebSocket server with graceful shutdown and latest-connection ownership, access-token check, message/notice adaptation, NapCat QQ display names (`get_friend_list` remark → `raw.sendRemarkName` → `raw.sendMemberName` / card → `raw.sendNickName` / nickname), QQ face descriptions, metadata-only ordinary-photo adaptation, NapCat `get_image`/`get_file`-backed sticker classification and image hydration (never directly trusts ephemeral event URLs), reconnect-safe send/download PlatformAdapter, fail-closed channel routing (never falls back to Telegram), entry-time ingress timestamp capture, per-chat ordered ingress queue (bounded-retry-then-drop, fail-closed), shared (chatId, messageId) dedup across live ingress and cold-start history pull, cold-start media classification / alt-text backfill (best-effort), self-sent synthetic event injection on send |
| Adaptation | Done | Types, conversion, dual timestamps, rich text parsing, string IDs, phantom edit filtering, platform-resolved `isMyself` identity |
| DB / Persistence | Done | events, messages, turn_responses, turn_responses_v2, compactions, image_alt_texts, subagents, subagent_messages, background_tasks, message_reaction_snapshots tables; 31 migrations |
| Projection | Done | Reducer (message/blocked-message/edit/delete/reaction), MetaReducer (user rename detection), Immer-based immutability |
| Rendering | Done | `render(IC, RenderParams) → RC`, XML serialization, viewport filtering, thumbnail content pieces, passive reaction event rendering, blocked-message placeholders as deleted messages, inline `<image>` / `<animation>` / `<sticker>` / `<custom-emoji>` alt text rendering |
| Driver | Done | Triple-provider SSE streaming (OpenAI Chat Completions via xsai + Responses API via fetch + Anthropic Messages API via fetch), unified API codec layer (provider-agnostic IR with format conversion at boundaries), platform-resolved `chat_name` / `chat_id` system-prompt prefix, lane-based tool execution (`enter_focus` prelude, parallel reads, serialized writers/messages, attachment writer barrier), Telegram-only `react_message`, semantic follow-up review for `send_message` drafts containing “确实” (preserve substantive content or react), per-step TR persistence (v2 schema), lightweight turn lifecycle (`TurnContext` + `TurnScratch` + internal `DriverFeature` hooks), mid-turn interruption, reasoning sanitization (per-provider format), reactive orchestration (alien-signals), automatic and `/compact`-triggered context compaction (LLM-based summarization with append-only history), subagent delegation with isolated helper context and mailbox communication, skills system (user-facing tool definitions loaded from markdown files), background tasks (long-running shell tasks with lifecycle management), typing-aware debounce scheduling (debounce-scoped Telegram typing presence with online heartbeat / markAsRead / supergroup channel-difference fallback), offline/online reply gating via /offline /online commands, rtk output compaction (optional argv0 rewriting + pipe fallback for bash tool) |
| Eval harness | Initial | Offline LLM eval suites for comparing prompt variants against fixed IC fixtures, repeated runs, custom TypeScript evaluators, side-effect-free tool traces, and probability summaries |

## Tech Stack

- **Runtime**: Node.js (>=22), TypeScript, tsx (dev), tsdown (build).
- **Telegram Bot API**: grammY — primary message handling, sending replies, commands.
- **Telegram User API**: gramjs (`telegram` on npm) — MTProto client for history fetching, reply-to context resolution, seeing other bots' messages.
- **OneBot 11**: reverse WebSocket over `ws` — QQ ingress/egress via array message segments, with optional bearer access token. Outbound fenced code blocks can be rendered to images through the optional system `silicon` binary; if unavailable or failing, OneBot send falls back to plain text and logs a warning.
- **LLM**: Three API format paths — OpenAI Chat Completions (via xsAI `chat()` with `stream: true`), OpenAI Responses API (via direct `fetch` with SSE streaming), and Anthropic Messages API (via direct `fetch` with SSE streaming). A unified API layer (`src/unified-api/`) provides provider-agnostic intermediate representation (`ConversationEntry[]`) with bidirectional codecs: each producer (streaming parser) emits IR, and each consumer (API sender) converts IR back to provider wire format. `composeContext()` builds a `ConversationEntry[]`: user content parts use `InputMessage` with `InputPart[]`, while assistant/tool entries are `OutputMessage` / `ToolResult`. Final conversion happens at the last send boundary via `toChatCompletionsInput()` / `toResponsesInput()` / `toMessagesInput()`. The provider-agnostic transport layer lives in `src/llm/`: SSE streaming helpers `src/llm/streaming.ts` (chat), `src/llm/streaming-responses.ts` (responses), and `src/llm/streaming-messages.ts` (anthropic-messages) parse chunks and emit IR; `src/llm/types.ts` holds `ProviderFormat` / `LlmEndpoint` / `ThinkingConfig` / `Usage`. Per-model `thinking` config is mapped only at API boundaries: chat uses flat `reasoning_effort` when enabled, responses uses `output_config.effort`, and Anthropic Messages uses `thinking.budget_tokens`. The Driver's `call-llm.ts` dispatches through these.
- **Image processing**: sharp — thumbnails, GIF frame extraction, image resizing.
- **Animation processing**: ffmpeg-static + ffprobe-static (bundled binaries via npm) — MP4/WEBM frame extraction; lottie-frame (native rlottie + libpng addon) — TGS/Lottie frame rendering. System deps: `libpng-dev`, `librlottie-dev`.
- **Database**: SQLite via better-sqlite3, Drizzle ORM.
- **State management**: Immer — immutable IC updates in Projection reducers.
- **Reactivity**: alien-signals — signal/computed/effect graph for Driver orchestration.
- **Validation**: Valibot — schema validation for config and other runtime inputs where schemas are defined.
- **Prompts**: @velin-dev/core — LLM prompt templates are velin templates (`.velin.md`) in the `prompts/` directory, rendered via `renderMarkdownString`. Configured system files may also be plain markdown files. Never hardcode prompt strings in source code.
- **Logging**: @guiiai/logg — structured logger with pretty/JSON output.
- **Dependency injection**: tsyringe — factory-registration mode only (no `@injectable`/`@inject` decorators). The composition root in `src/container/` registers each `create*(deps)` factory via `useFactory`; subsystems stay plain closure factories. Requires `reflect-metadata` imported before tsyringe loads (done at `src/index.ts` and `src/container/index.ts`).
- **Testing**: Vitest.
- **Linting**: ESLint with `@typescript-eslint`, `@stylistic/eslint-plugin`, `eslint-plugin-import`.
- **Package manager**: pnpm (hoisted `node_modules` via `.npmrc`).

## Project Structure

```
src/
├── index.ts                # Entry point — `import 'reflect-metadata'` (tsyringe polyfill) + thin error-handling shell around startup/startApp()
├── pipeline.ts             # Per-chat IC/RC state manager (reduce → render → log → dump)
├── prompt-template.ts      # Shared Velin template rendering cleanup used by production prompts and evals
├── http.ts                 # HTTP client with credential redaction (registerHttpSecret)
├── contacts.ts             # Contact list loader (contacts.json → Map<id, displayName>)
├── runtime-event.ts        # RuntimeEvent types for Driver-generated synthetic events (e.g. background task completion)
├── adaption-types.ts       # CanonicalIMEvent, CanonicalUser, ContentNode, platform-resolved self identity, etc.
├── config/
│   ├── config.ts           # Unified YAML config loader (Valibot schema)
│   └── logger.ts           # @guiiai/logg setup (pretty in dev, JSON in prod)
├── container/              # Dependency injection composition root (tsyringe, factory-registration mode)
│   ├── tokens.ts           # Phantom-typed InjectionToken registry (TOKENS) + grouped provider interfaces (ChatPolicy, AltTextPolicy, FeatureSets, DescriptionSemaphores, OneBotHolder)
│   ├── registrar.ts        # Registrar interface shared by deps/ registration functions
│   ├── index.ts            # buildContainer(): async; fs.readdirSync scans deps/, dynamic import() calls each export default function(registrar) in sorted order
│   └── deps/               # One file per register(TOKENS.X, ...) call; each exports default function(registrar). Add/remove a file to change registrations — no manual module list
├── startup/                # Platform-neutral application startup orchestration
│   ├── index.ts            # startApp(): builds container, runs async-only steps (v2 migration, cold-start replay, OneBot WS await, lifecycle/shutdown)
│   ├── chat-selection.ts   # Startup chat selection helpers (configured replay whitelist / in-memory residency checks)
│   ├── chat-selection.test.ts # Startup chat selection tests
│   ├── platform-registry.ts # Driver PlatformAdapter registry for platform startup modules
│   └── platform-registry.test.ts # Platform registry tests
├── projection/             # Layer 2: IC' = Reducers(IC, Event)
│   ├── types.ts            # IntermediateContext, ICMessage, ICSystemEvent, ICUserState
│   ├── reduce.ts           # reduce(IC, CanonicalIMEvent) → IC' with Immer
│   ├── reduce.test.ts      # Reducer unit tests
│   └── index.ts            # Barrel exports
├── rendering/              # Layer 3: IC + RenderParams → RenderedContext (RC)
│   ├── types.ts            # RenderParams, RenderedContentPiece, RenderedContextSegment, RenderedContext
│   ├── index.ts            # render(), rcToXml(), XML serialization of ContentNode/attachments
│   └── index.test.ts       # Rendering unit tests
├── llm/                    # Provider-agnostic LLM transport layer (SSE streaming + wire types)
│   ├── types.ts            # ProviderFormat, LlmEndpoint, Usage
│   ├── sse.ts              # Shared SSE line-buffer parser used by all provider streamers
│   ├── streaming.ts        # SSE streaming chat: parses OpenAI-compat SSE → ChatCompletion → IR
│   ├── streaming-responses.ts # SSE streaming responses: parses Responses API SSE → IR
│   ├── streaming-messages.ts  # SSE streaming messages: parses Anthropic Messages SSE → IR
│   ├── responses-types.ts   # OpenAI Responses API wire types (Response* prefix; consumed by streaming-responses)
│   └── index.ts            # Barrel exports
├── media/                  # Cross-subsystem media description / frame extraction / thumbnails
│   ├── llm-description.ts     # Shared utilities for image/animation description LLM calls (semaphore, streaming helpers)
│   ├── frame-extractor.ts     # Frame extraction from animations (MP4/WEBM via ffmpeg, GIF via sharp, TGS via lottie-frame)
│   ├── frame-extractor.test.ts # Frame extraction tests
│   ├── thumbnail.ts         # sharp-based thumbnail generation (pixel-budget ≤75k pixels ≈ 100 Claude tokens)
│   ├── image-to-text.ts     # Blocking image→alt text workflow + cache lookup/persist + model calls
│   ├── image-to-text.test.ts # Image-to-text workflow tests
│   ├── image-to-text-prompt.ts # Velin prompt renderer for image description workflow
│   ├── animation-to-text.ts   # Blocking animation→alt text workflow (GIF, animated/video stickers)
│   ├── animation-to-text-prompt.ts # Velin prompt renderer for animation description workflow
│   ├── custom-emoji-to-text.ts  # Blocking custom emoji→alt text workflow (static + animated)
│   ├── custom-emoji-to-text-prompt.ts # Velin prompt renderer for custom emoji description workflow
│   └── index.ts            # Barrel exports
├── unified-api/            # Provider-agnostic IR layer (ConversationEntry codec)
│   ├── types.ts            # ConversationEntry, Message, InputMessage, OutputMessage, ToolResult, InputPart, OutputPart, Extra
│   ├── chat-types.ts       # OpenAI Chat Completions wire types
│   ├── responses-types.ts  # OpenAI Responses API wire types
│   ├── anthropic-types.ts  # Anthropic Messages API wire types
│   ├── anthropic.test.ts   # Anthropic Messages codec round-trip tests
│   ├── codec.ts            # createCodec() — bidirectional provider ↔ IR converters
│   ├── codec.test.ts       # Codec round-trip tests
│   ├── from-chat-output.ts    # Chat Completions output → IR
│   ├── from-responses-output.ts # Responses API output → IR
│   ├── from-messages-output.ts  # Anthropic Messages output → IR
│   ├── to-chat-input.ts       # IR → Chat Completions input
│   ├── to-responses-input.ts  # IR → Responses API input
│   ├── to-messages-input.ts   # IR → Anthropic Messages input
│   ├── reasoning.ts        # stripReasoning() — cross-provider reasoning signature handling
│   ├── migrations.ts       # Historical TR data migration helpers (v1 → v2)
│   ├── fixtures.ts         # Test fixtures for codec tests
│   ├── fixtures.test.ts    # Fixture validation tests
│   ├── shared.ts           # Shared helpers (image extraction, text assembly)
│   └── index.ts            # Barrel exports
├── driver/                 # Driver: RC + TRs → LLM API calls
│   ├── types.ts            # TurnResponseV2, DriverConfig, CompactionConfig, CompactionSessionMeta, PlatformAdapter
│   ├── context.ts          # Pure functions: context composition (ConversationEntry[]), token trimming, reasoning sanitization, working window cursor
│   ├── context.test.ts     # Context composition tests
│   ├── merge.ts            # mergeContext(RC, TRs) → ContextChunk[] — timestamp-ordered interleave
│   ├── merge.test.ts       # Merge logic tests
│   ├── constants.ts        # Driver-scoped constants and dump-dir bootstrap helpers
│   ├── call-llm.ts         # Unified LLM call dispatcher (openai-chat / responses / anthropic-messages)
│   ├── call-llm.test.ts    # LLM dispatcher mapping tests, including OpenAI-compatible cache usage fields
│   ├── runner.ts           # LLM step executor: triple-provider SSE streaming + lane-based tool scheduling (prelude/read/write/message/serial)
│   ├── compaction.ts       # Context compaction: LLM-based conversation summarization (triple-provider)
│   ├── scheduler.ts        # Driver scheduler controller: reply eligibility, debounce/typing timers, active-run interruption, begin/settle state
│   ├── scheduler.test.ts   # Scheduler state-operation tests
│   ├── turn-features.ts    # DriverFeature hook interface + fixed prepare-phase runner
│   ├── turn-phases.ts      # Turn lifecycle phase runner: prepare, shared step loop, finish/fail/cleanup hook dispatch
│   ├── turn-phases.test.ts # Turn lifecycle phase tests for abort, skip, failure, and cleanup behavior
│   ├── turn-loop.ts        # Shared TurnState step loop used by main turns and subagents; runs DriverFeature step hooks around runner step executors
│   ├── turn-loop.test.ts   # Turn loop raw-vs-persisted entry tests
│   ├── features/           # Internal main-turn DriverFeature factories; main.ts is the fixed ordering point, TurnScratch carries per-turn feature scratch data
│   │   ├── types.ts        # MainTurnFeatureDeps + scheduler/tool/prompt dependency types for feature factories
│   │   ├── main.ts         # createMainTurnFeatures(): fixed main feature ordering
│   │   └── *.ts            # One factory per feature: context, interruption, reaction, capability, tools, skill, prompt, mailbox, persistence, cleanup, etc.
│   ├── prompt.ts           # Prompt rendering — loads all velin templates from prompts/; main prompt starts with sanitized chat_name/chat_id metadata
│   ├── skills.ts           # Skill loader: reads markdown files/directories from skills/ folder → SkillInfo map
│   ├── tools/               # Tool definitions, one file per tool + shared types/execution/barrel
│   │   ├── types.ts          # CahciuaTool, ToolResult, createTool, SendMessageAttachment, SendMessageTurnFlags
│   │   ├── bash.ts           # createBashTool + built-in pseudo commands (chat_info, skill_info)
│   │   ├── send-message.ts   # createSendMessageTool
│   │   ├── web-search.ts     # createWebSearchTool (Tavily)
│   │   ├── web-fetch.ts      # createWebFetchTool
│   │   ├── download-file.ts  # createDownloadFileTool
│   │   ├── read-image.ts     # createReadImageTool
│   │   ├── load-skill.ts     # createLoadSkillTool
│   │   ├── stay-silent.ts    # createStaySilentTool
│   │   ├── react-message.ts  # createReactMessageTool (Telegram only)
│   │   ├── kill-task.ts      # createKillTaskTool
│   │   ├── read-task-output.ts # createReadTaskOutputTool
│   │   ├── sleep.ts          # createSleepTool
│   │   ├── attachment-downloader.ts # Shared file_id→Buffer resolver (Telegram + OneBot)
│   │   ├── execution.ts      # extractToolCalls, extractLoadedSkillNames, executeToolCall
│   │   ├── index.ts          # Barrel re-exports
│   │   └── index.test.ts     # Tool unit tests
│   ├── send-message-human-likeness.ts # Heuristics for recent send_message human-likeness feedback (7 configurable checks)
│   ├── send-message-human-likeness.test.ts # Human-likeness heuristic tests
│   ├── turn-state.ts      # Explicit ChatScope / SchedulerState / TurnState / capability types for driver turn-loop refactors
│   ├── turn-state.test.ts # Driver turn/scheduler default-state tests
│   ├── system-prompt.test.ts # System prompt tests
│   ├── index.test.ts      # Driver reactive scheduling/debounce tests
│   ├── tool-providers.ts   # Capability-driven Driver tool assembly providers
│   ├── tool-providers.test.ts # Tool-provider channel routing tests, including OneBot fail-closed send behavior
│   ├── subagents/          # Subagent runtime: isolated helper manager, mailbox, lifecycle/types, communication/finalize tools
│   │   ├── types.ts        # AgentId, SubagentState, AgentMessage, SubagentStatus
│   │   ├── manager.ts      # SubagentManager: lifecycle, step loop, mailbox dispatch
│   │   ├── mailbox.ts      # Agent message queue with blocking poll and delivery tracking
│   │   ├── mailbox.test.ts # Mailbox unit tests
│   │   ├── tools.ts        # Subagent communication tools (send_message, check_mailbox, finalize)
│   │   └── tools.test.ts   # Subagent tool tests
│   └── index.ts            # createDriver() — reactive orchestration (alien-signals)
├── background-task/        # Long-running background task infrastructure
│   ├── types.ts            # BackgroundTask, BackgroundTaskFactory, TaskContext, ActiveTaskInfo
│   ├── manager.ts          # BackgroundTaskManager: lifecycle, pause/resume, timeout, checkpoint persistence
│   ├── shell.ts            # Shell command BackgroundTask implementation
│   └── index.ts            # Barrel exports
├── evals/                  # Offline LLM eval harness
│   ├── types.ts            # EvalSuite / EvalScenario / EvalRunResult / evaluator type definitions
│   ├── runner.ts           # Suite runner: IC → RC → context → model/tool loop → evaluator
│   ├── tools.ts            # Side-effect-free eval tools (send_message capture, dismiss, load_skill trace)
│   ├── report.ts           # runs.jsonl / summary.json / summary.md reporting and probability stats
│   ├── fixture-export.ts   # Export real chat windows from persisted events into eval fixtures, optionally with TR v2
│   └── index.ts            # Public eval harness exports
├── db/
│   ├── client.ts           # Database init (better-sqlite3 + Drizzle), WAL mode
│   ├── schema.ts           # Drizzle schema: users, messages, events, turnResponses, turnResponsesV2, compactions, imageAltTexts, subagents, subagentMessages, backgroundTasks, messageReactionSnapshots tables
│   ├── persistence.ts      # CRUD: persistEvent, persistTurnResponseV2, persistCompaction, image alt text cache lookups, loadEvents, loadTurnResponsesV2, loadCompaction, subagent lifecycle, background task persistence
│   ├── codec.ts            # ConversationEntry ↔ JSON serialization helpers
│   ├── migrate-v2.ts       # v1 → v2 data migration (turnResponses → turnResponsesV2)
│   └── index.ts            # Barrel exports
├── ingress/                # Platform-agnostic per-chat ordered ingress queue
│   ├── session-ingress-queue.ts # createSessionIngressQueue: speculative async transform + in-order commit (shared by Telegram + OneBot)
│   ├── session-ingress-queue.test.ts # Ingress queue tests
│   └── message-dedup.ts     # createMessageDedup: platform-agnostic (chatId, messageId) dedup with bounded LRU (shared by Telegram manager + OneBot ingress/history-pull)
├── onebot/
│   ├── index.ts             # OneBot exports + PlatformAdapter factory for Driver send/download hooks
│   ├── startup.ts           # OneBot startup: WS server lifecycle, ingress wiring, history pull (shared dedup), PlatformAdapter registration, post-startup task assembly
│   ├── post-startup.ts      # OneBot cold-start alt-text backfill: resolves historical image/animation events lacking alt text, persists attachments, replays affected chats (best-effort)
│   ├── post-startup.test.ts # OneBot alt-text backfill tests
│   ├── server.ts            # OneBot 11 reverse WebSocket server + echo-correlated API client; cached get_friend_list remarks; captures ingress meta at the WS frame entry and forwards raw events
│   ├── server.test.ts       # OneBot WebSocket server lifecycle and connected-client shutdown tests
│   ├── ingress.ts           # createOneBotIngress: per-chat ordered queue + bounded-retry-then-drop transform (adapt + alt-text); attemptWithBudget policy; shared-dedup gating
│   ├── ingress.test.ts      # OneBot ingress + attemptWithBudget + dedup tests
│   ├── types.ts             # OneBot 11 event/API/message-segment types
│   ├── adaptation.ts        # OneBot message/notice → CanonicalIMEvent conversion; metadata-only ordinary photos + NapCat-backed sticker classification with history-only fallback; NapCat QQ name priority (friend-list remark → raw remark → member name/card → nickname); OneBotIngressMeta capture, applies entry-time timestamps
│   ├── adaptation.test.ts   # OneBot adaptation tests, including NapCat-backed image download and user display-name priority
│   ├── send.ts              # send_message text/attachment rendering into OneBot array segments
│   ├── send.test.ts         # OneBot send rendering tests, including optional silicon code-block image conversion
│   ├── image-to-text.ts     # OneBot image download + thumbnail generation via shared image-to-text resolver (fail-closed: throws on failure)
│   ├── face-config.ts       # QQ face ID → description lookup
│   └── face-config.json     # QQ face metadata table
├── types/
│   ├── ffprobe-static.d.ts  # Type declarations for ffprobe-static npm package
│   └── lottie-frame.d.ts    # Type declarations for lottie-frame native addon
└── telegram/
    ├── index.ts             # Telegram public entry + startup handle aggregation
    ├── adaption.ts          # Telegram message/edit/delete/reaction/service → CanonicalIMEvent conversion, rich text parsing, contentToPlainText
    ├── adaption.test.ts     # Telegram adaptation and rich text parser tests
    ├── manager.ts           # TelegramManager — unified facade, session ingress queue, blocking media transforms (skips spoiler-photo auto-description), dedup dispatch
    ├── manager.test.ts      # Telegram media auto-description policy tests, including spoiler photos
    ├── event-sink.ts        # Persist/hydrate/push-to-pipeline/notify-driver event sink used by Telegram ingress
    ├── live-handlers.ts     # Telegram live ingress handlers, reactions, typing events, /offline, /online, and /compact commands
    ├── live-handlers.test.ts # Telegram live ingress tests, including reaction add/remove debounce
    ├── driver-hooks.ts      # Driver-facing Telegram send/download/reaction hooks and synthetic self-message injection
    ├── post-startup.ts      # Telegram historical animation/custom-emoji backfill tasks
    ├── custom-emoji-resolver.ts # Telegram Bot API adapter for custom emoji alt-text resolution
    ├── stores.ts            # Telegram message/reaction persistence port interfaces
    ├── bot.ts               # grammY Bot API client; registerCommand() for external command registration before on('message')
    ├── userbot.ts           # gramjs MTProto client
    ├── event-bus.ts         # Simple typed pub/sub
    ├── pack-title.ts        # Sticker pack metadata normalization (set_name → display title)
    ├── pack-title.test.ts   # Pack title normalization tests
    ├── typing-action.ts     # Shared typing-like MTProto action classifier
    ├── typing-action.test.ts # Typing action classifier tests
    ├── typing-poll.ts       # Debounce-scoped Telegram typing presence manager: online heartbeat, markAsRead, supergroup channel-difference fallback
    ├── typing-poll.test.ts  # Typing presence lifecycle and channel-difference tests
    ├── gramjs-logger.ts     # Patches gramjs internal logger to @guiiai/logg
    ├── markdown.ts          # Markdown → Telegram HTML converter (MarkdownIt-based)
    ├── session.ts           # Session file load/save
    ├── login.ts             # Interactive MTProto login script (pnpm login)
    └── message/
        ├── types.ts         # TelegramUser, TelegramMessage, Attachment, ForwardInfo, MessageEntity
        ├── gramjs.ts        # gramjs Api.Message → TelegramMessage conversion
        ├── gramjs.test.ts   # GramJS message conversion + merge regression tests
        ├── grammy.ts        # grammY Message → TelegramMessage conversion
        ├── dedup.ts         # Set-based message dedup with LRU eviction (10k)
        └── index.ts         # Barrel exports
```

Top-level directories:
- `prompts/` — all LLM prompt templates (velin `.velin.md` files), rendered at runtime via `@velin-dev/core`
  - `primary-system.velin.md` — main system prompt for chat LLM calls; **bot tone/style is hardcoded here**
  - `subagent-system.velin.md` — internal helper-agent prompt; intentionally contains no group-chat/platform/end-user concepts
  - `primary-late-binding.velin.md` — context-aware injection (mention/reply state, recent send_message human-likeness feedback, background task status)
  - `IDENTITY.velin.md` — bot identity / personality definition (loaded by prompt renderer); **bot persona is hardcoded here**
  - `CURIOSITY.md` — plain-markdown system file for curiosity-driven silent lookup and high-threshold natural interjections
  - `compaction-system.velin.md` — compaction LLM system prompt
  - `compaction-late-binding.velin.md` — compaction LLM user instruction (output format)
  - `image-to-text-system.velin.md` — blocking image description prompt used before events enter the pipeline
  - `animation-to-text-system.velin.md` — blocking GIF/animation description prompt (multi-frame)
  - `sticker-animation-to-text-system.velin.md` — blocking animated sticker description prompt (multi-frame)
  - `custom-emoji-to-text-system.velin.md` — blocking static custom emoji description prompt
- `skills/` — repository-provided skill definitions (markdown files) that can be copied into or used as the configured skills folder
  - `skill-authoring.md` — reusable workflow for inspecting skill runtime info and writing new skill files
- `evals/` — optional user-authored LLM eval suites, IC fixtures, prompt variants, and evaluator modules. These are run manually with `pnpm eval <suite.ts>` and are not part of ordinary Vitest unit tests.
  - `evals/skill-activation/` — compares the pre/post Skill Activation system prompts with fake skills and reports `load_skill` / correct-skill call rates.
  - `evals/agreement-review/` — exercises the `agreement_review_required` recovery choice, checking that substantive drafts are rewritten while pure agreement becomes a reaction.
- `docs/` — architecture and design documents (not prompts)
  - `dcp-design.md` — architecture rationale and Driver/TR design
  - `content-aware-frame-selection.md` — MSE-based frame selection findings and rationale
  - `humanize.md` — human-likeness design notes
  - `rc-change-side-effects.md` — RC 变更可能触发的副作用和代码位点
  - `subagent-system.md` — subagent system design
  - `telegram-module-architecture.md` / `telegram-module-architecture.svg` — readable Telegram module boundary and data-flow diagram
  - `telegram-typing-events.md` — Telegram typing event research
  - `unified-api-integration.md` — unified API integration design
- `dcp-updates.md` — implementation deltas from the original RFC

### Type Ownership

Platform types (`Attachment`, `ForwardInfo`, `MessageEntity`) are defined in `telegram/message/types.ts` — they belong to the telegram layer. `db/schema.ts` imports them for JSON column annotations. Never define platform types in the DB layer.

Canonical types (`CanonicalIMEvent`, `CanonicalUser`, `ContentNode`, etc.) are defined in `adaption-types.ts`. `ContentNode` is the platform-agnostic rich text representation — platform adapters parse platform-specific encodings (e.g. Telegram's text + offset-based entities in `telegram/adaption.ts`) into `ContentNode[]` trees. All IDs in canonical types are strings (platform-agnostic).

### Imports

Use relative paths for all internal imports:
```ts
import { loadConfig } from './config/config';
import type { CanonicalIMEvent } from '../adaption-types';
```

## Commands

- `pnpm dev` — run with file watching (tsx watch).
- `pnpm start` — run once (tsx).
- `pnpm build` — bundle with tsdown.
- `pnpm typecheck` — `tsc --noEmit` (current `tsconfig.json` only includes `src/**/*.ts`).
- `pnpm lint` uses `tsconfig.eslint.json` so `scripts/**/*.ts` can be linted without expanding the build/typecheck project.
- `pnpm lint` / `pnpm lint:fix` — ESLint.
- `pnpm test` / `pnpm test:run` — Vitest.
- `pnpm eval <suite.ts>` — run an offline LLM eval suite. Loads models from `config.yaml`, calls real model endpoints, writes `runs.jsonl`, `summary.json`, and `summary.md` under `eval-results/<suite>/<timestamp>/` unless the suite overrides `outputDir`.
- `pnpm eval:fixture --chat <chatId> --from-message <id> --to-message <id> --out <file>` — export a real chat slice from persisted canonical `events` into a TypeScript eval fixture. Also supports `--messages <id,id,...>`, `--from-ms/--to-ms`, `--include-replies`, `--context-before`, `--context-after`, `--include-trs`, and `--preview-xml <file>`.
- `pnpm debug:rc --chat <chatId>` — render a persisted chat's full RC as formatted XML on stdout. Opens the DB read-only by default; add `--migrate` to opt in to migrations, or `--respect-compaction` to mirror the startup compacted viewport.
- `pnpm login` — interactive MTProto session login.
- `pnpm db:generate` — generate Drizzle migration from schema changes.

## Architecture Rules

### Dependency Injection (tsyringe, factory mode)

The composition root is a **tsyringe** container built in `src/container/index.ts`, not manual wiring. We use tsyringe in **factory-registration mode** — no `@injectable`/`@inject` decorators, no `experimentalDecorators`/`emitDecoratorMetadata`, no class wrappers. This preserves the `const`/closure-factory convention: every subsystem keeps its existing `create*(deps)` signature and stays directly callable, so unit tests can construct factories without the container.

Rules when touching the graph:
- **Tokens** live in `src/container/tokens.ts`. Each is a phantom-typed `Token<T>` (`{ sym: Symbol }`) — the symbol is the runtime key; `T` only flows through the typed `register`/`get` helpers. Add a token there before registering a new graph node.
- **Registration** is split per-token: each `register(TOKENS.X, ...)` call lives in `src/container/deps/` as an `export default function(registrar)`. `buildContainer()` uses `fs.readdirSync` + dynamic `import()` to auto-discover and call them — no manual module list to maintain. Every factory is wrapped in the local `singleton()` helper. tsyringe's `FactoryProvider` does **not** cache, and its built-in `instanceCachingFactory` mis-handles `undefined`; some optional platform nodes legitimately resolve to `undefined`, so we memoize with an explicit presence flag.
- **Tokens should represent real runtime boundaries.** Do not replace a giant deps object with one equally giant token. Split platform construction into focused nodes such as manager, event sink, live handlers, driver hooks, and post-startup tasks when those parts have different dependency shapes.
- **Circular edges are broken by lazy resolution, not forward-ref hacks.** Hook closures call `get(TOKENS.DRIVER)` at invocation time, for example `onDriverEvent: (id, rc) => get(TOKENS.DRIVER).handleEvent(id, rc)`. The Telegram custom-emoji resolver reads the manager through a lazy getter (`get telegram() { return get(TOKENS.TELEGRAM_MANAGER); }`), which avoids resolving the full Telegram startup handle while the resolver is being built. The old mutable `driverRef` / `ref` / `managerRef` objects are gone.
- **Optional platform roots stay optional only at the root.** `TOKENS.TELEGRAM_MANAGER` and `TOKENS.TELEGRAM` may resolve to `undefined` when Telegram is not configured. Downstream Telegram-specific nodes (`TELEGRAM_DRIVER_HOOKS`, `TELEGRAM_LIVE_HANDLERS`, `TELEGRAM_POST_STARTUP_TASKS`) assume a manager exists; the `TELEGRAM` aggregator checks the manager before resolving them.
- **`reflect-metadata`** must be imported before `tsyringe` loads. It is imported at the top of `src/index.ts` (entry point) and `src/container/index.ts`.
- **Async construction stays in the orchestrator.** `buildContainer()` is `async` (dynamic imports) but the factory functions it registers are still synchronous. Async startup steps — `migrateV1ToV2`, cold-start replay, `startOneBot` (awaits a WS client), lifecycle/shutdown — live in `src/startup/index.ts`, which `await buildContainer()` then resolves nodes from the container and runs them. OneBot's handle is held in an `OneBotHolder` token the orchestrator populates after the await.
- `buildContainer()` returns a **child container** (`rootContainer.createChildContainer()`) so tests get isolation.

### DCP Layers Are Pure Functions

Projection reducers must be pure: `(IC, CanonicalIMEvent) => IC'`. No I/O, no side effects, no network calls. Projection only processes IM platform events — bot's own LLM interactions live exclusively in the Driver layer (unidirectional data flow, no backflow). External data (memory, user profiles) enters either through Driver-level late binding (current implementation) or as pre-fetched fields on the event.

### Dual Timestamps

Every `CanonicalIMEvent` carries two timestamps:
- `receivedAtMs` (milliseconds): local receive time, captured at platform ingress **before** any asynchronous media transforms or queue blocking. Telegram captures it in `captureIngressMeta()` at dispatch; OneBot captures it in `captureOneBotIngressMeta()` at the WS frame entry, before adaptation's network calls (`getGroupMemberInfo`, image fetch). **Ordering source of truth** — ensures cold-start replay matches live processing even when ingress is blocked on image-to-text.
- `timestampSec` (seconds): server-reported time, shown to the AI. For delete events (no server time), derived as `Math.floor(receivedAtMs / 1000)`.
- `utcOffsetMin`: timezone offset captured at the same ingress moment as `receivedAtMs`. Rendering converts `timestampSec` to local time using this per-event offset.

DB queries order by `(received_at, id)`.

### Consistency Above Availability

Highest design principle for ingress transforms: **never admit partially transformed events into the pipeline**. If image-to-text is enabled and an image event has not been fully resolved, that chat session must remain blocked. Timeouts, hangs, and infinite retries are acceptable; inconsistent data is not.

This rule is fail-closed by design:
- Image-to-text failures do **not** degrade to thumbnail-only or empty-alt-text fallback when the feature is enabled.
- A blocked session may stop accepting new events into Projection/Rendering/Driver indefinitely.
- Correctness of the event stream seen by DCP takes priority over latency and availability.

### Session Ingress Queue

Both platforms use the same **per-chat ordered commit queue** — `createSessionIngressQueue` in `src/ingress/session-ingress-queue.ts` (platform-agnostic; pass `logContext` to scope its logs). Each event captures ingress timestamps immediately, then enters a queue with two phases:
- **Transform**: asynchronous preprocessing. Later events in the same chat may start transforming before earlier events finish.
- **Commit**: only the oldest contiguous ready prefix is allowed to enter Adaptation → Projection → Rendering. This preserves event order while still allowing speculative preprocessing of later blocked messages.

The queue is fail-closed. If the head event's transform does not succeed, that chat's `nextCommitSeq` does not advance. Later events may finish transforming, but they remain buffered until the blocked head event resolves.

**Telegram**: the queue's `transform` runs `hydrateAttachments` (image/animation/custom-emoji-to-text + thumbnails); adaptation itself is pure. The shared queue retries a failing transform **forever** — safe because Telegram fileIds stay valid indefinitely.

**OneBot** (`src/onebot/ingress.ts`): unlike Telegram, OneBot **adaptation may do network** (`getGroupMemberInfo`, NapCat `get_image`/`get_file` download for sticker/animation classification), so the WS server forwards *raw* events plus ingress meta and the queue's `transform` runs adaptation **and** alt-text resolution. Ordinary photos need no bytes for classification and are downloaded only when later hydration requires them. Sticker candidates deliberately use the segment's stable `file` lookup key rather than directly fetching its ephemeral `url`; NapCat can refresh the QQ media URL/RKey or fall back to a local download. Live classification failures enter the bounded retry instead of silently deleting the image segment. Notice events adapt synchronously at enqueue (no network) and are keyed by chatId there. Because QQ media URLs / file references **expire**, infinite retry could wedge a chat permanently; instead OneBot wraps the message transform in `attemptWithBudget` — a terminable, never-fail-open exponential-backoff retry bounded by a wall-clock budget (`transformBudgetMs`, default 90s). On budget exhaustion the **whole event is dropped before persist/pipeline** (never admitted with degraded/empty alt text), so the commit cursor keeps advancing. Historical replay is explicitly best-effort: unavailable sticker bytes fall back to a static `sticker` attachment, and later alt-text failures are caught and logged, so expired media never aborts startup. `resolveOneBotImageAltText` remains fail-closed for live ingress.

**OneBot message dedup + history/live race**: OneBot uses the platform-agnostic `createMessageDedup` (`src/ingress/message-dedup.ts`, the same set-based bounded-LRU dedup Telegram's manager uses) keyed by `(chatId, message_id)`. A **single** dedup instance is created in `startOneBot` and shared by two paths: live ingress (`createOneBotIngress.enqueue`, message events only — notices have no stable per-message identity) and the cold-start `get_group_msg_history` pull. The WS server must be listening — and may already be delivering live frames — before history can be pulled, so a message arriving in that overlap window would otherwise be persisted twice (once live, once from history). Deduping across both paths by reserving `(chatId, message_id)` on first sighting closes the race without buffering or pausing live ingress: whichever path calls `tryAdd` first wins, the other skips. Dedup is consulted *before* the queue (live) and *before* adaptation (history pull).

**OneBot cold-start alt-text backfill** (`src/onebot/post-startup.ts`): images/animations that entered the DB while image-to-text was disabled (or whose live resolution was dropped by the bounded-retry budget) carry no alt text. After `startOneBot` completes its history pull, the orchestrator calls `handle.runPostStartupTasks()` (alongside Telegram's), which walks persisted history per whitelisted OneBot chat, re-resolves uncached image/animation/sticker attachments via `resolveOneBotImageAltText`, persists the mutated attachments back with `updateEventAttachments`, then re-hydrates and replays affected chats. Unlike Telegram (which queries alt text from the cache at render time), OneBot bakes resolved alt text directly into persisted event attachments, so the backfill must persist attachments back. Best-effort per CLAUDE.md: download/LLM failures (frequently expired QQ media) are caught and logged, never fatal.

### Dual Telegram Client

- **grammY** (Bot API): receives messages from non-bot users, sends replies, handles `/commands`.
- **gramjs** (User API): fetches history, resolves reply-to chains, sees other bots' messages (invisible to Bot API), receives edit/delete/typing events.

Messages from both clients are deduplicated by `(chatId, messageId)` in the TelegramManager. Userbot events are filtered to bot-joined chats only (`botChats` set, seeded from the events table plus configured Telegram chat IDs on startup). When the bot version arrives second, its `fileId` is merged into the in-flight message for Bot API download preference. All message/edit/delete/reaction events then enter the per-chat ingress queue before Adaptation. Delete events without `chatId` (MTProto private chat deletes) are dropped — `lookupChatId` attempts resolution from the messages table, but if the message was never persisted the event is lost.

### Telegram Runtime Boundaries

Telegram integration is intentionally split by runtime responsibility. Do not reintroduce a large `startup.ts` or a single giant `TelegramStartupDeps` object.

- `src/telegram/manager.ts`: owns the Bot API client, optional userbot, dedup, ingress queue, blocking media transforms, reaction actor hydration, typing event capture, typing polling controls, and raw send/download methods. It does **not** know about DB persistence, Pipeline, Driver, compaction, or chat policy.
- `src/telegram/event-sink.ts`: owns the platform-neutral event side effect order for Telegram ingress: persist canonical event, optionally hydrate cached alt text, optionally push into Pipeline, optionally notify Driver. It exposes `persist()` and `publish()` separately because message/edit/delete handlers must write platform-specific message tables between those two steps.
- `src/telegram/live-handlers.ts`: adapts manager callbacks into canonical events, applies blocked-user policy, writes message/edit/delete/reaction snapshot stores, handles typing events, and registers `/offline` / `/online`. Live reaction additions update Pipeline but intentionally do **not** notify Driver.
- `src/telegram/driver-hooks.ts`: exposes Driver-facing Telegram capabilities: `send_message`, attachment reads, Bot API / userbot downloads, allowed reaction refresh, `react_message`, debounce typing polling, and synthetic self-message injection after a successful send.
- `src/telegram/post-startup.ts`: runs Telegram-only post-start tasks after live handlers are started: historical animation hash backfill and uncached custom-emoji resolution followed by chat replay.
- `src/telegram/custom-emoji-resolver.ts`: adapts the shared media custom-emoji resolver to Telegram Bot API methods (`getCustomEmojiStickers`, file download, pack title resolution).
- `src/telegram/stores.ts`: defines the narrow message/reaction persistence ports shared by live handlers and driver hooks.
- `src/telegram/index.ts`: public Telegram entry. It re-exports Telegram factories/types and aggregates a `TelegramStartupHandle` from manager + driver hooks + live handlers + post-startup tasks.

Container tokens mirror those boundaries: `TELEGRAM_MANAGER`, `TELEGRAM_EVENT_SINK`, `TELEGRAM_MESSAGE_STORE`, `TELEGRAM_REACTION_STORE`, `TELEGRAM_DRIVER_HOOKS`, `TELEGRAM_LIVE_HANDLERS`, `TELEGRAM_POST_STARTUP_TASKS`, and the final optional `TELEGRAM` handle. New Telegram behavior should usually add or extend one of these focused nodes. If a dependency interface is only used by one module, keep it in that module; only shared ports belong in a separate file.

Important ordering constraints:
- Synthetic sent-message events: persist event → seed empty reaction snapshot → hydrate/push to Pipeline; do not notify Driver immediately.
- Normal message ingress: persist canonical event → persist Telegram message row and seed empty reaction snapshot if needed → hydrate/push to Pipeline → notify Driver.
- Edit/delete ingress: persist canonical event → persist platform edit/delete row → publish to Pipeline → notify Driver.
- Service/blocked events: persist and publish through the event sink; no Telegram message row is written for blocked content.
- Reaction additions: update snapshot first, then persist/publish append-only canonical `reaction` events without notifying Driver.

### Configured Chat Residency

The `chats` config is the in-memory residency whitelist. Startup seeds Telegram's known-chat filter from the full events table plus currently configured Telegram chats, so historical unconfigured groups can still persist incoming messages/edits/deletes, and configured chats with deleted context are still accepted by userbot. Cold-start replay only rebuilds IC/RC for chats present in both persisted events and config. Live ingress for unconfigured chats still persists `events` and `messages`, then stops before hydration, Projection, Rendering, Driver, and compaction. This keeps archival chats out of memory and avoids startup replay cost for chats that are no longer enabled.

### Phantom Edit Filtering

MTProto fires `updateEditMessage` for metadata-only changes (link preview loading, reactions in large supergroups, inline keyboard updates). These have no `editDate`. The userbot handler skips events without `editDate`. Live reactions are handled separately through Telegram Bot API `message_reaction` / `message_reaction_count` updates.

### Telegram Reactions

Incoming Telegram reaction updates come from Bot API polling with explicit `allowed_updates: ['message', 'message_reaction', 'message_reaction_count']`. Userbot is still used for reaction capabilities and actor lookup: `messages.getAvailableReactions` provides the global active emoji reaction list, per-chat `availableReactions` from `GetFullChat` / `GetFullChannel` constrains the final `react_message` tool enum, and `messages.getMessageReactionsList` resolves actor lists for `message_reaction_count` updates. Outgoing `react_message` calls use the Bot API `setMessageReaction` endpoint so the visible reaction sender is the real bot account. Custom, premium, and paid reactions are intentionally not exposed to the LLM.

Incoming `message_reaction` updates identify the actor directly and are diffed from Bot API `old_reaction` / `new_reaction`. Incoming `message_reaction_count` updates are aggregate-only, so Edelweiss asks userbot for the full `(emoji, sender)` reaction list, stores it per `(chatId, messageId)` in `message_reaction_snapshots`, then diffs that snapshot. Reaction updates emit append-only canonical `reaction` events only for additions. Removals update the snapshot but do not enter IC. If a message has no prior actor snapshot, the first aggregate snapshot seeds state without emitting historical reactions.

Reaction IC nodes render as passive `<event type="reaction_added" .../>` RC segments. Live reaction ingress updates Pipeline/IC/RC but does not call `driver.handleEvent()`, so reaction storms do not wake or interrupt the LLM. Cold-start replay still passes passive reaction segments to Driver, but `latestExternalEventMs()` and `latestInterruptingExternalEventMs()` ignore `isPassiveEvent`.

`react_message` is registered only for Telegram chats with a configured userbot and a non-empty allowed emoji list. Do not add reaction prompt text or tools to OneBot/QQ paths.

### Sticker Pack Title Normalization

Telegram exposes sticker/custom-emoji packs by raw `set_name` slug. Edelweiss keeps that raw slug as `stickerSetId` and resolves the human-readable pack title into `stickerSetName` before messages enter Adaptation. Rendering and prompt generation must treat `stickerSetName` as display title only.

Legacy events created before this split may still have raw `set_name` stored in `stickerSetName`. Cold-start replay normalizes those attachments once, persists the upgraded attachment JSON back to `events`, and reuses the same `resolvePackTitle()` path as live ingress and custom-emoji resolution.

### IC Mutation Semantics

Edit and delete events come exclusively from the userbot (gramjs / MTProto). Bot API does not push these notifications — without the userbot client, edits and deletes would not exist in the system.

Two categories of IC mutation with different KV cache properties:
- **In-place** (edit, delete): modify existing IC nodes at their original position with marks (`editedAtSec`, `deleted: true`). Causes KV cache miss from that point onward. Acceptable — edits are infrequent and usually recent.
- **Append-only** (user rename, join/leave, reactions): insert system event nodes at the end. Old messages keep their original `sender` field. Rendering uses `node.sender` (name at message time), not `ic.users`. KV-cache friendly.

Design rule: metadata changes about entities → append-only; content changes to specific messages → in-place with marks.

### HTTP Credential Redaction

`src/http.ts` exposes `registerHttpSecret(secret)`. Registered strings are masked with equal-length `*` in all `HttpError` messages. Bot token is registered at client creation.

### Message Scheduling

Projection runs immediately on every event — IC is always current. Scheduling is owned by the **Driver**. Current strategy: **debounce + natural batching with a cross-interrupt deadline** — when new external messages trigger the reply effect, a debounce timer (`initialDelayMs`, default 5s) starts and the current reply batch gets an absolute deadline (`Date.now() + maxDelayMs`, default 30s). New messages arriving during the wait reset only the debounce timer to `typingExtendMs` (default 5s); they do not move the batch deadline. MTProto typing events (`SendMessageTypingAction`) from non-bot users in the same chat also extend only the debounce timer, capped by the remaining deadline. The `running` flag prevents concurrent LLM calls. Before the batch deadline, new external chat messages arriving during a call abort the in-flight call and reschedule with `typingExtendMs`; once the deadline has passed, ordinary new messages no longer abort the current call, so the bot gets a chance to finish speaking. After a non-interrupted LLM attempt ends, the deadline is cleared; any still-pending external messages form a new batch. Bot responds via `send_message` tool call (not 1:1 response).

The reply effect reads `rc()` directly (in addition to `needsReply()`) so that it re-runs when RC changes even if `needsReply()` stays `true` — this is required for debounce extension and in-flight interruption checks on new messages. Typing events bypass the signal graph entirely via `extendDebounce()`, which resets only the debounce timer without moving the batch deadline.

**Config** (`debounce` section in chat config, per-chat overridable):
- `initialDelayMs` (number, default `5000`): delay before first LLM call after new external messages.
- `typingExtendMs` (number, default `5000`): delay reset on new messages or typing events.
- `maxDelayMs` (number, default `30000`): per-batch hard deadline — forces an LLM call and, after expiry, prevents ordinary new messages from endlessly aborting it.

Scheduling lives in Driver (not a separate orchestration layer) because the Driver already manages the reactive scheduling graph (signal/computed/effect) — externalizing it would create coordination overhead.

**Offline mode**: Each chat scope has an `offline` signal. When offline, `needsReply` only becomes true if there is an unprocessed RC segment with `mentionsMe` or `repliesToMe` — ordinary new messages are ignored. After the LLM call triggered by a mention/reply completes (success or failure), the Driver automatically resets `offline` to `false` (back to online). Sending `/offline` while an LLM call is already running leaves the call unaffected and keeps offline mode active after it finishes. Commands:
- `/offline` — enter offline mode; bot responds only to @mentions and replies, then auto-returns online.
- `/online` — return to online mode immediately.
- `/compact` — manually compact all context before the configured working window; skips cleanly when there is nothing eligible to summarize.

Commands are registered via `bot.registerCommand()` from `src/telegram/live-handlers.ts` and reported to Telegram via `setMyCommands` when the bot client starts. Command messages are intercepted before `bot.on('message')` in the grammY middleware chain so they do not enter the LLM pipeline.

### Tool Call Loop Interleaving

Each LLM API call = one TR (not the entire loop as one TR). Each TR stores the complete output of one step: assistant response + tool results produced by executing that step's tool calls. When new external chat messages arrive during a tool call loop before the current reply batch deadline, the scheduler aborts the active turn's `AbortController` and the next turn recomposes fresh context. After the deadline, ordinary new messages stop aborting the current loop so the bot is not starved by constant chatter. Runtime events (for example background task completion) do **not** abort an in-flight model API request and do **not** wait for debounce when they are the only pending trigger; `InterruptionFeature.shouldContinue` stops at a step boundary so the next turn can recompose context with the event. New messages' `receivedAtMs` > previous TR's `requestedAtMs` (causality), so they merge correctly after the TR. This is an **interrupt + re-schedule** mechanism, not mid-loop re-rendering — the interrupted loop exits, and a completely new call starts with a fresh step budget and updated system prompt. See `docs/dcp-design.md §Tool Call Loop Interleaving` for merge details.

### Reasoning Signature Sanitization

Anthropic and DeepSeek models return reasoning as thinking text + cryptographic signature. The signature is only valid within the same provider family. The unified API's `stripReasoning()` handles cross-provider compatibility: each `ConversationEntry` carries a `MessageReasoning` block. On context replay with a different provider format, all reasoning fields are stripped. Format conversion preserves reasoning through round-trips via the unified IR (`encrypted_content` ↔ `reasoning_opaque`, `summary` ↔ `reasoning_text`). In openai-chat format, reasoning appears as `reasoning_text` + `reasoning_opaque` fields on assistant entries. In responses format, reasoning appears as output items with `type: 'reasoning'`, carrying `encrypted_content` and `summary`. In anthropic-messages format, reasoning appears as `thinking` / `redacted_thinking` content blocks. The pair is always kept or stripped together.

### Tool Call ID Sanitization

Historical TRs keep provider-native tool call IDs exactly as returned. Some providers emit IDs that are valid for themselves but invalid for Anthropic Messages API replay (for example `send_message:103`, which violates `^[A-Za-z0-9_-]+$`). To keep the pipeline simple, `composeContext()` always sanitizes tool call IDs via `sanitizeToolCallIdsForMessagesApi()` after reasoning stripping / tool-result trimming and before token trimming:
- assistant `tool_calls[].id` and matching tool `tool_call_id` are remapped to `[A-Za-z0-9_-]` only
- remapping is deterministic within one request and collision-safe (`foo:1` and `foo?1` become `foo_1` and `foo_1_2`)
- storage stays raw — `turn_responses_v2` rows are never rewritten

### Debug Dumps

Driver writes the full LLM request JSON to `/tmp/cahciua/<chatId>.request.json` before each API call. This is intentional debug output — the project is not production-deployed. Do not flag as an issue.

### RC and TRs — Orthogonal Merge

RC (from Rendering) and TRs (from Driver) are two independent sorted streams:
- RC segments carry `receivedAtMs` (milliseconds, from source events)
- TRs carry `requestedAtMs` (milliseconds, `Date.now()` at API request time)

Driver merges them by timestamp into the final LLM API messages array. Causality guarantees correct ordering in online operation. **Mandatory tiebreaker**: when timestamps are equal, RC is ordered before TRs — required because Anthropic Messages API enforces strict user/assistant role alternation.

Data flows strictly forward (no backflow). Events table stores only IM platform events. IC is only derived from platform events. Driver is sole owner of TRs.

### TR Storage

TRs are stored in `turn_responses_v2` table as provider-agnostic `ConversationEntry[]` (JSON). The unified API codec normalizes all provider outputs into this IR before persistence. One row per TR:

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | autoincrement |
| chat_id | TEXT NOT NULL | Session ID |
| agent_id | TEXT NOT NULL DEFAULT 'main' | `'main'` for primary agent, `sa-<n>` for subagents |
| requested_at | INTEGER NOT NULL | millisecond timestamp, merge ordering key |
| entries | TEXT (JSON) NOT NULL | `ConversationEntry[]` in unified IR |
| input_tokens | INTEGER NOT NULL | for statistics / cost tracking |
| output_tokens | INTEGER NOT NULL | for statistics / cost tracking |
| model_name | TEXT NOT NULL DEFAULT '' | model used for this turn |

The old `turn_responses` table (provider-raw format with `provider` and `reasoning_signature_compat` columns) is deprecated. Data is migrated to v2 via `src/db/migrate-v2.ts`.

Same-provider reads are zero-conversion through the codec. Cross-provider reads use the unified API's bidirectional converters.

### Anti-Injection

User content in the rendered context is fenced with XML structure. Identity information (who said what) is carried as XML attributes (the truth source), not inline text that users could spoof.

### KV Cache Optimization

- System prompt is static and positioned first.
- Chat history is append-only within an epoch.
- **Current**: Dynamic action hints (mention / reply state, conditional `human-likeness` feedback) are injected by the Driver as a final synthetic user message via `injectLateBindingPrompt()`. The `human-likeness` section is functionally derived from the current successful `send_message` tool-call history at render time; it flags up to 6 configurable patterns (markdown-heavy formatting, newlines, trailing periods, punctuation-heavy short messages — each independently toggleable via `humanLikeness` config), and is omitted entirely when no enabled checks fire.
- **Planned**: Richer dynamic content (memory recall, cross-session awareness) should continue to be injected by the Driver through a more structured late-binding mechanism.
- Compaction creates epoch boundaries — see [Context Compaction](#context-compaction) below.

### Final Send Preparation

Before any actual provider request is sent, the Driver applies a final request-local normalization step through the unified API:
- `toChatCompletionsInput()`: converts `ConversationEntry[]` into Chat Completions API messages — moves image-bearing tool results into follow-up user messages prefixed with `The result of tool <name>`, keeping text/image ordering intact while preserving contiguous tool-result blocks.
- `toResponsesInput()`: converts into Responses API input items.
- `toMessagesInput()`: converts into Anthropic Messages API messages — parses `ToolCallPart.args` JSON strings into `input` objects, normalizes opaque-only reasoning to `redacted_thinking` blocks.
- Model image limits (`maxImagesAllowed`) are enforced at this final send boundary on **every** request, not just once when a turn starts. This ensures tool-generated images (for example `read_image`) cannot bypass per-model image caps in later steps or compaction calls.

`read_image` supports attachment file-id and local filesystem path modes.

### Self Identity and isSelfSent Pipeline

Platform adapters own account-identity resolution. Telegram Adaptation compares the message sender with the configured Telegram bot user id; OneBot Adaptation compares the raw event sender with `self_id`. The result is stored as `CanonicalMessageEvent.isMyself`, persisted in `events.is_myself`, and passed unchanged through `ICMessage.isMyself` to `RenderedContextSegment.isMyself`. Projection, Rendering, and Driver must not infer platform account identity from a global bot id. Driver uses this platform-resolved flag to exclude the bot account's messages from reply and interruption scheduling.

Bot's own sent messages are marked `isSelfSent: true` at creation time by the synthetic event bypass in `src/telegram/driver-hooks.ts`. This flag flows through the full pipeline: `CanonicalMessageEvent.isSelfSent` → `events.is_self_sent` (DB) → `ICMessage.isSelfSent` → `RenderedContextSegment.isSelfSent`. The flag is set at creation, not derived from sender ID (bot may change accounts).

`isMyself` and `isSelfSent` have different meanings: `isMyself` means the sender is the current platform account, while `isSelfSent` means this process produced the message through `send_message`. A message sent by another program controlling the same account is `isMyself` but not `isSelfSent`; only `isSelfSent` messages are removed as duplicate TR representations during context composition.

OneBot mirrors this: `createOneBotPlatformAdapter` (`src/onebot/index.ts`) takes an optional `selfSentSink` and, after a successful `api.sendMessage`, builds a synthetic self-sent event via `buildOneBotSelfSentEvent` (`src/onebot/adaptation.ts`) and runs the same ordering — persist event → hydrate alt text → push to Pipeline — **without** notifying the Driver (the bot must not wake on its own message). The OneBot send API returns only a message id (no server timestamp), so `timestampSec` is derived from `receivedAtMs` like delete events (see §Dual Timestamps); the synthetic sender is the OneBot `selfId` captured at lifecycle connect. If `selfId` is unavailable the injection is skipped. The sink is wired in `src/onebot/startup.ts` from the same `persistEvent` / `hydrateAltTextFromCache` / `pushPipelineEvent` deps used by ingress.

### Context Optimizations

The following optimizations are always active in `composeContext()` (operates on `ConversationEntry[]`):

- **trimStaleNoToolCallTurnResponses**: Keep only latest 5 TRs without tool calls; older pure-text TRs are dropped before merge.
- **trimSelfMessagesCoveredBySendToolCalls**: Filter RC segments with `isSelfSent=true` from context assembly (removes duplicate representation — bot messages exist in both RC via userbot and TRs via tool call results).
- **trimToolResults**: Distance-based mechanical trimming of older oversized tool call results. Oversized means text content `>512 chars` or image content with non-low detail. Only the latest 5 oversized results are kept untrimmed; older oversized results are mechanically trimmed / downgraded.
- **pruneLengthLimitFailures**: Despite the historical name, removes recoverable `send_message` failures for both the 256-byte limit and `agreement_review_required` from persisted TRs while retaining them in the live turn for correction. Follow-up `send_message`, `react_message`, or `stay_silent` calls resolve the pending prune.

`send_message` intercepts the first draft per turn containing “确实” and returns `agreement_review_required`. This is a request for semantic review, not a declaration that the whole draft is meaningless: the model must remove only acknowledgement wording and preserve substantive content, or use `react_message` when the draft only agrees. The factory receives the already-resolved reaction capability as a boolean; no TurnState, RC, or persistence schema fields are added. If the rejected call supplied `reply_to`, that id is returned as the suggested reaction target; otherwise the model chooses from message ids already present in rendered chat context. OneBot receives the silent fallback and never sees Telegram reaction instructions.

### Human-Likeness Heuristic Toggles

Each of the 7 heuristic checks in `send-message-human-likeness.ts` can be disabled independently via the `humanLikeness` key in chat config (all enabled by default). Disabling a check removes it from both detection and the late-binding XML feedback.

| Config key | Check | Default |
|------------|-------|---------|
| `humanLikeness.trailingPeriod` | Message ends with a full stop | `true` |
| `humanLikeness.denseClausePunctuation` | Short message packed with clause punctuation | `true` |
| `humanLikeness.multipleMarkdownBold` | More than one `**bold**` span | `true` |
| `humanLikeness.markdownList` | Markdown list | `true` |
| `humanLikeness.markdownHeader` | Markdown header | `true` |
| `humanLikeness.newline` | Any newline in a send_message | `true` |
| `humanLikeness.notErshi` | Rigid “不是…而是…” rhetorical pattern | `true` |

Toggles are per-chat (deep-merged with `default` like all other config). Defined in `ChatConfigSchema` / `ChatOverrideSchema` in `src/config/config.ts`; passed to `collectRecentSendMessageAssessments()` via `chatConfig.humanLikeness` in the Driver.

### Unified API Layer

`src/unified-api/` provides a provider-agnostic intermediate representation (IR) for all LLM interactions. This decouples TR storage from provider wire formats.

**Core types** (`types.ts`):
- `ConversationEntry = Message | ToolResult` — discriminated by `kind`
- `Message` discriminated by `role`: `system` / `user` → `InputMessage`, `assistant` → `OutputMessage`
- `InputPart = TextPart | ImagePart` — user content parts
- `OutputPart = TextPart | ToolCallPart | ReasoningPart` — assistant output parts
- `Extra<S>` — source-tagged container for provider-specific unknown fields (only on model-output nodes)

**Codec** (`codec.ts`): `createCodec()` returns bidirectional converters:
- `from<Provider>Output()` — parse LLM response → `OutputMessage` / `ToolResult`
- `to<Provider>Input()` — `ConversationEntry[]` → provider wire format
- Three provider pairs: Chat Completions, Responses, Anthropic Messages

**Reasoning** (`reasoning.ts`): `stripReasoning()` removes all reasoning blocks from `ConversationEntry[]` when crossing provider families.

**Migrations** (`migrations.ts`): decodes historical v1 `turn_responses` JSON into `ConversationEntry[]`.

**IR invariants** (hold across all producers/consumers):
- `ToolResult` is a user-side entry — never appears in `from-*Output` responses
- `ToolCallPart.args` is the raw wire JSON string; only the Anthropic emitter boundary parses it
- `Extra<S>` is source-tagged: emitters apply `extra.fields` only when `extra.source` matches their target format
- Reasoning carriers: block-level `ReasoningPart` (Responses, Anthropic) and message-level `MessageReasoning` (Chat Completions). Emitters normalize opaque-only reasoning to `redacted_thinking` for symmetric cross-format round-trips.

### Skills System

`src/driver/skills.ts` loads user-facing skill/tool definitions from a configurable `skills/` folder. `SkillInfo.name` is the stable load ID and always comes from the file stem or directory name. Supported formats:
- **CustomSkills**: single `.md` file without front-matter. File stem is the ID, first `#` heading is the catalog description, and the full markdown body is loaded.
- **CustomSkillsV2**: single `.md` file with YAML front-matter: required `name` (catalog title) and `description`, optional `usage`. File stem remains the ID.
- **AnthropicSkills**: directory whose name is the ID and whose main file is exactly `SKILL.md`. `SKILL.md` uses the same YAML front-matter loader as CustomSkillsV2, but the catalog omits `title` and shows only ID plus `description` / `usage`. Other files in the directory are listed as absolute resource paths when the skill is loaded, but their contents are not injected automatically.

A `load_skill` tool lets the LLM fetch skill content at runtime by `skill_id`, injected into the system prompt as an available-tools catalog. When skills are available, `primary-system.velin.md` includes Skill Activation guidance: before answering or using other task-specific tools, the LLM must check the listed skills and load a clearly matching skill by exact ID. This decouples skill authoring from code changes — adding a skill is just creating a supported `.md` file or skill directory.

The bash tool intercepts built-in pseudo commands before shell execution: `chat_info` returns the current chat ID, platform channel, and absolute skills folder; `skill_info <skill_id>` returns one loaded skill's metadata and absolute file/resource paths. Skills are loaded once when a chat scope is created, so changes to the skills folder require process restart or a fresh chat scope before these pseudo-command results update.

### Background Tasks

Long-running shell tasks managed by `src/background-task/`. The Driver's `start_background_task` tool spawns a task that runs independently of the LLM step loop. Key behaviors:
- **Lifecycle**: start → run (with timeout) → complete → notify via RuntimeEvent → inject into late-binding prompt
- **Pause/Resume**: tasks persist checkpoints to `background_tasks` table on shutdown; restored on cold start
- **Factory pattern**: `BackgroundTaskFactory<TParams, TCheckpoint>` defines `start()` and `recover()` for each task type
- **Shell tasks** (`shell.ts`): the primary implementation — runs shell commands with stdout/stderr capture
- Completion is surfaced to the LLM as a synthetic runtime event in the conversation context

### Telegram Typing Presence

Telegram typing updates are ephemeral and only arrive reliably while Telegram considers the userbot online and interested in the chat. During Driver debounce windows, `src/telegram/typing-poll.ts` starts a debounce-scoped typing presence watch: a shared `account.updateStatus(offline=false)` heartbeat every 50 seconds, `markAsRead(peer)` for the watched chat, raw MTProto typing updates from `src/telegram/userbot.ts`, and `updates.getChannelDifference` fallback polling for supergroups/channels. Basic groups rely on raw `UpdateChatUserTyping` plus the same heartbeat/read priming. `src/telegram/typing-action.ts` classifies typing-like actions shared by both update paths. Typing events within a 6s validity window extend the reply debounce timer.

### Context Compaction

Compaction proactively summarizes historical conversation context to prevent LLM context overflow. Implemented as an independent reactive effect (`alien-signals`) that runs in parallel with the main reply flow.

**Dual water mark strategy** (all thresholds use estimated tokens via `CHARS_PER_TOKEN = 2` heuristic, not actual tokenizer counts):
- **High water mark** (`compaction.maxContextEstTokens`): compaction triggers when estimated raw content (RC + TRs after cursor, excluding summary) exceeds this threshold.
- **Low water mark** (`compaction.workingWindowEstTokens`): after compaction, only this many estimated tokens of raw content are retained in the working window. The rest is replaced by a structured summary prepended as the first user message.

**Data flow**:
1. `compactionMeta` signal initialized from DB on cold start (`loadCompaction`)
2. `cursorMs` and `summary` derived as `computed()` from `compactionMeta`
3. Cursor auto-apply effect watches `cursorMs` → calls `pipeline.setCompactCursor()` → pipeline re-renders RC excluding segments before cursor
4. Reply effect reads `cursorMs()` and `summary()` from signals — no runtime DB queries
5. Compaction effect: when `estimatedTokens > maxContextEstTokens`, calls `runCompaction()` → `persistCompaction()` → updates `compactionMeta` signal → cursor effect auto-applies

Manual `/compact` commands on Telegram and OneBot use the same per-chat compaction task, bypass the high-water trigger, and retain the configured low-water working window. Concurrent manual/automatic requests share one in-flight task.

**Compaction storage** (`compactions` table): append-only — each compaction inserts a new row. `loadCompaction` reads the latest by `ORDER BY id DESC LIMIT 1`. Rolling back = deleting the latest row. Never upsert.

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | autoincrement |
| chat_id | TEXT NOT NULL | indexed |
| old_cursor_ms | INTEGER NOT NULL | start of compacted window |
| new_cursor_ms | INTEGER NOT NULL | end of compacted window (= new cursor position) |
| summary | TEXT NOT NULL | structured plain-text summary |
| input_tokens | INTEGER NOT NULL | LLM input tokens for this compaction call |
| output_tokens | INTEGER NOT NULL | LLM output tokens for this compaction call |
| created_at | INTEGER NOT NULL | millisecond timestamp |

**Compaction is NOT a turn**: compaction has its own dedicated table, not stored in `turn_responses`. It produces a summary (pure text with structured sections), not a provider-format response.

**Token estimation**: Context size is estimated using a `CHARS_PER_TOKEN = 2` heuristic (not an actual tokenizer). Summary size is excluded from the compaction trigger check to prevent the summary from growing until it fills the budget (which would degrade compaction into a sliding window). `findWorkingWindowCursor` counts both RC segments and TRs when determining the cursor position.

**Config** (`compaction` section in `config.yaml`):
- `maxContextEstTokens` (number, default `200000`): high water mark — trigger compaction when estimated context exceeds this. Also used by `trimContext` to cap the LLM request size.
- `workingWindowEstTokens` (number, default `8000`): low water mark — how many estimated tokens of raw content to retain after compaction.
- `model` (string, optional): override model for compaction LLM calls (references a key in the `models` registry). Defaults to `llm.model`.

**Empty content sanitization**: Anthropic Messages API rejects assistant messages with empty `content` (empty string, null, or pure-thinking entries with no content/tool_calls). `composeContext` sanitizes these: empty or null `content` is deleted; empty-shell assistant messages (no content, no tool_calls) are filtered out entirely. This applies to all providers for consistency.

### Image To Text

Optional blocking ingress transform that resolves image attachments into cached alt text before they enter DCP.

**Processing model**:
- Only image events with unresolved image attachments trigger the workflow.
- Cache key is the sha256 of the generated thumbnail (deterministic sharp WebP output). Both live ingress and cold-start replay produce the same thumbnail from the same image, so the cache key is stable.
- The LLM input image is encoded as PNG. By default it is resized with a 512×512 pixel budget (`fit: inside`, no enlargement); `imageToText.compress=false` sends the original image pixels to the description model. Static stickers always force compression regardless of this config.
- If alt text is present on an attachment, Rendering emits inline `<image ...>alt text</image>` and does **not** attach a separate image buffer content piece.
- Alt text is **never** stored in the `events` table — it is always queried transiently from the `image_alt_texts` table at runtime.
- Only whitelisted chats (`driver.chatIds`) trigger image-to-text resolution.

**Storage** (`image_alt_texts` table): keyed by thumbnail hash.

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | autoincrement |
| image_hash | TEXT NOT NULL UNIQUE | sha256 of thumbnail WebP bytes |
| alt_text | TEXT NOT NULL | resolved image description |
| alt_text_tokens | INTEGER NOT NULL | model output token count for the stored alt text |
| sticker_set_name | TEXT | sticker pack name (nullable, for stickers and custom emoji) |
| created_at | INTEGER NOT NULL | millisecond timestamp |

**Config** (`imageToText` section in `config.yaml`):
- `enabled` (boolean, default `false`): whether to block ingress on image-to-text
- `model`: model for the image-to-text workflow (references a key in the `models` registry)
- `compress` (boolean, default `true`): whether to resize normal image inputs before calling the model; static stickers always compress
- `pixelBudget` (number, default `262144`): maximum pixel count when compression is enabled (`512 * 512`)

### Animation To Text

Optional blocking ingress transform that resolves GIF animations and animated stickers into cached alt text, parallel to Image To Text.

**Supported formats**:
- **GIF / Animation** (`type: 'animation'`): Telegram delivers as MP4. Frames extracted via `ffmpeg` (bundled via `ffmpeg-static` npm package).
- **Video sticker** (`type: 'sticker'`, `isVideoSticker: true`): WEBM format. Frames extracted via `ffmpeg`.
- **Animated sticker** (`type: 'sticker'`, `isAnimatedSticker: true`): TGS format (gzipped Lottie JSON). Decompressed with `gunzipSync`, frames rendered via `lottie-frame` native addon (rlottie + libpng).
- **Custom emoji**: not processed (excluded by `canExtractFrames`).

**Frame extraction** (`src/media/frame-extractor.ts`):
- Frame selection is **count-based**, not time-based: total frame count is determined first, then ≤maxFrames → keep all, >maxFrames → pick maxFrames equidistant frames (including first and last).
- Frame count sources: GIF → `sharp.metadata().pages`; MP4/WEBM → `ffprobe -show_entries stream=nb_frames`; TGS → Lottie JSON `op - ip`.
- TGS format auto-detected by gzip magic bytes (`0x1f 0x8b`) — does not rely on attachment metadata flags, which may be absent during backfill from `CanonicalAttachment`.
- Each frame is resized to max 512px per edge (same as image-to-text) and encoded as PNG.
- `FrameExtractionResult` includes optional `frameTimestamps` (seconds per selected frame). FPS sources: TGS → `parsed.fr`; Video → ffprobe `r_frame_rate`; GIF → omitted (no reliable source).
- Content-aware (MSE-based) frame selection was explored and deferred — see `docs/content-aware-frame-selection.md` for findings and rationale.
- Files >20MB are skipped.

**Processing model**:
- Cache key is `sha256(fileBuffer)` — content-addressable, same animation from different users shares a single cache entry.
- The `animationHash` field is set on the Telegram-layer `Attachment` during live ingress, propagated through adaptation to `CanonicalAttachment`, and persisted in the `events` table attachments JSON. This enables cold-start cache lookup without re-downloading.
- LLM receives all extracted frames as multiple image content parts in a single request. Two separate prompts: `animation-to-text-system.velin.md` for GIFs, `sticker-animation-to-text-system.velin.md` for animated stickers.
- Alt text is stored in the same `image_alt_texts` table (reused from Image To Text — the schema is generic hash → alt text).
- If alt text is present on an animated attachment, Rendering emits `<animation type="...">alt text</animation>` (distinct from static `<image>` tag). Stickers use a dedicated `<sticker pack="...">alt text</sticker>` tag with the sticker pack name. Static stickers/photos continue to use `<image>`.

**Cold-start hydration**:
- Events with existing `animationHash`: sync lookup from `image_alt_texts` cache (same as image-to-text).
- Events missing `animationHash` (historical data before feature enablement): backfilled asynchronously after `telegram.start()` — files are re-downloaded via userbot (with Bot API fileId fallback from messages table), frames extracted, hash computed, and the events table is updated.

**System dependencies**:
- `ffmpeg-static` (npm, bundled binary) — provides `ffmpeg` for MP4/WEBM processing.
- `ffprobe-static` (npm, bundled binary) — provides `ffprobe` for video frame count detection.
- `lottie-frame` (npm, native C++ addon) — renders Lottie JSON frames to PNG. Requires system packages: `libpng-dev` and `librlottie-dev` (`apt-get install -y libpng-dev librlottie-dev`).

**Config** (`animationToText` section in `config.yaml`):
- `enabled` (boolean, default `false`): whether to block ingress on animation-to-text
- `model`: model for the animation-to-text workflow (references a key in the `models` registry)
- `maxFrames` (number, default `5`): maximum key frames to extract from each animation

### Custom Emoji To Text

Optional blocking ingress transform that resolves custom emoji (inline `MessageEntityCustomEmoji`) into cached text descriptions before they enter DCP.

**Processing model**:
- Custom emoji appear in message entities as `{type: 'custom_emoji', customEmojiId}` with a fallback emoji character in the message text.
- During ingress (Phase 4 of `hydrateAttachments`), entities are scanned for `custom_emoji` type. All unique `customEmojiId` values are collected with their fallback emoji text.
- `bot.api.getCustomEmojiStickers(ids)` fetches sticker metadata (file_id, is_animated, is_video) for the batch.
- Each sticker is downloaded via Bot API and processed:
  - **Static**: resized with sharp → LLM description via `custom-emoji-to-text-system.velin.md` prompt.
  - **Animated/Video**: frame extraction via `extractFrames` (same as animation-to-text) → LLM description via `custom-emoji-animated-to-text-system.velin.md` prompt.
- Cache key is `emoji:${customEmojiId}` — stored in the same `image_alt_texts` table. The `customEmojiId` is a document ID, globally unique and stable.
- Alt text is set transiently on `ContentNode.altText` (type `custom_emoji`) during sync hydration, never stored in the events table.
- PNGs sent to vision models are flattened onto a white background before base64 encoding. Some providers mishandle transparent PNG alpha and otherwise see black glyph stickers/custom emoji as solid black squares.

**Rendering**: When `altText` is present on a `custom_emoji` ContentNode, Rendering emits `<custom-emoji pack="PackName">description</custom-emoji>` (with `pack` attribute when `stickerSetName` is available). Without alt text, the fallback emoji character is rendered directly.

**Cold-start hydration**:
- During initial replay, `hydrateAltTextFromCache` walks ContentNode trees and sets `altText` from cache.
- After `telegram.startLiveHandlers()`, `src/telegram/post-startup.ts` batch-resolves uncached custom emoji IDs via Bot API, then replays the affected chats with hydrated events.

**Config** (`customEmojiToText` section in `config.yaml`):
- `enabled` (boolean, default `false`): whether to resolve custom emoji descriptions
- `model`: model for the description workflow (references a key in the `models` registry)
- `maxFrames` (number, default `5`): maximum equidistant frames for animated custom emoji

## Coding Conventions

- **Functional style**: `const` + arrow functions everywhere, closure-based factories. Use classes only when required by library APIs (grammY, gramjs) or for `Error` subclasses.
- **Strict types**: avoid `any`; use `unknown` + narrowing. `noUncheckedIndexedAccess` is enabled.
- **Consistent type imports**: use `import type { ... }` for type-only imports (enforced by ESLint).
- **File names**: `kebab-case`.
- **Validation**: use Valibot for runtime schema validation; keep schemas close to their consumers.
- **Immutable state**: use Immer's `produce()` in Projection reducers.
- **Error handling**: prefer explicit error returns or Result types over thrown exceptions for expected failures.
- **Logging**: use `@guiiai/logg` (`useLogger` / `useGlobalLogger`) for all runtime logs. Never use `console.log` for logging. `console.log` is only acceptable in CLI scripts for outputting raw data the user needs to copy (e.g. session strings).
- **No speculative code**: if a design isn't settled, don't write a wrong placeholder. Either leave a `// TODO:` explaining the initial thinking, or don't write it at all. Wrong code looks authoritative and misleads future work.

## Styling Rules (enforced by ESLint)

- 2-space indent, single quotes, semicolons, trailing commas in multiline.
- `1tbs` brace style (single-line allowed).
- Interface/type members delimited by semicolons.
- Arrow parens only when needed (`as-needed`).
- Unix line endings.

## Testing Practices

- Use Vitest. Test files live next to source as `*.test.ts`.
- Projection reducers are pure functions — test them with static CanonicalIMEvent fixtures.
- Mock Telegram clients and DB for integration tests.
- Driver, persistence, and Telegram integration are now complexity hotspots — expand test coverage there when behavior changes.
- When fixing a bug, add a test that reproduces the previous failure.

## Comments & Markers

- **Don't write comments that restate what the code already says.** Function names, type signatures, and variable names should be self-documenting. If a comment just paraphrases the code, delete it.
- **No file-header JSDoc blocks** (e.g. `/** This module does X. Responsibilities: ... */`). The file name and exports are enough.
- **No JSDoc on interface fields** when the field name is self-explanatory (e.g. `/** The chat ID. */ chatId: string` is noise).
- **No JSDoc on functions** unless the behavior is genuinely surprising or non-obvious from the signature.
- **Do comment** non-obvious logic, workarounds, edge cases, and "why" (not "what").
- Use markers consistently: `// TODO:`, `// REVIEW:`, `// NOTICE:`.
- Keep comments with the code when refactoring. If removing a comment, note why.

## Dependency Management

- Use `pnpm add <dep>` / `pnpm add -D <dep>` to add dependencies. Do not edit `package.json` by hand.
- Always run `pnpm typecheck` and `pnpm lint:fix` after finishing a task.

## Data Migration Principle

When existing data doesn't match the current schema or design, fix it with a **DB migration** (SQL UPDATE in a new migration file). Never add backward-compatibility code or runtime fallbacks to handle old data formats — code should only handle the latest design. This keeps the codebase clean and avoids accumulating compatibility shims.

## DB Migration Workflow

When you modify `src/db/schema.ts` (add/remove/change tables, columns, or indexes):

1. **Generate**: `pnpm db:generate` — diffs schema.ts against the latest meta snapshot, produces a SQL migration with a random codename.
2. **Review the generated SQL**: check that every statement is correct and necessary. Remove or adjust any unintended changes before committing. Verify:
   - New tables have all expected columns, indexes, and constraints.
   - Column additions use correct types and defaults.
   - No unnecessary table recreations (e.g. boolean default `false` vs integer `0` mismatch — fix the snapshot if the diff is cosmetic).
3. **Rename**: give the migration a descriptive name (e.g. `0026_create_subagents.sql`) and update the `tag` field for the corresponding entry in `drizzle/meta/_journal.json` to match.

The meta snapshot chain (`drizzle/meta/` + `_journal.json`) is the source of truth for Drizzle Kit diffs. Keep it in sync with the actual database state. Never edit `_journal.json` to add entries for migrations that don't exist in the DB. If the chain breaks (duplicate snapshot ids, missing snapshot files), fix the chain before generating new migrations.

## Commit Conventions

- Use Conventional Commits: `feat:`, `fix:`, `refactor:`, `test:`, `chore:`, etc.
- Keep commits focused and scoped.
- When a commit changes project structure, key patterns, or completes a milestone, update this file in the same commit.
- **NEVER commit or push without explicit human instruction.** Always wait for the user to verify changes, run the application, and explicitly request a commit. Unauthorized commits are strictly forbidden.

#### Commit format for coding agents

```
<type>: <description>

[optional body]

Co-Authored-By: Model Name <coding agent email>
```

For Claude Code, each commit message must end with a `Co-Authored-By` trailer. The model name should refer to the runtime environment prompts `You are powered by the model <actual model name>`, and should not be assumed to be `Claude Opus 4.8`.

For Codex, each commit message must also end with a `Co-Authored-By` trailer, using the current Codex model identity. For example: `Co-Authored-By: GPT-5.5 <codex@openai.com>`

If this is a port commit, add `Ported from (original repo name) (short commit hash).` after body. For example: `Ported from Cahciua 246d069.` Also. use `--author` to keep original author.
