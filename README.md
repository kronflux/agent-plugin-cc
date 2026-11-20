# Agent plugin for Claude Code

Hand code reviews and coding tasks from Claude Code to other agent CLIs: OpenAI Codex and
Google Antigravity (`agy`). The agents run on your own machine with your own subscriptions, and
their jobs report back into your Claude Code session.

This plugin is a fork of the Codex plugin for Claude Code
([openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)). It keeps the same Codex
integration and adds Antigravity, Windows support, background jobs that report back on their
own, messages to running tasks, parallel tasks in separate worktrees, usage limits, and stricter
handling of prompts and job state. See [the changelog](plugins/agent/CHANGELOG.md) for the full
list.

All commands come from the `agent` plugin. Commands for one agent carry its name, for example
`/agent:codex-review` and `/agent:agy-review`; the job commands `/agent:status`,
`/agent:result`, `/agent:send`, `/agent:resume`, and `/agent:cancel` work for both agents.

## What You Get

- `/agent:codex-review` and `/agent:agy-review` to review your changes or your project, as a peer or as a critical reviewer
- `/agent:codex-delegate` and `/agent:agy-delegate` to hand a task to Codex or Antigravity
- `/agent:codex-transfer` to hand off a Claude Code session to Codex
- `/agent:status`, `/agent:result`, `/agent:send`, `/agent:resume`, and `/agent:cancel` to manage the background jobs of both agents
- `/agent:codex-usage` and `/agent:agy-usage` to see how much of each agent's usage limits is left
- `/agent:fleet` to start Codex and Antigravity jobs together from one manifest and track them as one run
- `/agent:codex-setup` and `/agent:agy-setup` to check each agent and choose its delegation model and effort

## Requirements

- **For Codex: a ChatGPT subscription (incl. Free) or an OpenAI API key**, and the Codex CLI.
  - Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **For Antigravity: the Antigravity CLI (`agy`)**, signed in with your Google account. Usage
  counts against your Antigravity limits. You need only the agents you plan to use.
- **Git**, for reviews of changes and worktree tasks. A project review also works outside a git repository.
- **Node.js 22.13 or later**, findable as `node` on the PATH that Claude Code gives its hooks.
  When Claude Code is started from a desktop launcher or an IDE, that PATH can lack a Node
  installed through nvm, fnm, asdf, mise, or Homebrew. Add Node's directory in your Claude Code
  settings, for example `"env": { "PATH": "/home/me/.nvm/versions/node/v24.11.0/bin:/usr/local/bin:/usr/bin:/bin" }`.
  The [job store](#job-store) uses Node's built-in SQLite, which must be SQLite 3.51.3 or later
  (or 3.44.6 or later within 3.44, 3.50.7 or later within 3.50). With an older SQLite, the job
  commands and hooks stop with a message that names the Node and SQLite versions they found.

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add kronflux/agent-plugin-cc
```

Install the plugin:

```bash
/plugin install agent@agent-plugin-cc
```

Reload plugins:

```bash
/reload-plugins
```

Then run the setup command of each agent you use:

```bash
/agent:codex-setup
/agent:agy-setup
```

`/agent:codex-setup` will tell you whether Codex is ready. If Codex is missing and npm is available, it can offer to install Codex for you.

If you prefer to install Codex yourself, use:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in yet, run:

```bash
!codex login
```

If `agy` is installed but not signed in, run `!agy` once and sign in.

After install, you should see:

- the slash commands listed below
- the `agent:codex-delegate` and `agent:agy-delegate` subagents in `/agents`

To try the plugin from a local checkout instead of the published marketplace, start Claude Code
with the plugin directory for one session:

```bash
claude --plugin-dir /path/to/agent-plugin-cc/plugins/agent
```

or add the checkout as a marketplace and install from it:

```bash
/plugin marketplace add /path/to/agent-plugin-cc
/plugin install agent@agent-plugin-cc
```

One simple first run is:

```bash
/agent:codex-review --background
/agent:status
/agent:result
```

## Usage

### `/agent:codex-review`

Runs a read-only Codex review. It reviews your changes or your project, and takes the stance of a peer or of a critical reviewer.

> [!NOTE]
> A review of a multi-file change or of a whole project can take a while. The command estimates the size and asks whether to wait or to run it in the background.

**Targets.** `--target` picks what is reviewed:

- `changes` reviews your uncommitted changes, or your branch compared to a base branch like `main`. Use `--base <ref>` for the branch comparison and `--scope working-tree` or `--scope branch` to pick one. `--base` and `--scope` apply only to this target. An unknown `--base` ref, a ref with no shared history, and `--base` together with `--scope working-tree` exit with code 1 before a job exists.
- `project` reviews the current files of the folder instead of a diff. The delegate reads the files itself; the plugin does not paste them into the prompt. The prompt names the review root and the paths, and asks for defects, invalid syntax, structure, consistency, formatting, behavior that would confuse an end user, unhandled edge cases, and recommendations.
- `auto` is the default. In a git repository it reviews the changes when the working tree has changes or the branch is ahead of its base. Otherwise it reviews the project. Outside a git repository it always reviews the project, and `--target changes` there exits with "No git repository here. Use --target project to review the current files."

`--path <path>` narrows either target to a file or folder and can be repeated. The path must lie inside the review root, which is the repository root for `changes` and the current folder for `project`. In a changes review the paths limit the status, the diffs, and the list of changed files. If no change lies under the given paths, the command suggests `--target project`.

**Stances.** `--stance` picks how the reviewer works:

- `peer` is the default. It asks for an independent second opinion: what is sound, what is wrong, and what is missing, with evidence for every finding.
- `critical` questions the chosen implementation and design: assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

Text after the flags is passed to the review as instructions, for example a risk area to examine. A changes review with the `peer` stance, no instructions, and no `--path` uses Codex's built-in reviewer on an ephemeral thread; every other combination runs a review prompt that returns structured findings on a thread you can continue.

**Background.** `--background` starts the review as a tracked background job and prints its job ID, and `--wait` runs it in the foreground, which is the default. Use [`/agent:status <job-id>`](#agentstatus) to check on it, [`/agent:result <job-id>`](#agentresult) for the output, and [`/agent:cancel`](#agentcancel) to stop it.

Examples:

```bash
/agent:codex-review
/agent:codex-review --base main
/agent:codex-review --target project --path src
/agent:codex-review --stance critical --base main challenge whether this was the right caching and retry design
/agent:codex-review --background --stance critical look for race conditions and question the chosen approach
```

This command is read-only and does not fix code. To have Codex fix what a review found, run `/agent:codex-delegate --from-last-review`.

It also takes `--model` and `--effort`, which follow the [model policy](#models-and-effort).

### `/agent:agy-review`

Runs the same review with Antigravity. It takes the same flags as `/agent:codex-review`: `--target`, `--path`, `--stance`, `--base`, `--scope`, `--background`, `--wait`, `--model`, `--effort`, and instructions. Its default stance is `peer`, and it returns structured findings. Every review, in the foreground or the background, is a job in the [job store](#job-store), so `/agent:status` and `/agent:result` show it, and `/agent:agy-delegate --from-last-review` can use its findings.

```bash
/agent:agy-review
/agent:agy-review --stance critical --background
```

### `/agent:codex-delegate`

Hands a task to Codex through the `agent:codex-delegate` subagent.

Use it when you want Codex to:

- investigate a bug
- try a fix
- continue a previous Codex task
- take a faster or cheaper pass with a smaller model

The subagent starts Codex as a background job, waits until the job finishes, and returns Codex's result. It never returns only a job ID. While it waits, you can steer the job with [`/agent:send`](#agentsend) or stop it with [`/agent:cancel`](#agentcancel).

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, `--fresh`, `--worktree`, `--from-last-review`, `--label <name>`, and `--allow-questions`. `--label` names the job so that later commands can address it by that name, and `--allow-questions` lets Codex end its turn with one question instead of guessing; see [Jobs, chains and labels](#jobs-chains-and-labels). If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest Codex thread for this repo. `--from-last-review` sends the output of the newest finished review job that has output, from `/agent:codex-review` or `/agent:agy-review`. The task names the agent and the job ID of that review, for example "the findings of the Antigravity review review-...", and `/agent:status` shows that name while the task runs. When the task completes, `/agent:status` shows the summary of the task's own result. A review that failed, including one that returned no valid structured findings, is never used. When the plugin knows the current Claude session, only reviews from that session count. Any text you add is sent with the findings.

Examples:

```bash
/agent:codex-delegate investigate why the tests started failing
/agent:codex-delegate fix the failing test with the smallest safe patch
/agent:codex-delegate --resume apply the top fix from the last run
/agent:codex-delegate --model <id> --effort medium investigate the flaky integration test
/agent:codex-delegate --model configured fix the issue quickly
/agent:codex-delegate --background investigate the regression
/agent:codex-delegate --from-last-review skip the style findings
/agent:codex-delegate --worktree try a rewrite of the cache layer
```

With `--worktree`, Codex works in a new git worktree on the branch `agent/<job-id>`, created from
your last commit, so your checkout stays untouched. Uncommitted changes in your checkout are not
in the worktree. The result names the worktree path. Review or merge the branch, then remove the
worktree with `git worktree remove <path>`.

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- the model and effort follow the [model policy](#models-and-effort): with no `--model` or `--effort`, the plugin uses your repository's delegation setting, and otherwise the default of the Codex model catalog
- `--effort` takes `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`; an effort the selected model does not support is rejected before Codex starts, with the efforts it does support
- `--model` takes a catalog id, a family word, `default` or `configured`; `configured` sends no model, so Codex chooses it and a model set in your Codex configuration applies; an effort from `--effort` or the delegation setting is still sent
- write-capable runs use the `workspace-write` sandbox; `/agent:codex-setup --write-sandbox danger-full-access` turns the sandbox off for this repository, and `--write-sandbox workspace-write` turns it back on
- follow-up requests can continue the latest Codex task in the repo, and they keep that task's model and effort

### `/agent:agy-delegate`

Hands a task to Antigravity through the `agent:agy-delegate` subagent. It works like `/agent:codex-delegate`: the subagent starts the job in the background, waits for it, and returns the result.

It supports `--background`, `--wait`, `--resume`, `--fresh`, `--worktree`, `--from-last-review`, `--label <name>`, `--allow-questions`, `--model`, and `--effort` (the efforts the installed agy lists in `agy --help`, such as `low`, `medium`, and `high`). If you omit `--resume` and `--fresh` and this Claude session has an Antigravity job that can be continued, the command asks whether to continue the current Antigravity thread or start a new one.

- `--worktree` runs Antigravity in a new git worktree on the branch `agent/<job-id>`, as for Codex. The worktree is created from your last commit, and the result names its path. A continued conversation runs where its job ran, so `--worktree` cannot be combined with `--resume`.
- `--from-last-review` sends the findings of the newest finished review of this Claude session, from `/agent:codex-review` or `/agent:agy-review`.
- The subagent runs a write-capable task unless you ask only for review, diagnosis, or research. A read-only task is checked by a [read-only guard](#antigravity), which fails the job if Antigravity changed files.

While the job runs, `/agent:send` stores a message that Antigravity takes as its next turn when the running turn ends, and `/agent:cancel` stops the job's processes.

```bash
/agent:agy-delegate investigate why the build is failing in CI
/agent:agy-delegate --resume apply the top fix from the last run
/agent:agy-delegate --worktree --label cache-rewrite try a rewrite of the cache layer
/agent:agy-delegate --from-last-review
```

### `/agent:codex-transfer`

Creates a persistent Codex thread from the current Claude Code session and prints a `codex resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Codex.

Examples:

```bash
/agent:codex-transfer
/agent:codex-transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
/agent:codex-transfer --no-map
```

The plugin's `SessionStart` hook records the current transcript path; `--source` overrides it. The source must be a `.jsonl` file under the `projects` folder of your Claude profile: `$CLAUDE_CONFIG_DIR/projects` when `CLAUDE_CONFIG_DIR` is set, otherwise `~/.claude/projects`. The transfer uses Codex's own session import, so it follows the same conversion rules as importing Claude history in the Codex App. Codex imports only from `~/.claude/projects` and the transcript of a running session keeps growing, so every transfer copies the transcript once into a temporary folder there, cut after its last complete line. That one copy is hashed, imported, and described, and it is removed afterwards, also after a failure. Older Codex versions that do not expose session import must be upgraded before using this command.

The output names the Codex thread, the resume command, the session map, and one fidelity line, followed by any warnings. The fidelity line counts the user and assistant messages in the thread and says that tool calls and results appear in them only as tagged text. The thread does not hold tool call inputs other than the file argument, thinking, meta, sidechain, attachment, or system records, sub-agent transcripts, or the original timestamps.

**Session map.** Unless you pass `--no-map`, the transfer writes a session map, `SESSION-MAP.md`, and its data, `manifest.json`, to `transfers/<claude-session-id>/` in the plugin's state folder for the repository, never into your project. The map describes what the thread lacks: files touched, the commands run, sub-agents, open to-dos, and a legend of the resources it points to, with their paths and how to read them. It copies no file content, tool output, or thinking. The few excerpts it holds, such as the last user request and the last shell commands, pass through the plugin's secret redaction and are cut to length. Each transfer of the same session replaces both files.

**Pointer.** After a new import, the plugin appends one user message to the thread that names the session map, so a plain `codex resume <session-id>` reads it. If that message cannot be added, the output warns, and the printed resume command carries the pointer as its first prompt instead. `--no-map` writes no map, adds no message, and prints the plain resume command.

**Repeat transfers.** If the transcript has not changed since the last transfer of this session and the recorded thread still exists, the transfer reuses that thread. It imports nothing, writes the map again, and prints "This session was already transferred; the transcript has not changed." A changed transcript is imported into a new thread, and the output names the earlier one.

`--json` prints the manifest instead of the text. The thread id and the resume command are `target.threadId` and `target.resumeCommand`, and the transcript path and the Claude session id are `source.transcriptPath` and `source.sessionId`.

### Jobs, chains and labels

Every task and review of either agent is a job in the [job store](#job-store). Jobs that
continue one another on one conversation form a chain, and the newest job of a chain is its tip.
The job commands accept a job ID or a label:

- A job ID names that exact job, including an earlier job of a chain.
- A label names the tip of the chain that holds it. Give a label with `--label <name>` on a
  delegate command. A label is 1 to 40 lowercase letters, digits, or hyphens, and one label
  belongs to one chain at a time. When a continuation cannot take over the label because another
  job holds it, the output says so.

A job is in one of these states, and each state calls for one command:

- `queued` or `running`: add to its turn with `/agent:send`, or stop it with `/agent:cancel`.
- `waiting`: the delegate asked a question. Answer it with `/agent:send <job-id|label> <answer>`.
- `interrupted` or `completed`: continue it with `/agent:resume` or `/agent:send`.
- `failed` or `cancelled`: read it with `/agent:result`. Only `/agent:resume --force` continues it.
- `stopping`: the plugin has asked the job to stop but has not yet confirmed that the agent's
  process is gone. It cannot be continued yet; check it later with `/agent:status`. The
  [job store](#job-store) section describes what happens next.

**Questions.** With `--allow-questions` on a delegate command, the agent is told that it may end
its turn with one final line of the form `AGENT-QUESTION: <one question>` when it cannot
continue without an answer. The job then reads `waiting`, `/agent:status` and `/agent:result`
show the question, and the answer goes through `/agent:send`.

### `/agent:status`

Shows the jobs of both agents, read from the job store. Without an argument it lists the 20
newest jobs of the current Claude session in one table; `--all` lists up to 200 jobs of the
repository. Each row shows the job ID, agent, kind, state, label, chain position, pending
messages, unread events, and title, and each chain tip gets a line with the command that fits
its state.

With a job ID or label it shows that one job: its state, label, chain, the agent's session ID,
any question, error, or stop note, the path of its log, and the last lines of the log as
progress. `--wait` waits until the job is no longer queued, running, or stopping, for at most
`--timeout-ms` milliseconds (default 240000).

Examples:

```bash
/agent:status
/agent:status --all
/agent:status task-abc123
/agent:status cache-rewrite --wait
```

Use it to:

- check progress on background work
- see which jobs wait for an answer or can be continued
- confirm whether a job is still running

`status --json` prints `{ "jobs": [...] }`. Each job has `id`, `label`, `runId`, `provider`,
`model`, `status`, `chainId`, `continues`, `threadId`, `resumable`, `resumeMethod`,
`stopFailed`, `stoppingCause`, `providerExitUnobserved`, `pendingMessages`, `unreadEvents`,
`question`, `resultTruncated`, `structuredResultTooLarge`, `createdAt`, and `updatedAt`.

### Finished-job notices

In an interactive session, the plugin's monitor tells Claude when a job of this session
completes, fails, waits for an answer, or is interrupted, and no command has returned that
outcome yet: for example a background task nobody waited for, or a new turn started by
`/agent:send`. Claude then sees one line such as:

```text
[event 12] Codex job task-abc123 completed. Run /agent:result task-abc123 for the output.
```

Each line starts with `[event <n>]`, where `n` is the event's ID. A line can repeat, for example
after the monitor restarts; a line whose event ID was already seen is a duplicate. Monitor lines
carry text from the delegate, such as its question, so Claude treats them as data, not as
instructions.

The monitor announces nothing else: no starts, progress, or cancellations. Each notice starts a
Claude turn. The delegate subagents and foreground runs return their own results, so they produce
no notice. Monitors do not run in non-interactive `claude -p` sessions.

The monitor is also the session's caretaker for the job store. Every 10 seconds it finishes work
that was already decided, such as starting the job that continues another, and it stops workers
that no longer report that they are alive.

### `/agent:result`

Shows the stored output of a job of either agent. Without an argument it shows the newest
finished job of the current Claude session. A job that is still queued, running, or stopping has
no result yet; `--wait` waits for its end, for at most `--timeout-ms` milliseconds (default
240000), and exits with code 75 if the job is still running then.

The output ends with notes where they apply: that the stored result was truncated and where
the full log is, the question of a waiting job, that the agent's exit was not observed, the
agent's session ID, and the job that continued this one. Reopen the session in the agent's own
CLI with `codex resume <session-id>` for Codex or `agy --conversation <id>` for Antigravity.

Examples:

```bash
/agent:result
/agent:result task-abc123
/agent:result cache-rewrite --wait
```

### `/agent:fleet`

Starts Codex and Antigravity jobs together from one JSON manifest and tracks them as one run.
The members do not talk to each other; each one is an ordinary background job with its own label.

```json
{
  "manifestVersion": 1,
  "name": "audit",
  "defaults": { "provider": "codex", "write": false, "worktree": false, "model": null, "effort": null },
  "members": [
    { "label": "audit-auth", "provider": "codex", "kind": "task", "prompt": "check the auth module for missing checks",
      "promptFile": null, "write": false, "worktree": false, "model": null, "effort": null, "outputSchema": null,
      "allowQuestions": false, "review": null },
    { "label": "audit-docs", "provider": "agy", "kind": "review", "prompt": "check the README against the code",
      "review": { "target": "project", "paths": ["README.md", "src"], "stance": "peer" } }
  ]
}
```

- `manifestVersion` must be `1`, and `members` lists at most 8 members. `name` and `defaults` are optional.
- A key whose value is `null` counts as absent, so the two members above are read the same way as if they left those keys out.
- Each member needs a `label` (1 to 40 characters from `a-z`, `0-9` and `-`, unique in the manifest) and exactly one of `prompt` and `promptFile`. `provider` falls back to `defaults.provider`, then to Codex. `kind` is `task` (the default) or `review`.
- `write`, `worktree`, `model` and `effort` fall back to `defaults`; a member is read-only unless it sets `write: true`. `worktree: true` needs a git repository.
- A review member needs `review` with `target` (`auto`, `changes` or `project`), and optionally `paths` and `stance` (`peer` or `critical`). Its prompt is the review's instructions, so it must not be blank, and it cannot set `outputSchema`, `allowQuestions`, `write` or `worktree`. A review always runs bound to the review schema on a thread that can be continued.
- `promptFile` and `outputSchema` are read relative to the manifest's folder. Each file must lie inside the manifest's folder or the workspace (the git repository root of the folder you run the command in, or that folder outside a repository), judged by its real path with links resolved. `start` refuses any other file before reading it, so a manifest from another repository cannot send a file such as a key to a provider. Pass `--allow-outside-files` to `start` to read such a file.

The subcommands, each with `--json` for a machine-readable reply:

```bash
/agent:fleet start audit.json
/agent:fleet start audit.json --allow-outside-files
/agent:fleet status run-1794000000000-1a2b3c4d
/agent:fleet wait run-1794000000000-1a2b3c4d --timeout-ms 900000
/agent:fleet results run-1794000000000-1a2b3c4d --out reports
/agent:fleet cancel run-1794000000000-1a2b3c4d
```

- `start` checks the whole manifest and then each provider once (installed and signed in) before any job exists. A problem in either exits with code 1, names the member or the provider, and starts nothing. It then writes the run record, starts every member as a background job with its label and the run id, and prints the run id and each member's job id. A member whose start fails is listed with the reason; the others still start, and the command exits 0.
- `status` prints one row per member from the job store: label, provider, job id, state and model. A member that continues as a new job shows the newest job of its chain.
- `wait` returns when no member is queued, running or stopping, or with `--any` when one of them is no longer. It waits 10 minutes by default and exits with code 75 when the time runs out.
- `results` prints each member's result under `## <label>`; `--out <dir>` also writes one `<label>.md` file per member.
- `cancel` cancels every member that has not ended.

Exit codes: 0 for success, 1 for a refused manifest, a failed provider check or an unknown run id, and 75 for a `wait` that timed out.

A member beyond its provider's parallel limit (`maxParallel` in `config.json`, 8 by default) stays `queued` and starts when a place frees; `status` shows it as queued. If a fleet stops between writing its run record and recording its members' starts, `status` shows each member it finds by run id and label as its job, and any other member as `start-unknown`; nothing is started again. The run record is `runs/<run-id>.json` in the plugin's state folder for the repository, never in your project. Every member answers to `/agent:send`, `/agent:resume`, `/agent:result` and `/agent:cancel` by its label.

### `/agent:send`

Sends a message to a job of either agent, addressed by job ID or label.

- If a Codex job is running, the message joins its current turn. Codex reads it at its next step, the way a message typed into a running Codex session does. The command reports that Codex received the message only after Codex confirms it.
- If an Antigravity job is running, the message waits until the current turn ends. A new job then continues the conversation with the message as its prompt, and the command reports `continued` with that job's ID.
- If the job is `waiting`, the message is the answer to its question.
- If the job has finished (`interrupted` or `completed`), the message starts a new job that continues it on the same thread or conversation. The new job keeps the model and effort of the job it continues.

The reply says that the message was received, that it continues the job as a new job, or that it has not been received yet and stays with the job's chain. A message to a `stopping` job is delivered when the job is continued. If the job ends as failed or cancelled before it takes the message, the message is dropped, and the command exits with code 1.

`--timeout-ms <ms>` sets how long the command waits for the message to be received (default 60000). `--force` continues a thread whose earlier agent exit was not observed; the output then warns that the two jobs may overlap.

The command passes your message to the plugin through standard input, between quoted heredoc delimiters, so quotes, `$`, and backticks arrive as typed. Without a message, it asks for one and sends nothing.

Examples:

```bash
/agent:send task-abc123 stop exploring and summarize what you found
/agent:send cache-rewrite also update the tests for the new flag
```

### `/agent:resume`

Continues a `waiting`, `interrupted`, or `completed` job on its own thread or conversation, as a new job in the same chain. The optional message becomes the new job's prompt; without one, the job continues with a fixed line that asks it to go on.

```bash
/agent:resume task-abc123
/agent:resume cache-rewrite finish the migration and run the tests
/agent:resume task-abc123 --force
```

- A `queued` or `running` job takes messages through `/agent:send` instead.
- A `stopping` job cannot be continued yet.
- A `failed` or `cancelled` job, or a thread whose earlier agent exit was not observed, needs `--force`. The output then warns that the two jobs may overlap.
- `--output-schema <file>` gives the new job a JSON schema for structured output. An invalid schema stops the command before a new job exists.
- If the job was already continued, the command names the existing continuation and stores nothing.

Like `/agent:send`, it passes the message through standard input, so quotes, `$`, and backticks arrive as typed.

### `/agent:cancel`

Cancels a job of either agent, addressed by job ID or label. Without an argument it cancels the
one queued, running, or stopping job of the current Claude session, and asks for a job ID or
label when there are several.

- A queued, running, or stopping job is asked to stop. A Codex turn is interrupted first; an
  Antigravity job, which cannot be interrupted, is stopped by process ID, and the output says so.
  If the job does not confirm the cancel by its deadline, the output says so and points to
  `/agent:status`.
- A `waiting` or `interrupted` job is closed as `cancelled`.
- A job that has already ended has nothing to cancel.

Examples:

```bash
/agent:cancel
/agent:cancel task-abc123
```

### `/agent:codex-usage`

Shows the usage limits of the Codex account you are signed in with: each limit window with the percentage used and when it resets, your plan, and your credit balance.

```bash
/agent:codex-usage
```

`--json` prints the response Codex returned, with a `normalized` object added that holds the same limits in the shape `/agent:agy-usage --json` uses.

### `/agent:agy-usage`

Shows the quota of the Antigravity account you are signed in with. It lists each quota group,
and under it each limit with the percentage left and when it resets, in your local time. The
group of the model a delegation would use now is marked `(used by default delegation)`. If the
plugin cannot tell which model that is, a note at the top says so.

```bash
/agent:agy-usage
/agent:agy-usage --json
```

`--json` prints a normalized object, schema 1, with the groups and their limits. If agy's quota
report cannot be read, the command exits with code 1 and prints the reason.

### `/agent:codex-setup`

Checks whether Codex is installed and authenticated, and shows the version string of the Codex app server.
If Codex is missing and npm is available, it can offer to install Codex for you.

The report also names the delegation model and effort that a Codex task would use now and where each comes from (`delegation model:` and `delegation effort:`).

`--model <id|family|default|configured>` and `--effort <level>` store a delegation default for this repository, after checking that Codex accepts it. The [model policy](#models-and-effort) describes how the stored default combines with the flags of a command. `--write-sandbox workspace-write|danger-full-access` sets the write sandbox.

```bash
/agent:codex-setup --model <id> --effort high
/agent:codex-setup --model default
```

You can also use `/agent:codex-setup` to manage the optional review gate.

#### Enabling review gate

```bash
/agent:codex-setup --enable-review-gate
/agent:codex-setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

The stop-time review runs as an ordinary review job in the job store. The hook waits for it for up to 870 seconds. If the review takes longer, it keeps running, and the block reason names the job so you can check it with `/agent:status` or stop it with `/agent:cancel`.

After three blocks in a row in one Claude session, the next stop is allowed. Set
`CODEX_REVIEW_GATE_MAX_ROUNDS` to change the limit, or to `0` to remove it.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

### `/agent:agy-setup`

Checks that `agy` is installed and signed in. agy has no sign-in status command, so the check
lists the available models with `agy models`. Like `/agent:codex-setup`, it reports the
delegation model and effort and accepts `--model <id>`, `--effort <level>`, and
`--write-sandbox workspace-write|danger-full-access`.

The report also shows the installed agy version, the number of models, the model a delegation
would use by its display name and where that choice comes from, and the efforts agy lists. A
`Cleanup` part names the agy version on which the plugin confirmed that agy's processes end
cleanly, and the assumption that no MCP server is configured for agy; see
[Antigravity](#antigravity). `--json` prints the report as JSON.

```bash
/agent:agy-setup
/agent:agy-setup --model <id>
```

## Models and effort

The plugin chooses the model and the effort of a Codex job in this order. The first rule that applies wins, and the job record keeps the choice and its source.

1. `--model` and `--effort` on the command.
2. The delegation setting of the repository, stored by `/agent:codex-setup --model <value>` or `--effort <value>`.
3. The default of the Codex model catalog: the visible model that `model/list` marks as its default, with that model's default effort. If `model/list` marks none or cannot be read within 10 seconds, the plugin uses the newest visible model of the Sol family in `codex debug models`, with that model's default effort.
4. If neither gives a model, because `codex debug models` cannot be read or lists no visible Sol model, the plugin sends no model, prints "Codex chose the model; a model set in the Codex configuration applies.", and Codex chooses.

`--model` takes:

- a catalog id, used as given
- a family word, which resolves to the best-ranked visible model of that family in the catalog
- `default`, which uses the catalog default and ignores the stored setting
- `configured`, which sends no model, so Codex chooses it and a model set in your Codex configuration applies. The plugin still sends an effort given with `--effort` or stored in the delegation setting, and that effort replaces the one in your Codex configuration.

An unknown model or an effort the model does not support exits with code 1 before any job, worktree or thread exists, and the message lists the visible models or the supported efforts. If neither `model/list` nor `codex debug models` can be read, a model you name is sent as given, with one line that says it was not checked, and an effort is checked only against the efforts the plugin knows.

Follow-ups keep the model and effort of the job they continue: `/agent:send` on a finished job, `--resume` and `--resume-thread` on a task. A follow-up that names a new model keeps the earlier effort only when the new model accepts it; otherwise one line says the effort was not used.

Reviews, fleet entries and `/agent:codex-setup` follow the same rules.

Setting rules for `/agent:codex-setup`: `--model default` clears the stored setting, `--effort` alone keeps the stored model, and `--model` alone clears the stored effort. A model no catalog can check is stored with a warning.

An Antigravity job uses `--model` from the command, then, on a continued conversation, the model choice of the job it continues, then the delegation setting stored by `/agent:agy-setup --model <id>`, and otherwise names no model, so agy runs on the model saved in the Antigravity settings. When the plugin names no model, the output of a delegated job shows, after Antigravity's result and before any resume information, `Model: <name> (from the Antigravity settings)`, or `Model: chosen by Antigravity` when no model is saved. `--model <id>` is checked against `agy models` before the job starts; if that list cannot be read, the model is sent as given, with one line that says it was not checked. A model id that already ends in an effort, together with a different `--effort`, is refused. When you continue a conversation after the saved model changed, the output says so.

## Configuration

The plugin keeps one `config.json` per repository in its state folder (under `CLAUDE_PLUGIN_DATA`). The setup commands write it; you do not need to edit it by hand.

```json
{
  "stopReviewGate": false,
  "models": {
    "codex": { "model": "<id>", "effort": "high" },
    "agy": { "model": "<id>", "effort": null }
  }
}
```

- `stopReviewGate` is the review gate of `/agent:codex-setup`.
- `models` holds the delegation setting of each agent, described under [Models and effort](#models-and-effort). A `null` value means the agent default applies.

The hook that starts each Claude Code session exports `AGENT_PLUGIN_SESSION_ID` and `AGENT_PLUGIN_TRANSCRIPT_PATH` for the commands of that session.

## Job store

The plugin keeps every job of a repository in one SQLite database, `store/state.db`, in its
state folder for that repository. Each job runs in its own worker process. The store holds each
job's prompt, settings, state, label, chain, messages, events, and final output; each job's log
is a file in `store/artifacts/`. Every job command reads the store, so a job ID or label works
from any Claude Code session in the repository. Before `/agent:status` or `/agent:result`
answers, it finishes work the store has already decided, such as recording a worker that died.

**Cleanup.** Once an hour at most, the store deletes chains that are finished and idle. A chain
is kept while any of its jobs is unfinished, a message to it is pending, it was active in the
last 14 days, or it is among the 50 most recently active chains.

**Session end.** When a Claude Code session ends, except through `/clear`, the plugin stops that
session's running jobs within about 8 seconds. Their records, prompts, results, messages, and
logs are kept, and a stopped job reads `interrupted`, so `/agent:resume` can continue it later.
Jobs whose agent process could not be confirmed stopped read `stopping` and are listed on
standard error. A worker whose Claude Code process is gone, for example after a crash, also
notices that and stops.

**Session start.** A new session is told once about up to ten jobs from an earlier session
whose Claude Code process is gone and that are interrupted, stopping, or waiting for an answer.
The note lists each job with its agent, state, age, and the start of its prompt, and suggests
`/agent:resume <id>` or `/agent:cancel <id>`.

**`stopping`.** A job reads `stopping` when the plugin asked it to stop and has not yet
confirmed that the agent's processes are gone. The monitor and the job commands keep checking
it. When the processes are confirmed gone, the job is released. When a grace window passes
without that proof, the job is released as "provider exit not observed". Wait, then check the
job with `/agent:status`.

**Provider exit not observed.** This note means the plugin could not prove that the agent's
processes ended, so the agent may still run. The thread that job used stays blocked:
`/agent:send` and `/agent:resume` on it refuse, so that two runs do not overlap on one
conversation. If you know the process is gone, or you accept the overlap, pass `--force`.

**Recovery.** If the store is damaged, commands stop with an error that names the recovery
command. Run it with Node from the plugin's `scripts` folder:

```bash
node <plugin root>/scripts/agent-companion.mjs store recover
```

It checks the store and, only when the check fails, moves the whole `store` folder aside to a
`store.corrupt-<time>-<id>` folder next to it, which the plugin never deletes. The next command
creates an empty store. A healthy store is left alone, and the command says so. `--force` moves
the store aside even when it is healthy. If another process holds the store, for example on
Windows, nothing is moved: close every Claude Code session and command that uses the
repository, then run it again. The output then lists the identity files in `store/live/`, which
name the processes that may hold the store.

**Stopping processes.** A background worker stops its own agent process through the process handle it opened when it
started that process. While the worker holds the handle and has not seen the process exit, Windows
cannot give the process id to another process, so `taskkill /T /F` reaches the agent's own tree. The
stop counts as a tree stop only when `taskkill` succeeds on a process that was still running. On
Linux the agent process leads its own process group. The plugin signals that group, and it treats
the agent's processes as gone only when the kernel reports the group empty.

Residual risk of stopping a process on Windows without the worker's handle: when a worker has died
and a later check or hook stops a worker or an agent process, it first reads that process's id and
start time, and stops nothing when they differ from the recorded ones. `taskkill` then receives only
the process id. If the process exits and Windows gives its id to a new process in the short time
between that check and `taskkill` opening the process, the new process and its children are stopped
instead, and the stop counts as a verified tree stop of the old process. Windows reuses process ids,
but rarely this quickly.

## Antigravity

The plugin also drives the Antigravity CLI (`agy`). Its jobs appear in `/agent:status`, and
`/agent:result`, `/agent:send`, `/agent:resume`, and `/agent:cancel` work on them as on Codex
jobs. The commands are [`/agent:agy-setup`](#agentagy-setup),
[`/agent:agy-usage`](#agentagy-usage), [`/agent:agy-delegate`](#agentagy-delegate), and
[`/agent:agy-review`](#agentagy-review).

Each turn runs its own `agy` process. Write runs use agy's `--sandbox`, and
`/agent:codex-setup --write-sandbox danger-full-access` lifts it for both agents. Read-only runs
use `--sandbox` together with settings that deny agy's file-writing and command tools. Paths
outside the working folder that a turn must read are passed with `--add-dir`. An agy process
is stopped after 30 minutes; set `AGY_COMPANION_TURN_TIMEOUT_MS` to change the limit.

The plugin's `agy-companion.mjs task` command, which the delegate subagent runs, also accepts
`--output-schema <file>`, which asks for structured output and fails a turn that returns none,
and `--prompt-file <file>`, which reads the prompt from a file.

Limits:

- **No messages during a turn.** agy cannot take a message while a turn runs. A message sent
  with `/agent:send` waits for the turn to end, and the next turn takes it as its prompt, one
  message per turn.
- **Cancel is a process stop.** agy has no turn interrupt, so `/agent:cancel` stops the job's
  processes by process ID, and the output says so.
- **Read-only is enforced by a guard.** agy's deny settings do not cover every tool, so for a
  task without `--write`, the plugin compares the git working tree before and after the turn
  and watches agy's output for file-writing and command tools. If the turn changed files or
  used one of those tools, the job fails with "Antigravity edited files during a read-only
  task:" and the paths. The guard
  does not undo the changes. Outside a git repository, and for files git ignores, only the
  watched output counts, so a write it does not show goes unnoticed. Reviews are not guarded.
  `AGY_COMPANION_READONLY_GUARD=off` turns the guard off.
- **Instructions, not limits.** Every prompt ends with lines that ask agy to do the work itself,
  without subagents or scheduled tasks, and, for a read-only task, to change no file and run no
  command. agy reads these as instructions; nothing enforces them apart from the guard.
- **No MCP servers assumed.** The plugin confirms that a job's agy processes are gone from
  behaviour it observed on agy 1.5.10 on Windows: agy's own exit, the death of the process that
  started it, and a forced tree stop. These observations assume that no MCP server is
  configured for agy, because an MCP server process may outlive agy. On other platforms, or
  when the processes cannot be confirmed gone, the plugin waits a 60-second grace window, and
  a job released after it reads "provider exit not observed"; see [Job store](#job-store).

How the two agents compare:

| Feature | Codex | Antigravity |
|---|---|---|
| Setup report | yes | yes |
| Usage report | yes | yes |
| Delegated task | yes | yes |
| `/agent:resume` | yes | yes |
| `/agent:send` to a running job | joins the running turn | waits for the next turn |
| `/agent:send` to a finished job | yes | yes |
| `/agent:cancel` | interrupts the turn, then stops the processes | stops the processes |
| `/agent:status`, `/agent:result` | yes | yes |
| Review, critical review | yes | yes |
| Fleet (`/agent:fleet`) | yes | yes |
| `--worktree` | yes | yes |
| Write sandbox | yes | yes (shared setting) |
| Structured output (`--output-schema`) | yes | yes |
| Stop-time review gate | yes | no (the gate runs Codex) |
| Session transfer | yes | no |
| `--from-last-review` | yes | yes |
| Finished-job notices | yes | yes |

## Messaging compared with native subagents

Claude Code's own subagents run inside the session. The plugin's delegates run as separate
agent processes, so some patterns work the way they do with a native subagent, some are
approximated, and some are not available.

| Pattern | Codex | Antigravity |
|---|---|---|
| Follow-up to a running delegate | Native-like: `/agent:send` joins the running turn and reports that Codex received the message once Codex shows it. | Approximated: the message waits for the turn's end; a new job on the same conversation takes it as its prompt, and `/agent:send` reports `continued` with that job's ID. |
| Follow-up to a finished delegate | Approximated: `/agent:send` or `/agent:resume` starts a new job on the same thread. | Approximated: `/agent:send` or `/agent:resume` starts a new job on the same conversation. |
| Mid-turn interrupt | Native-like: `/agent:cancel` interrupts the turn, then stops the processes if the turn does not end. | Approximated: agy cannot be interrupted; `/agent:cancel` stops the processes by process ID. |
| Question from the delegate | Approximated: with `--allow-questions` the delegate ends its turn with an `AGENT-QUESTION:` line, the job reads `waiting`, and the answer goes through `/agent:send`. | Approximated: the same. |
| Mid-turn approval | Not available: the plugin forwards no approval request from a running turn to Claude. | Not available: the same. |
| Progress | Approximated: `/agent:status <id>` shows the last lines of the job's log; `/agent:result --wait` shows nothing until the end, and the monitor prints no progress. | Approximated: the same. |
| Result delivery | Approximated: the monitor prints one `[event <n>]` line per outcome, at least once; `/agent:result` reads the stored output. | Approximated: the same. |
| Survival of a closed session | Approximated: session end stops the delegates and keeps their work; `/agent:resume` continues them on the same thread. | Approximated: the same. |
| Survival of a crashed session | Approximated: workers notice that the Claude Code process is gone and stop; the next command updates the store, and the job can be resumed. | Approximated: the same. |
| Survival of a crashed worker | Approximated: the plugin stops the agent's processes, records `interrupted`, and the job can be resumed; an agent exit that was not observed blocks the thread until `--force`. | Approximated: the same; outside the confirmed cleanup cases, the exit is not observed and the thread needs `--force`. |

## Typical Flows

### Review Before Shipping

```bash
/agent:codex-review
```

### Hand A Problem To Codex Or Antigravity

```bash
/agent:codex-delegate investigate why the build is failing in CI
/agent:agy-delegate investigate why the build is failing in CI
```

### Get A Second Opinion

```bash
/agent:codex-review
/agent:agy-review
```

### Challenge A Design

```bash
/agent:codex-review --stance critical --base main
```

### Start Something Long-Running

```bash
/agent:codex-review --background --stance critical
/agent:codex-delegate --background investigate the flaky test
```

Then check in with:

```bash
/agent:status
/agent:result
```

## Codex Integration

The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses the global `codex` binary installed in your environment and [applies the same configuration](https://developers.openai.com/codex/config-basic).

### Common Configurations

The plugin picks the model and effort of a job as described under [Models and effort](#models-and-effort). Your Codex `config.toml` model applies when you pass `--model configured`, and when the plugin finds no default model (rule 4 under [Models and effort](#models-and-effort)). Its reasoning effort applies only when the plugin sends no effort: an `--effort` on the command or an effort in the delegation setting replaces it. To make the `config.toml` model the default for a repository, run `/agent:codex-setup --model configured`.

For example, to use a model and effort for every `--model configured` job of a project that names no effort, add the following to a `.codex/config.toml` file at the root of the directory you started Claude in:

```toml
model = "<model id>"
model_reasoning_effort = "high"
```

Your configuration will be picked up based on:

- user-level config in `~/.codex/config.toml`
- project-level overrides in `.codex/config.toml`
- project-level overrides only load when the [project is trusted](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)

Check out the Codex docs for more [configuration options](https://developers.openai.com/codex/config-reference).

### Moving The Work Over To Codex

Delegated tasks and any [stop gate](#enabling-review-gate) run can also be directly resumed inside Codex by running `codex resume` either with the specific session ID you received from running `/agent:result` or `/agent:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

## FAQ

### Does Antigravity need its own sign-in?

Yes. The plugin uses your local `agy` CLI and its sign-in. Run `!agy` once to sign in, then
`/agent:agy-setup` to check it.

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, you will also need to sign in to Codex with either a ChatGPT account or an API key. [Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/), and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both ChatGPT and API key sign-in. Run `/agent:codex-setup` to check whether Codex is ready, and use `!codex login` if it is not.

### Does the plugin use a separate Codex runtime?

No. This plugin delegates through your local [Codex CLI](https://developers.openai.com/codex/cli/) and [Codex app server](https://developers.openai.com/codex/app-server/) on the same machine.

That means:

- it uses the same Codex install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Codex config I already have?

Partly. The plugin starts the same Codex install with the same [configuration](#common-configurations), so your sign-in, sandbox and provider settings apply. The model and effort of a job come from the [model policy](#models-and-effort), and your `config.toml` model applies when you pass `--model configured`.

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).

## Security notes

When Codex runs a delegated task and an MCP server asks for consent through an elicitation, the runner answers on your behalf, because a delegated run has no operator to ask. It declines requests in `form`, `openai/form`, `openaiForm` or `url` mode, because it cannot fill in a form or open a URL. It accepts a request with no `mode` or an unknown `mode` with empty content, because declining blocks the MCP tool call that raised it.

## Development

Run `npm ci` and then `npm run build`. If npm is configured with `omit=dev`, run `npm ci --include=dev` before `npm run build`. A plain `npm ci` skips the build tools and the build fails.
