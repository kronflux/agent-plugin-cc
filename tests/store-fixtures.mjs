// Fixtures for the job store tests: store folders, seeded rows, table dumps, child processes that
// run one library call, helper processes that stand in for workers and providers, and the trace
// the test driver's provider writes. Run as a script, it is the child side of these helpers.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const requireSqlite = () => createRequire(import.meta.url)("node:sqlite");
const LIB = path.join(path.dirname(SELF), "..", "plugins", "agent", "scripts", "lib");
const NODE_FLAGS = ["--disable-warning=ExperimentalWarning"];

const MODULES = {
  store: "store.mjs",
  state: "state.mjs",
  mailbox: "mailbox.mjs",
  process: "process.mjs",
  live: "live.mjs",
  tracked: "tracked-jobs.mjs",
  launch: "task-launch.mjs",
  control: "job-control.mjs",
  host: "host.mjs"
};

function importLib(name) {
  return import(pathToFileURL(path.join(LIB, MODULES[name])).href);
}

const leftoverDirs = new Set();
const runAsScript = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === SELF;
// The test helpers register a test-file hook when loaded, so the child side never loads them.
const helpers = runAsScript ? null : await import("./helpers.mjs");

function tryRemove(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    leftoverDirs.delete(dir);
  } catch {
    leftoverDirs.add(dir);
  }
}

if (!runAsScript) {
  // A folder a test could not remove at its end, because a connection of that test was still
  // open, is removed when the test file ends.
  const { after } = await import("node:test");
  after(() => {
    for (const dir of leftoverDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      } catch {
        process.stderr.write(`leftover temp folder: ${dir}
`);
      }
    }
  });
}

/** A fresh state folder for one test, removed when the test or the test file ends. */
export function makeStoreDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-store-test-"));
  leftoverDirs.add(dir);
  t.after(() => tryRemove(dir));
  return dir;
}

/**
 * Inserts rows into a store through plain SQL, creating the store first. `spec` maps table names
 * to arrays of row objects, inserted in the order chains, jobs, messages, events, thread_barriers,
 * event_marks, job_notes, meta. Foreign keys between chains and jobs are deferred to the commit.
 */
export async function seedStore(stateDir, spec = {}) {
  const { openStore } = await importLib("store");
  const store = openStore(stateDir);
  try {
    store.transact((db) => {
      db.exec("PRAGMA defer_foreign_keys = ON");
      for (const table of ["chains", "jobs", "messages", "events", "thread_barriers", "event_marks", "job_notes", "meta"]) {
        for (const row of spec[table] ?? []) {
          const columns = Object.keys(row);
          const sql = `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
          db.prepare(sql).run(...columns.map((column) => row[column]));
        }
      }
    });
  } finally {
    store.close();
  }
}

/**
 * Every row of every table, plus the schema version, for before-and-after comparisons. The dump
 * reads through its own plain connection, so it works on a store the library refuses to open.
 */
export function dumpTables(stateDir) {
  const { DatabaseSync } = requireSqlite();
  const db = new DatabaseSync(path.join(stateDir, "store", "state.db"));
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    db.exec("BEGIN");
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%' ORDER BY name")
        .all()
        .map((row) => row.name);
      const dump = { user_version: db.prepare("PRAGMA user_version").get().user_version };
      for (const table of tables) {
        dump[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => ({ ...row }));
      }
      return dump;
    } finally {
      db.exec("COMMIT");
    }
  } finally {
    db.close();
  }
}

/** Runs `sql` on a plain connection to the store's database, outside the library. */
export function rawExec(stateDir, sql, params = []) {
  const { DatabaseSync } = requireSqlite();
  const db = new DatabaseSync(path.join(stateDir, "store", "state.db"));
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    if (params.length === 0) {
      db.exec(sql);
      return null;
    }
    return db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

/** Runs one query on a plain connection to the store's database and returns its rows. */
export function rawAll(stateDir, sql, params = []) {
  const { DatabaseSync } = requireSqlite();
  const db = new DatabaseSync(path.join(stateDir, "store", "state.db"));
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    return db.prepare(sql).all(...params).map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

/** The JSON lines the test driver's provider recorded for a job, oldest first. */
export function readTrace(stateDir, jobId) {
  const file = path.join(stateDir, `trace-${jobId}.jsonl`);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function childEnv(env) {
  const merged = { ...process.env, ...env };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || value === null) {
      delete merged[key];
    }
  }
  return merged;
}

/**
 * Runs one library call in a child process. `op` is `<module>.<export>`; an argument of the form
 * `{ "$store": <stateDir> }` is replaced by a store opened in the child and closed afterwards.
 * With `FIXTURE_START_AT` (epoch ms) in `env`, the child waits until then before the call, so
 * several children start their calls together. Resolves to `{ ok, value, error, code, pid }`;
 * the returned promise carries the child as `.child`.
 */
// Children inherit the test process's environment, which tests/test-env.mjs already cleaned and
// pointed at the test's own plugin data folder; they do not load it again, so a child stopped by
// its pid leaves no folder of its own behind.

/** Spawns this file in `mode` with `args`; returns the child. */
export function spawnFixture(mode, args = [], env = {}, { detached = false } = {}) {
  return spawn(process.execPath, [...NODE_FLAGS, SELF, mode, ...args.map(String)], {
    env: childEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: detached && process.platform !== "win32"
  });
}

// Cleanup contracts for the test driver's provider on this platform, so a worker that saw its
// provider exit or stopped it releases confirmed on Windows; Linux uses the empty process group.
export const WORKER_CONTRACTS = JSON.stringify(
  ["stdin-end", "tree-stop", "owner-death"].map((trigger) => ({ provider: "codex", platform: process.platform, trigger, version: "0.0.1", windowMs: 0 }))
);

/**
 * The environment of a test-driver worker: the contracts above and this script as worker entry.
 * Without `contracts` the worker gets an empty list; an unset variable would give it the
 * contracts the provider itself declares.
 */
export function workerEnv(extra = {}, { contracts = true } = {}) {
  return { AGENT_PLUGIN_TEST_CONTRACTS: contracts ? WORKER_CONTRACTS : "[]", AGENT_PLUGIN_TEST_WORKER_ENTRY: SELF, ...extra };
}

/** Creates a job whose worker uses the test driver with `testDriver` as its behaviour. */
export async function createDriverJob(store, testDriver, overrides = {}) {
  const { createJob } = await importLib("state");
  // Jobs created in one millisecond tie on created_at and are ordered by their random ids, so
  // each creation waits for the next millisecond to keep creation order.
  const until = Date.now() + 2;
  while (Date.now() < until) {
    // A short busy wait.
  }
  return createJob(
    store,
    {
      provider: "codex",
      kind: "task",
      title: overrides.title ?? "driver job",
      prompt: overrides.prompt ?? "do the work",
      request: { cwd: ".", testDriver },
      cwd: ".",
      allowQuestions: overrides.allowQuestions ?? false,
      requester: overrides.requester ?? { sessionId: "session-1", leaderPid: null, leaderStartToken: null },
      threadId: overrides.threadId ?? null,
      force: overrides.force ?? false
    },
    { label: overrides.label ?? null }
  ).jobId;
}

/** Polls `predicate` until it returns a truthy value or `timeoutMs` passes. */
export async function waitFor(predicate, { timeoutMs = 20000, intervalMs = 50, describe = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) {
      return value;
    }
    if (Date.now() > until) {
      throw new Error(`${describe} did not happen within ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * A list of processes the test started, stopped through stopOwnedProcesses when the test ends:
 * held ChildProcess objects and recorded `{ pid, startToken }` identities. A bare pid is never
 * stopped.
 */
export function trackProcesses(t) {
  const targets = [];
  t.after(() => helpers.stopOwnedProcesses(targets));
  return targets;
}

/** The worker's `{ pid, startToken }` recorded in a job's row, or null without both. */
export function workerIdentity(stateDir, jobId) {
  const row = jobRow(stateDir, jobId);
  return row?.worker_pid && row.worker_start_token ? { pid: row.worker_pid, startToken: row.worker_start_token } : null;
}

/**
 * The recorded identities of a job's test provider: the provider root the worker recorded in the
 * job's row, and each child the provider started and recorded in the trace with its token.
 */
export function providerIdentities(stateDir, jobId) {
  const row = jobRow(stateDir, jobId);
  const identities = row?.provider_pid && row.provider_start_token ? [{ pid: row.provider_pid, startToken: row.provider_start_token }] : [];
  for (const entry of readTrace(stateDir, jobId)) {
    if (entry.type === "child-identity") {
      identities.push({ pid: entry.childPid, startToken: entry.startToken });
    }
  }
  return identities;
}

/** The recorded identities of a job's worker and provider processes. */
export function jobProcesses(stateDir, jobId) {
  return [workerIdentity(stateDir, jobId), ...providerIdentities(stateDir, jobId)].filter(Boolean);
}

/** The pids of the test provider (and any child it started) recorded in a job's trace. */
export function providerPids(stateDir, jobId) {
  return readTrace(stateDir, jobId)
    .flatMap((entry) => [entry.type === "spawned" ? entry.pid : null, entry.type === "child" ? entry.childPid : null])
    .filter(Boolean);
}

/** One job row read through a plain connection. */
export function jobRow(stateDir, jobId) {
  return rawAll(stateDir, "SELECT * FROM jobs WHERE id = ?", [jobId])[0];
}

/** The path of this fixture script, for AGENT_PLUGIN_TEST_WORKER_ENTRY. */
export const FIXTURE_SCRIPT = SELF;

/**
 * Starts a test-driver worker for a job as the launcher would (detached on POSIX, so it leads its
 * own process group). Resolves `exit` with its exit code; adds the ChildProcess to `tracked`.
 */
export function startTestWorker(stateDir, jobId, env = {}, tracked = []) {
  const child = spawnFixture("worker", ["--state-dir", stateDir, "--job", jobId], env, { detached: true });
  tracked.push(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exit = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal, stderr })));
  return { child, pid: child.pid, exit };
}

export function runLibChild(op, args = [], env = {}) {
  const child = spawn(process.execPath, [...NODE_FLAGS, SELF, "lib", op, JSON.stringify(args)], {
    env: childEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const done = new Promise((resolve) => {
    child.on("close", (code, signal) => {
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      let parsed = null;
      try {
        parsed = line ? JSON.parse(line) : null;
      } catch {
        parsed = null;
      }
      resolve({ ok: parsed?.ok ?? false, value: parsed?.value, error: parsed?.error ?? null, code, signal, stdout, stderr, pid: child.pid });
    });
  });
  done.child = child;
  return done;
}

/**
 * Starts a sleeping helper process, optionally with a sleeping child of its own, and resolves to
 * `{ pid, childPid, childStartToken, process }`. On POSIX the helper leads its own process group.
 * The caller stops the helper through `process` and the child through its pid and start token,
 * read while the helper, which holds the child, still ran.
 */
export async function startHelperProcess({ child = false } = {}) {
  const script = child
    ? `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000);`
    : `console.log(0);setInterval(()=>{},1000);`;
  const helper = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "ignore"],
    detached: process.platform !== "win32",
    windowsHide: true
  });
  const childPid = await new Promise((resolve, reject) => {
    let buffer = "";
    helper.stdout.on("data", (chunk) => {
      buffer += chunk;
      const line = buffer.split(/\r?\n/)[0];
      if (buffer.includes("\n")) {
        resolve(Number(line) || null);
      }
    });
    helper.on("error", reject);
    helper.on("exit", () => resolve(null));
  });
  let childStartToken = null;
  if (childPid) {
    const { readProcessIdentity } = await importLib("process");
    const identity = await readProcessIdentity(childPid, { deadline: performance.now() + 15000 });
    // The helper holds its child, so while the helper runs the id cannot pass to another process.
    if (identity.state === "present" && helper.exitCode === null && helper.signalCode === null) {
      childStartToken = identity.startToken;
    }
  }
  return { pid: helper.pid, childPid, childStartToken, process: helper };
}

// Replaces `{ "$store": dir }` arguments with opened stores.
function materialize(value, stores, openStore) {
  if (Array.isArray(value)) {
    return value.map((item) => materialize(item, stores, openStore));
  }
  if (value && typeof value === "object") {
    if (typeof value.$store === "string" && Object.keys(value).length <= 2) {
      // Several children open one store at the same instant. The 2 s default of one attempt is
      // too short for the last of them on a slow disk, and these calls have no retry around them.
      const store = openStore(value.$store, { busyTimeoutMs: 15000, ...(value.options ?? {}) });
      stores.push(store);
      return store;
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, materialize(item, stores, openStore)]));
  }
  return value;
}

function serializeError(error) {
  if (!(error instanceof Error)) {
    return { name: "Error", message: String(error) };
  }
  const extra = {};
  for (const [key, value] of Object.entries(error)) {
    if (value === undefined || typeof value === "function") {
      continue;
    }
    try {
      JSON.stringify(value);
      extra[key] = value;
    } catch {
      extra[key] = String(value);
    }
  }
  return { ...extra, name: error.name, message: error.message, class: error.class, code: error.code };
}

function jsonSafe(value) {
  return JSON.parse(
    JSON.stringify(value ?? null, (_key, item) => {
      if (item instanceof Map) {
        return Object.fromEntries(item);
      }
      if (item instanceof Set) {
        return [...item];
      }
      if (typeof item === "bigint") {
        return String(item);
      }
      return item;
    })
  );
}

function waitForStart() {
  const startAt = Number(process.env.FIXTURE_START_AT);
  if (Number.isFinite(startAt)) {
    while (Date.now() < startAt) {
      // A busy wait keeps the start times of sibling children within a few milliseconds.
    }
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Calls that exist only for tests; `runLibChild("fixture.<name>", ...)` runs them in a child.
const FIXTURE_OPS = {
  // Opens a store once, and once more after an availability error; reports what happened.
  async coldOpen(stateDir) {
    const { openStore } = await importLib("store");
    let firstError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const store = openStore(stateDir);
        const userVersion = store.read((db) => db.prepare("PRAGMA user_version").get().user_version);
        store.close();
        return { userVersion, firstError };
      } catch (error) {
        if (attempt === 0 && error?.class === "availability") {
          firstError = { class: error.class, code: error.code, message: error.message };
          sleepSync(50);
          continue;
        }
        throw error;
      }
    }
    return null;
  },
  // A worker's turn end: recordEnd(completed) with its result, then storeLateResult when it lost.
  async endWithLateResult(store, jobId, execGen, text) {
    const { recordEnd, storeLateResult } = await importLib("state");
    const result = { text, json: null, logged: false };
    const outcome = recordEnd(store, jobId, { state: "completed", by: "worker", execGen, result, leader: "unknown" });
    const late = outcome.won ? null : storeLateResult(store, jobId, execGen, result);
    return { won: outcome.won, late };
  },
  // Sends `count` messages to a chain one after another; returns their ids in sending order.
  async sendMany(store, ref, sender, count) {
    const { sendToChain } = await importLib("mailbox");
    const ids = [];
    for (let index = 0; index < count; index += 1) {
      ids.push(sendToChain(store, { ref }, { text: `${sender}${index}`, requester: null }).messageId);
    }
    return ids;
  },
  // A cancel that loses to a continuation cancels the new tip with an exact stop request.
  async cancelOrFollow(store, jobId, requester) {
    const { decideNext, requestStop } = await importLib("state");
    try {
      const outcome = decideNext(store, { ref: jobId, observedTipId: jobId }, { action: "cancel", requester });
      if (outcome.won || !outcome.successorId) {
        return { cancelled: jobId, outcome };
      }
      const stop = requestStop(store, { jobIds: [outcome.successorId] }, { reason: "cancel", cancel: true });
      return { cancelled: outcome.successorId, selection: stop.selection.length };
    } catch (error) {
      return { error: error.name };
    }
  },
  // A prune and its file cleanup, as the monitor and the commands run them.
  async prune(store, stateDir) {
    const { pruneChains } = await importLib("state");
    const { pruneArtifacts } = await importLib("store");
    const result = pruneChains(store, { now: Date.now() });
    const deleted = await pruneArtifacts(stateDir, result.prunedJobIds);
    return { ...result, deleted };
  },
  // One scan with no launches and no leader information.
  async scan(store) {
    const { scanWorkspace } = await importLib("state");
    return scanWorkspace(store, { deadline: performance.now() + 15000, launch: async () => null, leaderCheck: async () => new Map() });
  },
  // Holds the write lock on a plain connection for `ms`, after writing `readyFile`.
  holdLock(stateDir, ms, readyFile) {
    const { DatabaseSync } = requireSqlite();
    const db = new DatabaseSync(path.join(stateDir, "store", "state.db"));
    db.exec("PRAGMA busy_timeout = 10000");
    db.exec("BEGIN IMMEDIATE");
    fs.writeFileSync(readyFile, "held");
    sleepSync(ms);
    db.exec("COMMIT");
    db.close();
    return true;
  }
};

// One writer of the stress test: `count` inserts into the table `stress`, each through the store's
// command retry path, printing the key after its commit and a summary line at the end.
async function runWriter(stateDir, name, count) {
  const { openStore, withRetry, RETRY_BUDGETS } = await importLib("store");
  const store = openStore(stateDir);
  let retries = 0;
  let maxElapsedMs = 0;
  let maxAttemptMs = 0;
  for (let index = 0; index < count; index += 1) {
    const key = `${name}-${index}`;
    const started = performance.now();
    try {
      await withRetry(
        (opts) => {
          const attemptStart = performance.now();
          try {
            return store.transact((db) => {
              db.prepare("INSERT INTO stress (key, writer, at) VALUES (?, ?, ?)").run(key, name, Date.now());
            }, opts);
          } finally {
            maxAttemptMs = Math.max(maxAttemptMs, performance.now() - attemptStart);
          }
        },
        RETRY_BUDGETS.command,
        { onRetry: () => (retries += 1) }
      );
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ summary: true, name, failed: { class: error?.class, code: error?.code, message: error?.message }, index, retries })}
`);
      process.exit(1);
    }
    maxElapsedMs = Math.max(maxElapsedMs, performance.now() - started);
    process.stdout.write(`${key}
`);
  }
  store.close();
  process.stdout.write(`${JSON.stringify({ summary: true, name, failed: null, retries, maxElapsedMs, maxAttemptMs })}
`);
}

async function runLibOp(op, rawArgs) {
  const [moduleName, exportName] = op.split(".");
  const stores = [];
  try {
    const { openStore } = await importLib("store").catch(() => ({ openStore: null }));
    const mod = moduleName === "fixture" ? FIXTURE_OPS : await importLib(moduleName);
    await importLib("state");
    const fn = mod[exportName];
    if (typeof fn !== "function") {
      throw new TypeError(`${op} is not a function`);
    }
    const args = materialize(JSON.parse(rawArgs), stores, openStore);
    waitForStart();
    const value = await fn(...args);
    process.stdout.write(`${JSON.stringify({ ok: true, value: jsonSafe(value) })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: serializeError(error) })}\n`);
  } finally {
    for (const store of stores) {
      try {
        store.close();
      } catch {
        // A store that failed mid-call may already be closed.
      }
    }
  }
}


// ---------------------------------------------------------------------------------------------
// The test driver: a ProviderDriver whose provider is `node store-fixtures.mjs fake-provider`,
// speaking JSON lines over stdin and stdout. The job's `request_json.testDriver` sets its
// behaviour; the fake records every request it receives to <stateDir>/trace-<jobId>.jsonl.

function delayMs(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createTestDriver(stateDir) {
  let child = null;
  let behaviour = {};
  let resolveTurn = null;
  const waiters = new Map();
  const send = (message) => {
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // A provider that already exited takes no more requests.
    }
  };
  const waitFor = (type) =>
    new Promise((resolve) => {
      const list = waiters.get(type) ?? [];
      list.push(resolve);
      waiters.set(type, list);
    });
  const driver = {
    id: "test",
    resumeMethod: "thread",
    get capabilities() {
      return {
        steer: Boolean(behaviour.steer),
        interrupt: behaviour.interrupt !== false,
        history: Array.isArray(behaviour.historyPages),
        ownExit: behaviour.ownExit ?? Boolean(behaviour.exitAfterTurn)
      };
    },
    turnEnded: null,
    async spawn(ctx) {
      behaviour = JSON.parse(ctx.job.request_json).testDriver ?? {};
      // On Linux the provider leads its own process group, as the worker's driver contract asks.
      child = spawn(process.execPath, [SELF, "fake-provider", stateDir, ctx.job.id, JSON.stringify({ ...behaviour, rowThreadId: ctx.job.thread_id })], {
        stdio: ["pipe", "pipe", "ignore"],
        detached: process.platform === "linux",
        windowsHide: true
      });
      child.stdin.on("error", () => {});
      const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, at: Date.now() })));
      let buffer = "";
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines.filter(Boolean)) {
          const message = JSON.parse(line);
          if (message.type === "receipt") {
            ctx.onReceipt(message.clientId);
          } else if (message.type === "ended") {
            resolveTurn?.({ status: message.status, text: message.text ?? "", json: message.json ?? null, error: message.error ?? null });
          } else {
            const list = waiters.get(message.type) ?? [];
            list.shift()?.(message);
          }
        }
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      return { pid: child.pid, exited, child };
    },
    async prepare() {
      const answer = waitFor("prepared");
      send({ type: "prepare" });
      const prepared = await answer;
      if (behaviour.earlyPrefix) {
        // A deliberate defect for the tests that guard dispatch order: the first bytes of the next
        // request are written before the harness commits its dispatch. The pause keeps the prefix's
        // arrival measurably earlier than the commits, whose times have millisecond resolution.
        child.stdin.write('{"type":"start",');
        await delayMs(50);
      }
      return { threadId: prepared.threadId, turnInProgress: prepared.turnInProgress ?? null, version: prepared.version ?? null };
    },
    async start(ctx, { text, clientId }) {
      driver.turnEnded = new Promise((resolve) => (resolveTurn = resolve));
      const accepted = waitFor("accepted");
      if (behaviour.earlyPrefix) {
        child.stdin.write(`${JSON.stringify({ text, clientId }).slice(1)}\n`);
      } else {
        send({ type: "start", text, clientId });
      }
      const reply = await accepted;
      ctx.onTurn(reply.turnId);
      ctx.onStarted();
      return "written";
    },
    async steer(ctx, { text, clientId }) {
      const result = waitFor("steer-result");
      send({ type: "steer", text, clientId });
      return (await result).result;
    },
    async interrupt() {
      send({ type: "interrupt" });
    },
    async interruptPrevious(ctx, turnId, timeoutMs) {
      const ended = waitFor("previous-ended").then(() => "ended");
      send({ type: "interrupt-previous", turnId });
      return Promise.race([ended, delayMs(timeoutMs).then(() => "timeout")]);
    },
    async historyHas(ctx, clientIds) {
      if (!Array.isArray(behaviour.historyPages)) {
        return null;
      }
      const found = new Set();
      for (let page = 0; page < behaviour.historyPages.length; page += 1) {
        const reply = waitFor("history-page");
        send({ type: "history", page });
        for (const id of (await reply).clientIds) {
          if (clientIds.includes(id)) {
            found.add(id);
          }
        }
      }
      return found;
    },
    endInput() {
      child.stdin.end();
    }
  };
  return driver;
}

function runFakeProvider(stateDir, jobId, behaviourJson) {
  const behaviour = JSON.parse(behaviourJson);
  const traceFile = path.join(stateDir, `trace-${jobId}.jsonl`);
  const trace = (entry) => fs.appendFileSync(traceFile, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`);
  const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  trace({ type: "spawned" });
  if (behaviour.traceSelf) {
    // The provider's own identity, for a test whose worker dies before recording it.
    importLib("process")
      .then((lib) => lib.readProcessIdentity(process.pid, { deadline: performance.now() + 30000 }))
      .then((identity) => {
        if (identity.state === "present") {
          trace({ type: "child-identity", childPid: process.pid, startToken: identity.startToken });
        }
      })
      .catch(() => {});
  }
  if (behaviour.spawnChild) {
    const grandchild = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
    trace({ type: "child", childPid: grandchild.pid });
    // The provider holds its child, so the identity it reads is that child's.
    importLib("process")
      .then((lib) => lib.readProcessIdentity(grandchild.pid, { deadline: performance.now() + 30000 }))
      .then((identity) => {
        if (identity.state === "present") {
          trace({ type: "child-identity", childPid: grandchild.pid, startToken: identity.startToken });
        }
      })
      .catch(() => {});
  }
  let turn = null;
  const endTurn = (status, fields) => {
    if (!turn) {
      return;
    }
    clearTimeout(turn.timer);
    turn = null;
    trace({ type: "turn-ended", status });
    if (behaviour.exitAfterTurn) {
      // The provider exits on its own right after its turn, before its input is closed.
      trace({ type: "own-exit" });
      process.stdout.write(`${JSON.stringify({ type: "ended", status, ...fields })}\n`, () => process.exit(0));
      return;
    }
    out({ type: "ended", status, ...fields });
  };
  let buffer = "";
  // The time the first byte of the line being read arrived, so a request written in pieces is
  // dated by its first piece.
  let lineStartedAt = null;
  process.stdin.on("data", (chunk) => {
    const arrivedAt = Date.now();
    if (buffer.length === 0 && chunk.length > 0) {
      lineStartedAt = arrivedAt;
    }
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    const startedAt = lines.map((_, index) => (index === 0 ? lineStartedAt : arrivedAt));
    const newPartialLine = buffer.length > 0 && (lines.length > 0 || buffer.length === chunk.length);
    if (lines.length > 0) {
      lineStartedAt = buffer.length > 0 ? arrivedAt : null;
    }
    if (newPartialLine) {
      // The first bytes of a line that is not complete yet are recorded as they arrive, because
      // the line may never complete: the worker can die mid-line, and on Windows this process then
      // ends with it.
      trace({ type: "line-start", firstByteAt: lineStartedAt, prefix: buffer.slice(0, 40) });
    }
    for (const [index, line] of lines.entries()) {
      if (!line) {
        continue;
      }
      const message = JSON.parse(line);
      trace({ type: "request", request: message.type, text: message.text ?? null, clientId: message.clientId ?? null, firstByteAt: startedAt[index] });
      if (message.type === "prepare") {
        out({ type: "prepared", threadId: behaviour.rowThreadId ?? behaviour.threadId ?? `th-${jobId}`, turnInProgress: behaviour.turnInProgress ?? null, version: behaviour.version ?? "1.0.0" });
      } else if (message.type === "start") {
        turn = { clientId: message.clientId };
        out({ type: "accepted", turnId: `turn-${jobId}` });
        if (!behaviour.noReceipt) {
          out({ type: "receipt", clientId: message.clientId });
        }
        const text = behaviour.question ? `${behaviour.answer ?? "partial work"}\nAGENT-QUESTION: ${behaviour.question}` : (behaviour.answer ?? "done");
        const json = behaviour.structuredQuestion ? { question: behaviour.structuredQuestion } : (behaviour.json ?? null);
        turn.timer = setTimeout(
          () => endTurn(behaviour.fail ? "failed" : "answer", { text: behaviour.fail ? "" : text, json, error: behaviour.fail ? String(behaviour.fail === true ? "the turn failed" : behaviour.fail) : null }),
          behaviour.delayMs ?? 100
        );
      } else if (message.type === "steer") {
        setTimeout(() => {
          if (turn) {
            trace({ type: "steer-accepted", clientId: message.clientId, text: message.text });
            out({ type: "steer-result", result: "accepted" });
            out({ type: "receipt", clientId: message.clientId });
          } else {
            out({ type: "steer-result", result: "turn-ended" });
          }
        }, behaviour.steerDelayMs ?? 0);
      } else if (message.type === "interrupt") {
        if (!behaviour.ignoreInterrupt) {
          endTurn("answer", { text: "interrupted", json: null, error: null });
        }
      } else if (message.type === "interrupt-previous") {
        if (behaviour.previousEnds !== false) {
          out({ type: "previous-ended" });
        }
      } else if (message.type === "history") {
        out({ type: "history-page", clientIds: behaviour.historyPages?.[message.page] ?? [] });
      }
    }
  });
  process.stdin.on("end", () => {
    if (buffer.length > 0) {
      // A request cut off by the end of input, for example by the worker's death mid-line, still
      // shows when its first bytes arrived.
      trace({ type: "partial-request", firstByteAt: lineStartedAt, bytes: buffer.length });
    }
    trace({ type: "eof" });
    if (behaviour.ignoreEof || (turn && behaviour.ignoreInterrupt)) {
      return;
    }
    if (behaviour.forkAndExit) {
      // The provider starts a child in its own process group and exits at once; the child lives on
      // for `forkAndExit` ms and records when it ends.
      const lingerMs = Number(behaviour.forkAndExit) || 2500;
      const script = `setTimeout(()=>{require('node:fs').appendFileSync(${JSON.stringify(traceFile)},JSON.stringify({at:Date.now(),pid:process.pid,type:'forked-exit'})+'\\n');process.exit(0)},${lingerMs})`;
      const forked = spawn(process.execPath, ["-e", script], { stdio: "ignore", windowsHide: true });
      trace({ type: "forked", childPid: forked.pid });
      importLib("process")
        .then((lib) => lib.readProcessIdentity(forked.pid, { deadline: performance.now() + 5000 }))
        .then((identity) => {
          if (identity.state === "present") {
            trace({ type: "child-identity", childPid: forked.pid, startToken: identity.startToken });
          }
        })
        .catch(() => {})
        .finally(() => process.exit(0));
      return;
    }
    process.exit(0);
  });
  setInterval(() => {}, 1000);
}

function parseWorkerArgs(args) {
  const read = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
  };
  return { stateDir: read("--state-dir"), jobId: read("--job") };
}

async function runTestWorker(args) {
  const { stateDir, jobId } = parseWorkerArgs(args);
  const { openStore } = await importLib("store");
  const { readJobView } = await importLib("state");
  const store = openStore(stateDir);
  const view = readJobView(store, jobId);
  store.close();
  const behaviour = view ? (JSON.parse(view.row.request_json).testDriver ?? {}) : {};
  if (behaviour.exitBeforeClaim) {
    fs.appendFileSync(path.join(stateDir, `trace-${jobId}.jsonl`), `${JSON.stringify({ at: Date.now(), pid: process.pid, type: "worker-exit-before-claim" })}\n`);
    process.exit(0);
  }
  const { runJobExecution } = await importLib("tracked");
  const code = await runJobExecution(stateDir, jobId, createTestDriver(stateDir));
  process.exit(code);
}

// A long-lived reader standing for the monitor: one read every 250 ms; exits 1 naming the
// recovery when the store folder moved.
async function runReader(stateDir) {
  const { openStore } = await importLib("store");
  const store = openStore(stateDir);
  process.stdout.write("ready\n");
  for (;;) {
    try {
      store.read((db) => db.prepare("SELECT count(*) AS n FROM jobs").get());
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ class: error?.class, message: error?.message })}\n`);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// A waiting `send` stand-in: waits for a message to be consumed; exits 1 when the store moved.
async function runWaiter(stateDir, jobId, messageId) {
  const { waitForJob } = await importLib("tracked");
  process.stdout.write("ready\n");
  try {
    await waitForJob(stateDir, jobId, { until: "consumed", messageId: Number(messageId), timeoutMs: 600000 });
    process.exit(0);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ class: error?.class, message: error?.message })}\n`);
    process.exit(1);
  }
}

// A process that holds only a folder, as its working directory.
function runFolderHolder(dir) {
  process.chdir(dir);
  process.stdout.write("ready\n");
  setInterval(() => {}, 1000);
}

if (runAsScript) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "reader") {
    await runReader(rest[0]);
  }
  if (mode === "waiter") {
    await runWaiter(rest[0], rest[1], rest[2]);
  }
  if (mode === "folder-holder") {
    runFolderHolder(rest[0]);
  }
  if (mode === "worker") {
    await runTestWorker(rest);
  }
  if (mode === "fake-provider") {
    runFakeProvider(rest[0], rest[1], rest[2] ?? "{}");
  }
  if (mode === "lib") {
    await runLibOp(rest[0], rest[1] ?? "[]");
    process.exit(0);
  }
  if (mode === "writer") {
    await runWriter(rest[0], rest[1], Number(rest[2]));
    process.exit(0);
  }
}
