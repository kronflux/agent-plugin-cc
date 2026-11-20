---
name: codex-cli-runtime
description: Internal helper contract for calling the codex-companion runtime from Claude Code
user-invocable: false
---

# Codex Runtime

Use this skill only inside the `agent:codex-rescue` subagent.

Helpers:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --background --json [flags] -- "<task text>"` starts the job and prints JSON with its `jobId`.
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result <jobId> --wait --timeout-ms 540000` waits for the job and prints its result. It exits with code 75 while the job is still running; run it again until it exits with another code. Give each of these `Bash` calls a `timeout` of `600000`.

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to start one `task` in the background, wait for it with `result --wait`, and return the final `result` stdout unchanged. It never returns only a job ID.
- Prefer the helper over hand-rolled `git`, direct Codex CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `send`, or `cancel` from `agent:codex-rescue`. Call `result` only as `result <jobId> --wait`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `gpt-5-4-prompting` skill to rewrite the user's request into a tighter Codex prompt before the `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--effort` unset unless the user explicitly requests a specific effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Pass `--model` only when the user names a model, a family word, `default` or `configured`.
- Default to a write-capable Codex run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text. The `task` call itself always uses `--background`.
- If the forwarded request includes `--model`, pass it through to `task` unchanged.
- If the forwarded request includes `--effort`, pass it through to `task`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- If the forwarded request includes `--worktree`, strip that token from the task text and pass it through to `task`.
- If the forwarded request includes `--from-last-review`, strip that token from the task text and pass it through to `task`. The companion adds the newest review's findings to the prompt, so the request needs no other text.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. The companion rejects an effort the selected model does not support and prints the efforts it does.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:
- Default to write-capable Codex work in `agent:codex-rescue` unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, poll status, cancel jobs, summarize output, or do any follow-up work of your own. The only commands are the `task` call and the `result --wait` calls.
- Return the stdout of the final `result` command exactly as-is.
- If a call fails with any exit code other than 75, return its output, including stderr, exactly as-is and stop.
