import test from "node:test";
import assert from "node:assert/strict";

import * as fx from "./store-fixtures.mjs";
import { stopOwnedProcess, stopOwnedProcesses } from "./helpers.mjs";
import { makeStoreDir, rawAll, rawExec, runLibChild } from "./store-fixtures.mjs";
import * as store from "../plugins/agent/scripts/lib/store.mjs";
import * as state from "../plugins/agent/scripts/lib/state.mjs";
import * as mailbox from "../plugins/agent/scripts/lib/mailbox.mjs";
import * as processLib from "../plugins/agent/scripts/lib/process.mjs";

const CLAIM = { pid: 4242, startToken: "tok-4242", groupId: null, limits: { maxParallel: 8 } };

function jobFields(overrides = {}) {
  return {
    provider: "codex",
    kind: "task",
    title: "a task",
    prompt: "do the thing",
    request: { cwd: "." },
    cwd: ".",
    requester: { sessionId: "session-1", leaderPid: null, leaderStartToken: null },
    ...overrides
  };
}

function openTestStore(t, stateDir) {
  const opened = store.openStore(stateDir);
  t.after(() => opened.close());
  return opened;
}

function claimedJob(db, overrides = {}) {
  const { jobId } = state.createJob(db, jobFields(overrides));
  const { execGen } = state.claimExecution(db, jobId, CLAIM);
  return { jobId, execGen };
}

// One pending message and one dispatched by the job itself, inserted through plain SQL.
function seedOpenMessages(stateDir, jobId, execGen) {
  rawExec(
    stateDir,
    `INSERT INTO messages (chain_id, text, created_at) VALUES ('${jobId}', 'first', 1), ('${jobId}', 'second', 2);
     UPDATE messages SET state = 'dispatched', attempts = 1, dispatched_at = 3, dispatched_job_id = '${jobId}',
       dispatched_gen = ${execGen} WHERE text = 'first' AND chain_id = '${jobId}';`
  );
}

test("a failed end drops pending and dispatched messages in the same transaction", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const { jobId, execGen } = claimedJob(db);
  seedOpenMessages(stateDir, jobId, execGen);
  const outcome = state.recordEnd(db, jobId, { state: "failed", by: "worker", execGen, error: "the turn failed", leader: "none" });
  assert.equal(outcome.won, true);
  assert.equal(outcome.successorId, null);
  const endAt = rawAll(stateDir, `SELECT end_at FROM jobs WHERE id = '${jobId}'`)[0].end_at;
  const messages = rawAll(stateDir, "SELECT text, state, close_cause, closed_at FROM messages ORDER BY id");
  assert.deepEqual(messages, [
    { text: "first", state: "dropped", close_cause: "failed", closed_at: endAt },
    { text: "second", state: "dropped", close_cause: "failed", closed_at: endAt }
  ]);
  const event = rawAll(stateDir, `SELECT kind, text FROM events WHERE job_id = '${jobId}'`)[0];
  assert.deepEqual(event, { kind: "failed", text: "the turn failed" });
  assert.equal(state.readJobView(db, jobId).state, "failed");
});

test("a cancelled end drops open messages and a natural end keeps them", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const cancelled = claimedJob(db);
  seedOpenMessages(stateDir, cancelled.jobId, cancelled.execGen);
  assert.equal(state.recordEnd(db, cancelled.jobId, { state: "cancelled", by: "worker", execGen: cancelled.execGen, reason: "tree-stop" }).won, true);
  assert.deepEqual(
    rawAll(stateDir, `SELECT state, close_cause FROM messages WHERE chain_id = '${cancelled.jobId}' ORDER BY id`),
    [
      { state: "dropped", close_cause: "cancelled" },
      { state: "dropped", close_cause: "cancelled" }
    ]
  );
  assert.equal(rawAll(stateDir, `SELECT count(*) AS n FROM events WHERE job_id = '${cancelled.jobId}'`)[0].n, 0);

  const natural = claimedJob(db, { title: "natural" });
  seedOpenMessages(stateDir, natural.jobId, natural.execGen);
  const outcome = state.recordEnd(db, natural.jobId, {
    state: "completed",
    by: "worker",
    execGen: natural.execGen,
    leader: "unknown",
    result: { text: "done", json: null, logged: false }
  });
  assert.equal(outcome.won, true);
  assert.equal(outcome.successorId, null);
  assert.deepEqual(
    rawAll(stateDir, `SELECT state FROM messages WHERE chain_id = '${natural.jobId}' ORDER BY id`).map((row) => row.state),
    ["dispatched", "pending"]
  );
  const lost = state.recordEnd(db, natural.jobId, { state: "interrupted", by: "reconcile", reason: "worker-dead" });
  assert.equal(lost.won, false);
  assert.equal(lost.view.state, "completed");
});

// ---------------------------------------------------------------------------------------------
// Chain messages, dispatch, confirmation and order

function startSoon(ms = 1000) {
  return String(Date.now() + ms);
}

// Ends a claimed job's turn as interrupted and releases its execution, so its successor can claim.
function interruptAndRelease(stateDir, jobId) {
  rawExec(
    stateDir,
    `UPDATE jobs SET end_state = 'interrupted', end_at = 10, end_by = 'reconcile' WHERE id = '${jobId}';
     UPDATE jobs SET exec_released_at = 11, release_kind = 'confirmed', active_thread_key = NULL WHERE id = '${jobId}';`
  );
}

function resumableJob(db, overrides = {}) {
  const { jobId, execGen } = claimedJob(db, overrides);
  state.recordThread(db, jobId, execGen, { threadId: `th-${jobId}`, resumeMethod: "thread" });
  state.recordIntent(db, jobId, execGen, "submit", { clientMessageId: "c" });
  state.recordIntent(db, jobId, execGen, "started", {});
  return { jobId, execGen };
}

test("a redispatch by a new job raises attempts by exactly one", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const first = resumableJob(db);
  const sent = mailbox.sendToChain(db, { ref: first.jobId, observedTipId: first.jobId }, { text: "hello", requester: null });
  assert.equal(sent.outcome, "running");
  assert.deepEqual(mailbox.dispatchMessage(db, sent.messageId, { jobId: first.jobId, execGen: first.execGen }), { won: true, attempts: 1 });
  interruptAndRelease(stateDir, first.jobId);
  const decision = state.decideNext(db, { ref: first.jobId, observedTipId: first.jobId }, { action: "continue", requester: null });
  const { execGen } = state.claimExecution(db, decision.successorId, CLAIM);
  assert.deepEqual(mailbox.dispatchMessage(db, sent.messageId, { jobId: decision.successorId, execGen }), { won: true, attempts: 2 });
  const row = rawAll(stateDir, `SELECT state, attempts, dispatched_job_id, dispatched_gen FROM messages WHERE id = ${sent.messageId}`)[0];
  assert.deepEqual(row, { state: "dispatched", attempts: 2, dispatched_job_id: decision.successorId, dispatched_gen: execGen });
});

test("dispatch refuses a non-tip, another chain, a stale or released generation, a stop, an ended job, and a second dispatch by the same execution", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const job = resumableJob(db);
  const other = resumableJob(db, { title: "other" });
  const message = mailbox.sendToChain(db, { ref: job.jobId, observedTipId: job.jobId }, { text: "m" }).messageId;
  assert.equal(mailbox.dispatchMessage(db, message, { jobId: other.jobId, execGen: other.execGen }).reason, "other-chain");
  assert.equal(mailbox.dispatchMessage(db, message, { jobId: job.jobId, execGen: job.execGen + 1 }).reason, "fenced");
  assert.equal(mailbox.dispatchMessage(db, message, { jobId: job.jobId, execGen: job.execGen }).won, true);
  assert.deepEqual(mailbox.dispatchMessage(db, message, { jobId: job.jobId, execGen: job.execGen }), {
    won: false,
    state: "dispatched",
    reason: "already-dispatched"
  });
  const stopped = resumableJob(db, { title: "stopped" });
  const stopMessage = mailbox.sendToChain(db, { ref: stopped.jobId }, { text: "s" }).messageId;
  rawExec(stateDir, `UPDATE jobs SET stop_requested_at = 1, stop_reason = 'session-end', stop_deadline = 2 WHERE id = '${stopped.jobId}'`);
  assert.equal(mailbox.dispatchMessage(db, stopMessage, { jobId: stopped.jobId, execGen: stopped.execGen }).reason, "fenced");
  const released = resumableJob(db, { title: "released" });
  const releasedMessage = mailbox.sendToChain(db, { ref: released.jobId }, { text: "r" }).messageId;
  rawExec(stateDir, `UPDATE jobs SET exec_released_at = 1, release_kind = 'confirmed', active_thread_key = NULL WHERE id = '${released.jobId}'`);
  assert.equal(mailbox.dispatchMessage(db, releasedMessage, { jobId: released.jobId, execGen: released.execGen }).reason, "fenced");
  const ended = resumableJob(db, { title: "ended" });
  const endedMessage = mailbox.sendToChain(db, { ref: ended.jobId }, { text: "e" }).messageId;
  state.recordEnd(db, ended.jobId, { state: "completed", by: "worker", execGen: ended.execGen, leader: "unknown" });
  assert.equal(mailbox.dispatchMessage(db, endedMessage, { jobId: ended.jobId, execGen: ended.execGen }).reason, "ended");
  interruptAndRelease(stateDir, other.jobId);
  const otherMessage = mailbox.sendToChain(db, { ref: other.jobId, observedTipId: other.jobId }, { text: "o" });
  assert.equal(otherMessage.outcome, "continued");
  assert.equal(mailbox.dispatchMessage(db, otherMessage.messageId, { jobId: other.jobId, execGen: other.execGen }).reason, "not-tip");
  const before = rawAll(stateDir, "SELECT * FROM messages ORDER BY id");
  assert.equal(mailbox.withdrawMessage(db, otherMessage.messageId), true);
  assert.equal(mailbox.withdrawMessage(db, otherMessage.messageId), false);
  assert.equal(mailbox.dispatchMessage(db, otherMessage.messageId, { jobId: otherMessage.jobId, execGen: 0 }).reason, "closed");
  assert.equal(before.length, rawAll(stateDir, "SELECT count(*) AS n FROM messages")[0].n);
});

test("confirmation needs the expected dispatcher and a live observing execution", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const job = resumableJob(db);
  const message = mailbox.sendToChain(db, { ref: job.jobId }, { text: "m" }).messageId;
  const receipt = { expectedJobId: job.jobId, expectedGen: job.execGen, observingJobId: job.jobId, observingGen: job.execGen, proof: "receipt" };
  assert.deepEqual(mailbox.confirmMessage(db, message, receipt), { confirmed: false, state: "pending", dispatchedJobId: null, dispatchedGen: null });
  mailbox.dispatchMessage(db, message, { jobId: job.jobId, execGen: job.execGen });
  assert.equal(mailbox.confirmMessage(db, message, { ...receipt, expectedGen: job.execGen + 1 }).confirmed, false);
  assert.equal(mailbox.confirmMessage(db, message, { ...receipt, observingGen: job.execGen + 1 }).confirmed, false);
  assert.deepEqual(mailbox.confirmMessage(db, message, receipt), { confirmed: true });
  assert.equal(mailbox.confirmMessage(db, message, receipt).confirmed, false);
  const outcome = mailbox.readMessageOutcome(db, message);
  assert.equal(outcome.state, "consumed");
  assert.equal(outcome.consumedJobId, job.jobId);
  assert.equal(outcome.tipId, job.jobId);
  const released = resumableJob(db, { title: "released" });
  const releasedMessage = mailbox.sendToChain(db, { ref: released.jobId }, { text: "r" }).messageId;
  mailbox.dispatchMessage(db, releasedMessage, { jobId: released.jobId, execGen: released.execGen });
  rawExec(stateDir, `UPDATE jobs SET exec_released_at = 1, release_kind = 'confirmed', active_thread_key = NULL WHERE id = '${released.jobId}'`);
  assert.equal(
    mailbox.confirmMessage(db, releasedMessage, {
      expectedJobId: released.jobId,
      expectedGen: released.execGen,
      observingJobId: released.jobId,
      observingGen: released.execGen,
      proof: "receipt"
    }).confirmed,
    false
  );
});

test("history confirmation records the continuing job as consumer", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const first = resumableJob(db);
  const message = mailbox.sendToChain(db, { ref: first.jobId }, { text: "m" }).messageId;
  mailbox.dispatchMessage(db, message, { jobId: first.jobId, execGen: first.execGen });
  interruptAndRelease(stateDir, first.jobId);
  const { successorId } = state.decideNext(db, { ref: first.jobId, observedTipId: first.jobId }, { action: "continue" });
  const { execGen } = state.claimExecution(db, successorId, CLAIM);
  assert.equal(
    mailbox.confirmMessage(db, message, { expectedJobId: successorId, expectedGen: execGen, observingJobId: successorId, observingGen: execGen, proof: "history" })
      .confirmed,
    false
  );
  assert.deepEqual(
    mailbox.confirmMessage(db, message, {
      expectedJobId: first.jobId,
      expectedGen: first.execGen,
      observingJobId: successorId,
      observingGen: execGen,
      proof: "history"
    }),
    { confirmed: true }
  );
  const row = rawAll(stateDir, `SELECT state, dispatched_job_id, consumed_job_id, attempts FROM messages WHERE id = ${message}`)[0];
  assert.deepEqual(row, { state: "consumed", dispatched_job_id: first.jobId, consumed_job_id: successorId, attempts: 1 });
});

test("message ids follow commit order across two senders", { timeout: 60000 }, async (t) => {
  const stateDir = makeStoreDir(t);
  const db = store.openStore(stateDir);
  const job = resumableJob(db);
  db.close();
  const env = { FIXTURE_START_AT: startSoon() };
  const results = await Promise.all(["a", "b"].map((sender) => runLibChild("fixture.sendMany", [{ $store: stateDir }, job.jobId, sender, 15], env)));
  for (const result of results) {
    assert.equal(result.ok, true, JSON.stringify(result.error));
    const ids = result.value;
    assert.deepEqual([...ids].sort((left, right) => left - right), ids);
  }
  const rows = rawAll(stateDir, "SELECT id, text FROM messages ORDER BY id");
  assert.equal(rows.length, 30);
  for (const sender of ["a", "b"]) {
    const texts = rows.filter((row) => row.text.startsWith(sender)).map((row) => row.text);
    assert.deepEqual(texts, Array.from({ length: 15 }, (_, index) => `${sender}${index}`));
  }
  assert.deepEqual(
    mailbox.composeRequestText({ messageId: 7, uncertain: true, body: "the body", additions: ["extra line"] }),
    "[message 7]\nThis message may already have reached you before the interruption:\nthe body\n\nextra line"
  );
  assert.equal(mailbox.composeRequestText({ messageId: null, uncertain: false, body: mailbox.CONTINUE_LINE, additions: [] }), mailbox.CONTINUE_LINE);
  assert.throws(() => mailbox.composeRequestText({ messageId: 1, body: "b", additions: ["x".repeat(4097)] }), RangeError);
  assert.equal(mailbox.messageClientId("abc", 5), "agent-abc-5");
  assert.equal(mailbox.submitClientId("abc", "task-1"), "agent-abc-task-1");
});

// ---------------------------------------------------------------------------------------------
// Messages through the worker harness on the test driver

function steerRequests(stateDir, jobId) {
  return fx.readTrace(stateDir, jobId).filter((entry) => entry.type === "steer-accepted");
}

function startTexts(stateDir, jobId) {
  return fx.readTrace(stateDir, jobId).filter((entry) => entry.request === "start").map((entry) => entry.text);
}

function setTestDriver(stateDir, jobId, testDriver) {
  rawExec(stateDir, "UPDATE jobs SET request_json = json_set(request_json, '$.testDriver', json(?)) WHERE id = ?", [JSON.stringify(testDriver), jobId]);
}

test("a message survives a worker that dies after taking it", { timeout: 60000 }, async (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const pids = fx.trackProcesses(t);
  const jobId = await fx.createDriverJob(db, { delayMs: 30000, steer: true, steerDelayMs: 20000 });
  const worker = fx.startTestWorker(stateDir, jobId, fx.workerEnv(), pids);
  await fx.waitFor(() => fx.jobRow(stateDir, jobId).started_at !== null, { describe: "the turn start" });
  pids.push(...fx.providerIdentities(stateDir, jobId));
  const { messageId } = mailbox.sendToChain(db, { ref: jobId }, { text: "taken" });
  await fx.waitFor(() => fx.readTrace(stateDir, jobId).some((entry) => entry.request === "steer"), { describe: "the steer request" });
  await stopOwnedProcess(worker.child);
  await worker.exit;
  await stopOwnedProcesses(fx.providerIdentities(stateDir, jobId));
  // The scan judges closure from the operating system, so it runs once the stopped provider is gone.
  const providers = fx.providerPids(stateDir, jobId);
  await fx.waitFor(async () => {
    const identities = await processLib.readProcessIdentities(providers, { deadline: performance.now() + 5000 });
    return providers.every((pid) => identities.get(pid)?.state === "absent");
  }, { describe: "the provider's exit" });
  process.env.AGENT_PLUGIN_TEST_CONTRACTS = fx.WORKER_CONTRACTS;
  t.after(() => delete process.env.AGENT_PLUGIN_TEST_CONTRACTS);
  await state.scanWorkspace(db, { deadline: performance.now() + 30000, launch: async () => null, leaderCheck: async () => new Map() });
  assert.equal(fx.jobRow(stateDir, jobId).end_state, "interrupted");
  const message = rawAll(stateDir, `SELECT state, attempts, dispatched_job_id FROM messages WHERE id = ${messageId}`)[0];
  assert.deepEqual(message, { state: "dispatched", attempts: 1, dispatched_job_id: jobId });
});

test("steers keep message id order across two senders", { timeout: 90000 }, async (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const pids = fx.trackProcesses(t);
  const jobId = await fx.createDriverJob(db, { delayMs: 30000, steer: true });
  const worker = fx.startTestWorker(stateDir, jobId, fx.workerEnv(), pids);
  await fx.waitFor(() => fx.jobRow(stateDir, jobId).started_at !== null, { describe: "the turn start" });
  pids.push(...fx.providerIdentities(stateDir, jobId));
  const env = { FIXTURE_START_AT: startSoon(800) };
  const senders = await Promise.all(["a", "b"].map((sender) => runLibChild("fixture.sendMany", [{ $store: stateDir }, jobId, sender, 10], env)));
  for (const sender of senders) {
    assert.equal(sender.ok, true, JSON.stringify(sender.error));
  }
  await fx.waitFor(() => steerRequests(stateDir, jobId).length === 20, { timeoutMs: 30000, describe: "twenty steers" });
  const ids = steerRequests(stateDir, jobId).map((entry) => Number(/^\[message (\d+)\]/.exec(entry.text)[1]));
  assert.deepEqual(ids, [...ids].sort((left, right) => left - right));
  const texts = steerRequests(stateDir, jobId).map((entry) => entry.text.split("\n")[1]);
  for (const sender of ["a", "b"]) {
    assert.deepEqual(
      texts.filter((text) => text.startsWith(sender)),
      Array.from({ length: 10 }, (_, index) => `${sender}${index}`)
    );
  }
  await fx.waitFor(() => rawAll(stateDir, "SELECT count(*) AS n FROM messages WHERE state = 'consumed'")[0].n === 20, { describe: "twenty receipts" });
  state.requestStop(db, { jobIds: [jobId] }, { reason: "session-end" });
  assert.equal((await worker.exit).code, 0);
});

test("a forced continuation of a failed tip sends no dropped message", { timeout: 60000 }, async (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const pids = fx.trackProcesses(t);
  const jobId = await fx.createDriverJob(db, { delayMs: 2000, fail: "the turn failed" }, { threadId: "th-fail" });
  const worker = fx.startTestWorker(stateDir, jobId, fx.workerEnv(), pids);
  await fx.waitFor(() => fx.jobRow(stateDir, jobId).started_at !== null, { describe: "the turn start" });
  pids.push(...fx.providerIdentities(stateDir, jobId));
  const execGen = fx.jobRow(stateDir, jobId).exec_gen;
  mailbox.sendToChain(db, { ref: jobId }, { text: "pending one" });
  const dispatched = mailbox.sendToChain(db, { ref: jobId }, { text: "dispatched one" }).messageId;
  assert.equal(mailbox.dispatchMessage(db, dispatched, { jobId, execGen }).won, true);
  assert.equal((await worker.exit).code, 0);
  const row = fx.jobRow(stateDir, jobId);
  assert.equal(row.end_state, "failed");
  assert.deepEqual(rawAll(stateDir, "SELECT state, close_cause, closed_at FROM messages ORDER BY id"), [
    { state: "dropped", close_cause: "failed", closed_at: row.end_at },
    { state: "dropped", close_cause: "failed", closed_at: row.end_at }
  ]);
  const { successorId } = state.decideNext(db, { ref: jobId, observedTipId: jobId }, { action: "continue", force: true, requester: null });
  setTestDriver(stateDir, successorId, { delayMs: 100 });
  assert.equal((await fx.startTestWorker(stateDir, successorId, fx.workerEnv(), pids).exit).code, 0);
  pids.push(...fx.providerIdentities(stateDir, successorId));
  const texts = startTexts(stateDir, successorId);
  assert.equal(texts.length, 1);
  assert.equal(texts[0].includes("pending one") || texts[0].includes("dispatched one") || texts[0].includes("[message"), false, texts[0]);
});

test("a dispatched message proven on history page two is consumed without replay, and one without proof is replayed with the prefix", { timeout: 240000 }, async (t) => {
  for (const proven of [true, false]) {
    const stateDir = makeStoreDir(t);
    const db = openTestStore(t, stateDir);
    const pids = fx.trackProcesses(t);
    const instanceId = rawAll(stateDir, "SELECT value FROM meta WHERE key = 'instance_id'")[0].value;
    const first = await fx.createDriverJob(db, { delayMs: 30000 }, { threadId: `th-history-${proven}` });
    const worker = fx.startTestWorker(stateDir, first, fx.workerEnv(), pids);
    await fx.waitFor(() => fx.jobRow(stateDir, first).started_at !== null, { describe: "the turn start" });
    pids.push(...fx.providerIdentities(stateDir, first));
    const execGen = fx.jobRow(stateDir, first).exec_gen;
    const { messageId } = mailbox.sendToChain(db, { ref: first }, { text: "maybe delivered" });
    assert.equal(mailbox.dispatchMessage(db, messageId, { jobId: first, execGen }).won, true);
    state.requestStop(db, { jobIds: [first] }, { reason: "session-end" });
    assert.equal((await worker.exit).code, 0);
    assert.equal(fx.jobRow(stateDir, first).release_kind, "confirmed");
    const historyPages = proven ? [["agent-other-1"], [mailbox.messageClientId(instanceId, messageId)]] : null;
    const { successorId } = state.decideNext(db, { ref: first, observedTipId: first }, { action: "continue", requester: null });
    setTestDriver(stateDir, successorId, { delayMs: 100, historyPages });
    assert.equal((await fx.startTestWorker(stateDir, successorId, fx.workerEnv(), pids).exit).code, 0);
    pids.push(...fx.providerIdentities(stateDir, successorId));
    const texts = startTexts(stateDir, successorId);
    const message = rawAll(stateDir, `SELECT state, consumed_job_id, attempts FROM messages WHERE id = ${messageId}`)[0];
    if (proven) {
      assert.deepEqual(texts, [mailbox.CONTINUE_LINE]);
      assert.deepEqual(message, { state: "consumed", consumed_job_id: successorId, attempts: 1 });
      assert.equal(fx.readTrace(stateDir, successorId).filter((entry) => entry.request === "history").length, 2);
    } else {
      assert.equal(texts.length, 1);
      assert.ok(texts[0].startsWith(`[message ${messageId}]\n${mailbox.UNCERTAIN_PREFIX}\nmaybe delivered`), texts[0]);
      assert.equal(message.attempts, 2);
      assert.equal(message.consumed_job_id, successorId);
    }
  }
});
