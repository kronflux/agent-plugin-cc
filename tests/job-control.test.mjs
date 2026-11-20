import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  buildStatusSnapshot,
  readJobProgressPreview,
  reconcileJobLiveness,
  resolveResultJob,
  terminateJobProcesses,
  WORKER_START_GRACE_MS
} from "../plugins/agent/scripts/lib/job-control.mjs";
import { readProcessCommandLines } from "../plugins/agent/scripts/lib/process.mjs";
import { listJobs, readJobFile, resolveJobFile, upsertJob, writeJobFile } from "../plugins/agent/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "agent", "scripts", "codex-companion.mjs");

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

  const result = run("node", [SCRIPT, "status", "task-dead-cli", "--json", "--cwd", workspace], { cwd: workspace });

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

test("a failed process lookup still stops the job", () => {
  const terminated = [];
  terminateJobProcesses([{ id: "job-a", status: "running", pid: 101 }], {
    readCommandLines: () => null,
    terminate(pid) {
      terminated.push(pid);
      return { delivered: true };
    }
  });
  assert.deepEqual(terminated, [101]);
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
