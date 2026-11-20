import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run, stopOwnedProcess } from "./helpers.mjs";
import {
  buildStatusSnapshot,
  readJobProgressPreview,
  reconcileJobLiveness,
  resolveResultJob,
  terminateJobProcesses,
  WORKER_START_GRACE_MS
} from "../plugins/agent/scripts/lib/job-control.mjs";
import { cancelJob } from "../plugins/agent/scripts/commands/cancel.mjs";
import { readProcessCommandLines } from "../plugins/agent/scripts/lib/process.mjs";
import * as processLib from "../plugins/agent/scripts/lib/process.mjs";
import * as stateLib from "../plugins/agent/scripts/lib/state.mjs";
import * as storeLib from "../plugins/agent/scripts/lib/store.mjs";
import * as fixtures from "./store-fixtures.mjs";
import { listJobs, readJobFile, resolveJobFile, upsertJob, writeJobFile } from "../plugins/agent/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "agent", "scripts", "codex-companion.mjs");
const NEUTRAL = path.join(ROOT, "plugins", "agent", "scripts", "agent-companion.mjs");

// The PID of a process that has already exited.
function exitedPid() {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

const alwaysDead = () => false;
const noInterrupt = async () => {};

test("a running job whose worker exited is stored as failed", async () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "task-dead", status: "running", pid: 424240 });

  const reaped = await reconcileJobLiveness(workspace, { isAlive: alwaysDead, interruptTurn: noInterrupt });

  assert.deepEqual(reaped, ["task-dead"]);
  const stored = readJobFile(resolveJobFile(workspace, "task-dead"));
  assert.equal(stored.status, "failed");
  assert.equal(stored.pid, null);
  assert.match(stored.errorMessage, /worker process exited/);
});

test("status reports a job with an exited worker as failed", () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "task-dead-cli", status: "running", pid: exitedPid(), title: "Codex Task" });

  const result = run("node", [NEUTRAL, "status", "task-dead-cli", "--json", "--cwd", workspace], { cwd: workspace });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).job.status, "failed");
  assert.equal(readJobFile(resolveJobFile(workspace, "task-dead-cli")).status, "failed");
});

test("a queued job without a worker fails after the start grace period", async () => {
  const workspace = makeTempDir();
  writeJobFile(workspace, "task-queued", { id: "task-queued", status: "queued", pid: null });
  const createdAt = Date.parse(readJobFile(resolveJobFile(workspace, "task-queued")).createdAt);

  assert.deepEqual(await reconcileJobLiveness(workspace, { now: createdAt + WORKER_START_GRACE_MS - 1000 }), []);
  assert.deepEqual(await reconcileJobLiveness(workspace, { now: createdAt + WORKER_START_GRACE_MS + 1000 }), ["task-queued"]);
  assert.match(readJobFile(resolveJobFile(workspace, "task-queued")).errorMessage, /did not start/);
});

test("a job that finishes while being checked keeps its result", async () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "task-race", status: "running", pid: 424242 });

  const reaped = await reconcileJobLiveness(workspace, {
    isAlive() {
      upsertJob(workspace, { id: "task-race", status: "completed", pid: null });
      return false;
    },
    interruptTurn: noInterrupt
  });

  assert.deepEqual(reaped, []);
  assert.equal(readJobFile(resolveJobFile(workspace, "task-race")).status, "completed");
});

test("the turn of a dead worker is interrupted before the job fails", async () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "task-turn", status: "running", pid: 424242, threadId: "thr_1", turnId: "turn_1" });
  upsertJob(workspace, { id: "task-no-turn", status: "running", pid: 424243, threadId: "thr_2" });
  const interrupted = [];

  await reconcileJobLiveness(workspace, {
    isAlive: alwaysDead,
    async interruptTurn(_root, job) {
      interrupted.push(`${job.threadId}/${job.turnId}`);
    }
  });

  assert.deepEqual(interrupted, ["thr_1/turn_1"]);
  assert.deepEqual(
    listJobs(workspace).map((job) => job.status),
    ["failed", "failed"]
  );
});

test("a PID reused by another process is not stopped", () => {
  const terminated = [];
  const outcomes = terminateJobProcesses(
    [
      { id: "job-a", status: "running", pid: 101, processMarker: "job-a" },
      { id: "job-b", status: "running", pid: 102, processMarker: "job-b" },
      { id: "job-c", status: "running", pid: 103 },
      { id: "job-d", status: "completed", pid: 104 }
    ],
    {
      readCommandLines: () =>
        new Map([
          [101, "node codex-companion.mjs task-worker --job-id job-a"],
          [102, "C:\\Windows\\explorer.exe"]
        ]),
      terminate(pid) {
        terminated.push(pid);
        return { delivered: true };
      }
    }
  );

  assert.deepEqual(terminated, [101]);
  assert.deepEqual(
    outcomes.map((entry) => entry.outcome),
    ["terminated", "pid-reused", "not-running"]
  );
});

test("a failed process lookup stops nothing and reports the process unverified", () => {
  const terminated = [];
  const outcomes = terminateJobProcesses([{ id: "job-a", status: "running", pid: 101, processMarker: "job-a" }], {
    readCommandLines: () => null,
    terminate(pid) {
      terminated.push(pid);
      return { delivered: true };
    }
  });
  assert.deepEqual(terminated, []);
  assert.deepEqual(outcomes, [{ jobId: "job-a", pid: 101, outcome: "unverified" }]);
});

test("cancel says the process may still be running when its lookup fails", async () => {
  const workspace = makeTempDir();
  const id = "task-unverified";
  const logFile = path.join(workspace, `${id}.log`);
  fs.writeFileSync(logFile, "", "utf8");
  const job = { id, provider: "codex", status: "running", phase: "running", title: "Codex Task", jobClass: "task", pid: 424245, processMarker: id, logFile };
  upsertJob(workspace, job);
  const terminated = [];
  const { payload, report } = await cancelJob(workspace, job, job, {
    interruptTurn: async () => ({ attempted: false, interrupted: false }),
    terminate: (jobs) =>
      terminateJobProcesses(jobs, {
        readCommandLines: () => null,
        terminate(pid) {
          terminated.push(pid);
          return { delivered: true };
        }
      })
  });
  assert.deepEqual(terminated, []);
  assert.match(payload.processWarning ?? "", /424245.*may still be running/);
  assert.match(report ?? "", /424245.*may still be running/);
  assert.match(fs.readFileSync(logFile, "utf8"), /424245.*may still be running/);
});

test("readProcessCommandLines finds the current process and not an exited one", () => {
  const gone = exitedPid();
  const lines = readProcessCommandLines([process.pid, gone]);
  assert.ok(lines, "the lookup failed");
  assert.match(lines.get(process.pid), /node/i);
  assert.equal(lines.has(gone), false);
});

test("task --resume-last is not blocked by a task whose worker exited", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(firstRun.status, 0, firstRun.stderr);
  upsertJob(repo, { id: "task-orphan", status: "running", jobClass: "task", pid: exitedPid() });

  const result = run("node", [SCRIPT, "task", "--resume-last", "follow up"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Resumed the prior run.\nFollow-up prompt accepted.\n");
});

test("a job whose pid now belongs to another program is failed", async (t) => {
  const workspace = makeTempDir(t);
  upsertJob(workspace, { id: "task-reused", status: "running", pid: 5001, threadId: "thr_r", turnId: "turn_r" });
  upsertJob(workspace, { id: "task-live", status: "running", pid: 5002 });
  const interrupted = [];

  const reaped = await reconcileJobLiveness(workspace, {
    isAlive: () => true,
    readCommandLines: () =>
      new Map([
        [5001, "notepad.exe"],
        [5002, "node codex-companion.mjs task-worker --job-id task-live"]
      ]),
    async interruptTurn(_root, job) {
      interrupted.push(job.id);
    }
  });

  assert.deepEqual(reaped, ["task-reused"]);
  assert.deepEqual(interrupted, ["task-reused"]);
  const reused = readJobFile(resolveJobFile(workspace, "task-reused"));
  assert.equal(reused.status, "failed");
  assert.match(reused.errorMessage, /another program/);
  assert.equal(readJobFile(resolveJobFile(workspace, "task-live")).status, "running");
});

test("a failed process lookup keeps a live job running", async (t) => {
  const workspace = makeTempDir(t);
  upsertJob(workspace, { id: "task-unknown", status: "running", pid: 5003 });

  const reaped = await reconcileJobLiveness(workspace, { isAlive: () => true, readCommandLines: () => null });

  assert.deepEqual(reaped, []);
  assert.equal(readJobFile(resolveJobFile(workspace, "task-unknown")).status, "running");
});

test("a queued job with an unreadable createdAt fails after the grace period from updatedAt", async (t) => {
  const workspace = makeTempDir(t);
  writeJobFile(workspace, "task-bad-date", { id: "task-bad-date", status: "queued", pid: null, createdAt: "not a date" });
  const updatedAt = Date.parse(readJobFile(resolveJobFile(workspace, "task-bad-date")).updatedAt);

  assert.deepEqual(await reconcileJobLiveness(workspace, { now: updatedAt + WORKER_START_GRACE_MS - 1000 }), []);
  assert.deepEqual(await reconcileJobLiveness(workspace, { now: updatedAt + WORKER_START_GRACE_MS + 1000 }), [
    "task-bad-date"
  ]);
});

test("result for a running job says it is still running", (t) => {
  const workspace = makeTempDir(t);
  upsertJob(workspace, { id: "task-done", status: "completed" });
  upsertJob(workspace, { id: "task-busy", status: "running", pid: 5004 });

  assert.throws(() => resolveResultJob(workspace, "task-busy"), /Job task-busy is still running/);
  assert.throws(() => resolveResultJob(workspace, "task-nope"), /No job found for "task-nope"/);
  assert.equal(resolveResultJob(workspace, "task-done").job.id, "task-done");
});

test("active jobs do not take slots from the recent list", async (t) => {
  const workspace = makeTempDir(t);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 3));
  for (let index = 0; index < 3; index += 1) {
    upsertJob(workspace, { id: `task-finished-${index}`, status: "completed" });
    await tick();
  }
  for (let index = 0; index < 9; index += 1) {
    upsertJob(workspace, { id: `task-running-${index}`, status: "running", pid: 6000 + index });
    await tick();
  }

  const snapshot = buildStatusSnapshot(workspace, { maxJobs: 8, env: {} });

  assert.equal(snapshot.running.length, 9);
  assert.equal(snapshot.latestFinished.id, "task-finished-2");
  assert.deepEqual(
    snapshot.recent.map((job) => job.id),
    ["task-finished-1", "task-finished-0"]
  );
});

test("status reads only the tail of a large log", (t) => {
  const workspace = makeTempDir(t);
  const logFile = path.join(workspace, "big.log");
  const filler = `[2026-01-01T00:00:00.000Z] filler ${"z".repeat(100)}\n`;
  const fd = fs.openSync(logFile, "w");
  try {
    const block = filler.repeat(1000);
    for (let written = 0; written < 10 * 1024 * 1024; written += block.length) {
      fs.writeSync(fd, block);
    }
    for (let index = 1; index <= 5; index += 1) {
      fs.writeSync(fd, `[2026-01-01T00:00:01.000Z] TAIL_LINE_${index}\n`);
    }
  } finally {
    fs.closeSync(fd);
  }
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (file, ...rest) => {
    if (path.resolve(String(file)) === logFile) {
      throw new Error("the whole log was read");
    }
    return readFileSync.call(fs, file, ...rest);
  });

  const preview = readJobProgressPreview(logFile, 4);

  assert.deepEqual(preview, ["TAIL_LINE_2", "TAIL_LINE_3", "TAIL_LINE_4", "TAIL_LINE_5"]);
});

test("an empty process marker in a record does not let a reused pid be stopped", () => {
  const stopped = [];
  const [outcome] = terminateJobProcesses(
    [{ id: "task-planted", provider: "codex", status: "running", pid: 424243, processMarker: "" }],
    {
      readCommandLines: (pids) => new Map(pids.map((pid) => [pid, "notepad.exe --planted"])),
      terminate: (pid) => {
        stopped.push(pid);
        return { delivered: true };
      }
    }
  );

  assert.equal(outcome.outcome, "pid-reused");
  assert.deepEqual(stopped, []);
});

test("an empty process marker in a record does not keep a reused pid's job alive", async () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "task-empty-marker", provider: "codex", status: "running", pid: 424244, processMarker: "" });

  const reaped = await reconcileJobLiveness(workspace, {
    isAlive: () => true,
    readCommandLines: (pids) => new Map(pids.map((pid) => [pid, "notepad.exe --planted"])),
    interruptTurn: noInterrupt
  });

  assert.deepEqual(reaped, ["task-empty-marker"]);
  assert.match(readJobFile(resolveJobFile(workspace, "task-empty-marker")).errorMessage, /belongs to another program/);
});

// ---------------------------------------------------------------------------------------------
// The stale tracker

const trackerClaim = { pid: 501, startToken: "t-501", jobId: "job-a", execGen: 1 };
const invalid = { valid: false, reason: "malformed" };

test("a polling gap longer than twice the interval resets every count", async () => {
  const { createStaleTracker } = await import("../plugins/agent/scripts/lib/live.mjs");
  const tracker = createStaleTracker({ stalePolls: 8, gapMs: 4000 });
  let verdict;
  for (let poll = 0; poll < 7; poll += 1) {
    verdict = tracker.observeBatch(poll * 2000, new Map([["job-a:1", { claim: trackerClaim, sample: invalid }]])).get("job-a:1");
  }
  assert.equal(verdict.verdict, "counting");
  assert.equal(verdict.count, 7);
  verdict = tracker.observeBatch(6 * 2000 + 4001, new Map([["job-a:1", { claim: trackerClaim, sample: invalid }]])).get("job-a:1");
  assert.equal(verdict.verdict, "counting");
  assert.equal(verdict.count, 1);
  for (let poll = 1; poll < 8; poll += 1) {
    verdict = tracker.observeBatch(16001 + poll * 2000, new Map([["job-a:1", { claim: trackerClaim, sample: invalid }]])).get("job-a:1");
  }
  assert.equal(verdict.verdict, "stale");
  tracker.reset();
  verdict = tracker.observeBatch(40000, new Map([["job-a:1", { claim: trackerClaim, sample: invalid }]])).get("job-a:1");
  assert.equal(verdict.count, 1);
});

test("the tracker publishes the claim and last valid counter it judged", async () => {
  const { createStaleTracker } = await import("../plugins/agent/scripts/lib/live.mjs");
  const tracker = createStaleTracker({ stalePolls: 2, gapMs: 4000 });
  let result = tracker.observeBatch(0, new Map([["job-a:1", { claim: trackerClaim, sample: { valid: true, counter: 5 } }]]));
  assert.deepEqual(result.get("job-a:1"), { verdict: "fresh", claim: trackerClaim, lastValidCounter: 5, count: 0 });
  result = tracker.observeBatch(2000, new Map([["job-a:1", { claim: trackerClaim, sample: { valid: true, counter: 5 } }]]));
  assert.equal(result.get("job-a:1").verdict, "counting");
  result = tracker.observeBatch(4000, new Map([["job-a:1", { claim: trackerClaim, sample: { valid: true, counter: 4 } }]]));
  assert.deepEqual(result.get("job-a:1"), { verdict: "stale", claim: trackerClaim, lastValidCounter: 5, count: 2 });
  const nextClaim = { ...trackerClaim, execGen: 2 };
  result = tracker.observeBatch(6000, new Map([["job-a:2", { claim: nextClaim, sample: { valid: true, counter: 1 } }]]));
  assert.equal(result.has("job-a:1"), false);
  assert.deepEqual(result.get("job-a:2"), { verdict: "fresh", claim: nextClaim, lastValidCounter: 1, count: 0 });
});

// ---------------------------------------------------------------------------------------------
// Store reconciliation of dead workers

test("a dead worker's job is interrupted, failed only when not resumable, and confirmed only with closure", { timeout: 60000 }, async (t) => {
  const { makeStoreDir, rawAll, rawExec, startHelperProcess } = await import("./store-fixtures.mjs");
  const store = await import("../plugins/agent/scripts/lib/store.mjs");
  const state = await import("../plugins/agent/scripts/lib/state.mjs");
  const exited = async () => {
    const helper = await startHelperProcess();
    const gone = new Promise((resolve) => helper.process.on("exit", resolve));
    await stopOwnedProcess(helper.process);
    await gone;
    return helper.pid;
  };
  const workerPid = await exited();
  const rootPid = await exited();
  const blocker = await startHelperProcess();
  t.after(() => stopOwnedProcess(blocker.process));
  for (const closure of [true, false]) {
    const stateDir = makeStoreDir(t);
    const db = store.openStore(stateDir);
    t.after(() => db.close());
    const make = (title, { threadId = null, ephemeral = false, submitted = true }) => {
      const { jobId } = state.createJob(db, {
        provider: "codex",
        kind: "task",
        title,
        prompt: "p",
        request: {},
        cwd: ".",
        threadId,
        ephemeral,
        requester: { sessionId: "s", leaderPid: null, leaderStartToken: null }
      });
      const groupId = process.platform === "win32" ? "NULL" : closure ? workerPid : blocker.pid;
      rawExec(
        stateDir,
        `UPDATE jobs SET exec_gen = 1, worker_pid = ${workerPid}, worker_start_token = 'w', claimed_at = 1, worker_group_id = ${groupId}, provider_group_id = ${groupId},
           spawn_intent_at = 2, provider_pid = ${rootPid}, provider_start_token = 'r', submit_intent_at = ${submitted ? 3 : "NULL"},
           started_at = 4, request_json = json_set(request_json, '$.providerVersion', '1.0.0') WHERE id = '${jobId}'`
      );
      return jobId;
    };
    const withThread = make("thread", { threadId: `th-${closure}` });
    const ephemeral = make("ephemeral", { threadId: `th-e-${closure}`, ephemeral: true });
    const promptOnly = make("prompt", { submitted: false });
    if (closure) {
      process.env.AGENT_PLUGIN_TEST_CONTRACTS = JSON.stringify([{ provider: "codex", platform: process.platform, trigger: "owner-death", version: "0.0.1", windowMs: 0 }]);
    } else {
      delete process.env.AGENT_PLUGIN_TEST_CONTRACTS;
    }
    process.env.AGENT_PLUGIN_GRACE_MS = "5000";
    try {
      const scan = () => state.scanWorkspace(db, { deadline: performance.now() + 30000, launch: async () => null, leaderCheck: async () => new Map() });
      // A scan skips an execution it has no time left for on a busy machine; the next scan takes it.
      const marked = new Set();
      for (let attempt = 0; attempt < 3 && marked.size < 3; attempt += 1) {
        const outcome = await scan();
        outcome[closure ? "released" : "stopping"].forEach((jobId) => marked.add(jobId));
      }
      if (!closure) {
        assert.deepEqual([...marked].sort(), [withThread, ephemeral, promptOnly].sort());
        for (const jobId of [withThread, ephemeral, promptOnly]) {
          assert.equal(state.readJobView(db, jobId).state, "stopping");
        }
        await new Promise((resolve) => setTimeout(resolve, 5200));
        await scan();
      }
      const rows = Object.fromEntries(
        rawAll(stateDir, "SELECT title, end_state, resume_method, release_kind, provider_exit_unobserved FROM jobs").map((row) => [row.title, row])
      );
      const kind = closure ? "confirmed" : "unobserved";
      const flag = closure ? 0 : 1;
      assert.deepEqual(rows.thread, { title: "thread", end_state: "interrupted", resume_method: null, release_kind: kind, provider_exit_unobserved: flag });
      assert.equal(rows.ephemeral.end_state, "failed");
      assert.equal(rows.ephemeral.release_kind, kind);
      assert.deepEqual(rows.prompt, { title: "prompt", end_state: "interrupted", resume_method: "stored-prompt", release_kind: kind, provider_exit_unobserved: flag });
    } finally {
      delete process.env.AGENT_PLUGIN_TEST_CONTRACTS;
      delete process.env.AGENT_PLUGIN_GRACE_MS;
    }
  }
});

// ---------------------------------------------------------------------------------------------
// The worker harness on the test driver


const WORKER_CONTRACTS = JSON.stringify(
  ["stdin-end", "tree-stop", "owner-death"].map((trigger) => ({ provider: "codex", platform: process.platform, trigger, version: "0.0.1", windowMs: 0 }))
);

function workerEnv(extra = {}) {
  return { AGENT_PLUGIN_TEST_CONTRACTS: WORKER_CONTRACTS, ...extra };
}

function driverJob(db, testDriver, overrides = {}) {
  // Jobs created in one millisecond tie on created_at and are ordered by their random ids, so
  // each creation waits for the next millisecond to keep creation order.
  const until = Date.now() + 2;
  while (Date.now() < until) {
    // A short busy wait.
  }
  return stateLib.createJob(db, {
    provider: "codex",
    kind: "task",
    title: overrides.title ?? "driver job",
    prompt: "do the work",
    request: { cwd: ".", testDriver },
    cwd: ".",
    requester: overrides.requester ?? { sessionId: "session-1", leaderPid: null, leaderStartToken: null },
    threadId: overrides.threadId ?? null
  }).jobId;
}

function jobRow(stateDir, jobId) {
  return fixtures.rawAll(stateDir, `SELECT * FROM jobs WHERE id = '${jobId}'`)[0];
}

async function waitFor(predicate, { timeoutMs = 20000, intervalMs = 50, describe = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) {
      return value;
    }
    if (Date.now() > until) {
      throw new Error(`${describe} did not happen within ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Every process a test started, stopped through stopOwnedProcesses when the test ends.
const trackProcesses = (t) => fixtures.trackProcesses(t);

function providerPids(stateDir, jobId) {
  return fixtures
    .readTrace(stateDir, jobId)
    .flatMap((entry) => [entry.type === "spawned" ? entry.pid : null, entry.type === "child" ? entry.childPid : null])
    .filter(Boolean);
}

// True once every pid reads absent. A lookup that times out on a busy machine answers unknown,
// so it is asked again for up to 20 seconds.
async function allAbsent(pids) {
  const until = Date.now() + 20000;
  for (;;) {
    const identities = await processLib.readProcessIdentities(pids, { deadline: performance.now() + 10000 });
    if (pids.every((pid) => identities.get(pid)?.state === "absent")) {
      return true;
    }
    if (pids.some((pid) => identities.get(pid)?.state === "present") || Date.now() > until) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function openDb(t, stateDir) {
  const db = storeLib.openStore(stateDir);
  t.after(() => db.close());
  return db;
}

async function startedJob(t, testDriver, env = {}, overrides = {}) {
  const stateDir = fixtures.makeStoreDir(t);
  const db = openDb(t, stateDir);
  const jobId = driverJob(db, testDriver, overrides);
  const pids = trackProcesses(t);
  const worker = fixtures.startTestWorker(stateDir, jobId, workerEnv(env), pids);
  await waitFor(() => jobRow(stateDir, jobId)?.started_at !== null, { describe: "the turn start" });
  pids.push(...fixtures.providerIdentities(stateDir, jobId));
  return { stateDir, db, jobId, worker, pids };
}

test("a worker interrupts, waits and releases when its turn stops in time", { timeout: 60000 }, async (t) => {
  const { stateDir, db, jobId, worker } = await startedJob(t, { delayMs: 30000, interrupt: true });
  stateLib.requestStop(db, { jobIds: [jobId] }, { reason: "session-end" });
  const exit = await worker.exit;
  assert.equal(exit.code, 0, exit.stderr);
  const row = jobRow(stateDir, jobId);
  assert.equal(row.end_state, "interrupted");
  assert.equal(row.end_reason, "session-end");
  assert.equal(row.release_kind, "confirmed");
  assert.equal(row.result_text, "interrupted");
  const requests = fixtures.readTrace(stateDir, jobId).map((entry) => entry.request ?? entry.type);
  assert.ok(requests.includes("interrupt"), requests.join(","));
  if (process.platform === "win32") {
    // Windows has no end-of-input step: the idle provider is stopped by the tree stop.
    assert.ok(!requests.includes("eof"), requests.join(","));
    assert.ok(fs.readFileSync(path.join(stateDir, "store", "artifacts", `${jobId}.log`), "utf8").includes("tree stop at"));
  } else {
    assert.ok(requests.includes("eof"), requests.join(","));
  }
  assert.equal(await allAbsent(providerPids(stateDir, jobId)), true);
});

test("a turn that ignores interrupt is stopped by identity at the deadline", { timeout: 60000 }, async (t) => {
  const { stateDir, db, jobId, worker } = await startedJob(t, { delayMs: 30000, interrupt: true, ignoreInterrupt: true });
  const started = performance.now();
  stateLib.requestStop(db, { jobIds: [jobId] }, { reason: "session-end" });
  const exit = await worker.exit;
  const elapsed = performance.now() - started;
  t.diagnostic(`worker exited ${Math.round(elapsed)} ms after the stop request`);
  assert.equal(exit.code, 0, exit.stderr);
  assert.ok(elapsed >= 2500, `the worker did not wait for the deadline (${elapsed} ms)`);
  const row = jobRow(stateDir, jobId);
  assert.equal(row.end_state, "interrupted");
  assert.equal(row.release_kind, "confirmed");
  assert.equal(await allAbsent(providerPids(stateDir, jobId)), true);
  assert.ok(fs.readFileSync(path.join(stateDir, "store", "artifacts", `${jobId}.log`), "utf8").includes("tree stop at"));
});

test("a provider that ignores end of input is stopped by identity", { timeout: 60000 }, async (t) => {
  const { stateDir, jobId, worker } = await startedJob(t, { delayMs: 300, ignoreEof: true }, { AGENT_PLUGIN_NATURAL_EXIT_MS: "1000" });
  const exit = await worker.exit;
  assert.equal(exit.code, 0, exit.stderr);
  const row = jobRow(stateDir, jobId);
  assert.equal(row.end_state, "completed");
  assert.equal(row.result_text, "done");
  assert.equal(row.release_kind, "confirmed");
  assert.equal(await allAbsent(providerPids(stateDir, jobId)), true);
});

test("a stop during the post-end shutdown keeps the end and releases", { timeout: 60000 }, async (t) => {
  const stateDir = fixtures.makeStoreDir(t);
  const pointsDir = path.join(stateDir, "points");
  fs.mkdirSync(pointsDir);
  const db = openDb(t, stateDir);
  const jobId = driverJob(db, { delayMs: 200 });
  const pids = trackProcesses(t);
  const worker = fixtures.startTestWorker(stateDir, jobId, workerEnv({ AGENT_PLUGIN_TEST_POINTS: "before-shutdown", AGENT_PLUGIN_TEST_POINTS_DIR: pointsDir }), pids);
  await waitFor(() => fs.readdirSync(pointsDir).some((name) => name.startsWith("before-shutdown-")), { describe: "the before-shutdown point" });
  pids.push(...fixtures.providerIdentities(stateDir, jobId));
  const before = jobRow(stateDir, jobId);
  assert.equal(before.end_state, "completed");
  stateLib.requestStop(db, { jobIds: [jobId] }, { reason: "session-end" });
  fs.writeFileSync(path.join(pointsDir, "before-shutdown.release"), "");
  const exit = await worker.exit;
  assert.equal(exit.code, 0, exit.stderr);
  const row = jobRow(stateDir, jobId);
  assert.equal(row.end_state, "completed");
  assert.equal(row.end_at, before.end_at);
  assert.notEqual(row.stop_requested_at, null);
  assert.equal(row.release_kind, "confirmed");
});

test("a release launches every free cohort place", { timeout: 90000 }, async (t) => {
  const stateDir = fixtures.makeStoreDir(t);
  fs.writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ maxParallel: { codex: 3 } }));
  const db = openDb(t, stateDir);
  const running = driverJob(db, { delayMs: 1500 }, { title: "running" });
  const queued = [1, 2, 3].map((index) => driverJob(db, { delayMs: 200 }, { title: `queued ${index}` }));
  const pids = trackProcesses(t);
  const worker = fixtures.startTestWorker(stateDir, running, workerEnv({ AGENT_PLUGIN_TEST_WORKER_ENTRY: fixtures.FIXTURE_SCRIPT }), pids);
  const exit = await worker.exit;
  assert.equal(exit.code, 0, exit.stderr);
  await waitFor(() => queued.every((jobId) => jobRow(stateDir, jobId).exec_released_at !== null), { timeoutMs: 60000, describe: "the three launched jobs" });
  for (const jobId of queued) {
    const row = jobRow(stateDir, jobId);
    pids.push(...fixtures.jobProcesses(stateDir, jobId));
    assert.equal(row.end_state, "completed");
    assert.equal(row.release_kind, "confirmed");
    assert.ok(row.claimed_at >= jobRow(stateDir, running).exec_released_at);
  }
});

test("a worker whose first heartbeat cannot be written stops its provider and exits", { timeout: 60000 }, async (t) => {
  const stateDir = fixtures.makeStoreDir(t);
  const db = openDb(t, stateDir);
  const jobId = driverJob(db, { delayMs: 30000 });
  const liveDir = path.join(stateDir, "store", "live");
  fs.rmSync(liveDir, { recursive: true, force: true });
  fs.writeFileSync(liveDir, "not a folder");
  const pids = trackProcesses(t);
  const first = await fixtures.startTestWorker(stateDir, jobId, workerEnv(), pids).exit;
  assert.equal(first.code, 1, first.stderr);
  assert.deepEqual(fixtures.readTrace(stateDir, jobId), []);
  assert.equal(jobRow(stateDir, jobId).spawn_intent_at, null);

  const pauseFile = path.join(stateDir, "pause-heartbeat");
  const { stateDir: pausedDir, jobId: pausedJob, worker } = await startedJob(t, { delayMs: 60000 }, { AGENT_PLUGIN_HEARTBEAT_PAUSE_FILE: pauseFile });
  fs.writeFileSync(pauseFile, "");
  const pausedAt = performance.now();
  const exit = await worker.exit;
  const waited = performance.now() - pausedAt;
  assert.equal(exit.code, 1, exit.stderr);
  assert.equal(await allAbsent(providerPids(pausedDir, pausedJob)), true);
  t.diagnostic(`the worker stopped ${Math.round(waited)} ms after its heartbeat writer paused`);
  assert.ok(waited >= 5000 && waited <= 16000, `${waited} ms`);
  const row = jobRow(pausedDir, pausedJob);
  assert.equal(row.end_state, null);
  assert.equal(row.exec_released_at, null);
});

test("a worker stops its provider and exits when the store folder moves or turns corrupt", { timeout: 60000 }, async (t) => {
  const { stateDir, jobId, worker } = await startedJob(t, { delayMs: 60000 });
  const providers = providerPids(stateDir, jobId);
  const storeDir = path.join(stateDir, "store");
  if (process.platform === "win32") {
    // Windows refuses to rename a folder whose database is open, so the store turns corrupt instead:
    // the database, the WAL and the two copies of the WAL index header (bytes 0 to 95 of the -shm
    // file, below its lock bytes) are overwritten, which the worker's next read detects.
    const overwrite = (name, length) => {
      const fd = fs.openSync(path.join(storeDir, name), "r+");
      try {
        fs.writeSync(fd, Buffer.alloc(length, 0x5a), 0, length, 0);
      } finally {
        fs.closeSync(fd);
      }
    };
    for (const name of ["state.db", "state.db-wal"]) {
      const size = fs.existsSync(path.join(storeDir, name)) ? fs.statSync(path.join(storeDir, name)).size : 0;
      if (size > 0) {
        overwrite(name, Math.min(size, 1 << 20));
      }
    }
    overwrite("state.db-shm", 96);
  } else {
    fs.renameSync(storeDir, path.join(stateDir, "store.moved"));
  }
  const exit = await worker.exit;
  assert.equal(exit.code, 1, exit.stderr);
  assert.equal(await allAbsent(providers), true);
});

test("delegates stop when the leader dies, one test per leader state", { timeout: 90000 }, async (t) => {
  const stateDir = fixtures.makeStoreDir(t);
  const db = openDb(t, stateDir);
  const pids = trackProcesses(t);
  const leader = await fixtures.startHelperProcess();
  pids.push(leader.process);
  const identity = await processLib.readProcessIdentity(leader.pid, { deadline: performance.now() + 5000 });
  const turn = { delayMs: 60000, interrupt: true };
  const jobs = {
    alive: driverJob(db, turn, { title: "leader", requester: { sessionId: "s", leaderPid: leader.pid, leaderStartToken: identity.startToken } }),
    none: driverJob(db, turn, { title: "none", requester: { sessionId: "s", leaderPid: null, leaderStartToken: null } }),
    nullToken: driverJob(db, turn, { title: "null token", requester: { sessionId: "s", leaderPid: leader.pid, leaderStartToken: null } }),
    unknown: driverJob(db, turn, { title: "unknown", requester: { sessionId: "s", leaderPid: leader.pid, leaderStartToken: identity.startToken } })
  };
  const workers = {};
  for (const [name, jobId] of Object.entries(jobs)) {
    const extra = { AGENT_PLUGIN_LEADER_CHECK_MS: "500", ...(name === "unknown" ? { AGENT_PLUGIN_TEST_PROCESS: JSON.stringify({ lookup: "unknown" }) } : {}) };
    workers[name] = fixtures.startTestWorker(stateDir, jobId, workerEnv(extra), pids);
  }
  for (const jobId of Object.values(jobs)) {
    await waitFor(() => jobRow(stateDir, jobId).started_at !== null, { describe: "every turn start" });
    pids.push(...fixtures.providerIdentities(stateDir, jobId));
  }
  await stopOwnedProcess(leader.process);
  const stoppedAt = Date.now();
  const exit = await workers.alive.exit;
  assert.ok(Date.now() - stoppedAt <= 15000);
  assert.equal(exit.code, 0, exit.stderr);
  const row = jobRow(stateDir, jobs.alive);
  assert.equal(row.end_state, "interrupted");
  assert.equal(row.end_reason, "leader-gone");
  assert.equal(await allAbsent([workers.alive.pid, ...providerPids(stateDir, jobs.alive)]), true);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  for (const name of ["none", "nullToken", "unknown"]) {
    const kept = jobRow(stateDir, jobs[name]);
    assert.equal(kept.end_state, null, name);
    assert.equal(kept.stop_requested_at, null, name);
  }
  stateLib.requestStop(db, { jobIds: [jobs.none, jobs.nullToken, jobs.unknown] }, { reason: "session-end" });
  for (const name of ["none", "nullToken", "unknown"]) {
    const done = await workers[name].exit;
    assert.equal(done.code, 0, `${name}: ${done.stderr}`);
    assert.equal(jobRow(stateDir, jobs[name]).end_state, "interrupted", name);
  }
});

test("the stop deadline ignores wall-clock jumps after first observation", { timeout: 120000 }, async (t) => {
  const results = [];
  for (const [when, offset] of [["before", 60000], ["before", -60000], ["after", 60000], ["after", -60000]]) {
    const clockFile = path.join(os.tmpdir(), `clock-${process.pid}-${when}-${offset}-${Date.now()}`);
    fs.writeFileSync(clockFile, "0");
    t.after(() => fs.rmSync(clockFile, { force: true }));
    const { stateDir, db, jobId, worker } = await startedJob(t, { delayMs: 60000, interrupt: true, ignoreInterrupt: true }, { AGENT_PLUGIN_TEST_CLOCK_OFFSET_FILE: clockFile });
    const logFile = path.join(stateDir, "store", "artifacts", `${jobId}.log`);
    stateLib.requestStop(db, { jobIds: [jobId] }, { reason: "session-end", afterMs: 4000 });
    if (when === "before") {
      fs.writeFileSync(clockFile, String(offset));
    } else {
      await waitFor(() => fs.existsSync(logFile) && fs.readFileSync(logFile, "utf8").includes("stop observed"), { describe: "the first observation" });
      fs.writeFileSync(clockFile, String(offset));
    }
    const exit = await worker.exit;
    assert.equal(exit.code, 0, exit.stderr);
    const log = fs.readFileSync(logFile, "utf8");
    const observed = /stop observed at ([\d.]+); local deadline ([\d.]+)/.exec(log);
    const stopped = /tree stop at ([\d.]+)/.exec(log);
    assert.ok(observed && stopped, log);
    const budget = Number(observed[2]) - Number(observed[1]);
    const waited = Number(stopped[1]) - Number(observed[1]);
    results.push(`${when} ${offset > 0 ? "+" : ""}${offset / 1000} s: budget ${Math.round(budget)} ms, tree stop after ${Math.round(waited)} ms`);
    if (when === "before" && offset > 0) {
      assert.ok(budget <= 1, `budget ${budget}`);
      assert.ok(waited <= 600, `waited ${waited}`);
    } else {
      assert.ok(budget <= 4000.5, `budget ${budget}`);
      assert.ok(budget >= 3000, `budget ${budget}`);
      assert.ok(waited <= 4000 + 500, `waited ${waited}`);
      // Windows stops the tree once the interrupt wait ends, 1.5 s before the deadline; Linux first
      // ends the provider's input and waits until 0.5 s before it.
      const lead = process.platform === "win32" ? 1500 : 500;
      assert.ok(waited >= budget - lead - 100, `waited ${waited}`);
    }
  }
  t.diagnostic(results.join("; "));
});
