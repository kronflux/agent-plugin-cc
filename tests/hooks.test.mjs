import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import { readStdinIfPiped } from "../plugins/agent/scripts/lib/fs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_HOOK = path.join(ROOT, "plugins", "agent", "scripts", "session-lifecycle-hook.mjs");

function runSessionStart(envFile, sessionId, cwd) {
  const result = run(process.execPath, [SESSION_HOOK, "SessionStart"], {
    cwd,
    env: { ...process.env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: path.join(cwd, "data") },
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: sessionId, cwd })
  });
  assert.equal(result.status, 0, result.stderr);
}

function exportsOf(envFile, name) {
  return fs
    .readFileSync(envFile, "utf8")
    .split("\n")
    .filter((line) => line.startsWith(`export ${name}=`));
}

test("repeated SessionStart runs add each export once and keep other hooks' lines", () => {
  const cwd = makeTempDir();
  const envFile = path.join(cwd, "env.sh");
  fs.writeFileSync(envFile, "export OTHER=1\n");

  for (let attempt = 0; attempt < 5; attempt += 1) {
    runSessionStart(envFile, "sess-1", cwd);
  }

  assert.deepEqual(exportsOf(envFile, "AGENT_PLUGIN_SESSION_ID"), ["export AGENT_PLUGIN_SESSION_ID='sess-1'"]);
  assert.equal(exportsOf(envFile, "CLAUDE_PLUGIN_DATA").length, 1);
  assert.deepEqual(exportsOf(envFile, "OTHER"), ["export OTHER=1"]);
});

test("a changed value is appended so the latest export wins", () => {
  const cwd = makeTempDir();
  const envFile = path.join(cwd, "env.sh");

  for (const sessionId of ["sess-a", "sess-b", "sess-b", "sess-a"]) {
    runSessionStart(envFile, sessionId, cwd);
  }

  assert.deepEqual(exportsOf(envFile, "AGENT_PLUGIN_SESSION_ID"), [
    "export AGENT_PLUGIN_SESSION_ID='sess-a'",
    "export AGENT_PLUGIN_SESSION_ID='sess-b'",
    "export AGENT_PLUGIN_SESSION_ID='sess-a'"
  ]);
});

test("stdin data that arrives with pauses is read in full", async () => {
  const payload = JSON.stringify({ hook_event_name: "Stop", session_id: "s" });
  const stdin = new PassThrough();
  const reading = readStdinIfPiped({ stdin, firstByteTimeoutMs: 1000, totalTimeoutMs: 5000 });
  stdin.write(payload.slice(0, 10));
  await new Promise((resolve) => setTimeout(resolve, 50));
  stdin.end(payload.slice(10));

  assert.equal(await reading, payload);
});

test("a piped stdin with no writer reads as empty after the first-byte timeout", { timeout: 5000 }, async () => {
  const startedAt = Date.now();
  const text = await readStdinIfPiped({ stdin: new PassThrough(), firstByteTimeoutMs: 100 });
  assert.equal(text, "");
  assert.ok(Date.now() - startedAt < 2000);
});

test("SessionEnd has a 10 second timeout and the launch flags match NODE_LAUNCH_FLAGS", async () => {
  const { NODE_LAUNCH_FLAGS } = await import("../plugins/agent/scripts/lib/store.mjs");
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, "plugins", "agent", "hooks", "hooks.json"), "utf8")).hooks;
  const entry = (event) => hooks[event][0].hooks[0];
  assert.equal(entry("SessionEnd").timeout, 10);
  assert.equal(entry("SessionStart").timeout, 5);
  for (const event of ["SessionStart", "SessionEnd", "Stop"]) {
    const { command, args } = entry(event);
    assert.equal(command, "node", event);
    assert.deepEqual(args.slice(0, NODE_LAUNCH_FLAGS.length), [...NODE_LAUNCH_FLAGS], event);
    assert.match(args[NODE_LAUNCH_FLAGS.length], /^\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/.+\.mjs$/, event);
  }
  const monitors = JSON.parse(fs.readFileSync(path.join(ROOT, "plugins", "agent", "monitors", "monitors.json"), "utf8"));
  assert.ok(monitors[0].command.startsWith(`node ${NODE_LAUNCH_FLAGS.join(" ")} "\${CLAUDE_PLUGIN_ROOT}/scripts/job-monitor.mjs"`), monitors[0].command);
});

test("session variables fall back to the names older sessions export", async () => {
  const { getSessionId, getTranscriptPath } = await import("../plugins/agent/scripts/lib/host.mjs");
  const legacy = { CODEX_COMPANION_SESSION_ID: "old-sess", CODEX_COMPANION_TRANSCRIPT_PATH: "/old/t.jsonl" };
  assert.equal(getSessionId(legacy), "old-sess");
  assert.equal(getTranscriptPath(legacy), "/old/t.jsonl");
  assert.equal(getSessionId({ ...legacy, AGENT_PLUGIN_SESSION_ID: "" }), "old-sess");
  const both = { ...legacy, AGENT_PLUGIN_SESSION_ID: "new-sess", AGENT_PLUGIN_TRANSCRIPT_PATH: "/new/t.jsonl" };
  assert.equal(getSessionId(both), "new-sess");
  assert.equal(getTranscriptPath(both), "/new/t.jsonl");
  assert.equal(getSessionId({}), null);
  assert.equal(getTranscriptPath({}), null);
});

// ---------------------------------------------------------------------------------------------
// SessionEnd on the job store. Jobs run in test-driver workers (tests/store-fixtures.mjs), whose
// provider is the fixture's fake; provider ids codex and agy only name the rows.

const SESSION = "sess-end";
const NODE_FLAGS = ["--disable-warning=ExperimentalWarning"];
// Cleanup contracts for both provider ids on this platform, so a tree stop, an own exit or an
// owner death the hook or a worker witnessed releases confirmed on Windows; Linux uses the empty
// process group.
const TEST_CONTRACTS = JSON.stringify(
  ["codex", "agy"].flatMap((provider) =>
    ["own-exit", "tree-stop", "owner-death"].map((trigger) => ({ provider, platform: process.platform, trigger, version: "0.0.1", windowMs: 0 }))
  )
);

const stateLib = await import("../plugins/agent/scripts/lib/state.mjs");
const storeLib = await import("../plugins/agent/scripts/lib/store.mjs");
const processLib = await import("../plugins/agent/scripts/lib/process.mjs");
const mailboxLib = await import("../plugins/agent/scripts/lib/mailbox.mjs");
const fixtures = await import("./store-fixtures.mjs");

function storeEnv(extra = {}) {
  return { AGENT_PLUGIN_TEST_CONTRACTS: TEST_CONTRACTS, AGENT_PLUGIN_TEST_WORKER_ENTRY: fixtures.FIXTURE_SCRIPT, ...extra };
}

// A workspace folder with an opened store; `maxParallel` goes to the state folder's config.json.
function storeWorkspace(t, { maxParallel = null } = {}) {
  const cwd = makeTempDir(t);
  const stateDir = stateLib.resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  if (maxParallel) {
    fs.writeFileSync(path.join(stateDir, "config.json"), `${JSON.stringify({ maxParallel })}\n`);
  }
  const store = storeLib.openStore(stateDir);
  t.after(() => store.close());
  return { cwd, stateDir, store, tracked: fixtures.trackProcesses(t) };
}

let jobClock = 0;
function createStoreJob(store, { provider = "codex", sessionId = SESSION, testDriver = {}, prompt = "do the work", leader = null, label = null } = {}) {
  // Jobs created in one millisecond tie on created_at; each creation takes the next millisecond.
  const until = Math.max(Date.now(), jobClock) + 1;
  while (Date.now() < until) {
    // A short busy wait.
  }
  jobClock = Date.now();
  return stateLib.createJob(
    store,
    {
      provider,
      kind: "task",
      title: `${provider} job`,
      prompt,
      request: { cwd: ".", testDriver },
      cwd: ".",
      requester: { sessionId, leaderPid: leader?.pid ?? null, leaderStartToken: leader?.startToken ?? null }
    },
    { label }
  ).jobId;
}

// Starts a job's test-driver worker; the worker, and its provider once recorded, are stopped when
// the test ends if they still run.
function startJob(ws, jobId, env = {}) {
  const worker = fixtures.startTestWorker(ws.stateDir, jobId, storeEnv(env), ws.tracked);
  worker.exitedAt = null;
  worker.child.once("exit", () => (worker.exitedAt = performance.now()));
  return worker;
}

function trackProviders(ws, jobIds) {
  for (const jobId of jobIds) {
    ws.tracked.push(...fixtures.providerIdentities(ws.stateDir, jobId));
  }
}

async function waitRunning(ws, jobIds, timeoutMs = 90000) {
  await fixtures.waitFor(
    () =>
      jobIds.every((jobId) => {
        const row = fixtures.jobRow(ws.stateDir, jobId);
        return row.started_at !== null && row.provider_pid !== null;
      }),
    { timeoutMs, intervalMs: 100, describe: "every job running with a recorded provider" }
  );
  trackProviders(ws, jobIds);
}

// Runs the hook as Claude Code does; resolves with its exit code, output and the time from the
// spawn to its exit.
function runHookAsync(cwd, input, env = {}) {
  const startedAt = performance.now();
  const child = spawn(process.execPath, [...NODE_FLAGS, SESSION_HOOK, input.hook_event_name], {
    cwd,
    env: { ...process.env, ...storeEnv(env) },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(JSON.stringify(input));
  const done = new Promise((resolve) =>
    child.on("close", (code) => resolve({ code, stdout, stderr, elapsedMs: performance.now() - startedAt, startedAt }))
  );
  done.child = child;
  done.startedAt = startedAt;
  return done;
}

function sessionEnd(cwd, sessionId = SESSION, reason = "other") {
  return { hook_event_name: "SessionEnd", session_id: sessionId, reason, cwd };
}

// Confirms each of `targets` present by its identity, then probes it with signal 0 every 20 ms
// until it is gone. Resolves to `{ done }`, a promise of the wall time each was first seen gone
// (null for one still there at `timeoutMs`, or one that was not present at the start). A signal 0
// probe stops nothing.
async function watchAbsence(targets, timeoutMs = 15000) {
  const identities = await processLib.readProcessIdentities(
    targets.map((target) => target.pid),
    { deadline: performance.now() + 10000 }
  );
  const watched = targets.filter((target) => processLib.confirmIdentity(target, identities.get(target.pid)) === "present");
  assert.equal(watched.length, targets.length, "every watched process is present at the start");
  const seen = new Map();
  const until = performance.now() + timeoutMs;
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  };
  const poll = async () => {
    while (seen.size < watched.length && performance.now() < until) {
      for (const target of watched) {
        if (!seen.has(target.pid) && !alive(target.pid)) {
          seen.set(target.pid, Date.now());
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return targets.map((target) => seen.get(target.pid) ?? null);
  };
  return { done: poll() };
}

function rootOf(ws, jobId) {
  const row = fixtures.jobRow(ws.stateDir, jobId);
  return { pid: row.provider_pid, startToken: row.provider_start_token };
}

function logFileOf(ws, jobId) {
  return path.join(ws.stateDir, "store", "artifacts", `${jobId}.log`);
}

test("session end stops delegates and keeps everything", { timeout: 120000 }, async (t) => {
  const ws = storeWorkspace(t);
  const completed = createStoreJob(ws.store, { testDriver: { delayMs: 10 } });
  await startJob(ws, completed).exit;
  const codex = createStoreJob(ws.store, { provider: "codex", testDriver: { delayMs: 600000 } });
  const agy = createStoreJob(ws.store, { provider: "agy", testDriver: { delayMs: 600000 } });
  const other = createStoreJob(ws.store, { provider: "codex", sessionId: "sess-other", testDriver: { delayMs: 600000 } });
  for (const jobId of [codex, agy, other]) {
    startJob(ws, jobId);
  }
  await waitRunning(ws, [codex, agy, other]);
  const messageId = mailboxLib.sendToChain(ws.store, { ref: codex }, { text: "a note" }).messageId;
  const roots = [rootOf(ws, codex), rootOf(ws, agy)];
  const before = fixtures.dumpTables(ws.stateDir);

  const absence = await watchAbsence(roots);
  const hook = await runHookAsync(ws.cwd, sessionEnd(ws.cwd));
  const absentAt = await absence.done;

  assert.equal(hook.code, 0, hook.stderr);
  t.diagnostic(`hook ${Math.round(hook.elapsedMs)} ms; stderr: ${hook.stderr.trim() || "(none)"}`);
  assert.ok(hook.elapsedMs < 8000, `the hook took ${hook.elapsedMs} ms`);
  const after = fixtures.dumpTables(ws.stateDir);
  assert.equal(after.jobs.length, before.jobs.length);
  assert.equal(after.chains.length, before.chains.length);
  assert.ok(after.messages.some((row) => row.id === messageId));
  [codex, agy].forEach((jobId, index) => {
    const row = fixtures.jobRow(ws.stateDir, jobId);
    assert.equal(row.end_state, "interrupted", jobId);
    assert.equal(row.end_reason, "session-end", jobId);
    assert.ok(["confirmed", "unobserved"].includes(row.release_kind), `${jobId} release ${row.release_kind}`);
    assert.equal(row.prompt, "do the work");
    assert.ok(fs.existsSync(logFileOf(ws, jobId)), `the log of ${jobId} remains`);
    assert.ok(absentAt[index] !== null && absentAt[index] - row.stop_requested_at <= 5000, `root of ${jobId} absent ${absentAt[index] - row.stop_requested_at} ms after the stop`);
  });
  const keptBefore = before.jobs.find((row) => row.id === completed);
  const kept = fixtures.jobRow(ws.stateDir, completed);
  assert.deepEqual([kept.end_state, kept.end_at, kept.result_text], [keptBefore.end_state, keptBefore.end_at, keptBefore.result_text]);
  assert.ok(fs.existsSync(logFileOf(ws, completed)));
  const untouched = fixtures.jobRow(ws.stateDir, other);
  assert.equal(untouched.stop_requested_at, null);
  assert.equal(untouched.end_state, null);
  assert.equal(processLib.confirmIdentity(rootOf(ws, other), await processLib.readProcessIdentity(untouched.provider_pid)), "present");
});

test("/clear stops nothing", { timeout: 90000 }, async (t) => {
  const ws = storeWorkspace(t);
  const jobs = [
    createStoreJob(ws.store, { testDriver: { delayMs: 600000 } }),
    createStoreJob(ws.store, { provider: "agy", testDriver: { delayMs: 600000 } })
  ];
  for (const jobId of jobs) {
    startJob(ws, jobId);
  }
  await waitRunning(ws, jobs);

  const hook = await runHookAsync(ws.cwd, sessionEnd(ws.cwd, SESSION, "clear"));

  assert.equal(hook.code, 0, hook.stderr);
  for (const jobId of jobs) {
    const row = fixtures.jobRow(ws.stateDir, jobId);
    assert.equal(row.stop_requested_at, null);
    assert.equal(row.end_state, null);
    assert.equal(stateLib.jobState(row), "running");
  }
});

// The worker of a job blocks at `point`, so it neither handles a stop nor ends its provider.
function pausedEnv(t, point) {
  const dir = makeTempDir(t);
  return { dir, point, env: { AGENT_PLUGIN_TEST_POINTS: point, AGENT_PLUGIN_TEST_POINTS_DIR: dir } };
}

async function waitPaused(paused, worker) {
  await fixtures.waitFor(() => fs.existsSync(path.join(paused.dir, `${paused.point}-${worker.pid}.reached`)), {
    timeoutMs: 60000,
    describe: `the worker reached ${paused.point}`
  });
}

test("an unstoppable provider keeps its job stopping", { timeout: 90000 }, async (t) => {
  const ws = storeWorkspace(t);
  const paused = pausedEnv(t, "before-end");
  const jobId = createStoreJob(ws.store, { testDriver: { delayMs: 50 } });
  const worker = startJob(ws, jobId, paused.env);
  await waitPaused(paused, worker);
  trackProviders(ws, [jobId]);

  const hook = await runHookAsync(ws.cwd, sessionEnd(ws.cwd), { AGENT_PLUGIN_TEST_PROCESS: JSON.stringify({ stopFails: true }) });

  assert.equal(hook.code, 0, hook.stderr);
  const row = fixtures.jobRow(ws.stateDir, jobId);
  assert.ok(row, "the row remains");
  assert.notEqual(row.stopping_since, null);
  assert.equal(row.stopping_cause, "unconfirmed-stop");
  assert.equal(row.end_state, null);
  assert.equal(row.exec_released_at, null);
  assert.equal(stateLib.jobState(row), "stopping");
  assert.match(hook.stderr, new RegExp(`${jobId} \\(stopping`));
  assert.throws(
    () => stateLib.decideNext(ws.store, { ref: jobId, observedTipId: jobId }, { action: "continue", requester: { sessionId: SESSION } }),
    stateLib.JobStoppingError
  );
});

for (const variant of ["A", "B"]) {
  test(`session end stops a live worker whose job already ended (${variant})`, { timeout: 90000 }, async (t) => {
    const ws = storeWorkspace(t);
    const paused = pausedEnv(t, "before-shutdown");
    const jobId = createStoreJob(ws.store, { testDriver: { delayMs: 50 } });
    const worker = startJob(ws, jobId, paused.env);
    await waitPaused(paused, worker);
    trackProviders(ws, [jobId]);
    let successor = null;
    if (variant === "B") {
      successor = stateLib.decideNext(
        ws.store,
        { ref: jobId, observedTipId: jobId },
        { action: "continue", message: "more", requester: { sessionId: SESSION } }
      ).successorId;
      assert.ok(successor);
    }
    const before = fixtures.jobRow(ws.stateDir, jobId);
    const eventsBefore = fixtures.rawAll(ws.stateDir, "SELECT * FROM events WHERE job_id = ?", [jobId]);
    assert.equal(before.end_state, "completed");
    const targets = [{ pid: before.worker_pid, startToken: before.worker_start_token }, rootOf(ws, jobId)];

    const absence = await watchAbsence(targets);
    const hook = await runHookAsync(ws.cwd, sessionEnd(ws.cwd));
    const absentAt = await absence.done;

    assert.equal(hook.code, 0, hook.stderr);
    const row = fixtures.jobRow(ws.stateDir, jobId);
    assert.notEqual(row.stop_requested_at, null);
    assert.notEqual(row.stop_deadline, null);
    assert.deepEqual(
      [row.end_state, row.end_at, row.end_by, row.end_reason],
      [before.end_state, before.end_at, before.end_by, before.end_reason]
    );
    assert.deepEqual(fixtures.rawAll(ws.stateDir, "SELECT * FROM events WHERE job_id = ?", [jobId]), eventsBefore);
    assert.ok(["confirmed", "unobserved"].includes(row.release_kind), `release ${row.release_kind}; stderr ${hook.stderr}`);
    for (const at of absentAt) {
      assert.ok(at !== null && at - row.stop_requested_at <= 5000, `absent ${at - row.stop_requested_at} ms after the stop`);
    }
    if (successor) {
      const next = fixtures.jobRow(ws.stateDir, successor);
      assert.equal(next.end_state, "interrupted");
      assert.equal(next.end_reason, "session-end");
      assert.equal(next.stop_requested_at, row.stop_requested_at);
    }
  });
}

test("an earlier committed deadline ends that worker's wait first", { timeout: 90000 }, async (t) => {
  const ws = storeWorkspace(t);
  const paused = pausedEnv(t, "before-end");
  const early = createStoreJob(ws.store, { testDriver: { delayMs: 50 } });
  const late = createStoreJob(ws.store, { testDriver: { delayMs: 50 } });
  const workers = [startJob(ws, early, paused.env), startJob(ws, late, paused.env)];
  for (const worker of workers) {
    await waitPaused(paused, worker);
  }
  trackProviders(ws, [early, late]);
  const earlier = stateLib.requestStop(ws.store, { jobIds: [early] }, { reason: "leader-gone", afterMs: 1500 });

  const hook = await runHookAsync(ws.cwd, sessionEnd(ws.cwd));

  assert.equal(hook.code, 0, hook.stderr);
  const [earlyExit, lateExit] = workers.map((worker) => worker.exitedAt);
  assert.ok(earlyExit !== null && lateExit !== null, `both workers were stopped; stderr ${hook.stderr}`);
  t.diagnostic(`early worker gone ${Math.round(earlyExit - hook.startedAt)} ms, late ${Math.round(lateExit - hook.startedAt)} ms after the hook started`);
  assert.ok(lateExit - earlyExit >= 1000, `the early worker exited ${Math.round(lateExit - earlyExit)} ms before the late one`);
  const row = fixtures.jobRow(ws.stateDir, early);
  assert.equal(row.stop_deadline, earlier.storedDeadline);
  assert.equal(row.stop_reason, "leader-gone");
  assert.equal(fixtures.jobRow(ws.stateDir, late).stop_reason, "session-end");
});

test("session end sends no stop to a worker before its stored deadline", { timeout: 90000 }, async (t) => {
  const ws = storeWorkspace(t);
  const paused = pausedEnv(t, "before-end");
  const jobId = createStoreJob(ws.store, { testDriver: { delayMs: 50 } });
  const worker = startJob(ws, jobId, paused.env);
  await waitPaused(paused, worker);
  trackProviders(ws, [jobId]);
  let exitWall = null;
  worker.child.once("exit", () => (exitWall = Date.now()));

  // Each identity query of the wait takes 700 ms longer than the stop's own query.
  const hook = await runHookAsync(ws.cwd, sessionEnd(ws.cwd), { AGENT_PLUGIN_TEST_POLL_QUERY_DELAY_MS: "700" });

  assert.equal(hook.code, 0, hook.stderr);
  const row = fixtures.jobRow(ws.stateDir, jobId);
  assert.notEqual(exitWall, null, `the worker was not stopped; stderr ${hook.stderr}`);
  t.diagnostic(`the worker exited ${exitWall - row.stop_deadline} ms after its deadline`);
  // The deadline is stored rounded to the millisecond.
  assert.ok(exitWall >= row.stop_deadline - 1, `the worker was stopped ${row.stop_deadline - exitWall} ms before its deadline`);
});

// Seeds `count` ended, released jobs in one chain each, half of them of the ending session.
async function seedEndedJobs(stateDir, count) {
  const now = Date.now() - 60000;
  const chains = [];
  const jobs = [];
  for (let index = 0; index < count; index += 1) {
    const id = `seed-${index}`;
    const at = now + index;
    chains.push({ id, tip_job_id: id, created_at: at, activity_at: at });
    jobs.push({
      id,
      chain_id: id,
      provider: index % 2 ? "agy" : "codex",
      kind: "task",
      title: "seeded job",
      prompt: "old work",
      request_json: "{}",
      cwd: ".",
      session_id: index % 2 ? SESSION : "sess-old",
      created_at: at,
      updated_at: at,
      exec_gen: 1,
      claimed_at: at,
      exec_released_at: at,
      release_kind: "confirmed",
      end_state: "completed",
      end_at: at,
      end_by: "worker"
    });
  }
  await fixtures.seedStore(stateDir, { chains, jobs });
}

// Holds the store's write lock for `holdMs` from a second process; resolves to `{ done }` once it
// holds it, where `done` settles when the holder exits.
async function holdWriteLock(t, stateDir, holdMs) {
  const readyFile = path.join(makeTempDir(t), "ready");
  const holder = fixtures.runLibChild("fixture.holdLock", [stateDir, holdMs, readyFile]);
  await fixtures.waitFor(() => fs.existsSync(readyFile), { timeoutMs: 10000, intervalMs: 10, describe: "the writer holds the lock" });
  return { done: holder };
}

const CONTENTION_RUNS = [
  { name: "a writer during the open", writerAt: "before", holdMs: 900 },
  { name: "a writer during the stop transaction", writerAt: 300, holdMs: 900 },
  { name: "a writer during the wait", writerAt: 2600, holdMs: 900 },
  { name: "a writer during the forced stops", writerAt: 4300, holdMs: 900 },
  { name: "a writer during the end transaction", writerAt: 5400, holdMs: 900 },
  { name: "process queries slowed by 300 ms", env: { AGENT_PLUGIN_TEST_PROCESS: JSON.stringify({ queryDelayMs: 300 }) } },
  { name: "a stop transaction that cannot commit", writerAt: "before", holdMs: 3500, noCommit: true }
];

test("the session-end hook fits its budget under contention", { timeout: 900000 }, async (t) => {
  for (const variant of CONTENTION_RUNS) {
    await t.test(variant.name, { timeout: 180000 }, async (st) => {
      const ws = storeWorkspace(st, { maxParallel: { codex: 10, agy: 10 } });
      await seedEndedJobs(ws.stateDir, 180);
      const jobIds = [];
      for (let index = 0; index < 20; index += 1) {
        jobIds.push(createStoreJob(ws.store, { provider: index % 2 ? "agy" : "codex", testDriver: { delayMs: 600000, ignoreInterrupt: true } }));
      }
      const workers = jobIds.map((jobId) => startJob(ws, jobId));
      await waitRunning(ws, jobIds, 150000);
      assert.equal(fixtures.rawAll(ws.stateDir, "SELECT count(*) AS n FROM jobs")[0].n, 200);
      const roots = jobIds.map((jobId) => rootOf(ws, jobId));
      const absence = await watchAbsence(roots, 20000);

      let writer = null;
      if (variant.writerAt === "before") {
        writer = await holdWriteLock(st, ws.stateDir, variant.holdMs);
      }
      const hookRun = runHookAsync(ws.cwd, sessionEnd(ws.cwd), variant.env ?? {});
      if (typeof variant.writerAt === "number") {
        await new Promise((resolve) => setTimeout(resolve, variant.writerAt));
        writer = await holdWriteLock(st, ws.stateDir, variant.holdMs);
      }
      const hook = await hookRun;
      const absentAt = await absence.done;
      await writer?.done;

      const exits = workers.map((worker) => (worker.exitedAt === null ? null : Math.round(worker.exitedAt - hook.startedAt)));
      st.diagnostic(
        `hook ${Math.round(hook.elapsedMs)} ms; worker exits after the spawn: ${Math.min(...exits.filter((n) => n !== null))}` +
          `..${Math.max(...exits.filter((n) => n !== null))} ms; stderr: ${hook.stderr.trim() || "(none)"}`
      );
      assert.equal(hook.code, 0, hook.stderr);
      assert.ok(hook.elapsedMs < 8000, `the hook took ${Math.round(hook.elapsedMs)} ms`);
      if (variant.noCommit) {
        assert.match(hook.stderr, /The job store was busy; stop requests were not recorded/);
        // A worker that could not read its own start token when it claimed (a slow identity
        // query) cannot be stopped by verified identity; the hook names it instead.
        const unverifiable = jobIds.filter((jobId) => fixtures.jobRow(ws.stateDir, jobId).worker_start_token === null);
        jobIds.forEach((jobId, index) => {
          if (unverifiable.includes(jobId)) {
            assert.match(hook.stderr, new RegExp(`not confirmed stopped: .*${jobId}`));
            return;
          }
          const exit = exits[index];
          assert.ok(exit !== null && exit >= 5500 && exit <= 7300, `the worker of ${jobId} exited ${exit} ms after the hook's spawn`);
        });
        for (const jobId of jobIds) {
          assert.equal(fixtures.jobRow(ws.stateDir, jobId).stop_requested_at, null);
        }
        return;
      }
      const stopping = [];
      jobIds.forEach((jobId, index) => {
        const row = fixtures.jobRow(ws.stateDir, jobId);
        const state = stateLib.jobState(row);
        assert.ok(state === "interrupted" || state === "stopping", `${jobId} reads ${state}`);
        if (state === "interrupted") {
          assert.ok(["confirmed", "unobserved"].includes(row.release_kind), `${jobId} release ${row.release_kind}`);
          assert.notEqual(absentAt[index], null, `the root of interrupted ${jobId} is gone`);
        } else {
          stopping.push(jobId);
        }
        assert.ok(absentAt[index] !== null && absentAt[index] - row.stop_requested_at <= 5000, `root of ${jobId} absent ${absentAt[index] - row.stop_requested_at} ms after the stop`);
      });
      const listed = [...hook.stderr.matchAll(/(task-[a-z0-9-]+) \(stopping/g)].map((match) => match[1]).sort();
      assert.deepEqual(listed, stopping.sort());
    });
  }
});

// ---------------------------------------------------------------------------------------------
// SessionStart on the job store.

// Seeds `chainCount` chains of two jobs each (an answered ancestor and its tip); `tips` and
// `firsts` map a chain index to the tip's and the ancestor's fields. Every other job is
// completed. Returns the tip ids by index.
async function seedChains(stateDir, chainCount, tips = {}, firsts = {}) {
  const now = Date.now() - 600000;
  const chains = [];
  const jobs = [];
  const tipIds = [];
  const base = (id, chainId, at, fields) => ({
    id,
    chain_id: chainId,
    provider: "codex",
    kind: "task",
    title: "seeded job",
    prompt: `work of ${id}`,
    request_json: "{}",
    cwd: ".",
    session_id: "sess-old",
    created_at: at,
    updated_at: at,
    ...fields
  });
  for (let index = 0; index < chainCount; index += 1) {
    const chainId = `chain-${String(index).padStart(3, "0")}`;
    const first = `${chainId}-a`;
    const tip = `${chainId}-b`;
    const at = now + index * 10;
    chains.push({ id: chainId, tip_job_id: tip, created_at: at, activity_at: at + 1 });
    jobs.push(base(first, chainId, at, { end_state: "completed", end_at: at, end_by: "worker", next_action: "continue", next_at: at, ...(firsts[index] ?? {}) }));
    jobs.push(base(tip, chainId, at + 1, { continues: first, end_state: "completed", end_at: at + 1, end_by: "worker", ...(tips[index] ?? {}) }));
    tipIds.push(tip);
  }
  await fixtures.seedStore(stateDir, { chains, jobs });
  return tipIds;
}

// A leader that is gone: this process's id with a start token it does not have.
const GONE_LEADER = { leader_pid: process.pid, leader_start_token: "0" };

async function aliveLeader() {
  const identity = await processLib.readProcessIdentity(process.pid, { deadline: performance.now() + 10000 });
  return { leader_pid: process.pid, leader_start_token: identity.startToken };
}

function interruptedTip(extra = {}) {
  return { end_state: "interrupted", end_reason: "session-end", end_by: "hook", ...GONE_LEADER, ...extra };
}

function sessionStartInput(cwd, sessionId) {
  return { hook_event_name: "SessionStart", session_id: sessionId, cwd };
}

function contextNote(stdout) {
  if (!stdout.trim()) {
    return "";
  }
  return JSON.parse(stdout).hookSpecificOutput.additionalContext;
}

function withoutNotes(dump) {
  const { job_notes: _notes, ...rest } = dump;
  return rest;
}

test("the next session is told once, within 2 seconds", { timeout: 120000 }, async (t) => {
  for (const blocked of [false, true]) {
    const ws = storeWorkspace(t);
    const tipIds = await seedChains(ws.stateDir, 100, {
      10: interruptedTip(),
      20: interruptedTip({ label: "fix-tests" }),
      30: { end_state: "waiting", end_by: "worker", question: "which branch?", ...GONE_LEADER },
      40: interruptedTip(await aliveLeader()),
      50: interruptedTip({ leader_start_token: null })
    });
    const listed = [tipIds[10], tipIds[20], tipIds[30]];
    const before = fixtures.dumpTables(ws.stateDir);
    assert.equal(before.jobs.length, 200);
    const envFile = path.join(ws.cwd, "env.sh");
    const writer = blocked ? await holdWriteLock(t, ws.stateDir, 1500) : null;

    const first = await runHookAsync(ws.cwd, sessionStartInput(ws.cwd, "sess-new"), { CLAUDE_ENV_FILE: envFile });
    await writer?.done;
    const second = await runHookAsync(ws.cwd, sessionStartInput(ws.cwd, "sess-new"), { CLAUDE_ENV_FILE: envFile });

    t.diagnostic(`${blocked ? "with" : "without"} a writer: ${Math.round(first.elapsedMs)} ms, then ${Math.round(second.elapsedMs)} ms`);
    for (const run of [first, second]) {
      assert.equal(run.code, 0, run.stderr);
      assert.ok(run.elapsedMs < 2000, `the hook took ${Math.round(run.elapsedMs)} ms`);
    }
    assert.deepEqual(exportsOf(envFile, "AGENT_PLUGIN_SESSION_ID"), ["export AGENT_PLUGIN_SESSION_ID='sess-new'"]);
    const firstNote = contextNote(first.stdout);
    const secondNote = contextNote(second.stdout);
    for (const jobId of [tipIds[40], tipIds[50]]) {
      assert.doesNotMatch(firstNote + secondNote, new RegExp(jobId));
    }
    assert.deepEqual(withoutNotes(fixtures.dumpTables(ws.stateDir)), withoutNotes(before));
    const noted = fixtures.rawAll(ws.stateDir, "SELECT job_id FROM job_notes WHERE session_id = 'sess-new' ORDER BY job_id").map((row) => row.job_id);
    if (!blocked) {
      for (const jobId of listed) {
        assert.match(firstNote, new RegExp(jobId));
        assert.doesNotMatch(secondNote, new RegExp(jobId));
      }
      assert.match(firstNote, /\/agent:resume /);
      assert.match(firstNote, /\/agent:cancel /);
      assert.match(firstNote, /\(fix-tests\)/);
      assert.match(firstNote, /Codex/);
      assert.match(firstNote, /waiting/);
      assert.equal(secondNote, "");
      assert.deepEqual(noted, [...listed].sort());
    } else {
      // Whatever the first run could note is listed once in all.
      for (const jobId of listed) {
        assert.equal([firstNote, secondNote].filter((note) => note.includes(jobId)).length, 1, jobId);
      }
    }
  }
});

test("tips beyond the first ten are noted on a later start", { timeout: 60000 }, async (t) => {
  const ws = storeWorkspace(t);
  const tips = {};
  for (let index = 0; index < 12; index += 1) {
    tips[index] = interruptedTip();
  }
  const tipIds = await seedChains(ws.stateDir, 12, tips);

  const first = await runHookAsync(ws.cwd, sessionStartInput(ws.cwd, "sess-new"));
  const second = await runHookAsync(ws.cwd, sessionStartInput(ws.cwd, "sess-new"));
  const third = await runHookAsync(ws.cwd, sessionStartInput(ws.cwd, "sess-new"));

  const inFirst = tipIds.filter((jobId) => contextNote(first.stdout).includes(jobId));
  const inSecond = tipIds.filter((jobId) => contextNote(second.stdout).includes(jobId));
  assert.equal(inFirst.length, 10);
  assert.equal(inSecond.length, 2);
  assert.deepEqual([...inFirst, ...inSecond].sort(), [...tipIds].sort());
  assert.equal(contextNote(third.stdout), "");
});

test("an answered ancestor is not announced", { timeout: 60000 }, async (t) => {
  for (const variant of ["A", "B"]) {
    const ws = storeWorkspace(t);
    // J waited for an answer and was continued by X: completed in A, running under another
    // session in B.
    const tip =
      variant === "A"
        ? { end_state: "completed", end_at: Date.now(), end_by: "worker", label: "j-label" }
        : { end_state: null, end_at: null, end_by: null, session_id: "sess-other", exec_gen: 1, claimed_at: Date.now(), started_at: Date.now(), worker_pid: process.pid, worker_start_token: "0" };
    const tipIds = await seedChains(ws.stateDir, 1, { 0: tip }, { 0: { end_state: "waiting", question: "which branch?", ...GONE_LEADER } });
    const waitingAncestor = tipIds[0].replace(/-b$/, "-a");

    const run = await runHookAsync(ws.cwd, sessionStartInput(ws.cwd, "sess-new"));

    assert.equal(run.code, 0, run.stderr);
    assert.doesNotMatch(contextNote(run.stdout), new RegExp(waitingAncestor), variant);
    assert.equal(contextNote(run.stdout), "", variant);
  }
});

test("a job continued after discovery read it is not noted", { timeout: 60000 }, async (t) => {
  const ws = storeWorkspace(t);
  // Discovery read the waiting job J as its chain's tip; another session then continued it by X.
  const tipIds = await seedChains(ws.stateDir, 1, { 0: { end_state: null, end_at: null, end_by: null } }, { 0: { end_state: "waiting", question: "which branch?", ...GONE_LEADER } });
  const ancestor = tipIds[0].replace(/-b$/, "-a");

  assert.deepEqual(mailboxLib.noteJobs(ws.store, [ancestor], "sess-new"), []);
  assert.deepEqual(fixtures.rawAll(ws.stateDir, "SELECT job_id FROM job_notes"), []);
});

test("a failing runtime gate writes stderr, adds the note and exits 0", { timeout: 60000 }, async (t) => {
  for (const stub of ["3.51.2", "3.44.5", "3.50.6", "import-fail"]) {
    const cwd = makeTempDir(t);
    const envFile = path.join(cwd, "env.sh");
    const stateDir = stateLib.resolveStateDir(cwd);

    const run = await runHookAsync(cwd, sessionStartInput(cwd, "sess-gate"), { AGENT_PLUGIN_TEST_SQLITE_VERSION: stub, CLAUDE_ENV_FILE: envFile });

    assert.equal(run.code, 0, `${stub}: ${run.stderr}`);
    assert.match(run.stderr, /the job store needs SQLite 3\.51\.3 or later/, stub);
    assert.match(contextNote(run.stdout), /the job store needs SQLite 3\.51\.3 or later/, stub);
    if (stub !== "import-fail") {
      assert.match(run.stderr, new RegExp(stub.replace(/\./g, "\\.")), stub);
    }
    assert.equal(fs.existsSync(path.join(stateDir, "store")), false, `${stub} created no store folder`);
    assert.deepEqual(exportsOf(envFile, "AGENT_PLUGIN_SESSION_ID"), ["export AGENT_PLUGIN_SESSION_ID='sess-gate'"]);
  }
});
