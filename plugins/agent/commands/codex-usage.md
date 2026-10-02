---
description: Show the Codex usage limits of the signed-in account
argument-hint: ""
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" usage "$ARGUMENTS"`

Present the command output to the user exactly as returned.
