import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { installFakeAgy, readFakeAgyState } from "./fake-agy-fixture.mjs";
import { initGitRepo, makeTempDir, run, stopOwnedProcess, stopOwnedProcesses, waitUntil } from "./helpers.mjs";
import { isProcessAlive, readProcessIdentity } from "../plugins/agent/scripts/lib/process.mjs";
import * as agyRuntime from "../plugins/agent/scripts/providers/agy/runtime.mjs";
import { runAgyTurn } from "../plugins/agent/scripts/providers/agy/runtime.mjs";
import { readStoredJob } from "../plugins/agent/scripts/lib/job-control.mjs";
import { getConfig, listJobs, upsertJob } from "../plugins/agent/scripts/lib/state.mjs";
import { executeAgyTask } from "../plugins/agent/scripts/providers/agy/commands/task.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGY = path.join(ROOT, "plugins", "agent", "scripts", "agy-companion.mjs");
const COMPANION = path.join(ROOT, "plugins", "agent", "scripts", "codex-companion.mjs");
const NEUTRAL = path.join(ROOT, "plugins", "agent", "scripts", "agent-companion.mjs");

// The recorded identities of the fake agy processes of this test, once every listed process
// that still runs has recorded its own (or 10 s have passed).
async function fakeAgyIdentities(binDir, pids) {
  const identities = () => readFakeAgyState(binDir).identities ?? [];
  await waitUntil(() => pids.every((pid) => !isProcessAlive(pid) || identities().some((entry) => entry.pid === pid)), {
    timeoutMs: 10000,
    describe: "the fake agy processes to record their identities"
  }).catch(() => {});
  return identities();
}

// Stops, through stopOwnedProcesses, each fake agy process of this test, and the child it
// started, that recorded its identity.
async function stopFakeAgyProcesses(binDir) {
  const state = readFakeAgyState(binDir);
  await stopOwnedProcesses(await fakeAgyIdentities(binDir, [...(state.pids ?? []), ...(state.childPids ?? [])]));
}

function makeRepo(behavior, t, fakeOptions = {}) {
  let binDir = null;
  // After hooks run in the order they are registered, so the processes stop before their
  // folders are removed.
  if (["hang", "slow", "silent", "chatty-silent"].includes(behavior)) {
    t.after(() => stopFakeAgyProcesses(binDir));
  }
  binDir = makeTempDir(t);
  const repo = makeTempDir(t);
  installFakeAgy(binDir, behavior, fakeOptions);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  // The home folder holds the Antigravity settings file that names agy's saved model.
  const home = makeTempDir(t);
  writeAgySettings(home, { model: "Fake Model (High)" });
  const sep = process.platform === "win32" ? ";" : ":";
  return { repo, binDir, home, env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${binDir}${sep}${process.env.PATH}` } };
}

function writeAgySettings(home, settings) {
  const folder = path.join(home, ".gemini", "antigravity-cli");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "settings.json"), JSON.stringify(settings));
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
  const result = run("node", [NEUTRAL, "result", jobId], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^reply: say hello$/m);
  assert.match(result.stdout, /Antigravity session ID: conv-1\nResume in Antigravity: agy --conversation conv-1/);

  const [agyRun] = readFakeAgyState(ctx.binDir).runs;
  assert.deepEqual(agyRun.args.slice(0, 5), ["--input-format", "stream-json", "--output-format", "stream-json", "--print="]);
  assert.match(agyRun.args.join(" "), /--print-timeout \d+s/);
  assert.match(agyRun.args.join(" "), /--sandbox --settings \S+read-only-settings\.json/);
  assert.equal(job(ctx.repo, jobId).provider, "agy");
});

test("write tasks keep the terminal sandbox without the read-only settings", (t) => {
  const ctx = makeRepo(undefined, t);
  const result = run("node", [AGY, "task", "--write", "--json", "edit", "it"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 0, result.stderr);
  const args = readFakeAgyState(ctx.binDir).runs[0].args;
  assert.ok(args.includes("--sandbox"));
  assert.ok(!args.includes("--mode"));
  assert.ok(!args.includes("--settings"));
});

// A stand-in child process whose stdin records every write.
function recordingChild() {
  const writes = [];
  return { writes, stdin: { write: (chunk) => writes.push(String(chunk)), on: () => {} } };
}

const TRANSPORT_FLAGS = ["--input-format", "stream-json", "--output-format", "stream-json", "--print="];

test("a turn sends its prompt as one stdin line and never in the arguments", async (t) => {
  const prompt = "Summarise one-stdin-line-marker-51c in two words.";
  assert.equal(typeof agyRuntime.encodeAgyPromptLine, "function", "encodeAgyPromptLine is not exported");
  assert.equal(typeof agyRuntime.writeAgyPrompt, "function", "writeAgyPrompt is not exported");
  assert.equal(agyRuntime.encodeAgyPromptLine(prompt), `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`);
  const child = recordingChild();
  agyRuntime.writeAgyPrompt(child, prompt);
  assert.throws(() => agyRuntime.writeAgyPrompt(child, "again"), /already/);
  assert.deepEqual(child.writes, [agyRuntime.encodeAgyPromptLine(prompt)]);

  const ctx = makeRepo(undefined, t);
  const result = await runAgyTurn(ctx.repo, { prompt, env: ctx.env });

  assert.equal(result.status, 0, JSON.stringify(result));
  const [agyRun] = readFakeAgyState(ctx.binDir).runs;
  assert.equal(agyRun.inputs.length, 1);
  assert.ok(agyRun.inputs[0].startsWith(prompt), agyRun.inputs[0]);
  assert.ok(!agyRun.args.some((arg) => arg.includes("one-stdin-line-marker-51c")), agyRun.args.join(" "));
  assert.equal(agyRun.stdinClosed, true);
});

test("normal, read-only, review and continuation turns use the same argv and stdin route and write once", async (t) => {
  const ctx = makeRepo(undefined, t);
  const env = { ...ctx.env, AGENT_PLUGIN_SESSION_ID: "session-same-route" };
  assert.equal(run("node", [AGY, "task", "read", "only"], { cwd: ctx.repo, env }).status, 0);
  assert.equal(run("node", [AGY, "task", "--write", "edit", "it"], { cwd: ctx.repo, env }).status, 0);
  assert.equal(run("node", [AGY, "task", "--resume-thread", "conv-1", "go", "on"], { cwd: ctx.repo, env }).status, 0);
  fs.writeFileSync(path.join(ctx.repo, "README.md"), "changed\n");
  assert.equal(run("node", [AGY, "review"], { cwd: ctx.repo, env }).status, 0);

  const runs = readFakeAgyState(ctx.binDir).runs;
  assert.equal(runs.length, 4);
  for (const agyRun of runs) {
    assert.deepEqual(agyRun.args.slice(0, 5), TRANSPORT_FLAGS);
    assert.match(agyRun.args.join(" "), /--print-timeout \d+s/);
    assert.equal(agyRun.inputs.length, 1, JSON.stringify(agyRun.inputs));
    assert.equal(agyRun.stdinClosed, true);
    assert.equal(agyRun.args.includes("--mode"), false, agyRun.args.join(" "));
  }
  const [readOnly, write, continued, review] = runs;
  const settingsOf = (args) => (args.includes("--settings") ? JSON.parse(fs.readFileSync(args[args.indexOf("--settings") + 1], "utf8")) : null);
  const denyWrites = { permissions: { deny: ["write_file(*)", "command(*)"] } };
  assert.ok(readOnly.args.includes("--sandbox"));
  assert.deepEqual(settingsOf(readOnly.args), denyWrites);
  assert.ok(write.args.includes("--sandbox"));
  assert.equal(settingsOf(write.args), null);
  assert.equal(continued.args[continued.args.indexOf("--conversation") + 1], "conv-1");
  assert.deepEqual(settingsOf(continued.args), denyWrites);
  assert.ok(review.args.includes("--json-schema"));
  assert.deepEqual(settingsOf(review.args), denyWrites);
});

test("a running agy job takes no second line", async (t) => {
  // The turn outlasts the start of the send command on a loaded machine.
  const ctx = makeRepo("slow", t, { slowMs: 8000 });
  const jobId = startBackground(ctx, ["first"]);
  assert.ok(await waitUntil(() => job(ctx.repo, jobId)?.threadId, { timeoutMs: 20000 }), "the conversation did not start");

  const sent = run("node", [NEUTRAL, "send", jobId, "second", "message"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(sent.status, 0, sent.stderr);
  const newJobId = sent.stdout.match(/ended before Antigravity applied the message, so it started a new turn on the same thread as (\S+)\./)?.[1];
  assert.ok(newJobId, sent.stdout);
  assert.ok(await waitUntil(() => job(ctx.repo, newJobId)?.status === "completed", { timeoutMs: 30000 }));
  const runs = readFakeAgyState(ctx.binDir).runs;
  assert.equal(runs.length, 2);
  assert.equal(runs[0].inputs.length, 1);
  assert.ok(runs[0].inputs[0].startsWith("first"), runs[0].inputs[0]);
  assert.equal(runs[1].args[runs[1].args.indexOf("--conversation") + 1], "conv-1");
  assert.equal(runs[1].inputs.length, 1);
  assert.ok(runs[1].inputs[0].startsWith("second message"), runs[1].inputs[0]);
});

test("a 40,000-character prompt reaches agy through stdin", (t) => {
  const ctx = makeRepo(undefined, t);
  const prompt = `start-${"y".repeat(40000)}-end`;

  const result = run("node", [AGY, "task", "--json"], { cwd: ctx.repo, env: ctx.env, input: prompt });

  assert.equal(result.status, 0, result.stderr);
  const [agyRun] = readFakeAgyState(ctx.binDir).runs;
  assert.equal(agyRun.inputs.length, 1);
  assert.ok(agyRun.inputs[0].startsWith(prompt), `${agyRun.inputs[0].length} characters arrived`);
  assert.ok(agyRun.args.every((arg) => arg.length < 1000), "the prompt was passed as an argument");
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

  const sent = run("node", [NEUTRAL, "send", "--json", jobId, "follow", "up"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(sent.status, 0, sent.stderr);
  const payload = JSON.parse(sent.stdout);
  assert.equal(payload.status, "started");
  assert.equal(payload.threadId, "conv-1");
  assert.ok(await waitUntil(() => job(ctx.repo, payload.newJobId)?.status === "completed", { timeoutMs: 20000 }));
  const runs = readFakeAgyState(ctx.binDir).runs;
  assert.equal(runs.length, 2);
  assert.equal(runs[1].args[runs[1].args.indexOf("--conversation") + 1], "conv-1");
  assert.equal(runs[1].inputs.length, 1);
  assert.equal(runs[1].inputs[0].split("\n")[0], "follow up");
});

test("send to a finished agy job keeps its model and effort", async (t) => {
  const ctx = makeRepo(undefined, t);
  const first = run("node", [AGY, "task", "--json", "--model", "fake-model-low", "--effort", "low", "first"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(first.status, 0, first.stderr);
  const { jobId } = JSON.parse(first.stdout);

  const sent = run("node", [NEUTRAL, "send", "--json", jobId, "more"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(sent.status, 0, sent.stderr);
  const { newJobId } = JSON.parse(sent.stdout);
  assert.ok(await waitUntil(() => job(ctx.repo, newJobId)?.status === "completed", { timeoutMs: 20000 }));
  const runs = readFakeAgyState(ctx.binDir).runs;
  assert.equal(runs.length, 2);
  assert.match(runs[1].args.join(" "), /--model fake-model-low --effort low/);
  assert.equal(job(ctx.repo, newJobId).model, "fake-model-low");
  assert.equal(job(ctx.repo, newJobId).effort, "low");
});

test("cancel stops a running agy job and its agy process", async (t) => {
  const ctx = makeRepo("hang", t);
  const jobId = startBackground(ctx, ["wait", "forever"]);
  const agyPid = await waitUntil(() => readFakeAgyState(ctx.binDir).runs[0]?.pid, { timeoutMs: 20000 });
  assert.ok(agyPid, "agy did not start");

  const cancelled = run("node", [NEUTRAL, "cancel", jobId, "--json"], { cwd: ctx.repo, env: ctx.env });

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
  assert.match(args.join(" "), /--sandbox --settings \S+read-only-settings\.json/);
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
  const status = run("node", [NEUTRAL, "status", jobId], { cwd: ctx.repo, env: ctx.env });
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
  const result = run("node", [NEUTRAL, "result", jobId], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /early-exit-answer-7f3/);
});

// Runs a foreground agy task and returns its stored record and the status output for it.
function runEndedTask(ctx, words) {
  const result = run("node", [AGY, "task", "--json", ...words], { cwd: ctx.repo, env: ctx.env });
  const record = latestAgyJob(ctx.repo);
  assert.ok(record, `no job was recorded: ${result.stderr}`);
  const status = run("node", [NEUTRAL, "status", record.id], { cwd: ctx.repo, env: ctx.env });
  return { result, stored: readStoredJob(ctx.repo, record.id), status };
}

test("a denied permission fails the job with the action and display name", (t) => {
  const ctx = makeRepo("denied", t);

  const { result, stored, status } = runEndedTask(ctx, ["run", "ping"]);

  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(stored.status, "failed", JSON.stringify(stored));
  assert.equal(stored.result?.failureMessage, "Antigravity was denied permission for command (Bash).");
  assert.match(status.stdout, /Antigravity was denied permission for command \(Bash\)\./);
});

test("a result without agent text fails", (t) => {
  const ctx = makeRepo("no-agent-text", t);

  const { result, stored } = runEndedTask(ctx, ["say", "something"]);

  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(stored.status, "failed", JSON.stringify(stored));
  assert.equal(stored.result?.failureMessage, "Antigravity ended the turn without an answer.");
});

test("an exit without a result fails", (t) => {
  const ctx = makeRepo("exit-without-result", t);

  const { result, stored } = runEndedTask(ctx, ["say", "something"]);

  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(stored.status, "failed", JSON.stringify(stored));
  assert.equal(stored.result?.failureMessage, "Antigravity ended the turn without an answer.");
});

test("a review path outside the working folder is passed with --add-dir or refused", async (t) => {
  const ctx = makeRepo(undefined, t);
  const outside = makeTempDir(t);
  const outsideFile = path.join(outside, "notes.md");
  fs.writeFileSync(outsideFile, "outside\n");
  fs.mkdirSync(path.join(ctx.repo, "src"));
  fs.writeFileSync(path.join(ctx.repo, "src", "app.js"), "inside\n");

  // A path outside the working folder adds its folder; a path inside adds nothing.
  assert.equal(typeof agyRuntime.outsideFolders, "function", "outsideFolders is not exported");
  const addDirs = agyRuntime.outsideFolders(ctx.repo, [outsideFile, outside, path.join(ctx.repo, "src", "app.js")]);
  assert.deepEqual(addDirs, [fs.realpathSync.native(outside)]);
  const turn = await runAgyTurn(ctx.repo, { prompt: "read the notes", env: ctx.env, addDirs });
  assert.equal(turn.status, 0, JSON.stringify(turn));
  const [agyRun] = readFakeAgyState(ctx.binDir).runs;
  assert.equal(agyRun.args.filter((arg) => arg === "--add-dir").length, 1, agyRun.args.join(" "));
  assert.equal(agyRun.args[agyRun.args.indexOf("--add-dir") + 1], fs.realpathSync.native(outside));

  // A review --path inside the review root is read in place.
  const inside = run("node", [AGY, "review", "--target", "project", "--path", "src"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(inside.status, 0, inside.stderr);
  assert.equal(readFakeAgyState(ctx.binDir).runs[1].args.includes("--add-dir"), false);

  // A review --path outside the review root is refused before a job exists or agy starts.
  const before = listJobs(ctx.repo).length;
  const refused = run("node", [AGY, "review", "--target", "project", "--path", outsideFile], { cwd: ctx.repo, env: ctx.env });
  assert.equal(refused.status, 1, refused.stdout);
  assert.ok(refused.stderr.includes(outsideFile), refused.stderr);
  assert.equal(readFakeAgyState(ctx.binDir).runs.length, 2);
  assert.equal(listJobs(ctx.repo).length, before);
});

const DELEGATE_LINE = "Do this work yourself. Do not start subagents, swarms, workflows or scheduled tasks.";
const READ_ONLY_LINE =
  "This is a read-only task. Do not use any tool that creates, edits or deletes a file, anywhere, including plan files, and do not run commands.";

test("every agy prompt ends with the delegate line and a read-only prompt also with the read-only line", (t) => {
  const ctx = makeRepo(undefined, t);
  assert.equal(run("node", [AGY, "task", "look", "around"], { cwd: ctx.repo, env: ctx.env }).status, 0);
  assert.equal(run("node", [AGY, "task", "--write", "change", "it"], { cwd: ctx.repo, env: ctx.env }).status, 0);
  fs.writeFileSync(path.join(ctx.repo, "README.md"), "changed\n");
  assert.equal(run("node", [AGY, "review"], { cwd: ctx.repo, env: ctx.env }).status, 0);

  const [readOnly, write, review] = readFakeAgyState(ctx.binDir).runs.map((agyRun) => agyRun.inputs[0]);
  assert.ok(readOnly.startsWith("look around"), readOnly);
  assert.ok(readOnly.endsWith(`\n\n${DELEGATE_LINE}\n${READ_ONLY_LINE}`), readOnly);
  assert.ok(write.startsWith("change it"), write);
  assert.ok(write.endsWith(`\n\n${DELEGATE_LINE}`), write);
  assert.ok(!write.includes(READ_ONLY_LINE), write);
  assert.ok(review.endsWith(`\n\n${DELEGATE_LINE}\n${READ_ONLY_LINE}`), review.slice(-400));
});

test("an agy process that emits nothing is stopped and the job fails", { timeout: 30000 }, async (t) => {
  const ctx = makeRepo("silent", t);
  const started = Date.now();

  const result = await runAgyTurn(ctx.repo, { prompt: "say nothing", env: { ...ctx.env, AGENT_PLUGIN_AGY_SILENCE_MS: "1000" }, timeoutMs: 120000 });

  assert.equal(result.status, 1, JSON.stringify(result));
  assert.equal(result.error?.message, "Antigravity stopped responding.");
  assert.ok(Date.now() - started < 15000, `the silence stop took ${Date.now() - started} ms`);
  const [agyRun] = readFakeAgyState(ctx.binDir).runs;
  assert.ok(await waitUntil(() => !isProcessAlive(agyRun.pid), { timeoutMs: 10000 }), "the silent agy process kept running");
});

// Starts a silent fake agy with a child and waits until the fake has recorded that child.
async function silentTurnWithChild(t, extra = {}) {
  const ctx = makeRepo("silent", t, { spawnChild: true });
  const turn = runAgyTurn(ctx.repo, { prompt: "say nothing", env: { ...ctx.env, AGENT_PLUGIN_AGY_SILENCE_MS: "3000" }, timeoutMs: 120000, ...extra });
  const childPid = await waitUntil(() => readFakeAgyState(ctx.binDir).childPids?.[0], { timeoutMs: 10000, describe: "the fake's child" });
  return { ctx, turn, childPid };
}

test("the silence stop removes a verified live root and its child", { timeout: 60000 }, async (t) => {
  const { ctx, turn, childPid } = await silentTurnWithChild(t);
  const fakePid = readFakeAgyState(ctx.binDir).runs[0].pid;

  const result = await turn;

  assert.equal(result.error?.message, "Antigravity stopped responding.");
  assert.equal(result.stop?.result, "stopped", JSON.stringify(result.stop ?? null));
  const root = result.stop.identity;
  assert.ok(root && Number.isInteger(root.pid) && root.startToken, JSON.stringify(root));
  if (process.platform !== "win32") {
    assert.equal(result.stop.expectedGroupId, root.pid, "the agy child does not lead its own process group");
  }
  for (const pid of new Set([root.pid, fakePid, childPid])) {
    assert.ok(await waitUntil(() => !isProcessAlive(pid), { timeoutMs: 10000 }), `process ${pid} kept running`);
  }
});

// The same token moved by one unit: Windows creation ticks, or the start ticks after the Linux
// boot id.
function shiftedToken(token) {
  const match = /^(.*?)(\d+)$/.exec(String(token));
  return `${match[1]}${BigInt(match[2]) + 1n}`;
}

test("the silence stop refuses a reused identity", { timeout: 60000 }, async (t) => {
  // The runtime reads the root's identity right after the spawn, while it holds the root, so the
  // true identity seen here is the root's.
  let rootIdentity = null;
  const { ctx, turn, childPid } = await silentTurnWithChild(t, {
    readIdentity: async (pid, options) => {
      const identity = await readProcessIdentity(pid, options);
      if (identity.state !== "present") {
        return identity;
      }
      rootIdentity ??= { pid, startToken: identity.startToken };
      return { ...identity, startToken: shiftedToken(identity.startToken) };
    }
  });
  const fakePid = readFakeAgyState(ctx.binDir).runs[0].pid;

  const result = await turn;

  assert.equal(result.error?.message, "Antigravity stopped responding.");
  assert.equal(result.stop?.result, "mismatch", JSON.stringify(result.stop ?? null));
  const root = result.stop.identity.pid;
  assert.ok(isProcessAlive(root), "the root was stopped although its identity did not match");
  assert.ok(isProcessAlive(childPid), "the child was stopped although the root's identity did not match");
  // The test stops what it started: the root through the identity the runtime read, the fake and
  // its child through the identities the fake recorded.
  const recorded = (await fakeAgyIdentities(ctx.binDir, [fakePid, childPid])).filter((entry) => entry.pid !== rootIdentity?.pid);
  await stopOwnedProcesses([rootIdentity, ...recorded]);
  for (const pid of new Set([root, fakePid, childPid])) {
    assert.ok(await waitUntil(() => !isProcessAlive(pid), { timeoutMs: 10000 }), `process ${pid} kept running`);
  }
});

test("an agy process that writes only non-event output is stopped as silent", { timeout: 30000 }, async (t) => {
  const ctx = makeRepo("chatty-silent", t);
  const started = Date.now();

  const result = await runAgyTurn(ctx.repo, { prompt: "say nothing", env: { ...ctx.env, AGENT_PLUGIN_AGY_SILENCE_MS: "1500" }, timeoutMs: 120000 });

  assert.equal(result.error?.message, "Antigravity stopped responding.");
  assert.equal(result.stop?.result, "stopped", JSON.stringify(result.stop ?? null));
  assert.ok(Date.now() - started < 15000, `the silence stop took ${Date.now() - started} ms`);
  const [agyRun] = readFakeAgyState(ctx.binDir).runs;
  assert.ok(await waitUntil(() => !isProcessAlive(agyRun.pid), { timeoutMs: 10000 }), "the agy process kept running");
});

test("a missing identity is read again before the silence stop", { timeout: 60000 }, async (t) => {
  let calls = 0;
  const { ctx, turn, childPid } = await silentTurnWithChild(t, {
    readIdentity: async (pid, options) => (++calls === 1 ? { state: "unknown", reason: "query timed out" } : readProcessIdentity(pid, options))
  });
  const fakePid = readFakeAgyState(ctx.binDir).runs[0].pid;

  const result = await turn;

  assert.equal(result.error?.message, "Antigravity stopped responding.");
  assert.equal(result.stop?.result, "stopped", JSON.stringify(result.stop ?? null));
  assert.ok(calls >= 2, `the identity was read ${calls} time(s)`);
  for (const pid of new Set([result.stop.identity.pid, fakePid, childPid])) {
    assert.ok(await waitUntil(() => !isProcessAlive(pid), { timeoutMs: 10000 }), `process ${pid} kept running`);
  }
});

test("a silence stop without an identity says the process may still run", { timeout: 60000 }, async (t) => {
  const { ctx, turn } = await silentTurnWithChild(t, { readIdentity: async () => ({ state: "unknown", reason: "query timed out" }) });
  const fakePid = readFakeAgyState(ctx.binDir).runs[0].pid;

  const result = await turn;

  assert.equal(result.stop?.result, "not-attempted", JSON.stringify(result.stop ?? null));
  assert.match(result.error?.message ?? "", /^Antigravity stopped responding. The agy process \d+ could not be identified, so it was not stopped and may still be running.$/);
  assert.ok(isProcessAlive(fakePid), "a process without an identity was stopped");
});

test("a second signal during a pending stop does not end the owner before agy is stopped", {
  timeout: 60000,
  skip: process.platform === "win32" ? "POSIX process groups and signals" : false
}, async (t) => {
  const ctx = makeRepo("silent", t, { spawnChild: true });
  const identityDelayMs = 4000;
  const owner = path.join(makeTempDir(t), "owner.mjs");
  const runtimeUrl = new URL("../plugins/agent/scripts/providers/agy/runtime.mjs", import.meta.url).href;
  const processUrl = new URL("../plugins/agent/scripts/lib/process.mjs", import.meta.url).href;
  fs.writeFileSync(
    owner,
    [
      `import { runAgyTurn } from ${JSON.stringify(runtimeUrl)};`,
      `import { readProcessIdentity } from ${JSON.stringify(processUrl)};`,
      `const readIdentity = async (pid, options) => { await new Promise((resolve) => setTimeout(resolve, ${identityDelayMs})); return readProcessIdentity(pid, options); };`,
      "const result = await runAgyTurn(process.argv[2], { prompt: 'say nothing', timeoutMs: 120000, readIdentity });",
      "process.stdout.write(JSON.stringify({ stop: result.stop, error: result.error }) + '\\n');"
    ].join("\n")
  );
  const { spawn } = await import("node:child_process");
  const startedAt = Date.now();
  const child = spawn(process.execPath, [owner, ctx.repo], { env: { ...ctx.env, AGENT_PLUGIN_AGY_SILENCE_MS: "1000" }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => stopOwnedProcess(child));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, at: Date.now() })));
  const childPid = await waitUntil(() => readFakeAgyState(ctx.binDir).childPids?.[0], { timeoutMs: 10000, describe: "the fake's child" });
  const rootPid = readFakeAgyState(ctx.binDir).runs[0].pid;

  // The watchdog fires after 1 s and its stop waits for the delayed identity; two signals arrive
  // while that stop is pending. They go through the held handle, whose exit has not been seen.
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, startedAt + 2000 - Date.now())));
  child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 200));
  child.kill("SIGTERM");
  const exit = await exited;

  assert.equal(exit.signal, "SIGTERM", JSON.stringify(exit));
  assert.ok(exit.at - startedAt >= identityDelayMs - 200, `the owner ended after ${exit.at - startedAt} ms, before its stop`);
  for (const pid of [rootPid, childPid]) {
    assert.ok(await waitUntil(() => !isProcessAlive(pid), { timeoutMs: 2000 }), `process ${pid} kept running after the owner ended`);
  }
});

test("a result with an empty response fails even after agent text", (t) => {
  const outcome = agyRuntime.classifyAgyOutcome(
    [
      { type: "init", conversationId: "c-1" },
      { type: "text", delta: "I will start by reading the files.", done: false },
      { type: "text", delta: "\n", done: true },
      { type: "result", status: "SUCCESS", response: "", structuredOutput: null, conversationId: "c-1", turns: 1, deniedActions: [] }
    ],
    { code: 0, signal: null }
  );
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error, "Antigravity ended the turn without an answer.");

  const ctx = makeRepo("opening-then-empty", t);
  const { result, stored } = runEndedTask(ctx, ["read", "the", "files"]);
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(stored.status, "failed", JSON.stringify(stored));
  assert.equal(stored.result?.failureMessage, "Antigravity ended the turn without an answer.");
});

const TRACE_DIR = path.join(ROOT, "tests", "fixtures", "agy-trace");

// The recorded traces with the outcome each real run had, from the folder's expected.json.
function recordedTraces() {
  const expected = JSON.parse(fs.readFileSync(path.join(TRACE_DIR, "expected.json"), "utf8"));
  return Object.entries(expected).map(([name, record]) => ({
    name,
    record,
    lines: fs.readFileSync(path.join(TRACE_DIR, `${name}.jsonl`), "utf8").split(/\r?\n/).filter(Boolean)
  }));
}

test("each recorded trace parses to the recorded turn count, conversation id and outcome", () => {
  assert.ok(fs.existsSync(path.join(TRACE_DIR, "expected.json")), "no recorded traces");
  const traces = recordedTraces();
  assert.ok(traces.length >= 9, `${traces.length} traces`);
  for (const { name, record, lines } of traces) {
    const adapter = agyRuntime.createAgyEventAdapter();
    for (const line of lines) {
      adapter.push(line);
    }
    const outcome = adapter.outcome({ code: record.exitCode, signal: null, conversationId: record.continued ? record.conversationId : null });
    assert.equal(outcome.conversationId, record.conversationId, name);
    assert.equal(outcome.turns, record.turns, name);
    assert.equal(outcome.status, record.status, name);
    assert.equal(outcome.error, record.error ?? null, name);
    assert.deepEqual(outcome.json, record.json ?? null, name);
    if (record.status === "answer") {
      assert.ok(outcome.text.length > 0, name);
    }
  }
});

// The sorted keys of an event's payload, the shape the traces and the fake are compared by.
function payloadKeys(event) {
  return Object.keys(event.init ?? event.step_update ?? event.result ?? {}).sort().join(",");
}

// One key set per event kind of a stream: init, each step type and state, and result.
function eventShapes(lines) {
  const shapes = new Map();
  for (const line of lines) {
    const event = JSON.parse(line);
    const step = event.step_update;
    const kind = step ? `${step.step_type}/${step.state}` : event.event;
    shapes.set(kind, new Set([...(shapes.get(kind) ?? []), payloadKeys(event)]));
  }
  return shapes;
}

test("the fake reports version 1.5.10 and the event fields of the recorded traces", async (t) => {
  const ctx = makeRepo(undefined, t);
  const version = run("node", [path.join(ctx.binDir, "agy"), "--version"], { env: ctx.env });
  assert.equal(version.stdout.trim(), "1.5.10");

  const schema = path.join(ctx.repo, "count.schema.json");
  fs.writeFileSync(schema, JSON.stringify({ type: "object", properties: { count: { type: "integer" } }, required: ["count"] }));
  const first = await runAgyTurn(ctx.repo, { prompt: "first", env: ctx.env });
  const second = await runAgyTurn(ctx.repo, { prompt: "second", env: ctx.env, conversationId: first.conversationId, jsonSchema: schema });
  assert.equal(first.outcome.turns, 1);
  assert.equal(second.outcome.turns, 2);
  assert.equal(second.conversationId, first.conversationId);

  const recorded = new Map();
  for (const { lines } of recordedTraces()) {
    for (const [kind, keys] of eventShapes(lines)) {
      recorded.set(kind, new Set([...(recorded.get(kind) ?? []), ...keys]));
    }
  }
  const runs = readFakeAgyState(ctx.binDir).runs;
  const fakeLines = runs.flatMap((agyRun) => agyRun.output ?? []);
  assert.ok(fakeLines.length > 0, "the fake recorded no output");
  for (const [kind, keys] of eventShapes(fakeLines)) {
    for (const key of keys) {
      assert.ok(recorded.get(kind)?.has(key), `${kind} {${key}} is not a recorded shape`);
    }
  }
  const init = JSON.parse(fakeLines[0]).init;
  assert.equal(init.permission_mode, "request-review");
  const steps = fakeLines.map((line) => JSON.parse(line).step_update).filter(Boolean);
  const secondRunSteps = (runs[1].output ?? []).map((line) => JSON.parse(line).step_update).filter(Boolean);
  assert.ok(secondRunSteps[0].step_index > 0, "step indexes restart in a continued conversation");
  assert.ok(steps.filter((step) => step.step_type === "agent_response" && step.state === "ACTIVE").length > 2, "one text chunk per reply");
  assert.ok(secondRunSteps.some((step) => step.step_type === "system_message"), "no system step on the continued turn");
  assert.ok(secondRunSteps.some((step) => step.step_type === "finish"), "no finish step on the schema turn");
});

test("replayed init and user_input events of a resumed turn leave its outcome unchanged", async (t) => {
  const ctx = makeRepo("replayed-events", t);
  const first = await runAgyTurn(ctx.repo, { prompt: "first", env: ctx.env });
  const resumed = await runAgyTurn(ctx.repo, { prompt: "again", env: ctx.env, conversationId: first.conversationId });

  assert.equal(resumed.status, 0, JSON.stringify(resumed));
  assert.equal(resumed.outcome.turns, 2);
  assert.equal(resumed.finalMessage, "reply: again");
  const output = readFakeAgyState(ctx.binDir).runs[1].output.map((line) => JSON.parse(line));
  assert.equal(output.filter((event) => event.event === "init").length, 2);
  assert.equal(output.filter((event) => event.step_update?.step_type === "user_input").length, 2);
});

test("a clean agy exit leaves no delayed kill", async (t) => {
  const ctx = makeRepo(undefined, t);
  const terminated = [];
  const result = await runAgyTurn(ctx.repo, {
    prompt: "hi",
    env: ctx.env,
    stopProcess: async (identity) => {
      terminated.push(identity);
      return "unknown";
    }
  });
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.equal(result.outcome.status, "answer");
  assert.equal(result.outcome.turns, 1);
  assert.equal(result.stop, null);

  await new Promise((resolve) => setTimeout(resolve, 5500));
  assert.equal(terminated.length, 0);
});

test("a second resume of a conversation is refused while the first is queued", async (t) => {
  const ctx = makeRepo("slow", t);
  const env = { ...ctx.env, AGENT_PLUGIN_SESSION_ID: "session-resume-twice" };
  const first = run("node", [AGY, "task", "--json", "start"], { cwd: ctx.repo, env, check: true });
  assert.equal(JSON.parse(first.stdout).threadId, "conv-1");

  const resumed = run("node", [AGY, "task", "--background", "--json", "--resume-last", "again"], { cwd: ctx.repo, env, check: true });
  const second = run("node", [AGY, "task", "--background", "--json", "--resume-last", "once", "more"], { cwd: ctx.repo, env });

  assert.equal(second.status, 1, second.stdout);
  assert.match(second.stderr, /still running/);
  const { jobId } = JSON.parse(resumed.stdout);
  await waitUntil(() => jobEnded(ctx.repo, jobId), { timeoutMs: 20000, describe: "the first resume ending" });
});

test("agy review --background runs as a tracked background review job", async (t) => {
  const ctx = makeRepo(undefined, t);
  fs.writeFileSync(path.join(ctx.repo, "README.md"), "changed\n");

  const result = run("node", [AGY, "review", "--background"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(result.status, 0, result.stderr);
  const jobId = result.stdout.match(/started in the background as (review-\S+)\./)?.[1];
  assert.ok(jobId, result.stdout);
  const ended = await waitUntil(() => jobEnded(ctx.repo, jobId), { timeoutMs: 20000, describe: "the background review ending" });
  assert.equal(ended.status, "completed", JSON.stringify(ended));
  assert.match(ended.rendered, /No material issues found by the fake agy\./);
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

// The newest job record of the repository.
function latestAgyJob(repo) {
  return listJobs(repo).sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))[0] ?? null;
}

test("agy uses its saved default and names it in the job output", (t) => {
  const ctx = makeRepo(undefined, t);
  const result = run("node", [AGY, "task", "hi"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Model: Fake Model \(High\) \(from the Antigravity settings\)$/m);
  const [agyRun] = readFakeAgyState(ctx.binDir).runs;
  assert.equal(agyRun.args.includes("--model"), false);
  const record = latestAgyJob(ctx.repo);
  assert.equal(record.model, null);
  assert.equal(record.modelSource, "provider-default");
  assert.equal(record.providerModel, "Fake Model (High)");

  fs.rmSync(path.join(ctx.home, ".gemini"), { recursive: true, force: true });
  const unnamed = run("node", [AGY, "task", "hi"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(unnamed.status, 0, unnamed.stderr);
  assert.match(unnamed.stdout, /^Model: chosen by Antigravity$/m);
});

test("result of a background agy task names the saved model it ran on", (t) => {
  const ctx = makeRepo(undefined, t);
  const jobId = startBackground(ctx, ["investigate", "the", "build"]);
  const result = run("node", [NEUTRAL, "result", jobId, "--wait", "--timeout-ms", "20000"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^reply: investigate the build$/m);
  assert.match(result.stdout, /^Model: Fake Model \(High\) \(from the Antigravity settings\)$/m);
  assert.equal(result.stdout.match(/^Model: /gm).length, 1, result.stdout);
});

test("status labels a task job with the current command name", (t) => {
  const ctx = makeRepo(undefined, t);
  const result = run("node", [AGY, "task", "hi"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 0, result.stderr);
  const status = run("node", [NEUTRAL, "status", "--all"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, / \| completed \| delegate \| Antigravity Task/);
  assert.doesNotMatch(status.stdout, /rescue/);
});

test("agy rejects a --model its model list does not contain", (t) => {
  const ctx = makeRepo(undefined, t);
  const result = run("node", [AGY, "task", "--model", "nope", "hi"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Model "nope" is not in the Antigravity model list\. Available: fake-model-high, fake-model-low\./);
  assert.equal(readFakeAgyState(ctx.binDir).runs.length, 0);
  assert.deepEqual(listJobs(ctx.repo), []);

  const accepted = run("node", [AGY, "task", "--model", "fake-model-low", "hi"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(readFakeAgyState(ctx.binDir).runs[0].args.join(" "), /--model fake-model-low/);
  assert.equal(latestAgyJob(ctx.repo).modelSource, "explicit");
});

test("a resumed agy conversation names a changed saved model", (t) => {
  const ctx = makeRepo(undefined, t);
  const first = run("node", [AGY, "task", "first"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(first.status, 0, first.stderr);
  writeAgySettings(ctx.home, { model: "Fake Model (Low)" });

  const resumed = run("node", [AGY, "task", "--resume-last", "more"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stderr, /Antigravity's saved model changed from Fake Model \(High\) to Fake Model \(Low\) since this conversation started\./);
  assert.equal(latestAgyJob(ctx.repo).providerModel, "Fake Model (Low)");
});

test("agy rejects a suffixed model with a different --effort", (t) => {
  const ctx = makeRepo(undefined, t);
  const rejected = run("node", [AGY, "task", "--model", "fake-model-high", "--effort", "low", "hi"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(rejected.status, 1);
  assert.match(
    rejected.stderr,
    /Antigravity model fake-model-high already sets effort high; remove --effort low or choose a model without an effort suffix\./
  );
  assert.equal(readFakeAgyState(ctx.binDir).runs.length, 0);

  const matching = run("node", [AGY, "task", "--model", "fake-model-high", "--effort", "high", "hi"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(matching.status, 0, matching.stderr);
  assert.match(readFakeAgyState(ctx.binDir).runs[0].args.join(" "), /--model fake-model-high --effort high/);
});

test("agy setup stores a model and accepts --write-sandbox", (t) => {
  const ctx = makeRepo(undefined, t);
  const result = run("node", [AGY, "setup", "--model", "fake-model-low", "--write-sandbox", "danger-full-access", "--json"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const config = getConfig(ctx.repo);
  assert.deepEqual(config.models, { agy: { model: "fake-model-low", effort: null } });
  assert.equal(config.writeSandbox, "danger-full-access");
  assert.equal(report.writeSandbox, "danger-full-access");
  assert.deepEqual(report.delegation, { model: "fake-model-low", effort: null, modelSource: "setting", effortSource: "provider-default", providerModel: null });

  const cleared = run("node", [AGY, "setup", "--model", "default"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.match(cleared.stdout, /^- delegation model: Fake Model \(High\) from the Antigravity settings \(provider-default\)$/m);
  assert.match(cleared.stdout, /^- delegation effort: default \(provider-default\)$/m);

  const rejected = run("node", [AGY, "setup", "--write-sandbox", "anything"], { cwd: ctx.repo, env: ctx.env });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Unsupported write sandbox "anything"/);
});

test("an agy task uses the stored setting and returns to the provider default after setup --model default", (t) => {
  const ctx = makeRepo(undefined, t);
  assert.equal(run("node", [AGY, "setup", "--model", "fake-model-low"], { cwd: ctx.repo, env: ctx.env }).status, 0);
  const first = run("node", [AGY, "task", "one"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(first.status, 0, first.stderr);
  assert.match(readFakeAgyState(ctx.binDir).runs[0].args.join(" "), /--model fake-model-low/);
  assert.equal(latestAgyJob(ctx.repo).modelSource, "setting");

  assert.equal(run("node", [AGY, "setup", "--model", "default"], { cwd: ctx.repo, env: ctx.env }).status, 0);
  const second = run("node", [AGY, "task", "two"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFakeAgyState(ctx.binDir).runs[1].args.includes("--model"), false);
  assert.equal(latestAgyJob(ctx.repo).modelSource, "provider-default");
});

test("a follow-up with a suffixed model drops an inherited effort that conflicts with the suffix", (t) => {
  const ctx = makeRepo(undefined, t);
  const first = run("node", [AGY, "task", "--model", "fake-model-high", "--effort", "high", "first"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(first.status, 0, first.stderr);

  const resumed = run("node", [AGY, "task", "--resume-last", "--model", "fake-model-low", "more"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stderr, /^Effort high of the continued job does not apply to model fake-model-low, so it was not used\.$/m);
  const args = readFakeAgyState(ctx.binDir).runs[1].args;
  assert.match(args.join(" "), /--model fake-model-low/);
  assert.equal(args.includes("--effort"), false, args.join(" "));
  const record = latestAgyJob(ctx.repo);
  assert.equal(record.effort, null);
  assert.equal(record.effortSource, "provider-default");
});

test("an agy job records the saved model agy reads when the job runs", async (t) => {
  const ctx = makeRepo(undefined, t);
  // The settings changed after the job was queued with the model saved then.
  writeAgySettings(ctx.home, { model: "Fake Model (Low)" });
  const jobId = "task-saved-model-check";
  upsertJob(ctx.repo, { id: jobId, provider: "agy", jobClass: "task", status: "running", model: null, providerModel: "Fake Model (High)" });
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH };
  Object.assign(process.env, { HOME: ctx.env.HOME, USERPROFILE: ctx.env.USERPROFILE, PATH: ctx.env.PATH });
  let execution;
  try {
    execution = await executeAgyTask({ cwd: ctx.repo, prompt: "hi", model: null, effort: null, providerModel: "Fake Model (High)", jobId });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
  assert.match(execution.rendered, /^Model: Fake Model \(Low\) \(from the Antigravity settings\)$/m);
  assert.equal(job(ctx.repo, jobId).providerModel, "Fake Model (Low)");
});

test("agy setup warns that a model it could not check was stored unchecked", (t) => {
  const ctx = makeRepo("models-fail", t);
  const result = run("node", [AGY, "setup", "--model", "custom-model"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /^The Antigravity model list is unavailable, so "custom-model" was not checked\.$/m);
  assert.doesNotMatch(result.stdout, /Delegations now use model custom-model/);
  assert.match(result.stdout, /Stored model custom-model for delegations in .* without checking it\./);
  assert.deepEqual(getConfig(ctx.repo).models, { agy: { model: "custom-model", effort: null } });
});
