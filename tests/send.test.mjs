import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import {
  createDriverJob,
  jobProcesses,
  jobRow,
  rawAll,
  rawExec,
  runLibChild,
  seedStore,
  startTestWorker,
  trackProcesses,
  waitFor,
  workerEnv
} from "./store-fixtures.mjs";
import { LabelInUseError, createJob, resolveStateDir } from "../plugins/agent/scripts/lib/state.mjs";
import { NODE_LAUNCH_FLAGS, openStore } from "../plugins/agent/scripts/lib/store.mjs";
import { renderSendReply } from "../plugins/agent/scripts/commands/send.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION = path.join(ROOT, "plugins", "agent", "scripts", "agent-companion.mjs");

// Runs agent-companion.mjs in `workspace`; resolves to { code, stdout, stderr, elapsedMs }. A worker
// a command launches runs the test driver.
function companion(workspace, args, { env = {}, input = "" } = {}) {
  const started = performance.now();
  const child = spawn(process.execPath, [...NODE_LAUNCH_FLAGS, COMPANION, ...args], {
    cwd: workspace,
    env: { ...process.env, ...workerEnv(), ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  return new Promise((resolve) =>
    child.on("close", (code) => resolve({ code, stdout, stderr, elapsedMs: performance.now() - started }))
  );
}

function workspaceOf(t) {
  const workspace = makeTempDir(t);
  return { workspace, stateDir: resolveStateDir(workspace) };
}

function withStore(stateDir, fn) {
  const store = openStore(stateDir);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

async function withStoreAsync(stateDir, fn) {
  const store = openStore(stateDir);
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

const T0 = Date.now() - 60000;

// A job row that ended `state` with a recorded thread, so a continuation resumes that thread.
function endedJob(id, state, fields = {}) {
  return {
    id,
    chain_id: id,
    provider: "codex",
    kind: "task",
    title: `job ${id}`,
    prompt: "do it",
    request_json: JSON.stringify({ cwd: ".", testDriver: fields.testDriver ?? { exitBeforeClaim: true } }),
    cwd: ".",
    created_at: T0,
    updated_at: T0,
    session_id: "session-1",
    thread_id: `th-${id}`,
    resume_method: "thread",
    submit_intent_at: T0,
    end_state: state,
    end_at: T0 + 10,
    end_by: "worker",
    ...Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "testDriver"))
  };
}

async function seedEnded(stateDir, id, state, fields = {}) {
  await seedStore(stateDir, {
    chains: [{ id, tip_job_id: id, live_label: fields.liveLabel ?? null, created_at: T0, activity_at: T0 }],
    jobs: [endedJob(id, state, Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "liveLabel")))]
  });
}

function messagesOf(stateDir) {
  return rawAll(stateDir, "SELECT * FROM messages ORDER BY id");
}

function successorsOf(stateDir, jobId) {
  return rawAll(stateDir, "SELECT * FROM jobs WHERE continues = ?", [jobId]);
}

function trackJob(tracked, stateDir, jobId) {
  tracked.push(...jobProcesses(stateDir, jobId));
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("two sends to one completed job create one successor", async (t) => {
  for (let round = 0; round < 20; round += 1) {
    const { workspace, stateDir } = workspaceOf(t);
    await seedEnded(stateDir, "task-done", "completed");

    const [one, two] = await Promise.all([
      companion(workspace, ["send", "--timeout-ms", "1000", "task-done", "one"]),
      companion(workspace, ["send", "--timeout-ms", "1000", "task-done", "two"])
    ]);

    assert.equal(one.code, 0, one.stderr);
    assert.equal(two.code, 0, two.stderr);
    const successors = successorsOf(stateDir, "task-done");
    assert.equal(successors.length, 1, `round ${round}`);
    const successorId = successors[0].id;
    assert.ok(one.stdout.includes(successorId), one.stdout);
    assert.ok(two.stdout.includes(successorId), two.stdout);
    const messages = messagesOf(stateDir);
    assert.deepEqual(messages.map((message) => message.chain_id), ["task-done", "task-done"]);
    assert.deepEqual(messages.map((message) => message.text).sort(), ["one", "two"]);
  }
});

test("a label follows the live chain", async (t) => {
  const tracked = trackProcesses(t);
  const { workspace, stateDir } = workspaceOf(t);
  await seedEnded(stateDir, "task-a", "completed", { label: "r" });
  const b = withStore(stateDir, (store) =>
    createJob(
      store,
      { provider: "codex", kind: "task", title: "b", prompt: "b", request: { cwd: ".", testDriver: { delayMs: 60000 } }, cwd: ".", requester: { sessionId: "session-1" } },
      { label: "r" }
    ).jobId
  );
  startTestWorker(stateDir, b, workerEnv(), tracked);
  await waitFor(() => jobRow(stateDir, b)?.started_at, { describe: "b's turn start" });
  trackJob(tracked, stateDir, b);

  const continued = await companion(workspace, ["send", "--json", "task-a", "go on"]);
  assert.equal(continued.code, 0, continued.stderr);
  const reply = JSON.parse(continued.stdout);
  assert.equal(reply.status, "continued");
  assert.equal(reply.labelDropped, "r");
  assert.equal(jobRow(stateDir, reply.consumedJobId).label, null);

  const hello = await companion(workspace, ["send", "--json", "--timeout-ms", "500", "r", "hello"]);
  assert.equal(hello.code, 0, hello.stderr);
  assert.equal(JSON.parse(hello.stdout).jobId, b);
  const message = messagesOf(stateDir).find((row) => row.text === "hello");
  assert.equal(message.chain_id, b);
  assert.deepEqual(
    rawAll(stateDir, "SELECT id FROM chains WHERE live_label = 'r'").map((row) => row.id),
    [b]
  );
});

test("send answers a waiting job on the same thread", async (t) => {
  const tracked = trackProcesses(t);
  const { workspace, stateDir } = workspaceOf(t);
  await seedEnded(stateDir, "task-ask", "waiting", { question: "which branch?", testDriver: { answer: "done on main" } });

  const sent = await companion(workspace, ["send", "--json", "task-ask", "main"]);

  assert.equal(sent.code, 0, sent.stderr);
  const reply = JSON.parse(sent.stdout);
  assert.equal(reply.status, "continued");
  const successor = reply.consumedJobId;
  t.after(() => trackJob(tracked, stateDir, successor));
  assert.equal(jobRow(stateDir, successor).thread_id, "th-task-ask");
  await waitFor(() => jobRow(stateDir, successor)?.end_state === "completed", { describe: "the successor's end" });
  const message = messagesOf(stateDir)[0];
  assert.equal(message.state, "consumed");
  assert.equal(message.consumed_job_id, successor);
});

test("labels address the right delegate", async (t) => {
  const tracked = trackProcesses(t);
  const { workspace, stateDir } = workspaceOf(t);
  const [a, b] = withStore(stateDir, (store) => [
    createJob(store, { provider: "codex", kind: "task", title: "a", prompt: "a", request: { cwd: ".", testDriver: { steer: true, delayMs: 4000 } }, cwd: ".", requester: { sessionId: "session-1" } }, { label: "a" }).jobId,
    createJob(store, { provider: "agy", kind: "task", title: "b", prompt: "b", request: { cwd: ".", testDriver: { steer: false, delayMs: 2000 } }, cwd: ".", requester: { sessionId: "session-1" } }, { label: "b" }).jobId
  ]);
  // Both providers release confirmed on this platform, so no barrier holds b's thread.
  const contracts = JSON.stringify(
    ["codex", "agy"].flatMap((provider) =>
      ["tree-stop", "own-exit", "owner-death"].map((trigger) => ({ provider, platform: process.platform, trigger, version: "0.0.1", windowMs: 0 }))
    )
  );
  for (const jobId of [a, b]) {
    startTestWorker(stateDir, jobId, workerEnv({ AGENT_PLUGIN_TEST_CONTRACTS: contracts }), tracked);
  }
  await waitFor(() => jobRow(stateDir, a)?.started_at && jobRow(stateDir, b)?.started_at, { describe: "both turn starts" });
  trackJob(tracked, stateDir, a);
  trackJob(tracked, stateDir, b);
  assert.throws(
    () =>
      withStore(stateDir, (store) =>
        createJob(store, { provider: "codex", kind: "task", title: "c", prompt: "c", request: {}, cwd: ".", requester: {} }, { label: "a" })
      ),
    LabelInUseError
  );

  const [sentA, sentB] = await Promise.all([
    companion(workspace, ["send", "--json", "a", "hello-a"]),
    companion(workspace, ["send", "--json", "b", "hello-b"])
  ]);

  assert.equal(sentA.code, 0, sentA.stderr);
  assert.equal(sentB.code, 0, sentB.stderr);
  const replyA = JSON.parse(sentA.stdout);
  assert.equal(replyA.status, "received");
  assert.equal(replyA.consumedJobId, a);
  const replyB = JSON.parse(sentB.stdout);
  const [successorB] = successorsOf(stateDir, b);
  assert.ok(successorB, "b has no successor");
  t.after(() => trackJob(tracked, stateDir, successorB.id));
  assert.equal(replyB.status, "continued");
  assert.equal(replyB.consumedJobId, successorB.id);
  const byText = Object.fromEntries(messagesOf(stateDir).map((row) => [row.text, row]));
  assert.equal(byText["hello-a"].chain_id, a);
  assert.equal(byText["hello-b"].chain_id, b);
});

for (const placement of ["before-end", "after-end"]) {
  test(`a message sent at the turn end names the job that consumed it (${placement})`, async (t) => {
    const tracked = trackProcesses(t);
    for (let round = 0; round < 10; round += 1) {
      const { workspace, stateDir } = workspaceOf(t);
      const pointsDir = makeTempDir(t);
      const jobId = await withStoreAsync(stateDir, (store) => createDriverJob(store, { delayMs: 50 }));
      const worker = startTestWorker(stateDir, jobId, workerEnv({ AGENT_PLUGIN_TEST_POINTS: placement, AGENT_PLUGIN_TEST_POINTS_DIR: pointsDir }), tracked);
      await waitFor(() => fs.readdirSync(pointsDir).some((name) => name.startsWith(`${placement}-`)), { describe: `the worker at ${placement}` });
      trackJob(tracked, stateDir, jobId);

      const sending = companion(workspace, ["send", "--json", "--timeout-ms", "30000", jobId, "late"]);
      if (placement === "before-end") {
        await waitFor(() => messagesOf(stateDir).length === 1, { describe: "the stored message" });
      }
      fs.writeFileSync(path.join(pointsDir, `${placement}.release`), "go");
      const sent = await sending;

      assert.equal(sent.code, 0, sent.stderr);
      const reply = JSON.parse(sent.stdout);
      // A continuation the send started claims once the first execution released the thread.
      const message = await waitFor(() => messagesOf(stateDir).find((row) => row.state === "consumed"), { describe: `round ${round}: the message's consumption` });
      assert.equal(reply.consumedJobId, message.consumed_job_id);
      assert.equal(jobRow(stateDir, message.consumed_job_id).chain_id, jobId);
      const [successor] = successorsOf(stateDir, jobId);
      if (successor) {
        trackJob(tracked, stateDir, successor.id);
        await waitFor(() => jobRow(stateDir, successor.id)?.end_state, { describe: "the successor's end" });
      }
      await worker.exit;
    }
  });
}

test("send exits 1 after 10 seconds behind a held lock and stores one message after a 3-second lock", async (t) => {
  const { workspace, stateDir } = workspaceOf(t);
  const lockDir = makeTempDir(t);
  await seedStore(stateDir, {
    chains: [{ id: "task-q", tip_job_id: "task-q", created_at: T0, activity_at: T0 }],
    jobs: [{ ...endedJob("task-q", null), end_state: null, end_at: null, end_by: null }]
  });
  for (const [holdMs, expectCode] of [
    [12000, 1],
    [3000, 0]
  ]) {
    const ready = path.join(lockDir, `ready-${holdMs}`);
    const holder = runLibChild("fixture.holdLock", [stateDir, holdMs, ready]);
    t.after(() => holder.child.kill());
    await waitFor(() => fs.existsSync(ready), { describe: "the held lock" });

    const sent = await companion(workspace, ["send", "--timeout-ms", "300", "task-q", `held ${holdMs}`]);

    assert.equal(sent.code, expectCode, `${holdMs}: ${sent.stderr}${sent.stdout}`);
    await holder;
    const stored = messagesOf(stateDir).filter((row) => row.text === `held ${holdMs}`);
    if (expectCode === 1) {
      assert.match(sent.stderr, /busy or unavailable \(busy\)/);
      assert.ok(sent.elapsedMs >= 9000 && sent.elapsedMs < 12000, `elapsed ${sent.elapsedMs}`);
      assert.equal(stored.length, 0);
    } else {
      assert.equal(stored.length, 1);
    }
  }
  assert.equal(rawAll(stateDir, "SELECT count(*) AS n FROM jobs")[0].n, 1);
});

test("a corrupt store makes send exit 1", async (t) => {
  const { workspace, stateDir } = workspaceOf(t);
  const storeDir = path.join(stateDir, "store");
  fs.mkdirSync(path.join(storeDir, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(storeDir, "state.db"), randomBytes(64 * 1024));
  fs.writeFileSync(path.join(storeDir, "artifacts", "task-old.log"), "an old log\n");
  const before = [sha256(path.join(storeDir, "state.db")), sha256(path.join(storeDir, "artifacts", "task-old.log"))];

  const sent = await companion(workspace, ["send", "task-old", "x"]);

  assert.equal(sent.code, 1, sent.stderr);
  assert.match(sent.stderr, /agent-companion\.mjs store recover/);
  assert.deepEqual([sha256(path.join(storeDir, "state.db")), sha256(path.join(storeDir, "artifacts", "task-old.log"))], before);
  assert.deepEqual(
    fs.readdirSync(storeDir, { recursive: true }).filter((name) => fs.statSync(path.join(storeDir, name)).isFile()).sort(),
    ["artifacts" + path.sep + "task-old.log", "state.db"]
  );
});

test("send keeps quotes, dollar signs and backticks verbatim through stdin", async (t) => {
  const { workspace, stateDir } = workspaceOf(t);
  await seedStore(stateDir, {
    chains: [{ id: "task-q", tip_job_id: "task-q", created_at: T0, activity_at: T0 }],
    jobs: [{ ...endedJob("task-q", null), end_state: null, end_at: null, end_by: null }]
  });
  const text = 'fix the "foo" bug in `parseArgs`, it\'s $5 and $HOME\n--not-an-option';

  const dash = await companion(workspace, ["send", "task-q", "--timeout-ms", "300", "-"], { input: `${text}\n` });
  const flag = await companion(workspace, ["send", "--stdin", "--timeout-ms", "300", "task-q"], { input: `${text}\n` });
  const oneString = await companion(workspace, ["send", `--timeout-ms 300 task-q don't touch "the" tests --now`]);

  for (const result of [dash, flag, oneString]) {
    assert.equal(result.code, 0, result.stderr);
  }
  assert.deepEqual(
    messagesOf(stateDir).map((row) => row.text),
    [text, text, `don't touch "the" tests --now`]
  );
});

test("a dropped message says it may have been delivered only when it had been dispatched", async (t) => {
  for (const dispatched of [true, false]) {
    const { workspace, stateDir } = workspaceOf(t);
    const pointsDir = makeTempDir(t);
    // A running job whose worker is gone, so nothing but this test moves its messages.
    await seedEnded(stateDir, "task-s", null, { end_at: null, end_by: null, claimed_at: T0, exec_gen: 1, worker_pid: 999999, worker_start_token: "gone", started_at: T0 + 5 });

    const sending = companion(workspace, ["send", "--json", "task-s", "hello"], {
      env: { AGENT_PLUGIN_TEST_POINTS: "after-send-commit", AGENT_PLUGIN_TEST_POINTS_DIR: pointsDir }
    });
    try {
      await waitFor(() => fs.readdirSync(pointsDir).some((name) => name.startsWith("after-send-commit-")), { describe: "the message commit" });
      // The job is cancelled and its message dropped: after its dispatch to Codex, or before.
      const [message] = messagesOf(stateDir);
      const now = Date.now();
      if (dispatched) {
        rawExec(stateDir, "UPDATE messages SET state = 'dispatched', attempts = 1, dispatched_at = ?, dispatched_job_id = 'task-s', dispatched_gen = 1 WHERE id = ?", [now, message.id]);
      }
      rawExec(stateDir, "UPDATE messages SET state = 'dropped', closed_at = ?, close_cause = 'cancelled' WHERE id = ?", [now, message.id]);
    } finally {
      // A send paused at its point is let go in every case, so it exits.
      fs.writeFileSync(path.join(pointsDir, "after-send-commit.release"), "");
    }
    const sent = await sending;

    assert.equal(sent.code, 1, sent.stderr);
    const reply = JSON.parse(sent.stdout);
    assert.equal(reply.status, "dropped");
    assert.equal(reply.dispatched, dispatched);
    const rendered = renderSendReply(reply);
    if (dispatched) {
      assert.match(rendered, /it may have been delivered/);
      assert.doesNotMatch(rendered, /it was not delivered/);
    } else {
      assert.match(rendered, /it was not delivered/);
    }
  }
});

test("send to an unknown job exits 1", async (t) => {
  const { workspace } = workspaceOf(t);
  const result = await companion(workspace, ["send", "task-missing", "hello"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /No job matches "task-missing"/);
});

test("result --wait exits 75 while the job runs and prints the result once it finishes", async (t) => {
  const tracked = trackProcesses(t);
  const { workspace, stateDir } = workspaceOf(t);
  const jobId = await withStoreAsync(stateDir, (store) => createDriverJob(store, { delayMs: 3000, answer: "Handled the requested task" }));
  startTestWorker(stateDir, jobId, workerEnv(), tracked);
  await waitFor(() => jobRow(stateDir, jobId)?.started_at, { describe: "the turn start" });
  trackJob(tracked, stateDir, jobId);

  const early = await companion(workspace, ["result", jobId, "--wait", "--timeout-ms", "500"]);
  assert.equal(early.code, 75, early.stderr);
  assert.match(early.stdout, new RegExp(`Job ${jobId} is still running after 1 s\\. Run the same command again`));

  const done = await companion(workspace, ["result", jobId, "--wait", "--timeout-ms", "20000"]);
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /Handled the requested task/);
  assert.ok(jobRow(stateDir, jobId).delivered_at, "the waiting result did not record its delivery");
});

for (const value of ["0", "abc"]) {
  test(`send --timeout-ms ${value} is rejected`, async (t) => {
    const { workspace } = workspaceOf(t);

    const result = await companion(workspace, ["send", "--timeout-ms", value, "task-missing", "hello"]);

    assert.equal(result.status ?? result.code, 1, result.stderr);
    assert.match(result.stderr, /--timeout-ms must be a positive number of milliseconds\./);
  });
}
