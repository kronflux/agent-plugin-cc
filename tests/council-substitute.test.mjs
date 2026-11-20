// The Claude stand-in for a failed council seat: the extension lifecycle, the substitution
// decision and its batch, the carry into Round 2 and the effective panel, on real store
// transactions with the test wall clock and fake provider jobs.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { installObject, readObject } from "../plugins/agent/scripts/lib/council/objects.mjs";
import { depositExtensionReceipt, depositSubstitutionOptIn } from "../plugins/agent/scripts/lib/council/extensions.mjs";
import { mergeCouncil } from "../plugins/agent/scripts/lib/council/merge.mjs";
import { effectivePanel, extensionRows, lifecycleWrites, quorumFamilies } from "../plugins/agent/scripts/lib/council/reduce-ext.mjs";
import { COUNCIL_EXTENSIONS, readCouncil, reduceRun } from "../plugins/agent/scripts/lib/council/state.mjs";
import { resolveStateDir } from "../plugins/agent/scripts/lib/state.mjs";
import { openStore } from "../plugins/agent/scripts/lib/store.mjs";
import { handleCouncil, renderCouncilReport, renderFailedReport } from "../plugins/agent/scripts/commands/council.mjs";
import { makeTempDir } from "./helpers.mjs";
import { EPOCH, bindAttempt, observe, openCouncilStore, receive, seatJobFields, seedRun, setJob, useTestClock } from "./council-helpers.mjs";

const hex = (character) => character.repeat(64);
const ON = { substitution: true };
const DEADLINE = () => performance.now() + 10000;

function reduceWith(store, { round = 1, extensions = ON, consent = null, prepared = {}, layer = 2 } = {}) {
  return reduceRun(store, { runId: "run-1", round, layer, extensions, consent, prepared, deadline: DEADLINE() });
}

const snapshot = (store) => readCouncil(store, "run-1");
const roundOf = (store, round = 1) => snapshot(store).rounds.find((row) => row.round === round);
const seatState = (store, seat, round = 1) => snapshot(store).seatRounds.find((row) => row.round === round && row.seat === seat);
const turnsOf = (store, round = 1) => snapshot(store).ext.turns.filter((turn) => turn.round === round);
const eventOf = (store, turnId, kind) => snapshot(store).ext.events.find((event) => event.turn_id === turnId && event.kind === kind) ?? null;
const decisionOf = (store, round = 1) => snapshot(store).ext.decisions.find((row) => row.kind === "substitution" && row.scope === round)?.decision ?? null;

// A seeded three-seat run (s1 Claude, s2 Codex, s3 Antigravity, T = 1000) where at 100 s1 and s3
// answered valid and s2's job failed for good: Round 1 is settled, with s2 the only candidate.
async function settledWithFailedCodex(t, clock, { runId = "run-1" } = {}) {
  const { store, runDir } = openCouncilStore(t);
  clock.set(0);
  const { seats } = await seedRun(store, runDir, { runId, layer: 2 });
  const ids = Object.fromEntries(seats.map((seat) => [seat.seat, seat.attemptId]));
  clock.set(100);
  const job2 = bindAttempt(store, ids.s2).jobId;
  const job3 = bindAttempt(store, ids.s3, { provider: "agy" }).jobId;
  setJob(store, job2, { claimed_at: EPOCH + 50, started_at: EPOCH + 50, end_at: EPOCH + 100, exec_released_at: EPOCH + 100, release_kind: "confirmed", end_state: "failed", error: "permission denied" });
  setJob(store, job3, { claimed_at: EPOCH + 50, started_at: EPOCH + 50, end_at: EPOCH + 100, exec_released_at: EPOCH + 100, release_kind: "confirmed", end_state: "completed" });
  assert.deepEqual(await receive(store, "run-1", "s1", ids.s1, { outcome: "valid", answerSha256: hex("1") }, 2), { ok: true, round: 1 });
  assert.deepEqual(await observe(store, ids.s2, job2, { outcome: "failure", eventAt: EPOCH + 100, reason: "provider failure" }, 2), { ok: true });
  assert.deepEqual(await observe(store, ids.s3, job3, { outcome: "valid", eventAt: EPOCH + 100, answerSha256: hex("3") }, 2), { ok: true });
  return { store, runDir: runDir(runId), ids };
}

test("the shipped extensions turn substitution on and leave follow-ups and the challenge off", () => {
  assert.deepEqual({ ...COUNCIL_EXTENSIONS }, { followups: false, substitution: true, challenge: false });
});

test("an extension turn settles once by X1 to X4, and a carry at a due cutoff by S3", () => {
  const turn = (id, extra = {}) => ({ id: id.repeat(32), seat: "s2", kind: "substitute", round: 1, created_at: 100, issue_by: 1100, ...extra });
  const turns = [turn("a"), turn("b"), turn("c"), turn("d"), turn("e", { kind: "carry", round: 2 }), turn("f")];
  const events = [
    { turn_id: "a".repeat(32), kind: "refusal", at: 105, reason: "predecessor missing" },
    { turn_id: "c".repeat(32), kind: "issue", at: 100, job_id: null },
    { turn_id: "c".repeat(32), kind: "deposit", at: 1099, event_at: 1099, code: "valid", digest: hex("c"), after_close: 0 },
    { turn_id: "d".repeat(32), kind: "issue", at: 100, job_id: null },
    { turn_id: "e".repeat(32), kind: "issue", at: 100, job_id: null },
    { turn_id: "f".repeat(32), kind: "issue", at: 100, job_id: null },
    { turn_id: "f".repeat(32), kind: "finish", at: 200, code: "invalid", reason: "schema validation failed" }
  ];
  const outcome = (writes) => writes.map((write) => [write.turnId[0], write.state, write.reason]);
  // Before any bound: the refusal (X1) and the timely deposit (X3) settle; the rest wait.
  assert.deepEqual(outcome(lifecycleWrites(turns, events, { t: 1050 })), [
    ["a", "error", "predecessor missing"],
    ["c", "valid", null]
  ]);
  // At the bound: the reserved turn expires (X2), the silent turn times out (X4), and a timely
  // deposit still wins after its expiry wake; a finished turn gets nothing more.
  assert.deepEqual(outcome(lifecycleWrites(turns, events, { t: 1100 })), [
    ["a", "error", "predecessor missing"],
    ["b", "error", "issuance deadline expired"],
    ["c", "valid", null],
    ["d", "timed-out", "reply deadline expired"],
    ["e", "timed-out", "reply deadline expired"]
  ]);
  // At a due cutoff before its own bound, an unanswered carry ends at the cutoff (S3).
  assert.deepEqual(outcome(lifecycleWrites([turns[4]], events, { t: 600, cutoffAt: 600 })), [["e", "timed-out", "quorum cutoff"]]);
});

test("a failed seat holds the round until a collect decides, and an opt-in issues one stand-in with the prepared prompt", async (t) => {
  const clock = useTestClock(t, 0);
  const { store, runDir } = await settledWithFailedCodex(t, clock);
  // Without a decision, every original seat being final does not close the round.
  assert.deepEqual(await reduceWith(store), { ok: true, changed: true, closed: false });
  assert.deepEqual([seatState(store, "s2").state, roundOf(store).closed_at, decisionOf(store), turnsOf(store)], ["error", null, null, []]);
  // With substitution off, the same round closes at once (the collection contract).
  {
    const other = await settledWithFailedCodex(t, clock);
    assert.deepEqual(await reduceRun(other.store, { runId: "run-1", round: 1, layer: 2, deadline: DEADLINE() }), { ok: true, changed: true, closed: true });
  }
  // An opt-in with no prepared prompt still holds.
  clock.set(200);
  assert.deepEqual(await depositSubstitutionOptIn(store, { runId: "run-1", round: 1, deadline: DEADLINE() }), { ok: true, deposited: true });
  assert.deepEqual(await depositSubstitutionOptIn(store, { runId: "run-1", round: 1, deadline: DEADLINE() }), { ok: true, deposited: false });
  assert.deepEqual(await reduceWith(store), { ok: true, changed: false, closed: false });
  // With the prompt prepared: `accept` and one issued substitute turn for s2, bound t + T.
  const prompt = installObject(runDir, "Stand-in prompt for s2\n", "md");
  assert.deepEqual(await reduceWith(store, { prepared: { s2: prompt } }), { ok: true, changed: true, closed: false });
  assert.equal(decisionOf(store), "accept");
  const [turn] = turnsOf(store);
  assert.deepEqual([turn.seat, turn.kind, turn.round, turn.prompt_sha256, turn.created_at - EPOCH, turn.issue_by - EPOCH], ["s2", "substitute", 1, prompt, 200, 1200]);
  assert.equal(eventOf(store, turn.id, "issue").at - EPOCH, 200);
  assert.equal(snapshot(store).ext.issued.total, 1);
  // The opt-in request has its result.
  assert.deepEqual(snapshot(store).ext.requests.map((row) => JSON.parse(row.result)), [{ decision: "accept" }]);
  // The stand-in's valid answer closes the round with quorum; the original seat stays `error`.
  clock.set(300);
  assert.deepEqual(await depositExtensionReceipt(store, { runId: "run-1", seat: "s2", intentId: turn.id, verdict: { outcome: "valid", answerSha256: hex("9") }, deadline: DEADLINE() }), { ok: true, round: 1 });
  assert.deepEqual(
    await depositExtensionReceipt(store, { runId: "run-1", seat: "s2", intentId: turn.id, verdict: { outcome: "valid", answerSha256: hex("9") }, deadline: DEADLINE() }),
    { ok: false, reason: "duplicate-receipt", round: 1 }
  );
  const revision = snapshot(store).run.input_rev;
  assert.deepEqual(await reduceWith(store), { ok: true, changed: true, closed: true });
  assert.deepEqual([eventOf(store, turn.id, "finish").code, roundOf(store).quorum, seatState(store, "s2").state], ["valid", 1, "error"]);
  // One revision for the valid extension finish and one for the closure.
  assert.equal(snapshot(store).run.input_rev, revision + 2);
  const panel = effectivePanel(snapshot(store), 1);
  assert.deepEqual(
    panel.map((entry) => [entry.seat, entry.actor, entry.kind, entry.family, entry.quorumFamily, entry.valid]),
    [
      ["s1", "s1", "original", "claude", "claude", true],
      ["s2", "s2~r1", "substitute", "claude", null, true],
      ["s3", "s3", "original", "agy", "agy", true]
    ]
  );
  assert.deepEqual(quorumFamilies(panel), ["agy", "claude"]);
  assert.deepEqual(snapshot(store).actorAnswers, { "s2~r1": hex("9") });
});

test("a declining collect closes the round with no stand-in, and a later opt-in cannot reopen it", async (t) => {
  const clock = useTestClock(t, 0);
  const { store, runDir } = await settledWithFailedCodex(t, clock);
  const prompt = installObject(runDir, "Stand-in prompt for s2\n", "md");
  assert.deepEqual(await reduceWith(store, { consent: "disallow", prepared: { s2: prompt } }), { ok: true, changed: true, closed: true });
  assert.deepEqual([decisionOf(store), turnsOf(store), roundOf(store).quorum], ["decline", [], 1]);
  assert.deepEqual(await depositSubstitutionOptIn(store, { runId: "run-1", round: 1, deadline: DEADLINE() }), { ok: true, deposited: false });
  assert.deepEqual(await reduceWith(store, { prepared: { s2: prompt } }), { ok: true, changed: false, closed: true });
  assert.deepEqual(turnsOf(store), []);
});

test("an opt-in already deposited wins over a later declining collect", async (t) => {
  const clock = useTestClock(t, 0);
  const { store, runDir } = await settledWithFailedCodex(t, clock);
  assert.equal((await depositSubstitutionOptIn(store, { runId: "run-1", round: 1, deadline: DEADLINE() })).deposited, true);
  const prompt = installObject(runDir, "Stand-in prompt for s2\n", "md");
  assert.deepEqual(await reduceWith(store, { consent: "disallow", prepared: { s2: prompt } }), { ok: true, changed: true, closed: false });
  assert.equal(decisionOf(store), "accept");
});

test("a stand-in that answers invalidly or stays silent settles once, with no second stand-in", async (t) => {
  const clock = useTestClock(t, 0);
  for (const silent of [false, true]) {
    const { store, runDir } = await settledWithFailedCodex(t, clock);
    clock.set(200);
    await depositSubstitutionOptIn(store, { runId: "run-1", round: 1, deadline: DEADLINE() });
    const prompt = installObject(runDir, "Stand-in prompt for s2\n", "md");
    await reduceWith(store, { prepared: { s2: prompt } });
    const [turn] = turnsOf(store);
    if (silent) {
      clock.set(1199);
      assert.deepEqual(await reduceWith(store, { prepared: { s2: prompt } }), { ok: true, changed: false, closed: false });
      clock.set(1200);
    } else {
      clock.set(300);
      const errorsSha256 = installObject(runDir, '["answer: required property is missing"]\n', "json");
      assert.equal((await depositExtensionReceipt(store, { runId: "run-1", seat: "s2", intentId: turn.id, verdict: { outcome: "invalid", errorsSha256, reason: "schema validation failed" }, deadline: DEADLINE() })).ok, true);
    }
    assert.deepEqual(await reduceWith(store, { prepared: { s2: prompt } }), { ok: true, changed: true, closed: true });
    const finish = eventOf(store, turn.id, "finish");
    assert.deepEqual([finish.code, finish.reason], silent ? ["timed-out", "reply deadline expired"] : ["invalid", "schema validation failed"]);
    assert.equal(turnsOf(store).length, 1);
    assert.equal(roundOf(store).quorum, 1);
    // A late receipt is refused.
    assert.equal((await depositExtensionReceipt(store, { runId: "run-1", seat: "s2", intentId: turn.id, verdict: { outcome: "valid", answerSha256: hex("9") }, deadline: DEADLINE() })).ok, false);
  }
});

test("the capacity decision applies when the batch cannot fit the member-turn cap, and the round closes", () => {
  const seatRounds = [
    { seat: "s1", state: "valid" },
    { seat: "s2", state: "error" },
    { seat: "s3", state: "valid" }
  ];
  const states = new Map(seatRounds.map((row) => [row.seat, row.state]));
  const ext = (used) => ({ enabled: true, turns: [], events: [], decision: null, optIn: true, consent: null, prepared: { s2: hex("2") }, freshTurnIds: ["a".repeat(32)], used, cap: 12, timeoutMs: 1000 });
  // Round 1 holds a future Round 2 slot for each seat that can reach it: 8 + 1 + 3 fits 12.
  assert.deepEqual(
    extensionRows(ext(8), { t: 100, round: 1, states, seatRounds }).writes.map((write) => write.op + (write.decision ? `:${write.decision}` : "")),
    ["ext-decision:accept", "ext-turn"]
  );
  // Injected extension issues leave no room: `capacity`, no turn, and the round may close.
  const full = extensionRows(ext(9), { t: 100, round: 1, states, seatRounds });
  assert.deepEqual([full.writes, full.close], [[{ op: "ext-decision", round: 1, decision: "capacity" }], true]);
  // Round 2 holds nothing further.
  assert.deepEqual(extensionRows(ext(11), { t: 100, round: 2, states, seatRounds }).writes.map((write) => write.op), ["ext-decision", "ext-turn"]);
});

test("the merge counts one vote per effective seat, gives a stand-in's findings and responses the family claude, and never lets a seat validate its own findings", () => {
  const finding = (id, claim) => ({ id, severity: "P2", claim, path: "src/a.mjs", line: 1, evidence: "e" });
  const response = (ref, extra = {}) => ({ finding: ref, response: "validate", disputes: null, sameAs: null, reason: null, evidence: null, ...extra });
  const merge = mergeCouncil({
    runId: "run-1",
    kind: "decision",
    options: ["A", "B"],
    seats: [
      { seat: "s1", family: "claude" },
      { seat: "s2", family: "codex", round1Family: "claude", round2Family: "claude", quorumFamily: null, round2Key: null },
      { seat: "s3", family: "agy", round1Family: "agy", round2Family: "claude", quorumFamily: null, round2Key: "s3~r2" }
    ],
    round1: { s1: { findings: [finding("f1", "alpha")] }, s2: { findings: [finding("f1", "bravo")] }, s3: { findings: [finding("f1", "charlie")] } },
    round2: {
      s1: { stance: "A", responses: [response("A-f1"), response("B-f1")], added: [] },
      s2: { stance: "A", responses: [response("A-f1"), response("B-f1")], added: [] },
      // A forged map entry would let s3's fresh stand-in validate s3's own finding: not counted.
      s3: { stance: "B", responses: [response("A-f1"), response("B-f1"), response("C-f1")], added: [finding("f1", "delta")] }
    },
    anonymisation: { s1: { A: "s2", B: "s3" }, s2: { A: "s1", B: "s3" }, s3: { A: "s1", B: "s2", C: "s3" } },
    turns: { used: 8, repairs: 0, retries: 0 }
  });
  assert.deepEqual(merge.decision.tally, { A: 2, B: 1 });
  assert.deepEqual(merge.quorum, { validSeats: 3, families: ["claude"] });
  const byClaim = Object.fromEntries(merge.clusters.map((cluster) => [cluster.claim, cluster]));
  // bravo was written by s2's Round 1 stand-in: reported by claude; s1 (claude) cannot cross-validate it, s3's stand-in neither.
  assert.deepEqual([byClaim.bravo.reportedBy, byClaim.bravo.validatedBy], [["claude"], []]);
  // charlie (agy) is validated by claude, through s1 and the stand-ins, never by s3 itself.
  assert.deepEqual([byClaim.charlie.reportedBy, byClaim.charlie.validatedBy, byClaim.charlie.findings], [["agy"], ["claude"], ["s3-f1"]]);
  // The fresh stand-in's added finding is keyed by its actor and authored by claude.
  assert.deepEqual([byClaim.delta.findings, byClaim.delta.reportedBy], [["s3~r2-f1"], ["claude"]]);
});

// ---------------------------------------------------------------------------------------------
// The council commands with substitution on (the shipped default).

const T_LONG = 1000000;
const iso = (at) => new Date(EPOCH + at).toISOString();

function r1Answer(claim) {
  return JSON.stringify({
    schema: 1,
    stance: null,
    confidence: "high",
    dealbreaker: null,
    findings: [{ id: "f1", severity: "P2", claim, path: "src/a.mjs", line: 1, evidence: `${claim} evidence` }],
    assumptions: [],
    wouldChangeMind: "a failing test"
  });
}

// A Round 2 answer that validates every finding of a letter map (each author has one finding f1).
function r2Answer(letterMap) {
  const responses = Object.keys(letterMap)
    .sort()
    .map((letter) => ({ finding: `${letter}-f1`, response: "validate", disputes: null, sameAs: null, reason: null, evidence: null }));
  return JSON.stringify({ schema: 1, stance: null, responses, added: [] });
}

// A fake monotonic clock and wait clock: `sleep(ms)` moves `now` on; the wall clock stays.
function fakeTime(start = Math.round(performance.now())) {
  const state = { now: start };
  return {
    now: () => state.now,
    sleep: (ms) => {
      state.now += ms;
      return new Promise((resolve) => setImmediate(resolve));
    }
  };
}

// Runs one council subcommand in this process at layer 2 with the shipped extensions unless
// given, fake provider checks, a job builder that keeps the prompt, no launch and no usage evidence.
async function council(argv, { cwd, extensions = undefined, advance = {} }) {
  const out = [];
  const err = [];
  const time = fakeTime();
  const code = await handleCouncil([argv[0], "--cwd", cwd, ...argv.slice(1)], {
    layer: 2,
    ...(extensions ? { extensions } : {}),
    io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
    readRequester: async () => ({ sessionId: "session-1", leaderPid: null, leaderStartToken: null }),
    checkProviders: async (ids) => ids.map((id) => ({ id, ok: true })),
    advance: {
      reconcile: async () => {},
      launch: async () => null,
      readUsage: async () => null,
      buildJob: async ({ family, label, prompt }) => ({ fields: seatJobFields(family === "codex" ? "codex" : "agy", { prompt }), label }),
      now: time.now,
      sleep: time.sleep,
      ...advance
    }
  });
  const stdout = out.join("");
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = null;
  }
  return { code, stdout, stderr: err.join(""), json };
}

// A council started at wall 0 through `council start`: s1 Claude, s2 Codex, s3 Antigravity, and
// with `fourth` an s4 Codex seat; the provider jobs stay queued until a test ends them.
async function started(t, clock, { fourth = false } = {}) {
  clock.set(0);
  const cwd = makeTempDir(t);
  const stateDir = resolveStateDir(cwd);
  const store = openStore(stateDir);
  t.after(() => store.close());
  const brief = path.join(cwd, "brief.json");
  fs.writeFileSync(brief, JSON.stringify({ question: "Is the cache correct?", targets: ["src"], kind: "review" }));
  const seats = fourth ? ["--seat", "claude:correctness", "--seat", "codex:security", "--seat", "agy:maintainability", "--seat", "codex:cost"] : [];
  const result = await council(["start", "--brief", brief, ...seats, "--timeout-ms", String(T_LONG), "--json"], { cwd });
  assert.equal(result.code, 0, result.stderr);
  return { cwd, store, runId: result.json.runId, dir: path.join(stateDir, "council", result.json.runId) };
}

const snap = (fx) => readCouncil(fx.store, fx.runId);
const seatRow = (fx, seat, round = 1) => snap(fx).seatRounds.find((row) => row.round === round && row.seat === seat);
const roundRow = (fx, round = 1) => snap(fx).rounds.find((row) => row.round === round);
const currentOf = (fx, seat, round = 1) => snap(fx).attempts.find((row) => row.id === seatRow(fx, seat, round).current_id);
const promptText = (delivery) => fs.readFileSync(delivery.promptFile, "utf8");
const mapOf = (fx) => JSON.parse(readObject(fx.dir, roundRow(fx, 2).map_sha256, "json").toString("utf8"));

function endJob(fx, jobId, at, columns) {
  setJob(fx.store, jobId, { claimed_at: EPOCH + at - 5, started_at: EPOCH + at - 5, end_at: EPOCH + at, exec_released_at: EPOCH + at, release_kind: "confirmed", thread_id: `thread-${jobId}`, ...columns });
}
const completeJob = (fx, jobId, at, resultJson) => endJob(fx, jobId, at, { end_state: "completed", result_json: resultJson });
const failJob = (fx, jobId, at) => endJob(fx, jobId, at, { end_state: "failed", error: "permission denied" });

async function submit(fx, seat, intentId, text) {
  const file = path.join(fx.cwd, `reply-${intentId}.json`);
  fs.writeFileSync(file, text);
  return council(["submit", fx.runId, seat, "--intent", intentId, "--file", file, "--json"], { cwd: fx.cwd });
}

function collect(fx, { round = 1, flags = [], budgetMs = 120000, extensions = undefined } = {}) {
  return council(["collect", fx.runId, "--round", String(round), ...flags, "--budget-ms", String(budgetMs), "--json"], { cwd: fx.cwd, extensions });
}

// A started three-seat council where at 100 s1 (Claude) and s3 (Antigravity) answered valid and
// s2's Codex job failed for good; nothing has observed s2 yet.
async function codexFailedAt100(t, clock) {
  const fx = await started(t, clock);
  clock.set(100);
  failJob(fx, currentOf(fx, "s2").job_id, 100);
  completeJob(fx, currentOf(fx, "s3").job_id, 100, r1Answer("charlie"));
  const accepted = await submit(fx, "s1", currentOf(fx, "s1").id, r1Answer("alpha"));
  assert.equal(accepted.code, 0, accepted.stderr);
  return fx;
}

test("a plain collect asks one stand-in for the failed Codex seat's lens, and its answer makes three valid seats from two families", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await codexFailedAt100(t, clock);
  const woke = await collect(fx);
  assert.equal(woke.code, 0, woke.stderr);
  assert.equal(woke.json.wake, "prompt", woke.stdout);
  const standIn = woke.json.deliveries.find((delivery) => delivery.actor);
  assert.deepEqual([standIn.seat, standIn.round, standIn.actor, standIn.deadline], ["s2", 1, "s2~r1", iso(100 + T_LONG)]);
  assert.match(promptText(standIn), /in place of a council member/);
  assert.match(promptText(standIn), /Your lens: security/);
  assert.deepEqual(
    woke.json.substitutions.map((entry) => [entry.seat, entry.round, entry.actor, entry.kind, entry.family, entry.model, entry.lens, entry.state, entry.intentId]),
    [["s2", 1, "s2~r1", "substitute", "claude", "opus", "security", "issued", standIn.intentId]]
  );
  assert.deepEqual([seatRow(fx, "s2").state, seatRow(fx, "s2").reason, roundRow(fx).closed_at], ["error", "provider failure", null]);
  // Status shows the open stand-in prompt as a delivery for a new seat agent.
  const status = await council(["status", fx.runId], { cwd: fx.cwd });
  assert.match(status.stdout, /Prompt for s2 \(stand-in s2~r1, a fresh council-member agent/);
  // The stand-in's valid answer closes Round 1 with quorum.
  clock.set(200);
  const accepted = await submit(fx, "s2", standIn.intentId, r1Answer("bravo"));
  assert.deepEqual([accepted.code, accepted.json.state, accepted.json.actor], [0, "valid", "s2~r1"], accepted.stderr);
  const closed = await collect(fx);
  assert.equal(closed.code, 0, closed.stdout);
  assert.deepEqual(
    [closed.json.wake, closed.json.quorum, closed.json.validSeats, closed.json.validFamilies, closed.json.families, closed.json.memberTurns],
    ["closed", true, 3, 2, ["claude", "agy"], 4]
  );
  assert.deepEqual([closed.json.substitutionDecision, closed.json.substitutionOptIn, closed.json.substitutions[0].state], ["accept", true, "valid"]);
  // The original seat keeps its own outcome.
  assert.deepEqual(closed.json.seats.find((seat) => seat.seat === "s2").state, "error");
});

test("a collect with --disallow-substitute closes with two valid seats and no stand-in, and a later plain collect cannot reopen it", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await codexFailedAt100(t, clock);
  const declined = await collect(fx, { flags: ["--disallow-substitute"] });
  assert.equal(declined.code, 0, declined.stdout);
  assert.deepEqual(
    [declined.json.wake, declined.json.quorum, declined.json.validSeats, declined.json.substitutionDecision, declined.json.substitutionOptIn, declined.json.substitutions],
    ["closed", true, 2, "decline", false, []]
  );
  const again = await collect(fx);
  assert.deepEqual([again.code, again.json.wake, again.json.validSeats, again.json.substitutionDecision, again.json.substitutionOptIn], [0, "closed", 2, "decline", false]);
  assert.deepEqual(snap(fx).ext.turns, []);
});

test("a collect with substitution off ignores --disallow-substitute and closes the round at once", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await codexFailedAt100(t, clock);
  const closed = await collect(fx, { flags: ["--disallow-substitute"], extensions: { substitution: false } });
  assert.deepEqual([closed.code, closed.json.wake, closed.json.validSeats, closed.json.substitutions], [0, "closed", 2, undefined]);
  assert.deepEqual([snap(fx).ext.decisions, snap(fx).ext.requests], [[], []]);
});

test("with only one original family valid the stand-ins are still asked, the round fails with No quorum, and the failed report lists their answers", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await started(t, clock);
  clock.set(100);
  failJob(fx, currentOf(fx, "s2").job_id, 100);
  failJob(fx, currentOf(fx, "s3").job_id, 100);
  assert.equal((await submit(fx, "s1", currentOf(fx, "s1").id, r1Answer("alpha"))).code, 0);
  const woke = await collect(fx);
  assert.equal(woke.json.wake, "prompt", woke.stdout);
  const standIns = woke.json.deliveries.filter((delivery) => delivery.actor);
  assert.deepEqual(standIns.map((delivery) => delivery.actor), ["s2~r1", "s3~r1"]);
  clock.set(200);
  assert.equal((await submit(fx, "s2", standIns[0].intentId, r1Answer("bravo"))).json.state, "valid");
  assert.equal(roundRow(fx).closed_at, null);
  assert.equal((await submit(fx, "s3", standIns[1].intentId, r1Answer("charlie"))).json.state, "valid");
  const closed = await collect(fx);
  assert.equal(closed.code, 1, closed.stdout);
  assert.deepEqual([closed.json.quorum, closed.json.validSeats, closed.json.validFamilies, closed.json.families], [false, 3, 1, ["claude"]]);
  const text = await council(["collect", fx.runId, "--round", "1"], { cwd: fx.cwd });
  assert.equal(text.code, 1);
  assert.match(text.stdout, /No quorum: 3 valid seats from 1 families/);
  const report = renderFailedReport(fx.dir, snap(fx));
  assert.match(report, /^# Failed council/);
  assert.match(report, /Round 1, s2, substitute s2~r1:[\s\S]*bravo/);
  assert.match(report, /Round 1, s3, substitute s3~r1:[\s\S]*charlie/);
  assert.match(report, /round 1: substitute \(same family as leader\) s2~r1, valid/);
  assert.match(report, /member turns 5 of 12/);
  const crossexam = await council(["crossexam", fx.runId, "--json"], { cwd: fx.cwd });
  assert.deepEqual([crossexam.code, crossexam.json.error], [1, "no-quorum"]);
  // merge publishes the failed inventory, then exits 1 with the count message; export rebuilds it.
  const merged = await council(["merge", fx.runId, "--json"], { cwd: fx.cwd });
  assert.deepEqual([merged.code, merged.json], [
    1,
    { error: "no-quorum", message: "No quorum: 3 valid seats from 1 families. A council needs two valid seats from two families." }
  ]);
  const file = path.join(fx.dir, "merge.json");
  const inventory = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual([inventory.outcome, inventory.families, inventory.substitutions.length], ["failed", ["claude"], 2]);
  assert.deepEqual(
    inventory.answers.map((entry) => [entry.round, entry.seat, entry.actor, entry.family, entry.answer.findings[0].claim]),
    [
      [1, "s1", "s1", "claude", "alpha"],
      [1, "s2", "s2~r1", "claude", "bravo"],
      [1, "s3", "s3~r1", "claude", "charlie"]
    ]
  );
  const bytes = fs.readFileSync(file, "utf8");
  fs.rmSync(file);
  const exported = await council(["export", fx.runId, "merge", "--json"], { cwd: fx.cwd });
  assert.equal(exported.code, 0, exported.stdout);
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  assert.equal(snap(fx).run.merge_sha256, null);
});

// A four-seat council (s1 Claude, s2 Codex, s3 Antigravity, s4 Codex) whose Round 1 closed with
// s2 answered by a Claude stand-in, then Round 2 seeded at 1000: s1 has a prompt, s3 and s4
// continue their jobs, and s2's stand-in is carried.
async function round2WithCarry(t, clock) {
  const fx = await started(t, clock, { fourth: true });
  clock.set(100);
  failJob(fx, currentOf(fx, "s2").job_id, 100);
  completeJob(fx, currentOf(fx, "s3").job_id, 100, r1Answer("charlie"));
  completeJob(fx, currentOf(fx, "s4").job_id, 100, r1Answer("delta"));
  assert.equal((await submit(fx, "s1", currentOf(fx, "s1").id, r1Answer("alpha"))).code, 0);
  const woke = await collect(fx);
  const standIn = woke.json.deliveries.find((delivery) => delivery.actor === "s2~r1");
  assert.ok(standIn, woke.stdout);
  clock.set(200);
  assert.equal((await submit(fx, "s2", standIn.intentId, r1Answer("bravo"))).json.state, "valid");
  assert.equal(roundRow(fx).quorum, 1);
  clock.set(1000);
  const sent = await council(["crossexam", fx.runId, "--json"], { cwd: fx.cwd });
  assert.equal(sent.code, 0, sent.stderr);
  return { fx, sent };
}

test("Round 2 carries a Round 1 stand-in with its own findings, and a seat that failed only in Round 2 gets a fresh stand-in without that seat's findings", async (t) => {
  const clock = useTestClock(t, 0);
  const { fx, sent } = await round2WithCarry(t, clock);
  const map = mapOf(fx);
  // The carry answers under its Round 1 key; the map names stand-in authors by actor key.
  assert.deepEqual(Object.keys(map).sort(), ["$alternates", "s1", "s2~r1", "s3", "s4"]);
  assert.deepEqual(Object.values(map.s1).sort(), ["s2~r1", "s3", "s4"]);
  assert.deepEqual(Object.keys(map.$alternates).sort(), ["s1~r2", "s3~r2", "s4~r2"]);
  assert.deepEqual(Object.values(map.$alternates["s4~r2"]).sort(), ["s1", "s2~r1", "s3"]);
  const carry = sent.json.deliveries.find((delivery) => delivery.actor === "s2~r1");
  assert.deepEqual([carry.seat, carry.round], ["s2", 2]);
  assert.match(promptText(carry), /"claim": "bravo"/);
  assert.match(promptText(carry), /alpha/);
  assert.match(promptText(carry), /Your lens: security/);
  const s1 = sent.json.deliveries.find((delivery) => delivery.seat === "s1");
  // s1, then the carry answer; s3's continuation answers valid; s4's fails for good.
  clock.set(1100);
  assert.equal((await submit(fx, "s1", s1.intentId, r2Answer(map.s1))).json.state, "valid");
  assert.equal((await submit(fx, "s2", carry.intentId, r2Answer(map["s2~r1"]))).json.state, "valid");
  completeJob(fx, currentOf(fx, "s3", 2).job_id, 1100, r2Answer(map.s3));
  failJob(fx, currentOf(fx, "s4", 2).job_id, 1100);
  const woke = await collect(fx, { round: 2 });
  assert.equal(woke.json.wake, "prompt", woke.stdout);
  const fresh = woke.json.deliveries.find((delivery) => delivery.actor === "s4~r2");
  assert.deepEqual([fresh.seat, fresh.round], ["s4", 2]);
  const text = promptText(fresh);
  assert.match(text, /in place of a council member/);
  assert.match(text, /Your lens: cost/);
  for (const claim of ["alpha", "bravo", "charlie"]) {
    assert.match(text, new RegExp(claim));
  }
  assert.doesNotMatch(text, /delta/);
  // A reply that names an own finding is refused for the fresh stand-in, which owns none.
  clock.set(1200);
  const forged = JSON.parse(r2Answer(map.$alternates["s4~r2"]));
  forged.responses[0].sameAs = "f1";
  assert.equal((await submit(fx, "s4", fresh.intentId, JSON.stringify(forged))).json.state, "invalid");
  assert.equal(snap(fx).ext.turns.filter((turn) => turn.round === 2).length, 2);
  const closed = await collect(fx, { round: 2 });
  assert.deepEqual([closed.code, closed.json.quorum, closed.json.validSeats, closed.json.families], [0, true, 3, ["claude", "agy"]]);
  assert.deepEqual(
    closed.json.substitutions.map((entry) => [entry.seat, entry.actor, entry.kind, entry.state]),
    [
      ["s2", "s2~r1", "carry", "valid"],
      ["s4", "s4~r2", "substitute", "invalid"]
    ]
  );
});

test("the merge and the report attribute a carried stand-in's work to its logical seat with the family claude", async (t) => {
  const clock = useTestClock(t, 0);
  const { fx, sent } = await round2WithCarry(t, clock);
  const map = mapOf(fx);
  const delivery = (seat) => sent.json.deliveries.find((entry) => entry.seat === seat);
  clock.set(1100);
  await submit(fx, "s1", delivery("s1").intentId, r2Answer(map.s1));
  await submit(fx, "s2", delivery("s2").intentId, r2Answer(map["s2~r1"]));
  completeJob(fx, currentOf(fx, "s3", 2).job_id, 1100, r2Answer(map.s3));
  failJob(fx, currentOf(fx, "s4", 2).job_id, 1100);
  const woke = await collect(fx, { round: 2 });
  const fresh = woke.json.deliveries.find((entry) => entry.actor === "s4~r2");
  clock.set(1200);
  assert.equal((await submit(fx, "s4", fresh.intentId, r2Answer(map.$alternates["s4~r2"]))).json.state, "valid");
  assert.equal(roundRow(fx, 2).quorum, 1);
  const merged = await council(["merge", fx.runId, "--json"], { cwd: fx.cwd });
  assert.equal(merged.code, 0, merged.stderr);
  const merge = merged.json.merge;
  assert.deepEqual(merge.quorum, { validSeats: 4, families: ["claude", "agy"] });
  assert.deepEqual(merge.memberTurns, { used: 10, cap: 14, repairs: 0, retries: 0 });
  assert.deepEqual(
    merge.substitutions.map((entry) => [entry.seat, entry.round, entry.actor, entry.kind, entry.family, entry.state]),
    [
      ["s2", 1, "s2~r1", "substitute", "claude", "valid"],
      ["s2", 2, "s2~r1", "carry", "claude", "valid"],
      ["s4", 2, "s4~r2", "substitute", "claude", "valid"]
    ]
  );
  const byClaim = Object.fromEntries(merge.clusters.map((cluster) => [cluster.claim, cluster]));
  // bravo, written by s2's stand-in, is claude's: s1 and the s4 stand-in (claude) cannot cross-validate it.
  assert.deepEqual([byClaim.bravo.findings, byClaim.bravo.reportedBy, byClaim.bravo.validatedBy], [["s2-f1"], ["claude"], ["agy"]]);
  // delta (s4's own Round 1 finding) is not validated by s4's stand-in, which never saw it.
  assert.deepEqual([byClaim.delta.reportedBy, byClaim.delta.validatedBy], [["codex"], ["claude", "agy"]]);
  const report = renderCouncilReport(fx.dir, snap(fx), merge);
  assert.match(report, /round 1: substitute \(same family as leader\) s2~r1, valid/);
  assert.match(report, /round 2: carried substitute \(same family as leader\) s2~r1, valid/);
  assert.match(report, /round 2: substitute \(same family as leader\) s4~r2, valid/);
  assert.match(report, /member turns 10 of 14/);
});

test("at the cutoff an unanswered carry ends timed-out, and a stand-in asked after the cutoff gets its own full time", async (t) => {
  const clock = useTestClock(t, 0);
  const { fx, sent } = await round2WithCarry(t, clock);
  const map = mapOf(fx);
  const s1 = sent.json.deliveries.find((entry) => entry.seat === "s1");
  const carry = sent.json.deliveries.find((entry) => entry.actor === "s2~r1");
  // s1 and s3 answer at 1100, which seals Round 2 (cutoff 301100); s4's job keeps running.
  clock.set(1100);
  setJob(fx.store, currentOf(fx, "s4", 2).job_id, { claimed_at: EPOCH + 1050, started_at: EPOCH + 1050 });
  await submit(fx, "s1", s1.intentId, r2Answer(map.s1));
  completeJob(fx, currentOf(fx, "s3", 2).job_id, 1100, r2Answer(map.s3));
  await collect(fx, { round: 2 });
  assert.equal(roundRow(fx, 2).cutoff_at - EPOCH, 301100);
  clock.set(301100);
  const woke = await collect(fx, { round: 2 });
  assert.equal(woke.json.wake, "prompt", woke.stdout);
  const carryTurn = snap(fx).ext.turns.find((turn) => turn.id === carry.intentId);
  const finish = snap(fx).ext.events.find((event) => event.turn_id === carryTurn.id && event.kind === "finish");
  assert.deepEqual([finish.code, finish.reason], ["timed-out", "quorum cutoff"]);
  assert.deepEqual([seatRow(fx, "s4", 2).state, seatRow(fx, "s4", 2).reason], ["timed-out", "quorum cutoff"]);
  const fresh = woke.json.deliveries.find((entry) => entry.actor === "s4~r2");
  assert.equal(fresh.deadline, iso(301100 + T_LONG));
  // A carry's late reply is refused; the fresh stand-in's reply after the cutoff counts.
  clock.set(302000);
  assert.equal((await submit(fx, "s2", carry.intentId, r2Answer(map["s2~r1"]))).json.error, "intent-not-open");
  assert.equal((await submit(fx, "s4", fresh.intentId, r2Answer(map.$alternates["s4~r2"]))).json.state, "valid");
  const closed = await collect(fx, { round: 2 });
  assert.deepEqual([closed.code, closed.json.quorum, closed.json.validSeats], [0, true, 3]);
});

test("start takes no --disallow-substitute and collect has no --allow-substitute", async (t) => {
  const cwd = makeTempDir(t);
  const start = await council(["start", "--brief", "brief.json", "--disallow-substitute", "--json"], { cwd });
  assert.deepEqual([start.code, start.json], [1, { error: "invalid-arguments", message: "--disallow-substitute is only valid on council collect." }]);
  const allow = await council(["collect", "run-x", "--round", "1", "--allow-substitute", "--json"], { cwd });
  assert.deepEqual([allow.code, allow.json], [1, { error: "invalid-arguments", message: "Unknown option --allow-substitute." }]);
});
