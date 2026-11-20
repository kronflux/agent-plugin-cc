import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { installFakeAgy, readFakeAgyState } from "./fake-agy-fixture.mjs";
import { initGitRepo, makeTempDir, run, waitUntil } from "./helpers.mjs";
import { isProcessAlive } from "../plugins/agent/scripts/lib/process.mjs";
import { runAgyTurn } from "../plugins/agent/scripts/providers/agy/runtime.mjs";
import { readStoredJob } from "../plugins/agent/scripts/lib/job-control.mjs";
import { listJobs } from "../plugins/agent/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGY = path.join(ROOT, "plugins", "agent", "scripts", "agy-companion.mjs");
const COMPANION = path.join(ROOT, "plugins", "agent", "scripts", "codex-companion.mjs");

// Stops, by id, each fake agy process of this test that is still alive; every id in the state
// file belongs to a process the test's own fake agy started.
function stopFakeAgyProcesses(binDir) {
  for (const pid of readFakeAgyState(binDir).pids ?? []) {
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid);
      } catch {
        // It exited in the meantime.
      }
    }
  }
}

function makeRepo(behavior, t) {
  let binDir = null;
  // After hooks run in the order they are registered, so the processes stop before their
  // folders are removed.
  if (behavior === "hang" || behavior === "slow") {
    t.after(() => stopFakeAgyProcesses(binDir));
  }
  binDir = makeTempDir(t);
  const repo = makeTempDir(t);
  installFakeAgy(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const sep = process.platform === "win32" ? ";" : ":";
  return { repo, binDir, env: { ...process.env, PATH: `${binDir}${sep}${process.env.PATH}` } };
}

function job(repo, jobId) {
  return listJobs(repo).find((candidate) => candidate.id === jobId);
}

function startBackground(ctx, args) {
  const launched = run("node", [AGY, "task", "--background", "--json", ...args], { cwd: ctx.repo, env: ctx.env });
  assert.equal(launched.status, 0, launched.stderr);
  return JSON.parse(launched.stdout).jobId;
}

test("a background agy task completes and result prints its response", async (t) => {
  const ctx = makeRepo(undefined, t);
  const jobId = startBackground(ctx, ["say", "hello"]);

  assert.ok(await waitUntil(() => job(ctx.repo, jobId)?.status === "completed", { timeoutMs: 20000 }), JSON.stringify(job(ctx.repo, jobId)));
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

test("write tasks keep the terminal sandbox but leave plan mode", (t) => {
  const ctx = makeRepo(undefined, t);
  const result = run("node", [AGY, "task", "--write", "--json", "edit", "it"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 0, result.stderr);
  const args = readFakeAgyState(ctx.binDir).runs[0].args;
  assert.ok(args.includes("--sandbox"));
  assert.ok(!args.includes("--mode"));
});

test("send to a running agy job writes one more input line to the same process", async (t) => {
  const ctx = makeRepo("slow", t);
  const jobId = startBackground(ctx, ["first"]);
  assert.ok(await waitUntil(() => job(ctx.repo, jobId)?.threadId, { timeoutMs: 20000 }), "the conversation did not start");

  const sent = run("node", [COMPANION, "send", jobId, "second", "message"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(sent.status, 0, sent.stderr);
  // The reply names the provider at the start of the output.
  assert.match(sent.stdout, /^Antigravity received the message/);
  // The reply names the job whose running turn took the message.
  assert.match(sent.stdout, new RegExp(`received the message in the running turn of ${jobId}`));
  assert.ok(await waitUntil(() => job(ctx.repo, jobId)?.status === "completed", { timeoutMs: 30000 }));
  const runs = readFakeAgyState(ctx.binDir).runs;
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].inputs, ["first", "second message"]);
  const result = run("node", [COMPANION, "result", jobId], { cwd: ctx.repo, env: ctx.env });
  assert.match(result.stdout, /^reply: first\n\nreply: second message$/m);
});

test("a turn's answer is its last agent message", (t) => {
  const ctx = makeRepo("two-messages", t);
  const result = run("node", [AGY, "task", "--json", "answer"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).rawOutput, "reply: answer");
});

test("send to a finished agy job resumes its conversation in a new process", async (t) => {
  const ctx = makeRepo(undefined, t);
  const first = run("node", [AGY, "task", "--json", "first"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(first.status, 0, first.stderr);
  const { jobId } = JSON.parse(first.stdout);

  const sent = run("node", [COMPANION, "send", "--json", jobId, "follow", "up"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(sent.status, 0, sent.stderr);
  const payload = JSON.parse(sent.stdout);
  assert.equal(payload.status, "started");
  assert.equal(payload.threadId, "conv-1");
  assert.ok(await waitUntil(() => job(ctx.repo, payload.newJobId)?.status === "completed", { timeoutMs: 20000 }));
  const runs = readFakeAgyState(ctx.binDir).runs;
  assert.equal(runs.length, 2);
  assert.equal(runs[1].args[runs[1].args.indexOf("--conversation") + 1], "conv-1");
  assert.deepEqual(runs[1].inputs, ["follow up"]);
});

test("cancel stops a running agy job and its agy process", async (t) => {
  const ctx = makeRepo("hang", t);
  const jobId = startBackground(ctx, ["wait", "forever"]);
  const agyPid = await waitUntil(() => readFakeAgyState(ctx.binDir).runs[0]?.pid, { timeoutMs: 20000 });
  assert.ok(agyPid, "agy did not start");

  const cancelled = run("node", [COMPANION, "cancel", jobId, "--json"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(job(ctx.repo, jobId).status, "cancelled");
  assert.ok(await waitUntil(() => !isProcessAlive(agyPid), { timeoutMs: 10000 }), "the agy process kept running");
});

test("an agy review returns the structured findings", (t) => {
  const ctx = makeRepo(undefined, t);
  fs.writeFileSync(path.join(ctx.repo, "README.md"), "changed\n");
  const result = run("node", [AGY, "review"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# Antigravity Review/m);
  assert.match(result.stdout, /No material issues found by the fake agy\./);
  const args = readFakeAgyState(ctx.binDir).runs[0].args;
  assert.ok(args.includes("--json-schema"));
  assert.match(args.join(" "), /--mode plan --sandbox/);
});

test("setup reports sign-in from the model list", (t) => {
  const ready = makeRepo(undefined, t);
  const ok = JSON.parse(run("node", [AGY, "setup", "--json"], { cwd: ready.repo, env: ready.env, check: true }).stdout);
  assert.equal(ok.ready, true);
  assert.deepEqual(ok.models.map((model) => model.id), ["fake-model-high", "fake-model-low"]);

  const out = makeRepo("models-fail", t);
  const failed = JSON.parse(run("node", [AGY, "setup", "--json"], { cwd: out.repo, env: out.env, check: true }).stdout);
  assert.equal(failed.ready, false);
  assert.match(failed.login.detail, /not signed in/);
});

test("agy accepts the efforts its help lists and rejects others before starting", (t) => {
  const ctx = makeRepo(undefined, t);
  const rejected = run("node", [AGY, "task", "--effort", "max", "do it"], { cwd: ctx.repo, env: ctx.env });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /agy does not support reasoning effort "max"\. Use one of: low, medium, high, xhigh/);
  assert.equal(readFakeAgyState(ctx.binDir).runs.length, 0);

  const accepted = run("node", [AGY, "task", "--effort", "xhigh", "do it"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(readFakeAgyState(ctx.binDir).runs[0].args.join(" "), /--effort xhigh/);
});

test("status shows an agy job's conversation and resume command", async (t) => {
  const ctx = makeRepo(undefined, t);
  const jobId = startBackground(ctx, ["hi"]);
  assert.ok(await waitUntil(() => job(ctx.repo, jobId)?.status === "completed", { timeoutMs: 20000 }));
  const status = run("node", [COMPANION, "status", jobId], { cwd: ctx.repo, env: ctx.env });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Antigravity session ID: conv-1/);
  assert.match(status.stdout, /Resume in Antigravity: agy --conversation conv-1/);
});

// The full stored record of a finished job, with its result; null while the job runs.
function jobEnded(repo, jobId) {
  const current = job(repo, jobId);
  return current && ["completed", "failed", "cancelled"].includes(current.status) ? readStoredJob(repo, jobId) : null;
}

test("an agy that exits before reading its prompt fails the job with a message", async (t) => {
  const ctx = makeRepo("exit-before-stdin", t);
  // A prompt larger than a pipe buffer keeps the write pending until agy is gone on every platform.
  const launched = run("node", [AGY, "task", "--background", "--json"], { cwd: ctx.repo, env: ctx.env, input: "x".repeat(2 * 1024 * 1024) });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);

  const ended = await waitUntil(() => jobEnded(ctx.repo, jobId), { timeoutMs: 20000, describe: "the exit-before-stdin job ending" });

  assert.equal(ended.status, "failed", JSON.stringify(ended));
  // A failed turn stores its message as the result's failureMessage; a thrown error as errorMessage.
  assert.match(ended.errorMessage ?? ended.result?.failureMessage ?? "", /agy (exited|closed its input)/);
  assert.ok(ended.completedAt, JSON.stringify(ended));
});

test("a result written just before agy exits is kept", async (t) => {
  const ctx = makeRepo("result-then-exit", t);
  const jobId = startBackground(ctx, ["answer", "fast"]);

  const ended = await waitUntil(() => jobEnded(ctx.repo, jobId), { timeoutMs: 20000, describe: "the result-then-exit job ending" });

  assert.equal(ended.status, "completed", JSON.stringify(ended));
  const result = run("node", [COMPANION, "result", jobId], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /early-exit-answer-7f3/);
});

test("a failed prompt turn fails the job even when a later turn succeeds", async (t) => {
  const ctx = makeRepo("fail-first-turn", t);
  const jobId = startBackground(ctx, ["first"]);
  await waitUntil(() => job(ctx.repo, jobId)?.status === "running" && job(ctx.repo, jobId)?.threadId, {
    timeoutMs: 20000,
    describe: "the fail-first-turn job running with a conversation"
  });

  const sent = run("node", [COMPANION, "send", jobId, "second"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(sent.status, 0, sent.stderr);

  const ended = await waitUntil(() => jobEnded(ctx.repo, jobId), { timeoutMs: 20000, describe: "the fail-first-turn job ending" });
  assert.equal(ended.status, "failed", JSON.stringify(ended));
  assert.deepEqual(readFakeAgyState(ctx.binDir).runs[0].inputs, ["first", "second"]);
  assert.match(ended.result?.rawOutput ?? "", /^reply: second$/m);
});

test("text of an unfinished response does not prefix the next turn", async (t) => {
  const ctx = makeRepo("result-before-done", t);
  const jobId = startBackground(ctx, ["first"]);
  await waitUntil(() => job(ctx.repo, jobId)?.status === "running" && job(ctx.repo, jobId)?.threadId, {
    timeoutMs: 20000,
    describe: "the result-before-done job running with a conversation"
  });

  const sent = run("node", [COMPANION, "send", jobId, "second"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(sent.status, 0, sent.stderr);

  const ended = await waitUntil(() => jobEnded(ctx.repo, jobId), { timeoutMs: 20000, describe: "the result-before-done job ending" });
  assert.equal(ended.status, "completed", JSON.stringify(ended));
  const output = ended.result?.rawOutput ?? "";
  assert.match(output, /^reply: second$/m);
  assert.doesNotMatch(output, /^partial-reply/m);
});

test("a clean agy exit leaves no delayed kill", async (t) => {
  const ctx = makeRepo(undefined, t);
  const terminated = [];
  const result = await runAgyTurn(ctx.repo, {
    prompt: "hi",
    env: ctx.env,
    terminate: (pid) => {
      terminated.push(pid);
      return { attempted: false, delivered: false, method: null };
    }
  });
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.deepEqual(result.turnOutcomes, [{ turnId: "turn-1", status: "SUCCESS" }]);

  await new Promise((resolve) => setTimeout(resolve, 5500));
  assert.equal(terminated.length, 0);
});

test("a second resume of a conversation is refused while the first is queued", async (t) => {
  const ctx = makeRepo("slow", t);
  const env = { ...ctx.env, CODEX_COMPANION_SESSION_ID: "session-resume-twice" };
  const first = run("node", [AGY, "task", "--json", "start"], { cwd: ctx.repo, env, check: true });
  assert.equal(JSON.parse(first.stdout).threadId, "conv-1");

  const resumed = run("node", [AGY, "task", "--background", "--json", "--resume-last", "again"], { cwd: ctx.repo, env, check: true });
  const second = run("node", [AGY, "task", "--background", "--json", "--resume-last", "once", "more"], { cwd: ctx.repo, env });

  assert.equal(second.status, 1, second.stdout);
  assert.match(second.stderr, /still running/);
  const { jobId } = JSON.parse(resumed.stdout);
  await waitUntil(() => jobEnded(ctx.repo, jobId), { timeoutMs: 20000, describe: "the first resume ending" });
});

test("agy review accepts --background and runs in the foreground", (t) => {
  const ctx = makeRepo(undefined, t);
  fs.writeFileSync(path.join(ctx.repo, "README.md"), "changed\n");

  const result = run("node", [AGY, "review", "--background"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No material issues found by the fake agy\./);
});

test("a failed agy review keeps its failure message in the summary", (t) => {
  const ctx = makeRepo("fail-first-turn", t);
  fs.writeFileSync(path.join(ctx.repo, "README.md"), "changed\n");

  const result = run("node", [AGY, "review"], { cwd: ctx.repo, env: ctx.env });

  assert.notEqual(result.status, 0, result.stdout);
  const review = listJobs(ctx.repo).find((candidate) => candidate.jobClass === "review");
  assert.ok(review, "no review job was recorded");
  assert.match(review.summary ?? "", /status ERROR/, JSON.stringify(review));
});
