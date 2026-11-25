# Changelog

## 3.1.1

- Council: when the Claude seat's agent stops, a `SubagentStop` hook saves its reply as the agent wrote it to `<run folder>/replies/<prompt digest>.json` and submits it for its delivery. The leader no longer copies the reply out of a notification, where the host shows `<`, `>` and `&` as entities, and a seat's reply is recorded before a cutoff notice can reach it.
- Council: an `open` council lets a seat answer in up to 1500 characters, with its own Round 1 schema. A `question` council keeps 500, because its answers become the options of a vote. The skill names both limits.
- Council: the skill says not to send a cutoff notice to a seat whose agent has already replied, because a message resumes the finished agent and it answers a second time.
- A job of a council seat that the council has read is recorded as returned, so the job monitor prints no line for it. The monitor's description now reads "Agent jobs that finished and whose result no command has returned yet".

## 3.1.0

- Output from Codex and Antigravity is shown to Claude as data. The prose of a result, of a fleet member and of a native review is printed between `<untrusted-codex-output id="...">` (or `untrusted-antigravity-output`) and a closing tag, with a line that says the block is data. Terminal escape sequences, control characters, invisible characters and direction controls are removed, and a complete private key block is replaced by a note. Structured output, review findings, questions, errors, progress lines, a foreground job's log and every `--json` result are sanitised and not fenced. This changes the text of `/agent:result` and of a foreground task: the answer is now the line after the opening tag.
- The stop review gate uses the same fence. Its tag is `untrusted-claude-output` (before: `untrusted-claude-response`). The reason Codex gives for a block reaches Claude sanitised.
- Council: a seat's reply and a follow-up answer are stored sanitised, and the round 2 prompt and the skill say that the other members' findings and answers are data to judge, not instructions.
- A failed job is shown with a note when its provider's quota is used up. For a failure the provider may have caused, `/agent:result` and a foreground task read the provider's usage report, within 10 seconds, and print `<Provider> reports that its quota is used up.` under the error, with the reset time when the report gives one; with `--json` it is the field `quotaNote`. The stored job does not change, and nothing is read while a job runs or ends.
- An Antigravity model id finds its usage group by its base name: an id with an effort word matches the group that lists the base model's display name, and the most exact form of the id that names a group decides. This also applies when the council classes a failed Antigravity seat.
- The line that tells an Antigravity job to do the work itself now also forbids calling another AI agent or its tools.

## 3.0.2

- A question council accepts a top-level `sameAs` group of three or more answer labels, such as `[["A", "B", "C"]]`, and stores it as its pairs. Before, the reply was refused and the seat needed a repair turn.

## 3.0.1

- A command started without `--disable-warning=ExperimentalWarning` no longer prints the `node:sqlite` warning into its stderr on Node 22.
- Text files are checked out with LF line ends on every system (`.gitattributes`). With `core.autocrlf` on, a Windows checkout gave prompts and command files CRLF line ends, and the plugin read the carriage returns as part of the text.
- The council skill says to start a seat's agent without a name. A named agent can become a teammate whose reply reaches the leader only after the leader's turn ends, so the seat missed its deadline and a stand-in answered for it.
- The test suite passes on Node 22, on Linux and on Windows runners. CI runs the test files one at a time, in four shards per system.

## 3.0.0

- Names change, with no aliases. `/agent:codex-rescue` is `/agent:codex-delegate`, `/agent:agy-rescue` is `/agent:agy-delegate`, and `/agent:codex-fanout` is `/agent:fleet`. The subagents are `agent:codex-delegate` and `agent:agy-delegate`, and the prompting skill is `codex-prompting`, rewritten without a model version. `/agent:codex-adversarial-review` is removed: use `/agent:codex-review --stance critical`.
- Reviews take a target and a stance. `--target auto|changes|project` reviews a diff or the current files of a folder, and a project review also works outside a git repository. `--path <path>` can be repeated to narrow either target. `--stance peer` (the default for both agents) asks for an independent second opinion, and `--stance critical` challenges the design. `--background` starts a tracked background review and prints its job ID. A review that returns structured findings runs on a thread you can continue, findings may carry no file or line, and an unknown `--base` ref exits with code 1 before a job exists. `/agent:agy-review` takes the same flags.
- Model policy. A Codex job with no `--model` uses the repository's delegation setting; otherwise the model that `model/list` marks as the default, with its default effort; otherwise the newest visible Sol model in `codex debug models`; otherwise no model, with a warning, so the Codex configuration chooses. `--model` takes an id, a family word, `default` or `configured`. A model or effort Codex does not offer is rejected before a job exists, with the choices listed; when neither model list can be read, a named model is sent unchecked, with a warning. `--model configured` sends no model, but an effort from `--effort` or the delegation setting is still sent. Follow-ups keep the model and effort of the job they continue. Job records hold the model, the effort, and where each came from. The fixed model aliases are removed.
- An Antigravity job with no `--model` uses the repository's delegation setting, and otherwise names no model, so agy runs on the model saved in the Antigravity settings. When the plugin names no model, a delegated job's output shows a `Model:` line, before any resume information, that names the saved model, or says that Antigravity chose it. An unknown model, or an effort that conflicts with the effort in a model id, is rejected before the job starts.
- Review fixes. Instruction text after `--path` stays text, so a word such as `--background` in it starts nothing. `--path` accepts the old path of a renamed file in a changes review. `--target changes` with nothing changed says there is nothing to review and suggests `--target project`. A Codex review that returns no valid structured findings exits with code 1 and is recorded as failed, as an Antigravity review is. The review heading names the target the plugin resolved. An Antigravity review with no model names the saved Antigravity model in its output and job record. Both review help texts list `--wait` and `--background`.
- `/agent:result` of a background job prints the Antigravity `Model:` line and the Codex warning about a reported model that differs from the one sent; the warning is also written to the job log. `--from-last-review` names the agent and job ID of the review it continues in the prompt, and `/agent:status` shows that name while the task runs; after the task completes, status shows the summary of the task's own result. `/agent:status` shows task jobs as `delegate`.
- `/agent:codex-setup` and `/agent:agy-setup` accept `--model` and `--effort` to store a delegation default per repository, and report the model and effort a delegation would use.
- `/agent:codex-setup` and `/agent:agy-setup` accept `--scope user`, which stores the model, effort and write sandbox in `user-config.json` for every repository without its own setting. A delegation takes each value from the flag, then the repository setting, then the user setting, then the agent default, and the setup report names the source of each value; `--json` adds `sources`.
- An Antigravity model is named by its full id (`model-x-high`) or by its base name and `--effort high`; the plugin joins them into the id and never passes `--effort` to agy. An effort given in both, even the same one, or in neither is refused before a job exists, with a message that explains both forms. A stored full id with a stored effort, as earlier versions of setup stored it, still runs, with a warning to run setup again, and the setup report lists the efforts of the delegation model's base name.
- Antigravity jobs no longer flash a console window on Windows: every agy process the plugin starts runs with `AGY_CLI_DISABLE_AUTO_UPDATE=1`, unless you set the variable, so agy updates only when you run it directly.
- `/agent:codex-setup` and `/agent:agy-setup` refuse an argument they do not know with `Unknown argument "<word>" for setup.` and the usage line, and change nothing; before, a mistyped flag such as `--danger-full-access` was ignored. `--write-sandbox` without a value now also says which values to use.
- `/agent:status`, `/agent:result`, `/agent:send`, and `/agent:cancel` run `scripts/agent-companion.mjs`. `codex-companion.mjs` no longer accepts `status`, `result`, `send`, `cancel`, or `adversarial-review`.
- The SessionStart hook exports `AGENT_PLUGIN_SESSION_ID` and `AGENT_PLUGIN_TRANSCRIPT_PATH` instead of `CODEX_COMPANION_SESSION_ID` and `CODEX_COMPANION_TRANSCRIPT_PATH`. A session started before the upgrade has the old names in its environment file until the hook runs again.
- Every command description names the providers it works for, command files share one frontmatter form, and the review commands no longer detach a background shell: they pass `--background` to the companion. The review commands put the chosen flag before the user's arguments, so text after `--` cannot swallow it, and the review and fleet commands pass the arguments in single quotes, so a double-quoted path with a space stays one value.
- The plugin needs Node.js 22.13 or later.
- Each Codex command now starts its own app server and stops it when done. The shared per-repository broker is removed, along with its session record and session-end teardown. `cancel` asks the job's worker to stop: the worker interrupts a running Codex turn, then stops its app server. `status` and `setup` report the session runtime as direct startup. Shared app servers started by an earlier version stop on their own idle timeout.
- Cancel keeps output a worker recorded before it stopped. Failed worktree launches remove their worktree and branch. Follow-up turns on a worktree job run in that worktree. `--timeout-ms` must be a positive number.
- Status and result print the job's session ID and, for a task whose thread the agent keeps, the command that opens it in the agent's own tool (`codex resume <id>` or `agy --conversation <id>`). They print no such command for a job whose thread is ephemeral or for a review job. `/agent:resume` continues a job from Claude Code.
- On POSIX, if the shared temp state root (`$TMPDIR/agent-plugin-<uid>`) is a symlink or belongs to another user, commands stop with "The plugin state folder <dir> is not a private folder owned by you; set CLAUDE_PLUGIN_DATA."
- An unreadable legacy `state.json` is now kept, with a warning on stderr.
- Jobs live in a SQLite job store, one database per repository in the plugin's state folder, and each job runs in its own worker process. The store keeps each job's prompt, settings, state, messages, events and output, with the log beside it, and the job commands read only the store, so a job ID or label works from any Claude Code session of the repository. Finished, idle chains are deleted after 14 days, keeping the 50 most recently active. The store needs SQLite 3.51.3 or later (or 3.44.6+ within 3.44, 3.50.7+ within 3.50); with an older Node SQLite, the job commands and hooks stop with a message naming both versions.
- Jobs have states `queued`, `running`, `waiting`, `interrupted`, `completed`, `failed`, `cancelled` and `stopping`, and every job command suggests the command that fits the state. A job that continues another on the same conversation joins its chain; a job ID names that exact job, and a label names the newest job of its chain.
- `/agent:resume <job-id|label> [--force] [--output-schema <file>] [message]` continues a waiting, interrupted or completed job on its own thread as a new job. A failed or cancelled job, or a thread whose earlier agent exit was not observed, needs `--force`, and the output warns that the two may overlap. A stopping job cannot be continued yet.
- `agent-companion.mjs store recover [--force]` checks a damaged store and moves it aside to a `store.corrupt-<time>-<id>` folder, which is never deleted; the next command creates an empty store. A healthy store is left alone unless `--force` is given. When another process holds the store, nothing is moved and the identity files in `store/live/` are listed.
- The delegate commands accept `--label <name>` (1 to 40 lowercase letters, digits or hyphens), which later commands accept in place of a job ID. The companion `task` command also accepts `--run-id <id>`, which `status --json` reports as `runId`.
- `--allow-questions` on a delegate command lets the agent end its turn with one `AGENT-QUESTION:` line instead of guessing. The job then reads `waiting`, status and result show the question, and `/agent:send` answers it.
- `/agent:status` lists the 20 newest jobs of the current session, or with `--all` up to 200 jobs of the repository, with label, chain, pending messages and unread events. With a job ID or label it shows the job's log path and its last log lines as progress. `--wait` waits until the job is no longer queued, running or stopping.
- `/agent:result` without an argument shows the newest finished job of the session. Its notes say when the stored result was truncated and where the full log is, give a waiting job's question, and name the job that continued this one. `--wait` exits with code 75 when the job is still running at the end of the wait.
- `/agent:send` reports that the message was received, that it started a new job that continues the conversation, or that it is still pending. A message to a stopping job is delivered when the job is continued; a message dropped because the job failed or was cancelled exits with code 1. `send` accepts `--force` and `--timeout-ms <ms>` (default 60000).
- `/agent:send` and `/agent:resume` pass the message to the plugin through standard input inside quoted heredoc delimiters, so quotes, `$` and backticks arrive as typed. Both commands can now be run by Claude, not only typed by the user.
- `/agent:cancel` without an argument cancels the session's one queued, running or stopping job. It also closes a waiting or interrupted job. A job that does not confirm the cancel by its deadline is reported as such, with a pointer to `/agent:status`.
- Ending a Claude Code session, except through `/clear`, stops that session's jobs within about 8 seconds and keeps their records, prompts, results, messages and logs. Stopped jobs read `interrupted` and can be resumed; jobs whose agent could not be confirmed stopped read `stopping` and are listed on stderr. The SessionEnd hook timeout is 10 seconds.
- A new session is told once about up to ten interrupted, stopping or waiting jobs whose Claude Code process is gone, with `/agent:resume <id>` and `/agent:cancel <id>`.
- The monitor announces completed, failed, waiting and interrupted jobs of its session, one line each, starting with `[event <n>]`. A repeated event ID is a duplicate. The monitor also finishes work the store has already decided and stops workers that no longer report that they are alive.
- The stop-time review runs as an ordinary review job. If it outlasts the hook's 870-second wait, it keeps running and the block reason names the job.
- The hooks, the monitor, the job commands and the delegate subagents start Node with `--disable-warning=ExperimentalWarning`.
- `/agent:codex-transfer` copies the transcript once before every import, also when it is already under `~/.claude/projects`, and imports that copy. It writes a session map, `SESSION-MAP.md`, and a manifest to the plugin's state folder, never to the project, and appends one message to the new thread that points to the map. An unchanged session whose thread still exists reuses the thread. `--no-map` writes no map and adds no pointer. The output ends with a fidelity line that counts the thread's user and assistant messages and says that tool calls and results appear in them only as tagged text.
- `/agent:codex-transfer --json` prints the transfer manifest, version 1. The old `{ threadId, resumeCommand, sourcePath, sessionId }` object is removed; its values are `target.threadId`, `target.resumeCommand`, `source.transcriptPath` and `source.sessionId`. The line "Transferred the Claude session into a Codex thread with visible turn history." is removed.
- `status --json` prints `{ jobs: [...] }`, one object per job with `id`, `label`, `runId`, `provider`, `model`, `status`, `chainId`, `continues`, `threadId`, `resumable`, `resumeMethod`, `stopFailed`, `stoppingCause`, `providerExitUnobserved`, `pendingMessages`, `unreadEvents`, `question`, `resultTruncated`, `structuredResultTooLarge`, `createdAt` and `updatedAt`.
- `/agent:agy-usage` shows the Antigravity quota groups, with the percentage left and the local reset time of each limit, and marks the group of the model a delegation would use. `--json` prints a normalized object, schema 1. `/agent:codex-usage --json` adds the same normalized object as `normalized`.
- `/agent:agy-setup` also reports the agy version, the model count, the delegation model by display name and its source, the efforts agy lists, and the agy version on which process cleanup was confirmed.
- Antigravity tasks accept `--worktree`, `--from-last-review` (the newest finished review of the session, from either agent), `--output-schema <file>` (a turn without structured output fails) and `--prompt-file <file>`. Antigravity tasks and reviews are jobs in the store, and `/agent:resume` and `/agent:send` continue an Antigravity task on the same conversation.
- Read-only Antigravity tasks run with settings that deny agy's file-writing and command tools, and no longer use plan mode. A read-only guard fails a task that changed files or used such a tool; `AGY_COMPANION_READONLY_GUARD=off` turns it off.
- `/agent:agy-delegate` asks whether to continue the current Antigravity thread when this session has one, as `/agent:codex-delegate` does for Codex.
- A message to a running Antigravity job waits for the turn to end and starts a new job that continues the conversation; `/agent:send` reports `continued` with that job's ID. Cancelling an Antigravity job stops its processes by process ID, and the output says so.
- `/agent:fleet start <manifest.json>` starts up to eight Codex and Antigravity jobs from one JSON manifest (version 1) and tracks them as one run; `status`, `wait`, `results [--out <dir>]` and `cancel` take the run id. The whole manifest and each provider are checked before any job starts; a blank prompt file or an output schema that is not a JSON object is refused. A prompt or schema file whose real path is outside the manifest's folder and the workspace is refused before it is read, unless `start` gets `--allow-outside-files`. Every member is an ordinary job with its label. The Codex task flag `--manifest` is removed.
- `agent-companion.mjs worktree list` shows the worktrees the plugin created for jobs, and `worktree remove <job-id|label>` removes one with its branch. Removal is refused while the job has not ended, with uncommitted changes, or with commits that are not merged. `worktree remove <job-id|label> --force` discards uncommitted changes and unmerged commits, says what it discarded, and prints the command that restores the branch; it still refuses while the job has not ended. A task creates its worktree before its job; a job continued after its worktree was removed ends as failed with the reason `worktree removed`.
- `/agent:council` (the `council` skill, with the read-only `council-member` agent) asks one Claude, one Codex and one Antigravity seat the same brief, shows each seat the others' findings without names in a second round, merges the findings by script, and reports them with the leader's verdicts. A seat whose answer is not valid JSON of the required form gets one repair prompt, and a seat whose attempt fails gets one retry. When two seats from two different families have answered, each seat still working has five more minutes, and then the round closes without it. A Claude seat and a Codex seat are told so; an Antigravity seat is not, because a message to its running job would start a new job. A fresh Claude `council-member` agent stands in for a seat that gave no valid answer, through that seat's lens; `collect --disallow-substitute` turns this off for a round. A stand-in adds an answer and never a family: without a quorum of two original families the run ends as a failed council with its report. After the merge, `council followup <run> <seat> --finding <id> <question>` asks one seat one question about a merged finding, or about its stance with `--finding stance` on a decision run, at most two per seat and six per run; the answer appears in the next merge and report. When every seat agreed, `status` and `merge` say `unanimous`, and the leader adds its own counterargument to the report message. The `agent-companion.mjs council` subcommands are `start`, `collect`, `submit`, `crossexam`, `merge`, `verdict`, `followup`, `export`, `status` and `report`. The job store's schema version is 6.
- A council has four modes, chosen per run with the brief's `kind` or `council start --kind`: `review` and `decision` as before, `question` and `open`. In a `question` council each seat answers in its own words (at most 500 characters); in Round 2 each seat marks which answers say the same thing and endorses one, the merge joins the marked answers into options, and the vote chooses the option with two thirds of the seats. In an `open` council the seats say which answers they agree with, and the leader records `council verdict <run> agreement agreed|partly|disagreed -- <reason>`, which the report shows as `Agreement (leader judgement)`. Both use the lenses evidence, first principles and counterexamples, and work outside a git repository. The prompts call the panel a council, not a review council. Store version 6 adds the run mode and the agreement tables and changes no existing table.
- On Windows, git and the system tools the plugin starts (`taskkill`, `cscript`, `powershell`, `cmd`) are started by absolute path. The system tools are found under `SystemRoot`, then `windir`; git is found on `PATH`. The `PATH` search, which also finds `codex` and `agy`, skips entries that are empty, relative or the working folder. A tool that cannot be found this way is started by name as before.
- Antigravity write-capable jobs can now edit files and run commands. In print mode agy refuses every tool call that needs a permission, and the plugin passed none, so every `--write` job failed with "Antigravity was denied permission". Write-capable turns now get session-only settings that allow every tool; read-only turns keep the deny rules for writing and commands and may read files and URLs. A read-only turn that was refused a command and still answers completes instead of failing.
- The read-only guard fails a turn for a changed file only when the turn ran a tool other than a reading tool (including one that failed without a refusal or never ended), so a file that another program changed during the turn no longer fails an Antigravity review or council seat.
- `/agent:status` shows a job that asked a question and was answered as `answered`, with the job that continued it, and the hint of a running Antigravity job says that a message continues the conversation as a new job. `fleet results` prints a review member as `/agent:result` does. `worktree remove` waits up to eight seconds for a job that has just ended to release its provider process.
- User settings (`setup --scope user`) are stored in `<profile>/agent-plugin/user-config.json`, outside the plugin data folder that Claude Code deletes on uninstall. A file in the old place is read and moved on the next user-scope setup.
- The council fills omitted nullable fields of a seat's reply with null and takes the JSON object out of a code fence or a surrounding sentence before it validates the reply, so a seat no longer loses a round over such a slip.
- The job monitor checks that its Claude Code session is alive without starting a helper process on every scan.

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
