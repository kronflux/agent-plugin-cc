---
name: council
description: 'Ask a read-only council (a Codex seat, an Antigravity seat and a Claude subagent) to review work, weigh a decision, or answer a question in two rounds, and report the merged result'
argument-hint: '<question, or a brief file>'
---

# Council

A council is a panel of read-only seats from different families: by default one Claude subagent (the `agent:council-member` agent), one Codex job and one Antigravity job. Each seat answers the same brief through its own lens; in a second round each seat sees the other seats' findings (and, on a question or open council, their answers) without their names and validates, challenges or skips each finding. A script merges the answers. You lead: you deliver prompts, check the findings and write the verdicts, but **the leader has no vote**.

All commands below are `node --disable-warning=ExperimentalWarning "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs" council <subcommand> ...`. Run each with `--json` and read its JSON.

## 1. Write the brief

Write a JSON file with exactly these keys:

```json
{ "question": "...", "targets": ["src/cache.mjs"], "kind": "review", "options": [], "claims": [ { "text": "...", "status": "observed" } ] }
```

- `kind` picks the mode. Choose it from what the user needs:
  - `review`: there are files or a document to judge. The seats report findings.
  - `decision`: you can write the choices yourself. Put two or more in `options`; each seat votes for one.
  - `question`: the question has a best answer, but you cannot list the choices. Each seat answers in its own words (at most 500 characters); in Round 2 each seat marks which answers say the same thing and endorses one. Answers marked as the same become one option, and the seats' endorsements are the vote. Leave `options` empty.
  - `open`: a matter of judgement, where a vote would mislead. Each seat answers in its own words and, in Round 2, says which answers it agrees with. There is no vote: you judge how far the answers agree. Leave `options` empty.
- `targets` is optional; a question or open council often has none. Every mode works in a folder that is not a git repository.
- `claims` are the premises you want checked, each `observed` or `assumed`.
- With no `--seat`, the council has the three default seats and lenses. To name seats, pass `--seat <family>:<lens>` for each (families `claude`, `codex`, `agy`; at most five seats, at most one Claude seat), and give opposing lenses to different families.

Run `council start --brief <file> --json`. It exits 1 when no quorum is possible (for example, when a provider CLI is missing and the seats left are from one family); report that message to the user and stop. A panel of one family is never called a council.

## 2. The loop

Repeat until the action is `done`:

1. Run `council status <run-id> --json`. It names one `action`, its `round`, the `deliveries` and the `clusters`.
2. For each delivery whose `intentId` you have not yet handed to an agent in this invocation, give its `promptFile` to that seat's `council-member` agent in the background. Use a new agent for the seat's first prompt; send later prompts to the same agent with `SendMessage`. After a restart of this skill, a new agent can take the complete prompt file. Deliver each `intentId` once. A repair prompt (after an invalid reply) or a retry prompt (after a missed deadline) arrives as a new delivery with a new `intentId`; send it to the same seat agent, and submit the reply with that new intent id.
   A delivery with an `actor` is a Claude stand-in prompt: the seat ended the round without a valid answer, and a stand-in answers in its place, through its lens. Give its `promptFile` to a new `council-member` agent of its own, never to the agent of another seat (also not to the Claude seat's agent). A stand-in prompt in Round 2 whose `actor` ends in `~r1` is a carry: send it with `SendMessage` to the agent that answered that actor's Round 1 prompt, or to a new agent after a restart. Submit its reply like any other, with its seat and its own intent id.
   A delivery with `kind` `notice` is a cutoff notice: the other seats have answered, and the seat has five minutes left. Send its `text` once to that seat's agent with `SendMessage`; a notice with an `actor` goes to the agent of that carried stand-in. It needs no reply and no `submit`. A notice is handed only once, by whichever of `status`, `collect` or `submit` sees it first, so act on it in the output where it appears.
   A delivery with `kind` `followup` is a follow-up question; deliver it as "Follow-up questions" below says.
3. When an agent replies, write its reply to a file and run `council submit <run-id> <seat> --intent <intentId> --file <reply> --json` with that exact intent id. When the delivery has a `round` (a stand-in, a carry or a follow-up), add `--round <round>`; the helper then refuses an intent of another round. Submit a reply that arrives after its deadline too; the helper decides whether it counts.
4. Then do the action:
   - `collect`: run `council collect <run-id> --round <N> --json` with the Bash tool's `run_in_background: true`, unless a collect is already running, and wait for the next notification (the collect finishing or an agent replying). A collect returns `wake` `closed`, `prompt`, `notice` or `budget`; deliver any notice in its `deliveries` (step 2), then go back to step 1. A plain collect lets a Claude stand-in answer for a seat that failed the round; this is the default. Add `--disallow-substitute` to every collect only when the user asked for no stand-ins; the round then closes without them. When `status` lists `substitutionCandidates`, the next plain collect asks their stand-ins.
   - `crossexam`: run `council crossexam <run-id> --json`. Claude's Round 2 prompt goes to the same seat agent.
   - `merge`: run `council merge <run-id> --json`.
   - `verify`: check each listed cluster yourself against the code or the source, then record `council verdict <run-id> <cluster-id> verified|rejected|not-checked [--strongest <n>] -- <reason>`. A rejected verdict needs a reason. On a verified disputed cluster, `--strongest <n>` names the strongest objection you rejected. Claims of the brief take a verdict the same way, by claim id (`a1`, `a2`, ...).
   - `agree` (open councils only): read every answer in the merge (`answers`) and the seats' `agreesWith` marks, judge how far the answers agree, and record `council verdict <run-id> agreement agreed|partly|disagreed -- <reason>`. The reason is required; say what the answers share and where they differ. The report shows it as `Agreement (leader judgement): <value>`.
   - `report`: if `unanimous` in the status is `true`, first write the counterargument ("Counterargument when every seat agreed" below). Then run `council report <run-id>` and present `report.md` to the user.
   - `report-failure`: run `council report <run-id>` and present `report.md` to the user.
   - `damaged`: tell the user which object is damaged (the digest in the status) and stop.
   - `done`: stop.

If a command reports that the job store is busy or unavailable, wait 5 seconds and run it again, at most three times, then report the error to the user.

## Counterargument when every seat agreed

`council status` (and `council merge`) shows `unanimous: true` when every seat agreed: every seat validated every other seat's findings, no seat challenged, skipped or added a finding, and on a decision every seat chose the same option. On a question council it is `true` when every seat's vote falls in one option and no seat challenged or added a finding. An open council is never `unanimous`; your agreement verdict takes its place. Then, before you present the report:

1. Write the strongest counterargument to the agreed result yourself.
2. Check it against the code or the source.
3. In the message that presents the report, state it under the heading `Counterargument (leader)`, with your assessment: whether it holds or does not hold, and why.

The report then says `Unanimous panel: the leader adds a counterargument.`, so the user sees why the section appears. You still have no vote: the counterargument is not a finding, and you never add it to the merge.

## Follow-up questions

After Round 2 closed with a quorum and the merge is current, you can ask one seat one question about one merged finding, or about its stance on a decision. Offer a follow-up when the user asks for one, or when a disputed finding turns on a fact that one seat can supply. Each seat answers at most two follow-ups and the run at most six; a follow-up that fails or runs out of time still counts.

1. Run `council followup <run-id> <seat> --finding <cluster-id> --json -- <question>`. To ask about the seat's stance on a decision, use `--finding stance`. If it refuses (for example `stale-merge` or `seat-followup-limit`), tell the user its message; after `stale-merge`, run `council merge` and ask again.
2. For a Codex or Antigravity seat, the seat's job continues with the question. Run `council collect <run-id> --round 2 --json` with `run_in_background: true` and wait until it returns `wake` `closed`.
3. For the Claude seat or a seat a stand-in answered, the output's `deliveries` holds a delivery with `kind` `followup`. Send its `promptFile` with `SendMessage` to the agent that gave the Round 2 answer of its `actor` (the Claude seat's agent, or the stand-in's agent); after a restart, give it to a new `council-member` agent, because the prompt is complete. Write the agent's reply to a file and run `council submit <run-id> <seat> --intent <intentId> --file <reply> --json`.
4. An answer changes the council's inputs. Run `council merge <run-id>` again, record the verdicts again, and run `council report <run-id>` again. While a follow-up is open, `council report` refuses with `followup-open-report`, and `council status` names `collect` for round 2.

The report lists each question under `## Follow-ups` with the seat, the finding and the answer, or the reason it has none. On a decision, a valid `stance` in the answer replaces that seat's vote. `--finding stance` is for a decision only; on a question or open council, ask about a merged finding.

## Answers and options

On a question or open council the merge lists every seat's answer under `answers`, labelled `A`, `B`, ... in seat order; the report shows them under `## Answers`. On a question council the merge also lists `options` (answers the seats marked as the same, each named after its first answer) and the vote in `decision`: the choice is the option with at least two thirds of the seats, and a seat without a valid Round 2 answer counts against it. The report shows the options under `## Options`. On an open council each answer lists the seats that agreed with it.

## Rules

- The leader has no vote: never add your own findings to the merge. Your judgement goes into verdicts only.
- A disputed P1 finding that is neither verified nor rejected is a blocker for the user; say so.
- A stand-in is Claude, the leader's own family: it adds an answer, never a family, so it cannot give a council its quorum. When you present the report, say which seats a stand-in answered for.
- Run at most three councils in a row on one subject, and never widen the question between them. A fresh council on changed work is a new run.
- Seats stay read-only. Never ask a seat agent to edit anything.
