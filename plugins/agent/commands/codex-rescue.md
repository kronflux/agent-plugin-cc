---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Codex rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--from-last-review] [--worktree] [--model <id|family|default|configured>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [what Codex should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `agent:codex-rescue` subagent via the `Agent` tool (`subagent_type: "agent:codex-rescue"`), forwarding the raw user request as the prompt.
`agent:codex-rescue` is a subagent, not a skill — do not call `Skill(agent:codex-rescue)` (no such skill) or `Skill(agent:codex-rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Codex's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- Claude Code runs plugin subagents in the background, so run the `agent:codex-rescue` subagent in the background in every case. Its result arrives as the agent's completion notification.
- If the request includes `--wait`, tell the user in one sentence that the result will arrive when the agent finishes, and start no other work in this turn.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- `--worktree` runs Codex in a new git worktree on its own branch instead of in this checkout. Preserve it for the forwarded `task` call, but do not treat it as part of the natural-language task text.
- `--from-last-review` sends the findings of the newest finished review, from `/agent:codex-review` or `/agent:agy-review`, to Codex. The task names that review's agent and job id, for example "the findings of the Antigravity review <job-id>". Preserve it for the forwarded `task` call, but do not treat it as part of the natural-language task text. A request with this flag needs no other text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Codex, check for a resumable rescue thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Codex thread or start a new one.
- The two choices must be:
  - `Continue current Codex thread`
  - `Start a new Codex thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Codex thread (Recommended)` first.
- Otherwise put `Start a new Codex thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It starts the Codex job with `task --background`, waits for it with `result <job-id> --wait`, and returns that command's stdout as-is. It never returns only a job ID.
- Return the Codex companion stdout verbatim to the user.
- When the subagent returns, present its output and stop. Do not run git, tests, or any other command to check its work.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, poll `/agent:status`, call `/agent:cancel`, summarize output, or do follow-up work of its own.
- While a Codex job runs, `/agent:send <job-id> <message>` adds a message to its running turn, and `/agent:cancel <job-id>` stops it.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort.
- Leave the model unset unless the user explicitly asks for one. Pass `--model` only when the user names a model, a family word, `default` or `configured`.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to run `/agent:codex-setup`.
- If the user did not supply a request and did not pass `--from-last-review`, ask what Codex should investigate or fix.
