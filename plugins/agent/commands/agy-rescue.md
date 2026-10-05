---
description: Delegate investigation, an explicit fix request, or follow-up work to Antigravity through the agy rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model>] [--effort <effort>] [what Antigravity should investigate, solve, or continue]"
allowed-tools: Bash(node:*), Agent
---

Invoke the `agent:agy-rescue` subagent via the `Agent` tool (`subagent_type: "agent:agy-rescue"`), forwarding the raw user request as the prompt.
`agent:agy-rescue` is a subagent, not a skill. Do not call `Skill(agent:agy-rescue)`.
The final user-visible response must be Antigravity's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `agent:agy-rescue` subagent in the background.
- If the request includes `--wait`, run the `agent:agy-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model`, `--effort`, `--resume`, and `--fresh` are runtime flags. Preserve them for the forwarded request, but do not treat them as part of the natural-language task text.

Operating rules:

- The subagent is a thin forwarder only. It starts the Antigravity job with `task --background`, waits for it with `result <job-id> --wait`, and returns that command's stdout as-is. It never returns only a job ID.
- Return the subagent's output verbatim to the user. Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- While an Antigravity job runs, `/agent:send <job-id> <message>` adds a message to it, and `/agent:cancel <job-id>` stops it.
- If the helper reports that agy is missing or not signed in, stop and tell the user to run `/agent:agy-setup`.
- If the user did not supply a request, ask what Antigravity should investigate or fix.
