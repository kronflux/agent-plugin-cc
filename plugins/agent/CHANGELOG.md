# Changelog

## 2.0.0

The plugin is now `agent` from the `agent-plugin-cc` marketplace, with commands named after the
agent they drive: `/agent:codex-review`, `/agent:codex-adversarial-review`,
`/agent:codex-rescue`, `/agent:codex-transfer`, `/agent:codex-setup`, `/agent:codex-usage`,
`/agent:status`, `/agent:result`, `/agent:send`, and `/agent:cancel`.

### Delegation

- The rescue subagent starts Codex as a background job, waits for it, and returns Codex's
  result. It never returns only a job ID.
- `/agent:send <job-id> <message>` adds a message to a running task's turn and reports it only
  after Codex confirms it. On a finished task it starts a new turn on the same thread.
- `/agent:codex-rescue --from-last-review` sends the findings of the newest review to Codex.
- `task --manifest <file.json>` starts one background task per entry.
- `task --worktree` runs a task in its own git worktree on the branch `agent/<job-id>`.
- `task --resume-thread <id>` continues a named thread; `task --output-schema <file>` asks for
  structured output.
- A plugin monitor tells Claude when a job finishes and no command has printed its result.

### Reliability

- Windows: executables are resolved through PATH and PATHEXT, `.cmd` and `.bat` files run
  through ComSpec, and process trees are stopped without a shell.
- Each job is stored in its own file, written atomically, so parallel jobs no longer lose or
  corrupt each other's records.
- Dead workers and stale jobs are detected; a queued job whose worker never started fails
  instead of staying queued.
- A turn that sends no events for 15 minutes is stopped and keeps its output; cancel waits for
  an interrupted worker before stopping it.
- When a job ends without a stored result, `/agent:result` reads it from the Codex transcript.
- The shared broker exits when idle, unloads threads of disconnected clients, and shuts down
  with the Claude session.
- Hooks start Node directly and work without a POSIX shell.

### Privacy and security

- Prompts are kept in a private request file, not in the job record, and secrets are redacted
  from summaries and error messages. State directories and files are private to the user.
- The write sandbox is `workspace-write` by default; `/agent:codex-setup --write-sandbox
  danger-full-access` turns it off per repository.

### Commands and checks

- `/agent:codex-usage` shows usage limit windows, plan, and credits.
- `/agent:codex-setup` shows the Codex app server version string.
- Every companion subcommand has its own `--help`; `--effort` is checked against the efforts
  the selected model supports before Codex starts; native reviews accept `--effort`.
- The stop review gate decides from a structured verdict and allows the stop after three blocks
  in a row (`CODEX_REVIEW_GATE_MAX_ROUNDS`).
- `/agent:codex-transfer` decides success from Codex's import report and supports Claude
  transcripts under `CLAUDE_CONFIG_DIR`.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
