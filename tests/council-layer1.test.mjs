// Layer 1 of the council: one repair and one retry per seat and round, on real store
// transactions with the test wall clock, fake provider job builders and the fake usage read.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { renderRepairPrompt, renderRetryPrompt } from "../plugins/agent/scripts/lib/council/prompts.mjs";
import { COUNCIL_LAYER, readCouncil } from "../plugins/agent/scripts/lib/council/state.mjs";
import { resolveStateDir } from "../plugins/agent/scripts/lib/state.mjs";
import { openStore } from "../plugins/agent/scripts/lib/store.mjs";
import { dispatchStops, handleCouncil, roundSchemaPath } from "../plugins/agent/scripts/commands/council.mjs";
import { makeTempDir } from "./helpers.mjs";
import { EPOCH, bindAttempt, observe, openCouncilStore, receive, reduce, seatJobFields, seedRun, setJob, useTestClock } from "./council-helpers.mjs";

const T_LONG = 100000;
const REACHED = { raw: { rateLimits: { limitId: "codex", rateLimitReachedType: "primary" } }, normalized: { groups: [] } };

function finding(id, overrides = {}) {
  return { id, severity: "P2", claim: `${id} claim`, path: "src/a.mjs", line: 1, evidence: `${id} evidence`, ...overrides };
}

function round1Answer() {
  return { schema: 1, stance: null, confidence: "high", dealbreaker: null, findings: [finding("f1")], assumptions: [], wouldChangeMind: "a failing test" };
}

const VALID = JSON.stringify(round1Answer());
const INVALID = JSON.stringify({ schema: 1 });

// A fake monotonic clock and wait clock: `sleep(ms)` records the delay and moves `now` on.
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

// Runs one council subcommand in this process at `layer` (1 unless given), with fake provider
// checks, a job builder that keeps the prompt it was given, no launch and no usage evidence.
async function council(argv, { cwd, layer = 1, advance = {} }) {
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

// A workspace whose council was started at wall 0 through `council start` (three default seats);
// the start pass created the two provider jobs.
async function started(t, clock, { timeoutMs = T_LONG } = {}) {
  clock.set(0);
  const cwd = makeTempDir(t);
  const stateDir = resolveStateDir(cwd);
  const store = openStore(stateDir);
  t.after(() => store.close());
  const brief = path.join(cwd, "brief.json");
  fs.writeFileSync(brief, JSON.stringify({ question: "Is the cache correct?", targets: ["src"], kind: "review" }));
  const result = await council(["start", "--brief", brief, "--timeout-ms", String(timeoutMs), "--json"], { cwd });
  assert.equal(result.code, 0, result.stderr);
  const runId = result.json.runId;
  return { cwd, store, runId, dir: path.join(stateDir, "council", runId) };
}

function snapshot(fx) {
  return readCouncil(fx.store, fx.runId);
}

function seatRow(fx, seat, round = 1) {
  return snapshot(fx).seatRounds.find((row) => row.round === round && row.seat === seat);
}

function attemptsOf(fx, seat, round = 1) {
  return snapshot(fx).attempts.filter((row) => row.round === round && row.seat === seat);
}

function currentOf(fx, seat, round = 1) {
  const id = seatRow(fx, seat, round).current_id;
  return snapshot(fx).attempts.find((row) => row.id === id);
}

function observationOf(fx, attemptId) {
  return snapshot(fx).observations.find((row) => row.attempt_id === attemptId);
}

function objectText(fx, sha256, ext) {
  return fs.readFileSync(path.join(fx.dir, "objects", `${sha256}.${ext}`), "utf8");
}

function jobRow(fx, jobId) {
  return fx.store.read((db) => ({ ...db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) }));
}

// Ends a job at `at`: claimed and started 5 ms earlier, released, with the given columns.
function endJob(fx, jobId, at, columns) {
  setJob(fx.store, jobId, {
    claimed_at: EPOCH + at - 5,
    started_at: EPOCH + at - 5,
    end_at: EPOCH + at,
    exec_released_at: EPOCH + at,
    release_kind: "confirmed",
    ...columns
  });
}

function completeJob(fx, jobId, at, resultJson, columns = {}) {
  endJob(fx, jobId, at, { end_state: "completed", result_json: resultJson, ...columns });
}

function failJob(fx, jobId, at, error, columns = {}) {
  endJob(fx, jobId, at, { end_state: "failed", error, ...columns });
}

async function submit(fx, seat, intentId, text, name = "reply.json") {
  const file = path.join(fx.cwd, name);
  fs.writeFileSync(file, text);
  return council(["submit", fx.runId, seat, "--intent", intentId, "--file", file, "--json"], { cwd: fx.cwd });
}

function collect(fx, round = 1, advance = {}) {
  return council(["collect", fx.runId, "--round", String(round), "--budget-ms", "120000", "--json"], { cwd: fx.cwd, advance });
}

async function status(fx) {
  const result = await council(["status", fx.runId, "--json"], { cwd: fx.cwd });
  assert.equal(result.code, 0, result.stderr);
  return result.json;
}

function roundSchemaText(round) {
  return fs.readFileSync(roundSchemaPath(round), "utf8");
}

// A started council whose s1 answered valid and s3 completed valid at 10.
async function oneSeatOpen(t, clock, options) {
  const fx = await started(t, clock, options);
  clock.set(10);
  completeJob(fx, currentOf(fx, "s3").job_id, 10, VALID);
  const accepted = await submit(fx, "s1", currentOf(fx, "s1").id, VALID);
  assert.equal(accepted.code, 0, accepted.stderr);
  return fx;
}

test("the shipped layer includes layer 1", () => {
  assert.ok(COUNCIL_LAYER >= 1);
});

test("an invalid provider answer gets one repair with the prepared prompt, and the repaired answer is accepted", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await oneSeatOpen(t, clock);
  const turn = currentOf(fx, "s2");
  completeJob(fx, turn.job_id, 10, INVALID);
  const pending = await collect(fx);
  assert.equal(pending.json.wake, "budget", pending.stdout);
  // The repair replaced the turn: a fresh job (the turn's job has no thread) with the prepared
  // prompt, which is the full round prompt, the validation errors and the schema.
  const observation = observationOf(fx, turn.id);
  assert.deepEqual([observation.outcome, observation.replacement_required], ["invalid", 1]);
  const [first, repair] = attemptsOf(fx, "s2");
  assert.equal(first.id, turn.id);
  assert.notEqual(first.retired_at, null);
  assert.deepEqual([repair.charge, repair.kind, repair.replaces_id, repair.predecessor_id], ["repair", "create", turn.id, null]);
  assert.equal(repair.prompt_sha256, observation.replacement_sha256);
  assert.equal(repair.retry_prompt_sha256, turn.retry_prompt_sha256);
  assert.notEqual(turn.retry_prompt_sha256, null);
  const errors = JSON.parse(objectText(fx, observation.errors_sha256, "json"));
  const expected = renderRepairPrompt({ basePrompt: objectText(fx, turn.prompt_sha256, "md"), errors, schemaText: roundSchemaText(1) });
  assert.equal(objectText(fx, repair.prompt_sha256, "md"), expected);
  assert.ok(expected.startsWith(objectText(fx, turn.prompt_sha256, "md").trimEnd()));
  assert.ok(errors.length > 0 && errors.every((line) => expected.includes(line)));
  assert.notEqual(repair.job_id, null);
  assert.equal(jobRow(fx, repair.job_id).prompt, expected);
  const open = (await status(fx)).rounds[0];
  assert.deepEqual([open.repairs, open.retries, open.memberTurns], [1, 0, 3]);

  // The repaired job answers valid: the round closes with s2 valid on the repair job.
  clock.set(20);
  completeJob(fx, repair.job_id, 20, VALID);
  const closed = await collect(fx);
  assert.equal(closed.code, 0, closed.stdout);
  assert.deepEqual([closed.json.wake, closed.json.quorum, closed.json.validSeats], ["closed", true, 3]);
  assert.deepEqual([closed.json.repairs, closed.json.retries, closed.json.memberTurns], [1, 0, 3]);
  assert.deepEqual(closed.json.seats.find((seat) => seat.seat === "s2"), {
    seat: "s2",
    family: "codex",
    state: "valid",
    reason: null,
    jobId: repair.job_id,
    answerSha256: seatRow(fx, "s2").answer_sha256,
    forcedReasons: []
  });
});

test("a second invalid answer after the repair is final", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await oneSeatOpen(t, clock);
  completeJob(fx, currentOf(fx, "s2").job_id, 10, INVALID);
  await collect(fx);
  const repair = currentOf(fx, "s2");
  assert.equal(repair.charge, "repair");
  clock.set(20);
  completeJob(fx, repair.job_id, 20, INVALID);
  const closed = await collect(fx);
  assert.equal(closed.json.wake, "closed");
  assert.deepEqual([seatRow(fx, "s2").state, seatRow(fx, "s2").reason], ["invalid", "schema validation failed"]);
  assert.deepEqual(attemptsOf(fx, "s2").map((row) => row.charge), ["turn", "repair"]);
  assert.deepEqual([closed.json.repairs, closed.json.retries], [1, 0]);
});

test("a transient failure gets one retry, a second one is final, and quota or a permanent failure gets none", async (t) => {
  const clock = useTestClock(t, 0);
  {
    const fx = await oneSeatOpen(t, clock);
    const turn = currentOf(fx, "s2");
    failJob(fx, turn.job_id, 10, "socket hang up");
    await collect(fx);
    const observation = observationOf(fx, turn.id);
    assert.deepEqual([observation.outcome, observation.transient, observation.replacement_required], ["failure", 1, 1]);
    const retry = currentOf(fx, "s2");
    assert.deepEqual([retry.charge, retry.kind, retry.replaces_id], ["retry", "create", turn.id]);
    assert.equal(retry.prompt_sha256, observation.replacement_sha256);
    const expected = renderRetryPrompt({ issuedAt: EPOCH + 10, basePrompt: objectText(fx, turn.prompt_sha256, "md"), reason: "transient provider failure" });
    assert.equal(objectText(fx, retry.prompt_sha256, "md"), expected);
    assert.equal(expected.split("\n")[1], "Previous attempt: transient provider failure.");
    assert.equal((await status(fx)).rounds[0].retries, 1);
    clock.set(20);
    failJob(fx, retry.job_id, 20, "socket hang up");
    const closed = await collect(fx);
    assert.equal(closed.json.wake, "closed");
    assert.deepEqual([seatRow(fx, "s2").state, seatRow(fx, "s2").reason], ["error", "transient provider failure"]);
    assert.deepEqual(attemptsOf(fx, "s2").map((row) => row.charge), ["turn", "retry"]);
    assert.deepEqual([closed.json.repairs, closed.json.retries, closed.json.memberTurns], [0, 1, 3]);
  }
  for (const [error, readUsage, state, reason] of [
    ["codex returned no structured output", async () => REACHED, "quota-exhausted", "quota exhausted"],
    ["permission denied", async () => null, "error", "provider failure"]
  ]) {
    const fx = await oneSeatOpen(t, clock);
    failJob(fx, currentOf(fx, "s2").job_id, 10, error);
    const closed = await collect(fx, 1, { readUsage });
    assert.equal(closed.json.wake, "closed", state);
    assert.deepEqual([seatRow(fx, "s2").state, seatRow(fx, "s2").reason], [state, reason]);
    assert.deepEqual(attemptsOf(fx, "s2").map((row) => row.charge), ["turn"], state);
    assert.equal(observationOf(fx, attemptsOf(fx, "s2")[0].id).replacement_required, 0);
  }
});

test("repair and retry are separate slots, used in either order, then the next failure is final", async (t) => {
  const clock = useTestClock(t, 0);
  // Repair, then retry, then an invalid answer is final.
  {
    const fx = await oneSeatOpen(t, clock);
    completeJob(fx, currentOf(fx, "s2").job_id, 10, INVALID);
    await collect(fx);
    clock.set(20);
    failJob(fx, currentOf(fx, "s2").job_id, 20, "socket hang up");
    await collect(fx);
    assert.deepEqual(attemptsOf(fx, "s2").map((row) => row.charge), ["turn", "repair", "retry"]);
    clock.set(30);
    completeJob(fx, currentOf(fx, "s2").job_id, 30, INVALID);
    const closed = await collect(fx);
    assert.equal(closed.json.wake, "closed");
    assert.deepEqual([seatRow(fx, "s2").state, seatRow(fx, "s2").reason], ["invalid", "schema validation failed"]);
    assert.deepEqual([closed.json.repairs, closed.json.retries, closed.json.memberTurns], [1, 1, 3]);
  }
  // Retry, then repair, then a late answer is final.
  {
    const fx = await oneSeatOpen(t, clock, { timeoutMs: 1000 });
    failJob(fx, currentOf(fx, "s2").job_id, 10, "socket hang up");
    await collect(fx);
    clock.set(20);
    completeJob(fx, currentOf(fx, "s2").job_id, 20, INVALID);
    await collect(fx);
    assert.deepEqual(attemptsOf(fx, "s2").map((row) => row.charge), ["turn", "retry", "repair"]);
    const repair = currentOf(fx, "s2");
    clock.set(1100);
    completeJob(fx, repair.job_id, 1090, VALID, { claimed_at: EPOCH + 30, started_at: EPOCH + 30 });
    const closed = await collect(fx);
    assert.equal(closed.json.wake, "closed");
    assert.deepEqual([seatRow(fx, "s2").state, seatRow(fx, "s2").reason], ["timed-out", "execution deadline expired"]);
    assert.deepEqual([closed.json.repairs, closed.json.retries], [1, 1]);
  }
});

test("a late provider answer gets a retry, and a silent Claude seat gets one retry prompt whose expiry ends it", async (t) => {
  const clock = useTestClock(t, 0);
  // A late provider answer: the retry uses the retry prompt prepared at the start.
  {
    const fx = await oneSeatOpen(t, clock, { timeoutMs: 1000 });
    const turn = currentOf(fx, "s2");
    clock.set(1100);
    completeJob(fx, turn.job_id, 1050, VALID, { claimed_at: EPOCH + 20, started_at: EPOCH + 20 });
    await collect(fx);
    assert.deepEqual(observationOf(fx, turn.id).outcome, "late");
    const retry = currentOf(fx, "s2");
    assert.deepEqual([retry.charge, retry.kind, retry.prompt_sha256], ["retry", "create", turn.retry_prompt_sha256]);
    const text = objectText(fx, retry.prompt_sha256, "md");
    assert.match(text.split("\n")[0], /^Reissued at \d{4}-\d\d-\d\dT[0-9:.]+Z; answer this prompt, not an earlier one\.$/);
    assert.ok(text.includes(objectText(fx, turn.prompt_sha256, "md").trimEnd()));
  }
  // A silent Claude seat: the retry prompt is a new delivery to the leader.
  {
    const fx = await started(t, clock, { timeoutMs: 1000 });
    clock.set(10);
    completeJob(fx, currentOf(fx, "s2").job_id, 10, VALID);
    completeJob(fx, currentOf(fx, "s3").job_id, 10, VALID);
    const turn = currentOf(fx, "s1");
    clock.set(1000);
    const woke = await collect(fx);
    assert.equal(woke.json.wake, "prompt", woke.stdout);
    const retry = currentOf(fx, "s1");
    assert.deepEqual([retry.charge, retry.kind, retry.replaces_id, retry.prompt_sha256], ["retry", "prompt", turn.id, turn.retry_prompt_sha256]);
    assert.equal(retry.issued_at, retry.created_at);
    const delivery = { seat: "s1", intentId: retry.id, promptFile: path.join(fx.dir, "objects", `${retry.prompt_sha256}.md`), deadline: new Date(EPOCH + 2000).toISOString() };
    assert.deepEqual(woke.json.deliveries, [delivery]);
    assert.deepEqual((await status(fx)).deliveries, [delivery]);
    assert.match(fs.readFileSync(delivery.promptFile, "utf8"), /^Reissued at /);
    assert.equal((await submit(fx, "s1", turn.id, VALID)).json.error, "intent-not-open");
    // The retry prompt expires too: the seat ends timed-out, and the round closes.
    clock.set(2000);
    const closed = await collect(fx);
    assert.deepEqual([closed.json.wake, closed.json.quorum, closed.json.retries, closed.json.memberTurns], ["closed", true, 1, 3]);
    assert.deepEqual([seatRow(fx, "s1").state, seatRow(fx, "s1").reason], ["timed-out", "reply deadline expired"]);
  }
});

test("an invalid Claude reply gets a repair prompt through submit", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await started(t, clock);
  const turn = currentOf(fx, "s1");
  clock.set(10);
  const invalid = await submit(fx, "s1", turn.id, INVALID);
  assert.equal(invalid.code, 0, invalid.stderr);
  const repair = currentOf(fx, "s1");
  assert.deepEqual([repair.charge, repair.kind, repair.replaces_id], ["repair", "prompt", turn.id]);
  assert.deepEqual([invalid.json.state, invalid.json.deliveries.map((delivery) => delivery.intentId)], ["running", [repair.id]]);
  const observation = observationOf(fx, turn.id);
  const errors = JSON.parse(objectText(fx, observation.errors_sha256, "json"));
  assert.equal(objectText(fx, repair.prompt_sha256, "md"), renderRepairPrompt({ basePrompt: objectText(fx, turn.prompt_sha256, "md"), errors, schemaText: roundSchemaText(1) }));
  // The old intent is answered; the repair intent takes a valid reply.
  assert.equal((await submit(fx, "s1", turn.id, VALID)).json.error, "duplicate-receipt");
  const accepted = await submit(fx, "s1", repair.id, VALID);
  assert.deepEqual([accepted.code, accepted.json.state], [0, "valid"]);
  assert.equal((await status(fx)).rounds[0].repairs, 1);
});

test("a replacement continues a job with a thread, and a threadless round 2 job gets a fresh job with the whole round prompt", async (t) => {
  const clock = useTestClock(t, 0);
  // Round 1: s2's ended job recorded a thread, so its repair continues that job.
  const fx = await oneSeatOpen(t, clock);
  const turn = currentOf(fx, "s2");
  completeJob(fx, turn.job_id, 10, INVALID, { thread_id: "thread-2" });
  await collect(fx);
  const repair = currentOf(fx, "s2");
  assert.deepEqual([repair.charge, repair.kind, repair.predecessor_id], ["repair", "continue", turn.job_id]);
  const successor = jobRow(fx, repair.job_id);
  assert.equal(successor.continues, turn.job_id);
  const message = fx.store.read((db) => db.prepare("SELECT text FROM messages WHERE chain_id = ? ORDER BY id DESC").get(successor.chain_id)).text;
  assert.equal(message, objectText(fx, repair.prompt_sha256, "md"));

  // The repaired job answers valid; Round 1 closes and Round 2 continues the repaired job.
  clock.set(20);
  completeJob(fx, repair.job_id, 20, VALID, { thread_id: "thread-2" });
  assert.equal((await collect(fx)).json.quorum, true);
  const crossed = await council(["crossexam", fx.runId, "--json"], { cwd: fx.cwd });
  assert.equal(crossed.code, 0, crossed.stderr);
  const r2 = currentOf(fx, "s2", 2);
  assert.deepEqual([r2.charge, r2.kind, r2.predecessor_id], ["turn", "continue", repair.job_id]);
  assert.equal(jobRow(fx, r2.job_id).continues, repair.job_id);
  assert.notEqual(r2.retry_prompt_sha256, null);

  // Round 2: the turn's job ends invalid with no thread; the repair is a fresh job whose prompt
  // holds the full Round 2 prompt, with the anonymised bundle.
  clock.set(30);
  completeJob(fx, r2.job_id, 30, INVALID, { thread_id: null });
  await collect(fx, 2);
  const fresh = currentOf(fx, "s2", 2);
  assert.deepEqual([fresh.charge, fresh.kind, fresh.predecessor_id], ["repair", "create", null]);
  const base = objectText(fx, r2.prompt_sha256, "md");
  assert.ok(base.includes("The other members' findings"));
  const prompt = jobRow(fx, fresh.job_id).prompt;
  assert.ok(prompt.startsWith(base.trimEnd()));
  assert.ok(prompt.includes(roundSchemaText(2).trim()));
  assert.equal(jobRow(fx, fresh.job_id).continues, null);
});

test("a fresh replacement whose seat label is still held retries once without a label", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await oneSeatOpen(t, clock);
  const turn = currentOf(fx, "s2");
  completeJob(fx, turn.job_id, 10, INVALID);
  // Another live chain holds the seat's label.
  const label = `${fx.runId}-s2`;
  const holder = fx.store.read((db) => db.prepare("SELECT id FROM chains WHERE live_label = ?").get(label));
  if (!holder) {
    const { createJob } = await import("../plugins/agent/scripts/lib/state.mjs");
    createJob(fx.store, seatJobFields("codex"), { label });
  }
  await collect(fx);
  const repair = currentOf(fx, "s2");
  assert.equal(repair.charge, "repair");
  assert.notEqual(repair.job_id, null);
  assert.equal(repair.refusal, null);
  assert.equal(jobRow(fx, repair.job_id).label, null);
});

test("the member-turn cap counts turns only, and the report shows repairs and retries", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await started(t, clock, { timeoutMs: 1000 });
  clock.set(10);
  completeJob(fx, currentOf(fx, "s2").job_id, 10, INVALID);
  failJob(fx, currentOf(fx, "s3").job_id, 10, "permission denied");
  await collect(fx);
  clock.set(20);
  completeJob(fx, currentOf(fx, "s2").job_id, 20, VALID);
  await collect(fx);
  // s1 stays silent: one retry prompt at 1000, which expires at 2000; only s2 is valid.
  clock.set(1000);
  assert.equal((await collect(fx)).json.wake, "prompt");
  clock.set(2000);
  const closed = await collect(fx);
  assert.deepEqual([closed.code, closed.json.quorum, closed.json.memberTurns, closed.json.repairs, closed.json.retries], [1, false, 3, 1, 1]);
  const report = await council(["report", fx.runId, "--json"], { cwd: fx.cwd });
  assert.equal(report.code, 0, report.stderr);
  const text = fs.readFileSync(report.json.file, "utf8");
  assert.ok(text.includes(`Run ${fx.runId} · review · 2 rounds · member turns 3 of 12 (repairs 1, retries 1)`), text);
});

test("a round seeded at layer 0 and reduced at layer 1 still closes", async (t) => {
  const clock = useTestClock(t, 0);
  const { store, runDir } = openCouncilStore(t);
  const { seats } = await seedRun(store, runDir, { layer: 0 });
  const ids = Object.fromEntries(seats.map((seat) => [seat.seat, seat.attemptId]));
  clock.set(10);
  const job2 = bindAttempt(store, ids.s2).jobId;
  const job3 = bindAttempt(store, ids.s3, { provider: "agy" }).jobId;
  for (const jobId of [job2, job3]) {
    setJob(store, jobId, { claimed_at: EPOCH + 10, end_state: "completed", end_at: EPOCH + 20 });
  }
  // Historical Layer 0 deposits: an invalid answer with no prepared repair digest.
  assert.deepEqual(await observe(store, ids.s2, job2, { outcome: "invalid", eventAt: EPOCH + 20, reason: "schema validation failed" }, 0), { ok: true });
  assert.deepEqual(await observe(store, ids.s3, job3, { outcome: "valid", eventAt: EPOCH + 20, answerSha256: "3".repeat(64) }, 0), { ok: true });
  // A new Layer 1 invalid receipt without its prepared repair digest is refused before any write.
  clock.set(30);
  assert.deepEqual(await receive(store, "run-1", "s1", ids.s1, { outcome: "invalid", errorsSha256: "e".repeat(64), reason: "schema validation failed" }, 1), {
    ok: false,
    reason: "replacement-digest-missing",
    round: 1
  });
  await reduce(store, "run-1", 1, 1);
  const rows = () => readCouncil(store, "run-1");
  assert.deepEqual(
    rows().seatRounds.map((row) => [row.seat, row.state, row.reason]),
    [
      ["s1", "running", null],
      ["s2", "invalid", "schema validation failed"],
      ["s3", "valid", null]
    ]
  );
  // The silent Layer 0 prompt has no prepared retry object: its retry uses the turn prompt.
  clock.set(1000);
  await reduce(store, "run-1", 1, 1);
  const retry = rows().attempts.find((row) => row.seat === "s1" && row.charge === "retry");
  assert.equal(retry.prompt_sha256, seats[0].promptSha256);
  assert.equal(retry.retry_prompt_sha256, null);
  clock.set(2000);
  assert.deepEqual(await reduce(store, "run-1", 1, 1), { ok: true, changed: true, closed: true });
  assert.deepEqual(
    rows().seatRounds.map((row) => [row.seat, row.state, row.reason]),
    [
      ["s1", "timed-out", "reply deadline expired"],
      ["s2", "invalid", "schema validation failed"],
      ["s3", "valid", null]
    ]
  );
  assert.equal(rows().rounds[0].quorum, 0);
});

test("the council's own stop records first-cancellation evidence, and only that cancellation gets the retry", async (t) => {
  const clock = useTestClock(t, 0);
  const deps = () => ({ layer: 1, deadline: performance.now() + 10000, readRequester: async () => ({ sessionId: "session-1" }), stamps: new Map() });
  for (const foreignFirst of [false, true]) {
    clock.set(0);
    const { store, runDir } = openCouncilStore(t);
    const { seats } = await seedRun(store, runDir, { layer: 1 });
    const s2 = seats[1].attemptId;
    clock.set(10);
    const jobId = bindAttempt(store, s2).jobId;
    setJob(store, jobId, { claimed_at: EPOCH + 10, started_at: EPOCH + 10 });
    if (foreignFirst) {
      setJob(store, jobId, { cancel_requested_at: EPOCH + 500 });
    }
    clock.set(1010);
    await reduce(store, "run-1", 1, 1);
    let stops = readCouncil(store, "run-1").stops;
    if (foreignFirst) {
      // B6 does not stop a job whose cancellation was requested elsewhere; the fixture adds the
      // council stop that a collector would have recorded before the foreign request.
      assert.equal(stops.length, 0);
      store.transact((db) => db.prepare("INSERT INTO council_stops (job_id, requested_at, cause) VALUES (?, ?, 'deadline')").run(jobId, EPOCH + 1010));
    } else {
      assert.deepEqual(stops.map((stop) => [stop.job_id, stop.cause]), [[jobId, "deadline"]]);
    }
    clock.set(1011);
    const outcome = await dispatchStops(store, readCouncil(store, "run-1").run, deps());
    assert.deepEqual([outcome.pending, outcome.errors], [0, []]);
    stops = readCouncil(store, "run-1").stops;
    assert.equal(stops[0].dispatched_at - EPOCH, 1011);
    assert.deepEqual(readCouncil(store, "run-1").cancels.map((row) => [row.job_id, row.committed_at - EPOCH]), foreignFirst ? [] : [[jobId, 1011]]);
    // The job ends cancelled; its observation is attributed by the evidence.
    setJob(store, jobId, { end_state: "cancelled", end_at: EPOCH + 1020, exec_released_at: EPOCH + 1020, release_kind: "confirmed" });
    clock.set(1021);
    assert.deepEqual(await observe(store, s2, jobId, { outcome: "cancelled", eventAt: EPOCH + 1020, reason: "job cancelled" }, 1), { ok: true });
    await reduce(store, "run-1", 1, 1);
    const row = readCouncil(store, "run-1").seatRounds.find((entry) => entry.seat === "s2");
    if (foreignFirst) {
      assert.deepEqual([row.state, row.reason], ["error", "external cancellation"]);
    } else {
      const retry = readCouncil(store, "run-1").attempts.find((entry) => entry.id === row.current_id);
      assert.deepEqual([row.state, retry.charge, retry.kind], ["issuing", "retry", "create"]);
    }
  }
});

test("an ended job whose replacement prompt cannot be prepared ends as an error without a replacement, and the round closes", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await oneSeatOpen(t, clock);
  const turn = currentOf(fx, "s2");
  fs.rmSync(path.join(fx.dir, "objects", `${turn.prompt_sha256}.md`));
  completeJob(fx, turn.job_id, 10, INVALID);
  const closed = await collect(fx);
  assert.deepEqual([closed.code, closed.json.wake, closed.json.quorum, closed.json.repairs], [0, "closed", true, 0], closed.stdout);
  assert.deepEqual([seatRow(fx, "s2").state, seatRow(fx, "s2").reason], ["error", "replacement prompt unavailable"]);
  assert.deepEqual(attemptsOf(fx, "s2").map((row) => row.charge), ["turn"]);
  assert.deepEqual(observationOf(fx, turn.id).outcome, "failure");
  assert.equal(closed.json.diagnostics.length, 1);
  assert.deepEqual([closed.json.diagnostics[0].seat, closed.json.diagnostics[0].jobId, closed.json.diagnostics[0].problem], ["s2", turn.job_id, "replacement-unavailable"]);
  assert.match(closed.stderr, /Seat s2: /);
});

test("a plain-text submit of an invalid Claude reply names the repair prompt", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await started(t, clock);
  const turn = currentOf(fx, "s1");
  clock.set(10);
  const file = path.join(fx.cwd, "reply.json");
  fs.writeFileSync(file, INVALID);
  const result = await council(["submit", fx.runId, "s1", "--intent", turn.id, "--file", file], { cwd: fx.cwd });
  assert.equal(result.code, 0, result.stderr);
  const repair = currentOf(fx, "s1");
  assert.equal(repair.charge, "repair");
  const line = result.stdout.split("\n").find((entry) => entry.includes(repair.id)) ?? "";
  assert.ok(line.includes(path.join(fx.dir, "objects", `${repair.prompt_sha256}.md`)), result.stdout);
  assert.ok(line.includes(new Date(repair.issue_by).toISOString()), result.stdout);
});
