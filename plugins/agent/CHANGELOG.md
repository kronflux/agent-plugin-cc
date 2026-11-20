# Changelog

## Unreleased

- `/agent:status`, `/agent:result`, `/agent:send`, and `/agent:cancel` run `scripts/agent-companion.mjs`. `codex-companion.mjs` no longer accepts `status`, `result`, `send`, `cancel`, or `adversarial-review`. `/agent:send` to a finished Antigravity job says "on its Antigravity thread".
- The SessionStart hook exports `AGENT_PLUGIN_SESSION_ID` and `AGENT_PLUGIN_TRANSCRIPT_PATH` instead of `CODEX_COMPANION_SESSION_ID` and `CODEX_COMPANION_TRANSCRIPT_PATH`. A session started before the upgrade has the old names in its environment file until the hook runs again.
- The plugin needs Node.js 22.13 or later.
- Each Codex command now starts its own app server and stops it when done. The shared per-repository broker is removed, along with its session record and session-end teardown. `cancel` stops the job's worker, which ends its app server, and no longer sends a turn interrupt. `status` and `setup` report the session runtime as direct startup. Shared app servers started by an earlier version stop on their own idle timeout.
- Cancel keeps output a worker recorded before it stopped. Failed worktree launches remove their worktree and branch. Follow-up turns on a worktree job run in that worktree. `--timeout-ms` must be a positive number.
- Status and result no longer print a `codex resume` command for a job whose thread is ephemeral, and review jobs no longer print a resume command.
- On POSIX, if the shared temp state root (`$TMPDIR/agent-plugin-<uid>`) is a symlink or belongs to another user, commands stop with "The plugin state folder <dir> is not a private folder owned by you; set CLAUDE_PLUGIN_DATA."
- An unreadable legacy `state.json` is now kept, with a warning on stderr.

## 2.0.0

The plugin is now `agent` from the `agent-plugin-cc` marketplace, with commands named after the
agent they drive: `/agent:codex-review`, `/agent:codex-adversarial-review`,
`/agent:codex-rescue`, `/agent:codex-transfer`, `/agent:codex-setup`, `/agent:codex-usage`,
`/agent:status`, `/agent:result`, `/agent:send`, and `/agent:cancel`.

### Antigravity

- `/agent:agy-rescue`, `/agent:agy-review`, `/agent:agy-setup`, and the `agent:agy-rescue`
  subagent drive the Antigravity CLI (`agy`). agy jobs work with `/agent:status`,
  `/agent:result`, `/agent:send`, and `/agent:cancel`.
- Agent CLIs are providers behind one registry; jobs record their provider, and job views name
  the provider of each job.

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
