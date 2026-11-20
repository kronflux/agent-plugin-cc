import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { installFakeAgy, readFakeAgyState } from "./fake-agy-fixture.mjs";
import { initGitRepo, makeTempDir, run, stopOwnedProcess, stopOwnedProcesses, waitUntil } from "./helpers.mjs";
import { isProcessAlive, readProcessIdentity } from "../plugins/agent/scripts/lib/process.mjs";
import * as agyRuntime from "../plugins/agent/scripts/providers/agy/runtime.mjs";
import { NODE_LAUNCH_FLAGS, openStore } from "../plugins/agent/scripts/lib/store.mjs";
import { createJob as createStoreJob, readJobView } from "../plugins/agent/scripts/lib/state.mjs";
import { composeRequestText, sendToChain, UNCERTAIN_PREFIX } from "../plugins/agent/scripts/lib/mailbox.mjs";
import { reconcileStore } from "../plugins/agent/scripts/lib/job-control.mjs";
import { decideNext, requestStop } from "../plugins/agent/scripts/lib/state.mjs";
import { AGY_LOST_CONTEXT_LINE, AGY_NO_QUESTION_TOOL_LINE, createAgyDriver, formatAgyBody } from "../plugins/agent/scripts/providers/agy/driver.mjs";
import * as readonlyGuard from "../plugins/agent/scripts/providers/agy/readonly-guard.mjs";
import { augmentSchemaForQuestions, QUESTION_INSTRUCTION } from "../plugins/agent/scripts/lib/task-launch.mjs";
import { makeStoreDir, rawAll, rawExec } from "./store-fixtures.mjs";
import { createHash } from "node:crypto";
import { getConfig, resolveStateDir } from "../plugins/agent/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGY = path.join(ROOT, "plugins", "agent", "scripts", "agy-companion.mjs");

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
  let repo = null;
  // After hooks run in the order they are registered, so the processes stop before their
  // folders are removed: the workers and agy processes of the repository's store jobs, each by
  // its recorded identity, and the fake agy processes that recorded theirs.
  t.after(async () => {
    if (repo) {
      await stopJobProcesses(resolveStateDir(repo), storeJobs(repo).map((row) => row.id), binDir);
    }
  });
  if (["hang", "slow", "silent", "chatty-silent"].includes(behavior)) {
    t.after(() => stopFakeAgyProcesses(binDir));
  }
  binDir = makeTempDir(t);
  repo = makeTempDir(t);
  installFakeAgy(binDir, behavior, fakeOptions);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  // The home folder holds the Antigravity settings file that names agy's saved model.
  const home = makeTempDir(t);
  writeAgySettings(home, { model: "Fake Model (High)" });
  const sep = process.platform === "win32" ? ";" : ":";
  // A store worker runs the fake through Node, so that on Windows its root is one process, as
  // agy.exe is, rather than the cmd.exe of the batch file that the commands still use.
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: `${binDir}${sep}${process.env.PATH}`, AGENT_PLUGIN_TEST_AGY_ENTRY: path.join(binDir, "agy") };
  return { repo, binDir, home, env };
}

function writeAgySettings(home, settings) {
  const folder = path.join(home, ".gemini", "antigravity-cli");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "settings.json"), JSON.stringify(settings));
}

// The store rows of a repository's jobs, oldest first; none before the store exists.
function storeJobs(repo) {
  const stateDir = resolveStateDir(repo);
  return fs.existsSync(path.join(stateDir, "store")) ? rawAll(stateDir, "SELECT * FROM jobs ORDER BY created_at, id") : [];
}

function job(repo, jobId) {
  return storeJobs(repo).find((row) => row.id === jobId);
}

function requestOf(row) {
  return JSON.parse(row.request_json);
}

// The store row of a job once it has an end decision.
function jobEnded(repo, jobId) {
  const row = job(repo, jobId);
  return row && row.end_state !== null ? row : null;
}

function startBackground(ctx, args) {
  const launched = run("node", [AGY, "task", "--background", "--json", ...args], { cwd: ctx.repo, env: ctx.env });
  assert.equal(launched.status, 0, launched.stderr);
  return JSON.parse(launched.stdout).jobId;
}

test("a background agy task completes with its response in the store", async (t) => {
  const ctx = makeRepo(undefined, t);
  const jobId = startBackground(ctx, ["say", "hello"]);

  const ended = await waitUntil(() => jobEnded(ctx.repo, jobId), { timeoutMs: 20000, describe: "the background job ending" });
  assert.equal(ended.end_state, "completed", JSON.stringify(ended));
  assert.equal(ended.result_text, "reply: say hello");
  assert.equal(ended.thread_id, "conv-1");
  assert.equal(ended.provider, "agy");

  const [agyRun] = readFakeAgyState(ctx.binDir).runs;
  assert.deepEqual(agyRun.args.slice(0, 5), ["--input-format", "stream-json", "--output-format", "stream-json", "--print="]);
  assert.match(agyRun.args.join(" "), /--print-timeout \d+s/);
  assert.match(agyRun.args.join(" "), /--sandbox --settings \S+read-only-settings\.json/);
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

// Runs one turn on the Antigravity driver as the worker does: the spawn, the prompt, the turn's
// end, then the end of agy's input and its exit. `request` fills the job's request. `ended` is the
// driver's turn result; `outcome` is what the driver's event adapter makes of the output this run
// of the fake recorded, with the job's conversation id, as the driver classifies it.
async function driverTurn(t, ctx, { prompt, threadId = null, request = {} }) {
  const driver = createAgyDriver(null, { env: ctx.env });
  const job = { request_json: JSON.stringify({ sandbox: "read-only", ...request }), thread_id: threadId, cwd: ctx.repo, allow_questions: 0 };
  const turnCtx = { job, cwd: ctx.repo, env: ctx.env, onThread() {}, onStarted() {}, onReceipt() {} };
  const runIndex = readFakeAgyState(ctx.binDir).runs.length;
  const spawned = await driver.spawn(turnCtx);
  t.after(() => stopOwnedProcess(spawned.child));
  await driver.start(turnCtx, { text: prompt, clientId: "client-1" });
  const ended = await driver.turnEnded;
  driver.endInput();
  const exit = await spawned.exited;
  const adapter = agyRuntime.createAgyEventAdapter();
  for (const line of readFakeAgyState(ctx.binDir).runs[runIndex]?.output ?? []) {
    adapter.push(line);
  }
  return { ended, outcome: adapter.outcome({ code: exit.code, signal: exit.signal, conversationId: threadId }) };
}

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
  const { ended } = await driverTurn(t, ctx, { prompt });

  assert.equal(ended.status, "answer", JSON.stringify(ended));
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

test("a resumed agy task continues its conversation in a new process", async (t) => {
  const ctx = makeRepo(undefined, t);
  const first = run("node", [AGY, "task", "--json", "first"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(first.status, 0, first.stderr);

  const resumed = run("node", [AGY, "task", "--json", "--resume-last", "follow", "up"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(resumed.status, 0, resumed.stderr);
  const payload = JSON.parse(resumed.stdout);
  assert.equal(payload.status, "completed");
  assert.equal(job(ctx.repo, payload.jobId).continues, JSON.parse(first.stdout).jobId);
  const runs = readFakeAgyState(ctx.binDir).runs;
  assert.equal(runs.length, 2);
  assert.equal(runs[1].args[runs[1].args.indexOf("--conversation") + 1], "conv-1");
  assert.equal(runs[1].inputs.length, 1);
  assert.match(runs[1].inputs[0], /^\[message \d+\]\nfollow up\n/);
});

test("a resumed agy task keeps its model and effort", async (t) => {
  const ctx = makeRepo(undefined, t);
  const first = run("node", [AGY, "task", "--json", "--model", "fake-model-low", "--effort", "low", "first"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(first.status, 0, first.stderr);

  const resumed = run("node", [AGY, "task", "--json", "--resume-last", "more"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(resumed.status, 0, resumed.stderr);
  const runs = readFakeAgyState(ctx.binDir).runs;
  assert.equal(runs.length, 2);
  assert.match(runs[1].args.join(" "), /--model fake-model-low --effort low/);
  const successor = job(ctx.repo, JSON.parse(resumed.stdout).jobId);
  assert.equal(successor.model, "fake-model-low");
  assert.equal(requestOf(successor).effort, "low");
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

test("an agy that exits before reading its prompt fails the job with a message", async (t) => {
  const ctx = makeRepo("exit-before-stdin", t);
  // A prompt larger than a pipe buffer keeps the write pending until agy is gone on every platform.
  const launched = run("node", [AGY, "task", "--background", "--json"], { cwd: ctx.repo, env: ctx.env, input: "x".repeat(2 * 1024 * 1024) });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);

  const ended = await waitUntil(() => jobEnded(ctx.repo, jobId), { timeoutMs: 20000, describe: "the exit-before-stdin job ending" });

  assert.equal(ended.end_state, "failed", JSON.stringify(ended));
  assert.match(ended.error ?? "", /agy (exited|closed its input)|provider exited/);
});

test("a result written just before agy exits is kept", async (t) => {
  const ctx = makeRepo("result-then-exit", t);
  const jobId = startBackground(ctx, ["answer", "fast"]);

  const ended = await waitUntil(() => jobEnded(ctx.repo, jobId), { timeoutMs: 20000, describe: "the result-then-exit job ending" });

  assert.equal(ended.end_state, "completed", JSON.stringify(ended));
  assert.match(ended.result_text, /early-exit-answer-7f3/);
});

// Runs a foreground agy task and returns the command's result, the job's store row as `stored`
// and the parsed JSON reply.
function runEndedTask(ctx, words) {
  const result = run("node", [AGY, "task", "--json", ...words], { cwd: ctx.repo, env: ctx.env });
  const record = latestAgyJob(ctx.repo);
  assert.ok(record, `no job was recorded: ${result.stderr}`);
  return { result, stored: record, reply: JSON.parse(result.stdout) };
}

test("a denied permission fails the job with the action and display name", (t) => {
  const ctx = makeRepo("denied", t);

  const { result, stored, reply } = runEndedTask(ctx, ["run", "ping"]);

  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(stored.end_state, "failed", JSON.stringify(stored));
  assert.equal(stored.error, "Antigravity was denied permission for command (Bash).");
  assert.equal(reply.status, "failed");
  assert.equal(reply.error, "Antigravity was denied permission for command (Bash).");
});

test("a result without agent text fails", (t) => {
  const ctx = makeRepo("no-agent-text", t);

  const { result, stored } = runEndedTask(ctx, ["say", "something"]);

  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(stored.end_state, "failed", JSON.stringify(stored));
  assert.equal(stored.error, "Antigravity ended the turn without an answer.");
});

test("an exit without a result fails", (t) => {
  const ctx = makeRepo("exit-without-result", t);

  const { result, stored } = runEndedTask(ctx, ["say", "something"]);

  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(stored.end_state, "failed", JSON.stringify(stored));
  assert.equal(stored.error, "Antigravity ended the turn without an answer.");
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
  const { ended: turn } = await driverTurn(t, ctx, { prompt: "read the notes", request: { addDirs } });
  assert.equal(turn.status, "answer", JSON.stringify(turn));
  const [agyRun] = readFakeAgyState(ctx.binDir).runs;
  assert.equal(agyRun.args.filter((arg) => arg === "--add-dir").length, 1, agyRun.args.join(" "));
  assert.equal(agyRun.args[agyRun.args.indexOf("--add-dir") + 1], fs.realpathSync.native(outside));

  // A review --path inside the review root is read in place.
  const inside = run("node", [AGY, "review", "--target", "project", "--path", "src"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(inside.status, 0, inside.stderr);
  assert.equal(readFakeAgyState(ctx.binDir).runs[1].args.includes("--add-dir"), false);

  // A review --path outside the review root is refused before a job exists or agy starts.
  const before = storeJobs(ctx.repo).length;
  const refused = run("node", [AGY, "review", "--target", "project", "--path", outsideFile], { cwd: ctx.repo, env: ctx.env });
  assert.equal(refused.status, 1, refused.stdout);
  assert.ok(refused.stderr.includes(outsideFile), refused.stderr);
  assert.equal(readFakeAgyState(ctx.binDir).runs.length, 2);
  assert.equal(storeJobs(ctx.repo).length, before);
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
  assert.equal(stored.end_state, "failed", JSON.stringify(stored));
  assert.equal(stored.error, "Antigravity ended the turn without an answer.");
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
  const first = await driverTurn(t, ctx, { prompt: "first" });
  const second = await driverTurn(t, ctx, {
    prompt: "second",
    threadId: first.outcome.conversationId,
    request: { outputSchema: JSON.parse(fs.readFileSync(schema, "utf8")) }
  });
  assert.equal(first.outcome.turns, 1);
  assert.equal(second.outcome.turns, 2);
  assert.equal(second.outcome.conversationId, first.outcome.conversationId);

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
  const first = await driverTurn(t, ctx, { prompt: "first" });
  const resumed = await driverTurn(t, ctx, { prompt: "again", threadId: first.outcome.conversationId });

  assert.equal(resumed.ended.status, "answer", JSON.stringify(resumed.ended));
  assert.equal(resumed.outcome.turns, 2);
  assert.equal(resumed.ended.text, "reply: again");
  const output = readFakeAgyState(ctx.binDir).runs[1].output.map((line) => JSON.parse(line));
  assert.equal(output.filter((event) => event.event === "init").length, 2);
  assert.equal(output.filter((event) => event.step_update?.step_type === "user_input").length, 2);
});

test("a second resume of a conversation is refused while the first is queued", async (t) => {
  const ctx = makeRepo("slow", t);
  const env = { ...ctx.env, AGENT_PLUGIN_SESSION_ID: "session-resume-twice" };
  const first = run("node", [AGY, "task", "--json", "start"], { cwd: ctx.repo, env, check: true });
  assert.equal(JSON.parse(first.stdout).threadId, "conv-1");

  const resumed = run("node", [AGY, "task", "--background", "--json", "--resume-last", "again"], { cwd: ctx.repo, env, check: true });
  const second = run("node", [AGY, "task", "--background", "--json", "--resume-last", "once", "more"], { cwd: ctx.repo, env });

  assert.equal(second.status, 1, second.stdout);
  assert.match(second.stderr, /is (queued|running); use send/);
  const { jobId } = JSON.parse(resumed.stdout);
  await waitUntil(() => jobEnded(ctx.repo, jobId), { timeoutMs: 20000, describe: "the first resume ending" });
});

test("agy review --background runs as a background review job in the store", async (t) => {
  const ctx = makeRepo(undefined, t);
  fs.writeFileSync(path.join(ctx.repo, "README.md"), "changed\n");

  const result = run("node", [AGY, "review", "--background"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(result.status, 0, result.stderr);
  const jobId = result.stdout.match(/started in the background as (review-\S+)\./)?.[1];
  assert.ok(jobId, result.stdout);
  const ended = await waitUntil(() => jobEnded(ctx.repo, jobId), { timeoutMs: 20000, describe: "the background review ending" });
  assert.equal(ended.end_state, "completed", JSON.stringify(ended));
  assert.equal(ended.kind, "review");
  assert.equal(JSON.parse(ended.result_json).summary, "No material issues found by the fake agy.");
});

test("a failed agy review keeps its failure message", (t) => {
  const ctx = makeRepo("fail-first-turn", t);
  fs.writeFileSync(path.join(ctx.repo, "README.md"), "changed\n");

  const result = run("node", [AGY, "review"], { cwd: ctx.repo, env: ctx.env });

  assert.notEqual(result.status, 0, result.stdout);
  const review = storeJobs(ctx.repo).find((row) => row.kind === "review");
  assert.ok(review, "no review job was recorded");
  assert.equal(review.end_state, "failed");
  assert.match(review.error ?? "", /status ERROR/, JSON.stringify(review));
});

test("an agy review whose structured result is not a review ends failed", (t) => {
  const ctx = makeRepo("empty-structured-output", t);
  fs.writeFileSync(path.join(ctx.repo, "README.md"), "changed\n");

  const result = run("node", [AGY, "review"], { cwd: ctx.repo, env: ctx.env, timeout: 60000 });

  assert.notEqual(result.status, 0, result.stdout);
  const review = storeJobs(ctx.repo).find((row) => row.kind === "review");
  assert.ok(review, "no review job was recorded");
  assert.equal(review.end_state, "failed", JSON.stringify(review));
  assert.match(review.error ?? "", /unexpected review shape/, JSON.stringify(review));
});

// The newest job record of the repository.
function latestAgyJob(repo) {
  return storeJobs(repo).at(-1) ?? null;
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
  assert.equal(requestOf(record).modelSource, "provider-default");
  assert.equal(requestOf(record).providerModel, "Fake Model (High)");

  fs.rmSync(path.join(ctx.home, ".gemini"), { recursive: true, force: true });
  const unnamed = run("node", [AGY, "task", "hi"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(unnamed.status, 0, unnamed.stderr);
  assert.match(unnamed.stdout, /^Model: chosen by Antigravity$/m);
});

test("agy rejects a --model its model list does not contain", (t) => {
  const ctx = makeRepo(undefined, t);
  const result = run("node", [AGY, "task", "--model", "nope", "hi"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Model "nope" is not in the Antigravity model list\. Available: fake-model-high, fake-model-low\./);
  assert.equal(readFakeAgyState(ctx.binDir).runs.length, 0);
  assert.deepEqual(storeJobs(ctx.repo), []);

  const accepted = run("node", [AGY, "task", "--model", "fake-model-low", "hi"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(readFakeAgyState(ctx.binDir).runs[0].args.join(" "), /--model fake-model-low/);
  assert.equal(requestOf(latestAgyJob(ctx.repo)).modelSource, "explicit");
});

test("a resumed agy conversation names a changed saved model", (t) => {
  const ctx = makeRepo(undefined, t);
  const first = run("node", [AGY, "task", "first"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(first.status, 0, first.stderr);
  writeAgySettings(ctx.home, { model: "Fake Model (Low)" });

  const resumed = run("node", [AGY, "task", "--resume-last", "more"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stderr, /Antigravity's saved model changed from Fake Model \(High\) to Fake Model \(Low\) since this conversation started\./);
  assert.equal(requestOf(latestAgyJob(ctx.repo)).providerModel, "Fake Model (Low)");
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
  assert.equal(requestOf(latestAgyJob(ctx.repo)).modelSource, "setting");

  assert.equal(run("node", [AGY, "setup", "--model", "default"], { cwd: ctx.repo, env: ctx.env }).status, 0);
  const second = run("node", [AGY, "task", "two"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFakeAgyState(ctx.binDir).runs[1].args.includes("--model"), false);
  assert.equal(requestOf(latestAgyJob(ctx.repo)).modelSource, "provider-default");
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
  assert.equal(requestOf(record).effort, null);
  assert.equal(requestOf(record).effortSource, "provider-default");
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

// ---------------------------------------------------------------------------------------------
// Antigravity jobs on the job store

function withStore(stateDir, fn) {
  const store = openStore(stateDir);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

// Creates an Antigravity job in the store as the task command would, and returns its id.
function createAgyStoreJob(stateDir, cwd, { prompt = "do the work", threadId = null, request = {}, allowQuestions = false, label = null, force = false } = {}) {
  return withStore(stateDir, (store) =>
    createStoreJob(
      store,
      {
        provider: "agy",
        kind: "task",
        title: "Antigravity Task",
        prompt,
        request: {
          cwd,
          worktree: null,
          write: false,
          sandbox: "read-only",
          model: null,
          effort: null,
          modelSource: "provider-default",
          effortSource: "provider-default",
          review: null,
          outputSchema: null,
          allowQuestions,
          flags: { background: true, fresh: false },
          ...request
        },
        cwd,
        model: null,
        allowQuestions,
        foreground: false,
        threadId,
        ephemeral: false,
        runId: null,
        requester: { sessionId: "session-agy", leaderPid: null, leaderStartToken: null },
        force
      },
      { label }
    ).jobId
  );
}

function storeRow(stateDir, jobId) {
  return rawAll(stateDir, "SELECT * FROM jobs WHERE id = ?", [jobId])[0];
}

function messageRow(stateDir, messageId) {
  return rawAll(stateDir, "SELECT * FROM messages WHERE id = ?", [messageId])[0];
}

// Stops, each only by a proved identity, a job's worker and provider root (recorded in its row)
// and every fake agy process that recorded its identity.
async function stopJobProcesses(stateDir, jobIds, binDir) {
  const targets = [];
  for (const jobId of jobIds) {
    const row = storeRow(stateDir, jobId);
    if (row?.worker_pid && row.worker_start_token) {
      targets.push({ pid: row.worker_pid, startToken: row.worker_start_token });
    }
    if (row?.provider_pid && row.provider_start_token) {
      targets.push({ pid: row.provider_pid, startToken: row.provider_start_token });
    }
  }
  targets.push(...(readFakeAgyState(binDir).identities ?? []));
  await stopOwnedProcesses(targets, { tree: true });
}

// Starts the Antigravity worker for a job as the launcher would (detached on POSIX); resolves
// `exit` with its exit code and stderr.
function startAgyWorker(ctx, stateDir, jobId, env = {}) {
  const child = spawn(process.execPath, [...NODE_LAUNCH_FLAGS, AGY, "worker", "--state-dir", stateDir, "--job", jobId], {
    env: { ...ctx.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32"
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exit = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal, stderr })));
  return { child, exit, jobId, stderrSoFar: () => stderr };
}

// What a failed worker test needs to be understood afterwards: each job's row, the end of its
// log, and each worker's exit state and stderr.
function workerDiagnostics(stateDir, workers) {
  const lines = [];
  try {
    for (const row of rawAll(
      stateDir,
      "SELECT id, end_state, end_reason, error, claimed_at, started_at, exec_released_at, release_kind, stopping_cause, last_refusal, launch_attempts, worker_pid FROM jobs"
    )) {
      lines.push(`row ${JSON.stringify(row)}`);
      const logFile = path.join(stateDir, "store", "artifacts", `${row.id}.log`);
      lines.push(`log ${row.id}: ${fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").slice(-1500) : "(no log file)"}`);
    }
  } catch (error) {
    lines.push(`rows unreadable: ${error?.message ?? error}`);
  }
  for (const worker of workers) {
    lines.push(`worker of ${worker.jobId}: pid ${worker.child.pid}, exitCode ${worker.child.exitCode}, signal ${worker.child.signalCode}, stderr ${JSON.stringify(worker.stderrSoFar().slice(-800))}`);
  }
  return lines.join("\n");
}

// Runs a body with workers and processes it starts stopped (by proved identity) before the
// test's folders are removed.
async function withAgyWorkers(ctx, stateDir, body) {
  const workers = [];
  const jobIds = new Set();
  const start = (jobId, env) => {
    jobIds.add(jobId);
    const worker = startAgyWorker(ctx, stateDir, jobId, env);
    workers.push(worker);
    return worker;
  };
  try {
    return await body(start);
  } catch (error) {
    if (error && typeof error.message === "string") {
      error.message += `\n${workerDiagnostics(stateDir, workers)}`;
    }
    throw error;
  } finally {
    await stopOwnedProcesses(
      workers.map((worker) => worker.child),
      { tree: true }
    );
    const allJobs = fs.existsSync(path.join(stateDir, "store")) ? rawAll(stateDir, "SELECT id FROM jobs").map((row) => row.id) : [];
    await stopJobProcesses(stateDir, [...new Set([...jobIds, ...allJobs])], ctx.binDir);
  }
}

test("the stdin line follows the dispatch commit", { timeout: 60000 }, async (t) => {
  const ctx = makeRepo(undefined, t);
  const stateDir = makeStoreDir(t);
  const jobId = createAgyStoreJob(stateDir, ctx.repo, { prompt: "first job" });
  const { messageId } = withStore(stateDir, (store) => sendToChain(store, { ref: jobId, observedTipId: jobId }, { text: "the queued message" }));

  await withAgyWorkers(ctx, stateDir, async (start) => {
    const worker = start(jobId);
    const exit = await worker.exit;
    assert.equal(exit.code, 0, exit.stderr);
  });

  const message = messageRow(stateDir, messageId);
  assert.ok(message.dispatched_at, JSON.stringify(message));
  const [agyRun] = readFakeAgyState(ctx.binDir).runs;
  assert.equal(agyRun.inputs.length, 1);
  assert.ok(agyRun.inputs[0].startsWith(`[message ${messageId}]`), agyRun.inputs[0]);
  assert.ok(agyRun.inputsAt[0] >= message.dispatched_at, `received ${agyRun.inputsAt[0]}, dispatched ${message.dispatched_at}`);
  assert.equal(message.state, "consumed", JSON.stringify(message));
  const row = storeRow(stateDir, jobId);
  assert.equal(row.end_state, "completed", JSON.stringify(row));
  assert.equal(row.thread_id, "conv-1");
});

test("a job launched twice on the fake agy writes one prompt", { timeout: 60000 }, async (t) => {
  const ctx = makeRepo(undefined, t);
  const stateDir = makeStoreDir(t);
  const jobId = createAgyStoreJob(stateDir, ctx.repo, { prompt: "only once" });

  await withAgyWorkers(ctx, stateDir, async (start) => {
    const first = start(jobId);
    const second = start(jobId);
    const exits = await Promise.all([first.exit, second.exit]);
    for (const exit of exits) {
      assert.equal(exit.code, 0, exit.stderr);
    }
  });

  const runs = readFakeAgyState(ctx.binDir).runs;
  assert.equal(runs.length, 1, JSON.stringify(runs.map((agyRun) => agyRun.args)));
  assert.equal(runs[0].inputs.length, 1);
  assert.equal(storeRow(stateDir, jobId).end_state, "completed");
});

test("a replayed init does not confirm a message", { timeout: 60000 }, async (t) => {
  const ctx = makeRepo("replay-then-stall", t);
  const stateDir = makeStoreDir(t);
  const jobId = createAgyStoreJob(stateDir, ctx.repo, { prompt: "continue", threadId: "conv-replayed" });
  const { messageId } = withStore(stateDir, (store) => sendToChain(store, { ref: jobId, observedTipId: jobId }, { text: "are you there" }));

  await withAgyWorkers(ctx, stateDir, async (start) => {
    start(jobId);
    await waitUntil(() => readFakeAgyState(ctx.binDir).runs[0]?.inputs?.length === 1, { timeoutMs: 20000, describe: "the prompt reaching the fake" });
    // The fake has written its replayed init and user_input; the message stays dispatched.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const message = messageRow(stateDir, messageId);
    assert.equal(message.state, "dispatched", JSON.stringify(message));
    assert.equal(storeRow(stateDir, jobId).end_state, null);
  });
});

// Cleanup contracts and a grace window for the fake agy on this platform, so that a worker that saw
// its provider exit, or a scan after an owner death, releases at once; Linux uses the empty
// provider group.
const AGY_TEST_CONTRACTS = JSON.stringify(
  ["own-exit", "tree-stop", "owner-death"].map((trigger) => ({ provider: "agy", platform: process.platform, trigger, version: "0.0.1", windowMs: 0 }))
);
const RELEASE_ENV = { AGENT_PLUGIN_TEST_CONTRACTS: AGY_TEST_CONTRACTS, AGENT_PLUGIN_GRACE_MS: "500" };

// waitUntil, with `snapshot()` added to the error when the condition does not happen in time.
async function waitUntilOr(snapshot, predicate, options) {
  try {
    return await waitUntil(predicate, options);
  } catch (error) {
    throw new Error(`${error.message}; store: ${snapshot()}`);
  }
}

// Waits until every job of the store has an end decision and a released execution, and every
// message is closed or consumed; returns the job rows in creation order.
async function waitForSettledChain(stateDir, { timeoutMs = 40000 } = {}) {
  const snapshot = () =>
    JSON.stringify({
      jobs: rawAll(stateDir, "SELECT id, continues, end_state, exec_gen, exec_released_at, stopping_since, started_at, thread_id, next_action FROM jobs ORDER BY created_at, id"),
      messages: rawAll(stateDir, "SELECT id, state, dispatched_job_id, consumed_job_id FROM messages")
    });
  return waitUntilOr(snapshot, 
    () => {
      const jobs = rawAll(stateDir, "SELECT * FROM jobs ORDER BY created_at, id");
      const open = rawAll(stateDir, "SELECT id FROM messages WHERE state IN ('pending', 'dispatched')");
      const settled = jobs.every((row) => row.end_state !== null && (row.exec_gen === 0 || row.exec_gen === null || row.exec_released_at !== null));
      return settled && open.length === 0 ? jobs : null;
    },
    { timeoutMs, describe: "the chain settling" }
  );
}

test("Antigravity messages wait for the successor", { timeout: 90000 }, async (t) => {
  const ctx = makeRepo("slow", t, { slowMs: 4000 });
  const stateDir = makeStoreDir(t);
  const first = createAgyStoreJob(stateDir, ctx.repo, { prompt: "a slow turn" });

  await withAgyWorkers({ ...ctx, env: { ...ctx.env, ...RELEASE_ENV } }, stateDir, async (start) => {
    start(first);
    await waitUntil(() => readFakeAgyState(ctx.binDir).runs[0]?.inputs?.length === 1, { timeoutMs: 20000, describe: "the first prompt" });
    const sent = withStore(stateDir, (store) => sendToChain(store, { ref: first, observedTipId: first }, { text: "hello" }));
    assert.equal(sent.outcome, "running");
    // During the turn nothing more reaches the first process and the message stays pending.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(readFakeAgyState(ctx.binDir).runs[0].inputs.length, 1);
    assert.equal(messageRow(stateDir, sent.messageId).state, "pending");

    const jobs = await waitForSettledChain(stateDir);
    assert.equal(jobs.length, 2, JSON.stringify(jobs.map((row) => [row.id, row.end_state])));
    const [firstRow, successor] = jobs;
    assert.equal(firstRow.end_state, "completed");
    assert.equal(successor.continues, first);
    assert.equal(successor.end_state, "completed");
    const runs = readFakeAgyState(ctx.binDir).runs;
    assert.equal(runs.length, 2);
    assert.equal(runs[0].inputs.length, 1, "a line reached the first process after its turn began");
    assert.equal(runs[1].args[runs[1].args.indexOf("--conversation") + 1], "conv-1");
    assert.equal(runs[1].inputs.length, 1);
    assert.ok(runs[1].inputs[0].startsWith(`[message ${sent.messageId}]\n`), runs[1].inputs[0]);
    const message = messageRow(stateDir, sent.messageId);
    assert.equal(message.state, "consumed");
    assert.equal(message.consumed_job_id, successor.id);
    assert.ok(message.dispatched_at <= runs[1].inputsAt[0], `dispatched ${message.dispatched_at}, received ${runs[1].inputsAt[0]}`);
  });
});

// Runs scans until `jobId` has an end decision; the worker of the job is gone.
// Runs one scan of the store in this process with `env` (contracts and grace window) applied
// for its duration.
async function scanOnce(stateDir, env = RELEASE_ENV) {
  const names = ["AGENT_PLUGIN_TEST_CONTRACTS", "AGENT_PLUGIN_GRACE_MS"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) {
    if (env[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = env[name];
    }
  }
  try {
    await reconcileStore(stateDir, { deadline: performance.now() + 8000, budget: "command" });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

// Scans until `jobId` has an end decision and a released execution; the worker of the job is gone.
async function scanUntilEnded(stateDir, jobId, env = RELEASE_ENV, { timeoutMs = 30000 } = {}) {
  return waitUntil(
    async () => {
      await scanOnce(stateDir, env);
      const row = storeRow(stateDir, jobId);
      return row.end_state !== null && row.exec_released_at !== null ? row : null;
    },
    { timeoutMs, intervalMs: 300, describe: "the scan ending the job" }
  );
}

for (const point of ["after-dispatch", "after-write"]) {
  test(`a possibly delivered agy message is resent with its prefix (${point})`, { timeout: 90000 }, async (t) => {
    const ctx = makeRepo(undefined, t);
    const stateDir = makeStoreDir(t);
    const pointsDir = makeTempDir(t);
    const first = createAgyStoreJob(stateDir, ctx.repo, { prompt: "the job", threadId: "conv-9" });
    const { messageId } = withStore(stateDir, (store) => sendToChain(store, { ref: first, observedTipId: first }, { text: "the message" }));
    const env = { ...ctx.env, ...RELEASE_ENV };

    await withAgyWorkers({ ...ctx, env }, stateDir, async (start) => {
      start(first, { AGENT_PLUGIN_TEST_POINTS: point, AGENT_PLUGIN_TEST_POINTS_DIR: pointsDir });
      await waitUntil(() => fs.readdirSync(pointsDir).some((name) => name.startsWith(`${point}-`)), { timeoutMs: 20000, describe: point });
      // The worker stops at the point; the test stops it and its provider by their identities.
      await stopJobProcesses(stateDir, [first], ctx.binDir);
      assert.equal(messageRow(stateDir, messageId).state, "dispatched");
      const ended = await scanUntilEnded(stateDir, first);
      assert.equal(ended.end_state, "interrupted", JSON.stringify(ended));

      const decided = withStore(stateDir, (store) => decideNext(store, { ref: first, observedTipId: first }, { action: "continue", requester: { sessionId: "session-agy", leaderPid: null, leaderStartToken: null } }));
      assert.equal(decided.won, true, JSON.stringify(decided));
      const worker = start(decided.successorId);
      const exit = await worker.exit;
      assert.equal(exit.code, 0, exit.stderr);
    });

    const runs = readFakeAgyState(ctx.binDir).runs;
    const last = runs.at(-1);
    assert.equal(last.inputs.length, 1);
    assert.ok(last.inputs[0].startsWith(`[message ${messageId}]\n${UNCERTAIN_PREFIX}\n`), last.inputs[0]);
    assert.equal(messageRow(stateDir, messageId).state, "consumed");
  });
}

test("only the oldest deliverable message opens an agy continuation", { timeout: 120000 }, async (t) => {
  const ctx = makeRepo("slow", t, { slowMs: 3000 });
  const stateDir = makeStoreDir(t);
  const first = createAgyStoreJob(stateDir, ctx.repo, { prompt: "a slow turn" });

  await withAgyWorkers({ ...ctx, env: { ...ctx.env, ...RELEASE_ENV } }, stateDir, async (start) => {
    start(first);
    await waitUntil(() => readFakeAgyState(ctx.binDir).runs[0]?.inputs?.length === 1, { timeoutMs: 20000, describe: "the first prompt" });
    const one = withStore(stateDir, (store) => sendToChain(store, { ref: first, observedTipId: first }, { text: "message one" }));
    const two = withStore(stateDir, (store) => sendToChain(store, { ref: first, observedTipId: first }, { text: "message two" }));

    const jobs = await waitForSettledChain(stateDir, { timeoutMs: 80000 });
    assert.equal(jobs.length, 3, JSON.stringify(jobs.map((row) => [row.id, row.end_state])));
    const runs = readFakeAgyState(ctx.binDir).runs;
    assert.deepEqual(
      runs.map((agyRun) => agyRun.inputs.length),
      [1, 1, 1]
    );
    assert.ok(runs[1].inputs[0].startsWith(`[message ${one.messageId}]\n`), runs[1].inputs[0]);
    assert.ok(!runs[1].inputs[0].includes("message two"), runs[1].inputs[0]);
    assert.ok(runs[2].inputs[0].startsWith(`[message ${two.messageId}]\n`), runs[2].inputs[0]);
    assert.equal(messageRow(stateDir, one.messageId).consumed_job_id, jobs[1].id);
    assert.equal(messageRow(stateDir, two.messageId).consumed_job_id, jobs[2].id);
  });
});

test("a send racing the agy turn end never makes a second prompt", { timeout: 300000 }, async (t) => {
  const repetitions = 20;
  const batch = 4;
  const runOne = async (index) => {
    const ctx = makeRepo(undefined, t);
    const stateDir = makeStoreDir(t);
    const first = createAgyStoreJob(stateDir, ctx.repo, { prompt: `race ${index}` });
    await withAgyWorkers({ ...ctx, env: { ...ctx.env, ...RELEASE_ENV } }, stateDir, async (start) => {
      const worker = start(first);
      await waitUntil(() => readFakeAgyState(ctx.binDir).runs[0]?.inputs?.length === 1, { timeoutMs: 20000, describe: "the first prompt" });
      // The fake answers 50 ms after the prompt; the send lands before, at or after the turn's end.
      await new Promise((resolve) => setTimeout(resolve, (index * 13) % 120));
      let sent;
      try {
        sent = withStore(stateDir, (store) => sendToChain(store, { ref: first, observedTipId: first }, { text: `racing ${index}` }));
      } catch (error) {
        const row = storeRow(stateDir, first);
        const exit = await Promise.race([worker.exit, new Promise((resolve) => setTimeout(() => resolve(null), 5000))]);
        const logPath = path.join(stateDir, "store", "artifacts", `${first}.log`);
        const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").slice(-4000) : "(no log)";
        assert.fail(`send ${index} failed: ${error.message}\nrow: ${JSON.stringify(row)}\nworker stderr: ${exit?.stderr ?? "(running)"}\nlog: ${log}`);
      }
      // A send that finds the turn ended creates the successor and, as the send command does,
      // launches it.
      if (sent.outcome === "continued") {
        start(sent.jobId);
      }
      await waitForSettledChain(stateDir, { timeoutMs: 60000 });
    });
    for (const agyRun of readFakeAgyState(ctx.binDir).runs) {
      assert.equal(agyRun.inputs.length, 1, `repetition ${index}: a job wrote ${agyRun.inputs.length} prompts`);
    }
    assert.equal(rawAll(stateDir, "SELECT state FROM messages")[0].state, "consumed");
  };
  for (let index = 0; index < repetitions; index += batch) {
    await Promise.all(Array.from({ length: Math.min(batch, repetitions - index) }, (_, offset) => runOne(index + offset)));
  }
});

test("the lost-context preamble keeps the message header first and stays within its byte budget", () => {
  const job = { thread_id: null, continues: "task-earlier", allow_questions: 0 };
  const prior = `${"é".repeat(40000)}tail-marker`;
  const body = formatAgyBody(job, { kind: "message", messageText: "the new message", storedPrompt: "the original prompt", predecessor: { resultText: prior, logTail: "" }, priorOutputBudget: 65536 });
  const text = composeRequestText({ messageId: 42, uncertain: true, body, additions: [agyRuntime.AGY_DELEGATE_LINE] });
  const lines = text.split("\n");
  assert.equal(lines[0], "[message 42]");
  assert.equal(lines[1], UNCERTAIN_PREFIX);
  assert.equal(lines[2], "the original prompt");
  assert.ok(text.includes(`\n${AGY_LOST_CONTEXT_LINE}\n`));
  const priorPart = body.slice(body.indexOf(AGY_LOST_CONTEXT_LINE) + AGY_LOST_CONTEXT_LINE.length + 1, body.lastIndexOf("\n\nthe new message"));
  assert.ok(Buffer.byteLength(priorPart, "utf8") <= 65536, `${Buffer.byteLength(priorPart, "utf8")} bytes of prior output`);
  assert.ok(!priorPart.includes("\uFFFD"), "the prior output was cut inside a character");
  assert.ok(!priorPart.includes("tail-marker"));
  assert.ok(text.endsWith(`the new message\n\n${agyRuntime.AGY_DELEGATE_LINE}`), text.slice(-200));

  // A job that resumes its conversation sends the message alone.
  assert.equal(formatAgyBody({ thread_id: "conv-1", continues: "task-earlier" }, { kind: "message", messageText: "only this", storedPrompt: "prompt", predecessor: { resultText: prior } }), "only this");
});

// The worker of a job, by the identity recorded in its row.
function workerOf(stateDir, jobId) {
  const row = storeRow(stateDir, jobId);
  return row?.worker_pid && row.worker_start_token ? { pid: row.worker_pid, startToken: row.worker_start_token } : null;
}

// Whether a recorded identity is still a running process with that start token.
async function stillRunning(identity) {
  const observed = await readProcessIdentity(identity.pid, { deadline: performance.now() + 10000 });
  return observed.state === "present" && String(observed.startToken) === String(identity.startToken);
}

test("an agy job stopped in its first turn is resumable", { timeout: 120000 }, async (t) => {
  const ctx = makeRepo("hang", t);
  const stateDir = makeStoreDir(t);
  const jobId = createAgyStoreJob(stateDir, ctx.repo, { prompt: "wait in the first turn" });

  await withAgyWorkers(ctx, stateDir, async (start) => {
    start(jobId);
    const started = await waitUntil(() => {
      const row = storeRow(stateDir, jobId);
      return row?.provider_start_token && row.thread_id === "conv-1" && row.started_at ? row : null;
    }, { timeoutMs: 20000, describe: "the conversation, provider identity and start" });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const root = { pid: started.provider_pid, startToken: started.provider_start_token };
    assert.equal(await stopOwnedProcess(workerOf(stateDir, jobId)), "stopped");
    if (process.platform === "linux") {
      // The detached agy root outlives its worker; the scan verifies its identity and stops its tree,
      // and the empty provider group establishes closure.
      assert.ok(await stillRunning(root), "the agy root ended with its worker");
    }
    // On Windows the system ends a worker's direct children with it, so agy ends with its owner and
    // the descriptor's owner-death contract establishes closure.
    const ended = await scanUntilEnded(stateDir, jobId, {});
    assert.equal(ended.end_state, "interrupted", JSON.stringify(ended));
    assert.equal(ended.release_kind, "confirmed", JSON.stringify(ended));
    assert.equal(await stillRunning(root), false);
    assert.equal(readJobView(openStore(stateDir), jobId).resumable, true);
  });
});

// A and C use a fake that stays alive when its input ends; B's fake exits at the end of its input.
for (const [name, behaviour, cancel] of [["A", "silent", false], ["B", undefined, false], ["C", "silent", true]]) {
  test(`owner death before the child is recorded on the fake agy (${name})`, { timeout: 120000 }, async (t) => {
    const ctx = makeRepo(behaviour, t);
    const stateDir = makeStoreDir(t);
    const pointsDir = makeTempDir(t);
    const jobId = createAgyStoreJob(stateDir, ctx.repo, { prompt: "a continuation", threadId: "conv-owner" });
    const graceEnv = { AGENT_PLUGIN_GRACE_MS: "3000" };

    await withAgyWorkers(ctx, stateDir, async (start) => {
      start(jobId, { AGENT_PLUGIN_TEST_POINTS: "after-spawn", AGENT_PLUGIN_TEST_POINTS_DIR: pointsDir });
      await waitUntil(() => fs.readdirSync(pointsDir).some((entry) => entry.startsWith("after-spawn-")), { timeoutMs: 20000, describe: "after-spawn" });
      assert.equal(storeRow(stateDir, jobId).provider_pid, null);
      assert.equal(await stopOwnedProcess(workerOf(stateDir, jobId)), "stopped");
      if (cancel) {
        withStore(stateDir, (store) => requestStop(store, { jobIds: [jobId] }, { reason: "cancel", cancel: true }));
      }

      await scanOnce(stateDir, graceEnv);
      const first = storeRow(stateDir, jobId);
      assert.equal(first.stopping_cause, "unrecorded-child", JSON.stringify(first));
      assert.ok(first.grace_started_at, JSON.stringify(first));
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await scanOnce(stateDir, graceEnv);
      assert.equal(storeRow(stateDir, jobId).grace_started_at, first.grace_started_at);

      const ended = await scanUntilEnded(stateDir, jobId, graceEnv, { timeoutMs: 20000 });
      assert.equal(ended.end_state, cancel ? "cancelled" : "interrupted", JSON.stringify(ended));
      // No provider root was recorded, so no platform can establish closure: unobserved, with a
      // barrier on the conversation.
      assert.equal(ended.release_kind, "unobserved");
      assert.equal(ended.provider_exit_unobserved, 1);
      assert.deepEqual(rawAll(stateDir, "SELECT provider, thread_id, job_id FROM thread_barriers"), [{ provider: "agy", thread_id: "conv-owner", job_id: jobId }]);
      if (behaviour === "silent" && process.platform === "linux") {
        // Cleaning up the unrecorded execution stopped nothing: the fake still runs. (On Windows the
        // system ends the fake with its worker.)
        const fake = (readFakeAgyState(ctx.binDir).identities ?? []).find((entry) => entry.pid === readFakeAgyState(ctx.binDir).runs[0].pid);
        assert.ok(fake && (await stillRunning(fake)), "the unrecorded agy process was stopped");
      }
    });
  });
}

test("an absent agy root is not confirmation without closure", { timeout: 180000 }, async (t) => {
  // A: a live worker cancels a running turn; its tree stop removes the root and the child, and
  // the descriptor's tree-stop contract (Windows) or the empty group (Linux) confirms the release.
  {
    const ctx = makeRepo("hang", t, { spawnChild: true });
    const stateDir = makeStoreDir(t);
    const jobId = createAgyStoreJob(stateDir, ctx.repo, { prompt: "case A" });
    await withAgyWorkers(ctx, stateDir, async (start) => {
      const worker = start(jobId);
      const childPid = await waitUntil(() => readFakeAgyState(ctx.binDir).childPids?.[0], { timeoutMs: 20000, describe: "the fake's child" });
      await waitUntil(() => storeRow(stateDir, jobId)?.started_at, { timeoutMs: 20000, describe: "the turn" });
      const child = await waitUntil(() => (readFakeAgyState(ctx.binDir).identities ?? []).find((entry) => entry.pid === childPid), { timeoutMs: 20000, describe: "the child's identity" });
      withStore(stateDir, (store) => requestStop(store, { jobIds: [jobId] }, { reason: "cancel", cancel: true }));
      const exit = await worker.exit;
      assert.equal(exit.code, 0, exit.stderr);
      const row = storeRow(stateDir, jobId);
      assert.equal(row.end_state, "cancelled", JSON.stringify(row));
      assert.equal(row.release_kind, "confirmed", JSON.stringify(row));
      assert.equal(await stillRunning(child), false, "the child outlived the tree stop");
    });
  }
  // B: the root exits by itself while its child keeps running, and the worker is stopped before
  // it handles that exit. Without a contract for the trigger (Windows) and with an occupied group
  // (Linux), the root's absence confirms nothing: the release is unobserved after the window and
  // the child is still running.
  {
    const ctx = makeRepo("result-then-exit", t, { spawnChild: true, recordIdentities: true });
    const stateDir = makeStoreDir(t);
    const pointsDir = makeTempDir(t);
    const jobId = createAgyStoreJob(stateDir, ctx.repo, { prompt: "case B" });
    const noContracts = { AGENT_PLUGIN_TEST_CONTRACTS: "[]", AGENT_PLUGIN_GRACE_MS: "2000" };
    await withAgyWorkers(ctx, stateDir, async (start) => {
      start(jobId, { AGENT_PLUGIN_TEST_POINTS: "before-end", AGENT_PLUGIN_TEST_POINTS_DIR: pointsDir });
      await waitUntil(() => fs.readdirSync(pointsDir).some((entry) => entry.startsWith("before-end-")), { timeoutMs: 20000, describe: "before-end" });
      const row = storeRow(stateDir, jobId);
      const root = { pid: row.provider_pid, startToken: row.provider_start_token };
      await waitUntil(async () => !(await stillRunning(root)), { timeoutMs: 10000, describe: "the root's own exit" });
      const childPid = readFakeAgyState(ctx.binDir).childPids[0];
      const child = await waitUntil(() => (readFakeAgyState(ctx.binDir).identities ?? []).find((entry) => entry.pid === childPid), { timeoutMs: 20000, describe: "the child's identity" });
      assert.equal(await stopOwnedProcess(workerOf(stateDir, jobId)), "stopped");

      await scanOnce(stateDir, noContracts);
      assert.equal(storeRow(stateDir, jobId).exec_released_at, null, "an absent root alone released the execution");
      const ended = await scanUntilEnded(stateDir, jobId, noContracts, { timeoutMs: 20000 });
      assert.equal(ended.release_kind, "unobserved", JSON.stringify(ended));
      assert.ok(await stillRunning(child), "the cleanup stopped the child");
    });
  }
});

test("a running agy turn goes straight to the tree stop on cancel", { timeout: 60000 }, async (t) => {
  const ctx = makeRepo("hang", t);
  const stateDir = makeStoreDir(t);
  const jobId = createAgyStoreJob(stateDir, ctx.repo, { prompt: "a long turn" });

  await withAgyWorkers(ctx, stateDir, async (start) => {
    const worker = start(jobId);
    await waitUntil(() => storeRow(stateDir, jobId)?.started_at, { timeoutMs: 20000, describe: "the turn" });
    const cancelledAt = Date.now();
    withStore(stateDir, (store) => requestStop(store, { jobIds: [jobId] }, { reason: "cancel", cancel: true }));
    const exit = await worker.exit;
    assert.equal(exit.code, 0, exit.stderr);
    const row = storeRow(stateDir, jobId);
    assert.equal(row.end_state, "cancelled");
    assert.equal(row.release_kind, "confirmed", JSON.stringify(row));
    assert.ok(row.exec_released_at - cancelledAt < 4000, `the release came ${row.exec_released_at - cancelledAt} ms after the cancel`);
    // agy's input was never ended: the tree stop came first.
    assert.notEqual(readFakeAgyState(ctx.binDir).runs[0].stdinClosed, true);
    const log = fs.readFileSync(path.join(stateDir, "store", "artifacts", `${jobId}.log`), "utf8");
    assert.match(log, /tree stop at/);
  });
});

test("an agy process that emits nothing is stopped and the job fails", { timeout: 30000 }, async (t) => {
  const ctx = makeRepo("silent", t);
  const stateDir = makeStoreDir(t);
  const jobId = createAgyStoreJob(stateDir, ctx.repo, { prompt: "say nothing" });

  await withAgyWorkers({ ...ctx, env: { ...ctx.env, ...RELEASE_ENV } }, stateDir, async (start) => {
    const started = Date.now();
    const exit = await start(jobId, { AGENT_PLUGIN_AGY_SILENCE_MS: "1000" }).exit;
    assert.equal(exit.code, 0, exit.stderr);
    const row = storeRow(stateDir, jobId);
    assert.equal(row.end_state, "failed", JSON.stringify(row));
    assert.equal(row.error, "Antigravity stopped responding.");
    assert.ok(Date.now() - started < 15000, `the silence stop took ${Date.now() - started} ms`);
    const [agyRun] = readFakeAgyState(ctx.binDir).runs;
    assert.ok(await waitUntil(() => !isProcessAlive(agyRun.pid), { timeoutMs: 10000 }), "the silent agy process kept running");
  });
});

test("the silence stop removes a verified live root and its child", { timeout: 60000 }, async (t) => {
  const ctx = makeRepo("silent", t, { spawnChild: true });
  const stateDir = makeStoreDir(t);
  const jobId = createAgyStoreJob(stateDir, ctx.repo, { prompt: "say nothing" });

  await withAgyWorkers({ ...ctx, env: { ...ctx.env, ...RELEASE_ENV } }, stateDir, async (start) => {
    const worker = start(jobId, { AGENT_PLUGIN_AGY_SILENCE_MS: "3000" });
    const childPid = await waitUntil(() => readFakeAgyState(ctx.binDir).childPids?.[0], { timeoutMs: 10000, describe: "the fake's child" });
    const fakePid = readFakeAgyState(ctx.binDir).runs[0].pid;
    const exit = await worker.exit;
    assert.equal(exit.code, 0, exit.stderr);

    const row = storeRow(stateDir, jobId);
    assert.equal(row.error, "Antigravity stopped responding.");
    // The worker's tree stop of the verified root is what released the execution.
    assert.equal(row.release_kind, "confirmed", JSON.stringify(row));
    const root = { pid: row.provider_pid, startToken: row.provider_start_token };
    assert.ok(Number.isInteger(root.pid) && root.startToken, JSON.stringify(root));
    if (process.platform === "linux") {
      assert.equal(row.provider_group_id, root.pid, "the agy child does not lead its own process group");
    }
    for (const pid of new Set([root.pid, fakePid, childPid])) {
      assert.ok(await waitUntil(() => !isProcessAlive(pid), { timeoutMs: 10000 }), `process ${pid} kept running`);
    }
  });
});

test("an agy process that writes only non-event output is stopped as silent", { timeout: 30000 }, async (t) => {
  const ctx = makeRepo("chatty-silent", t);
  const stateDir = makeStoreDir(t);
  const jobId = createAgyStoreJob(stateDir, ctx.repo, { prompt: "say nothing" });

  await withAgyWorkers({ ...ctx, env: { ...ctx.env, ...RELEASE_ENV } }, stateDir, async (start) => {
    const started = Date.now();
    const exit = await start(jobId, { AGENT_PLUGIN_AGY_SILENCE_MS: "1500" }).exit;
    assert.equal(exit.code, 0, exit.stderr);
    const row = storeRow(stateDir, jobId);
    assert.equal(row.error, "Antigravity stopped responding.");
    // The worker's tree stop of the verified root is what released the execution.
    assert.equal(row.release_kind, "confirmed", JSON.stringify(row));
    assert.ok(Date.now() - started < 15000, `the silence stop took ${Date.now() - started} ms`);
    const [agyRun] = readFakeAgyState(ctx.binDir).runs;
    assert.ok(await waitUntil(() => !isProcessAlive(agyRun.pid), { timeoutMs: 10000 }), "the agy process kept running");
  });
});

test("agy setup shows the validated and installed versions and the no-MCP assumption", (t) => {
  const ctx = makeRepo(undefined, t);
  const result = run("node", [AGY, "setup"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^- cleanup contracts validated on agy 1\.5\.10 \(Windows: own exit, owner death, tree stop; owner death also on 1\.5\.11\)$/m);
  assert.match(result.stdout, /^- installed agy: 1\.5\.10$/m);
  assert.match(result.stdout, /^- the contracts assume no MCP server is configured for agy; /m);
  const report = JSON.parse(run("node", [AGY, "setup", "--json"], { cwd: ctx.repo, env: ctx.env }).stdout);
  assert.equal(report.contracts.length, 3);
});

test("a delegate question makes the agy job waiting", { timeout: 60000 }, async (t) => {
  const ctx = makeRepo("question", t);
  const stateDir = makeStoreDir(t);
  const jobId = createAgyStoreJob(stateDir, ctx.repo, { prompt: "pick a branch", allowQuestions: true });

  await withAgyWorkers({ ...ctx, env: { ...ctx.env, ...RELEASE_ENV } }, stateDir, async (start) => {
    const exit = await start(jobId).exit;
    assert.equal(exit.code, 0, exit.stderr);
  });

  const row = storeRow(stateDir, jobId);
  assert.equal(row.end_state, "waiting", JSON.stringify(row));
  assert.equal(row.question, "which branch?");
  assert.equal(rawAll(stateDir, "SELECT kind FROM events WHERE job_id = ?", [jobId]).filter((event) => event.kind === "waiting").length, 1);
  const prompt = readFakeAgyState(ctx.binDir).runs[0].inputs[0];
  assert.ok(prompt.includes(QUESTION_INSTRUCTION), prompt);
  assert.ok(prompt.endsWith(AGY_NO_QUESTION_TOOL_LINE), prompt.slice(-300));
});

test("a seeded agy job passes the schema with an optional question property and ends waiting", { timeout: 60000 }, async (t) => {
  const ctx = makeRepo("question", t);
  const stateDir = makeStoreDir(t);
  const userSchema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
  const jobId = createAgyStoreJob(stateDir, ctx.repo, {
    prompt: "answer with a schema",
    allowQuestions: true,
    request: { outputSchema: augmentSchemaForQuestions(userSchema) }
  });

  await withAgyWorkers({ ...ctx, env: { ...ctx.env, ...RELEASE_ENV } }, stateDir, async (start) => {
    const exit = await start(jobId).exit;
    assert.equal(exit.code, 0, exit.stderr);
  });

  const [agyRun] = readFakeAgyState(ctx.binDir).runs;
  assert.deepEqual(agyRun.schema.properties.question, { type: "string" });
  assert.deepEqual(agyRun.schema.required, ["answer"]);
  const schemaFile = agyRun.args[agyRun.args.indexOf("--json-schema") + 1];
  assert.equal(fs.existsSync(schemaFile), false, "the temporary schema file was left behind");
  const row = storeRow(stateDir, jobId);
  assert.equal(row.end_state, "waiting", JSON.stringify(row));
  assert.equal(row.question, "which branch?");
});

test("a resumed conversation counts one turn despite a repeated init and replayed user_input", async (t) => {
  const ctx = makeRepo("replayed-events", t);
  const first = await driverTurn(t, ctx, { prompt: "first" });
  const resumed = await driverTurn(t, ctx, { prompt: "again", threadId: first.outcome.conversationId });

  const output = readFakeAgyState(ctx.binDir).runs[1].output.map((line) => JSON.parse(line));
  assert.equal(output.filter((event) => event.event === "init").length, 2);
  assert.equal(output.filter((event) => event.step_update?.step_type === "user_input").length, 2);
  assert.equal(resumed.outcome.processTurns, 1, JSON.stringify(resumed.outcome));
  assert.equal(first.outcome.processTurns, 1, JSON.stringify(first.outcome));
});

// ---------------------------------------------------------------------------------------------
// The task and review commands on the store

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("agy task and review accept --label and --run-id and store both", async (t) => {
  const ctx = makeRepo(undefined, t);
  const task = run("node", [AGY, "task", "--background", "--json", "--label", "a1", "--run-id", "run-1", "do", "it"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(task.status, 0, task.stderr);
  fs.writeFileSync(path.join(ctx.repo, "README.md"), "changed\n");
  const review = run("node", [AGY, "review", "--background", "--json", "--label", "a2", "--run-id", "run-1"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(review.status, 0, review.stderr);

  for (const [reply, label, kind] of [[JSON.parse(task.stdout), "a1", "task"], [JSON.parse(review.stdout), "a2", "review"]]) {
    assert.ok(reply.jobId, JSON.stringify(reply));
    assert.ok(["queued", "running"].includes(reply.status), JSON.stringify(reply));
    assert.equal(reply.label, label);
    assert.equal(reply.runId, "run-1");
    assert.equal(reply.provider, "agy");
    assert.equal(reply.chainId, reply.jobId);
    assert.ok(!Number.isNaN(Date.parse(reply.createdAt)), reply.createdAt);
    const row = job(ctx.repo, reply.jobId);
    assert.equal(row.label, label);
    assert.equal(row.run_id, "run-1");
    assert.equal(row.kind, kind);
    await waitUntil(() => jobEnded(ctx.repo, reply.jobId), { timeoutMs: 20000, describe: `the ${kind} ending` });
  }
});

test("agy resume flags respect the thread barrier and print the overlap warning with --force", async (t) => {
  const ctx = makeRepo(undefined, t);
  const env = { ...ctx.env, AGENT_PLUGIN_SESSION_ID: "session-barrier" };
  const first = run("node", [AGY, "task", "--json", "first"], { cwd: ctx.repo, env });
  assert.equal(first.status, 0, first.stderr);
  const barrierJob = "task-barrier-holder";
  const warning = `Thread conv-1 was last used by job ${barrierJob}, whose provider exit was not observed; it may still run and overlap this job.`;

  for (const flags of [["--resume-thread", "conv-1"], ["--resume-last"]]) {
    // A forced job whose release is confirmed clears the barrier, so each case starts with one.
    rawExec(resolveStateDir(ctx.repo), "INSERT OR REPLACE INTO thread_barriers (provider, thread_id, job_id, created_at) VALUES (?, ?, ?, ?)", ["agy", "conv-1", barrierJob, Date.now()]);
    const before = storeJobs(ctx.repo).length;
    const refused = run("node", [AGY, "task", "--json", ...flags, "y"], { cwd: ctx.repo, env });
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stderr, new RegExp(`last used by job ${barrierJob}`));
    assert.equal(storeJobs(ctx.repo).length, before, `${flags[0]} created a job without --force`);

    const forced = run("node", [AGY, "task", "--json", "--force", ...flags, "y"], { cwd: ctx.repo, env });
    assert.equal(forced.status, 0, forced.stderr);
    assert.ok(forced.stderr.includes(warning), forced.stderr);
    const row = job(ctx.repo, JSON.parse(forced.stdout).jobId);
    assert.equal(row.forced, 1, JSON.stringify(row));
    assert.equal(row.thread_id, "conv-1");
    await waitUntil(() => job(ctx.repo, row.id)?.exec_released_at, { timeoutMs: 20000, describe: "the forced job's release" });
  }
});

test("an agy job with a live label is refused", async (t) => {
  const ctx = makeRepo("slow", t);
  const first = run("node", [AGY, "task", "--background", "--json", "--label", "busy-one", "first"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(first.status, 0, first.stderr);
  const holder = JSON.parse(first.stdout).jobId;

  const second = run("node", [AGY, "task", "--background", "--json", "--label", "busy-one", "second"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(second.status, 1, second.stdout);
  assert.match(second.stderr, new RegExp(`The label "busy-one" is held by job ${holder}\\.`));
  assert.equal(storeJobs(ctx.repo).length, 1);
  await waitUntil(() => jobEnded(ctx.repo, holder), { timeoutMs: 20000, describe: "the first job ending" });
});

test("a foreground agy job exits by its end state", (t) => {
  const completed = makeRepo(undefined, t);
  const ok = run("node", [AGY, "task", "say", "hi"], { cwd: completed.repo, env: completed.env });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^reply: say hi$/m);

  const failed = makeRepo("no-agent-text", t);
  const bad = run("node", [AGY, "task", "say", "hi"], { cwd: failed.repo, env: failed.env });
  assert.equal(bad.status, 1, bad.stdout);
  assert.match(bad.stdout, /Antigravity ended the turn without an answer\./);

  const waiting = makeRepo("question", t);
  const asked = run("node", [AGY, "task", "--allow-questions", "pick", "one"], { cwd: waiting.repo, env: waiting.env });
  assert.equal(asked.status, 0, asked.stderr);
  assert.match(asked.stdout, /AGENT-QUESTION: which branch\?/);
  assert.equal(latestAgyJob(waiting.repo).end_state, "waiting");
});

test("an agy question works with an output schema", (t) => {
  const ctx = makeRepo("question", t);
  // An accepted task first shows that the test observes the job's store row.
  const accepted = run("node", [AGY, "task", "--json", "warm", "up"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(storeJobs(ctx.repo).length, 1);
  const schemaFile = path.join(ctx.repo, "s.json");
  fs.writeFileSync(schemaFile, JSON.stringify({ type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false }));
  const before = sha256(schemaFile);

  const result = run("node", [AGY, "task", "--json", "--allow-questions", "--output-schema", schemaFile, "x"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(result.status, 0, result.stderr);
  const reply = JSON.parse(result.stdout);
  assert.equal(reply.status, "waiting");
  assert.equal(reply.question, "which branch?");
  const agyRun = readFakeAgyState(ctx.binDir).runs.at(-1);
  assert.deepEqual(agyRun.schema.properties.question, { type: "string" });
  assert.deepEqual(agyRun.schema.required, ["answer"]);
  assert.equal(sha256(schemaFile), before);
});

test("agy question-schema conflicts are refused before any job", (t) => {
  const ctx = makeRepo(undefined, t);
  const accepted = run("node", [AGY, "task", "--json", "warm", "up"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(accepted.status, 0, accepted.stderr);
  const schemaA = path.join(ctx.repo, "a.json");
  const schemaB = path.join(ctx.repo, "b.json");
  fs.writeFileSync(schemaA, JSON.stringify({ type: "object", properties: { question: { type: "integer" } }, required: ["question"] }));
  fs.writeFileSync(schemaB, JSON.stringify({ type: "array", items: { type: "string" } }));
  const hashes = [sha256(schemaA), sha256(schemaB)];
  const runsBefore = readFakeAgyState(ctx.binDir).runs.length;

  for (const [file, rule] of [[schemaA, /already defines a question property/], [schemaB, /root must be an object schema with properties/]]) {
    const refused = run("node", [AGY, "task", "--allow-questions", "--output-schema", file, "x"], { cwd: ctx.repo, env: ctx.env });
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stderr, rule);
  }
  assert.equal(storeJobs(ctx.repo).length, 1);
  assert.deepEqual([sha256(schemaA), sha256(schemaB)], hashes);
  assert.equal(readFakeAgyState(ctx.binDir).runs.length, runsBefore, "the fake agy was contacted");
});

// ---------------------------------------------------------------------------------------------
// Each denial source fails a turn

test("denied_actions alone fails the turn", (t) => {
  const ctx = makeRepo("denied-actions-only", t);

  const { result, stored, reply } = runEndedTask(ctx, ["read", "it"]);

  assert.equal(result.status, 1, result.stdout);
  assert.equal(stored.end_state, "failed", JSON.stringify(stored));
  assert.equal(reply.error, "Antigravity was denied permission for command (Bash).");
  assert.ok(!reply.error.includes(" on "), reply.error);
});

test("a TOOL_ERROR event alone fails the turn", (t) => {
  const ctx = makeRepo("tool-error-only", t);

  const { result, stored, reply } = runEndedTask(ctx, ["run", "ping"]);

  assert.equal(result.status, 1, result.stdout);
  assert.equal(stored.end_state, "failed", JSON.stringify(stored));
  assert.match(reply.error, /^Antigravity was denied permission for command /);
});

test("setup reports version, sign-in, delegation model, efforts and write sandbox", (t) => {
  const ctx = makeRepo(undefined, t);
  const report = JSON.parse(run("node", [AGY, "setup", "--json"], { cwd: ctx.repo, env: ctx.env, check: true }).stdout);
  assert.equal(report.ready, true);
  assert.equal(report.login.ok, true);
  assert.equal(report.version, "1.5.10");
  assert.equal(report.modelCount, 2);
  assert.deepEqual(report.delegationModel, { id: null, displayName: "Fake Model (High)", source: "agy-settings" });
  assert.deepEqual(report.efforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(typeof report.writeSandbox, "string");
  const text = run("node", [AGY, "setup"], { cwd: ctx.repo, env: ctx.env, check: true }).stdout;
  assert.match(text, /^- version: 1\.5\.10$/m);
  assert.match(text, /^- delegation model by display name: Fake Model \(High\), from the Antigravity settings `model` key$/m);
  assert.match(text, /^- efforts: low, medium, high, xhigh$/m);

  fs.rmSync(path.join(ctx.home, ".gemini"), { recursive: true, force: true });
  const unknown = JSON.parse(run("node", [AGY, "setup", "--json"], { cwd: ctx.repo, env: ctx.env, check: true }).stdout);
  assert.deepEqual(unknown.delegationModel, { id: null, displayName: null, source: "unknown" });
  assert.match(run("node", [AGY, "setup"], { cwd: ctx.repo, env: ctx.env, check: true }).stdout, /^- delegation model by display name: unknown$/m);
});

// ---------------------------------------------------------------------------------------------
// Structured output on an agy task and its continuation

const NEUTRAL = path.join(ROOT, "plugins", "agent", "scripts", "agent-companion.mjs");

function writeSchema(dir, name, required) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify({ type: "object", properties: Object.fromEntries(required.map((key) => [key, { type: "string" }])), required }));
  return file;
}

test("an agy task with --output-schema stores and prints the structured object", (t) => {
  const ctx = makeRepo(undefined, t);
  const schema = writeSchema(ctx.repo, "schema.json", ["answer"]);

  const result = run("node", [AGY, "task", "--output-schema", schema, "answer", "it"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Structured output:$/m);
  assert.match(result.stdout, /"answer": "answer-value"/);
  const agyRun = readFakeAgyState(ctx.binDir).runs[0];
  assert.deepEqual(agyRun.schema, JSON.parse(fs.readFileSync(schema, "utf8")));
  const jobId = latestAgyJob(ctx.repo).id;
  const stored = JSON.parse(run("node", [NEUTRAL, "result", jobId, "--json"], { cwd: ctx.repo, env: ctx.env, check: true }).stdout);
  assert.deepEqual(stored.resultJson, { answer: "answer-value" });
  assert.match(run("node", [NEUTRAL, "result", jobId], { cwd: ctx.repo, env: ctx.env, check: true }).stdout, /^Structured output:$/m);
});

test("a schema answer with no prose completes", (t) => {
  const ctx = makeRepo("schema-only", t);
  const schema = writeSchema(ctx.repo, "schema.json", ["answer"]);

  const result = run("node", [AGY, "task", "--json", "--output-schema", schema, "x"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(result.status, 0, result.stderr);
  const reply = JSON.parse(result.stdout);
  assert.equal(reply.status, "completed");
  assert.deepEqual(reply.result, { answer: "answer-value" });
});

test("a continuation with another schema keeps the conversation", async (t) => {
  const ctx = makeRepo(undefined, t);
  const first = run("node", [AGY, "task", "--json", "--output-schema", writeSchema(ctx.repo, "a.json", ["answer"]), "first"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(first.status, 0, first.stderr);
  const firstId = JSON.parse(first.stdout).jobId;

  const resumed = run("node", [NEUTRAL, "resume", firstId, "--output-schema", writeSchema(ctx.repo, "b.json", ["count", "unit"]), "--json", "--", "more"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(resumed.status, 0, resumed.stderr);
  const successor = await waitUntil(() => storeJobs(ctx.repo).find((row) => row.continues === firstId && row.end_state !== null), { timeoutMs: 30000, describe: "the continuation ending" });
  assert.equal(successor.end_state, "completed", JSON.stringify(successor));
  const runs = readFakeAgyState(ctx.binDir).runs;
  assert.equal(runs[1].args[runs[1].args.indexOf("--conversation") + 1], "conv-1");
  assert.deepEqual(runs[1].schema.required, ["count", "unit"]);
  assert.equal(job(ctx.repo, firstId).thread_id, successor.thread_id);
  assert.deepEqual(JSON.parse(successor.result_json), { count: "count-value", unit: "unit-value" });
});

for (const [name, behavior] of [["a schema turn without structured output fails", "schema-no-output"], ["prose ending in JSON is not structured output", "schema-prose-json"]]) {
  test(name, (t) => {
    const ctx = makeRepo(behavior, t);
    const schema = writeSchema(ctx.repo, "schema.json", ["answer"]);

    const result = run("node", [AGY, "task", "--json", "--output-schema", schema, "x"], { cwd: ctx.repo, env: ctx.env });

    assert.equal(result.status, 1, result.stdout);
    const reply = JSON.parse(result.stdout);
    assert.equal(reply.status, "failed");
    assert.equal(reply.error, "Antigravity returned no structured output.");
    assert.match(run("node", [NEUTRAL, "result", reply.jobId], { cwd: ctx.repo, env: ctx.env }).stdout, /Antigravity returned no structured output\./);
  });
}

test("a denial outranks a structured answer", (t) => {
  const ctx = makeRepo("denied-with-schema", t);
  const schema = writeSchema(ctx.repo, "schema.json", ["answer"]);

  const result = run("node", [AGY, "task", "--json", "--output-schema", schema, "x"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(result.status, 1, result.stdout);
  const reply = JSON.parse(result.stdout);
  assert.equal(reply.status, "failed");
  assert.equal(reply.error, "Antigravity was denied permission for command (Bash).");
});

test("an invalid schema exits before a job is created", (t) => {
  const ctx = makeRepo(undefined, t);
  const cases = [
    ["missing.json", null],
    ["not-json.json", "not json"],
    ["objekt.json", JSON.stringify({ type: "objekt" })],
    ["required.json", JSON.stringify({ required: "answer" })]
  ];
  for (const [name, content] of cases) {
    const file = path.join(ctx.repo, name);
    if (content !== null) {
      fs.writeFileSync(file, content);
    }
    const result = run("node", [AGY, "task", "--output-schema", file, "x"], { cwd: ctx.repo, env: ctx.env });
    assert.equal(result.status, 1, `${name}: ${result.stdout}`);
    assert.ok(result.stderr.includes(file), `${name}: ${result.stderr}`);
  }
  assert.deepEqual(storeJobs(ctx.repo), []);
  assert.equal(readFakeAgyState(ctx.binDir).runs.length, 0);
});

// commands/resume.mjs prepares a resume's schema only for --allow-questions jobs and does not run
// the schema shape check; the cross-file note gives the call that makes this pass.
test("an invalid schema on resume exits before a successor is created", (t) => {
  const ctx = makeRepo(undefined, t);
  const first = run("node", [AGY, "task", "--json", "first"], { cwd: ctx.repo, env: ctx.env, check: true });
  const firstId = JSON.parse(first.stdout).jobId;
  const bad = path.join(ctx.repo, "objekt.json");
  fs.writeFileSync(bad, JSON.stringify({ type: "objekt" }));

  const resumed = run("node", [NEUTRAL, "resume", firstId, "--output-schema", bad, "--", "more"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(resumed.status, 1, resumed.stdout);
  assert.equal(storeJobs(ctx.repo).length, 1);
});

// ---------------------------------------------------------------------------------------------
// Worktree isolation

test("an agy --write --worktree task edits only the worktree", (t) => {
  const ctx = makeRepo("edit-readme", t);

  const result = run("node", [AGY, "task", "--write", "--worktree", "edit", "the", "readme"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(result.status, 0, result.stderr);
  const row = latestAgyJob(ctx.repo);
  const worktree = requestOf(row).worktree;
  assert.ok(worktree?.path && worktree.branch === `agent/${row.id}`, JSON.stringify(worktree));
  t.after(() => run("git", ["worktree", "remove", "--force", worktree.path], { cwd: ctx.repo }));
  assert.equal(run("git", ["status", "--short"], { cwd: ctx.repo }).stdout, "");
  assert.match(run("git", ["-C", worktree.path, "diff", "--stat"], { cwd: ctx.repo }).stdout, /README\.md/);
  assert.ok(result.stdout.includes(worktree.path), result.stdout);
  assert.ok(result.stdout.includes(`agent/${row.id}`), result.stdout);
  const prompt = readFakeAgyState(ctx.binDir).runs[0].inputs[0];
  const workLine = `Work only inside ${worktree.path}.`;
  assert.ok(prompt.includes(workLine), prompt);
  assert.ok(prompt.indexOf(workLine) < prompt.indexOf(DELEGATE_LINE), prompt);
});

test("an agy --resume-last of a worktree task keeps the worktree in its record and result", (t) => {
  const ctx = makeRepo(undefined, t);
  const first = run("node", [AGY, "task", "--write", "--worktree", "start"], { cwd: ctx.repo, env: ctx.env, timeout: 60000 });
  assert.equal(first.status, 0, first.stderr);
  const worktree = requestOf(latestAgyJob(ctx.repo)).worktree;
  assert.ok(worktree?.path, JSON.stringify(worktree));
  t.after(() => run("git", ["worktree", "remove", "--force", worktree.path], { cwd: ctx.repo, timeout: 60000 }));

  const resumed = run("node", [AGY, "task", "--write", "--resume-last", "more"], { cwd: ctx.repo, env: ctx.env, timeout: 60000 });

  assert.equal(resumed.status, 0, resumed.stderr);
  const successor = latestAgyJob(ctx.repo);
  assert.deepEqual(requestOf(successor).worktree, worktree);
  assert.ok(resumed.stdout.includes(worktree.path), resumed.stdout);
  assert.ok(resumed.stdout.includes(worktree.branch), resumed.stdout);
});

// ---------------------------------------------------------------------------------------------
// Review handoff and prompt files

test("an agy task from the last review uses a Codex review of this session", (t) => {
  const ctx = makeRepo(undefined, t);
  const env = { ...ctx.env, AGENT_PLUGIN_SESSION_ID: "session-handoff" };
  const stateDir = resolveStateDir(ctx.repo);
  // One finished Codex review of this session, as its worker stores it.
  const reviewId = withStore(stateDir, (store) =>
    createStoreJob(store, {
      provider: "codex",
      kind: "review",
      title: "Codex Review",
      prompt: "review the changes",
      request: { cwd: ctx.repo, review: { target: "changes", paths: [], stance: "peer", native: false, targetLabel: "the working tree" } },
      cwd: ctx.repo,
      requester: { sessionId: "session-handoff", leaderPid: null, leaderStartToken: null }
    }).jobId
  );
  rawExec(stateDir, "UPDATE jobs SET end_state = 'completed', end_at = ?, result_text = ? WHERE id = ?", [Date.now(), "REVIEW-FINDING-MARKER: the parser drops the last line.", reviewId]);

  const result = run("node", [AGY, "task", "--json", "--from-last-review", "fix", "it"], { cwd: ctx.repo, env });

  assert.equal(result.status, 0, result.stderr);
  const prompt = readFakeAgyState(ctx.binDir).runs[0].inputs[0];
  assert.ok(prompt.includes("REVIEW-FINDING-MARKER: the parser drops the last line."), prompt);
  assert.ok(prompt.includes(`Address the findings of the Codex review ${reviewId}`), prompt);
  assert.ok(prompt.includes("fix it"), prompt);

  const elsewhere = run("node", [AGY, "task", "--from-last-review", "fix", "it"], { cwd: ctx.repo, env: { ...ctx.env, AGENT_PLUGIN_SESSION_ID: "session-other" } });
  assert.equal(elsewhere.status, 1, elsewhere.stdout);
  assert.match(elsewhere.stderr, /No finished review with output was found in this session\. Run \/agent:codex-review or \/agent:agy-review first\./);
});

test("an agy task reads its prompt from --prompt-file", (t) => {
  const ctx = makeRepo(undefined, t);
  const file = path.join(ctx.repo, "prompt.md");
  fs.writeFileSync(file, "PROMPT-FILE-MARKER: summarise the README.\n");

  const result = run("node", [AGY, "task", "--json", "--prompt-file", file], { cwd: ctx.repo, env: ctx.env });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(readFakeAgyState(ctx.binDir).runs[0].inputs[0].startsWith("PROMPT-FILE-MARKER: summarise the README."));
});

// ---------------------------------------------------------------------------------------------
// Read-only stays read-only or fails

const GUARD_ON = { AGY_COMPANION_READONLY_GUARD: "on" };
const GUARD_OFF = { AGY_COMPANION_READONLY_GUARD: "off" };

test("with the guard on, a read-only task that edits a file fails and names it", async (t) => {
  const ctx = makeRepo("edit-readme", t);
  const env = { ...ctx.env, ...GUARD_ON };

  const result = run("node", [AGY, "task", "--json", "edit", "it"], { cwd: ctx.repo, env });

  assert.equal(result.status, 1, result.stdout);
  const reply = JSON.parse(result.stdout);
  assert.equal(reply.status, "failed");
  assert.equal(reply.error, "Antigravity edited files during a read-only task: README.md");

  // The driver resolves turnEnded in the worker's shape, with the guard's message.
  run("git", ["checkout", "--", "README.md"], { cwd: ctx.repo });
  const driver = createAgyDriver(null, { env });
  const job = { request_json: JSON.stringify({ sandbox: "read-only" }), thread_id: null, cwd: ctx.repo, allow_questions: 0 };
  const turnCtx = { job, cwd: ctx.repo, env, onThread() {}, onStarted() {}, onReceipt() {} };
  const spawned = await driver.spawn(turnCtx);
  t.after(() => stopOwnedProcess(spawned.child));
  await driver.start(turnCtx, { text: "edit it", clientId: "client-1" });
  const ended = await driver.turnEnded;
  assert.deepEqual(Object.keys(ended).sort(), ["error", "json", "status", "text"]);
  assert.equal(ended.status, "failed");
  assert.equal(ended.error, "Antigravity edited files during a read-only task: README.md");
  await spawned.exited;
});

test("the guard sees an edit to a file that was already modified", (t) => {
  const ctx = makeRepo("edit-readme", t);
  fs.writeFileSync(path.join(ctx.repo, "README.md"), "changed before the task\n");

  const result = run("node", [AGY, "task", "--json", "edit", "it"], { cwd: ctx.repo, env: { ...ctx.env, ...GUARD_ON } });

  assert.equal(result.status, 1, result.stdout);
  assert.equal(JSON.parse(result.stdout).error, "Antigravity edited files during a read-only task: README.md");
});

test("snapshotWorkingTree records both paths of a rename", async (t) => {
  const repo = makeTempDir(t);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  run("git", ["add", "a.txt"], { cwd: repo });
  run("git", ["commit", "-m", "a"], { cwd: repo });
  run("git", ["mv", "a.txt", "b.txt"], { cwd: repo });

  const snapshot = await readonlyGuard.snapshotWorkingTree(repo);

  assert.ok(snapshot.has("a.txt"), JSON.stringify([...snapshot.keys()]));
  assert.ok(snapshot.has("b.txt"), JSON.stringify([...snapshot.keys()]));
  assert.equal(await readonlyGuard.snapshotWorkingTree(makeTempDir(t)), null);
  assert.deepEqual(readonlyGuard.changedPaths(new Map([["x", "1"], ["y", "2"]]), new Map([["y", "3"], ["z", "4"]])), ["x", "y", "z"]);
});

test("a write-tool event fails a read-only task, also outside git", (t) => {
  const ctx = makeRepo("write-tool", t);
  const plain = makeTempDir(t);
  for (const cwd of [ctx.repo, plain]) {
    const result = run("node", [AGY, "task", "--json", "write", "notes"], { cwd, env: { ...ctx.env, ...GUARD_ON } });
    assert.equal(result.status, 1, result.stdout);
    const reply = JSON.parse(result.stdout);
    assert.equal(reply.status, "failed");
    assert.match(reply.error, /^Antigravity edited files during a read-only task: .*agy-fake-outside[\\/]notes\.txt$/);
  }
});

test("with the guard on, a read-only task that changes nothing completes", (t) => {
  const ctx = makeRepo(undefined, t);

  const result = run("node", [AGY, "task", "--json", "look"], { cwd: ctx.repo, env: { ...ctx.env, ...GUARD_ON } });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "completed");
});

test("with the guard off the worker takes no snapshot and applies no guard", (t) => {
  const ctx = makeRepo("edit-readme", t);

  const result = run("node", [AGY, "task", "--json", "edit", "it"], { cwd: ctx.repo, env: { ...ctx.env, ...GUARD_OFF } });

  assert.equal(result.status, 0, result.stderr);
  const reply = JSON.parse(result.stdout);
  assert.equal(reply.status, "completed");
  assert.doesNotMatch(String(reply.error ?? ""), /edited files/);
  assert.equal(readonlyGuard.readOnlyGuardMode(GUARD_OFF), "off");
  assert.equal(readonlyGuard.readOnlyGuardMode({}), readonlyGuard.READ_ONLY_ENFORCED_BY_FLAGS ? "off" : "on");
});

// ---------------------------------------------------------------------------------------------
// Delegate parity

test("task-resume-candidate reports the newest resumable agy job of the session", (t) => {
  const ctx = makeRepo(undefined, t);
  const env = { ...ctx.env, AGENT_PLUGIN_SESSION_ID: "session-candidate" };
  const first = run("node", [AGY, "task", "--json", "first"], { cwd: ctx.repo, env, check: true });
  const jobId = JSON.parse(first.stdout).jobId;

  const found = run("node", [AGY, "task-resume-candidate", "--json"], { cwd: ctx.repo, env });
  const fresh = run("node", [AGY, "task-resume-candidate", "--json"], { cwd: ctx.repo, env: { ...ctx.env, AGENT_PLUGIN_SESSION_ID: "session-fresh" } });

  assert.equal(found.status, 0, found.stderr);
  assert.deepEqual(JSON.parse(found.stdout), { available: true, jobId, threadId: "conv-1", label: null, status: "completed", provider: "agy" });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.deepEqual(JSON.parse(fresh.stdout), { available: false, jobId: null, threadId: null, label: null, status: null, provider: "agy" });
});

// Model ids and efforts as a fake `agy models` and `agy --help` would list them.
const FAKE_MODELS = ["x-low", "x-medium", "deep-high-low", "deep-high-medium", "gpt-oss-120b-medium", "gemini-pro-orchestrator-neon"];
const FAKE_EFFORTS = ["low", "medium", "high", "xhigh"];

function resolveFake(model, effort = null, catalogStatus = "available") {
  return agyRuntime.resolveAgyModel({ model, effort, models: catalogStatus === "available" ? FAKE_MODELS : [], efforts: FAKE_EFFORTS, catalogStatus });
}

test("resolveAgyModel joins a base name and an effort, and runs a full id as given", () => {
  assert.deepEqual(resolveFake("x", "low"), { model: "x-low", effort: "low" });
  assert.deepEqual(resolveFake("x-medium"), { model: "x-medium", effort: "medium" });
  // A base that itself ends in an effort word is split at its last word only.
  assert.deepEqual(resolveFake("deep-high", "medium"), { model: "deep-high-medium", effort: "medium" });
  assert.deepEqual(resolveFake("deep-high-low"), { model: "deep-high-low", effort: "low" });
  assert.deepEqual(agyRuntime.agyModelEfforts("deep-high", FAKE_MODELS, FAKE_EFFORTS), ["low", "medium"]);
  assert.deepEqual(agyRuntime.agyModelEfforts("x", FAKE_MODELS, FAKE_EFFORTS), ["low", "medium"]);
});

test("resolveAgyModel refuses an effort given twice or not at all, with the spec texts", () => {
  for (const effort of ["low", "medium"]) {
    assert.deepEqual(resolveFake("x-low", effort), {
      error: "Antigravity model x-low already includes effort low. Use either --model x-low, or --model x --effort <effort>."
    });
  }
  assert.deepEqual(resolveFake("x"), {
    error: "Antigravity model x needs an effort. Use --model x-<effort> or --model x --effort <effort>; x has: low, medium."
  });
  assert.deepEqual(resolveFake("x", "high"), {
    error: "Antigravity model x has no effort high. Use --model x-<effort> or --model x --effort <effort>; x has: low, medium."
  });
});

test("resolveAgyModel handles a single-variant base and a model without efforts", () => {
  assert.deepEqual(resolveFake("gpt-oss-120b-medium"), { model: "gpt-oss-120b-medium", effort: "medium" });
  assert.deepEqual(resolveFake("gpt-oss-120b", "medium"), { model: "gpt-oss-120b-medium", effort: "medium" });
  assert.match(resolveFake("gpt-oss-120b").error, /^Antigravity model gpt-oss-120b needs an effort\. .*; gpt-oss-120b has: medium\.$/);
  assert.deepEqual(resolveFake("gemini-pro-orchestrator-neon"), { model: "gemini-pro-orchestrator-neon", effort: null });
  assert.match(resolveFake("gemini-pro-orchestrator-neon", "low").error, /^Antigravity model gemini-pro-orchestrator-neon has no efforts/);
  assert.match(resolveFake("nope").error, /^Model "nope" is not in the Antigravity model list\. Available: x-low, /);
});

test("resolveAgyModel without a model list runs full ids and joined names unchecked", () => {
  for (const status of ["unavailable", "empty"]) {
    const warning = (id) => `The Antigravity model list is unavailable, so "${id}" was not checked.`;
    assert.deepEqual(resolveFake("y-high", null, status), { model: "y-high", effort: "high", warning: warning("y-high") });
    assert.deepEqual(resolveFake("y", "low", status), { model: "y-low", effort: "low", warning: warning("y-low") });
    assert.match(resolveFake("y", null, status).error, /^Antigravity model y needs an effort\. Use --model y-<effort> or --model y --effort <effort>; /);
    assert.match(resolveFake("y-high", "high", status).error, /already includes effort high/);
  }
});
