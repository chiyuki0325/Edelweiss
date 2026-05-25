# Skill Activation Eval

This eval compares whether the model calls `load_skill` more often after the Skill Activation system prompt change.

Run:

```bash
pnpm eval evals/skill-activation/suite.ts
```

The suite uses the same exported chat fixture and fake skills for both prompt variants:

- `before-skill-activation-guidance` uses `prompts/primary-system.velin.md` copied from the commit before the Skill Activation guidance was added.
- `after-skill-activation-guidance` uses the current production `prompts/primary-system.velin.md`.
- Both variants include the same `../../prompts/IDENTITY.velin.md` system file.
- The suite runs only one model step, so it measures the model's first tool choice instead of later self-correction.

The evaluator marks a run as passed only when the model loads the matching `netease-cloud-music` skill for the exported music/lyrics chat. The report also includes label rates for `calledLoadSkill`, `calledTargetSkill`, `calledBrowserUseSkill`, `sentMessage`, and `loadedBeforeSend`.
