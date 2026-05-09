# Subagent System Design

Cahciua subagents are isolated internal helper agents launched by the main Driver agent for non-trivial investigations or tool-heavy work. They are modeled after Claude Code-style subagents: the parent explicitly delegates a bounded task, the helper runs with its own system prompt and tools, and only structured messages/results return to the parent.

## Goals

- Keep exploratory tool rounds out of the main agent context when delegation is useful.
- Preserve DCP separation: IM chat history remains in RC, while agent work stays in Driver-owned turn responses.
- Let the main agent ask active helpers for status or further work.
- Let helpers finish themselves through an explicit finalization tool.

## Non-goals

- Subagents do not know about group chats, chat platforms, or end users.
- Subagents do not send chat messages.
- Subagents cannot launch nested subagents in the first version.
- Active subagents are not resumed after process restart; persisted non-finalized rows are marked failed/stale.

## Runtime model

Each chat scope owns one `SubagentManager` and one `AgentMailbox`.

- The main agent has internal ID `main`.
- Subagents use per-chat display IDs: `sa-1`, `sa-2`, ...
- `SubagentManager` tracks task, status, entries, running flag, and wake requests.
- `AgentMailbox` queues structured messages by recipient agent ID and flushes them as unified conversation entries.

Subagent lifecycle states:

- `running` — currently executing an LLM step loop.
- `idle` — not running, but can be woken by a mailbox message.
- `finalized` — completed via `finalize_subagent`; cannot receive new work.
- `failed` — failed during execution or marked stale after restart.

## Communication timing

Communication tools enqueue messages into the recipient mailbox. The runner flushes mailbox entries before the next LLM step after the current tool round:

1. Main calls `message_subagent`.
2. The tool queues an envelope to the subagent mailbox and wakes the subagent.
3. If the subagent is currently in a tool round, the message waits.
4. Before the subagent's next LLM call, the runner appends flushed mailbox entries.
5. The subagent can respond with `message_main` or finish with `finalize_subagent`.
6. Main receives those messages through the same mailbox hook before its next LLM step.

This gives bidirectional communication without mixing full transcripts between agents.

## Context isolation

Subagent transcripts are stored as their own Driver turn entries and are not injected into main context. Main sees only mailbox messages such as:

```xml
<agent-message from="sa-1" type="result" final="true">...</agent-message>
```

The same rule applies in the other direction: subagents receive only the initial task/context and explicit mailbox messages from main, not the group-chat RC.

## Tools

Main-only tools:

- `start_subagent` — starts an isolated helper for a bounded task.
- `message_subagent` — sends instructions or status requests to an active helper.

Subagent-only tools:

- `message_main` — sends a concise update or answer to the parent.
- `finalize_subagent` — returns the final result and exits.

Subagent allowlist:

- No `send_message`.
- No `start_subagent`.
- Existing non-chat tools may be available, including `bash`, `web_search`, `download_file`, `read_image`, `kill_task`, `read_task_output`, and `sleep`, according to parent chat config.

Tool descriptions and the subagent system prompt must avoid group-chat/platform/end-user concepts. Tool availability enforces chat-output restrictions; the subagent is not told about hidden chat capabilities.

## Configuration

Per-chat config:

```yaml
subagents:
  enabled: true
  model: primary
  maxConcurrent: 2
  maxSteps: 8
```

- `enabled` controls whether main sees subagent tools.
- `model` resolves through the existing top-level `models` registry; empty means use the chat primary model.
- `maxConcurrent` caps active non-finalized helpers per chat.
- `maxSteps` caps each subagent run loop.

## Persistence

Schema additions:

- `subagents` records lifecycle state, task, model name, timestamps, and final message.
- `subagent_messages` records mailbox messages for audit/debugging.
- `turn_responses_v2.agent_id` scopes Driver turn entries to `main` or a subagent ID.

On startup, unfinished persisted subagents should be marked failed/stale rather than resumed.

## Prompting

- Main prompt includes delegation guidance: use subagents only for isolated, non-trivial investigations or tool-heavy work; do simple work directly.
- Subagent prompt is purely internal task execution: assigned task, optional context, expected output, available tools, concise parent communication, and finalization.
- Subagent prompt must not mention group chat, chat platform, users, or external conversation context.
