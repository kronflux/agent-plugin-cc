# Changelog

## Unreleased

- Names change, with no aliases. `/agent:codex-rescue` is `/agent:codex-delegate`, `/agent:agy-rescue` is `/agent:agy-delegate`, and `/agent:codex-fanout` is `/agent:codex-fleet`. The subagents are `agent:codex-delegate` and `agent:agy-delegate`, and the prompting skill is `codex-prompting`, rewritten without a model version. `/agent:codex-adversarial-review` is removed: use `/agent:codex-review --stance critical`.
- Reviews take a target and a stance. `--target auto|changes|project` reviews a diff or the current files of a folder, and a project review also works outside a git repository. `--path <path>` can be repeated to narrow either target. `--stance peer` (the default for both agents) asks for an independent second opinion, and `--stance critical` challenges the design. `--background` starts a tracked background review and prints its job ID. A review that returns structured findings runs on a thread you can continue, findings may carry no file or line, and an unknown `--base` ref exits with code 1 before a job exists. `/agent:agy-review` takes the same flags.
- Model policy. A Codex job with no `--model` uses the repository's delegation setting; otherwise the model that `model/list` marks as the default, with its default effort; otherwise the newest visible Sol model in `codex debug models`; otherwise no model, with a warning, so the Codex configuration chooses. `--model` takes an id, a family word, `default` or `configured`. A model or effort Codex does not offer is rejected before a job exists, with the choices listed; when neither model list can be read, a named model is sent unchecked, with a warning. `--model configured` sends no model, but an effort from `--effort` or the delegation setting is still sent. Follow-ups keep the model and effort of the job they continue. Job records hold the model, the effort, and where each came from. The fixed model aliases are removed.
- An Antigravity job with no `--model` uses the repository's delegation setting, and otherwise names no model, so agy runs on the model saved in the Antigravity settings. When the plugin names no model, a delegated job's output shows a `Model:` line, before any resume information, that names the saved model, or says that Antigravity chose it. An unknown model, or an effort that conflicts with the effort in a model id, is rejected before the job starts.
- Review fixes. Instruction text after `--path` stays text, so a word such as `--background` in it starts nothing. `--path` accepts the old path of a renamed file in a changes review. `--target changes` with nothing changed says there is nothing to review and suggests `--target project`. A Codex review that returns no valid structured findings exits with code 1 and is recorded as failed, as an Antigravity review is. The review heading names the target the plugin resolved. An Antigravity review with no model names the saved Antigravity model in its output and job record. Both review help texts list `--wait` and `--background`.
- `/agent:result` of a background job prints the Antigravity `Model:` line and the Codex warning about a reported model that differs from the one sent; the warning is also written to the job log. `--from-last-review` names the agent and job ID of the review it continues in the prompt, and `/agent:status` shows that name while the task runs; after the task completes, status shows the summary of the task's own result. `/agent:status` shows task jobs as `delegate`.
- `/agent:codex-setup` and `/agent:agy-setup` accept `--model` and `--effort` to store a delegation default per repository, and report the model and effort a delegation would use.
- `/agent:status`, `/agent:result`, `/agent:send`, and `/agent:cancel` run `scripts/agent-companion.mjs`. `codex-companion.mjs` no longer accepts `status`, `result`, `send`, `cancel`, or `adversarial-review`. `/agent:send` to a finished Antigravity job says "on its Antigravity thread".
- The SessionStart hook exports `AGENT_PLUGIN_SESSION_ID` and `AGENT_PLUGIN_TRANSCRIPT_PATH` instead of `CODEX_COMPANION_SESSION_ID` and `CODEX_COMPANION_TRANSCRIPT_PATH`. A session started before the upgrade has the old names in its environment file until the hook runs again.
- Every command description names the providers it works for, command files share one frontmatter form, and the review commands no longer detach a background shell: they pass `--background` to the companion. The review commands put the chosen flag before the user's arguments, so text after `--` cannot swallow it, and the review and fleet commands pass the arguments in single quotes, so a double-quoted path with a space stays one value.
- The plugin needs Node.js 22.13 or later.
- Each Codex command now starts its own app server and stops it when done. The shared per-repository broker is removed, along with its session record and session-end teardown. `cancel` stops the job's worker, which ends its app server, and no longer sends a turn interrupt. `status` and `setup` report the session runtime as direct startup. Shared app servers started by an earlier version stop on their own idle timeout.
- Cancel keeps output a worker recorded before it stopped. Failed worktree launches remove their worktree and branch. Follow-up turns on a worktree job run in that worktree. `--timeout-ms` must be a positive number.
- Status and result no longer print a `codex resume` command for a job whose thread is ephemeral, and review jobs no longer print a resume command.
- On POSIX, if the shared temp state root (`$TMPDIR/agent-plugin-<uid>`) is a symlink or belongs to another user, commands stop with "The plugin state folder <dir> is not a private folder owned by you; set CLAUDE_PLUGIN_DATA."
- An unreadable legacy `state.json` is now kept, with a warning on stderr.
- `/agent:codex-transfer` copies the transcript once before every import, also when it is already under `~/.claude/projects`, and imports that copy. It writes a session map, `SESSION-MAP.md`, and a manifest to the plugin's state folder, never to the project, and appends one message to the new thread that points to the map. An unchanged session whose thread still exists reuses the thread. `--no-map` writes no map and adds no pointer. The output ends with a fidelity line that counts the thread's user and assistant messages and says that tool calls and results appear in them only as tagged text.
- `/agent:codex-transfer --json` prints the transfer manifest, version 1. The old `{ threadId, resumeCommand, sourcePath, sessionId }` object is removed; its values are `target.threadId`, `target.resumeCommand`, `source.transcriptPath` and `source.sessionId`. The line "Transferred the Claude session into a Codex thread with visible turn history." is removed.

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
