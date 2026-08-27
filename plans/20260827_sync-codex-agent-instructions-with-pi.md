# Synchronize Codex Instructions with Pi

## Goal

- Bring the latest workflow concepts from `pi/agent/AGENTS.md` into
  `codex/AGENTS.md`.
- Replace Pi-specific interfaces and behavior with Codex-native equivalents.

## Changes

- Add context-first delegation, context-forking rules, and subagent model
  routing for Codex.
- Add Codex-native question batching and capability discovery rules.
- Document Codex Plan Mode, `update_plan`, and the single conversation model.
- Preserve the existing verification, simplicity, autonomy, and Stow rules.

## Verification

- Compare both instruction files. Make sure that each new Pi concept has a Codex
  equivalent or an explicit Codex limitation.
- Search `codex/AGENTS.md` for Pi-only commands, extensions, settings, and tool
  names.
- Review the Markdown and the final diff for clarity, scope, and consistency.
