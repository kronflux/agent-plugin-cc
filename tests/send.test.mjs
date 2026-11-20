import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { readJobFile, resolveJobFile } from "../plugins/agent/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "agent", "scripts", "codex-companion.mjs");

function makeRepo(behavior) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return { repo, binDir, env: buildEnv(binDir) };
}

function fakeState(binDir) {
  const file = path.join(binDir, "fake-codex-state.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
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

async function startRunningTask(ctx) {
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "long job"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);
  const jobFile = resolveJobFile(ctx.repo, jobId);
  const turnId = await waitUntil(() => readJobFile(jobFile).turnId, 15000);
  assert.ok(turnId, "the turn did not start");
  return { jobId, jobFile, turnId };
}

test("send steers the running turn and reports it only after Codex confirms the message", async () => {
  const ctx = makeRepo("interruptible-slow-task");
  const { jobId, turnId } = await startRunningTask(ctx);

  const result = run("node", [SCRIPT, "send", jobId, "stop", "and", "summarize"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Codex received the message in the running turn of ${jobId}`));
  const [steer] = fakeState(ctx.binDir).steers;
  assert.equal(steer.expectedTurnId, turnId);
  assert.equal(steer.text, "stop and summarize");
  assert.match(steer.clientUserMessageId, /^msg-/);
});

test("send keeps the message as typed when it arrives as one argument string", async () => {
  const ctx = makeRepo("interruptible-slow-task");
  const { jobId } = await startRunningTask(ctx);

  // process.execPath runs Node without a shell, which would strip the quotes on Windows.
  const result = run(process.execPath, [SCRIPT, "send", `--timeout-ms 20000 ${jobId} don't touch "the" tests --now`], {
    cwd: ctx.repo,
    env: ctx.env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fakeState(ctx.binDir).steers[0].text, `don't touch "the" tests --now`);
});

test("send reports an accepted message that Codex has not confirmed yet", async () => {
  const ctx = makeRepo("steer-no-item");
  const { jobId } = await startRunningTask(ctx);

  const result = run("node", [SCRIPT, "send", "--timeout-ms", "1500", jobId, "check", "this"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /accepted the message .* had not confirmed it after 2 s/);
});

test("send retries a rejected steer once and then fails with Codex's error", async () => {
  const ctx = makeRepo("steer-rejected");
  const { jobId } = await startRunningTask(ctx);

  const result = run("node", [SCRIPT, "send", jobId, "change", "course"], { cwd: ctx.repo, env: ctx.env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Codex rejected the message for .*: expected active turn id .* does not match the active turn/);
  assert.equal(fakeState(ctx.binDir).steerAttempts, 2);
});

test("send continues the thread with a new turn when Codex says the turn has ended", async () => {
  const ctx = makeRepo("steer-turn-ended");
  const { jobId } = await startRunningTask(ctx);

  const result = run("node", [SCRIPT, "send", "--json", jobId, "one", "more", "thing"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "started");
  assert.match(payload.newJobId, /^task-/);
  assert.equal(fakeState(ctx.binDir).steerAttempts, 1);
});

test("send to a finished job starts a new turn on its thread", async () => {
  const ctx = makeRepo();
  const first = run("node", [SCRIPT, "task", "--json", "first pass"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(first.status, 0, first.stderr);
  const { jobId, threadId } = JSON.parse(first.stdout);

  const result = run("node", [SCRIPT, "send", "--json", jobId, "follow", "up"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "started");
  assert.equal(payload.threadId, threadId);
  const turn = await waitUntil(() => {
    const last = fakeState(ctx.binDir).lastTurnStart;
    return last?.prompt === "follow up" ? last : null;
  }, 15000);
  assert.ok(turn, "the new turn did not start");
  assert.equal(turn.threadId, threadId);
});

test("send refuses jobs that are not tasks and unknown job ids", () => {
  const ctx = makeRepo();
  const unknown = run("node", [SCRIPT, "send", "task-missing", "hello"], { cwd: ctx.repo, env: ctx.env });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /No job task-missing was found/);

  fs.writeFileSync(path.join(ctx.repo, "README.md"), "changed\n");
  const review = run("node", [SCRIPT, "review", "--json"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(review.status, 0, review.stderr);
  const status = JSON.parse(run("node", [SCRIPT, "status", "--json"], { cwd: ctx.repo, env: ctx.env }).stdout);
  const reviewJob = [...(status.running ?? []), ...(status.recent ?? []), status.latestFinished].find((job) => job?.jobClass === "review");
  assert.ok(reviewJob, JSON.stringify(status));
  const refused = run("node", [SCRIPT, "send", reviewJob.id, "hello"], { cwd: ctx.repo, env: ctx.env });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /is a review job\. Messages can be sent only to task jobs/);
});

test("result --wait exits 75 while the job runs and prints the result once it finishes", async () => {
  const ctx = makeRepo("interruptible-slow-task");
  const { jobId } = await startRunningTask(ctx);

  const early = run("node", [SCRIPT, "result", jobId, "--wait", "--timeout-ms", "500"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(early.status, 75, early.stderr);
  assert.match(early.stdout, new RegExp(`Job ${jobId} is still running after 1 s\. Run the same command again`));

  const done = run("node", [SCRIPT, "result", jobId, "--wait", "--timeout-ms", "20000"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /Handled the requested task/);
});

test("the rescue agent's task call keeps option-like text after -- as the prompt", () => {
  const ctx = makeRepo();
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "--write", "--", "fix --model handling"], {
    cwd: ctx.repo,
    env: ctx.env
  });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);
  const done = run("node", [SCRIPT, "result", jobId, "--wait", "--timeout-ms", "20000"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(done.status, 0, done.stderr);
  assert.equal(fakeState(ctx.binDir).lastTurnStart.prompt, "fix --model handling");
});

test("send starts a new turn with a message the turn ended without applying", async () => {
  const ctx = makeRepo("steer-no-item");
  const { jobId, turnId } = await startRunningTask(ctx);

  const result = run("node", [SCRIPT, "send", "--json", jobId, "apply", "this", "later"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "started");
  assert.equal(payload.reason, "unapplied");
  assert.notEqual(payload.newJobId, jobId);
  const turn = await waitUntil(() => {
    const last = fakeState(ctx.binDir).lastTurnStart;
    return last?.prompt === "apply this later" ? last : null;
  }, 20000);
  assert.ok(turn, "the follow-up turn did not start");
  assert.notEqual(turn.turnId, turnId);
});

test("cancel names a job that has already finished", () => {
  const ctx = makeRepo();
  const done = run("node", [SCRIPT, "task", "--json", "quick"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(done.status, 0, done.stderr);
  const { jobId } = JSON.parse(done.stdout);

  const cancelled = run("node", [SCRIPT, "cancel", jobId], { cwd: ctx.repo, env: ctx.env });

  assert.notEqual(cancelled.status, 0);
  assert.match(cancelled.stderr, new RegExp(`Job ${jobId} has already completed, so there is nothing to cancel\.`));
});
