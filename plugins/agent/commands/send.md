---
description: Send a message to a running Codex or Antigravity job, or continue a finished job's thread with it
argument-hint: '<job-id> <message>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs" send "$ARGUMENTS"`

Present the command output to the user exactly as returned.
