---
description: 'Show the Antigravity quota groups, windows and reset times'
argument-hint: '[--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" usage "$ARGUMENTS"`

Present the command output to the user exactly as returned.
