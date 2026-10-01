import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import {
  getConfig,
  listJobs,
  markJobCancelled,
  readJobFile,
  removeJob,
  resolveJobFile,
  resolveJobsDir,
  resolveStateDir,
  upsertJob,
  writeJobFile
} from "../plugins/agent/scripts/lib/state.mjs";

const STATE_MODULE = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "agent", "scripts", "lib", "state.mjs")
).href;

// Runs `body` in a separate Node process with `upsertJob` in scope and `workspace` bound.
function runStateProcess(workspace, body) {
  const source = `import { upsertJob } from ${JSON.stringify(STATE_MODULE)};\nconst workspace = ${JSON.stringify(workspace)};\n${body}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`state process exited ${code}: ${stderr}`))));
  });
}

test("concurrent writers keep every job record intact", async () => {
  const workspace = makeTempDir();
  const writers = [];
  for (let writer = 0; writer < 8; writer += 1) {
    writers.push(
      runStateProcess(
        workspace,
        `for (let i = 0; i < 25; i += 1) upsertJob(workspace, { id: "job-${writer}-" + i, status: "queued" });`
      )
    );
  }
  for (let worker = 0; worker < 4; worker += 1) {
    writers.push(
      runStateProcess(
        workspace,
        `for (let i = 0; i < 50; i += 1) upsertJob(workspace, { id: "progress-${worker}", status: "running", phase: "step-" + i });`
      )
    );
  }
  await Promise.all(writers);

  const jobsDir = resolveJobsDir(workspace);
  const records = fs.readdirSync(jobsDir).filter((name) => name.endsWith(".json"));
  assert.equal(records.length, 204);
  for (const name of records) {
    JSON.parse(fs.readFileSync(path.join(jobsDir, name), "utf8"));
  }
  const ids = new Set(listJobs(workspace).map((job) => job.id));
  for (let writer = 0; writer < 8; writer += 1) {
    for (let i = 0; i < 25; i += 1) {
      assert.equal(ids.has(`job-${writer}-${i}`), true, `job-${writer}-${i} missing`);
    }
  }
  assert.equal(fs.readdirSync(jobsDir).some((name) => name.endsWith(".tmp")), false);
});

test("listing jobs during continuous writes never returns an empty list", async () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "steady", status: "running" });
  const stopFile = path.join(workspace, "stop");
  const writer = runStateProcess(
    workspace,
    `import fs from "node:fs";\nfor (let i = 0; !fs.existsSync(${JSON.stringify(stopFile)}); i += 1) upsertJob(workspace, { id: "steady", phase: "step-" + i });`
  );

  try {
    for (let read = 0; read < 10000; read += 1) {
      assert.equal(listJobs(workspace).length, 1, `read ${read} returned no job`);
    }
  } finally {
    fs.writeFileSync(stopFile, "");
    await writer;
  }
});

test("pruning removes only the oldest finished jobs", () => {
  const workspace = makeTempDir();
  for (let index = 0; index < 60; index += 1) {
    const jobId = `done-${String(index).padStart(2, "0")}`;
    const logFile = path.join(resolveJobsDir(workspace), `${jobId}.log`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, "log\n");
    fs.writeFileSync(
      resolveJobFile(workspace, jobId),
      JSON.stringify({ id: jobId, status: "completed", logFile, updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() })
    );
  }
  for (const jobId of ["active-a", "active-b", "active-c"]) {
    fs.writeFileSync(
      resolveJobFile(workspace, jobId),
      JSON.stringify({ id: jobId, status: "running", updatedAt: "2020-01-01T00:00:00.000Z" })
    );
  }

  upsertJob(workspace, { id: "new-job", status: "queued" });

  const ids = new Set(listJobs(workspace).map((job) => job.id));
  for (const jobId of ["active-a", "active-b", "active-c", "new-job"]) {
    assert.equal(ids.has(jobId), true, `${jobId} was pruned`);
  }
  const finished = [...ids].filter((id) => id.startsWith("done-")).sort();
  assert.equal(finished.length, 50);
  assert.equal(finished[0], "done-10");
  assert.equal(fs.existsSync(path.join(resolveJobsDir(workspace), "done-09.log")), false);
  assert.equal(fs.existsSync(path.join(resolveJobsDir(workspace), "done-10.log")), true);
});

test("a cancelled job stays cancelled when its worker writes afterwards", () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "task-1", status: "running", pid: 4242 });
  markJobCancelled(workspace, "task-1");
  upsertJob(workspace, { id: "task-1", status: "completed", phase: "done" });
  writeJobFile(workspace, "task-1", { id: "task-1", status: "failed", phase: "failed" });

  const [listed] = listJobs(workspace);
  assert.equal(listed.status, "cancelled");
  assert.equal(listed.pid, null);
  assert.equal(readJobFile(resolveJobFile(workspace, "task-1")).status, "cancelled");
});

test("a removed active job is not written again", () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "task-2", status: "running", sessionId: "s1" });
  removeJob(workspace, { id: "task-2", status: "running" });
  assert.equal(upsertJob(workspace, { id: "task-2", phase: "late progress" }), null);
  writeJobFile(workspace, "task-2", { id: "task-2", status: "completed" });
  assert.deepEqual(listJobs(workspace), []);
  assert.equal(fs.existsSync(path.join(resolveJobsDir(workspace), "task-2.json")), false);
});

test("pruning deletes removal markers older than an hour", () => {
  const workspace = makeTempDir();
  const jobsDir = resolveJobsDir(workspace);
  fs.mkdirSync(jobsDir, { recursive: true });
  const oldMarker = path.join(jobsDir, "old.removed");
  const recentMarker = path.join(jobsDir, "recent.removed");
  fs.writeFileSync(oldMarker, "");
  fs.writeFileSync(recentMarker, "");
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(oldMarker, twoHoursAgo, twoHoursAgo);

  upsertJob(workspace, { id: "trigger", status: "queued" });

  assert.equal(fs.existsSync(oldMarker), false);
  assert.equal(fs.existsSync(recentMarker), true);
});

test("job listings omit result fields that the full record keeps", () => {
  const workspace = makeTempDir();
  writeJobFile(workspace, "task-3", {
    id: "task-3",
    status: "completed",
    result: { text: "answer" },
    rendered: "answer"
  });

  const [listed] = listJobs(workspace);
  assert.equal("result" in listed, false);
  assert.equal("rendered" in listed, false);
  assert.equal(readJobFile(resolveJobFile(workspace, "task-3")).rendered, "answer");
});

test("a legacy state.json index becomes job files and a config file", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "jobs", "legacy-1.json"),
    JSON.stringify({ id: "legacy-1", status: "running", result: { text: "full" } })
  );
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    JSON.stringify({
      version: 1,
      config: { stopReviewGate: true },
      jobs: [
        { id: "legacy-1", status: "completed", summary: "one" },
        { id: "legacy-2", status: "failed", summary: "two" },
        { id: "legacy-3", status: "running", summary: "three" }
      ]
    })
  );

  const jobs = listJobs(workspace);

  assert.deepEqual(jobs.map((job) => job.id).sort(), ["legacy-1", "legacy-2", "legacy-3"]);
  assert.equal(jobs.find((job) => job.id === "legacy-1").status, "completed");
  assert.equal(readJobFile(resolveJobFile(workspace, "legacy-1")).result.text, "full");
  assert.equal(getConfig(workspace).stopReviewGate, true);
  assert.equal(fs.existsSync(path.join(stateDir, "state.json")), false);
  assert.equal(fs.existsSync(path.join(stateDir, "state.json.migrated")), true);
});
