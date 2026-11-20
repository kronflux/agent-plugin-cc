// Follow-up questions to one council seat after a successful Round 2: the shared lifecycle of a
// follow-up turn, its admission and refusals, its answer in the merge and the report, and the
// unanimous-panel projection, on real store transactions with the test wall clock and fake
// provider jobs.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { unanimousPanel } from "../plugins/agent/scripts/lib/council/merge.mjs";
import { readObject } from "../plugins/agent/scripts/lib/council/objects.mjs";
import { followupLimits, followupWrites } from "../plugins/agent/scripts/lib/council/reduce-ext.mjs";
import { readCouncil } from "../plugins/agent/scripts/lib/council/state.mjs";
import { readJobView, resolveStateDir } from "../plugins/agent/scripts/lib/state.mjs";
import { openStore } from "../plugins/agent/scripts/lib/store.mjs";
import { handleCouncil } from "../plugins/agent/scripts/commands/council.mjs";
import { makeTempDir } from "./helpers.mjs";
import { EPOCH, seatJobFields, setJob, useTestClock } from "./council-helpers.mjs";

const hex = (character) => character.repeat(64);

// ---------------------------------------------------------------------------------------------
// The pure rows.

test("a follow-up turn settles once by X1 to X8, with the provider outcomes of the B5 mapping", () => {
  const T = 1000;
  const turn = (id, extra = {}) => ({ id: id.repeat(32), seat: "s2", kind: "followup", round: null, created_at: 100, issue_by: 1100, ...extra });
  const issue = (id, jobId) => ({ turn_id: id.repeat(32), kind: "issue", at: 100, job_id: jobId });
  const deposit = (id, code, reason = null) => ({ turn_id: id.repeat(32), kind: "deposit", at: 300, event_at: 290, code, reason, digest: code === "valid" ? hex("d") : null, after_close: 0 });
  const live = (jobId, extra = {}) => ({ id: jobId, created_at: 100, claimed_at: 110, end_state: null, cancel_requested_at: null, ...extra });
  const ended = (jobId) => ({ ...live(jobId), end_state: "completed" });
  const outcome = (writes) => writes.map((write) => [write.turnId[0], write.op, write.state ?? write.code, write.reason ?? null]);
  // X5: each deposit class finishes its turn by the mapping.
  const classes = [
    ["a", "valid", null, ["valid", null]],
    ["b", "invalid", "schema validation failed", ["invalid", "schema validation failed"]],
    ["c", "late", "execution deadline expired", ["timed-out", "execution deadline expired"]],
    ["d", "quota", "quota exhausted", ["quota-exhausted", "quota exhausted"]],
    ["e", "missing", "job pruned or missing", ["error", "job pruned or missing"]],
    ["f", "failure", "provider failure", ["error", "provider failure"]],
    ["g", "cancelled", "job cancelled", ["error", "external cancellation"]]
  ];
  const turns = classes.map(([id]) => turn(id));
  const events = classes.flatMap(([id, code, reason]) => [issue(id, `job-${id}`), deposit(id, code, reason)]);
  const jobs = Object.fromEntries(classes.map(([id]) => [`job-${id}`, ended(`job-${id}`)]));
  assert.deepEqual(
    outcome(followupWrites(turns, events, { t: 400, w: 400, timeoutMs: T, jobs })),
    classes.map(([id, , , [state, reason]]) => [id, "ext-finish", state, reason])
  );
  // A cancellation after the council's own acknowledged stop takes the stop's cause.
  const stopped = [issue("h", "job-h"), { turn_id: "h".repeat(32), kind: "stop", at: 1110, code: "deadline" }, { turn_id: "h".repeat(32), kind: "ack", at: 1111, event_at: 1111, code: "council" }, deposit("h", "cancelled", "job cancelled")];
  assert.deepEqual(outcome(followupWrites([turn("h")], stopped, { t: 1200, w: 1200, timeoutMs: T, jobs: { "job-h": ended("job-h") } })), [["h", "ext-finish", "timed-out", "execution deadline expired"]]);
  // X6: an unended job past its execution bound (claim + T) gets a stop; before it, nothing.
  const running = [turn("i")];
  const runningEvents = [issue("i", "job-i")];
  assert.deepEqual(followupWrites(running, runningEvents, { t: 1109, w: 1109, timeoutMs: T, jobs: { "job-i": live("job-i") } }), []);
  assert.deepEqual(
    followupWrites(running, runningEvents, { t: 1110, w: 1110, timeoutMs: T, jobs: { "job-i": live("job-i") } }),
    [{ op: "ext-stop", turnId: "i".repeat(32), seat: "s2", jobId: "job-i", code: "deadline" }]
  );
  // An unclaimed job is stopped at its queue bound (created + T).
  assert.deepEqual(outcome(followupWrites(running, runningEvents, { t: 1100, w: 1100, timeoutMs: T, jobs: { "job-i": live("job-i", { claimed_at: null }) } })), [["i", "ext-stop", "queue", null]]);
  // X7: a council-first acknowledged stop settles 120 s after the acknowledgement while the job stays unended.
  const acked = [...runningEvents, { turn_id: "i".repeat(32), kind: "stop", at: 1110, code: "deadline" }, { turn_id: "i".repeat(32), kind: "ack", at: 1111, event_at: 1111, code: "council" }];
  const cancelling = { "job-i": live("job-i", { cancel_requested_at: 1111 }) };
  assert.deepEqual(followupWrites(running, acked, { t: 121110, w: 121110, timeoutMs: T, jobs: cancelling }), []);
  assert.deepEqual(outcome(followupWrites(running, acked, { t: 121111, w: 121111, timeoutMs: T, jobs: cancelling })), [["i", "ext-finish", "timed-out", "execution deadline expired"]]);
  // An ended job without a deposit, and a missing job, wait for their observation.
  assert.deepEqual(followupWrites(running, acked, { t: 200000, w: 200000, timeoutMs: T, jobs: { "job-i": ended("job-i") } }), []);
  assert.deepEqual(followupWrites(running, runningEvents, { t: 200000, w: 200000, timeoutMs: T, jobs: {} }), []);
  // X8: a foreign cancellation settles `error` 120 s after its request on the raw wall axis.
  const foreign = { "job-i": live("job-i", { cancel_requested_at: 500 }) };
  assert.deepEqual(followupWrites(running, runningEvents, { t: 120499, w: 120499, timeoutMs: T, jobs: foreign }), []);
  assert.deepEqual(outcome(followupWrites(running, runningEvents, { t: 120500, w: 120500, timeoutMs: T, jobs: foreign })), [["i", "ext-finish", "error", "external cancellation did not settle"]]);
  // X1, X2 and X4 settle a reserved provider turn and a silent Claude turn; a finished turn gets nothing.
  const shared = [turn("j", { predecessor_id: "job-p" }), turn("k", { predecessor_id: "job-p" }), turn("l"), turn("m")];
  const sharedEvents = [
    { turn_id: "j".repeat(32), kind: "refusal", at: 105, reason: "predecessor has no thread" },
    issue("l", null),
    issue("m", null),
    { turn_id: "m".repeat(32), kind: "finish", at: 200, code: "valid", reason: null }
  ];
  assert.deepEqual(outcome(followupWrites(shared, sharedEvents, { t: 1100, w: 1100, timeoutMs: T, jobs: {} })), [
    ["j", "ext-finish", "error", "predecessor has no thread"],
    ["k", "ext-finish", "error", "issuance deadline expired"],
    ["l", "ext-finish", "timed-out", "reply deadline expired"]
  ]);
  // Turns of other kinds are left to their own rows.
  assert.deepEqual(followupWrites([turn("n", { kind: "substitute", round: 1 })], [issue("n", null)], { t: 5000, w: 5000, timeoutMs: T, jobs: {} }), []);
});

test("the limits of an opening name the seat, the run and the cap in that order", () => {
  const base = { seat: "s1", seatCount: 0, runCount: 0, used: 6, live: 0, cap: 12 };
  assert.deepEqual(followupLimits(base), []);
  assert.deepEqual(followupLimits({ ...base, seatCount: 2, runCount: 2 }), [{ error: "seat-followup-limit", message: "Seat s1 has reached the limit of two follow-ups." }]);
  assert.deepEqual(followupLimits({ ...base, runCount: 6, used: 10 }), [{ error: "run-followup-limit", message: "The run has reached the limit of six follow-ups." }]);
  // A live reservation holds a member turn: 11 used plus one reserved leaves no room in 12.
  assert.deepEqual(followupLimits({ ...base, used: 11, live: 1 }), [{ error: "member-turn-limit", message: "The run has reached its cap of 12 member turns." }]);
  assert.deepEqual(
    followupLimits({ ...base, seatCount: 2, runCount: 6, used: 12 }).map((limit) => limit.error),
    ["seat-followup-limit", "run-followup-limit", "member-turn-limit"]
  );
});

// ---------------------------------------------------------------------------------------------
// The council commands with follow-ups on.

const ON = { followups: true, substitution: true };
const T_LONG = 1000000;
const iso = (at) => new Date(EPOCH + at).toISOString();

function r1Answer(claim, stance = null) {
  return JSON.stringify({
    schema: 1,
    stance,
    confidence: "high",
    dealbreaker: null,
    findings: [{ id: "f1", severity: "P2", claim, path: "src/a.mjs", line: 1, evidence: `${claim} evidence` }],
    assumptions: [],
    wouldChangeMind: "a failing test"
  });
}

// A Round 2 answer that gives `response` to every finding of a letter map (each author has one
// finding f1).
function r2Answer(letterMap, { stance = null, response = "validate", added = [] } = {}) {
  const responses = Object.keys(letterMap)
    .sort()
    .map((letter) =>
      response === "challenge"
        ? { finding: `${letter}-f1`, response, disputes: "claim", sameAs: null, reason: "not so", evidence: "see the code" }
        : { finding: `${letter}-f1`, response, disputes: null, sameAs: null, reason: null, evidence: null }
    );
  return JSON.stringify({ schema: 1, stance, responses, added });
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

// Runs one council subcommand in this process at layer 2 with follow-ups on unless given, fake
// provider checks, a job builder that keeps the prompt, no launch and no usage evidence.
async function council(argv, { cwd, extensions = ON, advance = {} }) {
  const out = [];
  const err = [];
  const time = fakeTime();
  const code = await handleCouncil([argv[0], "--cwd", cwd, ...argv.slice(1)], {
    layer: 2,
    extensions,
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

const snap = (fx) => readCouncil(fx.store, fx.runId);
const seatRow = (fx, seat, round = 1) => snap(fx).seatRounds.find((row) => row.round === round && row.seat === seat);
const roundRow = (fx, round = 1) => snap(fx).rounds.find((row) => row.round === round);
const currentOf = (fx, seat, round = 1) => snap(fx).attempts.find((row) => row.id === seatRow(fx, seat, round).current_id);
const mapOf = (fx) => JSON.parse(readObject(fx.dir, roundRow(fx, 2).map_sha256, "json").toString("utf8"));
const turnOf = (fx, intentId) => snap(fx).ext.turns.find((turn) => turn.id === intentId);
const eventOf = (fx, intentId, kind) => snap(fx).ext.events.find((event) => event.turn_id === intentId && event.kind === kind) ?? null;
const finishOf = (fx, intentId) => {
  const finish = eventOf(fx, intentId, "finish");
  return finish ? [finish.code, finish.reason] : null;
};

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

function collect(fx, { round = 2, budgetMs = 120000, advance = {} } = {}) {
  return council(["collect", fx.runId, "--round", String(round), "--budget-ms", String(budgetMs), "--json"], { cwd: fx.cwd, advance });
}

function followup(fx, seat, target, question = "Does it hold?", { extensions = ON, advance = {} } = {}) {
  return council(["followup", fx.runId, seat, "--finding", target, "--json", "--", question], { cwd: fx.cwd, extensions, advance });
}

async function merge(fx) {
  const result = await council(["merge", fx.runId, "--json"], { cwd: fx.cwd });
  assert.equal(result.code, 0, result.stdout);
  return result;
}

// A council started at wall 0 through `council start`: s1 Claude, s2 Codex, s3 Antigravity; the
// provider jobs stay queued until a test ends them.
async function started(t, clock, { kind = "review" } = {}) {
  clock.set(0);
  const cwd = makeTempDir(t);
  const stateDir = resolveStateDir(cwd);
  const store = openStore(stateDir);
  t.after(() => store.close());
  const brief = path.join(cwd, "brief.json");
  fs.writeFileSync(brief, JSON.stringify({ question: "Is the cache correct?", targets: ["src"], kind, ...(kind === "decision" ? { options: ["A", "B"] } : {}) }));
  const result = await council(["start", "--brief", brief, "--timeout-ms", String(T_LONG), "--json"], { cwd });
  assert.equal(result.code, 0, result.stderr);
  return { cwd, store, kind, runId: result.json.runId, dir: path.join(stateDir, "council", result.json.runId) };
}

// Round 1 answered at 100 (s1 alpha, s2 bravo, s3 charlie, each its own finding f1) and closed.
async function round1Closed(t, clock, options = {}) {
  const fx = await started(t, clock, options);
  const stance = fx.kind === "decision" ? "A" : null;
  clock.set(100);
  completeJob(fx, currentOf(fx, "s2").job_id, 100, r1Answer("bravo", stance));
  completeJob(fx, currentOf(fx, "s3").job_id, 100, r1Answer("charlie", stance));
  assert.equal((await submit(fx, "s1", currentOf(fx, "s1").id, r1Answer("alpha", stance))).code, 0);
  const closed = await collect(fx, { round: 1 });
  assert.equal(closed.json.quorum, true, closed.stdout);
  return fx;
}

// Round 2 sent at 1000 and answered at 1100 (`answers2(seat, letterMap)` gives each answer, by
// default a validation of every finding), and closed.
async function round2Closed(t, clock, { answers2 = null, ...options } = {}) {
  const fx = await round1Closed(t, clock, options);
  clock.set(1000);
  const sent = await council(["crossexam", fx.runId, "--json"], { cwd: fx.cwd });
  assert.equal(sent.code, 0, sent.stderr);
  const map = mapOf(fx);
  const stance = fx.kind === "decision" ? "A" : null;
  const answerOf = (seat) => (answers2 ? answers2(seat, map[seat]) : r2Answer(map[seat], { stance }));
  clock.set(1100);
  assert.equal((await submit(fx, "s1", sent.json.deliveries.find((entry) => entry.seat === "s1").intentId, answerOf("s1"))).json.state, "valid");
  completeJob(fx, currentOf(fx, "s2", 2).job_id, 1100, answerOf("s2"));
  completeJob(fx, currentOf(fx, "s3", 2).job_id, 1100, answerOf("s3"));
  const closed = await collect(fx);
  assert.deepEqual([closed.code, closed.json.quorum], [0, true], closed.stdout);
  return fx;
}

// A successful council merged at 1200: the clusters c1 alpha (s1), c2 bravo (s2), c3 charlie (s3).
async function merged(t, clock, options = {}) {
  const fx = await round2Closed(t, clock, options);
  clock.set(1200);
  await merge(fx);
  return fx;
}

// Asks a provider seat one question at `at`, ends its job with `resultJson`, collects and merges.
async function askProvider(fx, clock, seat, target, at, resultJson) {
  clock.set(at);
  const asked = await followup(fx, seat, target);
  assert.equal(asked.code, 0, asked.stdout);
  completeJob(fx, asked.json.jobId, at + 10, resultJson);
  clock.set(at + 20);
  const closed = await collect(fx);
  assert.equal(closed.json.wake, "closed", closed.stdout);
  await merge(fx);
  return asked.json;
}

test("a follow-up to a provider seat continues its accepted Round 2 job and stores its valid answer", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await merged(t, clock);
  const round2Job = currentOf(fx, "s2", 2).job_id;
  clock.set(1300);
  const asked = await followup(fx, "s2", "c1", "Is alpha a real defect?");
  assert.equal(asked.code, 0, asked.stdout);
  assert.deepEqual(Object.keys(asked.json), ["runId", "seat", "intentId", "ordinal", "state", "jobId", "deliveries", "diagnostics"]);
  assert.deepEqual([asked.json.runId, asked.json.seat, asked.json.ordinal, asked.json.state, asked.json.deliveries, asked.json.diagnostics], [fx.runId, "s2", 1, "issued", [], []]);
  // The new job continues the exact job of the seat's accepted Round 2 answer, with the follow-up prompt.
  assert.equal(readJobView(fx.store, asked.json.jobId).row.continues, round2Job);
  const turn = turnOf(fx, asked.json.intentId);
  assert.deepEqual(
    [turn.kind, turn.target, turn.question, turn.predecessor_id, turn.merge_sha256, turn.issue_by - EPOCH],
    ["followup", "c1", "Is alpha a real defect?", round2Job, snap(fx).run.merge_sha256, 1300 + T_LONG]
  );
  const prompt = readObject(fx.dir, turn.prompt_sha256, "md").toString("utf8");
  assert.match(prompt, /Is alpha a real defect\?/);
  assert.match(prompt, /Merged finding c1/);
  assert.match(prompt, /"claim": "alpha"/);
  assert.match(prompt, /"claim": "bravo"/);
  assert.match(prompt, /Your lens: security/);
  assert.doesNotMatch(prompt, /reportedBy|codex/);
  // Status sends the leader to collect Round 2 while the follow-up is open.
  assert.equal((await council(["status", fx.runId, "--json"], { cwd: fx.cwd })).json.action, "collect");
  // The job answers; collect observes it, settles the follow-up valid and returns the closed round.
  const revision = snap(fx).run.input_rev;
  completeJob(fx, asked.json.jobId, 1400, JSON.stringify({ answer: "Yes: the cache key omits the locale.", stance: null }));
  clock.set(1500);
  const closed = await collect(fx);
  assert.deepEqual([closed.code, closed.json.wake, closed.json.quorum], [0, "closed", true], closed.stdout);
  assert.deepEqual(finishOf(fx, asked.json.intentId), ["valid", null]);
  const deposit = eventOf(fx, asked.json.intentId, "deposit");
  assert.deepEqual(JSON.parse(readObject(fx.dir, deposit.digest, "json").toString("utf8")), { answer: "Yes: the cache key omits the locale." });
  assert.equal(snap(fx).run.input_rev, revision + 1);
  assert.equal((await council(["status", fx.runId, "--json"], { cwd: fx.cwd })).json.action, "merge");
});

test("a follow-up to the Claude seat is a prompt the leader delivers and submits, and a late reply is refused", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await merged(t, clock);
  clock.set(1300);
  const asked = await followup(fx, "s1", "c2", "Why did you validate bravo?");
  assert.deepEqual([asked.code, asked.json.state, asked.json.jobId, asked.json.ordinal], [0, "issued", null, 1], asked.stdout);
  const [delivery] = asked.json.deliveries;
  assert.deepEqual(
    [delivery.seat, delivery.intentId, delivery.round, delivery.actor, delivery.kind, delivery.deadline],
    ["s1", asked.json.intentId, 2, "s1", "followup", iso(1300 + T_LONG)]
  );
  assert.match(fs.readFileSync(delivery.promptFile, "utf8"), /Why did you validate bravo\?/);
  const status = await council(["status", fx.runId], { cwd: fx.cwd });
  assert.match(status.stdout, /Follow-up prompt for s1 \(to the agent of s1\)/);
  assert.match(status.stdout, /Next: run council collect .* --round 2\./);
  clock.set(1400);
  const accepted = await submit(fx, "s1", delivery.intentId, JSON.stringify({ answer: "Because the trace shows it.", stance: null }));
  assert.deepEqual([accepted.code, accepted.json.state, accepted.json.actor, accepted.json.ordinal], [0, "valid", "s1", 1], accepted.stdout);
  assert.equal((await submit(fx, "s1", delivery.intentId, JSON.stringify({ answer: "Again." }))).json.error, "duplicate-receipt");
  // A second follow-up whose reply comes at its deadline is refused, and the follow-up times out.
  clock.set(1500);
  await merge(fx);
  const second = await followup(fx, "s1", "c3");
  assert.equal(second.code, 0, second.stdout);
  clock.set(1500 + T_LONG);
  const late = await submit(fx, "s1", second.json.intentId, JSON.stringify({ answer: "Too late." }));
  assert.deepEqual([late.code, late.json.error], [1, "intent-not-open"]);
  assert.deepEqual(finishOf(fx, second.json.intentId), ["timed-out", "reply deadline expired"]);
});

test("each follow-up refusal has its code and message, in the contract's order", async (t) => {
  const clock = useTestClock(t, 0);
  const refusal = (result) => [result.code, result.json?.error, result.json?.message];
  const early = await round1Closed(t, clock);
  // Parsing comes first, before the run is looked up.
  const blank = await council(["followup", "no-such-run", "s1", "--finding", "c1", "--json", "--", "  "], { cwd: early.cwd });
  assert.deepEqual(refusal(blank), [1, "invalid-arguments", "Supply one nonblank follow-up question."]);
  assert.deepEqual(refusal(await followup({ ...early, runId: "no-such-run" }, "s1", "c1")), [1, "unknown-run", "Unknown council run no-such-run."]);
  assert.deepEqual(refusal(await followup(early, "s9", "c99", "q", { extensions: { substitution: true } })), [1, "extension-disabled", "Council extension followups is disabled."]);
  assert.deepEqual(refusal(await followup(early, "s9", "c99")), [1, "round-2-not-successful", "Follow-ups require a successful closed Round 2."]);
  const fx = await round2Closed(t, clock);
  assert.deepEqual(refusal(await followup(fx, "s9", "c99")), [1, "stale-merge", "Council merge is stale. Run council merge again."]);
  await merge(fx);
  assert.deepEqual(refusal(await followup(fx, "s9", "c99")), [1, "invalid-seat", "Seat s9 has no valid Round 2 actor."]);
  assert.deepEqual(refusal(await followup(fx, "s2", "c99")), [1, "invalid-target", "Finding c99 is not an eligible follow-up target."]);
  assert.deepEqual(refusal(await followup(fx, "s2", "stance")), [1, "invalid-target", "Finding stance is not an eligible follow-up target."]);
  clock.set(1300);
  assert.equal((await followup(fx, "s1", "c2")).code, 0);
  assert.deepEqual(refusal(await followup(fx, "s1", "c3")), [1, "followup-open", "Seat s1 already has an open follow-up."]);
  // A predecessor that cannot be continued is refused before anything is opened.
  setJob(fx.store, currentOf(fx, "s2", 2).job_id, { thread_id: null });
  assert.deepEqual(refusal(await followup(fx, "s2", "c1")), [1, "predecessor-unusable", "Seat s2 cannot continue: predecessor has no thread."]);
  assert.equal(snap(fx).ext.turns.length, 1);
});

test("a third follow-up to one seat and a seventh in the run are refused, and a failed follow-up counts", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await merged(t, clock);
  // s1's first follow-up stays silent past its deadline: it times out and still counts.
  clock.set(1300);
  const silent = await followup(fx, "s1", "c2");
  clock.set(1300 + T_LONG);
  assert.equal((await collect(fx)).json.wake, "closed");
  assert.deepEqual(finishOf(fx, silent.json.intentId), ["timed-out", "reply deadline expired"]);
  // A stale merge is refused before the limits.
  assert.equal((await followup(fx, "s1", "c3")).json.error, "stale-merge");
  await merge(fx);
  let at = 1400 + T_LONG;
  clock.set(at);
  const second = await followup(fx, "s1", "c3");
  assert.equal((await submit(fx, "s1", second.json.intentId, JSON.stringify({ answer: "Yes." }))).json.state, "valid");
  await merge(fx);
  const third = await followup(fx, "s1", "c2");
  assert.deepEqual([third.code, third.json.error, third.json.message], [1, "seat-followup-limit", "Seat s1 has reached the limit of two follow-ups."]);
  // Four more follow-ups to the provider seats fill the run's six; the next names every limit it reaches.
  for (const seat of ["s2", "s2", "s3", "s3"]) {
    at += 100;
    await askProvider(fx, clock, seat, "c1", at, JSON.stringify({ answer: `From ${seat}.`, stance: null }));
  }
  assert.equal(snap(fx).ext.turns.length, 6);
  const seventh = await followup(fx, "s3", "c1");
  assert.deepEqual(
    [seventh.code, seventh.json.error, seventh.json.message],
    [1, "seat-followup-limit", "Seat s3 has reached the limit of two follow-ups. The run has reached the limit of six follow-ups. The run has reached its cap of 12 member turns."]
  );
  // A seat's second follow-up continues the job of its first.
  const s2Turns = snap(fx).ext.turns.filter((turn) => turn.seat === "s2").sort((a, b) => a.ordinal - b.ordinal);
  assert.equal(s2Turns[1].predecessor_id, eventOf(fx, s2Turns[0].id, "issue").job_id);
});

test("a provider follow-up that answers invalidly, fails, or runs past its deadline ends once, and its job gets the exact stop", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await merged(t, clock);
  // An answer with a stance on a review is invalid.
  clock.set(1300);
  const invalid = await followup(fx, "s2", "c1");
  completeJob(fx, invalid.json.jobId, 1310, JSON.stringify({ answer: "Yes.", stance: "A" }));
  clock.set(1320);
  assert.equal((await collect(fx)).json.wake, "closed");
  assert.deepEqual(finishOf(fx, invalid.json.intentId), ["invalid", "schema validation failed"]);
  // A failed job ends `error` with its failure reason, and is not continued by a later follow-up.
  await merge(fx);
  clock.set(1400);
  const failed = await followup(fx, "s3", "c1");
  failJob(fx, failed.json.jobId, 1410);
  clock.set(1420);
  assert.equal((await collect(fx)).json.wake, "closed");
  assert.deepEqual(finishOf(fx, failed.json.intentId), ["error", "provider failure"]);
  await merge(fx);
  assert.equal((await followup(fx, "s3", "c2")).json.message, "Seat s3 cannot continue: predecessor failed.");
  // s2's second follow-up continues the job that answered invalidly and runs past its execution bound.
  clock.set(1500);
  const slow = await followup(fx, "s2", "c2");
  assert.equal(readJobView(fx.store, slow.json.jobId).row.continues, eventOf(fx, invalid.json.intentId, "issue").job_id);
  setJob(fx.store, slow.json.jobId, { claimed_at: EPOCH + 1510, started_at: EPOCH + 1510 });
  const stops = [];
  const { requestStop } = await import("../plugins/agent/scripts/lib/state.mjs");
  const recordStop = (store, selector, options, opts) => {
    stops.push(selector.jobIds);
    return requestStop(store, selector, options, opts);
  };
  clock.set(1510 + T_LONG - 1);
  assert.equal((await collect(fx, { budgetMs: 4000, advance: { requestStop: recordStop } })).json.wake, "budget");
  assert.deepEqual([stops, eventOf(fx, slow.json.intentId, "stop")], [[], null]);
  clock.set(1510 + T_LONG);
  assert.equal((await collect(fx, { budgetMs: 4000, advance: { requestStop: recordStop } })).json.wake, "budget");
  assert.deepEqual(stops, [[slow.json.jobId]]);
  assert.deepEqual([eventOf(fx, slow.json.intentId, "stop").code, eventOf(fx, slow.json.intentId, "ack").code], ["deadline", "council"]);
  assert.notEqual(readJobView(fx.store, slow.json.jobId).row.cancel_requested_at, null);
  // The job does not end within 120 s of the acknowledged stop: the follow-up times out with the stop's cause.
  clock.set(eventOf(fx, slow.json.intentId, "ack").at - EPOCH + 120000);
  const closed = await collect(fx, { advance: { requestStop: recordStop } });
  assert.equal(closed.json.wake, "closed", closed.stdout);
  assert.deepEqual(finishOf(fx, slow.json.intentId), ["timed-out", "execution deadline expired"]);
  assert.deepEqual(stops, [[slow.json.jobId]]);
});

// A council whose Round 1 seat s2 failed at 100 and was answered by the Claude stand-in s2~r1 at
// 200, with Round 2 sent at 1000: s1 has a prompt, s2's stand-in is carried, s3 continues its job.
async function round2WithCarry(t, clock) {
  const fx = await started(t, clock);
  clock.set(100);
  failJob(fx, currentOf(fx, "s2").job_id, 100);
  completeJob(fx, currentOf(fx, "s3").job_id, 100, r1Answer("charlie"));
  assert.equal((await submit(fx, "s1", currentOf(fx, "s1").id, r1Answer("alpha"))).code, 0);
  const woke = await collect(fx, { round: 1 });
  const standIn = woke.json.deliveries.find((delivery) => delivery.actor === "s2~r1");
  assert.ok(standIn, woke.stdout);
  clock.set(200);
  assert.equal((await submit(fx, "s2", standIn.intentId, r1Answer("bravo"))).json.state, "valid");
  clock.set(1000);
  const sent = await council(["crossexam", fx.runId, "--json"], { cwd: fx.cwd });
  assert.equal(sent.code, 0, sent.stderr);
  return { fx, sent, map: mapOf(fx) };
}

test("a follow-up to a seat a Claude stand-in answered goes to that stand-in as a prompt", async (t) => {
  const clock = useTestClock(t, 0);
  const { fx, sent, map } = await round2WithCarry(t, clock);
  clock.set(1100);
  for (const delivery of sent.json.deliveries) {
    assert.equal((await submit(fx, delivery.seat, delivery.intentId, r2Answer(map[delivery.actor ?? delivery.seat]))).json.state, "valid");
  }
  completeJob(fx, currentOf(fx, "s3", 2).job_id, 1100, r2Answer(map.s3));
  assert.equal((await collect(fx)).json.quorum, true);
  clock.set(1200);
  await merge(fx);
  clock.set(1300);
  const asked = await followup(fx, "s2", "c1");
  assert.deepEqual([asked.code, asked.json.jobId], [0, null], asked.stdout);
  const delivery = asked.json.deliveries.find((entry) => entry.intentId === asked.json.intentId);
  assert.deepEqual([delivery.seat, delivery.actor, delivery.kind], ["s2", "s2~r1", "followup"]);
  // The prompt holds the stand-in's own answers.
  assert.match(fs.readFileSync(delivery.promptFile, "utf8"), /"claim": "bravo"/);
  assert.equal((await submit(fx, "s2", delivery.intentId, JSON.stringify({ answer: "The stand-in answers." }))).json.state, "valid");
});

test("on a decision a valid follow-up stance changes that seat's vote in the next merge, and an unknown option is invalid", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await merged(t, clock, { kind: "decision" });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fx.dir, "merge.json"), "utf8")).decision, { choice: "A", tally: { A: 3 }, threshold: "2/3", confidence: "HIGH" });
  const first = await askProvider(fx, clock, "s2", "stance", 1300, JSON.stringify({ answer: "The cost changes my choice.", stance: "B" }));
  const mergeJson = JSON.parse(fs.readFileSync(path.join(fx.dir, "merge.json"), "utf8"));
  assert.deepEqual(mergeJson.decision, { choice: "A", tally: { A: 2, B: 1 }, threshold: "2/3", confidence: "MEDIUM" });
  assert.deepEqual(mergeJson.followups, [
    {
      ordinal: 1,
      intentId: first.intentId,
      seat: "s2",
      findingId: "stance",
      question: "Does it hold?",
      mergeSha256: turnOf(fx, first.intentId).merge_sha256,
      state: "valid",
      issuedAt: EPOCH + 1300,
      jobId: first.jobId,
      answer: "The cost changes my choice.",
      stance: "B",
      at: EPOCH + 1310,
      reason: null,
      forceReason: null
    }
  ]);
  assert.match(readObject(fx.dir, turnOf(fx, first.intentId).prompt_sha256, "md").toString("utf8"), /Your stance on the decision\. The options are: A, B\./);
  // An option the decision does not have makes the answer invalid; the vote stays.
  const unknown = await askProvider(fx, clock, "s3", "stance", 1400, JSON.stringify({ answer: "Neither.", stance: "C" }));
  assert.deepEqual(finishOf(fx, unknown.intentId), ["invalid", "schema validation failed"]);
  // The Claude seat's valid stance moves the choice.
  clock.set(1500);
  const asked = await followup(fx, "s1", "stance");
  assert.equal((await submit(fx, "s1", asked.json.intentId, JSON.stringify({ answer: "B is cheaper.", stance: "B" }))).json.state, "valid");
  const remerged = await merge(fx);
  assert.deepEqual(remerged.json.merge.decision, { choice: "B", tally: { B: 2, A: 1 }, threshold: "2/3", confidence: "MEDIUM" });
  assert.deepEqual(remerged.json.merge.followups.map((entry) => [entry.seat, entry.state, entry.stance]), [
    ["s2", "valid", "B"],
    ["s3", "invalid", null],
    ["s1", "valid", "B"]
  ]);
});

test("the report is refused while a follow-up is open, and afterwards the merge, the report and followups.json include it", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await merged(t, clock);
  const verifyAll = async () => {
    const status = await council(["status", fx.runId, "--json"], { cwd: fx.cwd });
    for (const id of status.json.clusters) {
      assert.equal((await council(["verdict", fx.runId, id, "not-checked"], { cwd: fx.cwd })).code, 0);
    }
  };
  // s1's first follow-up stays silent and times out; it is listed without an answer.
  clock.set(1300);
  const silent = await followup(fx, "s1", "c2", "Is bravo reachable?");
  await verifyAll();
  const refused = await council(["report", fx.runId, "--json"], { cwd: fx.cwd });
  assert.deepEqual([refused.code, refused.json], [1, { error: "followup-open-report", message: "A council follow-up is open. Wait for it to finish." }]);
  clock.set(1300 + T_LONG);
  assert.equal((await collect(fx)).json.wake, "closed");
  await merge(fx);
  // s2 answers its follow-up about c1.
  await askProvider(fx, clock, "s2", "c1", 1400 + T_LONG, JSON.stringify({ answer: "Yes: the cache key omits the locale.", stance: null }));
  const mergeJson = JSON.parse(fs.readFileSync(path.join(fx.dir, "merge.json"), "utf8"));
  assert.deepEqual(mergeJson.followups.map((entry) => [entry.ordinal, entry.seat, entry.findingId, entry.state, entry.answer, entry.reason]), [
    [1, "s1", "c2", "timed-out", null, "reply deadline expired"],
    [2, "s2", "c1", "valid", "Yes: the cache key omits the locale.", null]
  ]);
  assert.equal(mergeJson.followups[0].intentId, silent.json.intentId);
  await verifyAll();
  const report = await council(["report", fx.runId], { cwd: fx.cwd });
  assert.equal(report.code, 0, report.stderr);
  assert.match(report.stdout, /## Follow-ups\n\n- s1 on c2 \(follow-up 1\): Is bravo reachable\?\n {2}No answer: timed-out \(reply deadline expired\)\.\n- s2 on c1 \(follow-up 2\): Does it hold\?\n {2}Answer: Yes: the cache key omits the locale\.\n/);
  assert.ok(report.stdout.indexOf("## Disputes") < report.stdout.indexOf("## Follow-ups"));
  assert.ok(report.stdout.indexOf("## Follow-ups") < report.stdout.indexOf("## Minority positions"));
  const followups = JSON.parse(fs.readFileSync(path.join(fx.dir, "followups.json"), "utf8"));
  assert.deepEqual(followups, [{ seat: "s2", findingId: "c1", question: "Does it hold?", answer: "Yes: the cache key omits the locale.", at: EPOCH + 1410 + T_LONG }]);
  fs.rmSync(path.join(fx.dir, "followups.json"));
  const exported = await council(["export", fx.runId, "followups", "--json"], { cwd: fx.cwd });
  assert.equal(exported.code, 0, exported.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fx.dir, "followups.json"), "utf8")), followups);
  // A report whose revisions are no longer current is not exported.
  assert.equal((await council(["verdict", fx.runId, "c1", "verified", "--", "checked"], { cwd: fx.cwd })).code, 0);
  const stale = await council(["export", fx.runId, "report", "--json"], { cwd: fx.cwd });
  assert.deepEqual([stale.code, stale.json.error], [1, "report-stale"]);
});

test("an empty followups.json export is an empty array, and a merge with follow-ups off keeps the collection output", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await merged(t, clock);
  assert.equal((await council(["export", fx.runId, "followups", "--json"], { cwd: fx.cwd })).code, 0);
  assert.equal(fs.readFileSync(path.join(fx.dir, "followups.json"), "utf8"), "[]\n");
  await askProvider(fx, clock, "s2", "c1", 1300, JSON.stringify({ answer: "Yes.", stance: null }));
  const off = await council(["merge", fx.runId, "--json"], { cwd: fx.cwd, extensions: { substitution: true } });
  assert.equal(off.code, 0, off.stdout);
  assert.equal(Object.hasOwn(off.json.merge, "followups"), false);
});

// ---------------------------------------------------------------------------------------------
// The unanimous panel.

test("the panel is unanimous only when every seat validated every other seat's finding and chose the same option", () => {
  const finding = (id) => ({ id, severity: "P2", claim: id, path: null, line: null, evidence: "e" });
  const response = (ref, extra = {}) => ({ finding: ref, response: "validate", disputes: null, sameAs: null, reason: null, evidence: null, ...extra });
  // Three seats; each Round 2 bundle letters the two other seats as A and B.
  const anonymisation = { s1: { A: "s2", B: "s3" }, s2: { A: "s1", B: "s3" }, s3: { A: "s1", B: "s2" } };
  const round1 = { s1: { findings: [finding("f1")] }, s2: { findings: [finding("f1")] }, s3: { findings: [finding("f1")] } };
  const agreeing = (stance = null) => ({ stance, responses: [response("A-f1"), response("B-f1")], added: [] });
  const round2 = { s1: agreeing(), s2: agreeing(), s3: agreeing() };
  const base = { kind: "review", round1, round2, anonymisation };
  assert.equal(unanimousPanel(base), true);
  const changed = (seat, answer) => ({ ...base, round2: { ...round2, [seat]: answer } });
  assert.equal(unanimousPanel(changed("s2", { ...agreeing(), responses: [response("A-f1"), response("B-f1", { response: "challenge", disputes: "claim", reason: "r", evidence: "e" })] })), false);
  assert.equal(unanimousPanel(changed("s2", { ...agreeing(), responses: [response("A-f1"), response("B-f1", { response: "skip" })] })), false);
  assert.equal(unanimousPanel(changed("s3", { ...agreeing(), added: [finding("f2")] })), false);
  // A seat without a valid Round 2 answer leaves the panel incomplete.
  const { s3: _dropped, ...twoAnswers } = round2;
  assert.equal(unanimousPanel({ ...base, round2: twoAnswers }), false);
  // A finding that no other seat was given has no validation from a different seat.
  assert.equal(unanimousPanel({ ...base, anonymisation: { s1: { A: "s2", B: "s1" }, s2: { A: "s1", B: "s2" }, s3: { A: "s1", B: "s2" } } }), false);
  // An empty complete matrix qualifies.
  const empty = { s1: { findings: [] }, s2: { findings: [] } };
  assert.equal(unanimousPanel({ kind: "review", round1: empty, round2: { s1: { stance: null, responses: [], added: [] }, s2: { stance: null, responses: [], added: [] } }, anonymisation: {} }), true);
  // A decision also needs one non-null option at every seat.
  const decision = { ...base, kind: "decision", round2: { s1: agreeing("A"), s2: agreeing("A"), s3: agreeing("A") } };
  assert.equal(unanimousPanel(decision), true);
  assert.equal(unanimousPanel({ ...decision, round2: { ...decision.round2, s3: agreeing("B") } }), false);
  assert.equal(unanimousPanel({ ...decision, round2: { s1: agreeing(null), s2: agreeing(null), s3: agreeing(null) } }), false);
});

test("status, merge and report say when the panel is unanimous, and not when one seat challenged or chose differently", async (t) => {
  const clock = useTestClock(t, 0);
  const agreed = await merged(t, clock);
  const status = await council(["status", agreed.runId, "--json"], { cwd: agreed.cwd });
  assert.equal(status.json.unanimous, true);
  assert.equal((await merge(agreed)).json.unanimous, true);
  for (const id of status.json.clusters) {
    assert.equal((await council(["verdict", agreed.runId, id, "not-checked"], { cwd: agreed.cwd })).code, 0);
  }
  const report = await council(["report", agreed.runId], { cwd: agreed.cwd });
  assert.equal(report.code, 0, report.stderr);
  assert.match(report.stdout, /## Verdict\n\nConfidence: HIGH\n\nUnanimous panel: the leader adds a counterargument\.\n/);
  // One challenge: not unanimous, and the report has no counterargument line.
  const challenged = await merged(t, clock, { answers2: (seat, letterMap) => r2Answer(letterMap, { response: seat === "s3" ? "challenge" : "validate" }) });
  assert.equal((await council(["status", challenged.runId, "--json"], { cwd: challenged.cwd })).json.unanimous, false);
  assert.equal((await merge(challenged)).json.unanimous, false);
  // A decision: unanimous with one option everywhere, not when one seat chose another.
  const decided = await merged(t, clock, { kind: "decision" });
  assert.equal((await council(["status", decided.runId, "--json"], { cwd: decided.cwd })).json.unanimous, true);
  const split = await merged(t, clock, { kind: "decision", answers2: (seat, letterMap) => r2Answer(letterMap, { stance: seat === "s2" ? "B" : "A" }) });
  assert.equal((await council(["status", split.runId, "--json"], { cwd: split.cwd })).json.unanimous, false);
  // Before Round 2 closes the panel is not unanimous.
  const early = await round1Closed(t, clock);
  assert.equal((await council(["status", early.runId, "--json"], { cwd: early.cwd })).json.unanimous, false);
});

// ---------------------------------------------------------------------------------------------
// Round addressing on submit, and the cutoff notice for a carried stand-in.

async function submitInRound(fx, seat, intentId, round, text) {
  const file = path.join(fx.cwd, `reply-${intentId}-${round}.json`);
  fs.writeFileSync(file, text);
  return council(["submit", fx.runId, seat, "--intent", intentId, "--round", String(round), "--file", file, "--json"], { cwd: fx.cwd });
}

test("submit with --round accepts an intent only in its own round: a core prompt, a carry and a follow-up", async (t) => {
  const clock = useTestClock(t, 0);
  const notOpen = (result, intentId, seat, round) => [result.code, result.json.error, result.json.message, intentId, seat, round];
  // A core Round 1 prompt.
  const fx = await started(t, clock);
  clock.set(100);
  const prompt = currentOf(fx, "s1").id;
  const wrong = await submitInRound(fx, "s1", prompt, 2, r1Answer("alpha"));
  assert.deepEqual(notOpen(wrong, prompt, "s1", 2), [1, "intent-not-open", `Intent ${prompt} is not open for s1 in round 2; nothing was recorded.`, prompt, "s1", 2]);
  assert.equal(snap(fx).observations.length, 0);
  assert.equal((await submitInRound(fx, "s1", prompt, 1, r1Answer("alpha"))).json.state, "valid");
  // A carried stand-in answers in Round 2.
  const { fx: carried, sent, map } = await round2WithCarry(t, clock);
  const carry = sent.json.deliveries.find((delivery) => delivery.actor === "s2~r1");
  clock.set(1100);
  assert.equal((await submitInRound(carried, "s2", carry.intentId, 1, r2Answer(map["s2~r1"]))).json.error, "intent-not-open");
  assert.equal(eventOf(carried, carry.intentId, "deposit"), null);
  assert.equal((await submitInRound(carried, "s2", carry.intentId, 2, r2Answer(map["s2~r1"]))).json.state, "valid");
  // A follow-up is addressed as round 2.
  const done = await merged(t, clock);
  clock.set(1300);
  const asked = await followup(done, "s1", "c2");
  assert.equal((await submitInRound(done, "s1", asked.json.intentId, 1, JSON.stringify({ answer: "Yes." }))).json.error, "intent-not-open");
  assert.equal((await submitInRound(done, "s1", asked.json.intentId, 2, JSON.stringify({ answer: "Yes." }))).json.state, "valid");
});

test("a carried stand-in still working when Round 2 is sealed gets the cutoff notice once, for its own agent", async (t) => {
  const clock = useTestClock(t, 0);
  const { fx, sent, map } = await round2WithCarry(t, clock);
  // s1 answers at 1100 and s3's job at 1150: two original families seal Round 2; the carry still works.
  clock.set(1100);
  assert.equal((await submit(fx, "s1", sent.json.deliveries.find((delivery) => delivery.seat === "s1" && !delivery.actor).intentId, r2Answer(map.s1))).json.state, "valid");
  clock.set(1150);
  completeJob(fx, currentOf(fx, "s3", 2).job_id, 1150, r2Answer(map.s3));
  const woke = await collect(fx, { budgetMs: 4000 });
  assert.equal(woke.json.wake, "notice", woke.stdout);
  assert.notEqual(roundRow(fx, 2).cutoff_at, null);
  const notices = woke.json.deliveries.filter((delivery) => delivery.kind === "notice");
  assert.deepEqual(notices, [{ kind: "notice", seat: "s2", actor: "s2~r1", text: "The other seats of the panel have answered. You have five minutes from now to give your answer in the required JSON form; after that the round closes without it." }]);
  // The notice is handed once: neither status nor a later collect hands it again.
  assert.equal((await council(["status", fx.runId, "--json"], { cwd: fx.cwd })).json.deliveries.some((delivery) => delivery.kind === "notice"), false);
  assert.equal((await collect(fx, { budgetMs: 4000 })).json.deliveries.some((delivery) => delivery.kind === "notice"), false);
});
