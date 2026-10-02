---
description: Send a message to a running Codex task, or continue a finished task's thread with it
argument-hint: '<job-id> <message>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" send "$ARGUMENTS"`

Present the command output to the user exactly as returned.
