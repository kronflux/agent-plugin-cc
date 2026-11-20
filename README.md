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

- `/agent:codex-review` for a normal read-only Codex review
- `/agent:codex-adversarial-review` for a steerable challenge review
- `/agent:codex-rescue` and `/agent:codex-transfer` to delegate work to Codex and hand off sessions
- `/agent:status`, `/agent:result`, `/agent:send`, and `/agent:cancel` to manage the background jobs of both agents
- `/agent:codex-usage` to see how much of your Codex usage limits is left
- `/agent:codex-fanout` to start several Codex tasks at once from a manifest
- `/agent:agy-rescue`, `/agent:agy-review`, and `/agent:agy-setup` to do the same with Antigravity (`agy`)

## Requirements

- **For Codex: a ChatGPT subscription (incl. Free) or an OpenAI API key**, and the Codex CLI.
  - Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **For Antigravity: the Antigravity CLI (`agy`)**, signed in with your Google account. Usage
  counts against your Antigravity limits. You need only the agents you plan to use.
- **Git**, for reviews and worktree tasks.
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
- the `agent:codex-rescue` and `agent:agy-rescue` subagents in `/agents`

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

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/agent:codex-adversarial-review`](#agentcodex-adversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/agent:codex-review
/agent:codex-review --base main
/agent:codex-review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/agent:status`](#agentstatus) to check on the progress and [`/agent:cancel`](#agentcancel) to cancel the ongoing task.

### `/agent:codex-adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/agent:codex-review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/agent:codex-review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/agent:codex-adversarial-review
/agent:codex-adversarial-review --base main challenge whether this was the right caching and retry design
/agent:codex-adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code. To have Codex fix what a review found, run `/agent:codex-rescue --from-last-review`.

### `/agent:codex-rescue`

Hands a task to Codex through the `agent:codex-rescue` subagent.

Use it when you want Codex to:

- investigate a bug
- try a fix
- continue a previous Codex task
- take a faster or cheaper pass with a smaller model

The subagent starts Codex as a background job, waits until the job finishes, and returns Codex's result. It never returns only a job ID. While it waits, you can steer the job with [`/agent:send`](#agentsend) or stop it with [`/agent:cancel`](#agentcancel).

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, `--fresh`, `--worktree`, and `--from-last-review`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo. `--from-last-review` sends the findings of the newest finished `/agent:codex-review` or `/agent:codex-adversarial-review` run, preferring runs from the current Claude session; any text you add is sent with them.

Examples:

```bash
/agent:codex-rescue investigate why the tests started failing
/agent:codex-rescue fix the failing test with the smallest safe patch
/agent:codex-rescue --resume apply the top fix from the last run
/agent:codex-rescue --model gpt-5.4-mini --effort medium investigate the flaky integration test
/agent:codex-rescue --model spark fix the issue quickly
/agent:codex-rescue --background investigate the regression
/agent:codex-rescue --from-last-review skip the style findings
/agent:codex-rescue --worktree try a rewrite of the cache layer
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

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- `--effort` takes `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`; an effort the selected model does not support is rejected before Codex starts, with the efforts it does support
- if you say `spark`, the plugin maps that to `gpt-5.3-codex-spark`
- write-capable rescue runs use the `workspace-write` sandbox; `/agent:codex-setup --write-sandbox danger-full-access` turns the sandbox off for this repository, and `--write-sandbox workspace-write` turns it back on
- follow-up rescue requests can continue the latest Codex task in the repo

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
Claude turn. The rescue subagent and foreground runs print their own results, so they produce no
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

### `/agent:codex-fanout`

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
that do not set them. Every entry is checked before any task starts. Give write tasks
`worktree: true` so parallel edits do not collide. Use a path relative to the repository, or
quote a path that contains spaces.

```bash
/agent:codex-fanout tasks.json
/agent:codex-fanout tasks.json --write --worktree
```

### `/agent:send`

Sends a message to a task job of either agent.

- If a Codex job is running, the message joins its current turn. Codex reads it at its next step, the way a message typed into a running Codex session does. The command reports success only after Codex confirms it received the message.
- If an Antigravity job is running, the message runs as the next turn once the current turn finishes. The command reports success when that turn starts.
- If the job has finished, the message starts a new turn on the same thread or conversation as a new background job.

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

## Antigravity

The plugin also drives the Antigravity CLI (`agy`). Its jobs appear in `/agent:status`, and
`/agent:result`, `/agent:send`, and `/agent:cancel` work on them as on Codex jobs.

- `/agent:agy-setup` checks that `agy` is installed and signed in. agy has no sign-in status
  command, so the check lists the available models with `agy models`.
- `/agent:agy-rescue` hands a task to Antigravity through the `agent:agy-rescue` subagent. It
  supports `--background`, `--wait`, `--resume`, `--fresh`, `--model`, and `--effort` (the
  efforts the installed agy lists in `agy --help`, such as `low`, `medium`, and `high`).
- `/agent:agy-review` runs a review of your changes and returns structured findings. It takes
  the same target options as `/agent:codex-review` and optional focus text.

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
/agent:codex-rescue investigate why the build is failing in CI
/agent:agy-rescue investigate why the build is failing in CI
```

### Get A Second Opinion

```bash
/agent:codex-review
/agent:agy-review
```

### Start Something Long-Running

```bash
/agent:codex-adversarial-review --background
/agent:codex-rescue --background investigate the flaky test
```

Then check in with:

```bash
/agent:status
/agent:result
```

## Codex Integration

The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses the global `codex` binary installed in your environment and [applies the same configuration](https://developers.openai.com/codex/config-basic).

### Common Configurations

If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. For example to always use `gpt-5.4-mini` on `high` for a specific project you can add the following to a `.codex/config.toml` file at the root of the directory you started Claude in:

```toml
model = "gpt-5.4-mini"
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

Yes. If you already use Codex, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).

## Security notes

When Codex runs a delegated task and an MCP server asks for consent through an elicitation, the runner answers on your behalf, because a delegated run has no operator to ask. It declines requests in `form`, `openai/form`, `openaiForm` or `url` mode, because it cannot fill in a form or open a URL. It accepts a request with no `mode` or an unknown `mode` with empty content, because declining blocks the MCP tool call that raised it.

## Development

Run `npm ci` and then `npm run build`. If npm is configured with `omit=dev`, run `npm ci --include=dev` before `npm run build`. A plain `npm ci` skips the build tools and the build fails.
