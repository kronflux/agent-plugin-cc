// Library-level replays of the Layer 0 collection schedules, on real store transactions and the
// test wall clock. All times are milliseconds relative to EPOCH; T is 1000 unless a test says so.
import test from "node:test";
import assert from "node:assert/strict";

import {
  EPOCH,
  bindAttempt,
  closeRound1ByReduce,
  freshAttemptId,
  observe,
  openCouncilStore,
  receive,
  reduce,
  rel,
  seedRun,
  setJob,
  sql,
  useTestClock
} from "./council-helpers.mjs";
import { decideNext } from "../plugins/agent/scripts/lib/state.mjs";
import { installObject } from "../plugins/agent/scripts/lib/council/objects.mjs";
import { providerTiming } from "../plugins/agent/scripts/lib/council/reduce.mjs";
import { CouncilFenceError, acknowledgeStop, continueBindingHook, readCouncil, startRound2 } from "../plugins/agent/scripts/lib/council/state.mjs";

const hex = (character) => character.repeat(64);
const DEADLINE = () => performance.now() + 10000;
const VALID = { outcome: "valid", answerSha256: hex("a") };

function seatRound(store, seat, round = 1) {
  return readCouncil(store, "run-1").seatRounds.find((row) => row.round === round && row.seat === seat);
}

async function seeded(t, clock, options = {}) {
  clock.set(options.at ?? 0);
  const fixture = openCouncilStore(t);
  const { seats } = await seedRun(fixture.store, fixture.runDir, options);
  return { ...fixture, ids: Object.fromEntries(seats.map((seat) => [seat.seat, seat.attemptId])) };
}

test("layer 0 schedule DR-01, BR-02, T=1000", async (t) => {
  const clock = useTestClock(t, 0);
  // Order A: the receipt commits at 999, the collector reduces at 1005, the submit's reduce at 1020.
  {
    const { store, ids } = await seeded(t, clock);
    clock.set(990);
    clock.set(999);
    assert.deepEqual(await receive(store, "run-1", "s1", ids.s1, VALID), { ok: true, round: 1 });
    clock.set(1005);
    await reduce(store);
    const accepted = seatRound(store, "s1");
    assert.deepEqual([accepted.state, accepted.answer_sha256, rel(accepted.final_at)], ["valid", hex("a"), 1005]);
    clock.set(1020);
    assert.equal((await reduce(store)).changed, false);
    assert.deepEqual(seatRound(store, "s1"), accepted);
    assert.equal(readCouncil(store, "run-1").run.input_rev, 2);
  }
  // Order B: the collector reduces at 1005 before the deposit attempt at 1020.
  {
    const { store, ids } = await seeded(t, clock);
    clock.set(1005);
    await reduce(store);
    assert.deepEqual([seatRound(store, "s1").state, seatRound(store, "s1").reason], ["timed-out", "reply deadline expired"]);
    clock.set(1020);
    assert.deepEqual(await receive(store, "run-1", "s1", ids.s1, VALID), { ok: false, reason: "intent-not-open", round: 1 });
    assert.equal((await reduce(store)).changed, false);
    assert.equal(readCouncil(store, "run-1").observations.length, 0);
  }
  // A submit at 1050 before a collector at 1060: refused, and its own reduce expires B4 once.
  {
    const { store, ids } = await seeded(t, clock);
    clock.set(1050);
    assert.deepEqual(await receive(store, "run-1", "s1", ids.s1, VALID), { ok: false, reason: "intent-not-open", round: 1 });
    await reduce(store);
    const expired = seatRound(store, "s1");
    assert.deepEqual([expired.state, rel(expired.final_at)], ["timed-out", 1050]);
    clock.set(1060);
    assert.equal((await reduce(store)).changed, false);
    assert.deepEqual(seatRound(store, "s1"), expired);
  }
  // The collector commits at wall 1060, the wall is set back to 1050, then the submit enters.
  {
    const { store, ids } = await seeded(t, clock);
    clock.set(1060);
    await reduce(store);
    const expired = seatRound(store, "s1");
    assert.deepEqual([expired.state, rel(expired.final_at)], ["timed-out", 1060]);
    clock.set(1050);
    assert.deepEqual(await receive(store, "run-1", "s1", ids.s1, VALID), { ok: false, reason: "intent-not-open", round: 1 });
    assert.equal((await reduce(store)).changed, false);
    assert.deepEqual(seatRound(store, "s1"), expired);
    assert.equal(rel(readCouncil(store, "run-1").run.clock), 1060);
  }
  // A successful submit at 500 with no collector reaches B4 before it prints.
  {
    const { store, ids } = await seeded(t, clock);
    clock.set(500);
    assert.deepEqual(await receive(store, "run-1", "s1", ids.s1, VALID), { ok: true, round: 1 });
    await reduce(store);
    assert.deepEqual([seatRound(store, "s1").state, rel(seatRound(store, "s1").final_at)], ["valid", 500]);
  }
});

test("layer 0 schedule DR-02, BR-03, T=1000", async (t) => {
  const clock = useTestClock(t, 0);
  // Bind at wall 900, return the wall to 100, reduce an observed completion at 101.
  {
    const { store, ids } = await seeded(t, clock);
    clock.set(900);
    const jobId = bindAttempt(store, ids.s2).jobId;
    clock.set(100);
    setJob(store, jobId, { claimed_at: EPOCH + 100, end_state: "completed", end_at: EPOCH + 100 });
    assert.deepEqual(await observe(store, ids.s2, jobId, { outcome: "valid", eventAt: EPOCH + 100, answerSha256: hex("b") }), { ok: true });
    clock.set(101);
    await reduce(store);
    const row = seatRound(store, "s2");
    assert.equal(row.state, "valid");
    assert.ok(rel(row.final_at) >= 900, `final_at ${rel(row.final_at)}`);
    const attempt = readCouncil(store, "run-1").attempts.find((entry) => entry.id === ids.s2);
    assert.ok(rel(attempt.retired_at) >= 900);
    assert.equal(rel(readCouncil(store, "run-1").run.clock), 900);
  }
  // Ratchet a run from 1000 to 4,000,000, return the wall to 1010, seed and bind a later round's
  // job at 1010 and claim it at 1020.
  const { store, runDir } = await seeded(t, clock, { at: 1000 });
  const { job2 } = await closeRound1ByReduce(store, "run-1", clock, { at: 1000 });
  clock.set(4000000);
  await reduce(store);
  assert.equal(rel(readCouncil(store, "run-1").run.clock), 4000000);
  clock.set(1010);
  const mapSha256 = installObject(runDir("run-1"), '{"s1":{}}\n', "json");
  const entries = ["s1", "s2", "s3"].map((seat) => ({
    seat,
    attemptId: freshAttemptId(),
    promptSha256: installObject(runDir("run-1"), `Round 2 prompt for ${seat}\n`, "md"),
    mapSha256
  }));
  assert.deepEqual(await startRound2(store, { runId: "run-1", mapSha256, entries, layer: 0, deadline: DEADLINE() }), { ok: true });
  const r2 = Object.fromEntries(entries.map((entry) => [entry.seat, entry.attemptId]));
  const prompt = readCouncil(store, "run-1").attempts.find((attempt) => attempt.id === r2.s1);
  assert.deepEqual([rel(prompt.created_at), rel(prompt.issue_by)], [4000000, 4001000]);
  const decision = decideNext(
    store,
    { ref: job2, observedTipId: job2 },
    { action: "continue", message: "round 2", requester: { sessionId: "session-1" }, withinDecision: continueBindingHook({ attemptId: r2.s2, predecessorId: job2, layer: 0 }) }
  );
  assert.equal(decision.won, true);
  const successor = decision.successorId;
  clock.set(1020);
  setJob(store, successor, { claimed_at: EPOCH + 1020, started_at: EPOCH + 1020 });
  for (const wall of [1030, 2019]) {
    clock.set(wall);
    await reduce(store, "run-1", 2);
    assert.equal(readCouncil(store, "run-1").stops.length, 0, `no stop at ${wall}`);
  }
  clock.set(2020);
  await reduce(store, "run-1", 2);
  const stops = readCouncil(store, "run-1").stops;
  assert.deepEqual(stops.map((stop) => [stop.job_id, stop.cause, rel(stop.requested_at)]), [[successor, "deadline", 4000000]]);
  // A write at 2050 and a rollback to 2040 leave the run clock at its high-water mark.
  clock.set(2050);
  assert.deepEqual(await acknowledgeStop(store, { jobId: successor, selected: true, deadline: DEADLINE() }), { ok: true });
  clock.set(2040);
  await reduce(store, "run-1", 2);
  assert.equal(rel(readCouncil(store, "run-1").run.clock), 4000000);
  // The Claude prompt created at 4,000,000 reaches B4 only at wall 4,001,000; the stop dispatched
  // at 4,000,000 reaches B7 only at wall 4,120,000.
  assert.equal(rel(readCouncil(store, "run-1").stops[0].dispatched_at), 4000000);
  for (const wall of [10000, 100000, 3000000]) {
    clock.set(wall);
    await reduce(store, "run-1", 2);
    assert.equal(seatRound(store, "s1", 2).state, "running", `s1 at ${wall}`);
    assert.equal(seatRound(store, "s2", 2).state, "running", `s2 at ${wall}`);
  }
  clock.set(4001000);
  await reduce(store, "run-1", 2);
  assert.deepEqual([seatRound(store, "s1", 2).state, seatRound(store, "s1", 2).reason], ["timed-out", "reply deadline expired"]);
  assert.equal(seatRound(store, "s2", 2).state, "running");
  clock.set(4119999);
  await reduce(store, "run-1", 2);
  assert.equal(seatRound(store, "s2", 2).state, "running");
  clock.set(4120000);
  await reduce(store, "run-1", 2);
  assert.deepEqual([seatRound(store, "s2", 2).state, seatRound(store, "s2", 2).reason, rel(seatRound(store, "s2", 2).final_at)], [
    "timed-out",
    "execution deadline expired",
    4120000
  ]);
});

test("layer 0 schedule DR-03, AR-01, T=1000", async (t) => {
  const clock = useTestClock(t, 0);
  for (const legacyStop of [false, true]) {
    const { store, ids } = await seeded(t, clock);
    clock.set(5);
    const ended = bindAttempt(store, ids.s2).jobId;
    const live = bindAttempt(store, ids.s3, { provider: "agy" }).jobId;
    setJob(store, ended, { claimed_at: EPOCH + 10, started_at: EPOCH + 10, end_state: "completed", end_at: EPOCH + 50 });
    setJob(store, live, { claimed_at: EPOCH + 10, started_at: EPOCH + 10 });
    if (legacyStop) {
      clock.set(20);
      sql(store, ["INSERT INTO council_stops (job_id, requested_at, cause, dispatched_at, acknowledged_at) VALUES (?, ?, 'deadline', ?, ?)", ended, EPOCH + 20, EPOCH + 20, EPOCH + 20]);
    }
    // The submit's reduce at 120050 sees the ended job unobserved and still only hook-bound.
    clock.set(120050);
    await reduce(store);
    assert.equal(seatRound(store, "s2").state, "running", `legacy stop ${legacyStop}`);
    assert.equal(seatRound(store, "s2").final_at, null);
    const stops = readCouncil(store, "run-1").stops.filter((stop) => stop.job_id === live);
    assert.deepEqual(stops.map((stop) => [stop.cause, rel(stop.requested_at)]), [["deadline", 120050]]);
    assert.equal(seatRound(store, "s3").state, "running");
    // The observation at 120051 settles the ended seat by B5.
    clock.set(120051);
    const timing = providerTiming(readJob(store, ended), 1000);
    assert.deepEqual(timing, { timely: true, reason: null });
    assert.deepEqual(await observe(store, ids.s2, ended, { outcome: "valid", eventAt: EPOCH + 50, answerSha256: hex("b") }), { ok: true });
    await reduce(store);
    assert.deepEqual([seatRound(store, "s2").state, rel(seatRound(store, "s2").final_at)], ["valid", 120051]);
  }
});

function readJob(store, jobId) {
  return store.read((db) => ({ ...db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) }));
}

function refused(store, sqlText, pattern) {
  assert.throws(() => sql(store, sqlText), pattern, sqlText);
}

test("layer 0 schedule DR-04, DR-07, BR-03, T=1000", async (t) => {
  const clock = useTestClock(t, 0);
  const { store, ids } = await seeded(t, clock);
  // At 0: malformed shapes, an attempt before its seat round, a cross-seat current id and a
  // dangling deferred reference are refused.
  const brief = hex("b");
  refused(
    store,
    `INSERT INTO council_runs (id, kind, cwd, brief_sha256, options_json, timeout_ms, seat_count, turn_cap, created_at, clock) VALUES ('run-x', 'review', '/w', '${brief.slice(1)}', '[]', 1000, 3, 12, 0, 0)`,
    /CHECK constraint failed/
  );
  refused(store, `INSERT INTO council_observations (attempt_id, observed_at, event_at, outcome, reason) VALUES ('${ids.s2}', 0, 0, 'missing', 'job pruned or missing')`, /CHECK constraint failed/);
  sql(store, "INSERT INTO council_seats (run_id, seat, family, provider, lens, label, created_at) VALUES ('run-1', 's4', 'codex', 'codex', 'cost', 'run-1-s4', 0)");
  refused(
    store,
    `INSERT INTO council_attempts (id, run_id, round, seat, kind, created_at, issue_by, prompt_sha256) VALUES ('${freshAttemptId()}', 'run-1', 1, 's4', 'create', 0, 1000, '${hex("4")}')`,
    /FOREIGN KEY constraint failed/
  );
  refused(store, `INSERT INTO council_seat_rounds (run_id, round, seat, state, current_id) VALUES ('run-1', 1, 's4', 'issuing', '${ids.s2}')`, /FOREIGN KEY constraint failed/);
  refused(store, `INSERT INTO council_seat_rounds (run_id, round, seat, state, current_id) VALUES ('run-1', 1, 's4', 'issuing', '${freshAttemptId()}')`, /FOREIGN KEY constraint failed/);

  // At 1: bind and deposit; the reduce closes the round on these facts.
  clock.set(1);
  const jobId = bindAttempt(store, ids.s2).jobId;
  setJob(store, jobId, { claimed_at: EPOCH + 1, end_state: "completed", end_at: EPOCH + 1 });
  assert.deepEqual(await observe(store, ids.s2, jobId, { outcome: "valid", eventAt: EPOCH + 1, answerSha256: hex("b") }), { ok: true });
  assert.deepEqual(await receive(store, "run-1", "s1", ids.s1, VALID), { ok: true, round: 1 });
  sql(store, ["UPDATE council_attempts SET refusal = 'label in use' WHERE id = ?", ids.s3]);
  await reduce(store);
  const original = readCouncil(store, "run-1");
  assert.deepEqual(
    original.seatRounds.map((row) => [row.seat, row.state]),
    [
      ["s1", "valid"],
      ["s2", "valid"],
      ["s3", "error"]
    ]
  );
  assert.equal(original.rounds[0].quorum, 1);

  // At 2: rewrites of the observation, a final seat, its closed round and the bound attempt are
  // refused, and canonical replays keep the first facts.
  clock.set(2);
  refused(store, `UPDATE council_observations SET answer_sha256 = '${hex("c")}' WHERE attempt_id = '${ids.s2}'`, /council observation is immutable/);
  refused(store, `DELETE FROM council_observations WHERE attempt_id = '${ids.s2}'`, /council observation cannot be deleted/);
  refused(
    store,
    `INSERT OR REPLACE INTO council_observations (attempt_id, observed_at, event_at, outcome, answer_sha256) VALUES ('${ids.s2}', 2, 2, 'valid', '${hex("c")}')`,
    /council observation already exists/
  );
  refused(store, "UPDATE council_seat_rounds SET reason = 'x' WHERE run_id = 'run-1' AND round = 1 AND seat = 's3'", /final state is fixed/);
  refused(store, "UPDATE council_rounds SET quorum = 0 WHERE run_id = 'run-1' AND round = 1", /seal or close is fixed/);
  refused(store, `UPDATE council_attempts SET job_id = 'job-other' WHERE id = '${ids.s2}'`, /binding is fixed/);
  refused(store, `UPDATE council_attempts SET issued_at = issued_at + 1 WHERE id = '${ids.s2}'`, /binding is fixed/);
  assert.deepEqual(await observe(store, ids.s2, jobId, { outcome: "late", eventAt: EPOCH + 1, reason: "execution deadline expired" }), {
    ok: false,
    reason: "duplicate-observation"
  });
  assert.deepEqual(await receive(store, "run-1", "s1", ids.s1, { outcome: "invalid", errorsSha256: hex("d"), reason: "schema validation failed" }), {
    ok: false,
    reason: "duplicate-receipt",
    round: 1
  });
  clock.set(3);
  assert.equal((await reduce(store)).changed, false);
  const after = readCouncil(store, "run-1");
  assert.deepEqual(after.observations, original.observations);
  assert.deepEqual(after.seatRounds, original.seatRounds);
  assert.deepEqual(after.rounds, original.rounds);
});

test("layer 0 schedule Boundaries, DR-08, T=1000", async (t) => {
  const clock = useTestClock(t, 0);
  // A binding at 999 is accounted by B1 at 1001.
  {
    const { store, ids } = await seeded(t, clock);
    clock.set(999);
    bindAttempt(store, ids.s2);
    clock.set(1001);
    await reduce(store);
    assert.deepEqual([seatRound(store, "s2").state, seatRound(store, "s2").reason], ["running", null]);
  }
  // A binding at 1000 rolls back and the seat reaches B3.
  {
    const { store, ids } = await seeded(t, clock);
    clock.set(1000);
    assert.throws(() => bindAttempt(store, ids.s2), (error) => error instanceof CouncilFenceError && error.code === "stale-attempt");
    assert.equal(store.read((db) => db.prepare("SELECT count(*) AS n FROM jobs").get().n), 0);
    await reduce(store);
    assert.deepEqual([seatRound(store, "s2").state, seatRound(store, "s2").reason], ["error", "issuance deadline expired"]);
  }
  // Claim at 10, complete at 1009 or 1010, with a different started_at: execution is measured
  // from the claim.
  for (const [endAt, startedAt, state, reason] of [
    [1009, 400, "valid", null],
    [1010, 20, "timed-out", "execution deadline expired"]
  ]) {
    const { store, ids } = await seeded(t, clock);
    clock.set(0);
    const jobId = bindAttempt(store, ids.s2).jobId;
    setJob(store, jobId, { claimed_at: EPOCH + 10, started_at: EPOCH + startedAt, end_state: "completed", end_at: EPOCH + endAt });
    clock.set(endAt + 1);
    const timing = providerTiming(readJob(store, jobId), 1000);
    const verdict = timing.timely
      ? { outcome: "valid", eventAt: EPOCH + endAt, answerSha256: hex("b") }
      : { outcome: "late", eventAt: EPOCH + endAt, reason: timing.reason };
    assert.deepEqual(await observe(store, ids.s2, jobId, verdict), { ok: true });
    await reduce(store);
    assert.deepEqual([seatRound(store, "s2").state, seatRound(store, "s2").reason], [state, reason], `end at ${endAt}`);
  }
});
