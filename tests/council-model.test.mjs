import test from "node:test";
import assert from "node:assert/strict";

import {
  EPOCH,
  bindAttempt,
  councilChanges,
  councilSnapshot,
  observe,
  openCouncilStore,
  receive,
  reduce,
  seedRun,
  setJob,
  sql,
  useTestClock
} from "./council-helpers.mjs";
import { nextDue, reduceRound } from "../plugins/agent/scripts/lib/council/reduce.mjs";
import { readCouncil, recordRefusal } from "../plugins/agent/scripts/lib/council/state.mjs";

const hex = (character) => character.repeat(64);
const DEADLINE = () => performance.now() + 10000;

// A seeded three-seat run (T=1000, created at 0) where every seat but `open` is already final:
// s1 valid when it is not open, s2 valid when s1 is open, s3 an error.
async function rowFixture(t, clock, open) {
  clock.set(0);
  const { store, runDir } = openCouncilStore(t);
  const { seats } = await seedRun(store, runDir);
  const ids = Object.fromEntries(seats.map((seat) => [seat.seat, seat.attemptId]));
  const finals = open === "s1" ? { s2: "valid", s3: "error" } : { s1: "valid", s3: "error" };
  const steps = [];
  for (const [seat, state] of Object.entries(finals)) {
    steps.push(
      [
        "UPDATE council_seat_rounds SET state = ?, answer_sha256 = ?, reason = ?, final_at = ? WHERE run_id = 'run-1' AND round = 1 AND seat = ?",
        state,
        state === "valid" ? hex(seat.slice(1)) : null,
        state === "valid" ? null : "provider failure",
        EPOCH,
        seat
      ],
      ["UPDATE council_attempts SET retired_at = ? WHERE id = ?", EPOCH, ids[seat]]
    );
  }
  sql(store, ...steps);
  const names = Object.fromEntries(seats.map((seat) => [seat.attemptId, `${seat.seat}-attempt`]));
  return { store, ids, names };
}

const sr = (seat, column, before, after) => `council_seat_rounds run-1|1|${seat} ${column}: ${before} -> ${after}`;

function finishLines(seat, from, state, reason, at, { answer = null, errors = null } = {}) {
  const lines = [sr(seat, "state", from, state), sr(seat, "final_at", null, at), `council_attempts ${seat}-attempt retired_at: null -> ${at}`];
  if (reason !== null) {
    lines.push(sr(seat, "reason", null, reason));
  }
  if (answer !== null) {
    lines.push(sr(seat, "answer_sha256", null, answer));
  }
  if (errors !== null) {
    lines.push(sr(seat, "errors_sha256", null, errors));
  }
  return lines;
}

function closeLines(at, quorum, inputRev) {
  const lines = [`council_rounds run-1|1 closed_at: null -> ${at}`, `council_rounds run-1|1 quorum: null -> ${quorum}`, `council_runs run-1 input_rev: 0 -> ${inputRev}`];
  if (quorum === 0) {
    lines.push(`council_runs run-1 failed_at: null -> ${at}`);
  }
  return lines;
}

// Binds s2 at 10 to a job and accounts it at 15, so s2 is a running provider seat.
async function runningProvider(fixture, clock, jobColumns = {}) {
  clock.set(10);
  const jobId = bindAttempt(fixture.store, fixture.ids.s2).jobId;
  if (Object.keys(jobColumns).length > 0) {
    setJob(fixture.store, jobId, jobColumns);
  }
  clock.set(15);
  await reduce(fixture.store);
  fixture.names[jobId] = "s2-job";
  return jobId;
}

// Reduces at `at` and returns the row changes against the snapshot taken just before.
async function changesAt(fixture, clock, at) {
  const before = councilSnapshot(fixture.store);
  clock.set(at);
  const result = await reduce(fixture.store);
  assert.equal(result.ok, true);
  return councilChanges(before, councilSnapshot(fixture.store), fixture.names);
}

const sorted = (lines) => [...lines].sort();

test("B1 to B9 each apply their guard and effect, and fall through when the guard is false", async (t) => {
  const clock = useTestClock(t, 0);

  // B1: an issuing seat whose attempt is bound becomes running.
  {
    const fixture = await rowFixture(t, clock, "s2");
    assert.deepEqual(await changesAt(fixture, clock, 20), []);
    clock.set(30);
    bindAttempt(fixture.store, fixture.ids.s2);
    assert.deepEqual(await changesAt(fixture, clock, 40), [sr("s2", "state", "issuing", "running")]);
  }
  // B2: a durable refusal finishes an unbound seat as an error with the refusal.
  {
    const fixture = await rowFixture(t, clock, "s2");
    clock.set(10);
    assert.deepEqual(await recordRefusal(fixture.store, { attemptId: fixture.ids.s2, reason: "label in use", layer: 0, deadline: DEADLINE() }), { ok: true });
    assert.deepEqual(await changesAt(fixture, clock, 20), sorted([...finishLines("s2", "issuing", "error", "label in use", 20), ...closeLines(20, 0, 1)]));
  }
  // B3: an unbound seat at its issue_by.
  {
    const fixture = await rowFixture(t, clock, "s2");
    assert.deepEqual(await changesAt(fixture, clock, 999), []);
    assert.deepEqual(await changesAt(fixture, clock, 1000), sorted([...finishLines("s2", "issuing", "error", "issuance deadline expired", 1000), ...closeLines(1000, 0, 1)]));
  }
  // B4: a running prompt classifies its receipt, or times out at its issue_by.
  {
    const fixture = await rowFixture(t, clock, "s1");
    clock.set(500);
    assert.deepEqual(await receive(fixture.store, "run-1", "s1", fixture.ids.s1, { outcome: "valid", answerSha256: hex("a") }), { ok: true, round: 1 });
    assert.deepEqual(
      await changesAt(fixture, clock, 600),
      sorted([...finishLines("s1", "running", "valid", null, 600, { answer: hex("a") }), ...closeLines(600, 1, 2)])
    );
  }
  {
    const fixture = await rowFixture(t, clock, "s1");
    clock.set(500);
    await receive(fixture.store, "run-1", "s1", fixture.ids.s1, { outcome: "invalid", errorsSha256: hex("d"), reason: "schema validation failed" });
    assert.deepEqual(
      await changesAt(fixture, clock, 600),
      sorted([...finishLines("s1", "running", "invalid", "schema validation failed", 600, { errors: hex("d") }), ...closeLines(600, 0, 1)])
    );
  }
  {
    const fixture = await rowFixture(t, clock, "s1");
    assert.deepEqual(await changesAt(fixture, clock, 999), []);
    assert.deepEqual(await changesAt(fixture, clock, 1000), sorted([...finishLines("s1", "running", "timed-out", "reply deadline expired", 1000), ...closeLines(1000, 0, 1)]));
  }
  // B5: a provider observation for the current attempt, through the reason table; B1 exposes an
  // issuing seat to B5 in the same call.
  {
    const fixture = await rowFixture(t, clock, "s2");
    clock.set(10);
    const jobId = bindAttempt(fixture.store, fixture.ids.s2).jobId;
    setJob(fixture.store, jobId, { claimed_at: EPOCH + 20, end_state: "completed", end_at: EPOCH + 50 });
    clock.set(60);
    assert.deepEqual(await observe(fixture.store, fixture.ids.s2, jobId, { outcome: "valid", eventAt: EPOCH + 50, answerSha256: hex("b") }), { ok: true });
    assert.deepEqual(
      await changesAt(fixture, clock, 70),
      sorted([...finishLines("s2", "issuing", "valid", null, 70, { answer: hex("b") }), ...closeLines(70, 1, 2)])
    );
  }
  const b5 = [
    [{ outcome: "invalid", reason: "missing structured output" }, "completed", "invalid", "missing structured output"],
    [{ outcome: "late", reason: "execution deadline expired" }, "completed", "timed-out", "execution deadline expired"],
    [{ outcome: "cancelled", reason: "job cancelled" }, "cancelled", "error", "external cancellation"],
    [{ outcome: "quota", reason: "quota exhausted" }, "failed", "quota-exhausted", "quota exhausted"],
    [{ outcome: "failure", reason: "launch failed" }, "interrupted", "error", "launch failed"],
    [{ outcome: "missing", reason: "job pruned or missing" }, null, "error", "job pruned or missing"]
  ];
  for (const [verdict, endState, state, reason] of b5) {
    const fixture = await rowFixture(t, clock, "s2");
    const jobId = await runningProvider(fixture, clock, endState ? { end_state: endState, end_at: EPOCH + 30 } : {});
    clock.set(40);
    assert.deepEqual(await observe(fixture.store, fixture.ids.s2, jobId, { ...verdict, eventAt: EPOCH + 30 }), { ok: true });
    assert.deepEqual(await changesAt(fixture, clock, 50), sorted([...finishLines("s2", "running", state, reason, 50), ...closeLines(50, 0, 1)]), verdict.outcome);
  }
  {
    // A cancellation with an exact council stop is that stop's timeout.
    const fixture = await rowFixture(t, clock, "s2");
    const jobId = await runningProvider(fixture, clock);
    sql(fixture.store, ["INSERT INTO council_stops (job_id, requested_at, cause) VALUES (?, ?, 'deadline')", jobId, EPOCH + 20]);
    setJob(fixture.store, jobId, { end_state: "cancelled", end_at: EPOCH + 30 });
    clock.set(40);
    await observe(fixture.store, fixture.ids.s2, jobId, { outcome: "cancelled", eventAt: EPOCH + 30, reason: "job cancelled" });
    assert.deepEqual(await changesAt(fixture, clock, 50), sorted([...finishLines("s2", "running", "timed-out", "execution deadline expired", 50), ...closeLines(50, 0, 1)]));
  }
  {
    // An ended job with no observation is observation work: no row applies.
    const fixture = await rowFixture(t, clock, "s2");
    await runningProvider(fixture, clock, { claimed_at: EPOCH + 12, end_state: "completed", end_at: EPOCH + 30 });
    assert.deepEqual(await changesAt(fixture, clock, 200000), []);
  }
  // B6: an unended exact tip past its raw queue or execution limit gets one exact stop.
  for (const [columns, quiet, due, cause] of [
    [{}, 1009, 1010, "queue"],
    [{ claimed_at: EPOCH + 20, started_at: EPOCH + 500 }, 1019, 1020, "deadline"],
    [{ claimed_at: EPOCH + 1012 }, null, 1012, "queue"],
    [{ claimed_at: EPOCH + 20, stop_requested_at: EPOCH + 500, stopping_since: EPOCH + 500, stopping_cause: "unconfirmed-stop" }, 1019, 1020, "deadline"]
  ]) {
    const fixture = await rowFixture(t, clock, "s2");
    const jobId = await runningProvider(fixture, clock, columns);
    if (quiet !== null) {
      assert.deepEqual(await changesAt(fixture, clock, quiet), []);
    }
    assert.deepEqual(await changesAt(fixture, clock, due), ["council_stops s2-job inserted"]);
    const stop = readCouncil(fixture.store, "run-1").stops[0];
    assert.deepEqual([stop.job_id, stop.cause, stop.requested_at - EPOCH, stop.dispatched_at], [jobId, cause, due, null]);
    assert.deepEqual(await changesAt(fixture, clock, due + 1), []);
  }
  for (const columns of [{ cancel_requested_at: EPOCH + 500 }, { end_state: "failed", end_at: EPOCH + 500 }]) {
    const fixture = await rowFixture(t, clock, "s2");
    await runningProvider(fixture, clock, columns);
    assert.deepEqual(await changesAt(fixture, clock, 1010), []);
  }
  // B7: a selected council stop past its bound finishes the still-unended job as that stop's timeout.
  {
    const fixture = await rowFixture(t, clock, "s2");
    const jobId = await runningProvider(fixture, clock, { claimed_at: EPOCH + 20 });
    sql(fixture.store, ["INSERT INTO council_stops (job_id, requested_at, cause) VALUES (?, ?, 'deadline')", jobId, EPOCH + 1020]);
    assert.deepEqual(await changesAt(fixture, clock, 200000), []);
    sql(fixture.store, ["UPDATE council_stops SET dispatched_at = ?, acknowledged_at = ? WHERE job_id = ? AND acknowledged_at IS NULL", EPOCH + 200001, EPOCH + 200001, jobId]);
    assert.deepEqual(await changesAt(fixture, clock, 320000), []);
    assert.deepEqual(
      await changesAt(fixture, clock, 320001),
      sorted([...finishLines("s2", "running", "timed-out", "execution deadline expired", 320001), ...closeLines(320001, 0, 1)])
    );
  }
  // B8: a foreign cancellation that does not settle within the bound, with no council stop.
  {
    const fixture = await rowFixture(t, clock, "s2");
    await runningProvider(fixture, clock, { claimed_at: EPOCH + 20, cancel_requested_at: EPOCH + 1500 });
    assert.deepEqual(await changesAt(fixture, clock, 121499), []);
    assert.deepEqual(
      await changesAt(fixture, clock, 121500),
      sorted([...finishLines("s2", "running", "error", "external cancellation did not settle", 121500), ...closeLines(121500, 0, 1)])
    );
  }
  {
    const fixture = await rowFixture(t, clock, "s2");
    const jobId = await runningProvider(fixture, clock, { claimed_at: EPOCH + 20, cancel_requested_at: EPOCH + 1500 });
    sql(fixture.store, ["INSERT INTO council_stops (job_id, requested_at, cause) VALUES (?, ?, 'deadline')", jobId, EPOCH + 1020]);
    assert.deepEqual(await changesAt(fixture, clock, 121500), []);
  }
});

// A hand-built view of an open round with T=1000 for the pure reducer.
function handView({ seatRounds, attempts, observations = [], stops = [], cancels = [], jobs = {}, clock = 0, freshIds = [] }) {
  return {
    run: { id: "run-1", timeout_ms: 1000, clock, seat_count: 3 },
    round: { run_id: "run-1", round: 1, started_at: 0, closed_at: null, quorum: null, quorum_at: null, cutoff_at: null },
    seats: [
      { seat: "s1", family: "claude" },
      { seat: "s2", family: "codex" },
      { seat: "s3", family: "agy" }
    ],
    seatRounds,
    attempts,
    observations,
    stops,
    cancels,
    jobs,
    freshIds
  };
}

const prompt = (id, issueBy) => ({ id, kind: "prompt", job_id: null, refusal: null, issue_by: issueBy, created_at: issueBy - 1000 });
const provider = (id, issueBy, jobId = null, refusal = null) => ({ id, kind: "create", job_id: jobId, refusal, issue_by: issueBy, created_at: issueBy - 1000 });
const unendedJob = (createdAt, claimedAt = null) => ({ created_at: createdAt, claimed_at: claimedAt, end_state: null, isTip: 1, cancel_requested_at: null });

test("a seat takes the first matching row and B9 runs last", async (t) => {
  // B1 exposes a seat to B5 in the same call; B9 follows.
  const exposed = handView({
    seatRounds: [
      { seat: "s1", state: "valid", current_id: "a1" },
      { seat: "s2", state: "issuing", current_id: "a2" },
      { seat: "s3", state: "error", current_id: "a3" }
    ],
    attempts: [prompt("a1", 1000), provider("a2", 1000, "j2"), provider("a3", 1000)],
    observations: [{ attempt_id: "a2", outcome: "valid", answer_sha256: hex("b"), reason: null }]
  });
  assert.deepEqual(reduceRound(exposed, { w: 50, t: 50, layer: 0 }).writes, [
    { op: "account", seat: "s2" },
    { op: "finish", seat: "s2", state: "valid", reason: null, answerSha256: hex("b"), errorsSha256: null },
    { op: "close", quorum: 1 }
  ]);
  // B2 wins over B3; B1 to B3 run over every seat before B4 to B8.
  const ordered = handView({
    seatRounds: [
      { seat: "s1", state: "running", current_id: "a1" },
      { seat: "s2", state: "issuing", current_id: "a2" },
      { seat: "s3", state: "issuing", current_id: "a3" }
    ],
    attempts: [prompt("a1", 1000), provider("a2", 1000, null, "invalid label"), provider("a3", 1000)]
  });
  assert.deepEqual(
    reduceRound(ordered, { w: 1000, t: 1000, layer: 0 }).writes.map((write) => [write.op, write.seat, write.reason]),
    [
      ["finish", "s2", "invalid label"],
      ["finish", "s3", "issuance deadline expired"],
      ["finish", "s1", "reply deadline expired"],
      ["close", undefined, undefined]
    ]
  );
  // B9 does not close while a seat is open.
  const open = handView({
    seatRounds: [
      { seat: "s1", state: "running", current_id: "a1" },
      { seat: "s2", state: "running", current_id: "a2" },
      { seat: "s3", state: "error", current_id: "a3" }
    ],
    attempts: [prompt("a1", 1000), provider("a2", 1000, "j2"), provider("a3", 1000)],
    jobs: { j2: unendedJob(10, 20) }
  });
  assert.deepEqual(reduceRound(open, { w: 1000, t: 1000, layer: 0 }).writes.map((write) => write.op), ["finish"]);

  // On the store: a failed quorum sets failed_at once, and a closed round takes no further write.
  const clock = useTestClock(t, 0);
  const { store, runDir } = openCouncilStore(t);
  await seedRun(store, runDir);
  clock.set(1000);
  assert.deepEqual(await reduce(store), { ok: true, changed: true, closed: true });
  const closed = readCouncil(store, "run-1");
  assert.equal(closed.run.failed_at - EPOCH, 1000);
  assert.equal(closed.run.input_rev, 1);
  assert.equal(closed.rounds[0].quorum, 0);
  clock.set(2000);
  assert.deepEqual(await reduce(store), { ok: true, changed: false, closed: true });
  const again = readCouncil(store, "run-1");
  assert.deepEqual({ ...again.run, clock: null }, { ...closed.run, clock: null });
  assert.deepEqual(again.seatRounds, closed.seatRounds);
  assert.deepEqual(await reduce(store, "run-1", 2), { ok: false, reason: "round-not-started" });
  assert.deepEqual(await reduce(store, "run-none", 1), { ok: false, reason: "unknown-run" });
});

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

test("reduceRound is pure", () => {
  const build = () =>
    handView({
      seatRounds: [
        { seat: "s1", state: "running", current_id: "a1" },
        { seat: "s2", state: "issuing", current_id: "a2" },
        { seat: "s3", state: "running", current_id: "a3" }
      ],
      attempts: [prompt("a1", 1000), provider("a2", 1000, "j2"), provider("a3", 1000, "j3")],
      observations: [{ attempt_id: "a1", outcome: "invalid", answer_sha256: null, errors_sha256: hex("d"), reason: "schema validation failed" }],
      jobs: { j2: unendedJob(10), j3: unendedJob(10, 20) }
    });
  const view = deepFreeze(build());
  const first = reduceRound(view, { w: 1015, t: 1015, layer: 0 });
  const second = reduceRound(view, { w: 1015, t: 1015, layer: 0 });
  assert.deepEqual(first, second);
  assert.deepEqual(view, build());
  assert.deepEqual(first.writes, [
    { op: "account", seat: "s2" },
    { op: "finish", seat: "s1", state: "invalid", reason: "schema validation failed", answerSha256: null, errorsSha256: hex("d") },
    { op: "stop", jobId: "j2", cause: "queue" }
  ]);
  assert.deepEqual(first.nextDue, { delayMs: 5, axis: "wall", source: "s3:execution" });
});

test("nextDue converts each deadline on its own clock", () => {
  // After a ratchet to 4,000,000 with the wall back at 1010.
  const w = 1010;
  const t = 4000000;
  const providerSeat = { seat: "s2", state: "running", current_id: "a2" };
  const promptSeat = { seat: "s1", state: "running", current_id: "a1" };
  const done = { seat: "s3", state: "error", current_id: "a3" };
  const wallOnly = handView({
    clock: t,
    seatRounds: [{ seat: "s1", state: "valid", current_id: "a1" }, providerSeat, done],
    attempts: [prompt("a1", 4001000), provider("a2", 4001000, "j2"), provider("a3", 1000)],
    jobs: { j2: unendedJob(1010, 1020) }
  });
  assert.deepEqual(nextDue(wallOnly, { w, t, layer: 0 }), { delayMs: 1010, axis: "wall", source: "s2:execution" });
  const councilOnly = handView({
    clock: t,
    seatRounds: [promptSeat, { seat: "s2", state: "valid", current_id: "a2" }, done],
    attempts: [prompt("a1", 4001000), provider("a2", 4001000, "j2"), provider("a3", 1000)]
  });
  assert.deepEqual(nextDue(councilOnly, { w, t, layer: 0 }), { delayMs: 1000, axis: "council", source: "s1:issue_by" });
  const both = handView({
    clock: t,
    seatRounds: [promptSeat, providerSeat, done],
    attempts: [prompt("a1", 4001000), provider("a2", 4001000, "j2"), provider("a3", 1000)],
    jobs: { j2: unendedJob(1010, 1020) }
  });
  assert.deepEqual(nextDue(both, { w, t, layer: 0 }), { delayMs: 1000, axis: "council", source: "s1:issue_by" });
  assert.deepEqual(reduceRound(both, { w, t, layer: 0 }).nextDue, { delayMs: 1000, axis: "council", source: "s1:issue_by" });
  const stopped = handView({
    clock: t,
    seatRounds: [{ seat: "s1", state: "valid", current_id: "a1" }, providerSeat, done],
    attempts: [prompt("a1", 4001000), provider("a2", 4001000, "j2"), provider("a3", 1000)],
    stops: [{ job_id: "j2", requested_at: t, cause: "deadline", dispatched_at: t, acknowledged_at: t }],
    jobs: { j2: { ...unendedJob(1010, 1020), cancel_requested_at: 1015 } }
  });
  assert.deepEqual(nextDue(stopped, { w, t, layer: 0 }), { delayMs: 120000, axis: "council", source: "s2:stop-dispatch" });
  const foreign = handView({
    clock: t,
    seatRounds: [{ seat: "s1", state: "valid", current_id: "a1" }, providerSeat, done],
    attempts: [prompt("a1", 4001000), provider("a2", 4001000, "j2"), provider("a3", 1000)],
    jobs: { j2: { ...unendedJob(1010, 1020), cancel_requested_at: 1000 } }
  });
  assert.deepEqual(nextDue(foreign, { w, t, layer: 0 }), { delayMs: 119990, axis: "wall", source: "s2:external-cancel" });
  const none = handView({
    seatRounds: [{ seat: "s1", state: "valid", current_id: "a1" }, { seat: "s2", state: "valid", current_id: "a2" }, done],
    attempts: [prompt("a1", 1000), provider("a2", 1000, "j2"), provider("a3", 1000)]
  });
  assert.equal(nextDue(none, { w, t, layer: 0 }), null);
});

// Layer 1: a hand-built round where s1 is valid, s3 is an error, and s2 (or s1) is the seat under
// test. Attempts carry their charge, prompt and prepared retry digest; ids f0..f5 are fresh.
const FRESH = ["f0", "f1", "f2", "f3", "f4", "f5"];
const turn = (id, seat, kind, overrides = {}) => ({
  id,
  seat,
  charge: "turn",
  kind,
  job_id: null,
  refusal: null,
  created_at: 0,
  issue_by: 1000,
  prompt_sha256: hex(seat.slice(1)),
  retry_prompt_sha256: hex("r"),
  ...overrides
});
const endedJob = (columns = {}) => ({ created_at: 0, claimed_at: 10, end_state: "completed", end_at: 50, isTip: 1, cancel_requested_at: null, thread_id: null, ...columns });

function layer1View({ s2 = {}, s2Attempts = [], observation = null, stops = [], cancels = [], job = endedJob(), s1 = null, s1Observation = null } = {}) {
  const s1Attempt = turn("a1", "s1", "prompt", { issued_at: 0 });
  const s2Attempt = turn("a2", "s2", "create", { job_id: "j2", ...s2 });
  return handView({
    seatRounds: [
      { seat: "s1", state: s1 ? "running" : "valid", current_id: "a1" },
      { seat: "s2", state: s1 ? "valid" : "running", current_id: "a2" },
      { seat: "s3", state: "error", current_id: "a3" }
    ],
    attempts: [s1Attempt, s2Attempt, ...s2Attempts, turn("a3", "s3", "create")],
    observations: [...(observation ? [{ attempt_id: "a2", ...observation }] : []), ...(s1Observation ? [{ attempt_id: "a1", ...s1Observation }] : [])],
    stops,
    cancels,
    jobs: job ? { j2: job } : {},
    freshIds: FRESH
  });
}

const replaceWrite = (seat, charge, kind, promptSha256, overrides = {}) => ({
  op: "replace",
  seat,
  charge,
  attemptId: FRESH[(Number(seat.slice(1)) - 1) * 2 + (charge === "repair" ? 0 : 1)],
  kind,
  predecessorId: null,
  replacesId: `a${seat.slice(1)}`,
  promptSha256,
  retryPromptSha256: hex("r"),
  ...overrides
});

const finishOf = (seat, state, reason) => ({ op: "finish", seat, state, reason, answerSha256: null, errorsSha256: null });

test("layer 1 rows L1b and L1c replace once per slot, and the fallback finishes the ordinary candidate", () => {
  const at = { w: 100, t: 100, layer: 1 };
  const invalid = { outcome: "invalid", reason: "schema validation failed", errors_sha256: hex("e"), replacement_sha256: hex("p"), transient: 0 };
  // L1b: an invalid answer with its prepared digest gets one repair; a threadless job is replaced
  // by a fresh job, an ended job with a thread is continued.
  assert.deepEqual(reduceRound(layer1View({ observation: invalid }), at).writes, [replaceWrite("s2", "repair", "create", hex("p"))]);
  assert.deepEqual(reduceRound(layer1View({ observation: invalid, job: endedJob({ thread_id: "thread-2" }) }), at).writes, [
    replaceWrite("s2", "repair", "continue", hex("p"), { predecessorId: "j2" })
  ]);
  // A pruned job row gives a fresh job.
  assert.deepEqual(reduceRound(layer1View({ observation: invalid, job: null }), at).writes, [replaceWrite("s2", "repair", "create", hex("p"))]);
  // Layer 0, a used repair slot, or a historical deposit without a digest: the ordinary finish.
  const invalidFinish = [{ ...finishOf("s2", "invalid", "schema validation failed"), errorsSha256: hex("e") }, { op: "close", quorum: 0 }];
  assert.deepEqual(reduceRound(layer1View({ observation: invalid }), { ...at, layer: 0 }).writes, invalidFinish);
  const usedRepair = [turn("a2r", "s2", "create", { charge: "repair", replaces_id: "a0", retired_at: 50 })];
  assert.deepEqual(reduceRound(layer1View({ observation: invalid, s2Attempts: usedRepair }), at).writes, invalidFinish);
  assert.deepEqual(reduceRound(layer1View({ observation: { ...invalid, replacement_sha256: null } }), at).writes, invalidFinish);
  // A used retry slot leaves the repair slot free: either order is allowed.
  const usedRetry = [turn("a2t", "s2", "create", { charge: "retry", retired_at: 50 })];
  assert.deepEqual(reduceRound(layer1View({ observation: invalid, s2Attempts: usedRetry }), at).writes, [replaceWrite("s2", "repair", "create", hex("p"))]);

  // L1c: a late output, a transient failure with its digest, and a council-caused cancellation
  // with first-cancellation evidence get one retry.
  const late = { outcome: "late", reason: "execution deadline expired", transient: 0, replacement_sha256: null };
  assert.deepEqual(reduceRound(layer1View({ observation: late }), at).writes, [replaceWrite("s2", "retry", "create", hex("r"))]);
  // A Layer 0 attempt with no prepared retry object retries with its initial turn prompt.
  assert.deepEqual(reduceRound(layer1View({ observation: late, s2: { retry_prompt_sha256: null } }), at).writes, [
    replaceWrite("s2", "retry", "create", hex("2"), { retryPromptSha256: null })
  ]);
  const transient = { outcome: "failure", reason: "transient provider failure", transient: 1, replacement_sha256: hex("t") };
  assert.deepEqual(reduceRound(layer1View({ observation: transient, job: endedJob({ end_state: "failed", thread_id: "thread-2" }) }), at).writes, [
    replaceWrite("s2", "retry", "continue", hex("t"), { predecessorId: "j2" })
  ]);
  assert.deepEqual(reduceRound(layer1View({ observation: transient, s2Attempts: usedRetry }), at).writes, [
    finishOf("s2", "error", "transient provider failure"),
    { op: "close", quorum: 0 }
  ]);
  // Quota, a permanent failure and a missing job are never retried.
  for (const [observation, state, reason] of [
    [{ outcome: "quota", reason: "quota exhausted", transient: 0 }, "quota-exhausted", "quota exhausted"],
    [{ outcome: "failure", reason: "provider failure", transient: 0 }, "error", "provider failure"],
    [{ outcome: "missing", reason: "job pruned or missing", transient: 0 }, "error", "job pruned or missing"]
  ]) {
    assert.deepEqual(reduceRound(layer1View({ observation }), at).writes, [finishOf("s2", state, reason), { op: "close", quorum: 0 }], observation.outcome);
  }

  // A Claude prompt: an invalid receipt gets a repair prompt, a silent prompt a retry prompt.
  const s1Invalid = { outcome: "invalid", reason: "schema validation failed", errors_sha256: hex("e"), replacement_sha256: hex("q"), transient: 0 };
  assert.deepEqual(reduceRound(layer1View({ s1: true, s1Observation: s1Invalid }), at).writes, [replaceWrite("s1", "repair", "prompt", hex("q"))]);
  assert.deepEqual(reduceRound(layer1View({ s1: true }), { w: 1000, t: 1000, layer: 1 }).writes, [replaceWrite("s1", "retry", "prompt", hex("r"))]);
  // The replacement's own issuance deadline is the next wake.
  assert.deepEqual(reduceRound(layer1View({ s1: true }), { w: 1000, t: 1000, layer: 1 }).nextDue, { delayMs: 1000, axis: "council", source: "s1:issue_by" });
});

test("layer 1 attribution: L1a, the B7 retry of a threadless live job, and the B8 extension", () => {
  const at = { w: 100, t: 100, layer: 1 };
  const cancelled = { outcome: "cancelled", reason: "job cancelled", transient: 0, replacement_sha256: null };
  const stop = { job_id: "j2", requested_at: 20, cause: "deadline", dispatched_at: 30, acknowledged_at: 30 };
  const proof = { job_id: "j2", committed_at: 30 };
  const cancelledJob = endedJob({ end_state: "cancelled" });
  // L1a: a cancellation with council-first evidence is the stop's timeout and gets the retry;
  // without the evidence, a council stop row alone is an external cancellation.
  assert.deepEqual(reduceRound(layer1View({ observation: cancelled, stops: [stop], cancels: [proof], job: cancelledJob }), at).writes, [
    replaceWrite("s2", "retry", "create", hex("r"))
  ]);
  for (const stops of [[stop], []]) {
    assert.deepEqual(reduceRound(layer1View({ observation: cancelled, stops, job: cancelledJob }), at).writes, [
      finishOf("s2", "error", "external cancellation"),
      { op: "close", quorum: 0 }
    ]);
  }
  // With a used retry slot the proven cancellation finishes as the stop's timeout.
  const usedRetry = [turn("a2t", "s2", "create", { charge: "retry", retired_at: 50 })];
  assert.deepEqual(reduceRound(layer1View({ observation: cancelled, stops: [stop], cancels: [proof], job: cancelledJob, s2Attempts: usedRetry }), at).writes, [
    finishOf("s2", "timed-out", "execution deadline expired"),
    { op: "close", quorum: 0 }
  ]);

  // B7 at its bound on a still-live job: proven and threadless gives a fresh retry; proven with a
  // thread finishes timed-out; unproven is an external cancellation that did not settle.
  const live = { created_at: 0, claimed_at: 10, end_state: null, isTip: 1, cancel_requested_at: 30, thread_id: null };
  const bound = { w: 120030, t: 120030, layer: 1 };
  assert.deepEqual(reduceRound(layer1View({ stops: [stop], cancels: [proof], job: live }), { ...bound, w: 120029, t: 120029 }).writes, []);
  assert.deepEqual(reduceRound(layer1View({ stops: [stop], cancels: [proof], job: live }), bound).writes, [replaceWrite("s2", "retry", "create", hex("r"))]);
  assert.deepEqual(reduceRound(layer1View({ stops: [stop], cancels: [proof], job: { ...live, thread_id: "thread-2" } }), bound).writes, [
    finishOf("s2", "timed-out", "execution deadline expired"),
    { op: "close", quorum: 0 }
  ]);
  assert.deepEqual(reduceRound(layer1View({ stops: [stop], job: live }), bound).writes, [
    finishOf("s2", "error", "external cancellation did not settle"),
    { op: "close", quorum: 0 }
  ]);
  // Layer 0 keeps its rule: a selected council stop at its bound is that stop's timeout.
  assert.deepEqual(reduceRound(layer1View({ stops: [stop], job: live }), { ...bound, layer: 0 }).writes, [
    finishOf("s2", "timed-out", "execution deadline expired"),
    { op: "close", quorum: 0 }
  ]);

  // B8 extension: a pending council stop without evidence does not hold back the raw bound of an
  // external cancellation; proven evidence does.
  const pending = { ...stop, dispatched_at: null, acknowledged_at: null };
  const foreign = { ...live, cancel_requested_at: 25 };
  assert.deepEqual(reduceRound(layer1View({ stops: [pending], job: foreign }), { w: 120024, t: 120024, layer: 1 }).writes, []);
  assert.deepEqual(reduceRound(layer1View({ stops: [pending], job: foreign }), { w: 120025, t: 120025, layer: 1 }).writes, [
    finishOf("s2", "error", "external cancellation did not settle"),
    { op: "close", quorum: 0 }
  ]);
  assert.deepEqual(nextDue(layer1View({ stops: [pending], job: foreign }), { w: 25, t: 25, layer: 1 }), { delayMs: 120000, axis: "wall", source: "s2:external-cancel" });
  assert.deepEqual(reduceRound(layer1View({ stops: [pending], job: foreign }), { w: 120025, t: 120025, layer: 0 }).writes, []);
});
