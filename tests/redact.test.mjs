import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run, stopTestBrokers } from "./helpers.mjs";
import { redactSecrets } from "../plugins/agent/scripts/lib/redact.mjs";
import {
  listJobs,
  readJobFile,
  resolveJobFile,
  resolveJobsDir,
  resolveStateDir,
  takeJobRequest,
  upsertJob,
  writeJobFile
} from "../plugins/agent/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "agent", "scripts", "codex-companion.mjs");

after(stopTestBrokers);

function filesUnder(dir) {
  return fs.readdirSync(dir, { recursive: true }).map((name) => path.join(dir, String(name)));
}

test("redactSecrets replaces credential values and keeps surrounding text", () => {
  assert.equal(redactSecrets("use token=abc123def to log in"), "use token=[redacted] to log in");
  assert.equal(redactSecrets('password: "hunter two"'), "password: [redacted]");
  assert.equal(redactSecrets("Authorization: Bearer abcdefgh12345678"), "Authorization: Bearer [redacted]");
  assert.equal(redactSecrets("key sk-proj-ABCDEFGHIJKLMNOPQRSTUV end"), "key [redacted] end");
  assert.equal(redactSecrets("ghp_0123456789abcdefghijABCDEFGHIJ"), "[redacted]");
  assert.equal(redactSecrets("AKIAABCDEFGHIJKLMNOP"), "[redacted]");
  assert.equal(redactSecrets("Fix the flaky login test"), "Fix the flaky login test");
});

test("job records keep the request out of the record and redact summaries", () => {
  const workspace = makeTempDir();
  writeJobFile(workspace, "task-1", {
    id: "task-1",
    status: "queued",
    summary: "deploy with api_key=s3cr3tvalue",
    errorMessage: "auth failed for Bearer abcdefgh12345678",
    request: { prompt: "the private prompt" }
  });

  const record = readJobFile(resolveJobFile(workspace, "task-1"));
  assert.equal("request" in record, false);
  assert.equal(record.summary, "deploy with api_key=[redacted]");
  assert.equal(record.errorMessage, "auth failed for Bearer [redacted]");
  assert.deepEqual(takeJobRequest(workspace, "task-1"), { prompt: "the private prompt" });
  assert.equal(takeJobRequest(workspace, "task-1"), null);
});

test("a finished job leaves no request file", () => {
  const workspace = makeTempDir();
  writeJobFile(workspace, "task-2", { id: "task-2", status: "queued", request: { prompt: "p" } });
  const requestFile = path.join(resolveJobsDir(workspace), "task-2.request.json");
  assert.equal(fs.existsSync(requestFile), true);

  writeJobFile(workspace, "task-2", { id: "task-2", status: "failed", errorMessage: "could not start" });

  assert.equal(fs.existsSync(requestFile), false);
});

test("a stored prompt in an older job record is moved out on listing", () => {
  const workspace = makeTempDir();
  const jobFile = resolveJobFile(workspace, "task-old");
  fs.writeFileSync(jobFile, JSON.stringify({ id: "task-old", status: "completed", request: { prompt: "old prompt" } }));

  assert.equal(listJobs(workspace).length, 1);

  assert.equal(fs.readFileSync(jobFile, "utf8").includes("old prompt"), false);
  assert.equal(fs.existsSync(jobFile.replace(/\.json$/, ".request.json")), false);
});

test("a background task leaves its prompt nowhere in the job records", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "secret-marker-7731 investigate"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);
  const waited = run("node", [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "15000", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(JSON.parse(waited.stdout).job.status, "completed");

  // Logs record Codex's own output, which can quote the prompt; job records and request
  // files must not hold it.
  const records = filesUnder(resolveStateDir(repo)).filter((file) => file.endsWith(".json"));
  assert.notEqual(records.length, 0);
  for (const file of records) {
    assert.equal(fs.readFileSync(file, "utf8").includes("secret-marker-7731"), false, file);
  }
});

test("state directories are private to their owner", { skip: process.platform === "win32" && "POSIX modes" }, () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "task-mode", status: "queued" });
  const stateDir = resolveStateDir(workspace);
  assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(stateDir, "jobs")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(resolveJobFile(workspace, "task-mode")).mode & 0o777, 0o600);
});
