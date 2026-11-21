---
description: Check whether the Antigravity CLI (agy) is installed and signed in, and set the delegation model and effort
argument-hint: '[--scope project|user] [--model <id|default>] [--effort <level>] [--write-sandbox workspace-write|danger-full-access] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup "$ARGUMENTS"`

Present the command output to the user exactly as returned. If it says agy is not signed in, tell the user to run `!agy` once and sign in.
