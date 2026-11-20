---
description: 'Start Codex or Antigravity jobs together from one manifest and track them as one run'
argument-hint: 'start <manifest.json> [--allow-outside-files] | status|wait|results|cancel <run-id> [--any] [--timeout-ms <ms>] [--out <dir>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node --disable-warning=ExperimentalWarning "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs" fleet '$ARGUMENTS'`

Present the command output to the user exactly as returned.
