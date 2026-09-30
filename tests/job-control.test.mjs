import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run, stopTestBrokers } from "./helpers.mjs";
import { reconcileJobLiveness, terminateJobProcesses, WORKER_START_GRACE_MS } from "../plugins/agent/scripts/lib/job-control.mjs";
import { readProcessCommandLines } from "../plugins/agent/scripts/lib/process.mjs";
import { listJobs, readJobFile, resolveJobFile, upsertJob, writeJobFile } from "../plugins/agent/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "agent", "scripts", "codex-companion.mjs");

after(stopTestBrokers);

// The PID of a process that has already exited.
function exitedPid() {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

const alwaysDead = () => false;
const noInterrupt = async () => {};

test("a running job whose worker exited is stored as failed", async () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "task-dead", status: "running", pid: exitedPid() });

  const reaped = await reconcileJobLiveness(workspace, { interruptTurn: noInterrupt });

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
