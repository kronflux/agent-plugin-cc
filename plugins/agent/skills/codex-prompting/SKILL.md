---
name: codex-prompting
description: Internal guidance for briefing a Codex delegate on coding, review, diagnosis, and research tasks inside the agent plugin
user-invocable: false
---

# Briefing a Codex delegate

Use this skill when `agent:codex-delegate` needs to tighten the user's request into a prompt for Codex.

A Codex delegate starts with none of this conversation. The prompt is its whole brief. Write it so a capable engineer who has only the repository and this text can finish the job and report back.

Principles:
- Goal as outcome. State the result that must be true when the work is done, not the steps to reach it. Say what done looks like so Codex does not have to guess the end state.
- Context by path. Point to the files, directories, commands, failing output, and prior findings that matter, by path or exact text. Do not paste whole files or restate what Codex can read for itself.
- Constraints. Name what must not change, what is out of scope, and what is risky: files to leave alone, interfaces to keep, behavior to preserve, and whether the run may write.
- Evidence to return. Ask for the proof that the outcome holds: the command that was run and its output, the file and line behind each claim, and what was not checked.
- Output shape. Name the sections, their order, and the length the reader needs. Keep the smallest shape that makes the answer easy to use.

Working rules:
- One clear task per run. Split unrelated asks into separate runs.
- Prefer a sharper brief over longer prose. Tighten the goal, constraints, and evidence request before asking for more effort.
- Keep claims anchored to observed evidence. If something is a hypothesis, say so.
- Say what to do when a detail is missing. A delegated run cannot pause to ask anything: Codex continues on the most reasonable reading and reports the assumption, or, when a wrong guess would be costly, stops and returns the blocking question as its final result.
- Ask for brief progress updates only when the task is long-running or tool-heavy.

Structure with blocks:
- Keep the prompt compact and use stable XML tags so it has a predictable structure.
- `<task>`: the concrete job and the relevant repository or failure context.
- `<structured_output_contract>` or `<compact_output_contract>`: exact shape, ordering, and brevity requirements.
- `<default_follow_through_policy>`: what Codex should do by default, since it cannot ask questions during the run.
- `<verification_loop>` or `<completeness_contract>`: for debugging, implementation, or risky fixes.
- `<grounding_rules>` or `<citation_rules>`: for review, research, or anything that could drift into unsupported claims.

When to add blocks:
- Coding or debugging: add `completeness_contract`, `verification_loop`, and `missing_context_gating`.
- Review or critical review: add `grounding_rules`, `structured_output_contract`, and `dig_deeper_nudge`.
- Research or recommendation tasks: add `research_mode` and `citation_rules`.
- Write-capable tasks: add `action_safety` so Codex stays narrow and avoids unrelated refactors.

How to choose the run:
- The delegate runs `task` only and never calls `review`. A review of local git changes is the separate `/agent:codex-review` command; when a delegated request asks for review-like analysis, brief it as a task with the Root-Cause Review recipe.
- Use `task` when the task is diagnosis, planning, research, or implementation and you need to control the prompt more directly.
- Diagnosis, review and research runs stay read-only: leave out `--write` unless the user asks for edits.
- A follow-up continues the job the user means. If the user names a thread, use `task --resume-thread <thread-id>`; if the user names a job, the follow-up belongs in `/agent:send <job-id> <message>`. Use `task --resume-last` only when the newest Codex task of this repository is the one the user means.
- In a follow-up, send only the new instruction instead of restating the whole prompt, unless the direction changed materially.

Prompt assembly checklist:
1. State the outcome and the scope in `<task>`.
2. List the paths and exact text Codex needs.
3. Name the constraints and whether the run may write.
4. Ask for the evidence that proves the outcome.
5. Choose the smallest output shape that makes the answer easy to use.
6. Add verification, grounding, and safety blocks only where the task needs them.
7. Remove redundant instructions before sending the prompt.

Reusable blocks live in [references/prompt-blocks.md](references/prompt-blocks.md).
Concrete end-to-end templates live in [references/codex-prompt-recipes.md](references/codex-prompt-recipes.md).
Common failure modes to avoid live in [references/codex-prompt-antipatterns.md](references/codex-prompt-antipatterns.md).
