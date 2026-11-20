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
`/agent:result`, `/agent:send`, and `/agent:cancel` work for both agents.

## What You Get

- `/agent:codex-review` and `/agent:agy-review` to review your changes or your project, as a peer or as a critical reviewer
- `/agent:codex-delegate` and `/agent:agy-delegate` to hand a task to Codex or Antigravity
- `/agent:codex-transfer` to hand off a Claude Code session to Codex
- `/agent:status`, `/agent:result`, `/agent:send`, and `/agent:cancel` to manage the background jobs of both agents
- `/agent:codex-usage` to see how much of your Codex usage limits is left
- `/agent:codex-fleet` to start several Codex tasks at once from a manifest
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

Runs the same review with Antigravity. It takes the same flags as `/agent:codex-review`: `--target`, `--path`, `--stance`, `--base`, `--scope`, `--background`, `--wait`, `--model`, `--effort`, and instructions. Its default stance is `peer`, and it returns structured findings.

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

It supports `--background`, `--wait`, `--resume`, `--fresh`, `--worktree`, and `--from-last-review`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest Codex thread for this repo. `--from-last-review` sends the output of the newest finished review job that has output, from `/agent:codex-review` or `/agent:agy-review`. The task names the agent and the job ID of that review, for example "the findings of the Antigravity review review-...", and `/agent:status` shows that name while the task runs. When the task completes, `/agent:status` shows the summary of the task's own result. A review that failed, including one that returned no valid structured findings, is never used. When the plugin knows the current Claude session, only reviews from that session count. Any text you add is sent with the findings.

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

It supports `--background`, `--wait`, `--resume`, `--fresh`, `--model`, and `--effort` (the efforts the installed agy lists in `agy --help`, such as `low`, `medium`, and `high`).

```bash
/agent:agy-delegate investigate why the build is failing in CI
/agent:agy-delegate --resume apply the top fix from the last run
```

### `/agent:codex-transfer`

Creates a persistent Codex thread from the current Claude Code session and prints a `codex resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Codex.

Examples:

```bash
/agent:codex-transfer
/agent:codex-transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. The transfer uses Codex's external-agent session importer, so it follows the same conversion rules as importing Claude history in the Codex App and creates visible turns that can be continued in the App or TUI. The source must be under `~/.claude/projects` or, when `CLAUDE_CONFIG_DIR` is set, under `$CLAUDE_CONFIG_DIR/projects`. Codex imports only from `~/.claude/projects`, so a transcript from `CLAUDE_CONFIG_DIR` is copied into a temporary directory there for the import and removed afterward. Older Codex versions that do not expose session import must be upgraded before using this command.

### `/agent:status`

Shows running and recent jobs of both agents for the current repository. Each job shows its
session ID and the command that resumes it in its own CLI.

Examples:

```bash
/agent:status
/agent:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### Finished-job notices

In an interactive session, the plugin's monitor tells Claude when a job started from this
Claude Code process finishes and no command has printed its result yet: for example a
background task nobody waited for, or a new turn started by `/agent:send`. Claude then sees one
line such as `Codex job task-abc123 completed: ... Run /agent:result task-abc123 for the output.`

The monitor announces nothing else: no starts, progress, or cancellations. Each notice starts a
Claude turn. The delegate subagents and foreground runs print their own results, so they produce no
notice. Monitors do not run in non-interactive `claude -p` sessions.

### `/agent:result`

Shows the final stored output of a finished job of either agent.
When available, it also includes the session ID and the command that reopens the run in its own
CLI: `codex resume <session-id>` for Codex, `agy --conversation <id>` for Antigravity.

Examples:

```bash
/agent:result
/agent:result task-abc123
```

### `/agent:codex-fleet`

Starts one background Codex task per entry of a JSON manifest and prints the job IDs.

```json
[
  { "label": "lint", "prompt": "fix the lint errors in src/" },
  { "label": "docs", "prompt": "update the README for the new flags", "effort": "low" },
  { "label": "cache", "prompt": "try a rewrite of the cache layer", "write": true, "worktree": true }
]
```

Each entry needs a `label` and a `prompt`; `model`, `effort`, `write`, and `worktree` are
optional. `--write`, `--worktree`, `--model`, and `--effort` on the command apply to entries
that do not set them. Every entry is checked before any task starts, including its model and
effort. Give write tasks `worktree: true` so parallel edits do not collide. Use a path relative
to the repository, or quote a path that contains spaces.

```bash
/agent:codex-fleet tasks.json
/agent:codex-fleet tasks.json --write --worktree
```

### `/agent:send`

Sends a message to a task job of either agent.

- If a Codex job is running, the message joins its current turn. Codex reads it at its next step, the way a message typed into a running Codex session does. The command reports success only after Codex confirms it received the message.
- If an Antigravity job is running, the message runs as the next turn once the current turn finishes. The command reports success when that turn starts.
- If the job has finished, the message starts a new turn on the same thread or conversation as a new background job. The new turn keeps the model and effort of the job it continues.

Examples:

```bash
/agent:send task-abc123 stop exploring and summarize what you found
/agent:send task-abc123 also update the tests for the new flag
```

### `/agent:cancel`

Cancels an active background job of either agent. Cancel stops the job's worker and the
processes it started.

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

After three blocks in a row in one Claude session, the next stop is allowed. Set
`CODEX_REVIEW_GATE_MAX_ROUNDS` to change the limit, or to `0` to remove it.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

### `/agent:agy-setup`

Checks that `agy` is installed and signed in. agy has no sign-in status command, so the check
lists the available models with `agy models`. Like `/agent:codex-setup`, it reports the
delegation model and effort and accepts `--model <id>`, `--effort <level>`, and
`--write-sandbox workspace-write|danger-full-access`.

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

A background worker stops its own agent process through the process handle it opened when it
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
`/agent:result`, `/agent:send`, and `/agent:cancel` work on them as on Codex jobs. The commands
are [`/agent:agy-setup`](#agentagy-setup), [`/agent:agy-delegate`](#agentagy-delegate), and
[`/agent:agy-review`](#agentagy-review).

Each job runs its own `agy` process. Read-only runs use agy's plan mode with terminal
restrictions (`--mode plan --sandbox`); write runs keep the terminal restrictions
(`--sandbox`), and `/agent:codex-setup --write-sandbox danger-full-access` lifts them for both
agents. A message sent with `/agent:send` while a turn runs waits until that turn finishes and
then runs as the next turn; agy does not interrupt the running turn. agy has no way to
interrupt a turn, so `/agent:cancel` stops the job's processes. An agy process is stopped after
30 minutes; set `AGY_COMPANION_TURN_TIMEOUT_MS` to change the limit.

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
