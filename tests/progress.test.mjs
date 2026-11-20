import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run, stopOwnedProcess } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/agent/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "agent");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const MONITOR = path.join(PLUGIN_ROOT, "scripts", "job-monitor.mjs");

function makeRepo(behavior) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return { repo, env: { ...buildEnv(binDir), CLAUDE_PID: String(process.pid) } };
}

test("the job log gets one line per completed agent message", () => {
  const ctx = makeRepo("three-messages");
  const result = run("node", [SCRIPT, "task", "--json", "investigate"], { cwd: ctx.repo, env: ctx.env, timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);

  // The one job's log, beside the job store.
  const artifacts = path.join(resolveStateDir(ctx.repo), "store", "artifacts");
  const logs = fs.readdirSync(artifacts).filter((name) => name.endsWith(".log"));
  assert.equal(logs.length, 1, logs.join(", "));
  const log = fs.readFileSync(path.join(artifacts, logs[0]), "utf8");
  const lines = log.split("\n").filter((line) => /^\[[^\]]+\] Assistant message captured: /.test(line));
  assert.equal(lines.length, 3, log);
  assert.match(lines[0], /First progress note\./);
});

test("the plugin registers the job monitor", () => {
  const monitorsFile = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "monitors", "monitors.json"), "utf8"));
  assert.deepEqual(Object.keys(monitorsFile[0]).sort(), ["command", "description", "name"]);
  assert.match(
    monitorsFile[0].command,
    /^node --disable-warning=ExperimentalWarning "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/job-monitor\.mjs" "\$\{CLAUDE_PROJECT_DIR\}" "\$\{CLAUDE_PLUGIN_DATA\}"$/
  );
});

// ---------------------------------------------------------------------------------------------
// The monitor on the job store. Jobs run in test-driver workers (tests/store-fixtures.mjs).

const stateLib = await import("../plugins/agent/scripts/lib/state.mjs");
const storeLib = await import("../plugins/agent/scripts/lib/store.mjs");
const processLib = await import("../plugins/agent/scripts/lib/process.mjs");
const mailboxLib = await import("../plugins/agent/scripts/lib/mailbox.mjs");
const fixtures = await import("./store-fixtures.mjs");

const SESSION = "sess-monitor";
const NODE_FLAGS = ["--disable-warning=ExperimentalWarning"];
// Cleanup contracts for both provider ids on this platform, so a witnessed tree stop, own exit or
// owner death releases confirmed on Windows; Linux uses the empty process group.
const TEST_CONTRACTS = JSON.stringify(
  ["codex", "agy"].flatMap((provider) =>
    ["own-exit", "tree-stop", "owner-death"].map((trigger) => ({ provider, platform: process.platform, trigger, version: "0.0.1", windowMs: 0 }))
  )
);
// The worker rewrites its heartbeat every 2 s and stops itself after 8 s without one, so a poll
// of 400 ms with 8 stale polls judges a worker stale 3.2 s after its last advancing sample: more
// than one heartbeat interval, and early enough for the monitor to act before the worker would.
const FAST_MONITOR = { AGENT_PLUGIN_MONITOR_POLL_MS: "400", AGENT_PLUGIN_STALE_POLLS: "8", AGENT_PLUGIN_SCAN_MS: "500" };

function storeEnv(extra = {}) {
  return { AGENT_PLUGIN_TEST_CONTRACTS: TEST_CONTRACTS, AGENT_PLUGIN_TEST_WORKER_ENTRY: fixtures.FIXTURE_SCRIPT, ...extra };
}

function storeWorkspace(t) {
  const cwd = makeTempDir(t);
  const stateDir = stateLib.resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  const store = storeLib.openStore(stateDir);
  t.after(() => store.close());
  return { cwd, stateDir, store, tracked: fixtures.trackProcesses(t) };
}

let jobClock = 0;
function createStoreJob(store, { provider = "codex", sessionId = SESSION, testDriver = {}, label = null, allowQuestions = false } = {}) {
  // Jobs created in one millisecond tie on created_at; each creation takes the next millisecond.
  const until = Math.max(Date.now(), jobClock) + 1;
  while (Date.now() < until) {
    // A short busy wait.
  }
  jobClock = Date.now();
  return stateLib.createJob(
    store,
    {
      provider,
      kind: "task",
      title: `${provider} job`,
      prompt: "do the work",
      request: { cwd: ".", testDriver },
      cwd: ".",
      allowQuestions,
      requester: { sessionId, leaderPid: null, leaderStartToken: null }
    },
    { label }
  ).jobId;
}

function startJob(ws, jobId, env = {}) {
  const worker = fixtures.startTestWorker(ws.stateDir, jobId, storeEnv(env), ws.tracked);
  worker.exitedAt = null;
  worker.child.once("exit", () => (worker.exitedAt = Date.now()));
  return worker;
}

function row(ws, jobId) {
  return fixtures.jobRow(ws.stateDir, jobId);
}

async function waitRunning(ws, jobId) {
  await fixtures.waitFor(() => row(ws, jobId).started_at !== null && row(ws, jobId).provider_pid !== null, {
    timeoutMs: 60000,
    describe: `job ${jobId} running with a recorded provider`
  });
  ws.tracked.push(...fixtures.providerIdentities(ws.stateDir, jobId));
}

// Starts the monitor for a workspace; its stdout and stderr are collected, and it is stopped when
// the test ends if it still runs.
function startStoreMonitor(t, ws, env = {}) {
  const child = spawn(process.execPath, [...NODE_FLAGS, MONITOR, ws.cwd], {
    env: { ...process.env, ...storeEnv(FAST_MONITOR), ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const monitor = { child, stdout: "", stderr: "", exitCode: undefined };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (monitor.stdout += chunk));
  child.stderr.on("data", (chunk) => (monitor.stderr += chunk));
  monitor.exit = new Promise((resolve) =>
    child.on("close", (code) => {
      monitor.exitCode = code;
      resolve(code);
    })
  );
  t.after(() => stopOwnedProcess(child));
  return monitor;
}

function liveFile(ws, pid) {
  return path.join(ws.stateDir, "store", "live", `worker-${pid}.json`);
}

function liveCounter(ws, pid) {
  try {
    return JSON.parse(fs.readFileSync(liveFile(ws, pid), "utf8")).counter;
  } catch {
    return null;
  }
}

// Resolves right after the worker published a new heartbeat.
async function nextHeartbeat(ws, pid) {
  const start = liveCounter(ws, pid);
  await fixtures.waitFor(() => liveCounter(ws, pid) !== null && liveCounter(ws, pid) !== start, {
    timeoutMs: 10000,
    intervalMs: 20,
    describe: "a new heartbeat"
  });
}

const sleepMs = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Probes a recorded identity with signal 0 every 20 ms, after confirming it present; resolves to
// `{ done }`, a promise of the wall time it was first seen gone (null if still there at the end).
async function watchGone(identity, timeoutMs = 30000) {
  const observed = await processLib.readProcessIdentity(identity.pid, { deadline: performance.now() + 10000 });
  assert.equal(processLib.confirmIdentity(identity, observed), "present");
  const alive = () => {
    try {
      process.kill(identity.pid, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  };
  const until = Date.now() + timeoutMs;
  const done = (async () => {
    while (Date.now() < until) {
      if (!alive()) {
        return Date.now();
      }
      await sleepMs(20);
    }
    return null;
  })();
  return { done };
}

// A running job whose worker skips its heartbeat while the pause file exists. With `freeze`, the
// worker blocks at the end of its turn (1.5 s in), which stops its event loop and so its heartbeat,
// as a suspended process would.
async function staleSetup(t, { freeze = false } = {}) {
  const ws = storeWorkspace(t);
  const pauseFile = path.join(makeTempDir(t), "heartbeat.pause");
  const pointsDir = makeTempDir(t);
  const jobId = createStoreJob(ws.store, { testDriver: { delayMs: freeze ? 1500 : 600000 } });
  const env = freeze ? { AGENT_PLUGIN_TEST_POINTS: "before-end", AGENT_PLUGIN_TEST_POINTS_DIR: pointsDir } : {};
  const worker = startJob(ws, jobId, { AGENT_PLUGIN_HEARTBEAT_PAUSE_FILE: pauseFile, ...env });
  await waitRunning(ws, jobId);
  if (freeze) {
    await fixtures.waitFor(() => fs.existsSync(path.join(pointsDir, `before-end-${worker.pid}.reached`)), { describe: "the worker blocked" });
  } else {
    await nextHeartbeat(ws, worker.pid);
  }
  const root = { pid: row(ws, jobId).provider_pid, startToken: row(ws, jobId).provider_start_token };
  return { ws, jobId, worker, pauseFile, root };
}

async function waitMarked(ws, jobId, monitors = [], timeoutMs = 20000) {
  try {
    await fixtures.waitFor(() => row(ws, jobId).stopping_cause === "stale-worker" || row(ws, jobId).stop_reason === "stale-worker", {
      timeoutMs,
      intervalMs: 50,
      describe: "the stale-worker marking"
    });
  } catch (error) {
    const state = row(ws, jobId);
    error.message += `; row ${JSON.stringify({ stop_reason: state.stop_reason, stopping_cause: state.stopping_cause, end_state: state.end_state, end_reason: state.end_reason, released: state.exec_released_at })}; monitor stderr: ${monitors.map((monitor) => monitor.stderr).join(" | ")}`;
    throw error;
  }
}

async function waitReleased(ws, jobId, timeoutMs = 30000) {
  await fixtures.waitFor(() => row(ws, jobId).exec_released_at !== null, { timeoutMs, describe: "the release" });
}

// How late this test may see a process gone: watchGone probes every 20 ms from this process's
// event loop, which lags by tens of milliseconds when the whole suite runs in parallel (79 and
// 120 ms were measured there; the file alone stays under 50).
const GONE_OBSERVATION_LAG_MS = 250;

// Worker and provider root gone, by the times this test first saw them gone, before the execution
// was released.
function assertGoneBeforeRelease(ws, jobId, workerGoneAt, rootGoneAt) {
  const released = row(ws, jobId);
  assert.ok(workerGoneAt !== null, "the worker is gone");
  assert.ok(rootGoneAt !== null, "the provider root is gone");
  assert.ok(workerGoneAt <= released.exec_released_at + GONE_OBSERVATION_LAG_MS, `worker gone ${workerGoneAt - released.exec_released_at} ms after the release`);
  assert.ok(rootGoneAt <= released.exec_released_at + GONE_OBSERVATION_LAG_MS, `root gone ${rootGoneAt - released.exec_released_at} ms after the release`);
  assert.ok(["confirmed", "unobserved"].includes(released.release_kind));
}

test("a stale worker is stopped, not overtaken", { timeout: 600000 }, async (t) => {
  for (const variant of ["A", "B", "D", "H-malformed", "H-other-job"]) {
    await t.test(`marked and stopped (${variant})`, { timeout: 90000 }, async (st) => {
      // B suspends the worker: SIGSTOP on Linux; elsewhere the worker blocks synchronously at a
      // test point, which stops its heartbeat the same way.
      const suspend = variant === "B";
      const { ws, jobId, worker, pauseFile, root } = await staleSetup(st, { freeze: suspend && process.platform !== "linux" });
      const workerGone = { done: (async () => (await worker.exit, worker.exitedAt))() };
      const rootGone = await watchGone(root);
      const monitor = startStoreMonitor(st, ws);
      let writer = null;
      if (suspend) {
        if (process.platform === "linux") {
          // The held, running worker is suspended through its own ChildProcess handle.
          assert.ok(worker.child.kill("SIGSTOP"), "the worker was suspended");
        }
      } else {
        fs.writeFileSync(pauseFile, "");
      }
      if (variant === "H-malformed") {
        fs.writeFileSync(liveFile(ws, worker.pid), "{not json");
      } else if (variant === "H-other-job") {
        let counter = 1000;
        const claim = row(ws, jobId);
        writer = setInterval(() => {
          counter += 1;
          const sample = { role: "worker", pid: claim.worker_pid, startToken: claim.worker_start_token, jobId: "another-job", execGen: claim.exec_gen, counter };
          fs.writeFileSync(liveFile(ws, worker.pid), JSON.stringify(sample));
        }, 300);
      }
      try {
        await waitMarked(ws, jobId, [monitor]);
        const marked = row(ws, jobId);
        assert.equal(marked.stop_reason, "stale-worker");
        if (marked.exec_released_at === null && marked.end_state === null) {
          assert.equal(stateLib.jobState(marked), "stopping");
          assert.throws(
            () => stateLib.decideNext(ws.store, { ref: jobId, observedTipId: jobId }, { action: "continue", requester: { sessionId: SESSION } }),
            stateLib.JobStoppingError
          );
        }
        if (variant === "D") {
          // The worker wakes after the marking: its heartbeat advances again, the claim is kept
          // until the worker is gone, and the stop still follows.
          assert.equal(marked.exec_released_at, null);
          fs.rmSync(pauseFile, { force: true });
        }
        await waitReleased(ws, jobId);
      } finally {
        clearInterval(writer);
      }
      assertGoneBeforeRelease(ws, jobId, await workerGone.done, await rootGone.done);
      assert.equal(monitor.exitCode, undefined, monitor.stderr);
      await stopOwnedProcess(monitor.child);
      const next = stateLib.decideNext(ws.store, { ref: jobId, observedTipId: jobId }, { action: "continue", requester: { sessionId: SESSION } });
      assert.equal(next.won, true);
      assert.ok(next.successorId);
    });
  }

  await t.test("a polling gap resets the counts (C)", { timeout: 90000 }, async (st) => {
    const { ws, jobId, worker, pauseFile } = await staleSetup(st);
    const monitorPause = path.join(makeTempDir(st), "monitor.pause");
    const monitor = startStoreMonitor(st, ws, { AGENT_PLUGIN_MONITOR_PAUSE_FILE: monitorPause });
    await sleepMs(1500);
    await nextHeartbeat(ws, worker.pid);
    fs.writeFileSync(pauseFile, "");
    await sleepMs(1500);
    fs.writeFileSync(monitorPause, "");
    await sleepMs(1500);
    fs.rmSync(monitorPause);
    await sleepMs(500);
    fs.rmSync(pauseFile);
    await sleepMs(5000);
    assert.equal(row(ws, jobId).stop_requested_at, null);
    assert.equal(monitor.exitCode, undefined, monitor.stderr);
  });

  await t.test("a new monitor completes the stop (E)", { timeout: 90000 }, async (st) => {
    const { ws, jobId, worker, pauseFile, root } = await staleSetup(st);
    const workerGone = { done: (async () => (await worker.exit, worker.exitedAt))() };
    const rootGone = await watchGone(root);
    const first = startStoreMonitor(st, ws);
    fs.writeFileSync(pauseFile, "");
    await waitMarked(ws, jobId, [first]);
    await stopOwnedProcess(first.child);
    startStoreMonitor(st, ws);
    await waitReleased(ws, jobId);
    assertGoneBeforeRelease(ws, jobId, await workerGone.done, await rootGone.done);
  });

  await t.test("a heartbeat that is malformed for a few polls is no staleness (G)", { timeout: 90000 }, async (st) => {
    const { ws, jobId, worker } = await staleSetup(st);
    const monitor = startStoreMonitor(st, ws);
    // Each time a valid heartbeat stays readable for at least one poll, then the file is unreadable
    // or malformed for about three polls until the next heartbeat, which stays valid for a few.
    for (let round = 0; round < 3; round += 1) {
      await nextHeartbeat(ws, worker.pid);
      await sleepMs(700);
      fs.writeFileSync(liveFile(ws, worker.pid), round === 1 ? "" : "{not json");
      await nextHeartbeat(ws, worker.pid);
      await sleepMs(1000);
    }
    await sleepMs(5000);
    assert.equal(row(ws, jobId).stop_requested_at, null);
    assert.equal(monitor.exitCode, undefined, monitor.stderr);
  });

  await t.test("two monitors mark once and release once (I)", { timeout: 90000 }, async (st) => {
    const { ws, jobId, worker, pauseFile, root } = await staleSetup(st);
    const workerGone = { done: (async () => (await worker.exit, worker.exitedAt))() };
    const rootGone = await watchGone(root);
    const monitors = [startStoreMonitor(st, ws, { CLAUDE_PID: "" }), startStoreMonitor(st, ws, { CLAUDE_PID: "" })];
    fs.writeFileSync(pauseFile, "");
    await waitMarked(ws, jobId, monitors);
    const marked = row(ws, jobId);
    await waitReleased(ws, jobId);
    const released = row(ws, jobId);
    assert.equal(released.stop_requested_at, marked.stop_requested_at);
    assert.equal(released.stop_reason, "stale-worker");
    assertGoneBeforeRelease(ws, jobId, await workerGone.done, await rootGone.done);
    await sleepMs(1500);
    for (const monitor of monitors) {
      assert.equal(monitor.exitCode, undefined, monitor.stderr);
    }
    assert.equal(fixtures.rawAll(ws.stateDir, "SELECT count(*) AS n FROM jobs")[0].n, 1);
  });
});

test("a crash after the end transaction is finished by the monitor", { timeout: 180000 }, async (t) => {
  await t.test("the worker dies after its end committed a successor (A)", { timeout: 90000 }, async (st) => {
    const ws = storeWorkspace(st);
    const pointsDir = makeTempDir(st);
    const jobId = createStoreJob(ws.store, { testDriver: { delayMs: 1500, answer: "first answer", ignoreEof: true } });
    const worker = startJob(ws, jobId, { AGENT_PLUGIN_TEST_POINTS: "after-end", AGENT_PLUGIN_TEST_POINTS_DIR: pointsDir });
    await waitRunning(ws, jobId);
    const messageId = mailboxLib.sendToChain(ws.store, { ref: jobId, observedTipId: jobId }, { text: "one more thing" }).messageId;
    await fixtures.waitFor(() => fs.existsSync(path.join(pointsDir, `after-end-${worker.pid}.reached`)), { timeoutMs: 30000, describe: "the end commit" });
    const ended = row(ws, jobId);
    const successorId = fixtures.rawAll(ws.stateDir, "SELECT id FROM jobs WHERE continues = ?", [jobId])[0]?.id;
    assert.ok(successorId, "the end transaction committed a successor");
    const events = fixtures.rawAll(ws.stateDir, "SELECT * FROM events WHERE job_id = ?", [jobId]);
    // The worker alone is stopped. Its provider root may outlive it; the fake provider of the
    // fixtures can also end with its broken input pipe, which the scan then finds absent.
    const root = { pid: ended.provider_pid, startToken: ended.provider_start_token };
    assert.equal(processLib.confirmIdentity(root, await processLib.readProcessIdentity(root.pid)), "present");
    await stopOwnedProcess(worker.child);
    st.diagnostic(`provider root after the worker's death: ${processLib.confirmIdentity(root, await processLib.readProcessIdentity(root.pid))}`);

    startStoreMonitor(st, ws);
    await fixtures.waitFor(() => mailboxLib.readMessageOutcome(ws.store, messageId)?.state === "consumed", {
      timeoutMs: 60000,
      describe: "the message consumed by the successor"
    });

    const first = row(ws, jobId);
    const next = row(ws, successorId);
    ws.tracked.push(...fixtures.jobProcesses(ws.stateDir, successorId));
    assert.ok(["confirmed", "unobserved"].includes(first.release_kind));
    assert.deepEqual([first.end_state, first.end_at, first.end_reason], [ended.end_state, ended.end_at, ended.end_reason]);
    assert.deepEqual(fixtures.rawAll(ws.stateDir, "SELECT * FROM events WHERE job_id = ?", [jobId]), events);
    assert.ok(next.claimed_at >= first.exec_released_at, "the successor claimed only after the release");
    assert.equal(mailboxLib.readMessageOutcome(ws.store, messageId).consumedJobId, successorId);
    assert.equal(processLib.confirmIdentity(root, await processLib.readProcessIdentity(root.pid)), "absent");
  });

  await t.test("the sender dies after its send committed a successor (B)", { timeout: 90000 }, async (st) => {
    const ws = storeWorkspace(st);
    const pointsDir = makeTempDir(st);
    const jobId = createStoreJob(ws.store, { testDriver: { delayMs: 50 } });
    await startJob(ws, jobId).exit;
    assert.equal(row(ws, jobId).end_state, "completed");
    const sender = fixtures.runLibChild(
      "mailbox.sendToChain",
      [{ $store: ws.stateDir }, { ref: jobId, observedTipId: jobId }, { text: "follow up" }],
      { AGENT_PLUGIN_TEST_POINTS: "after-send-commit", AGENT_PLUGIN_TEST_POINTS_DIR: pointsDir }
    );
    await fixtures.waitFor(() => fs.existsSync(path.join(pointsDir, `after-send-commit-${sender.child.pid}.reached`)), {
      timeoutMs: 30000,
      describe: "the send commit"
    });
    await stopOwnedProcess(sender.child);
    await sender;
    const successorId = fixtures.rawAll(ws.stateDir, "SELECT id FROM jobs WHERE continues = ?", [jobId])[0]?.id;
    assert.ok(successorId, "the send committed a successor");
    const messageId = fixtures.rawAll(ws.stateDir, "SELECT id FROM messages")[0].id;

    startStoreMonitor(st, ws);
    await fixtures.waitFor(() => mailboxLib.readMessageOutcome(ws.store, messageId)?.state === "consumed", {
      timeoutMs: 60000,
      describe: "the message consumed by the successor"
    });
    ws.tracked.push(...fixtures.jobProcesses(ws.stateDir, successorId));
    assert.equal(mailboxLib.readMessageOutcome(ws.store, messageId).consumedJobId, successorId);
    assert.equal(fixtures.rawAll(ws.stateDir, "SELECT count(*) AS n FROM jobs WHERE id = ? AND claimed_at IS NOT NULL", [successorId])[0].n, 1);
  });
});

test("the monitor exits naming the recovery when the store folder moves", { timeout: 60000 }, async (t) => {
  if (process.platform !== "linux") {
    t.skip("Windows refuses to rename a store folder that a process holds open; the move is a Linux case");
    return;
  }
  const ws = storeWorkspace(t);
  ws.store.close();
  const monitor = startStoreMonitor(t, ws);
  await fixtures.waitFor(() => fs.existsSync(path.join(ws.stateDir, "store", "live", `monitor-${monitor.child.pid}.json`)), {
    describe: "the monitor started"
  });
  fs.renameSync(path.join(ws.stateDir, "store"), path.join(ws.stateDir, "store.corrupt-test"));
  const code = await Promise.race([monitor.exit, sleepMs(5000).then(() => "running")]);
  assert.equal(code, 1, monitor.stderr);
  assert.match(monitor.stderr, /store recover/);
});

test("one of two monitors runs the daily integrity check", { timeout: 60000 }, async (t) => {
  const ws = storeWorkspace(t);
  const monitors = [0, 1].map(() => startStoreMonitor(t, ws, { AGENT_PLUGIN_TEST_INTEGRITY_FAIL: "1", AGENT_PLUGIN_SCAN_MS: "500" }));
  const first = await Promise.race(monitors.map((monitor) => monitor.exit.then(() => monitor)));
  await sleepMs(3000);
  assert.equal(first.exitCode, 1);
  assert.match(first.stderr, /integrity check/);
  assert.match(first.stderr, /store recover/);
  const others = monitors.filter((monitor) => monitor !== first);
  assert.equal(others[0].exitCode, undefined, `the second monitor exited: ${others[0].stderr}`);
  const stamp = fixtures.rawAll(ws.stateDir, "SELECT value FROM meta WHERE key = 'last_integrity_check_at'");
  assert.equal(stamp.length, 1);
});

// ---------------------------------------------------------------------------------------------
// Event lines.

// This test process stands in for the session's Claude Code process: jobs record it as their
// leader, and the monitor gets its id as CLAUDE_PID.
async function thisLeader() {
  const identity = await processLib.readProcessIdentity(process.pid, { deadline: performance.now() + 10000 });
  return { pid: process.pid, startToken: identity.startToken };
}

function createLedJob(ws, leader, { label = null, testDriver = {}, allowQuestions = false, sessionId = SESSION } = {}) {
  const until = Math.max(Date.now(), jobClock) + 1;
  while (Date.now() < until) {
    // A short busy wait.
  }
  jobClock = Date.now();
  return stateLib.createJob(
    ws.store,
    {
      provider: "codex",
      kind: "task",
      title: "codex job",
      prompt: "do the work",
      request: { cwd: ".", testDriver },
      cwd: ".",
      allowQuestions,
      requester: { sessionId, leaderPid: leader.pid, leaderStartToken: leader.startToken }
    },
    { label }
  ).jobId;
}

function eventsOf(ws, jobId) {
  return fixtures.rawAll(ws.stateDir, "SELECT * FROM events WHERE job_id = ?", [jobId]);
}

function marksOf(ws, eventId) {
  return fixtures.rawAll(ws.stateDir, "SELECT * FROM event_marks WHERE event_id = ?", [eventId]);
}

// A job of this session that ends waiting for an answer to "which branch?".
async function waitingJob(ws, leader, options = {}) {
  const jobId = createLedJob(ws, leader, { allowQuestions: true, testDriver: { question: "which branch?", delayMs: 50 }, ...options });
  await startJob(ws, jobId).exit;
  assert.equal(row(ws, jobId).end_state, "waiting");
  const [event] = eventsOf(ws, jobId);
  assert.equal(event.kind, "waiting");
  return { jobId, event };
}

test("the monitor prints the waiting line with the event id", { timeout: 60000 }, async (t) => {
  const ws = storeWorkspace(t);
  const leader = await thisLeader();
  const { jobId, event } = await waitingJob(ws, leader, { label: "pick-branch" });

  const monitor = startStoreMonitor(t, ws, { CLAUDE_PID: String(process.pid) });
  await fixtures.waitFor(() => marksOf(ws, event.id).length === 1, { timeoutMs: 20000, describe: "the event marked printed" });

  assert.equal(
    monitor.stdout,
    `[event ${event.id}] Codex job ${jobId} (pick-branch) is waiting for an answer: which branch? Reply with /agent:send ${jobId} <answer>.\n`
  );
  assert.equal(marksOf(ws, event.id)[0].session_id, SESSION);
});

test("the monitor stays silent when a waiting command returns the outcome within the grace", { timeout: 60000 }, async (t) => {
  const ws = storeWorkspace(t);
  const leader = await thisLeader();
  const monitor = startStoreMonitor(t, ws, { CLAUDE_PID: String(process.pid) });
  const jobId = createLedJob(ws, leader, { testDriver: { delayMs: 300 } });
  const worker = startJob(ws, jobId);
  const waited = await fixtures.runLibChild("tracked.waitForJob", [ws.stateDir, jobId, { until: "end", deliver: true, timeoutMs: 30000 }]);
  await worker.exit;
  assert.equal(waited.ok, true, waited.stderr);
  const [event] = eventsOf(ws, jobId);
  assert.equal(event.kind, "completed");
  assert.notEqual(row(ws, jobId).delivered_at, null);

  await fixtures.waitFor(() => marksOf(ws, event.id).length === 1, { timeoutMs: 20000, describe: "the event recorded without a line" });
  await sleepMs(1000);
  assert.equal(monitor.stdout, "");
});

test("a repeated notification keeps its event id", { timeout: 60000 }, async (t) => {
  const ws = storeWorkspace(t);
  const leader = await thisLeader();
  const { jobId, event } = await waitingJob(ws, leader);
  const pointsDir = makeTempDir(t);
  const line = `[event ${event.id}] Codex job ${jobId} is waiting for an answer: which branch? Reply with /agent:send ${jobId} <answer>.\n`;

  const first = startStoreMonitor(t, ws, {
    CLAUDE_PID: String(process.pid),
    AGENT_PLUGIN_TEST_POINTS: "monitor-after-print",
    AGENT_PLUGIN_TEST_POINTS_DIR: pointsDir
  });
  await fixtures.waitFor(() => fs.existsSync(path.join(pointsDir, `monitor-after-print-${first.child.pid}.reached`)), {
    timeoutMs: 20000,
    describe: "the first monitor printed"
  });
  await stopOwnedProcess(first.child);
  await first.exit;
  assert.equal(first.stdout, line);
  assert.equal(marksOf(ws, event.id).length, 0);

  const second = startStoreMonitor(t, ws, { CLAUDE_PID: String(process.pid) });
  await fixtures.waitFor(() => marksOf(ws, event.id).length === 1, { timeoutMs: 20000, describe: "the second monitor recorded the print" });
  assert.equal(second.stdout, line);
});

test("the monitor ignores jobs started from another Claude process", { timeout: 60000 }, async (t) => {
  const ws = storeWorkspace(t);
  // The other Claude process: this process's id with another start token, in another session.
  const jobId = createLedJob(ws, { pid: process.pid, startToken: "0" }, { sessionId: "sess-elsewhere", testDriver: { delayMs: 50 } });
  const monitor = startStoreMonitor(t, ws, { CLAUDE_PID: String(process.pid) });
  await startJob(ws, jobId).exit;
  const [event] = eventsOf(ws, jobId);
  assert.equal(event.kind, "completed");

  await sleepMs(7000);
  assert.equal(monitor.stdout, "");
  assert.equal(marksOf(ws, event.id).length, 0);
});

test("the monitor exits when its Claude process is gone", { timeout: 30000 }, async (t) => {
  const ws = storeWorkspace(t);
  const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => gone.on("close", resolve));
  const monitor = startStoreMonitor(t, ws, { CLAUDE_PID: String(gone.pid) });

  const code = await Promise.race([monitor.exit, sleepMs(10000).then(() => "still running after 10 s")]);
  assert.equal(code, 0, monitor.stderr);
});
