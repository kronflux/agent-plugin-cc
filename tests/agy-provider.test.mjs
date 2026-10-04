import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { installFakeAgy, readFakeAgyState } from "./fake-agy-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { isProcessAlive } from "../plugins/agent/scripts/lib/process.mjs";
import { listJobs } from "../plugins/agent/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGY = path.join(ROOT, "plugins", "agent", "scripts", "agy-companion.mjs");
const COMPANION = path.join(ROOT, "plugins", "agent", "scripts", "codex-companion.mjs");

function makeRepo(behavior) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeAgy(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const sep = process.platform === "win32" ? ";" : ":";
  return { repo, binDir, env: { ...process.env, PATH: `${binDir}${sep}${process.env.PATH}` } };
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

function job(repo, jobId) {
  return listJobs(repo).find((candidate) => candidate.id === jobId);
}

function startBackground(ctx, args) {
  const launched = run("node", [AGY, "task", "--background", "--json", ...args], { cwd: ctx.repo, env: ctx.env });
  assert.equal(launched.status, 0, launched.stderr);
  return JSON.parse(launched.stdout).jobId;
}

test("a background agy task completes and result prints its response", async () => {
  const ctx = makeRepo();
  const jobId = startBackground(ctx, ["say", "hello"]);

  assert.ok(await waitUntil(() => job(ctx.repo, jobId)?.status === "completed", 20000), JSON.stringify(job(ctx.repo, jobId)));
  const result = run("node", [COMPANION, "result", jobId], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^reply: say hello$/m);
  assert.match(result.stdout, /Antigravity session ID: conv-1\nResume in Antigravity: agy --conversation conv-1/);

  const [agyRun] = readFakeAgyState(ctx.binDir).runs;
  assert.deepEqual(agyRun.args.slice(0, 5), ["--input-format", "stream-json", "--output-format", "stream-json", "--print="]);
  assert.match(agyRun.args.join(" "), /--print-timeout \d+s/);
  assert.match(agyRun.args.join(" "), /--mode plan --sandbox/);
  assert.equal(job(ctx.repo, jobId).provider, "agy");
});

test("write tasks keep the terminal sandbox but leave plan mode", () => {
  const ctx = makeRepo();
  const result = run("node", [AGY, "task", "--write", "--json", "edit", "it"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 0, result.stderr);
  const args = readFakeAgyState(ctx.binDir).runs[0].args;
  assert.ok(args.includes("--sandbox"));
  assert.ok(!args.includes("--mode"));
});

test("send to a running agy job writes one more input line to the same process", async () => {
  const ctx = makeRepo("slow");
  const jobId = startBackground(ctx, ["first"]);
  assert.ok(await waitUntil(() => job(ctx.repo, jobId)?.threadId, 20000), "the conversation did not start");

  const sent = run("node", [COMPANION, "send", jobId, "second", "message"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(sent.status, 0, sent.stderr);
  assert.match(sent.stdout, new RegExp(`received the message in the running turn of ${jobId}`));
  assert.ok(await waitUntil(() => job(ctx.repo, jobId)?.status === "completed", 30000));
  const runs = readFakeAgyState(ctx.binDir).runs;
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].inputs, ["first", "second message"]);
  const result = run("node", [COMPANION, "result", jobId], { cwd: ctx.repo, env: ctx.env });
  assert.match(result.stdout, /^reply: first\n\nreply: second message$/m);
  assert.match(sent.stdout, /^Antigravity received the message/);
});

test("a turn's answer is its last agent message", () => {
  const ctx = makeRepo("two-messages");
  const result = run("node", [AGY, "task", "--json", "answer"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).rawOutput, "reply: answer");
});

test("send to a finished agy job resumes its conversation in a new process", async () => {
  const ctx = makeRepo();
  const first = run("node", [AGY, "task", "--json", "first"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(first.status, 0, first.stderr);
  const { jobId } = JSON.parse(first.stdout);

  const sent = run("node", [COMPANION, "send", "--json", jobId, "follow", "up"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(sent.status, 0, sent.stderr);
  const payload = JSON.parse(sent.stdout);
  assert.equal(payload.status, "started");
  assert.equal(payload.threadId, "conv-1");
  assert.ok(await waitUntil(() => job(ctx.repo, payload.newJobId)?.status === "completed", 20000));
  const runs = readFakeAgyState(ctx.binDir).runs;
  assert.equal(runs.length, 2);
  assert.equal(runs[1].args[runs[1].args.indexOf("--conversation") + 1], "conv-1");
  assert.deepEqual(runs[1].inputs, ["follow up"]);
});

test("cancel stops a running agy job and its agy process", async () => {
  const ctx = makeRepo("hang");
  const jobId = startBackground(ctx, ["wait", "forever"]);
  const agyPid = await waitUntil(() => readFakeAgyState(ctx.binDir).runs[0]?.pid, 20000);
  assert.ok(agyPid, "agy did not start");

  const cancelled = run("node", [COMPANION, "cancel", jobId, "--json"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(job(ctx.repo, jobId).status, "cancelled");
  assert.ok(await waitUntil(() => !isProcessAlive(agyPid), 10000), "the agy process kept running");
});

test("an agy review returns the structured findings", () => {
  const ctx = makeRepo();
  fs.writeFileSync(path.join(ctx.repo, "README.md"), "changed\n");
  const result = run("node", [AGY, "review"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# Antigravity Review/m);
  assert.match(result.stdout, /No material issues found by the fake agy\./);
  const args = readFakeAgyState(ctx.binDir).runs[0].args;
  assert.ok(args.includes("--json-schema"));
  assert.match(args.join(" "), /--mode plan --sandbox/);
});

test("setup reports sign-in from the model list", () => {
  const ready = makeRepo();
  const ok = JSON.parse(run("node", [AGY, "setup", "--json"], { cwd: ready.repo, env: ready.env }).stdout);
  assert.equal(ok.ready, true);
  assert.deepEqual(ok.models.map((model) => model.id), ["fake-model-high", "fake-model-low"]);

  const out = makeRepo("models-fail");
  const failed = JSON.parse(run("node", [AGY, "setup", "--json"], { cwd: out.repo, env: out.env }).stdout);
  assert.equal(failed.ready, false);
  assert.match(failed.login.detail, /not signed in/);
});

test("agy rejects an effort it does not know before starting", () => {
  const ctx = makeRepo();
  const result = run("node", [AGY, "task", "--effort", "xhigh", "do it"], { cwd: ctx.repo, env: ctx.env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /agy does not support reasoning effort "xhigh"\. Use one of: low, medium, high/);
  assert.equal(readFakeAgyState(ctx.binDir).runs.length, 0);
});

test("status shows an agy job's conversation and resume command", async () => {
  const ctx = makeRepo();
  const jobId = startBackground(ctx, ["hi"]);
  assert.ok(await waitUntil(() => job(ctx.repo, jobId)?.status === "completed", 20000));
  const status = run("node", [COMPANION, "status", jobId], { cwd: ctx.repo, env: ctx.env });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Antigravity session ID: conv-1/);
  assert.match(status.stdout, /Resume in Antigravity: agy --conversation conv-1/);
});
