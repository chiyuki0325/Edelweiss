---
name: Skill Authoring
description: Use when you need to inspect the current chat/skill environment or write a reusable skill from a mature workflow.
usage: Load this before creating or revising a skill file, or when you need the exact chat id, skills folder, or skill file paths.
---

Skills are reusable workflow notes. Use them to preserve a workflow that has become clear and repeatable, so future sessions can load it instead of rediscovering the same steps.

## Inspect the Runtime Environment

Use the following commands when you need exact runtime facts:

```bash
chat_info
```

Returns JSON with:
- `chatId`: current chat id.
- `currentChannel`: current platform channel.
- `skillsFolder`: absolute path to the configured skills folder.

```bash
skill_info <skill_id>
```

Returns JSON for one loaded skill, including:
- `id`
- `format`
- `title`, when the skill exposes one
- `description`
- `usage`, when present
- `skillsFolder`
- `skillPath`
- `mainFilePath`
- `resourceFiles`

Use `skill_info` when you need absolute paths for editing, reading adjacent resources, or checking what was loaded.

Skills are loaded once when a chat scope is created. If a skill file is added, removed, or changed, the running bot may need a restart before the available skills list and pseudo-command results reflect the change.

## Choose The Shape

Use a single markdown file when the workflow is only instructions. Create it in the configured skills folder. The filename without `.md` is the skill id used by `load_skill`.

```
skills/
  workflow-id.md
```

Use a directory when the workflow needs any script, helper document, template, fixture, or other resource file. The directory name is the skill id, the main instructions live in `SKILL.md`, and scripts/resources live next to it:

```
skills/
  workflow-id/
    SKILL.md
    scripts/
      helper.py
    any-other-resource.bin
```

Skill ids should be short kebab-case strings: lowercase words joined by hyphens, such as `release-notes`, `browser-debugging`, or `api-migration`.

## Write A Single-File Skill

Create a single markdown file in the configured skills folder:

Start the file with YAML front matter:

```md
---
name: Short Display Name
description: One sentence describing when this skill should be used.
usage: Optional sentence telling the model when to load it.
---

Write the actual workflow here.
```

Field rules:
- `name` is the human-facing title shown in the available skills list.
- `description` should be specific enough for the model to decide whether the skill matches the current request.
- `usage` is optional; include it only when it gives a useful activation rule.
- The filename is still the skill id. Do not tell the model to load the display name.

## Example

For a workflow that summarizes release notes and uses a helper script, create this directory:

```text
skills-folder/
  release-notes/
    SKILL.md
    scripts/
      collect-commits.py
```

`release-notes` is the skill id.

`SKILL.md`:

```md
---
name: Release Notes
description: Use when preparing user-facing release notes from recent commits or merged changes.
usage: Load before summarizing a release, changelog, or milestone.
---

Use this workflow to turn implementation history into concise user-facing release notes.

1. Run `chat_info` if you need the current chat id or skills folder.
2. Run `skill_info release-notes` if you need the absolute path to this skill or its helper script.
3. Inspect the requested commit range or change list.
4. Use `scripts/collect-commits.py` only when raw git output needs normalization.
5. Group the final notes by user-visible behavior, not by file names.
```

`scripts/collect-commits.ts`:

```python
# Helper script for normalizing git log output before writing release notes.
```

## What To Put In The Body

Write the workflow as operational instructions:
- When to use the workflow.
- What information to gather first.
- Which tools or commands to run.
- Expected inputs and outputs.
- Failure modes and recovery steps.
- Examples that show the intended command shape or final answer shape.

Keep the body focused on procedures that are stable across sessions. Do not store one-off chat details unless they are part of a durable workflow.
