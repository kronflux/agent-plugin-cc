// Layer 2 of the council: the five-minute cutoff after quorum and the notice to the seats still
// working, on real store transactions with the test wall clock, fake provider job builders and no
// usage evidence.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { CUTOFF_NOTICE } from "../plugins/agent/scripts/lib/council/prompts.mjs";
import { COUNCIL_LAYER, GRACE_MS, continueBindingHook, readCouncil, startRound2 } from "../plugins/agent/scripts/lib/council/state.mjs";
import { installObject } from "../plugins/agent/scripts/lib/council/objects.mjs";
import { decideNext, resolveStateDir } from "../plugins/agent/scripts/lib/state.mjs";
import { openStore } from "../plugins/agent/scripts/lib/store.mjs";
import { handleCouncil } from "../plugins/agent/scripts/commands/council.mjs";
import { makeTempDir } from "./helpers.mjs";
import { EPOCH, bindAttempt, freshAttemptId, observe, openCouncilStore, receive, reduce, seatJobFields, seedRun, setJob, useTestClock } from "./council-helpers.mjs";

const T_LONG = 1000000;
const hex = (character) => character.repeat(64);
const iso = (at) => new Date(EPOCH + at).toISOString();

function finding(id) {
  return { id, severity: "P2", claim: `${id} claim`, path: "src/a.mjs", line: 1, evidence: `${id} evidence` };
}

const VALID = JSON.stringify({ schema: 1, stance: null, confidence: "high", dealbreaker: null, findings: [finding("f1")], assumptions: [], wouldChangeMind: "a failing test" });
const INVALID = JSON.stringify({ schema: 1 });

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

// Runs one council subcommand in this process at `layer` (2 unless given), with fake provider
// checks, a job builder that keeps the prompt it was given, no launch and no usage evidence.
async function council(argv, { cwd, layer = 2, advance = {} }) {
  const out = [];
  const err = [];
  const time = fakeTime();
  const code = await handleCouncil([argv[0], "--cwd", cwd, ...argv.slice(1)], {
    layer,
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

// A council started at wall 0 through `council start` (s1 Claude, s2 Codex, s3 Antigravity); the
// start pass created the two provider jobs, which stay queued until a test claims them.
async function started(t, clock, { layer = 2 } = {}) {
  clock.set(0);
  const cwd = makeTempDir(t);
  const stateDir = resolveStateDir(cwd);
  const store = openStore(stateDir);
  t.after(() => store.close());
  const brief = path.join(cwd, "brief.json");
  fs.writeFileSync(brief, JSON.stringify({ question: "Is the cache correct?", targets: ["src"], kind: "review" }));
  const result = await council(["start", "--brief", brief, "--timeout-ms", String(T_LONG), "--json"], { cwd, layer });
  assert.equal(result.code, 0, result.stderr);
  return { cwd, store, runId: result.json.runId, dir: path.join(stateDir, "council", result.json.runId) };
}

const snapshot = (fx) => readCouncil(fx.store, fx.runId);
const seatRow = (fx, seat, round = 1) => snapshot(fx).seatRounds.find((row) => row.round === round && row.seat === seat);
const attemptsOf = (fx, seat, round = 1) => snapshot(fx).attempts.filter((row) => row.round === round && row.seat === seat);
const roundRow = (fx, round = 1) => snapshot(fx).rounds.find((row) => row.round === round);

function currentOf(fx, seat, round = 1) {
  const id = seatRow(fx, seat, round).current_id;
  return snapshot(fx).attempts.find((row) => row.id === id);
}

function jobRow(fx, jobId) {
  return fx.store.read((db) => ({ ...db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) }));
}

function messagesOf(fx, jobId) {
  return fx.store.read((db) => db.prepare("SELECT * FROM messages WHERE chain_id = (SELECT chain_id FROM jobs WHERE id = ?) ORDER BY id").all(jobId).map((row) => ({ ...row })));
}

// Marks a job claimed and started 5 ms before `at`, with its execution live.
function runJob(fx, jobId, at) {
  setJob(fx.store, jobId, { claimed_at: EPOCH + at - 5, started_at: EPOCH + at - 5 });
}

function completeJob(fx, jobId, at, resultJson) {
  setJob(fx.store, jobId, {
    claimed_at: EPOCH + at - 5,
    started_at: EPOCH + at - 5,
    end_at: EPOCH + at,
    exec_released_at: EPOCH + at,
    release_kind: "confirmed",
    end_state: "completed",
    result_json: resultJson
  });
}

async function submit(fx, seat, intentId, text, name = "reply.json") {
  const file = path.join(fx.cwd, name);
  fs.writeFileSync(file, text);
  return council(["submit", fx.runId, seat, "--intent", intentId, "--file", file, "--json"], { cwd: fx.cwd });
}

function collect(fx, { round = 1, budgetMs = 6000, advance = {} } = {}) {
  return council(["collect", fx.runId, "--round", String(round), "--disallow-substitute", "--budget-ms", String(budgetMs), "--json"], { cwd: fx.cwd, advance });
}

async function status(fx) {
  const result = await council(["status", fx.runId, "--json"], { cwd: fx.cwd });
  assert.equal(result.code, 0, result.stderr);
  return result.json;
}

const noticesIn = (deliveries) => deliveries.filter((delivery) => delivery.kind === "notice");
const noticeFor = (seat) => ({ kind: "notice", seat, text: CUTOFF_NOTICE });

// A started council where s1 (Claude) and s3 (Antigravity) answered valid at 100, which seals
// Round 1; s2's job is running unless `s2Running` is false.
async function sealedAt100(t, clock, { s2Running = true } = {}) {
  const fx = await started(t, clock);
  clock.set(100);
  if (s2Running) {
    runJob(fx, currentOf(fx, "s2").job_id, 100);
  }
  completeJob(fx, currentOf(fx, "s3").job_id, 100, VALID);
  const accepted = await submit(fx, "s1", currentOf(fx, "s1").id, VALID);
  assert.equal(accepted.code, 0, accepted.stderr);
  return fx;
}

test("the shipped layer is 2, and the time after quorum is five minutes", () => {
  assert.equal(COUNCIL_LAYER, 2);
  assert.equal(GRACE_MS, 300000);
  assert.match(CUTOFF_NOTICE, /five minutes from now/);
});

test("two valid families at 100 seal the round with the cutoff at 300100, and the round stays open", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await sealedAt100(t, clock);
  assert.deepEqual([roundRow(fx).quorum_at - EPOCH, roundRow(fx).cutoff_at - EPOCH, roundRow(fx).closed_at], [100, 300100, null]);
  const open = (await status(fx)).rounds[0];
  assert.deepEqual([open.quorumAt, open.cutoffAt, open.closedAt, open.quorum], [iso(100), iso(300100), null, null]);
  assert.equal(seatRow(fx, "s2").state, "running");
  // Before the cutoff a collect leaves the round open; the cutoff never moves.
  clock.set(300099);
  assert.equal((await collect(fx)).json.wake, "budget");
  assert.deepEqual([roundRow(fx).quorum_at - EPOCH, roundRow(fx).cutoff_at - EPOCH, roundRow(fx).closed_at], [100, 300100, null]);
});

test("a third seat that answers valid before the cutoff counts, and the round closes at once", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await sealedAt100(t, clock);
  clock.set(200000);
  completeJob(fx, currentOf(fx, "s2").job_id, 200000, VALID);
  const closed = await collect(fx);
  assert.equal(closed.code, 0, closed.stdout);
  assert.deepEqual(
    [closed.json.wake, closed.json.quorum, closed.json.validSeats, closed.json.quorumAt, closed.json.cutoffAt, closed.json.closedAt],
    ["closed", true, 3, iso(100), iso(300100), iso(200000)]
  );
  assert.equal(snapshot(fx).stops.length, 0);
});

test("a silent third seat ends timed-out at the cutoff, its running job gets an exact stop, and collect returns the quorum result", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await sealedAt100(t, clock);
  const jobId = currentOf(fx, "s2").job_id;
  clock.set(300100);
  const closed = await collect(fx);
  assert.equal(closed.code, 0, closed.stdout);
  assert.deepEqual([closed.json.wake, closed.json.quorum, closed.json.validSeats, closed.json.cleanupPending], ["closed", true, 2, false]);
  assert.deepEqual(closed.json.seats.find((seat) => seat.seat === "s2").state, "timed-out");
  assert.deepEqual([seatRow(fx, "s2").state, seatRow(fx, "s2").reason], ["timed-out", "quorum cutoff"]);
  // The council's stop names the exact job, was dispatched through the stop request, and nothing
  // else was stopped.
  const stops = snapshot(fx).stops;
  assert.deepEqual(stops.map((stop) => [stop.job_id, stop.cause, stop.requested_at - EPOCH]), [[jobId, "quorum-cutoff", 300100]]);
  assert.notEqual(stops[0].acknowledged_at, null);
  assert.notEqual(jobRow(fx, jobId).cancel_requested_at, null);
  assert.equal(jobRow(fx, currentOf(fx, "s3").job_id).cancel_requested_at, null);
  // No attempt was issued after the cutoff.
  assert.deepEqual(attemptsOf(fx, "s2").map((row) => row.charge), ["turn"]);
});

test("without quorum there is no seal and no cutoff, and the ordinary time limit applies", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await started(t, clock);
  clock.set(100);
  runJob(fx, currentOf(fx, "s2").job_id, 10);
  // Only one family is valid: s3 failed permanently.
  const s3 = currentOf(fx, "s3");
  setJob(fx.store, s3.job_id, { claimed_at: EPOCH + 50, started_at: EPOCH + 50, end_at: EPOCH + 100, exec_released_at: EPOCH + 100, release_kind: "confirmed", end_state: "failed", error: "permission denied" });
  assert.deepEqual(await observe(fx.store, s3.id, s3.job_id, { outcome: "failure", eventAt: EPOCH + 100, reason: "provider failure" }, 2), { ok: true });
  assert.equal((await submit(fx, "s1", currentOf(fx, "s1").id, VALID)).code, 0);
  await collect(fx);
  assert.equal(seatRow(fx, "s3").state, "error");
  assert.deepEqual([roundRow(fx).quorum_at, roundRow(fx).cutoff_at], [null, null]);
  clock.set(300100);
  assert.equal((await collect(fx)).json.wake, "budget");
  assert.deepEqual([seatRow(fx, "s2").state, snapshot(fx).stops.length, roundRow(fx).closed_at], ["running", 0, null]);
  // The execution limit of s2's job (claimed at 5) is T later: B6 stops it for its deadline.
  clock.set(T_LONG + 5);
  await collect(fx);
  assert.deepEqual(snapshot(fx).stops.map((stop) => stop.cause), ["deadline"]);
});

test("after the cutoff an invalid answer in hand is classified without a repair", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await sealedAt100(t, clock);
  // s2 ended invalid at 300050, before the cutoff, but nothing observed it until 300100.
  completeJob(fx, currentOf(fx, "s2").job_id, 300050, INVALID);
  clock.set(300100);
  const closed = await collect(fx);
  assert.deepEqual([closed.json.wake, closed.json.quorum, closed.json.repairs, closed.json.retries], ["closed", true, 0, 0]);
  assert.deepEqual([seatRow(fx, "s2").state, seatRow(fx, "s2").reason], ["invalid", "schema validation failed"]);
  assert.deepEqual(attemptsOf(fx, "s2").map((row) => row.charge), ["turn"]);
  assert.equal(snapshot(fx).stops.length, 0);
});

test("a seat whose repair is in flight at the seal still has only until the cutoff", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await started(t, clock);
  clock.set(50);
  completeJob(fx, currentOf(fx, "s2").job_id, 50, INVALID);
  await collect(fx);
  const repair = currentOf(fx, "s2");
  assert.equal(repair.charge, "repair");
  assert.ok(repair.issue_by - EPOCH > 300100);
  clock.set(100);
  completeJob(fx, currentOf(fx, "s3").job_id, 100, VALID);
  assert.equal((await submit(fx, "s1", currentOf(fx, "s1").id, VALID)).code, 0);
  assert.equal(roundRow(fx).cutoff_at - EPOCH, 300100);
  clock.set(300100);
  const closed = await collect(fx);
  assert.deepEqual([closed.json.wake, closed.json.quorum, closed.json.repairs], ["closed", true, 1]);
  assert.deepEqual([seatRow(fx, "s2").state, seatRow(fx, "s2").reason], ["timed-out", "quorum cutoff"]);
  // The repair's queued job is the seat's live tip: it gets the exact cutoff stop.
  assert.deepEqual(snapshot(fx).stops.map((stop) => [stop.job_id, stop.cause]), [[repair.job_id, "quorum-cutoff"]]);
});

test("the Claude seat's notice is handed once, by a running collect or by status, and its answer after the notice counts", async (t) => {
  const clock = useTestClock(t, 0);
  // A collect that seals the round returns at once with the notice for s1.
  {
    const fx = await started(t, clock);
    clock.set(100);
    completeJob(fx, currentOf(fx, "s2").job_id, 100, VALID);
    completeJob(fx, currentOf(fx, "s3").job_id, 100, VALID);
    const woke = await collect(fx, { budgetMs: 120000 });
    assert.equal(woke.code, 0, woke.stderr);
    assert.equal(woke.json.wake, "notice", woke.stdout);
    assert.deepEqual(noticesIn(woke.json.deliveries), [noticeFor("s1")]);
    // The prompt delivery is still listed; the notice is not a prompt and has no intent.
    assert.deepEqual(woke.json.deliveries.filter((delivery) => delivery.kind !== "notice").map((delivery) => delivery.intentId), [currentOf(fx, "s1").id]);
    assert.deepEqual(noticesIn((await status(fx)).deliveries), []);
    assert.equal((await collect(fx)).json.wake, "budget");
    // The answer after the notice counts like any other answer before the cutoff, and consumes
    // no repair, retry or member turn.
    clock.set(200);
    const accepted = await submit(fx, "s1", currentOf(fx, "s1").id, VALID);
    assert.deepEqual([accepted.code, accepted.json.state], [0, "valid"]);
    const closed = await collect(fx);
    assert.deepEqual([closed.json.wake, closed.json.validSeats, closed.json.memberTurns, closed.json.repairs, closed.json.retries], ["closed", 3, 3, 0, 0]);
  }
  // A round sealed by a reduction that handed nothing: the first status hands the notice.
  {
    const fx = await started(t, clock);
    clock.set(100);
    for (const seat of ["s2", "s3"]) {
      const attempt = currentOf(fx, seat);
      completeJob(fx, attempt.job_id, 100, VALID);
      assert.deepEqual(await observe(fx.store, attempt.id, attempt.job_id, { outcome: "valid", eventAt: EPOCH + 100, answerSha256: hex(seat.slice(1)) }, 2), { ok: true });
    }
    await reduce(fx.store, fx.runId, 1, 2);
    assert.equal(roundRow(fx).cutoff_at - EPOCH, 300100);
    const first = await status(fx);
    assert.deepEqual(noticesIn(first.deliveries), [noticeFor("s1")]);
    assert.deepEqual(noticesIn((await status(fx)).deliveries), []);
    const again = await collect(fx);
    assert.deepEqual([again.json.wake, noticesIn(again.json.deliveries)], ["budget", []]);
  }
});

test("a provider seat's notice goes once into a running turn that takes messages, and to no other seat", async (t) => {
  const clock = useTestClock(t, 0);
  // Codex takes a message into a running turn: one message with the notice text, sent once.
  {
    const fx = await sealedAt100(t, clock);
    const jobId = currentOf(fx, "s2").job_id;
    assert.deepEqual(messagesOf(fx, jobId).map((row) => [row.text, row.state]), [[CUTOFF_NOTICE, "pending"]]);
    await collect(fx);
    assert.equal(messagesOf(fx, jobId).length, 1);
    // The notice is not an attempt: no repair, retry or member turn, and no deadline moved.
    assert.deepEqual(attemptsOf(fx, "s2").map((row) => row.charge), ["turn"]);
    assert.equal(roundRow(fx).cutoff_at - EPOCH, 300100);
    // A valid answer after the notice counts.
    clock.set(200000);
    completeJob(fx, jobId, 200000, VALID);
    const closed = await collect(fx);
    assert.deepEqual([closed.json.wake, closed.json.validSeats], ["closed", 3]);
  }
  // Antigravity would hold the message and continue in a new job: no notice.
  {
    const fx = await started(t, clock);
    clock.set(100);
    const agyJob = currentOf(fx, "s3").job_id;
    runJob(fx, agyJob, 100);
    completeJob(fx, currentOf(fx, "s2").job_id, 100, VALID);
    assert.equal((await submit(fx, "s1", currentOf(fx, "s1").id, VALID)).code, 0);
    assert.equal(roundRow(fx).cutoff_at - EPOCH, 300100);
    await collect(fx);
    assert.deepEqual(messagesOf(fx, agyJob), []);
    assert.equal(jobRow(fx, agyJob).next_action, null);
  }
  // A seat whose job has not started gets no notice, now or later.
  {
    const fx = await sealedAt100(t, clock, { s2Running: false });
    const jobId = currentOf(fx, "s2").job_id;
    assert.deepEqual(messagesOf(fx, jobId), []);
    runJob(fx, jobId, 200);
    clock.set(200);
    await collect(fx);
    assert.deepEqual(messagesOf(fx, jobId), []);
  }
  // A failed send is a diagnostic and changes nothing in the round.
  {
    const fx = await started(t, clock);
    clock.set(100);
    const jobId = currentOf(fx, "s2").job_id;
    runJob(fx, jobId, 100);
    assert.equal((await submit(fx, "s1", currentOf(fx, "s1").id, VALID)).code, 0);
    completeJob(fx, currentOf(fx, "s3").job_id, 100, VALID);
    const failing = async () => {
      throw new Error("the store is busy");
    };
    const result = await collect(fx, { advance: { sendMessage: failing } });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.json.diagnostics, [{ seat: "s2", jobId, notice: "not-sent", message: "the store is busy" }]);
    assert.match(result.stderr, /Seat s2: the cutoff notice was not delivered to job/);
    assert.deepEqual([seatRow(fx, "s2").state, roundRow(fx).cutoff_at - EPOCH, roundRow(fx).closed_at], ["running", 300100, null]);
    assert.deepEqual(attemptsOf(fx, "s2").map((row) => row.charge), ["turn"]);
    assert.deepEqual(messagesOf(fx, jobId), []);
    // It is not tried again.
    await collect(fx);
    assert.deepEqual(messagesOf(fx, jobId), []);
  }
});

test("a notice no running turn took is withdrawn once its job has ended", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await sealedAt100(t, clock);
  const jobId = currentOf(fx, "s2").job_id;
  assert.equal(messagesOf(fx, jobId)[0].state, "pending");
  clock.set(200000);
  completeJob(fx, jobId, 200000, VALID);
  const closed = await collect(fx);
  assert.equal(closed.json.wake, "closed");
  assert.deepEqual(messagesOf(fx, jobId).map((row) => [row.state, row.close_cause]), [["withdrawn", "withdrawn"]]);
});

test("a round seeded at layer 1 and reduced at layer 2 closes, and Round 2 seals and cuts off on its own", async (t) => {
  const clock = useTestClock(t, 0);
  const { store, runDir } = openCouncilStore(t);
  const { seats } = await seedRun(store, runDir, { layer: 1, timeoutMs: T_LONG });
  const ids = Object.fromEntries(seats.map((seat) => [seat.seat, seat.attemptId]));
  const rounds = () => readCouncil(store, "run-1").rounds;
  const seatState = (seat, round) => readCouncil(store, "run-1").seatRounds.find((row) => row.round === round && row.seat === seat);
  const ended = (jobId, at) => setJob(store, jobId, { claimed_at: EPOCH + at, started_at: EPOCH + at, end_state: "completed", end_at: EPOCH + at, exec_released_at: EPOCH + at, release_kind: "confirmed" });
  // Round 1: s1 and s2 valid at 10 seal it; s3 answers valid at 20, before the cutoff.
  clock.set(10);
  const job2 = bindAttempt(store, ids.s2).jobId;
  const job3 = bindAttempt(store, ids.s3, { provider: "agy" }).jobId;
  ended(job2, 10);
  assert.deepEqual(await receive(store, "run-1", "s1", ids.s1, { outcome: "valid", answerSha256: hex("1") }, 2), { ok: true, round: 1 });
  assert.deepEqual(await observe(store, ids.s2, job2, { outcome: "valid", eventAt: EPOCH + 10, answerSha256: hex("2") }, 2), { ok: true });
  await reduce(store, "run-1", 1, 2);
  assert.deepEqual([rounds()[0].quorum_at - EPOCH, rounds()[0].cutoff_at - EPOCH, rounds()[0].closed_at], [10, 300010, null]);
  clock.set(20);
  ended(job3, 20);
  assert.deepEqual(await observe(store, ids.s3, job3, { outcome: "valid", eventAt: EPOCH + 20, answerSha256: hex("3") }, 2), { ok: true });
  assert.deepEqual(await reduce(store, "run-1", 1, 2), { ok: true, changed: true, closed: true });
  assert.deepEqual([rounds()[0].quorum, rounds()[0].closed_at - EPOCH], [1, 20]);

  // Round 2 at 1000: s2 and s3 answer valid at 1010, which seals Round 2 alone.
  clock.set(1000);
  const mapSha256 = installObject(runDir("run-1"), '{"s1":{}}\n', "json");
  const entries = ["s1", "s2", "s3"].map((seat) => ({ seat, attemptId: freshAttemptId(), promptSha256: installObject(runDir("run-1"), `Round 2 prompt for ${seat}\n`, "md"), mapSha256 }));
  assert.deepEqual(await startRound2(store, { runId: "run-1", mapSha256, entries, layer: 2, deadline: performance.now() + 10000 }), { ok: true });
  const r2 = Object.fromEntries(entries.map((entry) => [entry.seat, entry.attemptId]));
  for (const [seat, predecessorId] of [["s2", job2], ["s3", job3]]) {
    const decision = decideNext(
      store,
      { ref: predecessorId, observedTipId: predecessorId },
      { action: "continue", message: "round 2", requester: { sessionId: "session-1" }, withinDecision: continueBindingHook({ attemptId: r2[seat], predecessorId, layer: 2 }) }
    );
    assert.equal(decision.won, true, seat);
    clock.set(1010);
    ended(decision.successorId, 1010);
    assert.deepEqual(await observe(store, r2[seat], decision.successorId, { outcome: "valid", eventAt: EPOCH + 1010, answerSha256: hex(seat.slice(1)) }, 2), { ok: true });
  }
  await reduce(store, "run-1", 2, 2);
  assert.deepEqual([rounds()[1].quorum_at - EPOCH, rounds()[1].cutoff_at - EPOCH, rounds()[1].closed_at], [1010, 301010, null]);
  assert.deepEqual([rounds()[0].quorum_at - EPOCH, rounds()[0].cutoff_at - EPOCH], [10, 300010]);
  // The silent Claude seat is cut off at Round 2's own cutoff, not Round 1's.
  clock.set(301009);
  await reduce(store, "run-1", 2, 2);
  assert.equal(seatState("s1", 2).state, "running");
  clock.set(301010);
  assert.deepEqual(await reduce(store, "run-1", 2, 2), { ok: true, changed: true, closed: true });
  assert.deepEqual([seatState("s1", 2).state, seatState("s1", 2).reason, rounds()[1].quorum], ["timed-out", "quorum cutoff", 1]);
  // A receipt after the cutoff is refused.
  assert.equal((await receive(store, "run-1", "s1", r2.s1, { outcome: "valid", answerSha256: hex("1") }, 2)).reason, "intent-not-open");
});
