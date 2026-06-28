# Driver Lightweight Turn Loop and Lifecycle Hooks

This document proposes refactoring the current Driver from a heavyweight
reactive closure into a lightweight turn loop with explicit in-memory turn state
and typed lifecycle hooks.

The goal is not to make Driver extensible as a public plugin system. The goal is
to make the internal control flow smaller, testable, and easier to change while
preserving the current DCP boundary: RC comes from Rendering, TRs are Driver
owned, and each LLM step persists as `turn_responses_v2`.

## Problem

`src/driver/index.ts` currently owns many concerns in one chat-scope closure:

- chat scope lifecycle: RC signal, offline mode, cleanup, compact cursor effects
- scheduling: debounce timers, max-delay deadline, typing extension, wake logic
- interruption: in-flight aborts, step-boundary breaks, runtime-event behavior
- turn preparation: load TRs, compose context, prompt rendering, late binding
- tool assembly: send/reaction/bash/web/media/skill/subagent/background tools
- step handling: persist TRs, update `lastProcessedMs`, prune send length failures
- compaction: independent token-budget check and summarization flow
- subagents: mailbox, manager, wake-main bridge, subagent tool injection

This makes the main Driver loop difficult to reason about because important
turn-level facts are hidden in local variables or nested closures:

- whether `send_message` is available for this turn
- whether send-message length limiting happened and pruning is pending
- whether the turn started offline and should auto-return online
- what RC snapshot the turn was composed from
- which external input is interrupting
- which skills were already loaded
- which tools were included and why

The existing behavior is mostly sound. The refactor should preserve behavior
while making those facts explicit.

## Goals

- Keep the runtime loop small: prepare turn, run steps, finish turn.
- Make per-turn state explicit and in-memory.
- Split business rules into typed lifecycle hooks grouped by phase.
- Let tool availability be driven by turn capabilities instead of ad hoc
  `includeSendMessage` booleans.
- Keep step persistence unchanged: every LLM API call still produces one
  `TurnResponseV2` row.
- Keep compaction independent from the main turn loop.
- Improve unit-test boundaries for scheduling, tool capability selection,
  late-binding fragments, step transforms, and interruption decisions.

## Non-goals

- No new persisted turn-state table.
- No public plugin API or dynamic third-party extension mechanism.
- No change to RC/TR merge semantics.
- No change to provider wire formats or unified API codecs.
- No attempt to resume an in-flight turn after process restart.

## Core Model

The refactor separates three state levels.

### ChatScope

`ChatScope` is long-lived per chat and owns cross-turn state.

```ts
interface ChatScope {
  chatId: string;
  chatConfig: ResolvedChatConfig;

  rc: Signal<RenderedContext>;
  offline: Signal<boolean>;
  lastProcessedMs: Signal<number>;
  failedRc: Signal<RenderedContext | null>;

  mailbox: AgentMailbox;
  subagents: SubagentManager;
  allSkills: Map<string, SkillInfo>;

  compactionMeta: Signal<CompactionSessionMeta | null>;

  scheduler: SchedulerState;
  activeTurn: TurnState | null;

  cleanup(): void;
}
```

`ChatScope` should keep the current reactive surface: `handleEvent()` updates
the RC signal, `handleTyping()` updates scheduler state, and `setOfflineMode()`
updates the offline signal.

`lastProcessedMs` is seeded asynchronously on scope creation. Today the scope
fires a fire-and-forget `getLastProcessedTime(chatId).then(v =>
lastProcessedMs(Math.max(lastProcessedMs(), v)))`, so there is a window where a
freshly created scope still has `lastProcessedMs === 0` and an RC update can
trigger a reply before the DB seed lands. The refactor must preserve this exact
init order and `Math.max` merge (the seed must never move the value backwards if
a turn already advanced it). Do not convert this to an `await` that blocks scope
creation, and do not drop the `Math.max` — either change alters cold-start
timing. If the race is to be closed, that is a separate behavior change and
should be called out explicitly, not introduced silently by the refactor.

### SchedulerState

`SchedulerState` is cross-turn but only about when to start or interrupt a turn.

```ts
interface SchedulerState {
  debounceTimer?: ReturnType<typeof setTimeout>;
  maxDelayTimer?: ReturnType<typeof setTimeout>;
  debounceWaiting: boolean;
  replyBatchDeadlineMs: number | null;
  startNextDebounceWithExtendDelay: boolean;
  lastTypingAtMs: number;
  // Cursor for "which external input counts as interrupting the active turn".
  // Today this is `activeRunInterruptCursorMs`, a local in `executeLlmCall`. In
  // version B the scheduler owns interruption, so the cursor lives here, not on
  // TurnState.
  activeRunInterruptCursorMs: number;
}
```

It replaces loose variables such as `debounceWaiting`,
`replyBatchDeadlineMs`, `startNextDebounceWithExtendDelay`, and
`lastTypingAtMs`.

### TurnState

`TurnState` is created for each main-agent or subagent run and is never
persisted as a standalone object.

```ts
interface TurnState {
  id: string;
  kind: 'main' | 'subagent';
  chatId: string;
  agentId: string;

  scope: ChatScope;
  model: LlmEndpoint;
  rcAtStart: RenderedContext;
  trs: TurnResponseV2[];
  entries: ConversationEntry[];
  system: string;
  tools: CahciuaTool[];

  step: number;
  // Infinity for main turns; `chatConfig.subagents.maxSteps` for subagents.
  maxSteps: number;
  // Cross-step state for send_message length-limit pruning. It lives on
  // TurnState (not a feature closure) so `transformStepEntries` can read it
  // and advance it between steps. See "Step Entries: Raw vs Persisted".
  pendingPrune: boolean;
  // The scheduler aborts this when interrupting input arrives (version B
  // preemptive interruption). The turn only receives the abort.
  abortController: AbortController;
  // NOTE: the interrupt cursor (today's `activeRunInterruptCursorMs`) does NOT
  // live here. In version B the scheduler owns the interruption decision, so the
  // cursor that defines "what counts as interrupting input" is scheduler state
  // (SchedulerState), not turn state. Keeping it off TurnState prevents the turn
  // from looking like it still participates in the decision.

  capabilities: TurnCapabilities;
  loadedSkills: Set<string>;
  reactionEmojis: string[];

  flags: {
    wasOfflineAtStart: boolean;
    interruptedByInput: boolean;
    // Set by the send_message tool when a send hit the 256-byte limit. Drives
    // BOTH length-limit pruning (persisted view) AND a forced follow-up step
    // (the model must split the message and retry). See SendMessageFeature.
    sendMessageWasLengthLimited: boolean;
    modelStayedSilent: boolean;
  };
}
```

Usage is intentionally **not** accumulated on `TurnState`. Each step persists
its own input/output token counts on its own `TurnResponseV2` row (one row per
step), matching the current per-step persistence; there is no turn-level usage
total to keep. The only place usage is summed today is across `forceToolCall`
retries inside a single step, which stays inside the step executor.

`TurnState` is the shared place for data that today is captured by closures. A
hook may mutate `turn.capabilities`, `turn.tools`, `turn.entries`, or
well-defined `turn.flags`, but should not squirrel state away in feature-local
closures unless it is purely cache-like.

### Step Entries: Raw vs Persisted

There are **two** entry streams per step, and they must not be conflated. The
current `runner.ts` loop encodes this asymmetry deliberately (see the comment on
`pruneLengthLimitFailures`):

- **Raw step entries** are appended to the in-turn working context
  (`working = [...working, ...stepEntries]`). The model must keep seeing its own
  length-limit failure within the current turn so it can correct (split the
  message and retry). The raw stream is **never** pruned mid-turn.
- **Persisted step entries** are the pruned view (`pruneLengthLimitFailures`
  output). This is what `persistStep` writes to `turn_responses_v2`, so future
  turns and compaction never replay the "try long → fail → split" few-shot.

This means `CompletedStep` must carry both, and the main loop must append the
**raw** entries while `persistStep` consumes the **transformed** entries:

```ts
interface CompletedStep {
  rawEntries: ConversationEntry[];       // appended to turn.entries (working context)
  persistedEntries: ConversationEntry[]; // written by persistStep
  usage: Usage;
  requestedAtMs: number;
  hasToolCalls: boolean;
  anyRequiresFollowUp: boolean;
}
```

The main loop therefore appends `step.rawEntries`, not a single `step.entries`:

```ts
turn.entries = [...turn.entries, ...step.rawEntries];
```

`transformStepEntries` is the producer of `persistedEntries` from `rawEntries`.
It is a `transform` hook, but it is **not** allowed to feed its output back into
the working context — only into persistence. The phase runner enforces this by
wiring `transformStepEntries → persistStep` and keeping `rawEntries` separate.
Because length-limit pruning is stateful across steps, `transformStepEntries`
reads and advances `turn.pendingPrune` rather than threading state through a
feature closure.

## Capabilities

Tool availability should be computed as turn capabilities first, then converted
to actual `CahciuaTool[]`.

```ts
interface TurnCapabilities {
  canSendMessage: boolean;
  canDismissMessage: boolean;
  canReact: boolean;
  canUseBash: boolean;
  canUseWebSearch: boolean;
  canUseWebFetch: boolean;
  canDownloadFile: boolean;
  canReadImage: boolean;
  canUseBackgroundTasks: boolean;
  canLoadSkill: boolean;
  canStartSubagent: boolean;
  canMessageSubagent: boolean;
  canMessageMain: boolean;
  canFinalizeSubagent: boolean;
}
```

Initial defaults:

- main turn: may send/dismiss/react; may start/message subagents when enabled
- subagent turn: cannot send/dismiss/react; cannot start nested subagents; may
  message main and finalize itself
- both: may use non-chat tools according to chat config

This replaces the current `createSharedTools(includeSendMessage, ...)` shape
with capability-driven tool providers.

## Hook Design

The main risk of hook-based design is replacing heavy business logic with heavy
`onX()` boilerplate. To avoid that, Driver should not manually call a long list
of hooks everywhere. It should run a small number of phases through a phase
runner.

```ts
interface DriverFeature {
  name: string;

  prepareTurn?(turn: TurnState): Awaitable<void>;
  prepareContext?(turn: TurnState): Awaitable<void>;
  preparePrompt?(turn: TurnState): Awaitable<void>;
  prepareCapabilities?(turn: TurnState): Awaitable<void>;
  prepareTools?(turn: TurnState): Awaitable<void>;

  beforeStep?(turn: TurnState): Awaitable<void>;
  beforeModelCall?(turn: TurnState): Awaitable<void>;
  afterModelCall?(turn: TurnState, output: ModelStepOutput): Awaitable<void>;
  afterToolResults?(turn: TurnState, output: StepOutput): Awaitable<void>;
  transformStepEntries?(
    turn: TurnState,
    entries: ConversationEntry[],
  ): Awaitable<ConversationEntry[]>;
  persistStep?(turn: TurnState, step: CompletedStep): Awaitable<void>;
  shouldContinue?(turn: TurnState, step: CompletedStep): Awaitable<boolean | undefined>;

  finishTurn?(turn: TurnState): Awaitable<void>;
  failTurn?(turn: TurnState, error: unknown): Awaitable<void>;
  cleanupTurn?(turn: TurnState): Awaitable<void>;
}
```

Hooks should be categorized by semantics:

- `effect`: observes or performs side effects, returns nothing
- `provide`: appends fragments/tools/capabilities
- `transform`: takes a value and returns the replacement value
- `decide`: returns `boolean | undefined`; `undefined` means no opinion

This avoids hooks that can arbitrarily control everything.

## Phase Runner

The turn runner should expose phases, not raw hook calls.

```ts
interface TurnPhases {
  prepareTurn(turn: TurnState, signal: AbortSignal): Promise<void>;
  runStep(turn: TurnState): Promise<CompletedStep>;
  shouldContinue(turn: TurnState, step: CompletedStep): Promise<boolean>;
  finishTurn(turn: TurnState): Promise<void>;
  failTurn(turn: TurnState, error: unknown): Promise<void>;
  cleanupTurn(turn: TurnState): Promise<void>;
}
```

The main loop stays small. Both turn preparation and the step loop run under one
`AbortSignal` owned by the turn (`turn.abortController`). The scheduler aborts it
when interrupting input arrives, so a turn can be preempted **during preparation**
(e.g. mid `refreshAllowedReactionEmojis`) as well as at a step boundary — there is
no separate pre-flight interrupt check. See "Unified Preemptive Interruption".

```ts
const runTurn = async (turn: TurnState, phases: TurnPhases) => {
  const signal = turn.abortController.signal;

  try {
    await phases.prepareTurn(turn, signal);

    while (true) {
      const step = await phases.runStep(turn);
      if (!await phases.shouldContinue(turn, step)) break;

      // Append the RAW step entries to the working context, not the pruned
      // view. The pruned view is persisted by persistStep. See
      // "Step Entries: Raw vs Persisted".
      turn.entries = [...turn.entries, ...step.rawEntries];
      turn.step++;
    }

    await phases.finishTurn(turn);
  } catch (err) {
    // An abort is a silent reschedule, NOT a failure: do not record failedRc,
    // do not rethrow as an error. Real errors go through failTurn.
    if (signal.aborted) {
      turn.flags.interruptedByInput = true;
    } else {
      await phases.failTurn(turn, err);
      throw err;
    }
  } finally {
    await phases.cleanupTurn(turn);
  }
};
```

The phase runner owns hook ordering. Every prepare hook receives the signal so
in-flight network work (reaction refresh, prompt rendering that fetches, etc.)
can be cancelled the instant the scheduler decides to preempt:

```ts
const prepareTurn = async (turn: TurnState, signal: AbortSignal) => {
  await runHook('prepareTurn', turn, signal);
  await runHook('prepareContext', turn, signal);
  await runHook('preparePrompt', turn, signal);
  await runHook('prepareCapabilities', turn, signal);
  await runHook('prepareTools', turn, signal);
};
```

This keeps hook count high enough to isolate behavior but prevents the main loop
from becoming a wall of `onX()` calls. Crucially, it removes the need for a
"gate" phase that can abort a turn mid-preparation: cancellation rides the
existing `AbortSignal` instead of a bespoke decision point.

## Proposed Features

### ContextFeature

Responsibilities:

- load TRs after compaction cursor
- compose RC + TRs + summary through `composeContext()`
- initialize `turn.entries`
- detect interrupted previous tool loop via `wasToolLoopInterrupted()`
- compute mention/reply state for late binding

Current source:

- `loadTRs(chatId, cursor)`
- `composeContext(...)`
- `wasToolLoopInterrupted(trs)`
- mention/reply scans in `executeLlmCall()`

### PromptFeature

Responsibilities:

- render primary system prompt
- collect late-binding fragments
- inject late-binding user message

Late-binding fragments should be provided by narrower features instead of one
large block. Examples:

- time-now fragment
- force-tool-call fragment
- mention/reply state fragment
- interruption state fragment
- recent send-message human-likeness fragment
- active background task fragment

Current source:

- `renderSystemPrompt(...)`
- `renderLateBindingPrompt(...)`
- `injectLateBindingPrompt(...)`
- `localTimeNow()`

### CapabilityFeature

Responsibilities:

- set initial capabilities by `turn.kind`
- apply chat config gates
- apply platform gates
- apply dynamic gates such as available reaction emojis

Current source:

- `createSharedTools(includeSendMessage, reactionEmojis)`
- subagent `createTools: () => createSharedTools(false)`
- Telegram reaction tool conditional
- skill tool conditional

### ToolProviderFeature

Responsibilities:

- convert `turn.capabilities` into actual `CahciuaTool[]`
- own tool-specific setup and dependencies

Suggested providers:

- `sendMessageToolProvider`
- `reactionToolProvider`
- `bashToolProvider`
- `webToolProvider`
- `downloadFileToolProvider`
- `readImageToolProvider`
- `backgroundTaskToolProvider`
- `skillToolProvider`
- `subagentToolProvider`

Current source:

- all logic inside `createSharedTools()`
- skill tool construction in `executeLlmCall()`
- subagent `mainTools()`

### SendMessageFeature

Responsibilities:

- hold `sendMessageTurnFlags` on `TurnState`
- expose send/dismiss tools when capability allows
- record length-limit behavior
- prune failed length-limit attempts across steps

Current source:

- `sendMessageTurnFlags`
- `createSendMessageTool(...)`
- `createDismissMessageTool()`
- `pruneLengthLimitFailures(...)`

### SkillFeature

Responsibilities:

- load all skills once per scope
- detect already loaded skills from context
- expose `load_skill` when capability allows
- update `turn.loadedSkills` when a skill is loaded

Current source:

- `loadSkillsFromFolder(...)`
- `extractLoadedSkillNames(ctx.entries)`
- `createLoadSkillTool(...)`

### SubagentFeature

Responsibilities:

- create subagent manager per scope
- expose main-agent subagent tools when enabled
- flush mailbox entries before each step
- wake main when subagent sends messages

Current source:

- `createAgentMailbox()`
- `createSubagentManager(...)`
- `pullExternalEntries: () => mailbox.flush('main')`
- `wakeMain`

The first refactor can leave subagent internals using `createRunner()` and only
adapt main-turn hooks. A later refactor can let subagents share the same
`TurnState` + `TurnPhases` path with `kind: 'subagent'`.

### PersistenceFeature

Responsibilities:

- persist every completed step as `TurnResponseV2` (the pruned/persisted view,
  not the raw working entries — see "Step Entries: Raw vs Persisted")
- update `scope.lastProcessedMs` **for main turns only**
- preserve `agentId`

`lastProcessedMs` drives the scheduler's `needsReply` / interruption cursor, so
it must only advance for `turn.kind === 'main'`. Subagent steps persist their
`TurnResponseV2` rows (with their `sa-<n>` agentId) but must **not** touch
`scope.lastProcessedMs`; doing so would wake or suppress the main reply loop
based on subagent activity. This preserves the current asymmetry between the
main `onStepComplete` (which calls `lastProcessedMs(requestedAtMs)`) and the
subagent `persistStep` (which only writes the row).

Current source:

- `onStepComplete`
- `deps.persistTurnResponse(...)`
- `lastProcessedMs(requestedAtMs)`
- subagent `persistStep`

### InterruptionFeature

Interruption is **preemptive**, not polled. The scheduler owns one
`turn.abortController` and aborts it the moment an interrupting external input
arrives, regardless of whether the turn is still in `prepareTurn` (composing
context, refreshing reaction emojis, rendering the prompt) or already inside the
step loop. The turn does not periodically *ask* "should I stop?"; it is
*stopped*. This unifies what the current code splits across two mechanisms:

- the pre-flight check after `composeContext` (`hasInterruptingInputDuringActiveRun()`
  → `return`), and
- the per-step `checkInterrupt()` poll inside `runStepLoop`.

Both collapse into "scheduler aborts the controller; the turn unwinds." The
pre-flight Telegram reaction refresh is also covered: because the abort fires
the moment input arrives, an in-flight `refreshAllowedReactionEmojis` fetch is
cancelled rather than completing on a turn that is already doomed — strictly
better than today's pre-flight check, which only fires *after* the refresh.

Responsibilities:

- thread `turn.abortController.signal` through every prepare-phase network call
  (reaction refresh, prompt rendering inputs) and every model call
- recognize `AbortError` in the runner's `catch` and route it to silent
  re-schedule, **not** `failTurn` / `failedRc`
- keep `turn.flags.interruptedByInput` as the turn-local record of why the turn
  ended (read by `cleanupTurn` / `onTurnSettled`)

Current source:

- `activeRunRc`
- `activeRunInterruptCursorMs`
- `activeRunInterruptedByInput`
- `hasInterruptingInputDuringActiveRun()`
- `checkInterrupt`
- `markActiveRunInterruptedByInput()`

#### Who decides, who aborts, who writes back

The decision moves to the **scheduler**, because the scheduler is already the
component watching RC changes (the reply effect today). When it sees an
interrupting input during an active turn, it does three things in one place:

```ts
// inside the scheduler, when interrupting input is observed during an active turn
markInterruptedByInput(scope);          // the invariant trio, below
turn.flags.interruptedByInput = true;   // turn-local cause record
turn.abortController.abort(new InterruptError());
```

`markInterruptedByInput` applies the three scheduler facts that today live in
`markActiveRunInterruptedByInput()` as one atomic unit:

```ts
startNextDebounceWithExtendDelay = true;          // next debounce uses extend delay
replyBatchDeadlineMs ??= Date.now() + maxDelayMs; // anchor deadline ONCE
// (the turn flag is set by the caller above)
```

The `??=` is load-bearing: the batch deadline is anchored on the **first**
interruption and must not slide forward on later interruptions within the same
batch. Keeping it inside a single scheduler method prevents any caller from
re-implementing the anchoring or applying the trio partially.

Note this is the inverse of the old data flow. Today the *turn* (`checkInterrupt`)
polls and writes back to the scheduler. In version B the *scheduler* decides and
the turn only *receives* an abort. The side effects therefore happen at the
**cause** (scheduler observes input) rather than at the **effect** (turn notices),
which is both simpler and removes the "hook pokes scheduler fields" hazard — the
turn-side hook (`InterruptionFeature`) no longer holds the interruption predicate
at all; it only classifies `AbortError`.

#### AbortError vs real failure

The runner's `catch` must distinguish an interrupt-abort from a genuine error:

```ts
} catch (err) {
  if (err instanceof InterruptError || turn.abortController.signal.aborted) {
    // silent: scheduler already anchored deadline + extend-delay; just unwind.
    // Do NOT call failTurn / markFailed — this RC is not "failed", it is superseded.
  } else {
    await phases.failTurn(turn, err);  // FailureFeature → scheduler.markFailed(...)
    throw err;
  }
} finally {
  await phases.cleanupTurn(turn);       // running(false), onTurnSettled, offline reset
}
```

This preserves the current asymmetry: an aborted turn never writes `failedRc`
(so the superseding RC is free to trigger a fresh turn immediately), while a real
error writes `failedRc` to suppress retry until RC changes.

#### Deadline reset on settle

`turn.flags.interruptedByInput` is the turn-local half that survives into the
`finally` block, because whether to clear `replyBatchDeadlineMs` depends on it.
`cleanupTurn` calls `scheduler.onTurnSettled(scope, { interruptedByInput })`, and
the scheduler clears the deadline only when the turn was **not** interrupted —
matching today's `if (!activeRunInterruptedByInput) replyBatchDeadlineMs = null`.

#### Runtime events do not abort

One behavior must be preserved explicitly: runtime events (e.g. background task
completion) wake the *next* turn but must **not** abort an in-flight model call.
So the scheduler's abort trigger fires only for interrupting *external chat*
input, not for runtime events — the same distinction
`latestInterruptingExternalEventMs` draws today. Runtime events still break the
step loop at a boundary (so the next turn recomposes context with the event),
but they do this by letting the current step finish and not continuing, not by
aborting. This stays a `shouldContinue` decision, the one place where a
non-abort, boundary-only stop still lives.

### FailureFeature

Responsibilities:

- on turn failure, record the failing RC snapshot so the scheduler suppresses
  retry until a fresh RC arrives

Current source:

- `failedRc(rcAtStart)` in the `executeLlmCall` catch block

Today the catch block writes `failedRc(rcAtStart)`, and the scheduler's
`needsReply` reads `rcVal === failedRc()` to suppress re-attempting a call for
the same RC. After the refactor, `failedRc` is a scope-level signal owned by the
scheduler (it is the consumer), but the **write** happens on turn failure. The
collaboration channel must be explicit: `failTurn(turn, error)` calls back into
the scheduler (e.g. `scope.scheduler.markFailed(turn.rcAtStart)`) rather than a
feature poking `scope.failedRc` directly. Without this, a failed turn would loop
on the same RC. Note `rcAtStart` is captured at turn creation (`turn.rcAtStart`),
not re-read at failure time.

### HumanLikenessFeature

Responsibilities:

- collect recent send-message assessments
- render the XML fragment for late binding

Current source:

- `collectRecentSendMessageAssessments(...)`
- `renderRecentSendMessageHumanLikenessXml(...)`
- `RECENT_SEND_MESSAGE_WINDOW`

### ReactionFeature

Responsibilities:

- refresh Telegram allowed reaction emojis before tool construction
- fall back to cached emojis on refresh failure
- expose `react_message` only when available

Current source:

- `refreshAllowedReactionEmojis`
- `getAllowedReactionEmojis`
- `createReactMessageTool(...)`

### CompactionFeature

Compaction should remain scope-level and independent from turn execution.

Responsibilities:

- observe RC changes
- load TRs for the compactable window
- call `runCompaction(...)`
- persist compaction metadata
- update compact cursor and RC

Current source:

- `disposeCompactionEffect`
- `compactionRunning`
- `lastCheckedRc`
- `compactionTimer`

Compaction hooks should be separate from turn hooks:

```ts
interface CompactionFeature {
  shouldCompact(scope: ChatScope, ctx: ComposedContext): boolean;
  selectWindow(scope: ChatScope, rc: RenderedContext, trs: TurnResponseV2[]): CompactionWindow;
  onCompactionStart?(scope: ChatScope, window: CompactionWindow): Awaitable<void>;
  onCompactionComplete?(scope: ChatScope, meta: CompactionSessionMeta): Awaitable<void>;
  onCompactionError?(scope: ChatScope, error: unknown): Awaitable<void>;
}
```

## Scheduling Boundary

Scheduling should not be implemented as ordinary turn hooks. It is a controller
around turns.

The scheduler owns:

- `needsReply(scope)`
- debounce timers
- typing extension
- reply-batch deadline
- active-turn abort
- failed-RC retry suppression
- offline mention/reply gate

Turn hooks may observe scheduler facts but should not schedule timers directly.

Suggested controller shape:

```ts
interface DriverScheduler {
  onRcUpdated(scope: ChatScope): void;
  onTyping(scope: ChatScope, userId?: string): void;
  wake(scope: ChatScope, reason: WakeReason): void;
  stop(scope: ChatScope): void;

  // Called by cleanupTurn (FailureFeature / settle), not by turn-decision hooks.
  // markInterruptedByInput is internal: in version B the scheduler decides to
  // interrupt and aborts the turn itself — see "Who decides, who aborts, who
  // writes back" — so it is not a turn-facing entry point.
  markFailed(scope: ChatScope, rc: RenderedContext): void;
  onTurnSettled(scope: ChatScope, outcome: { interruptedByInput: boolean }): void;
}
```

This keeps the subtle debounce and interruption semantics localized. In version
B the interruption decision lives entirely in the scheduler: when it observes
interrupting external input during an active turn it applies the deadline /
extend-delay trio atomically (its internal `markInterruptedByInput`), sets
`turn.flags.interruptedByInput`, and aborts `turn.abortController`. The turn
never polls. The only scheduler methods a settling turn calls are `markFailed`
(real error → retry suppression) and `onTurnSettled` (clear the deadline unless
the turn was interrupted).

## Step Executor

`src/driver/runner.ts` can be reduced to a step executor. It should no longer
own the whole loop.

Proposed split:

- `callModelStep(turn)`:
  - call `callLlm(...)`
  - handle force-tool-call retry
  - return assistant entries and usage
- `executeToolStep(turn, modelOutput)`:
  - extract tool calls
  - execute tools
  - return tool results
- `runOneStep(turn)`:
  - combine model output + tool results into `CompletedStep`

The loop-level policies then move to features:

- silent model handling
- prune length-limit failures
- persistence
- requires-follow-up stopping
- interruption stopping
- mailbox flush before next step

## Hook Ordering

Initial main-turn ordering should be fixed:

1. `prepareTurn`
2. `prepareContext`
3. `preparePrompt`
4. `prepareCapabilities`
5. `prepareTools`
6. repeated step:
   - `beforeStep`
   - mailbox/external-entry pull
   - `beforeModelCall`
   - model call
   - `afterModelCall`
   - tool execution
   - `afterToolResults`
   - `transformStepEntries`
   - `persistStep`
   - `shouldContinue`
7. `finishTurn`
8. `cleanupTurn`

Ordering matters. Examples:

- `SkillFeature` needs composed context before it can detect loaded skills.
- `ToolProviderFeature` needs capabilities before it can construct tools.
- `PromptFeature` needs reaction/tool availability to render system prompt
  accurately if the prompt advertises specific tools.
- `PersistenceFeature` should run after step transforms so persisted TRs match
  future context.
- `shouldContinue` should run after persistence so completed model/tool output
  is not lost. Note `shouldContinue` no longer carries external-input
  interruption (that is preemptive abort — see "InterruptionFeature"); the only
  stop decisions left here are no-tool-calls / no-follow-up, the silent-model
  break, and the runtime-event boundary stop.

If prompt rendering needs final tool availability, split prompt phase into:

1. `preparePromptInputs`
2. `prepareCapabilities`
3. `prepareTools`
4. `renderSystemPrompt`
5. `injectLateBinding`

The exact split can be chosen during implementation, but it should remain a
small fixed phase list.

## Mapping Current Logic to Hooks

| Current logic | New owner |
|---|---|
| `needsReply` computed | scheduler |
| offline mention/reply gate | scheduler |
| debounce timers and max deadline | scheduler |
| active abort controller | scheduler + `TurnState.abortController` |
| `composeContext` call | `ContextFeature` |
| `renderSystemPrompt` | `PromptFeature` |
| `renderLateBindingPrompt` | `PromptFeature` + fragment providers |
| recent send-message XML | `HumanLikenessFeature` |
| active background tasks late binding | `BackgroundTaskFeature` |
| Telegram reaction emoji refresh | `ReactionFeature` |
| `createSharedTools` | tool provider features |
| `sendMessageTurnFlags` | `SendMessageFeature` on `TurnState` |
| `extractLoadedSkillNames` | `SkillFeature` |
| `createLoadSkillTool` | `SkillFeature` |
| mailbox flush | `SubagentFeature.beforeStep` |
| `pruneLengthLimitFailures` | `SendMessageFeature.transformStepEntries` |
| `persistTurnResponse` | `PersistenceFeature.persistStep` |
| `lastProcessedMs` update (main only) | `PersistenceFeature.persistStep` |
| `failedRc(rcAtStart)` write | `failTurn` → `scheduler.markFailed(...)` |
| `hasInterruptingInputDuringActiveRun` pre-flight check | removed — scheduler aborts `turn.abortController` (see "Unified Preemptive Interruption") |
| `checkInterrupt` (external chat input) | removed — preemptive abort via `turn.abortController` |
| `checkInterrupt` (runtime-event boundary stop) | `InterruptionFeature.shouldContinue` (non-abort, boundary-only) |
| `markActiveRunInterruptedByInput` | `scheduler.markInterruptedByInput` (scheduler self-call on abort) |
| compaction effect | scope-level `CompactionFeature` |

## Testing Strategy

Add focused unit tests around the new boundaries before moving too much logic.

Recommended tests:

- `turn-state.test.ts`: constructs main/subagent `TurnState` defaults
- `scheduler.test.ts`: debounce, typing extension, deadline, offline gate
- `features/send-message.test.ts`: length-limit pruning and flags
- `features/tools.test.ts`: capabilities produce expected tools
- `features/prompt.test.ts`: late-binding fragment composition
- `features/interruption.test.ts`: runtime event vs external message behavior
- `turn-runner.test.ts`: loop continues/stops on tool calls and follow-up flags

Keep existing integration-style tests for current debounce behavior while
refactoring. They protect the most fragile runtime semantics.

## Migration Plan

The safest implementation path is incremental.

### Phase 1: Introduce Types Without Behavior Change

- Add `ChatScope`, `SchedulerState`, `TurnState`, and `TurnCapabilities` types.
- Move existing local variables into those structures.
- Keep `executeLlmCall()` behavior intact.

Expected result: large function still exists, but state is explicit.

### Phase 2: Extract Turn Preparation

- Extract `createMainTurn(scope)`.
- Extract `prepareMainTurn(turn)`.
- Move context composition, prompt rendering, reaction refresh, skill detection,
  and tool construction behind phase methods.

Expected result: `executeLlmCall()` becomes mostly orchestration.

### Phase 3: Reduce Runner to Step Executor

- Split `createRunner().runStepLoop()` into reusable `runOneStep()`.
- Move persistence, pruning, and continuation decisions to Driver phases.
- Keep force-tool-call retry inside the model step executor.

Expected result: main Driver owns lifecycle; runner owns provider/model/tool
step mechanics.

### Phase 4: Convert Tool Assembly to Capability Providers

- Replace `createSharedTools(includeSendMessage, ...)` with tool providers.
- Main and subagent turns use different `TurnCapabilities`.
- Move `sendMessageTurnFlags` onto `TurnState`.

Expected result: send-tool availability and gates become inspectable and
testable.

### Phase 5: Extract Scheduler

- Move debounce/interruption timer logic into `createDriverScheduler(...)`.
- Keep the public API unchanged: `handleEvent`, `handleTyping`,
  `setOfflineMode`, `stop`.

Expected result: `createDriver()` wires scope, scheduler, phases, and features.

Status: completed. `src/driver/scheduler.ts` now owns reply eligibility,
debounce timers, typing extension, active-run interruption/abort, failed-RC
writeback, and turn begin/settle state transitions. `createDriver()` keeps the
same public API and delegates scheduling through the per-scope scheduler
controller while retaining turn preparation/execution and independent
compaction wiring.

### Phase 6: Optional Subagent Unification

- Let subagents create `TurnState` with `kind: 'subagent'`.
- Reuse the same step executor and feature pipeline.
- Keep subagent-specific prompt and tools as feature overrides.

This is optional. The main driver benefits even if subagents keep their current
manager loop for a while.

## Risks

### Hidden Control Flow

Hooks can make control flow harder to follow if any hook can mutate anything.
Mitigation: fixed phases, typed hook semantics, and explicit `TurnState`.

### Ordering Regressions

Some logic depends on order, especially skills, prompt rendering, tools, and
persistence. Mitigation: phase runner owns ordering, and tests assert key order.

### Scheduler Regressions

Debounce and interruption are the most subtle behavior in the current Driver.
Mitigation: do not hookify timers; extract scheduler as a controller and keep
existing debounce tests passing through each phase.

### Over-abstraction

The project does not need a generic plugin framework. Mitigation: features are
internal modules, not dynamically loaded plugins.

### State Leaks Across Turns

Feature-local mutable state could accidentally persist across turns. Mitigation:
turn-level facts live in `TurnState`; feature-local state is limited to caches
such as loaded all-skills maps on `ChatScope`.

## Success Criteria

- `createDriver()` is primarily wiring and public API methods.
- The main turn runner is readable as prepare/run steps/finish.
- Tool availability can be inspected from `turn.capabilities`.
- Send-message length-limit behavior is tested without creating a full Driver.
- Debounce and interruption tests continue to pass.
- No DB migration is needed.
- `turn_responses_v2` output remains compatible with existing context
  composition and compaction.
