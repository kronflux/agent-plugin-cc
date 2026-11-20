---
description: Start several Codex tasks in the background from a JSON manifest
argument-hint: '<manifest.json> [--write] [--worktree] [--model <id|family|default|configured>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task "--manifest $ARGUMENTS"`

Present the command output to the user exactly as returned.
