---
description: Transfer the current Claude Code session into a resumable Codex thread
argument-hint: '[--source <claude-jsonl>] [--json] [--no-map]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" transfer "$ARGUMENTS"`

Present the command output to the user exactly as returned. Preserve the Codex session ID and the `codex resume <session-id>` command. Preserve the session map path and the resume command exactly.
