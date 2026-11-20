---
name: council
description: 'Ask a read-only council (a Codex seat, an Antigravity seat and a Claude subagent) to review work or weigh a decision in two rounds, and report the merged findings'
argument-hint: '<question, or a brief file>'
---

# Council

A council is a panel of read-only seats from different families: by default one Claude subagent (the `agent:council-member` agent), one Codex job and one Antigravity job. Each seat answers the same brief through its own lens; in a second round each seat sees the other seats' findings without their names and validates, challenges or skips each one. A script merges the answers. You lead: you deliver prompts, check the findings and write the verdicts, but **the leader has no vote**.

All commands below are `node --disable-warning=ExperimentalWarning "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs" council <subcommand> ...`. Run each with `--json` and read its JSON.

## 1. Write the brief

Write a JSON file with exactly these keys:

```json
{ "question": "...", "targets": ["src/cache.mjs"], "kind": "review", "options": [], "claims": [ { "text": "...", "status": "observed" } ] }
```

- `kind` is `review` (findings about code or a document) or `decision` (a choice between `options`, two or more).
- `claims` are the premises you want checked, each `observed` or `assumed`.
- With no `--seat`, the council has the three default seats and lenses. To name seats, pass `--seat <family>:<lens>` for each (families `claude`, `codex`, `agy`; at most five seats, at most one Claude seat), and give opposing lenses to different families.

Run `council start --brief <file> --json`. It exits 1 when no quorum is possible (for example, when a provider CLI is missing and the seats left are from one family); report that message to the user and stop. A panel of one family is never called a council.

## 2. The loop

Repeat until the action is `done`:

1. Run `council status <run-id> --json`. It names one `action`, its `round`, the `deliveries` and the `clusters`.
2. For each delivery whose `intentId` you have not yet handed to an agent in this invocation, give its `promptFile` to that seat's `council-member` agent in the background. Use a new agent for the seat's first prompt; send later prompts to the same agent with `SendMessage`. After a restart of this skill, a new agent can take the complete prompt file. Deliver each `intentId` once. A repair prompt (after an invalid reply) or a retry prompt (after a missed deadline) arrives as a new delivery with a new `intentId`; send it to the same seat agent, and submit the reply with that new intent id.
3. When an agent replies, write its reply to a file and run `council submit <run-id> <seat> --intent <intentId> --file <reply> --json` with that exact intent id. Submit a reply that arrives after its deadline too; the helper decides whether it counts.
4. Then do the action:
   - `collect`: run `council collect <run-id> --round <N> --json` with the Bash tool's `run_in_background: true`, unless a collect is already running, and wait for the next notification (the collect finishing or an agent replying). A collect returns `wake` `closed`, `prompt` or `budget`; on any of them, go back to step 1.
   - `crossexam`: run `council crossexam <run-id> --json`. Claude's Round 2 prompt goes to the same seat agent.
   - `merge`: run `council merge <run-id> --json`.
   - `verify`: check each listed cluster yourself against the code or the source, then record `council verdict <run-id> <cluster-id> verified|rejected|not-checked [--strongest <n>] -- <reason>`. A rejected verdict needs a reason. On a verified disputed cluster, `--strongest <n>` names the strongest objection you rejected. Claims of the brief take a verdict the same way, by claim id (`a1`, `a2`, ...).
   - `report` or `report-failure`: run `council report <run-id>` and present `report.md` to the user.
   - `damaged`: tell the user which object is damaged (the digest in the status) and stop.
   - `done`: stop.

If a command reports that the job store is busy or unavailable, wait 5 seconds and run it again, at most three times, then report the error to the user.

## Rules

- The leader has no vote: never add your own findings to the merge. Your judgement goes into verdicts only.
- A disputed P1 finding that is neither verified nor rejected is a blocker for the user; say so.
- Run at most three councils in a row on one subject, and never widen the question between them. A fresh council on changed work is a new run.
- Seats stay read-only. Never ask a seat agent to edit anything.
