---
description: Review local git changes or the current project with Codex, as a peer or a critical reviewer
argument-hint: '[--target auto|changes|project] [--path <path>]... [--stance peer|critical] [--base <ref>] [--scope auto|working-tree|branch] [--background|--wait] [--model <id|family|default|configured>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [instructions]'
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Codex review through the plugin runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Codex's output verbatim to the user.

Targets:
- `--target changes` reviews the git working tree, or the branch against `--base <ref>`. `--scope working-tree` or `--scope branch` picks one of the two.
- `--target project` reviews the current files of the folder, or only the files named with `--path <path>` (repeatable). Codex reads the files itself.
- `--target auto` is the default. It reviews the changes when the working tree has changes or the branch is ahead of its base, and the project otherwise, also outside a git repository.
- `--base` and `--scope` apply only to a changes target.

Stances:
- `--stance peer` is the default. It asks for an independent second opinion: what is sound, what is wrong, and what is missing, with evidence for every finding.
- `--stance critical` challenges the implementation and the design choices.
- Text after the flags is passed to the review as instructions.

Execution mode rules:
- If the raw arguments include `--wait` or `--background`, do not ask. Run the review with the arguments as given.
- Otherwise, estimate the review size before asking:
  - For a changes target, start with `git status --short --untracked-files=all`.
  - For a changes target, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For a base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - For a project target, recommend background unless `--path` names one or two files.
  - Recommend waiting only when the review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not add extra review instructions or rewrite the user's intent.
- Pass the arguments to the companion as one single-quoted argument, as in the command under Run. The companion splits that argument itself and keeps a double-quoted value such as `--path "docs/Release Notes.md"` as one value.
- If the arguments contain a single quote, write each one as `\'\''` inside the single quotes. The shell then passes `\'`, which the companion reads as a literal quote.
- When the user chose in the question, put the matching flag (`--wait` or `--background`) first inside the quotes, before the user's arguments, for example `review '--background $ARGUMENTS'`. The companion reads every word after a `--` as review instructions, so a flag added at the end would not count.
- The companion script parses `--wait` and `--background`. A background review is a tracked job that the script starts itself, so the `Bash` call is an ordinary foreground call in both cases.

Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review '$ARGUMENTS'
```

Foreground result:
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background result:
- The command prints the plugin's job id.
- Return that output, then tell the user: "Codex review started in the background. Run `/agent:status <job-id>` to check progress or `/agent:result <job-id>` for the output."
- Do not wait for the job in this turn.
