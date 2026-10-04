---
description: Run an Antigravity review of local git changes that challenges the implementation and design
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <model>] [--effort <low|medium|high>] [focus ...]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*)
---

Run an Antigravity review through the plugin runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Antigravity's output verbatim to the user.

Execution mode:
- If the raw arguments include `--background`, run the command below with `Bash` and `run_in_background: true`, and do not wait for it in this turn.
- Otherwise run it in the foreground.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review "$ARGUMENTS"
```

- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.
