import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import * as fx from "./store-fixtures.mjs";
import { stopOwnedProcess, stopOwnedProcesses } from "./helpers.mjs";
import { dumpTables, makeStoreDir, rawAll, rawExec, runLibChild, spawnFixture, startHelperProcess } from "./store-fixtures.mjs";
import * as store from "../plugins/agent/scripts/lib/store.mjs";
import * as state from "../plugins/agent/scripts/lib/state.mjs";
import * as launch from "../plugins/agent/scripts/lib/task-launch.mjs";
import * as mailbox from "../plugins/agent/scripts/lib/mailbox.mjs";
import * as live from "../plugins/agent/scripts/lib/live.mjs";
import * as processLib from "../plugins/agent/scripts/lib/process.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The Node release that E-S1 measured as the lowest with a safe SQLite on the 22 line.
const MEASURED_NODE_FLOOR = "22.22.3";

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) {
      return (a[index] ?? 0) - (b[index] ?? 0);
    }
  }
  return 0;
}

test("the runtime gate accepts 3.51.3, 3.44.6 and 3.50.7 and refuses 3.51.2, 3.44.5, 3.50.6 and a failed import", async (t) => {
  const stateDir = makeStoreDir(t);
  const cases = [
    ["3.51.3", true],
    ["3.44.6", true],
    ["3.50.7", true],
    ["3.54.0", true],
    ["3.51.2", false],
    ["3.44.5", false],
    ["3.50.6", false],
    ["import-fail", false]
  ];
  const results = await Promise.all(
    cases.map(([version]) => runLibChild("store.checkRuntime", [], { AGENT_PLUGIN_TEST_SQLITE_VERSION: version }))
  );
  for (const [index, [version, expected]] of cases.entries()) {
    const result = results[index];
    assert.equal(result.ok, true, `${version}: ${result.stderr}`);
    assert.equal(result.value.ok, expected, version);
    assert.equal(result.value.node, process.version);
    if (!expected) {
      const message = store.runtimeGateMessage(result.value);
      assert.ok(message.includes(process.version), message);
      assert.ok(message.includes("3.51.3"), message);
      if (version === "import-fail") {
        assert.equal(result.value.sqlite, null);
        assert.ok(message.includes("none (node:sqlite did not load)"), message);
      } else {
        assert.equal(result.value.sqlite, version);
        assert.ok(message.includes(`SQLite ${version}`), message);
      }
    }
  }
  assert.equal(store.sqliteVersionPasses("3.51.3"), true);
  assert.equal(store.sqliteVersionPasses("3.45.0"), false);
  assert.equal(store.sqliteVersionPasses("4.0.0"), true);
  assert.equal(
    store.runtimeGateMessage({ ok: false, node: "v22.1.0", sqlite: "3.45.1" }),
    "Node v22.1.0 provides SQLite 3.45.1; the job store needs SQLite 3.51.3 or later (or 3.44.6+ within 3.44, 3.50.7+ within 3.50)."
  );
  assert.deepEqual(store.NODE_LAUNCH_FLAGS, ["--disable-warning=ExperimentalWarning"]);
  assert.equal(store.SYNCHRONOUS, "FULL");
  assert.equal(fs.existsSync(path.join(stateDir, "store")), false);
});

test("package.json engines.node is the measured floor", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.engines.node, `>=${MEASURED_NODE_FLOOR}`);
  assert.ok(compareVersions(MEASURED_NODE_FLOOR, "22.13.0") >= 0);
});

// ---------------------------------------------------------------------------------------------
// Connection, schema, migration, errors and deadlines

const SCHEMA_TABLES = ["chains", "event_marks", "events", "job_notes", "jobs", "messages", "meta", "thread_barriers"];

function startSoon(ms = 1500) {
  return String(Date.now() + ms);
}

function spinFor(ms) {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Spends time inside a callback without yielding.
  }
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function listTree(dir) {
  const entries = [];
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      entries.push(child);
      if (entry.isDirectory()) {
        walk(child);
      }
    }
  };
  walk("");
  return entries.sort();
}

function tableNames(stateDir) {
  return rawAll(stateDir, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%' ORDER BY name").map(
    (row) => row.name
  );
}

function lineCount(file) {
  return fs.readFileSync(file, "utf8").trim().split(/\r?\n/).length;
}

test("eight cold openers migrate a fresh store once", { timeout: 240000 }, async (t) => {
  for (let repetition = 0; repetition < 20; repetition += 1) {
    const stateDir = makeStoreDir(t);
    const countFile = path.join(stateDir, "migrations.txt");
    const env = { AGENT_PLUGIN_TEST_MIGRATION_COUNT_FILE: countFile, FIXTURE_START_AT: startSoon() };
    const results = await Promise.all(Array.from({ length: 8 }, () => runLibChild("fixture.coldOpen", [stateDir], env)));
    for (const result of results) {
      assert.equal(result.ok, true, `repetition ${repetition}: ${JSON.stringify(result.error)} ${result.stderr}`);
      assert.equal(result.value.userVersion, store.SCHEMA_VERSION);
      if (result.value.firstError) {
        assert.equal(result.value.firstError.class, "availability");
      }
    }
    assert.deepEqual(tableNames(stateDir), SCHEMA_TABLES);
    assert.equal(lineCount(countFile), 1, `repetition ${repetition}`);
    assert.equal(rawAll(stateDir, "PRAGMA user_version")[0].user_version, store.SCHEMA_VERSION);
  }
});

test("a store above SCHEMA_VERSION is refused naming both versions", (t) => {
  const stateDir = makeStoreDir(t);
  store.openStore(stateDir).close();
  rawExec(stateDir, `PRAGMA user_version = ${store.SCHEMA_VERSION + 1}`);
  const before = dumpTables(stateDir);
  assert.throws(
    () => store.openStore(stateDir),
    (error) =>
      error instanceof store.StoreError &&
      error.class === "future-version" &&
      error.message.includes(String(store.SCHEMA_VERSION + 1)) &&
      error.message.includes(String(store.SCHEMA_VERSION))
  );
  assert.deepEqual(dumpTables(stateDir), before);
  assert.equal(before.user_version, store.SCHEMA_VERSION + 1);
});

test("a current store upgrades to a test-only next version once under two competing opens", { timeout: 180000 }, async (t) => {
  for (let repetition = 0; repetition < 20; repetition += 1) {
    const stateDir = makeStoreDir(t);
    store.openStore(stateDir).close();
    const metaBefore = rawAll(stateDir, "SELECT * FROM meta ORDER BY key");
    const countFile = path.join(stateDir, "migrations.txt");
    const env = {
      AGENT_PLUGIN_TEST_EXTRA_MIGRATION: "1",
      AGENT_PLUGIN_TEST_MIGRATION_COUNT_FILE: countFile,
      FIXTURE_START_AT: startSoon(1200)
    };
    const results = await Promise.all([0, 1].map(() => runLibChild("fixture.coldOpen", [stateDir], env)));
    for (const result of results) {
      assert.equal(result.ok, true, `repetition ${repetition}: ${JSON.stringify(result.error)} ${result.stderr}`);
      assert.equal(result.value.userVersion, store.SCHEMA_VERSION + 1);
    }
    assert.equal(rawAll(stateDir, "PRAGMA user_version")[0].user_version, store.SCHEMA_VERSION + 1);
    assert.deepEqual(tableNames(stateDir), [...SCHEMA_TABLES, "test_extra_migration"].sort());
    assert.deepEqual(rawAll(stateDir, "SELECT * FROM meta ORDER BY key"), metaBefore);
    assert.equal(lineCount(countFile), 1, `repetition ${repetition}`);
  }
  const stateDir = makeStoreDir(t);
  store.openStore(stateDir).close();
  process.env.AGENT_PLUGIN_TEST_EXTRA_MIGRATION = "1";
  try {
    assert.throws(
      () => store.openStore(stateDir, { migrate: false }),
      (error) => error instanceof store.StoreError && error.class === "availability" && error.code === "not-migrated"
    );
  } finally {
    delete process.env.AGENT_PLUGIN_TEST_EXTRA_MIGRATION;
  }
  assert.equal(rawAll(stateDir, "PRAGMA user_version")[0].user_version, store.SCHEMA_VERSION);
});

// The columns each schema version after 1 added to the jobs table, newest last.
const COLUMNS_AFTER_V1 = ["provider_group_id", "provider_exit_seen_at"];

// Turns a store written by this version back into a version-1 store: the same tables without the
// columns later versions added.
function asVersion1Store(stateDir) {
  const columns = rawAll(stateDir, "PRAGMA table_info(jobs)").map((column) => column.name);
  for (const name of [...COLUMNS_AFTER_V1].reverse()) {
    if (columns.includes(name)) {
      rawExec(stateDir, `ALTER TABLE jobs DROP COLUMN ${name}`);
    }
  }
  rawExec(stateDir, "PRAGMA user_version = 1");
}

test("a version-1 store migrates to the current columns with old rows null", (t) => {
  const stateDir = makeStoreDir(t);
  const db = store.openStore(stateDir);
  const { jobId } = state.createJob(db, jobFields());
  db.close();
  rawExec(stateDir, `UPDATE jobs SET exec_gen = 1, claimed_at = 1, worker_pid = 11, worker_group_id = 11, provider_pid = 12 WHERE id = '${jobId}'`);
  asVersion1Store(stateDir);
  assert.equal(store.SCHEMA_VERSION, 3);
  const migrated = store.openStore(stateDir);
  migrated.close();
  assert.equal(rawAll(stateDir, "PRAGMA user_version")[0].user_version, 3);
  const columns = rawAll(stateDir, "PRAGMA table_info(jobs)").map((column) => column.name);
  for (const name of COLUMNS_AFTER_V1) {
    assert.ok(columns.includes(name), `the ${name} column was not added`);
  }
  const row = rawAll(stateDir, "SELECT provider_pid, worker_group_id, provider_group_id, provider_exit_seen_at FROM jobs WHERE id = ?", [jobId])[0];
  assert.deepEqual(row, { provider_pid: 12, worker_group_id: 11, provider_group_id: null, provider_exit_seen_at: null });
});

test("the schema rejects every mutation the triggers guard", (t) => {
  const stateDir = makeStoreDir(t);
  const db = store.openStore(stateDir);
  t.after(() => db.close());
  db.transact((handle) => {
    handle.exec("PRAGMA defer_foreign_keys = ON");
    const insertChain = handle.prepare("INSERT INTO chains (id, tip_job_id, created_at, activity_at) VALUES (?, ?, 1, 1)");
    const insertJob = handle.prepare(
      `INSERT INTO jobs (id, chain_id, provider, kind, title, prompt, request_json, cwd, created_at, updated_at,
         end_state, end_at, end_by, next_action, next_at, next_session_id, cancelled_at)
       VALUES (?, ?, 'codex', 'task', 't', 'p', '{}', '.', 1, 1, 'completed', 1, 'worker', ?, 1, 'owner', ?)`
    );
    insertChain.run("c1", "c1");
    insertJob.run("c1", "c1", "cancel", 1);
    insertChain.run("c2", "c2");
    insertJob.run("c2", "c2", "continue", null);
    handle.prepare("INSERT INTO messages (chain_id, text, created_at) VALUES ('c1', 'hello', 1)").run();
    handle
      .prepare("UPDATE messages SET state = 'dispatched', attempts = 1, dispatched_at = 1, dispatched_job_id = 'c1', dispatched_gen = 1")
      .run();
  });
  const ROLLBACK = new Error("rollback");
  const attempt = (sql) => {
    try {
      db.transact((handle) => {
        handle.prepare(sql).run();
        throw ROLLBACK;
      });
    } catch (error) {
      return error === ROLLBACK ? "accepted" : "rejected";
    }
    return "accepted";
  };
  const cases = {
    "UPDATE jobs SET next_at = 2 WHERE id = 'c1'": "rejected",
    "UPDATE jobs SET next_session_id = 'other' WHERE id = 'c1'": "rejected",
    "UPDATE jobs SET next_action = 'continue', next_at = 5, next_session_id = 'new' WHERE id = 'c1'": "accepted",
    "UPDATE jobs SET next_action = 'cancel' WHERE id = 'c2'": "rejected",
    "UPDATE jobs SET cancelled_at = 9 WHERE id = 'c1'": "rejected",
    "UPDATE jobs SET end_reason = 'x' WHERE id = 'c1'": "rejected",
    "UPDATE messages SET state = 'dispatched', attempts = 0": "rejected",
    "UPDATE messages SET state = 'dispatched', attempts = 1": "rejected",
    "UPDATE messages SET state = 'dispatched', attempts = 2": "accepted",
    "UPDATE messages SET attempts = 0": "rejected",
    "UPDATE messages SET attempts = 2": "accepted",
    "UPDATE messages SET state = 'consumed', attempts = 2, consumed_job_id = 'c1', consumed_at = 3": "rejected",
    "INSERT INTO messages (chain_id, text, created_at, attempts) VALUES ('c1', 'x', 1, 1)": "rejected",
    "UPDATE messages SET text = 'changed'": "rejected",
    "UPDATE messages SET state = 'pending'": "rejected"
  };
  const before = dumpTables(stateDir);
  for (const [sql, expected] of Object.entries(cases)) {
    assert.equal(attempt(sql), expected, sql);
  }
  assert.deepEqual(dumpTables(stateDir), before);
});

test("transact and read refuse an async callback and a nested call", (t) => {
  const stateDir = makeStoreDir(t);
  const db = store.openStore(stateDir);
  t.after(() => db.close());
  const before = dumpTables(stateDir);
  assert.throws(() => db.transact(async (handle) => handle.prepare("INSERT INTO meta (key, value) VALUES ('x', 'y')").run()), TypeError);
  assert.throws(() => db.read(() => Promise.resolve(1)), TypeError);
  assert.throws(() => db.transact(() => db.transact(() => 1)), TypeError);
  assert.throws(() => db.transact(() => db.read(() => 1)), TypeError);
  assert.throws(() => db.read(() => db.transact(() => 1)), TypeError);
  assert.throws(() => db.transact((handle) => handle.exec("COMMIT")), TypeError);
  assert.equal(db.inTransaction(), false);
  assert.deepEqual(dumpTables(stateDir), before);
  assert.equal(db.transact(() => 7), 7);
});

test("a corrupt state.db is refused and nothing is written", (t) => {
  const stateDir = makeStoreDir(t);
  store.openStore(stateDir).close();
  const storeDir = path.join(stateDir, "store");
  const log = path.join(storeDir, "artifacts", "job-1.log");
  fs.writeFileSync(log, "some output\n");
  fs.writeFileSync(path.join(storeDir, "state.db"), Buffer.from(Array.from({ length: 16384 }, (_, index) => (index * 7919) % 251)));
  const snapshot = () => ({ db: sha256(path.join(storeDir, "state.db")), log: sha256(log), tree: listTree(stateDir) });
  const before = snapshot();
  assert.throws(
    () => store.openStore(stateDir),
    (error) => error instanceof store.StoreError && error.class === "corruption" && error.message.includes("store recover")
  );
  assert.deepEqual(snapshot(), before);
});

test("a late statement on an open connection obeys the caller's phase deadline", { timeout: 30000 }, async (t) => {
  const stateDir = makeStoreDir(t);
  const db = store.openStore(stateDir);
  t.after(() => db.close());
  const ready = path.join(stateDir, "held.txt");
  const holder = runLibChild("fixture.holdLock", [stateDir, 2000, ready]);
  const until = Date.now() + 10000;
  while (!fs.existsSync(ready) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(fs.existsSync(ready), "the lock holder did not start");
  const deadline = performance.now() + 300;
  let statementStart = 0;
  let thrown = null;
  try {
    db.read(
      (handle) => {
        spinFor(200);
        statementStart = performance.now();
        handle.prepare("INSERT INTO meta (key, value) VALUES ('late', 'x')").run();
      },
      { deadline }
    );
  } catch (error) {
    thrown = error;
  }
  const waited = performance.now() - statementStart;
  t.diagnostic(`late statement waited ${Math.round(waited)} ms`);
  assert.ok(thrown instanceof store.StoreError && thrown.class === "availability", String(thrown));
  assert.ok(waited <= 250, `waited ${waited} ms`);
  assert.throws(
    () => db.read(() => 1, { deadline: performance.now() - 1 }),
    (error) => error instanceof store.StoreError && error.class === "availability" && error.code === "deadline"
  );
  assert.equal(db.inTransaction(), false);
  await holder;
});

test("two monitors reserving the integrity check get one reservation", { timeout: 120000 }, async (t) => {
  for (let repetition = 0; repetition < 20; repetition += 1) {
    const stateDir = makeStoreDir(t);
    store.openStore(stateDir).close();
    const env = { FIXTURE_START_AT: startSoon(1000) };
    const now = Date.now();
    const results = await Promise.all([0, 1].map(() => runLibChild("store.reserveIntegrityCheck", [{ $store: stateDir }, { now }], env)));
    assert.deepEqual(
      results.map((result) => result.value).sort(),
      [false, true],
      `repetition ${repetition}: ${JSON.stringify(results.map((result) => result.error))}`
    );
  }
  const stateDir = makeStoreDir(t);
  const db = store.openStore(stateDir);
  t.after(() => db.close());
  assert.equal(store.checkIntegrity(db), "ok");
  process.env.AGENT_PLUGIN_TEST_INTEGRITY_FAIL = "1";
  try {
    assert.notEqual(store.checkIntegrity(db), "ok");
  } finally {
    delete process.env.AGENT_PLUGIN_TEST_INTEGRITY_FAIL;
  }
});

test("eight writers keep every printed row when one is stopped mid-run", { timeout: 300000 }, async (t) => {
  const stateDir = makeStoreDir(t);
  store.openStore(stateDir).close();
  rawExec(stateDir, "CREATE TABLE stress (key TEXT PRIMARY KEY, writer TEXT NOT NULL, at INTEGER NOT NULL) STRICT");
  const names = Array.from({ length: 8 }, (_, index) => `w${index}`);
  const victim = "w3";
  const printed = new Map(names.map((name) => [name, []]));
  const summaries = new Map();
  const spawned = [];
  t.after(() => stopOwnedProcesses(spawned));
  let victimStopped = false;
  const exits = names.map(
    (name) =>
      new Promise((resolve) => {
        const child = spawnFixture("writer", [stateDir, name, 500]);
        spawned.push(child);
        let buffer = "";
        child.stdout.on("data", (chunk) => {
          buffer += chunk;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop();
          for (const line of lines.filter(Boolean)) {
            if (line.startsWith("{")) {
              summaries.set(name, JSON.parse(line));
              continue;
            }
            printed.get(name).push(line);
            if (name === victim && !victimStopped && printed.get(name).length === 100) {
              victimStopped = true;
              stopOwnedProcess(child);
            }
          }
        });
        child.on("close", (code, signal) => resolve({ name, code, signal }));
      })
  );
  const results = await Promise.all(exits);
  assert.ok(victimStopped, "the victim was not stopped");
  for (const result of results.filter((entry) => entry.name !== victim)) {
    const summary = summaries.get(result.name);
    assert.equal(result.code, 0, `${result.name}: ${JSON.stringify(summary)}`);
    assert.equal(summary?.failed, null, `${result.name}: ${JSON.stringify(summary)}`);
    assert.equal(printed.get(result.name).length, 500);
  }
  const rows = rawAll(stateDir, "SELECT key, writer FROM stress");
  const stored = new Set(rows.map((row) => row.key));
  for (const [name, keys] of printed) {
    for (const key of keys) {
      assert.ok(stored.has(key), `printed key ${key} of ${name} is missing`);
    }
  }
  const victimPrinted = new Set(printed.get(victim));
  const unprinted = rows.filter((row) => row.writer === victim && !victimPrinted.has(row.key));
  assert.ok(unprinted.length <= 1, `unprinted victim rows: ${unprinted.length}`);
  assert.equal(rawAll(stateDir, "PRAGMA integrity_check")[0].integrity_check, "ok");
  const others = [...summaries.values()].filter((summary) => summary.name !== victim);
  const retries = others.reduce((total, summary) => total + summary.retries, 0);
  const maxElapsed = Math.max(...others.map((summary) => summary.maxElapsedMs));
  const maxAttempt = Math.max(...others.map((summary) => summary.maxAttemptMs));
  t.diagnostic(
    `AC19 node ${process.version} sqlite ${process.versions.sqlite}: rows ${rows.length}, victim printed ${victimPrinted.size}, ` +
      `unprinted victim rows ${unprinted.length}, retries ${retries}, max elapsed per insert ${Math.round(maxElapsed)} ms, ` +
      `max attempt ${Math.round(maxAttempt)} ms`
  );
});

// ---------------------------------------------------------------------------------------------
// Jobs, chains, labels, views and references

function jobFields(overrides = {}) {
  return {
    provider: "codex",
    kind: "task",
    title: "a task",
    prompt: "do the thing",
    request: { cwd: "." },
    cwd: ".",
    model: null,
    allowQuestions: false,
    foreground: false,
    threadId: null,
    ephemeral: false,
    runId: null,
    requester: { sessionId: "session-1", leaderPid: null, leaderStartToken: null },
    ...overrides
  };
}

function openTestStore(t, stateDir) {
  const opened = store.openStore(stateDir);
  t.after(() => opened.close());
  return opened;
}

test("two creators of one label leave exactly one live chain", { timeout: 120000 }, async (t) => {
  for (let repetition = 0; repetition < 20; repetition += 1) {
    const stateDir = makeStoreDir(t);
    store.openStore(stateDir).close();
    const env = { FIXTURE_START_AT: startSoon(1000) };
    const results = await Promise.all(
      [0, 1].map((index) => runLibChild("state.createJob", [{ $store: stateDir }, jobFields({ title: `t${index}` }), { label: "r" }], env))
    );
    const winners = results.filter((result) => result.ok);
    const losers = results.filter((result) => !result.ok);
    assert.equal(winners.length, 1, `repetition ${repetition}: ${JSON.stringify(results.map((result) => result.error))}`);
    assert.equal(losers[0].error.name, "LabelInUseError");
    assert.equal(losers[0].error.holderJobId, winners[0].value.jobId);
    assert.deepEqual(rawAll(stateDir, "SELECT id, live_label FROM chains"), [{ id: winners[0].value.jobId, live_label: "r" }]);
    assert.equal(rawAll(stateDir, "SELECT count(*) AS n FROM jobs")[0].n, 1);
  }
});

test("an id reads that exact job and a label reads the chain tip", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const { jobId } = state.createJob(db, jobFields(), { label: "r" });
  rawExec(
    stateDir,
    `UPDATE jobs SET thread_id = 'th-1', submit_intent_at = 1, end_state = 'interrupted', end_at = 2, end_by = 'worker',
       result_text = 'stored result', result_at = 2, next_action = 'continue', next_at = 3 WHERE id = '${jobId}'`
  );
  rawExec(
    stateDir,
    `INSERT INTO jobs (id, chain_id, continues, provider, kind, title, label, prompt, request_json, cwd, thread_id,
       created_at, updated_at, claimed_at, worker_pid, exec_gen, started_at)
     VALUES ('job-x', '${jobId}', '${jobId}', 'codex', 'task', 'a task', 'r', 'do the thing', '{}', '.', 'th-1', 9000000000000, 3, 3, 1, 1, 4);
     UPDATE chains SET tip_job_id = 'job-x' WHERE id = '${jobId}';`
  );
  const exact = state.resolveExactJob(db, jobId);
  assert.equal(exact.id, jobId);
  assert.equal(exact.state, "interrupted");
  assert.equal(exact.isTip, false);
  assert.equal(exact.successorId, "job-x");
  assert.equal(exact.row.result_text, "stored result");
  assert.equal(exact.chainPosition, 1);
  const tipById = state.resolveActionableTip(db, jobId);
  assert.equal(tipById.id, "job-x");
  assert.equal(tipById.state, "running");
  assert.equal(tipById.isTip, true);
  assert.equal(tipById.chainPosition, 2);
  assert.equal(state.resolveActionableTip(db, "r").id, "job-x");
  assert.equal(state.resolveExactJob(db, "missing"), null);
  assert.equal(state.resolveActionableTip(db, "missing"), null);
  assert.equal(state.readJobView(db, "job-x").id, "job-x");
  assert.deepEqual(
    state.listJobViews(db, { sessionId: "session-1" }).map((view) => view.id),
    [jobId]
  );
  assert.deepEqual(
    state.listJobViews(db, { all: true }).map((view) => view.id),
    ["job-x", jobId]
  );
});

test("a label is free again once its chain's tip completed", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const first = state.createJob(db, jobFields(), { label: "r" });
  assert.throws(
    () => state.createJob(db, jobFields(), { label: "r" }),
    (error) => error instanceof state.LabelInUseError && error.holderJobId === first.jobId
  );
  rawExec(
    stateDir,
    `UPDATE jobs SET end_state = 'completed', end_at = 2, end_by = 'worker' WHERE id = '${first.jobId}';
     UPDATE chains SET live_label = NULL WHERE id = '${first.jobId}';`
  );
  const second = state.createJob(db, jobFields(), { label: "r" });
  assert.equal(state.resolveActionableTip(db, "r").id, second.jobId);
  assert.throws(() => state.createJob(db, jobFields(), { label: "Bad_Label" }), state.InvalidLabelError);
  assert.throws(() => state.createJob(db, jobFields(), { label: "x".repeat(41) }), state.InvalidLabelError);
});

test("a prompt of 8,388,608 bytes is stored and one byte more is refused before any row", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const { jobId } = state.createJob(db, jobFields({ prompt: "a".repeat(8388608) }));
  assert.equal(rawAll(stateDir, `SELECT length(prompt) AS n FROM jobs WHERE id = '${jobId}'`)[0].n, 8388608);
  const before = dumpTables(stateDir);
  assert.throws(() => state.createJob(db, jobFields({ prompt: "a".repeat(8388609) })), state.PromptTooLargeError);
  assert.throws(() => state.createJob(db, jobFields({ prompt: `${"a".repeat(8388607)}é` })), state.PromptTooLargeError);
  assert.deepEqual(dumpTables(stateDir), before);
});

test("a new chain on a barred thread needs force and is marked forced", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  rawExec(stateDir, "INSERT INTO thread_barriers (provider, thread_id, job_id, created_at) VALUES ('codex', 'th-9', 'job-old', 1)");
  const before = dumpTables(stateDir);
  assert.throws(
    () => state.createJob(db, jobFields({ threadId: "th-9" })),
    (error) => error instanceof state.ThreadBarrierError && error.threadId === "th-9" && error.barrierJobId === "job-old"
  );
  assert.deepEqual(dumpTables(stateDir), before);
  const forced = state.createJob(db, jobFields({ threadId: "th-9", force: true }));
  assert.equal(forced.barrierJobId, "job-old");
  assert.equal(rawAll(stateDir, `SELECT forced FROM jobs WHERE id = '${forced.jobId}'`)[0].forced, 1);
  const free = state.createJob(db, jobFields({ threadId: "th-10" }));
  assert.equal(free.barrierJobId, null);
  assert.equal(rawAll(stateDir, `SELECT forced FROM jobs WHERE id = '${free.jobId}'`)[0].forced, 0);
});

test("a withinCreate row commits with the job", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  rawExec(stateDir, "CREATE TABLE scratch (job_id TEXT, chain_id TEXT) STRICT");
  const calls = [];
  const created = state.createJob(db, jobFields(), {
    label: "seat",
    withinCreate(handle, ids) {
      calls.push(ids);
      assert.equal(handle.prepare("SELECT count(*) AS n FROM jobs WHERE id = ?").get(ids.jobId).n, 1);
      handle.prepare("INSERT INTO scratch (job_id, chain_id) VALUES (?, ?)").run(ids.jobId, ids.chainId);
    }
  });
  assert.deepEqual(calls, [{ jobId: created.jobId, chainId: created.chainId }]);
  assert.deepEqual(rawAll(stateDir, "SELECT job_id, chain_id FROM scratch"), [{ job_id: created.jobId, chain_id: created.chainId }]);
  assert.equal(rawAll(stateDir, "SELECT count(*) AS n FROM chains")[0].n, 1);
});

test("a withinCreate that throws leaves no job, no chain and no row", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  rawExec(stateDir, "CREATE TABLE scratch (job_id TEXT) STRICT");
  const before = dumpTables(stateDir);
  const failure = new Error("hook failed");
  assert.throws(
    () =>
      state.createJob(db, jobFields(), {
        withinCreate(handle, ids) {
          handle.prepare("INSERT INTO scratch (job_id) VALUES (?)").run(ids.jobId);
          throw failure;
        }
      }),
    (error) => error === failure
  );
  assert.throws(
    () =>
      state.createJob(db, jobFields(), {
        withinCreate(handle) {
          handle.exec("COMMIT");
        }
      }),
    TypeError
  );
  assert.throws(
    () =>
      state.createJob(db, jobFields(), {
        withinCreate() {
          state.createJob(db, jobFields());
        }
      }),
    TypeError
  );
  assert.deepEqual(dumpTables(stateDir), before);
});

test("a withinCreate that returns a promise is rejected and changes nothing", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const before = dumpTables(stateDir);
  assert.throws(() => state.createJob(db, jobFields(), { withinCreate: async () => {} }), TypeError);
  assert.deepEqual(dumpTables(stateDir), before);
});

test("label and barrier refusals do not call withinCreate", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  state.createJob(db, jobFields(), { label: "held" });
  rawExec(stateDir, "INSERT INTO thread_barriers (provider, thread_id, job_id, created_at) VALUES ('codex', 'th-b', 'job-old', 1)");
  let calls = 0;
  const withinCreate = () => {
    calls += 1;
  };
  assert.throws(() => state.createJob(db, jobFields(), { label: "held", withinCreate }), state.LabelInUseError);
  assert.throws(() => state.createJob(db, jobFields({ threadId: "th-b" }), { withinCreate }), state.ThreadBarrierError);
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------------------------
// Shared eligibility, claims, intents, thread registration and launch attempts

const CLAIM = { pid: 4242, startToken: "tok-4242", groupId: null, limits: { maxParallel: 8 } };

// Each creation waits for the next millisecond, so creation order is also created_at order
// (jobs created in one millisecond are ordered by their random ids).
function nextMillisecond() {
  const until = Date.now() + 2;
  while (Date.now() < until) {
    // A short busy wait.
  }
}

function createQueued(db, count, overrides = {}) {
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    nextMillisecond();
    ids.push(state.createJob(db, jobFields({ title: `job ${index}`, ...overrides })).jobId);
  }
  return ids;
}

function readCohortLog(file) {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("two workers claiming one job produce one claim", { timeout: 120000 }, async (t) => {
  for (let repetition = 0; repetition < 20; repetition += 1) {
    const stateDir = makeStoreDir(t);
    const db = store.openStore(stateDir);
    const [jobId] = createQueued(db, 1);
    db.close();
    const env = { FIXTURE_START_AT: startSoon(1000) };
    const results = await Promise.all(
      [1, 2].map((index) =>
        runLibChild("state.claimExecution", [{ $store: stateDir }, jobId, { ...CLAIM, pid: 5000 + index, startToken: `t${index}` }], env)
      )
    );
    const values = results.map((result) => result.value);
    assert.equal(values.filter((value) => value?.claimed).length, 1, `repetition ${repetition}: ${JSON.stringify(results)}`);
    assert.deepEqual(values.find((value) => value.claimed), { claimed: true, execGen: 1 });
    assert.deepEqual(values.find((value) => !value.claimed), { claimed: false, reason: "claimed" });
    assert.equal(rawAll(stateDir, `SELECT exec_gen FROM jobs WHERE id = '${jobId}'`)[0].exec_gen, 1);
  }
});

test("two claims on one thread hold the thread key one at a time", { timeout: 120000 }, async (t) => {
  for (let repetition = 0; repetition < 20; repetition += 1) {
    const stateDir = makeStoreDir(t);
    const db = store.openStore(stateDir);
    const ids = createQueued(db, 2, { threadId: "th-shared" });
    db.close();
    const env = { FIXTURE_START_AT: startSoon(1000) };
    const results = await Promise.all(
      ids.map((jobId, index) => runLibChild("state.claimExecution", [{ $store: stateDir }, jobId, { ...CLAIM, pid: 6000 + index }], env))
    );
    const values = results.map((result) => result.value);
    assert.equal(values.filter((value) => value?.claimed).length, 1, `repetition ${repetition}: ${JSON.stringify(results)}`);
    const loserIndex = values.findIndex((value) => !value.claimed);
    assert.deepEqual(values[loserIndex], { claimed: false, reason: "thread-busy" });
    const rows = rawAll(stateDir, "SELECT id, active_thread_key, last_refusal FROM jobs ORDER BY created_at");
    assert.deepEqual(
      rows.filter((row) => row.active_thread_key !== null).map((row) => row.active_thread_key),
      ["codex:th-shared"]
    );
    assert.equal(rows.find((row) => row.id === ids[loserIndex]).last_refusal, "thread-busy");
  }
});

test("claims never exceed the limit and only the oldest eligible cohort claims", { timeout: 240000 }, async (t) => {
  for (const variant of ["A", "C"]) {
    for (let repetition = 0; repetition < 20; repetition += 1) {
      const stateDir = makeStoreDir(t);
      const cohortLog = path.join(stateDir, "cohort.jsonl");
      const db = store.openStore(stateDir);
      if (variant === "C") {
        const [holder] = createQueued(db, 1, { threadId: "th-held" });
        state.claimExecution(db, holder, { ...CLAIM, limits: { maxParallel: 2 } });
      }
      const ids = [
        ...createQueued(db, 1, variant === "C" ? { threadId: "th-held" } : {}),
        ...createQueued(db, 5)
      ];
      db.close();
      const env = { FIXTURE_START_AT: startSoon(1500), AGENT_PLUGIN_TEST_COHORT_LOG: cohortLog };
      const results = await Promise.all(
        ids.map((jobId, index) =>
          runLibChild("state.claimExecution", [{ $store: stateDir }, jobId, { ...CLAIM, pid: 7000 + index, limits: { maxParallel: 2 } }], env)
        )
      );
      const label = `${variant} repetition ${repetition}`;
      for (const result of results) {
        assert.equal(result.ok, true, `${label}: ${JSON.stringify(result.error)}`);
      }
      const claimed = ids.filter((_, index) => results[index].value.claimed);
      const executing = rawAll(stateDir, "SELECT count(*) AS n FROM jobs WHERE claimed_at IS NOT NULL AND exec_released_at IS NULL")[0].n;
      assert.ok(executing <= 2, `${label}: ${executing} executing`);
      const expected = variant === "A" ? ids.slice(0, 2) : ids.slice(1, 2);
      assert.deepEqual(claimed.sort(), [...expected].sort(), label);
      if (variant === "C") {
        assert.deepEqual(results[0].value, { claimed: false, reason: "thread-busy" }, label);
      }
      const log = readCohortLog(cohortLog);
      for (const jobId of claimed) {
        const line = log.find((entry) => entry.jobId === jobId && entry.decision === "claimed");
        assert.ok(line, `${label}: no cohort line for ${jobId}`);
        assert.ok(line.cohort.includes(jobId), `${label}: ${jobId} claimed outside ${JSON.stringify(line.cohort)}`);
        assert.equal(line.cohort.length, line.free > 0 ? Math.min(line.free, line.cohort.length) : 0);
      }
      for (const entry of log.filter((line) => line.decision === "admission")) {
        assert.equal(entry.cohort.includes(entry.jobId), false, `${label}: ${JSON.stringify(entry)}`);
      }
    }
  }
});

test("a forced claimant behind a held key is refused thread-busy", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const [holder] = createQueued(db, 1, { threadId: "th-k" });
  assert.equal(state.claimExecution(db, holder, CLAIM).claimed, true);
  rawExec(stateDir, "INSERT INTO thread_barriers (provider, thread_id, job_id, created_at) VALUES ('codex', 'th-k', 'job-old', 1)");
  const forced = state.createJob(db, jobFields({ threadId: "th-k", force: true }));
  assert.deepEqual(state.claimExecution(db, forced.jobId, { ...CLAIM, pid: 4343 }), { claimed: false, reason: "thread-busy" });
  assert.equal(rawAll(stateDir, `SELECT last_refusal FROM jobs WHERE id = '${forced.jobId}'`)[0].last_refusal, "thread-busy");
});

test("a successor behind a barrier is neither launched nor failed after three launches", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const [jobId] = createQueued(db, 1, { threadId: "th-bar" });
  rawExec(stateDir, "INSERT INTO thread_barriers (provider, thread_id, job_id, created_at) VALUES ('codex', 'th-bar', 'job-old', 1)");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.deepEqual(state.recordLaunchAttempt(db, jobId, { now: Date.now() + attempt * 10000 }), { ok: false, reason: "barrier" });
  }
  rawExec(stateDir, `UPDATE jobs SET launch_attempts = 3 WHERE id = '${jobId}'`);
  assert.equal(state.endLaunchFailed(db, jobId), false);
  assert.deepEqual(state.claimExecution(db, jobId, CLAIM), { claimed: false, reason: "barrier" });
  const row = rawAll(stateDir, `SELECT end_state, last_refusal, launch_attempts FROM jobs WHERE id = '${jobId}'`)[0];
  assert.deepEqual(row, { end_state: null, last_refusal: "admission", launch_attempts: 0 });
  assert.equal(state.readJobView(db, jobId).state, "queued");
  const [free] = createQueued(db, 1);
  assert.deepEqual(state.recordLaunchAttempt(db, free, { now: 100000 }), { ok: true, attempts: 1 });
  assert.deepEqual(state.recordLaunchAttempt(db, free, { now: 103000 }), { ok: false, reason: "recent" });
  assert.deepEqual(state.recordLaunchAttempt(db, free, { now: 106000 }), { ok: true, attempts: 2 });
  assert.deepEqual(state.recordLaunchAttempt(db, free, { now: 112000 }), { ok: true, attempts: 3 });
  assert.equal(state.endLaunchFailed(db, free), true);
  const ended = state.readJobView(db, free);
  assert.equal(ended.state, "interrupted");
  assert.equal(ended.row.end_reason, "launch-failed");
  assert.equal(ended.row.resume_method, "stored-prompt");
  assert.equal(state.endLaunchFailed(db, free), false);
});

test("an intent or thread registration after a stop changes nothing, and none is accepted on an unclaimed job", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const [jobId] = createQueued(db, 1);
  const kinds = [
    ["spawn", {}],
    ["provider", { pid: 1, startToken: "x" }],
    ["version", { version: "1.0.0" }],
    ["submit", { clientMessageId: "c" }],
    ["turn", { turnId: "t" }],
    ["started", {}]
  ];
  let before = dumpTables(stateDir);
  for (const [kind, fields] of kinds) {
    assert.equal(state.recordIntent(db, jobId, 0, kind, fields), false, kind);
  }
  assert.deepEqual(state.recordThread(db, jobId, 0, { threadId: "th-u", resumeMethod: "thread" }), { ok: false, reason: "fenced" });
  assert.deepEqual(dumpTables(stateDir), before);
  const { execGen } = state.claimExecution(db, jobId, CLAIM);
  assert.equal(state.recordIntent(db, jobId, execGen, "spawn", {}), true);
  assert.equal(state.recordIntent(db, jobId, execGen, "version", { version: "0.169.0" }), true);
  assert.equal(state.readJobView(db, jobId).request.providerVersion, "0.169.0");
  assert.deepEqual(state.readExecutionFence(db, jobId, execGen), { ok: true });
  assert.deepEqual(state.readExecutionFence(db, jobId, execGen + 1), { ok: false, reason: "superseded" });
  rawExec(stateDir, `UPDATE jobs SET stop_requested_at = 5, stop_reason = 'session-end', stop_deadline = 9 WHERE id = '${jobId}'`);
  before = dumpTables(stateDir);
  for (const [kind, fields] of kinds) {
    assert.equal(state.recordIntent(db, jobId, execGen, kind, fields), false, kind);
  }
  assert.deepEqual(state.recordThread(db, jobId, execGen, { threadId: "th-s", resumeMethod: "thread" }), { ok: false, reason: "fenced" });
  assert.deepEqual(state.readExecutionFence(db, jobId, execGen), { ok: false, reason: "stop" });
  assert.deepEqual(dumpTables(stateDir), before);
});

test("a thread registration refuses a held key and a barrier and records the key otherwise", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const [holder, other, third] = createQueued(db, 3);
  const holderGen = state.claimExecution(db, holder, CLAIM).execGen;
  assert.deepEqual(state.recordThread(db, holder, holderGen, { threadId: "th-r", resumeMethod: "thread" }), { ok: true });
  assert.equal(rawAll(stateDir, `SELECT active_thread_key FROM jobs WHERE id = '${holder}'`)[0].active_thread_key, "codex:th-r");
  const otherGen = state.claimExecution(db, other, { ...CLAIM, pid: 1 }).execGen;
  assert.deepEqual(state.recordThread(db, other, otherGen, { threadId: "th-r", resumeMethod: "thread" }), { ok: false, reason: "held" });
  rawExec(stateDir, "INSERT INTO thread_barriers (provider, thread_id, job_id, created_at) VALUES ('codex', 'th-z', 'job-old', 1)");
  const thirdGen = state.claimExecution(db, third, { ...CLAIM, pid: 2 }).execGen;
  assert.deepEqual(state.recordThread(db, third, thirdGen, { threadId: "th-z", resumeMethod: "thread" }), { ok: false, reason: "barrier" });
});

// ---------------------------------------------------------------------------------------------
// The shared end mutation, results and questions

function claimedJob(db, overrides = {}) {
  const [jobId] = createQueued(db, 1, overrides);
  const { execGen } = state.claimExecution(db, jobId, CLAIM);
  return { jobId, execGen };
}

test("a turn end and an interruption cannot both win", { timeout: 120000 }, async (t) => {
  const outcomes = new Set();
  for (let repetition = 0; repetition < 20; repetition += 1) {
    const stateDir = makeStoreDir(t);
    const db = store.openStore(stateDir);
    const { jobId, execGen } = claimedJob(db);
    state.recordIntent(db, jobId, execGen, "started", {});
    db.close();
    const env = { FIXTURE_START_AT: startSoon(1000) };
    const [worker, reconciler] = await Promise.all([
      runLibChild("fixture.endWithLateResult", [{ $store: stateDir }, jobId, execGen, "the worker's output"], env),
      runLibChild("state.recordEnd", [{ $store: stateDir }, jobId, { state: "interrupted", by: "reconcile", reason: "worker-dead" }], env)
    ]);
    assert.equal(worker.ok, true, JSON.stringify(worker.error));
    assert.equal(reconciler.ok, true, JSON.stringify(reconciler.error));
    assert.equal([worker.value.won, reconciler.value.won].filter(Boolean).length, 1, `repetition ${repetition}`);
    const reads = new Set();
    for (let read = 0; read < 10; read += 1) {
      const row = rawAll(stateDir, `SELECT end_state, result_text FROM jobs WHERE id = '${jobId}'`)[0];
      reads.add(JSON.stringify(row));
      assert.equal(row.result_text, "the worker's output");
    }
    assert.equal(reads.size, 1);
    outcomes.add(JSON.parse([...reads][0]).end_state);
  }
  t.diagnostic(`end states seen: ${[...outcomes].join(", ")}`);
});

test("results are capped on a character boundary and oversized JSON is dropped", (t) => {
  const CAP = 1048576;
  const exact = state.capResult({ text: "a".repeat(CAP), json: null });
  assert.equal(exact.text.length, CAP);
  assert.equal(exact.truncated, false);
  const over = state.capResult({ text: "a".repeat(CAP + 1), json: null });
  assert.equal(Buffer.byteLength(over.text), CAP);
  assert.equal(over.truncated, true);
  const spanning = state.capResult({ text: `${"a".repeat(CAP - 2)}\u{1F600}`, json: null });
  assert.equal(spanning.text, "a".repeat(CAP - 2));
  assert.equal(spanning.truncated, true);
  assert.equal(Buffer.from(spanning.text, "utf8").toString("utf8"), spanning.text);
  const smallJson = state.capResult({ text: "ok", json: { answer: 1 } });
  assert.equal(smallJson.json, '{"answer":1}');
  assert.equal(smallJson.jsonTooLarge, false);
  const bigJson = { blob: "x".repeat(CAP - 11 + 1) };
  assert.equal(Buffer.byteLength(JSON.stringify(bigJson)), CAP + 1);
  const dropped = state.capResult({ text: "rendered", json: bigJson });
  assert.equal(dropped.json, null);
  assert.equal(dropped.jsonTooLarge, true);
  assert.equal(dropped.truncated, true);
  assert.equal(dropped.text, "rendered");

  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const { jobId, execGen } = claimedJob(db);
  const outcome = state.recordEnd(db, jobId, {
    state: "completed",
    by: "worker",
    execGen,
    leader: "unknown",
    result: { text: `${"a".repeat(CAP - 2)}\u{1F600}`, json: bigJson, logged: true }
  });
  assert.equal(outcome.won, true);
  const row = rawAll(
    stateDir,
    `SELECT length(CAST(result_text AS BLOB)) AS bytes, result_json, result_truncated, result_json_too_large, result_logged
     FROM jobs WHERE id = '${jobId}'`
  )[0];
  assert.deepEqual(row, { bytes: CAP - 2, result_json: null, result_truncated: 1, result_json_too_large: 1, result_logged: 1 });
});

test("question extraction obeys the flag and the structured property", () => {
  const marked = "Here is what I found.\nAGENT-QUESTION: Which branch should I use?\n";
  assert.deepEqual(launch.extractQuestion({ text: marked, json: null, allowQuestions: false }), { question: null, json: null });
  assert.deepEqual(launch.extractQuestion({ text: marked, json: null, allowQuestions: true }), {
    question: "Which branch should I use?",
    json: null
  });
  assert.deepEqual(launch.extractQuestion({ text: "AGENT-QUESTION: early\nthen more text", json: null, allowQuestions: true }), {
    question: null,
    json: null
  });
  assert.deepEqual(
    launch.extractQuestion({ text: marked, json: { verdict: "ok", question: "Structured?" }, allowQuestions: true }),
    { question: "Structured?", json: { verdict: "ok", question: "Structured?" } }
  );
  assert.deepEqual(launch.extractQuestion({ text: "done", json: { verdict: "ok", question: "" }, allowQuestions: true }), {
    question: null,
    json: { verdict: "ok" }
  });
  assert.deepEqual(launch.extractQuestion({ text: "done", json: { verdict: "ok", question: "" }, allowQuestions: false }), {
    question: null,
    json: { verdict: "ok", question: "" }
  });
  assert.equal(
    launch.QUESTION_INSTRUCTION,
    "If you cannot continue without an answer from the requester, end your reply with one final line of the form AGENT-QUESTION: <one question>."
  );
});

test("question schema validation refuses a non-object root and an existing question property", () => {
  assert.throws(
    () => launch.validateQuestionSchema({ type: "array", items: {} }),
    (error) => error instanceof launch.QuestionSchemaError && error.rule === "the output schema root must be an object schema with properties"
  );
  assert.throws(() => launch.validateQuestionSchema({ type: "object" }), launch.QuestionSchemaError);
  assert.throws(
    () => launch.validateQuestionSchema({ type: "object", properties: { question: { type: "integer" } }, required: ["question"] }),
    (error) => error instanceof launch.QuestionSchemaError && error.rule === "the output schema already defines a question property"
  );
  const schema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"], additionalProperties: false };
  const copy = launch.augmentSchemaForQuestions(schema);
  assert.deepEqual(copy.properties.question, { type: "string" });
  assert.deepEqual(copy.required, ["verdict"]);
  assert.equal(schema.properties.question, undefined);
  assert.doesNotThrow(() => launch.validateQuestionSchema(schema));
});

// ---------------------------------------------------------------------------------------------
// Next decision and continuation

const REQUESTER = { sessionId: "session-2", leaderPid: null, leaderStartToken: null };

// A job that ran a turn on thread `threadId` and ended `endState` (not released).
function endedJob(db, { endState = "completed", threadId = `th-${Math.random().toString(36).slice(2, 8)}`, label = null, ...overrides } = {}) {
  nextMillisecond();
  const { jobId } = state.createJob(db, jobFields(overrides), { label });
  const { execGen } = state.claimExecution(db, jobId, CLAIM);
  state.recordThread(db, jobId, execGen, { threadId, resumeMethod: "thread" });
  state.recordIntent(db, jobId, execGen, "submit", { clientMessageId: "c" });
  state.recordIntent(db, jobId, execGen, "started", {});
  const outcome = state.recordEnd(db, jobId, {
    state: endState,
    by: "worker",
    execGen,
    leader: "unknown",
    question: endState === "waiting" ? "which one?" : null,
    error: endState === "failed" ? "broke" : null,
    result: { text: "out", json: null, logged: false }
  });
  assert.equal(outcome.won, true);
  return { jobId, execGen, threadId };
}

function successorsOf(stateDir, jobId) {
  return rawAll(stateDir, `SELECT id FROM jobs WHERE continues = '${jobId}'`).map((row) => row.id);
}

test("two racing resumes create one successor and the loser stores no message", { timeout: 120000 }, async (t) => {
  for (let repetition = 0; repetition < 20; repetition += 1) {
    const stateDir = makeStoreDir(t);
    const db = store.openStore(stateDir);
    const { jobId } = endedJob(db);
    db.close();
    const env = { FIXTURE_START_AT: startSoon(1000) };
    const results = await Promise.all(
      ["one", "two"].map((message) =>
        runLibChild("state.decideNext", [{ $store: stateDir }, { ref: jobId, observedTipId: jobId }, { action: "continue", message, requester: REQUESTER }], env)
      )
    );
    const label = `repetition ${repetition}: ${JSON.stringify(results.map((result) => result.error ?? result.value))}`;
    const winners = results.filter((result) => result.value?.won);
    const losers = results.filter((result) => result.ok && !result.value.won);
    assert.equal(winners.length, 1, label);
    assert.equal(losers.length, 1, label);
    const successors = successorsOf(stateDir, jobId);
    assert.deepEqual(successors, [winners[0].value.successorId], label);
    assert.equal(losers[0].value.successorId, successors[0], label);
    const messages = rawAll(stateDir, "SELECT id, text FROM messages");
    assert.equal(messages.length, 1, label);
    assert.equal(messages[0].id, winners[0].value.messageId);
  }
});

test("two forced resumes of a cancelled job create one successor", { timeout: 120000 }, async (t) => {
  for (let repetition = 0; repetition < 20; repetition += 1) {
    const stateDir = makeStoreDir(t);
    const db = store.openStore(stateDir);
    const { jobId } = endedJob(db, { endState: "waiting" });
    assert.equal(state.decideNext(db, { ref: jobId, observedTipId: jobId }, { action: "cancel", requester: REQUESTER }).won, true);
    db.close();
    const env = { FIXTURE_START_AT: startSoon(1000) };
    const results = await Promise.all(
      [0, 1].map(() =>
        runLibChild("state.decideNext", [{ $store: stateDir }, { ref: jobId, observedTipId: jobId }, { action: "continue", force: true, requester: REQUESTER }], env)
      )
    );
    const label = `repetition ${repetition}: ${JSON.stringify(results.map((result) => result.error ?? result.value))}`;
    const successors = successorsOf(stateDir, jobId);
    assert.equal(successors.length, 1, label);
    assert.equal(results.filter((result) => result.value?.won).length, 1, label);
    assert.deepEqual(results.map((result) => result.value.successorId), [successors[0], successors[0]], label);
  }
});

test("a cancelled or failed job continues only with force and keeps cancelled", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const waiting = endedJob(db, { endState: "waiting" });
  rawExec(stateDir, `INSERT INTO messages (chain_id, text, created_at) VALUES ('${waiting.jobId}', 'old', 1)`);
  assert.equal(state.decideNext(db, { ref: waiting.jobId, observedTipId: waiting.jobId }, { action: "cancel", requester: REQUESTER }).won, true);
  const failed = endedJob(db, { endState: "failed" });
  const cancelled = endedJob(db, { endState: "cancelled" });
  const cases = [
    [waiting.jobId, state.JobCancelledError],
    [failed.jobId, state.JobFailedError],
    [cancelled.jobId, state.JobCancelledError]
  ];
  for (const [jobId, ErrorClass] of cases) {
    const before = dumpTables(stateDir);
    assert.throws(() => state.decideNext(db, { ref: jobId, observedTipId: jobId }, { action: "continue", message: "go", requester: REQUESTER }), ErrorClass);
    assert.deepEqual(dumpTables(stateDir), before);
  }
  for (const [jobId] of cases) {
    const outcome = state.decideNext(db, { ref: jobId, observedTipId: jobId }, { action: "continue", force: true, requester: REQUESTER });
    assert.equal(outcome.won, true, jobId);
    assert.ok(outcome.successorId);
  }
  const first = state.readJobView(db, waiting.jobId);
  assert.equal(first.state, "cancelled");
  assert.equal(first.row.next_action, "continue");
  assert.equal(first.row.next_session_id, "session-2");
  assert.deepEqual(rawAll(stateDir, `SELECT state, close_cause FROM messages WHERE chain_id = '${waiting.jobId}'`), [
    { state: "dropped", close_cause: "cancelled" }
  ]);
});

test("a continuation drops a label another live chain holds", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const chainA = endedJob(db, { label: "r" });
  assert.equal(rawAll(stateDir, `SELECT live_label FROM chains WHERE id = '${chainA.jobId}'`)[0].live_label, null);
  const chainB = state.createJob(db, jobFields({ title: "b" }), { label: "r" });
  const outcome = state.decideNext(db, { ref: chainA.jobId, observedTipId: chainA.jobId }, { action: "continue", requester: REQUESTER });
  assert.equal(outcome.won, true);
  assert.equal(outcome.labelDropped, true);
  assert.equal(rawAll(stateDir, `SELECT label FROM jobs WHERE id = '${outcome.successorId}'`)[0].label, null);
  assert.deepEqual(rawAll(stateDir, "SELECT id FROM chains WHERE live_label = 'r'"), [{ id: chainB.jobId }]);
  assert.equal(state.resolveActionableTip(db, "r").id, chainB.jobId);
  const chainC = endedJob(db, { label: "q" });
  const kept = state.decideNext(db, { ref: chainC.jobId, observedTipId: chainC.jobId }, { action: "continue", requester: REQUESTER });
  assert.equal(kept.labelDropped, false);
  assert.equal(rawAll(stateDir, `SELECT live_label FROM chains WHERE id = '${chainC.jobId}'`)[0].live_label, "q");
});

test("resume-last selects the newest resumable tip inside the decision", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  endedJob(db);
  const newerCompleted = endedJob(db);
  const target = { resumeLast: { provider: "codex", sessionId: "session-1" } };
  nextMillisecond();
  const { jobId: stopping } = state.createJob(db, jobFields());
  const { execGen } = state.claimExecution(db, stopping, CLAIM);
  state.recordThread(db, stopping, execGen, { threadId: "th-stop", resumeMethod: "thread" });
  state.recordIntent(db, stopping, execGen, "submit", { clientMessageId: "c" });
  rawExec(
    stateDir,
    `UPDATE jobs SET started_at = 1, stop_requested_at = 2, stop_reason = 'session-end', stop_deadline = 3,
       stopping_since = 4, stopping_cause = 'unconfirmed-stop' WHERE id = '${stopping}'`
  );
  assert.throws(() => state.decideNext(db, target, { action: "continue", requester: REQUESTER }), state.JobStoppingError);
  rawExec(stateDir, `UPDATE jobs SET session_id = 'elsewhere' WHERE id = '${stopping}'`);
  const outcome = state.decideNext(db, target, { action: "continue", requester: REQUESTER });
  assert.equal(outcome.won, true);
  assert.deepEqual(successorsOf(stateDir, newerCompleted.jobId), [outcome.successorId]);
  assert.throws(
    () => state.decideNext(db, { resumeLast: { provider: "codex", sessionId: "nobody" } }, { action: "continue", requester: REQUESTER }),
    state.NotResumableError
  );
});

test("a withinDecision row commits with the decision", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  rawExec(stateDir, "CREATE TABLE scratch (successor TEXT, tip TEXT) STRICT");
  const { jobId } = endedJob(db);
  const calls = [];
  const outcome = state.decideNext(
    db,
    { ref: jobId, observedTipId: jobId },
    {
      action: "continue",
      message: "hello",
      requester: REQUESTER,
      withinDecision(handle, info) {
        calls.push(info);
        assert.equal(handle.prepare("SELECT count(*) AS n FROM jobs WHERE id = ?").get(info.successorId).n, 1);
        assert.equal(handle.prepare("SELECT count(*) AS n FROM messages WHERE text = 'hello'").get().n, 1);
        handle.prepare("INSERT INTO scratch (successor, tip) VALUES (?, ?)").run(info.successorId, info.tipId);
      }
    }
  );
  assert.deepEqual(calls, [{ won: true, successorId: outcome.successorId, tipId: jobId }]);
  assert.deepEqual(rawAll(stateDir, "SELECT successor, tip FROM scratch"), [{ successor: outcome.successorId, tip: jobId }]);
  assert.equal(rawAll(stateDir, `SELECT next_action FROM jobs WHERE id = '${jobId}'`)[0].next_action, "continue");
  assert.equal(rawAll(stateDir, "SELECT count(*) AS n FROM messages")[0].n, 1);
});

test("a withinDecision is not called on a refusal", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const [queued] = createQueued(db, 1);
  const { jobId: stopping } = state.createJob(db, jobFields());
  rawExec(stateDir, `UPDATE jobs SET stopping_since = 1, stopping_cause = 'unconfirmed-stop' WHERE id = '${stopping}'`);
  let calls = 0;
  const withinDecision = () => {
    calls += 1;
  };
  const before = dumpTables(stateDir);
  assert.throws(() => state.decideNext(db, { ref: queued, observedTipId: queued }, { action: "continue", requester: REQUESTER, withinDecision }), state.JobActiveError);
  assert.throws(() => state.decideNext(db, { ref: stopping, observedTipId: stopping }, { action: "continue", requester: REQUESTER, withinDecision }), state.JobStoppingError);
  assert.equal(calls, 0);
  assert.deepEqual(dumpTables(stateDir), before);
});

test("a lost decision with no successor returns without the hook, and a loss to cancellation still throws", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const plain = endedJob(db);
  const cancelledByNext = endedJob(db, { endState: "waiting" });
  state.decideNext(db, { ref: cancelledByNext.jobId, observedTipId: cancelledByNext.jobId }, { action: "cancel", requester: REQUESTER });
  let calls = 0;
  const withinDecision = () => {
    calls += 1;
  };
  process.env.AGENT_PLUGIN_TEST_FORCE_BRANCH = "decision-zero-rows";
  try {
    const before = dumpTables(stateDir);
    const lost = state.decideNext(db, { ref: plain.jobId, observedTipId: plain.jobId }, { action: "continue", message: "m", requester: REQUESTER, withinDecision });
    assert.equal(lost.won, false);
    assert.equal(lost.successorId, null);
    assert.throws(
      () =>
        state.decideNext(db, { ref: cancelledByNext.jobId, observedTipId: cancelledByNext.jobId }, { action: "continue", force: true, message: "m", requester: REQUESTER, withinDecision }),
      state.JobCancelledError
    );
    assert.deepEqual(dumpTables(stateDir), before);
  } finally {
    delete process.env.AGENT_PLUGIN_TEST_FORCE_BRANCH;
  }
  assert.equal(calls, 0);
});

test("concludeLoss calls the hook once with won false", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  rawExec(stateDir, "CREATE TABLE scratch (x TEXT) STRICT");
  const calls = [];
  const view = { id: "tip" };
  const outcome = db.transact((handle) =>
    state.concludeLoss(handle, { tipId: "tip", successorId: "succ", view }, (inner, info) => {
      calls.push(info);
      inner.prepare("INSERT INTO scratch (x) VALUES ('kept')").run();
    })
  );
  assert.deepEqual(outcome, { won: false, view, successorId: "succ" });
  assert.deepEqual(calls, [{ won: false, successorId: "succ", tipId: "tip" }]);
  const failure = new Error("hook failed");
  assert.throws(
    () =>
      db.transact((handle) =>
        state.concludeLoss(handle, { tipId: "tip", successorId: "succ", view }, (inner) => {
          inner.prepare("INSERT INTO scratch (x) VALUES ('rolled back')").run();
          throw failure;
        })
      ),
    (error) => error === failure
  );
  assert.deepEqual(rawAll(stateDir, "SELECT x FROM scratch"), [{ x: "kept" }]);
});

test("a withinDecision that throws leaves the store unchanged", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  rawExec(stateDir, "CREATE TABLE scratch (x TEXT) STRICT");
  const { jobId } = endedJob(db);
  const before = dumpTables(stateDir);
  const failure = new Error("hook failed");
  assert.throws(
    () =>
      state.decideNext(db, { ref: jobId, observedTipId: jobId }, {
        action: "continue",
        message: "m",
        requester: REQUESTER,
        withinDecision(handle) {
          handle.prepare("INSERT INTO scratch (x) VALUES ('x')").run();
          throw failure;
        }
      }),
    (error) => error === failure
  );
  assert.deepEqual(dumpTables(stateDir), before);
});

test("a withinDecision that returns a promise is rejected and changes nothing", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const { jobId } = endedJob(db);
  const before = dumpTables(stateDir);
  assert.throws(
    () => state.decideNext(db, { ref: jobId, observedTipId: jobId }, { action: "continue", requester: REQUESTER, withinDecision: async () => {} }),
    TypeError
  );
  assert.deepEqual(dumpTables(stateDir), before);
});

test("a withinDecision runs with won false and the existing successor for a losing decision", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const { jobId } = endedJob(db);
  const first = state.decideNext(db, { ref: jobId, observedTipId: jobId }, { action: "continue", requester: REQUESTER });
  const calls = [];
  const second = state.decideNext(db, { ref: jobId, observedTipId: jobId }, {
    action: "continue",
    message: "late",
    requester: REQUESTER,
    withinDecision: (handle, info) => calls.push(info)
  });
  assert.equal(second.won, false);
  assert.equal(second.successorId, first.successorId);
  assert.deepEqual(calls, [{ won: false, successorId: first.successorId, tipId: first.successorId }]);
  assert.equal(rawAll(stateDir, "SELECT count(*) AS n FROM messages")[0].n, 0);
});

// ---------------------------------------------------------------------------------------------
// Mailbox, outcomes and events

test("two sends to one completed job create one successor and both messages reach it", { timeout: 120000 }, async (t) => {
  for (let repetition = 0; repetition < 20; repetition += 1) {
    const stateDir = makeStoreDir(t);
    const db = store.openStore(stateDir);
    const { jobId } = endedJob(db);
    db.close();
    const env = { FIXTURE_START_AT: startSoon(1000) };
    const results = await Promise.all(
      ["one", "two"].map((text) =>
        runLibChild("mailbox.sendToChain", [{ $store: stateDir }, { ref: jobId, observedTipId: jobId }, { text, requester: REQUESTER }], env)
      )
    );
    const label = `repetition ${repetition}: ${JSON.stringify(results.map((result) => result.error ?? result.value))}`;
    const successors = successorsOf(stateDir, jobId);
    assert.equal(successors.length, 1, label);
    assert.deepEqual(results.map((result) => result.value.outcome).sort(), ["continued", "running"], label);
    for (const result of results) {
      assert.equal(result.value.jobId, successors[0], label);
    }
    const messages = rawAll(stateDir, "SELECT id, text, state, chain_id FROM messages ORDER BY id");
    assert.equal(messages.length, 2, label);
    assert.ok(messages.every((message) => message.chain_id === jobId && message.state === "pending"), label);
    const continued = results.find((result) => result.value.outcome === "continued");
    assert.equal(messages[0].id, continued.value.messageId, label);
  }
});

test("a message stored as the turn ends is not left behind", { timeout: 120000 }, async (t) => {
  const orders = new Set();
  for (let repetition = 0; repetition < 20; repetition += 1) {
    const stateDir = makeStoreDir(t);
    const db = store.openStore(stateDir);
    const { jobId, execGen } = claimedJob(db);
    state.recordThread(db, jobId, execGen, { threadId: `th-${repetition}`, resumeMethod: "thread" });
    state.recordIntent(db, jobId, execGen, "submit", { clientMessageId: "c" });
    state.recordIntent(db, jobId, execGen, "started", {});
    db.close();
    const env = { FIXTURE_START_AT: startSoon(1000) };
    const [ending, sending] = await Promise.all([
      runLibChild("state.recordEnd", [{ $store: stateDir }, jobId, { state: "completed", by: "worker", execGen, leader: "none" }], env),
      runLibChild("mailbox.sendToChain", [{ $store: stateDir }, { ref: jobId, observedTipId: jobId }, { text: "late", requester: REQUESTER }], env)
    ]);
    const label = `repetition ${repetition}: ${JSON.stringify([ending.error ?? ending.value, sending.error ?? sending.value])}`;
    assert.equal(ending.ok && sending.ok, true, label);
    orders.add(sending.value.outcome);
    const message = rawAll(stateDir, "SELECT state, chain_id FROM messages")[0];
    assert.equal(message.state, "pending", label);
    const chainJobs = rawAll(stateDir, `SELECT id, end_state, next_action, claimed_at FROM jobs WHERE chain_id = '${jobId}' ORDER BY created_at`);
    const queued = chainJobs.filter((row) => row.end_state === null);
    assert.equal(queued.length, 1, label);
    assert.equal(chainJobs.find((row) => row.id === jobId).next_action, "continue", label);
    assert.equal(sending.value.jobId, sending.value.outcome === "continued" ? queued[0].id : jobId, label);
  }
  t.diagnostic(`send outcomes seen: ${[...orders].join(", ")}`);
});

test("availability errors change nothing and a retry clears a 3-second lock", { timeout: 60000 }, async (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const { jobId } = endedJob(db);
  const countRows = () => rawAll(stateDir, "SELECT (SELECT count(*) FROM messages) AS messages, (SELECT count(*) FROM jobs) AS jobs")[0];
  const before = countRows();
  const send = (text) =>
    store.withRetry((retryOpts) => mailbox.sendToChain(db, { ref: jobId, observedTipId: jobId }, { text, requester: REQUESTER }, retryOpts), "command");
  const hold = async (ms) => {
    const ready = path.join(stateDir, `held-${ms}.txt`);
    const holder = runLibChild("fixture.holdLock", [stateDir, ms, ready]);
    const until = Date.now() + 10000;
    while (!fs.existsSync(ready) && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { holder };
  };

  let { holder } = await hold(12000);
  let started = performance.now();
  await assert.rejects(send("x"), (error) => error instanceof store.StoreError && error.class === "availability" && error.code === "busy");
  const caseA = performance.now() - started;
  t.diagnostic(`case A gave up after ${Math.round(caseA)} ms`);
  assert.ok(caseA >= 9000 && caseA <= 12500, `case A took ${caseA} ms`);
  await holder;
  assert.deepEqual(countRows(), before);

  ({ holder } = await hold(3000));
  started = performance.now();
  let retries = 0;
  const sent = await store.withRetry(
    (retryOpts) => mailbox.sendToChain(db, { ref: jobId, observedTipId: jobId }, { text: "x", requester: REQUESTER }, retryOpts),
    "command",
    { onRetry: () => (retries += 1) }
  );
  t.diagnostic(`case A2 succeeded after ${Math.round(performance.now() - started)} ms and ${retries} retries`);
  assert.equal(sent.outcome, "continued");
  assert.ok(retries >= 1);
  assert.deepEqual(rawAll(stateDir, "SELECT text FROM messages"), [{ text: "x" }]);
  await holder;

  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.diagnostic("case B skipped: root ignores file permissions");
    return;
  }
  db.close();
  const after = countRows();
  const dbFile = path.join(stateDir, "store", "state.db");
  fs.chmodSync(dbFile, 0o444);
  try {
    await assert.rejects(
      store.withRetry((retryOpts) => {
        const readOnly = store.openStore(stateDir);
        try {
          return mailbox.sendToChain(readOnly, { ref: jobId }, { text: "y", requester: REQUESTER }, retryOpts);
        } finally {
          readOnly.close();
        }
      }, "command"),
      (error) => error instanceof store.StoreError && error.class === "availability"
    );
  } finally {
    fs.chmodSync(dbFile, 0o644);
  }
  assert.deepEqual(countRows(), after);
});

test("an event prints once per session and carries its job's session and delivery time", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const { jobId } = endedJob(db, { endState: "waiting", label: "ask" });
  const events = mailbox.listEvents(db, { sessionId: "session-1", unprinted: true });
  assert.equal(events.length, 1);
  assert.deepEqual(
    { ...events[0], createdAt: typeof events[0].createdAt },
    { id: events[0].id, jobId, kind: "waiting", text: "which one?", createdAt: "number", readAt: null, jobSessionId: "session-1", deliveredAt: null, provider: "codex", label: "ask" }
  );
  assert.equal(mailbox.markDelivered(db, jobId), true);
  assert.equal(mailbox.markDelivered(db, jobId), false);
  assert.equal(typeof mailbox.listEvents(db, { sessionId: "session-1" })[0].deliveredAt, "number");
  assert.equal(mailbox.markEventPrinted(db, events[0].id, "session-1"), true);
  assert.equal(mailbox.markEventPrinted(db, events[0].id, "session-1"), false);
  assert.deepEqual(mailbox.listEvents(db, { sessionId: "session-1", unprinted: true }), []);
  assert.equal(mailbox.listEvents(db, { sessionId: "session-1" }).length, 1);
  assert.equal(mailbox.markEventRead(db, events[0].id), true);
  assert.deepEqual(mailbox.listEvents(db, { sessionId: "session-1", unread: true }), []);
  assert.deepEqual(mailbox.noteJobs(db, [jobId, "missing"], "session-9"), [jobId]);
  assert.deepEqual(mailbox.noteJobs(db, [jobId], "session-9"), []);
});

// ---------------------------------------------------------------------------------------------
// Stop requests, the session-end batch, stopping, grace, release, dead claims and stale marks

const END_COLUMNS = "end_state, end_at, end_by, end_reason, question, error";

function runningJob(db, { threadId = null, sessionId = "session-1", forced = false, ...overrides } = {}) {
  const fields = jobFields({ requester: { sessionId, leaderPid: null, leaderStartToken: null }, threadId: forced ? threadId : null, force: forced, ...overrides });
  const { jobId } = state.createJob(db, fields);
  const claim = state.claimExecution(db, jobId, { ...CLAIM, limits: { maxParallel: 1000 } });
  assert.equal(claim.claimed, true, JSON.stringify(claim));
  const { execGen } = claim;
  state.recordIntent(db, jobId, execGen, "spawn", {});
  state.recordIntent(db, jobId, execGen, "provider", { pid: 99999, startToken: "root-token" });
  if (threadId && !forced) {
    assert.deepEqual(state.recordThread(db, jobId, execGen, { threadId, resumeMethod: "thread" }), { ok: true });
  }
  state.recordIntent(db, jobId, execGen, "submit", { clientMessageId: "c" });
  state.recordIntent(db, jobId, execGen, "started", {});
  return { jobId, execGen };
}

function endColumns(stateDir, jobId) {
  return rawAll(stateDir, `SELECT ${END_COLUMNS} FROM jobs WHERE id = '${jobId}'`)[0];
}

test("an unobserved release writes a barrier that survives chain deletion and is cleared only by a confirmed forced release", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const first = runningJob(db, { threadId: "th-b1" });
  assert.equal(state.releaseExecution(db, first.jobId, first.execGen, { kind: "unobserved", endIfUndecided: { by: "reconcile", reason: "worker-dead" } }), true);
  assert.deepEqual(rawAll(stateDir, "SELECT provider, thread_id, job_id FROM thread_barriers"), [{ provider: "codex", thread_id: "th-b1", job_id: first.jobId }]);
  const view = state.readJobView(db, first.jobId);
  assert.equal(view.state, "interrupted");
  assert.equal(view.providerExitUnobserved, true);
  assert.equal(view.row.release_kind, "unobserved");
  assert.equal(view.row.active_thread_key, null);
  rawExec(stateDir, `DELETE FROM chains WHERE id = '${first.jobId}'`);
  assert.equal(rawAll(stateDir, "SELECT count(*) AS n FROM jobs")[0].n, 0);
  assert.equal(rawAll(stateDir, "SELECT count(*) AS n FROM thread_barriers")[0].n, 1);
  const unforced = runningJob(db, { title: "other thread", threadId: "th-other" });
  state.releaseExecution(db, unforced.jobId, unforced.execGen, { kind: "confirmed" });
  assert.equal(rawAll(stateDir, "SELECT count(*) AS n FROM thread_barriers")[0].n, 1);
  const forcedUnobserved = runningJob(db, { title: "forced 1", threadId: "th-b1", forced: true });
  state.releaseExecution(db, forcedUnobserved.jobId, forcedUnobserved.execGen, { kind: "unobserved" });
  assert.deepEqual(rawAll(stateDir, "SELECT job_id FROM thread_barriers"), [{ job_id: forcedUnobserved.jobId }]);
  const forcedConfirmed = runningJob(db, { title: "forced 2", threadId: "th-b1", forced: true });
  assert.equal(rawAll(stateDir, `SELECT forced FROM jobs WHERE id = '${forcedConfirmed.jobId}'`)[0].forced, 1);
  state.releaseExecution(db, forcedConfirmed.jobId, forcedConfirmed.execGen, { kind: "confirmed" });
  assert.equal(rawAll(stateDir, "SELECT count(*) AS n FROM thread_barriers")[0].n, 0);
});

test("an already queued successor meets a newly written barrier", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const job = runningJob(db, { threadId: "th-q" });
  state.recordEnd(db, job.jobId, { state: "completed", by: "worker", execGen: job.execGen, leader: "unknown" });
  const { successorId } = state.decideNext(db, { ref: job.jobId, observedTipId: job.jobId }, { action: "continue", requester: REQUESTER });
  state.releaseExecution(db, job.jobId, job.execGen, { kind: "unobserved" });
  assert.deepEqual(state.claimExecution(db, successorId, CLAIM), { claimed: false, reason: "barrier" });
  assert.equal(state.readJobView(db, successorId).state, "queued");
  assert.deepEqual(state.recordLaunchAttempt(db, successorId, { now: Date.now() }), { ok: false, reason: "barrier" });
});

test("a release never touches the immutable end columns", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  for (const kind of ["confirmed", "unobserved"]) {
    const job = runningJob(db, { threadId: `th-${kind}` });
    state.recordEnd(db, job.jobId, { state: "waiting", by: "worker", execGen: job.execGen, question: "which?", leader: "unknown" });
    const before = endColumns(stateDir, job.jobId);
    assert.equal(state.releaseExecution(db, job.jobId, job.execGen, { kind, endIfUndecided: { by: "reconcile", reason: "worker-dead" } }), true);
    assert.deepEqual(endColumns(stateDir, job.jobId), before);
    assert.equal(state.releaseExecution(db, job.jobId, job.execGen, { kind: "confirmed" }), false);
    assert.equal(rawAll(stateDir, `SELECT release_kind FROM jobs WHERE id = '${job.jobId}'`)[0].release_kind, kind);
    assert.equal(rawAll(stateDir, `SELECT count(*) AS n FROM events WHERE job_id = '${job.jobId}'`)[0].n, 1);
  }
});

test("a stop deadline never moves later", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const job = runningJob(db);
  const first = state.requestStop(db, { jobIds: [job.jobId] }, { reason: "leader-gone", afterMs: 4000 });
  const deadline = rawAll(stateDir, `SELECT stop_deadline FROM jobs WHERE id = '${job.jobId}'`)[0].stop_deadline;
  assert.equal(first.selection[0].deadline, deadline);
  const later = state.requestStop(db, { jobIds: [job.jobId] }, { reason: "session-end", afterMs: 60000 });
  assert.equal(later.selection[0].deadline, deadline);
  assert.ok(later.selection[0].localDeadline <= later.commitMono + 4000 + 1);
  assert.equal(rawAll(stateDir, `SELECT stop_deadline, stop_reason FROM jobs WHERE id = '${job.jobId}'`)[0].stop_deadline, deadline);
  const session = state.requestStop(db, { sessionId: "session-1" }, { reason: "session-end", afterMs: 30000, sessionId: "session-1" });
  assert.equal(session.selection.find((entry) => entry.jobId === job.jobId).deadline, deadline);
  const earlier = state.requestStop(db, { jobIds: [job.jobId] }, { reason: "session-end", afterMs: 0 });
  assert.ok(earlier.selection[0].deadline < deadline);
  assert.equal(rawAll(stateDir, `SELECT stop_reason FROM jobs WHERE id = '${job.jobId}'`)[0].stop_reason, "leader-gone");
});

test("the session-end batch commits two releases and one stopping mark in one transaction, and never marks an ended job stopping", async (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const a = runningJob(db, { title: "a", threadId: "th-a" });
  const b = runningJob(db, { title: "b", threadId: "th-b" });
  const c = runningJob(db, { title: "c" });
  const ended = runningJob(db, { title: "ended" });
  state.recordEnd(db, ended.jobId, { state: "completed", by: "worker", execGen: ended.execGen, leader: "unknown" });
  const stop = state.requestStop(db, { sessionId: "session-1" }, { reason: "session-end", sessionId: "session-1" });
  assert.equal(stop.selection.length, 4);
  const decisions = [
    { jobId: a.jobId, execGen: a.execGen, release: { kind: "confirmed" } },
    { jobId: b.jobId, execGen: b.execGen, release: { kind: "unobserved" } },
    { jobId: c.jobId, execGen: c.execGen, release: null },
    { jobId: ended.jobId, execGen: ended.execGen, release: null }
  ];
  const before = dumpTables(stateDir);
  process.env.AGENT_PLUGIN_TEST_FAIL_STATEMENT = "batch-second";
  try {
    assert.throws(() => state.commitSessionEnd(db, decisions));
  } finally {
    delete process.env.AGENT_PLUGIN_TEST_FAIL_STATEMENT;
  }
  assert.deepEqual(dumpTables(stateDir), before);
  const scanner = await runLibChild("state.releaseExecution", [{ $store: stateDir }, a.jobId, a.execGen, { kind: "confirmed", endIfUndecided: { by: "reconcile", reason: "session-end" } }]);
  assert.equal(scanner.value, true);
  const endedBefore = rawAll(stateDir, `SELECT * FROM jobs WHERE id = '${ended.jobId}'`)[0];
  const result = state.commitSessionEnd(db, decisions);
  assert.deepEqual(result, { released: [b.jobId], stopping: [c.jobId], unreleased: [ended.jobId], skipped: [a.jobId] });
  assert.deepEqual(rawAll(stateDir, `SELECT * FROM jobs WHERE id = '${ended.jobId}'`)[0], endedBefore);
  const rows = Object.fromEntries(rawAll(stateDir, "SELECT id, end_state, end_reason, release_kind, stopping_cause FROM jobs").map((row) => [row.id, row]));
  assert.equal(rows[b.jobId].end_state, "interrupted");
  assert.equal(rows[b.jobId].end_reason, "session-end");
  assert.equal(rows[b.jobId].release_kind, "unobserved");
  assert.equal(rows[c.jobId].stopping_cause, "unconfirmed-stop");
  assert.equal(rows[c.jobId].end_state, null);
  assert.equal(state.readJobView(db, c.jobId).state, "stopping");
});

test("the stop deadline is relative to the commit and capped by the hook's local deadline", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const job = runningJob(db);
  const uncapped = state.requestStop(db, { jobIds: [job.jobId] }, { reason: "session-end", afterMs: 4000 });
  assert.equal(uncapped.storedDeadline - uncapped.commitWall, 4000);
  assert.ok(Math.abs(uncapped.localDeadline - (uncapped.commitMono + 4000)) < 1);
  const other = runningJob(db, { title: "other" });
  const cap = performance.now() + 1000;
  const capped = state.requestStop(db, { jobIds: [other.jobId] }, { reason: "session-end", afterMs: 4000, maxLocalDeadline: cap });
  assert.equal(capped.localDeadline, cap);
  assert.ok(capped.storedDeadline - capped.commitWall <= 1000);
  assert.ok(capped.storedDeadline - capped.commitWall >= 900);
  assert.equal(rawAll(stateDir, `SELECT stop_deadline FROM jobs WHERE id = '${other.jobId}'`)[0].stop_deadline, capped.storedDeadline);
});

test("a dead claim with no spawn intent ends interrupted at once", { timeout: 120000 }, async (t) => {
  const winners = new Set();
  for (let repetition = 0; repetition < 20; repetition += 1) {
    const stateDir = makeStoreDir(t);
    const db = store.openStore(stateDir);
    const { jobId, execGen } = claimedJob(db);
    db.close();
    const env = { FIXTURE_START_AT: startSoon(1000) };
    const [dead, spawn] = await Promise.all([
      runLibChild("state.endDeadClaim", [{ $store: stateDir }, jobId, execGen], env),
      runLibChild("state.recordIntent", [{ $store: stateDir }, jobId, execGen, "spawn", {}], env)
    ]);
    assert.equal([dead.value, spawn.value].filter(Boolean).length, 1, `repetition ${repetition}: ${JSON.stringify([dead, spawn].map((r) => r.error ?? r.value))}`);
    const row = rawAll(stateDir, `SELECT end_state, end_reason, resume_method, release_kind, spawn_intent_at FROM jobs WHERE id = '${jobId}'`)[0];
    if (dead.value) {
      winners.add("dead-claim");
      assert.deepEqual({ ...row, spawn_intent_at: null }, { end_state: "interrupted", end_reason: "worker-dead", resume_method: "stored-prompt", release_kind: "confirmed", spawn_intent_at: null });
      assert.equal(row.spawn_intent_at, null);
    } else {
      winners.add("spawn");
      assert.equal(row.end_state, null);
      assert.notEqual(row.spawn_intent_at, null);
    }
    const reopened = store.openStore(stateDir);
    assert.equal(state.endDeadClaim(reopened, jobId, execGen), false);
    reopened.close();
  }
  t.diagnostic(`winners seen: ${[...winners].join(", ")}`);
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const [unclaimed] = createQueued(db, 1);
  assert.equal(state.releaseExecution(db, unclaimed, 0, { kind: "confirmed" }), false);
  assert.equal(state.endDeadClaim(db, unclaimed, 0), false);
});

test("a cancel drops open messages on the queued path and on a grace-expired release, and a natural end that won first keeps them", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const [queued] = createQueued(db, 1);
  mailbox.sendToChain(db, { ref: queued }, { text: "q" });
  const stop = state.requestStop(db, { jobIds: [queued] }, { reason: "cancel", cancel: true });
  assert.equal(stop.selection[0].endedUnclaimed, true);
  assert.equal(state.readJobView(db, queued).state, "cancelled");
  assert.deepEqual(rawAll(stateDir, `SELECT state, close_cause FROM messages WHERE chain_id = '${queued}'`), [{ state: "dropped", close_cause: "cancelled" }]);

  const running = runningJob(db, { title: "running", threadId: "th-run" });
  mailbox.sendToChain(db, { ref: running.jobId }, { text: "r" });
  state.requestStop(db, { jobIds: [running.jobId] }, { reason: "cancel", cancel: true });
  state.startGrace(db, running.jobId, running.execGen, { cause: "owner-death" });
  assert.equal(state.releaseExecution(db, running.jobId, running.execGen, { kind: "unobserved", endIfUndecided: { by: "reconcile", reason: "worker-dead" } }), true);
  assert.equal(state.readJobView(db, running.jobId).state, "cancelled");
  assert.deepEqual(rawAll(stateDir, `SELECT state, close_cause FROM messages WHERE chain_id = '${running.jobId}'`), [{ state: "dropped", close_cause: "cancelled" }]);

  const natural = runningJob(db, { title: "natural", threadId: "th-nat" });
  mailbox.sendToChain(db, { ref: natural.jobId }, { text: "n" });
  state.recordEnd(db, natural.jobId, { state: "completed", by: "worker", execGen: natural.execGen, leader: "unknown" });
  const before = endColumns(stateDir, natural.jobId);
  state.requestStop(db, { jobIds: [natural.jobId] }, { reason: "cancel", cancel: true });
  state.releaseExecution(db, natural.jobId, natural.execGen, { kind: "confirmed" });
  assert.deepEqual(endColumns(stateDir, natural.jobId), before);
  assert.deepEqual(rawAll(stateDir, `SELECT state FROM messages WHERE chain_id = '${natural.jobId}'`), [{ state: "pending" }]);
});

test("cancel and resume cannot both win", { timeout: 120000 }, async (t) => {
  const outcomes = new Set();
  for (let repetition = 0; repetition < 20; repetition += 1) {
    const stateDir = makeStoreDir(t);
    const db = store.openStore(stateDir);
    const { jobId } = endedJob(db, { endState: "waiting" });
    db.close();
    const env = { FIXTURE_START_AT: startSoon(1000) };
    const [cancel, resume] = await Promise.all([
      runLibChild("fixture.cancelOrFollow", [{ $store: stateDir }, jobId, REQUESTER], env),
      runLibChild("state.decideNext", [{ $store: stateDir }, { ref: jobId, observedTipId: jobId }, { action: "continue", requester: REQUESTER }], env)
    ]);
    const label = `repetition ${repetition}: ${JSON.stringify([cancel.error ?? cancel.value, resume.error ?? resume.value])}`;
    const reads = new Set();
    for (let read = 0; read < 10; read += 1) {
      reads.add(JSON.stringify(rawAll(stateDir, "SELECT id, end_state, next_action, cancelled_at IS NOT NULL AS cancelled FROM jobs ORDER BY created_at")));
    }
    assert.equal(reads.size, 1, label);
    const rows = JSON.parse([...reads][0]);
    if (rows.length === 1) {
      outcomes.add("cancel first");
      assert.equal(rows[0].next_action, "cancel", label);
      assert.equal(resume.ok, false, label);
      assert.equal(resume.error.name, "JobCancelledError", label);
    } else {
      outcomes.add("resume first");
      assert.equal(rows.length, 2, label);
      assert.equal(rows[0].next_action, "continue", label);
      assert.equal(rows[1].end_state, "cancelled", label);
    }
  }
  t.diagnostic(`outcomes seen: ${[...outcomes].join(", ")}`);
});

test("a stale mark refuses a fresh rewrite, a non-integer counter is never valid, and two markers mark once", async (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const job = runningJob(db);
  const claim = { pid: CLAIM.pid, startToken: CLAIM.startToken, jobId: job.jobId, execGen: job.execGen };
  const fields = { ...claim, provider: null };
  live.writeLiveFile(stateDir, "worker", fields);
  const baseline = live.writeLiveFile(stateDir, "worker", fields);
  assert.deepEqual(live.readLiveSample(stateDir, claim), { valid: true, counter: baseline });
  live.writeLiveFile(stateDir, "worker", fields);
  const before = dumpTables(stateDir);
  assert.equal(state.markStale(db, job.jobId, job.execGen, { claim, lastValidCounter: baseline, stateDir }), false);
  assert.deepEqual(dumpTables(stateDir), before);
  const file = path.join(stateDir, "store", "live", `worker-${CLAIM.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...fields, role: "worker", counter: 1e30 }));
  assert.deepEqual(live.readLiveSample(stateDir, claim), { valid: false, reason: "malformed" });
  fs.writeFileSync(file, JSON.stringify({ ...fields, role: "worker", counter: "9" }));
  assert.deepEqual(live.readLiveSample(stateDir, claim), { valid: false, reason: "malformed" });
  fs.writeFileSync(file, JSON.stringify({ ...fields, startToken: "other", role: "worker", counter: 99 }));
  assert.deepEqual(live.readLiveSample(stateDir, claim), { valid: false, reason: "mismatch" });
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(live.readLiveSample(stateDir, claim), { valid: false, reason: "malformed" });
  const results = await Promise.all(
    [0, 1].map(() => runLibChild("state.markStale", [{ $store: stateDir }, job.jobId, job.execGen, { claim, lastValidCounter: baseline + 1, stateDir }], { FIXTURE_START_AT: startSoon(800) }))
  );
  assert.deepEqual(results.map((result) => result.value).sort(), [false, true], JSON.stringify(results.map((result) => result.error)));
  const row = rawAll(stateDir, `SELECT stopping_cause, stop_reason, stop_deadline - stop_requested_at AS window FROM jobs WHERE id = '${job.jobId}'`)[0];
  assert.deepEqual(row, { stopping_cause: "stale-worker", stop_reason: "stale-worker", window: 4000 });
  fs.rmSync(file);
  assert.deepEqual(live.readLiveSample(stateDir, claim), { valid: false, reason: "missing" });
});

test("requestStop with jobIds selects only the named executions", (t) => {
  const stateDir = makeStoreDir(t);
  const clockFile = path.join(stateDir, "clock.txt");
  process.env.AGENT_PLUGIN_TEST_CLOCK_OFFSET_FILE = clockFile;
  t.after(() => delete process.env.AGENT_PLUGIN_TEST_CLOCK_OFFSET_FILE);
  const setClock = (at) => fs.writeFileSync(clockFile, String(at - Date.now()));
  const db = openTestStore(t, stateDir);
  setClock(1000 + 100);
  const ancestor = runningJob(db, { title: "ancestor", threadId: "th-anc" });
  state.recordEnd(db, ancestor.jobId, { state: "completed", by: "worker", execGen: ancestor.execGen, leader: "unknown" });
  const { successorId } = state.decideNext(db, { ref: ancestor.jobId, observedTipId: ancestor.jobId }, { action: "continue", requester: REQUESTER });
  const released = runningJob(db, { title: "released" });
  state.releaseExecution(db, released.jobId, released.execGen, { kind: "confirmed" });
  const [unclaimed] = createQueued(db, 1);
  const stopColumns = (jobId) => rawAll(stateDir, `SELECT stop_requested_at, stop_deadline, stop_reason FROM jobs WHERE id = '${jobId}'`)[0];
  setClock(1000 + 110);
  const first = state.requestStop(db, { jobIds: [ancestor.jobId] }, { reason: "leader-gone" });
  assert.deepEqual(first.selection.map((entry) => [entry.jobId, entry.execGen, entry.wasEnded, entry.endedUnclaimed]), [[ancestor.jobId, ancestor.execGen, true, false]]);
  assert.deepEqual(stopColumns(successorId), { stop_requested_at: null, stop_deadline: null, stop_reason: null });
  assert.equal(state.readJobView(db, successorId).state, "queued");
  setClock(1000 + 111);
  const before = dumpTables(stateDir);
  const empty = state.requestStop(db, { jobIds: [released.jobId, "absent-id"] }, { reason: "leader-gone" });
  assert.deepEqual(empty.selection, []);
  assert.deepEqual(dumpTables(stateDir), before);
  setClock(1000 + 112);
  const cancelled = state.requestStop(db, { jobIds: [unclaimed] }, { reason: "cancel", cancel: true });
  assert.equal(cancelled.selection.length, 1);
  assert.equal(cancelled.selection[0].endedUnclaimed, true);
  assert.equal(cancelled.selection[0].worker, null);
  assert.equal(state.readJobView(db, unclaimed).state, "cancelled");
});

test("requestStop withinStop sees prior cancel and end flags", (t) => {
  const stateDir = makeStoreDir(t);
  const clockFile = path.join(stateDir, "clock.txt");
  process.env.AGENT_PLUGIN_TEST_CLOCK_OFFSET_FILE = clockFile;
  t.after(() => delete process.env.AGENT_PLUGIN_TEST_CLOCK_OFFSET_FILE);
  const setClock = (at) => fs.writeFileSync(clockFile, String(at - Date.now()));
  const db = openTestStore(t, stateDir);
  rawExec(stateDir, "CREATE TABLE marker (x TEXT) STRICT");
  const flagsOf = (jobId) => {
    let seen = null;
    const result = state.requestStop(db, { jobIds: [jobId] }, {
      reason: "cancel",
      cancel: true,
      withinStop(handle, info) {
        seen = info;
      }
    });
    assert.equal(seen.commitWall, result.commitWall);
    return seen.selection.map((entry) => ({ hadCancelRequest: entry.hadCancelRequest, wasEnded: entry.wasEnded }));
  };
  for (const claimed of [true, false]) {
    for (const order of ["999 first", "1000 first"]) {
      for (let row = 0; row < 20; row += 1) {
        const jobId = claimed ? runningJob(db, { title: `${order} ${row}` }).jobId : createQueued(db, 1)[0];
        setClock(order === "999 first" ? 999 : 1000);
        const firstFlags = flagsOf(jobId);
        setClock(order === "999 first" ? 1000 : 999);
        const secondFlags = flagsOf(jobId);
        assert.deepEqual(firstFlags, [{ hadCancelRequest: false, wasEnded: false }], `${claimed} ${order} ${row}`);
        if (claimed) {
          assert.deepEqual(secondFlags, [{ hadCancelRequest: true, wasEnded: false }], `${claimed} ${order} ${row}`);
        } else {
          assert.deepEqual(secondFlags, [], `${claimed} ${order} ${row}`);
        }
      }
    }
  }
  setClock(1001);
  const replayJob = runningJob(db, { title: "replay" });
  flagsOf(replayJob.jobId);
  assert.deepEqual(flagsOf(replayJob.jobId), [{ hadCancelRequest: true, wasEnded: false }]);
  let emptyCalls = 0;
  state.requestStop(db, { jobIds: ["absent"] }, {
    reason: "cancel",
    withinStop(handle, info) {
      emptyCalls += 1;
      assert.deepEqual(info.selection, []);
    }
  });
  assert.equal(emptyCalls, 1);
  setClock(1002);
  const [rollbackJob] = createQueued(db, 1);
  const before = dumpTables(stateDir);
  const failure = new Error("hook failed");
  assert.throws(
    () =>
      state.requestStop(db, { jobIds: [rollbackJob] }, {
        reason: "cancel",
        cancel: true,
        withinStop(handle) {
          handle.prepare("INSERT INTO marker (x) VALUES ('m')").run();
          throw failure;
        }
      }),
    (error) => error === failure
  );
  assert.throws(() => state.requestStop(db, { jobIds: [rollbackJob] }, { reason: "cancel", cancel: true, withinStop: async () => {} }), TypeError);
  assert.deepEqual(dumpTables(stateDir), before);
});

test("every violating primitive call throws and leaves every table unchanged", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const chainA = endedJob(db);
  const chainB = endedJob(db, { title: "b" });
  const running = runningJob(db, { title: "running" });
  const before = dumpTables(stateDir);
  const expectUnchanged = (call, label) => {
    assert.throws(call, undefined, label);
    assert.deepEqual(dumpTables(stateDir), before, label);
  };
  process.env.AGENT_PLUGIN_TEST_FAIL_STATEMENT = "successor-insert";
  try {
    expectUnchanged(() => state.decideNext(db, { ref: chainA.jobId, observedTipId: chainA.jobId }, { action: "continue", message: "m", requester: REQUESTER }), "successor insert");
  } finally {
    delete process.env.AGENT_PLUGIN_TEST_FAIL_STATEMENT;
  }
  expectUnchanged(() => state.decideNext(db, { ref: chainA.jobId, observedTipId: chainB.jobId }, { action: "continue", requester: REQUESTER }), "successor in another chain");
  expectUnchanged(() => mailbox.sendToChain(db, { ref: chainA.jobId, observedTipId: chainB.jobId }, { text: "x" }), "tip of another chain");
  process.env.AGENT_PLUGIN_TEST_FAIL_STATEMENT = "event-insert";
  try {
    expectUnchanged(() => state.recordEnd(db, running.jobId, { state: "completed", by: "worker", execGen: running.execGen, leader: "unknown" }), "event insert");
  } finally {
    delete process.env.AGENT_PLUGIN_TEST_FAIL_STATEMENT;
  }
  expectUnchanged(() => state.createJob(db, jobFields(), { label: "Not Valid" }), "label alphabet");
});

// ---------------------------------------------------------------------------------------------
// Pruning

const DAY_MS = 24 * 60 * 60 * 1000;

// One completed chain whose activity is 15 days old, and 50 newer completed chains.
function seedPrunable(stateDir) {
  const db = store.openStore(stateDir);
  const old = endedJob(db, { title: "old" });
  const newer = [];
  for (let index = 0; index < 50; index += 1) {
    newer.push(endedJob(db, { title: `newer ${index}`, threadId: `th-n${index}` }).jobId);
    state.releaseExecution(db, newer.at(-1), 1, { kind: "confirmed" });
  }
  state.releaseExecution(db, old.jobId, old.execGen, { kind: "confirmed" });
  db.close();
  const now = Date.now();
  rawExec(stateDir, `UPDATE chains SET activity_at = ${now - 15 * DAY_MS} WHERE id = '${old.jobId}'`);
  rawExec(stateDir, `UPDATE chains SET activity_at = ${now - DAY_MS} WHERE id <> '${old.jobId}'`);
  fs.writeFileSync(path.join(stateDir, "store", "artifacts", `${old.jobId}.log`), "old output\n");
  return { oldId: old.jobId, newer };
}

function orphanCounts(stateDir) {
  return rawAll(
    stateDir,
    `SELECT (SELECT count(*) FROM jobs WHERE chain_id NOT IN (SELECT id FROM chains)) AS jobs,
            (SELECT count(*) FROM messages WHERE chain_id NOT IN (SELECT id FROM chains)) AS messages`
  )[0];
}

test("pruning and resume cannot both win", { timeout: 300000 }, async (t) => {
  const outcomes = new Set();
  for (let repetition = 0; repetition < 20; repetition += 1) {
    const stateDir = makeStoreDir(t);
    const { oldId } = seedPrunable(stateDir);
    const env = { FIXTURE_START_AT: startSoon(1000) };
    const [pruner, resume] = await Promise.all([
      runLibChild("fixture.prune", [{ $store: stateDir }, stateDir], env),
      runLibChild("state.decideNext", [{ $store: stateDir }, { ref: oldId, observedTipId: oldId }, { action: "continue", message: "hello", requester: REQUESTER }], env)
    ]);
    const label = `repetition ${repetition}: ${JSON.stringify([pruner.error ?? pruner.value, resume.error ?? resume.value])}`;
    assert.equal(pruner.ok, true, label);
    const chainKept = rawAll(stateDir, `SELECT count(*) AS n FROM chains WHERE id = '${oldId}'`)[0].n === 1;
    const logExists = fs.existsSync(path.join(stateDir, "store", "artifacts", `${oldId}.log`));
    if (chainKept) {
      outcomes.add("resume first");
      assert.equal(resume.value?.won, true, label);
      assert.deepEqual(rawAll(stateDir, `SELECT end_state, claimed_at FROM jobs WHERE id = '${resume.value.successorId}'`), [{ end_state: null, claimed_at: null }]);
      assert.ok(logExists, label);
    } else {
      outcomes.add("prune first");
      assert.equal(resume.ok, false, label);
      assert.equal(resume.error.name, "UnknownJobError", label);
      assert.deepEqual(pruner.value.prunedJobIds, [oldId], label);
      assert.equal(logExists, false, label);
    }
    assert.deepEqual(orphanCounts(stateDir), { jobs: 0, messages: 0 }, label);
  }
  t.diagnostic(`outcomes seen: ${[...outcomes].join(", ")}`);

  const stateDir = makeStoreDir(t);
  const { oldId } = seedPrunable(stateDir);
  const pointsDir = path.join(stateDir, "points");
  fs.mkdirSync(pointsDir);
  const before = dumpTables(stateDir);
  const pruner = runLibChild("fixture.prune", [{ $store: stateDir }, stateDir], {
    AGENT_PLUGIN_TEST_POINTS: "inside-prune",
    AGENT_PLUGIN_TEST_POINTS_DIR: pointsDir
  });
  const until = Date.now() + 20000;
  while (!fs.readdirSync(pointsDir).some((name) => name.startsWith("inside-prune-")) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(fs.readdirSync(pointsDir).some((name) => name.startsWith("inside-prune-")), "the pruner did not reach its point");
  await stopOwnedProcess(pruner.child);
  await pruner;
  assert.deepEqual(dumpTables(stateDir), before);
  assert.equal(rawAll(stateDir, `SELECT count(*) AS n FROM chains WHERE id = '${oldId}'`)[0].n, 1);
  assert.equal(rawAll(stateDir, "PRAGMA integrity_check")[0].integrity_check, "ok");
});

test("pruning keeps the barrier and leaves the old jobs folder and archives alone", async (t) => {
  const stateDir = makeStoreDir(t);
  const { oldId } = seedPrunable(stateDir);
  rawExec(stateDir, `INSERT INTO thread_barriers (provider, thread_id, job_id, created_at) VALUES ('codex', 'th-old', '${oldId}', 1)`);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir);
  fs.writeFileSync(path.join(jobsDir, "task-legacy.json"), '{"id":"task-legacy"}\n');
  fs.writeFileSync(path.join(jobsDir, "task-legacy.log"), "legacy log\n");
  const archive = path.join(stateDir, "store.corrupt-20260101T000000Z-deadbeef");
  fs.mkdirSync(path.join(archive, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(archive, "artifacts", `${oldId}.log`), "archived\n");
  const artifacts = path.join(stateDir, "store", "artifacts");
  const staleOrphan = path.join(artifacts, "task-gone-old.log");
  const freshOrphan = path.join(artifacts, "task-gone-new.log");
  fs.writeFileSync(staleOrphan, "x\n");
  fs.writeFileSync(freshOrphan, "y\n");
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(staleOrphan, twoHoursAgo, twoHoursAgo);
  const db = openTestStore(t, stateDir);
  const pruned = state.pruneChains(db, { now: Date.now() });
  assert.deepEqual(pruned.prunedJobIds, [oldId]);
  const deleted = await store.pruneArtifacts(stateDir, pruned.prunedJobIds);
  assert.equal(deleted, 2);
  assert.equal(fs.existsSync(path.join(artifacts, `${oldId}.log`)), false);
  assert.equal(fs.existsSync(staleOrphan), false);
  assert.equal(fs.existsSync(freshOrphan), true);
  assert.deepEqual(rawAll(stateDir, "SELECT thread_id, job_id FROM thread_barriers"), [{ thread_id: "th-old", job_id: oldId }]);
  assert.deepEqual(fs.readdirSync(jobsDir).sort(), ["task-legacy.json", "task-legacy.log"]);
  assert.equal(fs.readFileSync(path.join(archive, "artifacts", `${oldId}.log`), "utf8"), "archived\n");
  assert.equal(state.pruneChains(db, { now: Date.now() + 1000 }).prunedJobIds.length, 0);
  assert.equal(rawAll(stateDir, "SELECT count(*) AS n FROM chains")[0].n, 50);
});

// ---------------------------------------------------------------------------------------------
// Exact identities

test("exact identities: absent, denied, timed out, a reused pid whose token differs by one unit, and a null stored token", async (t) => {
  const helper = await startHelperProcess();
  t.after(() => stopOwnedProcess(helper.process));
  const exited = await startHelperProcess();
  const exitedGone = new Promise((resolve) => exited.process.on("exit", resolve));
  await stopOwnedProcess(exited.process);
  await exitedGone;
  const deadline = () => performance.now() + 5000;
  const present = await processLib.readProcessIdentity(helper.pid, { deadline: deadline() });
  assert.equal(present.state, "present");
  assert.equal(typeof present.startToken, "string");
  assert.deepEqual(await processLib.readProcessIdentity(exited.pid, { deadline: deadline() }), { state: "absent" });
  assert.equal(processLib.confirmIdentity({ pid: helper.pid, startToken: present.startToken }, present), "present");
  const reusedToken = present.startToken.replace(/(\d+)$/, (digits) => (BigInt(digits) + 1n).toString());
  assert.equal(processLib.confirmIdentity({ pid: helper.pid, startToken: reusedToken }, present), "absent");
  assert.equal(processLib.confirmIdentity({ pid: helper.pid, startToken: null }, present), "unknown");
  assert.equal(processLib.confirmIdentity({ pid: helper.pid, startToken: present.startToken }, { state: "absent" }), "absent");
  process.env.AGENT_PLUGIN_TEST_PROCESS = JSON.stringify({ lookup: "unknown" });
  try {
    const denied = await processLib.readProcessIdentity(helper.pid, { deadline: deadline() });
    assert.equal(denied.state, "unknown");
    assert.equal(processLib.confirmIdentity({ pid: helper.pid, startToken: present.startToken }, denied), "unknown");
  } finally {
    delete process.env.AGENT_PLUGIN_TEST_PROCESS;
  }
  process.env.AGENT_PLUGIN_TEST_PROCESS = JSON.stringify({ queryDelayMs: 500 });
  try {
    const started = performance.now();
    const timedOut = await processLib.readProcessIdentities([helper.pid, exited.pid], { deadline: performance.now() + 100 });
    assert.ok(performance.now() - started < 450);
    assert.equal(timedOut.get(helper.pid).state, "unknown");
    assert.equal(timedOut.get(exited.pid).state, "unknown");
  } finally {
    delete process.env.AGENT_PLUGIN_TEST_PROCESS;
  }
});

// ---------------------------------------------------------------------------------------------
// Release evidence and decision

function evidence(overrides = {}) {
  return {
    platform: "win32",
    provider: "codex",
    providerVersion: "0.169.0",
    expectedGroupId: null,
    rootRecorded: true,
    root: "absent",
    rootExitSeenAt: null,
    group: null,
    trigger: null,
    graceStartedAt: null,
    graceMs: 60000,
    contracts: [],
    ...overrides
  };
}

const contract = (trigger, version = "0.169.0", windowMs = 1000) => ({ provider: "codex", platform: "win32", trigger, version, windowMs });

test("a cleanup contract counts only for the trigger observed for this execution", async (t) => {
  const T = 1_000_000;
  const d1 = evidence({ rootExitSeenAt: T, trigger: { kind: "stdin-end", at: T }, contracts: [contract("stdin-end")] });
  assert.equal(state.decideRelease(d1, { now: T + 999 }).kind, "wait");
  assert.equal(state.decideRelease(d1, { now: T + 1000 }).kind, "confirmed");
  const d2 = evidence({ trigger: { kind: "tree-stop", at: T }, contracts: [contract("stdin-end"), contract("owner-death")], graceStartedAt: T });
  assert.equal(state.decideRelease(d2, { now: T + 5000 }).kind, "wait");
  assert.equal(state.decideRelease(d2, { now: T + 60000 }).kind, "unobserved");
  const d3 = evidence({ rootExitSeenAt: T, trigger: { kind: "stdin-end", at: T }, contracts: [contract("owner-death")], graceStartedAt: T });
  assert.equal(state.decideRelease(d3, { now: T + 5000 }).kind, "wait");
  assert.equal(state.decideRelease(d3, { now: T + 60000 }).kind, "unobserved");
  const otherProvider = evidence({ rootExitSeenAt: T, trigger: { kind: "stdin-end", at: T }, contracts: [{ ...contract("stdin-end"), provider: "agy" }], graceStartedAt: T });
  assert.equal(state.decideRelease(otherProvider, { now: T + 5000 }).kind, "wait");

  process.env.AGENT_PLUGIN_TEST_CONTRACTS = JSON.stringify([{ ...contract("stdin-end"), platform: process.platform }]);
  process.env.AGENT_PLUGIN_GRACE_MS = "3000";
  t.after(() => {
    delete process.env.AGENT_PLUGIN_TEST_CONTRACTS;
    delete process.env.AGENT_PLUGIN_GRACE_MS;
  });
  assert.equal(state.graceWindowMs("codex"), 3000);
  assert.deepEqual(state.cleanupContracts("codex").map((entry) => entry.trigger), ["stdin-end"]);
  assert.deepEqual(state.cleanupContracts("agy"), []);
  const exited = await startHelperProcess();
  const exitedGone = new Promise((resolve) => exited.process.on("exit", resolve));
  await stopOwnedProcess(exited.process);
  await exitedGone;
  const input = {
    jobId: "j",
    execGen: 1,
    provider: "codex",
    providerVersion: "0.169.0",
    expectedGroupId: null,
    rootRecorded: true,
    root: { pid: exited.pid, startToken: "1" },
    graceStartedAt: null,
    stopDeadline: null
  };
  // A root exit the worker saw is the provider's own exit; no evidence ever names the end of stdin.
  const seen = await state.observeClosure(input, { deadline: performance.now() + 5000, rootExitSeenAt: T });
  assert.equal(seen.root, "absent");
  assert.deepEqual(seen.trigger, { kind: "own-exit", at: T });
  assert.equal(seen.graceMs, 3000);
  const stopped = await state.observeClosure(input, { deadline: performance.now() + 5000, stopResult: "stopped", stoppedAt: T + 5 });
  assert.deepEqual(stopped.trigger, { kind: "tree-stop", at: T + 5 });
  const mismatched = await state.observeClosure(input, { deadline: performance.now() + 5000, stopResult: "mismatch", stoppedAt: T + 5 });
  assert.equal(mismatched.trigger, null);
  const owner = await state.observeClosure({ ...input, graceStartedAt: T }, { deadline: performance.now() + 5000 });
  assert.deepEqual(owner.trigger, { kind: "owner-death", at: T });
});

test("release evidence: no recorded root with an empty and a non-empty group, a mismatched or unknown stop, a mismatched trigger, and an older provider version", () => {
  const T = 2_000_000;
  // A provider whose pid was never recorded has no recorded group to ask, so only grace decides.
  const linuxEmpty = evidence({ platform: "linux", rootRecorded: false, root: "unknown", group: true, graceStartedAt: T });
  assert.equal(state.decideRelease(linuxEmpty, { now: T }).kind, "wait");
  assert.equal(state.decideRelease(linuxEmpty, { now: T + 60000 }).kind, "unobserved");
  const linuxClosed = evidence({ platform: "linux", root: "absent", group: true, graceStartedAt: T });
  assert.equal(state.decideRelease(linuxClosed, { now: T }).kind, "confirmed");
  const linuxBusy = evidence({ platform: "linux", rootRecorded: false, root: "unknown", group: false, graceStartedAt: T });
  assert.equal(state.decideRelease(linuxBusy, { now: T + 1 }).kind, "wait");
  assert.equal(state.decideRelease(linuxBusy, { now: T + 60000 }).kind, "unobserved");
  const linuxRootPresent = evidence({ platform: "linux", root: "present", group: true, graceStartedAt: T });
  assert.equal(state.decideRelease(linuxRootPresent, { now: T + 1 }).kind, "wait");
  const windowsNoRoot = evidence({ rootRecorded: false, root: "unknown", graceStartedAt: T, contracts: [contract("owner-death")], trigger: { kind: "owner-death", at: T } });
  assert.equal(state.decideRelease(windowsNoRoot, { now: T + 5000 }).kind, "wait");
  const noTrigger = evidence({ graceStartedAt: T, contracts: [contract("tree-stop")], trigger: null });
  assert.equal(state.decideRelease(noTrigger, { now: T + 5000 }).kind, "wait");
  assert.equal(state.decideRelease(noTrigger, { now: T + 60000 }).kind, "unobserved");
  const rootAbsentAlone = evidence({ graceStartedAt: null });
  assert.equal(state.decideRelease(rootAbsentAlone, { now: T + 600000 }).kind, "wait");
  const mismatchedTrigger = evidence({ trigger: { kind: "owner-death", at: T }, contracts: [contract("stdin-end")], graceStartedAt: T });
  assert.equal(state.decideRelease(mismatchedTrigger, { now: T + 5000 }).kind, "wait");
  const older = evidence({ providerVersion: "0.168.9", rootExitSeenAt: T, trigger: { kind: "stdin-end", at: T }, contracts: [contract("stdin-end")], graceStartedAt: T });
  assert.equal(state.decideRelease(older, { now: T + 5000 }).kind, "wait");
  assert.equal(state.decideRelease(older, { now: T + 60000 }).kind, "unobserved");
  const unknownVersion = evidence({ providerVersion: null, rootExitSeenAt: T, trigger: { kind: "stdin-end", at: T }, contracts: [contract("stdin-end")] });
  assert.equal(state.decideRelease(unknownVersion, { now: T + 5000 }).kind, "wait");
  const newer = evidence({ providerVersion: "0.170.1", rootExitSeenAt: T, trigger: { kind: "stdin-end", at: T }, contracts: [contract("stdin-end")] });
  assert.equal(state.decideRelease(newer, { now: T + 5000 }).kind, "confirmed");
  assert.equal(state.DEFAULT_GRACE_MS, 60000);
});

// ---------------------------------------------------------------------------------------------
// Heartbeat files and the stale tracker

test("invalid heartbeat windows", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const missingDir = path.join(stateDir, "nowhere");
  assert.throws(() => live.writeLiveFile(missingDir, "worker", { pid: 1, startToken: "x", jobId: "j", execGen: 1 }));

  const job = runningJob(db);
  const claim = { pid: CLAIM.pid, startToken: CLAIM.startToken, jobId: job.jobId, execGen: job.execGen };
  const key = `${job.jobId}:${job.execGen}`;
  const file = path.join(stateDir, "store", "live", `worker-${CLAIM.pid}.json`);
  const tracker = live.createStaleTracker({ stalePolls: 8, gapMs: 4000 });
  let at = 0;
  const poll = () => {
    at += 2000;
    return tracker.observeBatch(at, new Map([[key, { claim, sample: live.readLiveSample(stateDir, claim) }]])).get(key);
  };
  live.writeLiveFile(stateDir, "worker", claim);
  assert.equal(poll().verdict, "fresh");
  fs.writeFileSync(file, "{broken");
  for (let index = 0; index < 3; index += 1) {
    assert.equal(poll().verdict, "counting");
  }
  live.writeLiveFile(stateDir, "worker", claim);
  assert.equal(poll().verdict, "fresh");

  fs.writeFileSync(file, JSON.stringify({ ...claim, execGen: claim.execGen + 1, counter: 50 }));
  let verdict;
  for (let index = 0; index < 8; index += 1) {
    verdict = poll();
  }
  assert.equal(verdict.verdict, "stale");
  assert.equal(state.markStale(db, job.jobId, job.execGen, { claim: verdict.claim, lastValidCounter: verdict.lastValidCounter, stateDir }), true);
  assert.equal(state.readJobView(db, job.jobId).state, "stopping");
  assert.equal(state.readJobView(db, job.jobId).row.stopping_cause, "stale-worker");

  const other = runningJob(db, { title: "malformed" });
  const otherClaim = { pid: CLAIM.pid, startToken: CLAIM.startToken, jobId: other.jobId, execGen: other.execGen };
  fs.writeFileSync(file, JSON.stringify({ ...otherClaim, counter: "seven" }));
  const otherTracker = live.createStaleTracker({ stalePolls: 8, gapMs: 4000 });
  for (let index = 1; index <= 8; index += 1) {
    verdict = otherTracker.observeBatch(index * 2000, new Map([["o", { claim: otherClaim, sample: live.readLiveSample(stateDir, otherClaim) }]])).get("o");
  }
  assert.equal(verdict.verdict, "stale");
  assert.equal(verdict.lastValidCounter, null);
  assert.equal(state.markStale(db, other.jobId, other.execGen, { claim: otherClaim, lastValidCounter: verdict.lastValidCounter, stateDir }), true);
  assert.deepEqual(live.listLiveFiles(stateDir).map((entry) => entry.file), [`worker-${CLAIM.pid}.json`]);
});

// ---------------------------------------------------------------------------------------------
// Scanner and launcher

async function exitedProcess() {
  const helper = await startHelperProcess();
  const gone = new Promise((resolve) => helper.process.on("exit", resolve));
  await stopOwnedProcess(helper.process);
  await gone;
  return helper.pid;
}

// An owner-death contract for this platform that makes a dead worker's cleanup confirmed at once
// on Windows; Linux confirms through the empty worker group instead.
const CLOSURE_CONTRACTS = JSON.stringify([
  { provider: "codex", platform: process.platform, trigger: "owner-death", version: "0.0.1", windowMs: 0 },
  { provider: "codex", platform: process.platform, trigger: "tree-stop", version: "0.0.1", windowMs: 0 }
]);

// A running job whose worker has exited; its provider root identity is recorded and exited.
function deadWorkerJob(stateDir, db, { workerPid, rootPid, groupId, threadId = null, ephemeral = false, submitted = true, recordRoot = true, title = "dead" }) {
  const { jobId } = state.createJob(db, jobFields({ title, threadId, ephemeral }));
  rawExec(
    stateDir,
    `UPDATE jobs SET exec_gen = 1, worker_pid = ${workerPid}, worker_start_token = 'gone-token', claimed_at = 1,
       worker_group_id = ${groupId ?? "NULL"}, spawn_intent_at = 2,
       provider_pid = ${recordRoot ? rootPid : "NULL"}, provider_start_token = ${recordRoot ? "'root-token'" : "NULL"},
       provider_group_id = ${recordRoot ? (groupId ?? "NULL") : "NULL"},
       submit_intent_at = ${submitted ? 3 : "NULL"}, started_at = ${submitted ? 4 : "NULL"},
       request_json = json_set(request_json, '$.providerVersion', '1.0.0'),
       active_thread_key = ${threadId ? `'codex:${threadId}'` : "NULL"}
     WHERE id = '${jobId}'`
  );
  return jobId;
}

test("independent scanners clean one execution once", { timeout: 60000 }, async (t) => {
  const workerPid = await exitedProcess();
  const rootPid = await exitedProcess();
  const stateDir = makeStoreDir(t);
  const db = store.openStore(stateDir);
  const jobId = deadWorkerJob(stateDir, db, { workerPid, rootPid, groupId: workerPid, threadId: "th-scan" });
  db.close();
  const env = { FIXTURE_START_AT: startSoon(1200), AGENT_PLUGIN_TEST_CONTRACTS: CLOSURE_CONTRACTS };
  const results = await Promise.all([0, 1].map(() => runLibChild("fixture.scan", [{ $store: stateDir }], env)));
  for (const result of results) {
    assert.equal(result.ok, true, JSON.stringify(result.error));
  }
  const released = results.flatMap((result) => result.value.released);
  assert.deepEqual(released, [jobId], JSON.stringify(results.map((result) => result.value)));
  const row = rawAll(stateDir, `SELECT end_state, release_kind, end_reason, active_thread_key FROM jobs WHERE id = '${jobId}'`)[0];
  assert.deepEqual(row, { end_state: "interrupted", release_kind: "confirmed", end_reason: "worker-dead", active_thread_key: null });
  assert.equal(rawAll(stateDir, `SELECT count(*) AS n FROM events WHERE job_id = '${jobId}'`)[0].n, 1);
});

test("owner death before the child is recorded keeps stopping, then releases unobserved with a barrier", { timeout: 60000 }, async (t) => {
  process.env.AGENT_PLUGIN_GRACE_MS = "3000";
  t.after(() => delete process.env.AGENT_PLUGIN_GRACE_MS);
  const workerPid = await exitedProcess();
  const providerA = await startHelperProcess();
  const providerB = await startHelperProcess();
  const providerC = await startHelperProcess();
  t.after(() => stopOwnedProcesses([providerA, providerB, providerC].map((helper) => helper.process)));
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const groupOf = (helper) => (process.platform === "win32" ? null : helper.pid);
  const jobs = {
    A: deadWorkerJob(stateDir, db, { workerPid, groupId: groupOf(providerA), threadId: "th-A", recordRoot: false, title: "A" }),
    B: deadWorkerJob(stateDir, db, { workerPid, groupId: groupOf(providerB), threadId: "th-B", recordRoot: false, title: "B" }),
    C: deadWorkerJob(stateDir, db, { workerPid, groupId: groupOf(providerC), threadId: "th-C", recordRoot: false, title: "C" })
  };
  rawExec(stateDir, `UPDATE jobs SET stop_requested_at = 5, stop_reason = 'cancel', stop_deadline = 6, cancel_requested_at = 5 WHERE id = '${jobs.C}'`);
  const scan = () => state.scanWorkspace(db, { deadline: performance.now() + 30000, launch: async () => null, leaderCheck: async () => new Map() });
  const first = await scan();
  assert.deepEqual([...first.stopping].sort(), Object.values(jobs).sort());
  const graceOf = () => Object.fromEntries(rawAll(stateDir, "SELECT title, grace_started_at, stopping_cause FROM jobs").map((row) => [row.title, row]));
  const firstGrace = graceOf();
  for (const name of ["A", "B", "C"]) {
    assert.equal(firstGrace[name].stopping_cause, "unrecorded-child");
    assert.notEqual(firstGrace[name].grace_started_at, null);
    assert.equal(state.readJobView(db, jobs[name]).state, name === "C" ? "stopping" : "stopping");
  }
  await stopOwnedProcess(providerB.process);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await scan();
  const secondGrace = graceOf();
  for (const name of ["A", "C"]) {
    assert.equal(secondGrace[name].grace_started_at, firstGrace[name].grace_started_at);
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await scan();
  const rows = Object.fromEntries(
    rawAll(stateDir, "SELECT title, end_state, release_kind, provider_exit_unobserved, cancelled_at FROM jobs").map((row) => [row.title, row])
  );
  assert.deepEqual(rows.A, { title: "A", end_state: "interrupted", release_kind: "unobserved", provider_exit_unobserved: 1, cancelled_at: null });
  assert.equal(rows.C.end_state, "cancelled");
  assert.equal(rows.C.release_kind, "unobserved");
  const barriers = rawAll(stateDir, "SELECT thread_id FROM thread_barriers ORDER BY thread_id").map((row) => row.thread_id);
  // A provider whose pid was never recorded has no recorded group either, so on every platform
  // only grace decides: B's provider exited, yet B is released unobserved like the others.
  assert.equal(rows.B.release_kind, "unobserved");
  assert.deepEqual(barriers, ["th-A", "th-B", "th-C"]);
  for (const helper of [providerA, providerC]) {
    assert.equal((await processLib.readProcessIdentity(helper.pid, { deadline: performance.now() + 5000 })).state, "present");
  }
  assert.equal(rawAll(stateDir, "SELECT count(*) AS n FROM jobs WHERE continues IS NOT NULL")[0].n, 0);
});

test("a stale mark that loses stops nothing", async (t) => {
  const worker = await startHelperProcess();
  t.after(() => stopOwnedProcess(worker.process));
  const identity = await processLib.readProcessIdentity(worker.pid, { deadline: performance.now() + 5000 });
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const { jobId } = state.createJob(db, jobFields());
  const { execGen } = state.claimExecution(db, jobId, { pid: worker.pid, startToken: identity.startToken, groupId: identity.groupId, limits: { maxParallel: 8 } });
  state.recordIntent(db, jobId, execGen, "spawn", {});
  const claim = { pid: worker.pid, startToken: identity.startToken, jobId, execGen };
  const baseline = live.writeLiveFile(stateDir, "worker", claim);
  const heartbeats = new Map([[`${jobId}:${execGen}`, { verdict: "stale", claim, lastValidCounter: baseline, count: 8 }]]);
  live.writeLiveFile(stateDir, "worker", claim);
  const before = dumpTables(stateDir);
  const result = await state.scanWorkspace(db, { deadline: performance.now() + 30000, heartbeats, launch: async () => null });
  assert.deepEqual(result.released, []);
  assert.deepEqual(dumpTables(stateDir), before);
  assert.equal((await processLib.readProcessIdentity(worker.pid, { deadline: performance.now() + 5000 })).state, "present");
});

test("the store scanner imports no legacy job-record function and never touches jobs/", async (t) => {
  const legacy = [
    "upsertJob",
    "writeJobFile",
    "readJobFile",
    "listJobs",
    "markJobCancelled",
    "takeJobRequest",
    "queueJobMessage",
    "takeJobMessages",
    "withdrawJobMessage",
    "writeJobMessageOutcome",
    "readJobMessageOutcome",
    "markJobResultDelivered",
    "isJobResultDelivered",
    "removeJob",
    "resolveJobFile",
    "createJobRecord",
    "runTrackedJob",
    "reconcileJobLiveness",
    "buildStatusSnapshot",
    "buildSingleJobSnapshot",
    "resolveResultJob",
    "resolveCancelableJob",
    "terminateJobProcesses",
    "terminateProcessTree",
    "readProcessCommandLines",
    "interruptOrphanedTurn"
  ];
  const control = await import("../plugins/agent/scripts/lib/job-control.mjs");
  const sources = {
    scanWorkspace: state.scanWorkspace.toString(),
    reconcileStore: control.reconcileStore.toString(),
    readLeaderStates: control.readLeaderStates.toString(),
    launchWorker: launch.launchWorker.toString(),
    launchEligible: launch.launchEligible.toString()
  };
  for (const [name, source] of Object.entries(sources)) {
    for (const legacyName of legacy) {
      assert.equal(new RegExp(`\\b${legacyName}\\b`).test(source), false, `${name} uses ${legacyName}`);
    }
  }
  const stateDir = makeStoreDir(t);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const record = path.join(jobsDir, "task-old.json");
  fs.writeFileSync(record, '{"id":"task-old","status":"running","pid":1}\n');
  const workerPid = await exitedProcess();
  const db = store.openStore(stateDir);
  deadWorkerJob(stateDir, db, { workerPid, rootPid: workerPid, groupId: workerPid });
  db.close();
  process.env.AGENT_PLUGIN_TEST_CONTRACTS = CLOSURE_CONTRACTS;
  t.after(() => delete process.env.AGENT_PLUGIN_TEST_CONTRACTS);
  await control.reconcileStore(stateDir, { deadline: performance.now() + 10000, leaderCheck: async () => new Map() });
  assert.equal(fs.readFileSync(record, "utf8"), '{"id":"task-old","status":"running","pid":1}\n');
  assert.deepEqual(fs.readdirSync(jobsDir), ["task-old.json"]);
});

// ---------------------------------------------------------------------------------------------
// End-to-end races and crash points on the test driver

const launchModule = launch;

function pointEnv(stateDir, points) {
  const dir = path.join(stateDir, "points");
  fs.mkdirSync(dir, { recursive: true });
  return { dir, env: { AGENT_PLUGIN_TEST_POINTS: points, AGENT_PLUGIN_TEST_POINTS_DIR: dir } };
}

function reached(dir, name) {
  return fs.existsSync(dir) && fs.readdirSync(dir).some((entry) => entry.startsWith(`${name}-`) && entry.endsWith(".reached"));
}

function startRequests(stateDir, jobId) {
  return fx.readTrace(stateDir, jobId).filter((entry) => entry.type === "request" && entry.request === "start");
}

async function scanOnce(db, extra = {}) {
  return state.scanWorkspace(db, { deadline: performance.now() + 30000, launch: async () => null, leaderCheck: async () => new Map(), ...extra });
}

test("no byte reaches the provider before its dispatch commit, at every crash point", { timeout: 180000 }, async (t) => {
  for (const point of ["after-claim", "after-spawn", "after-provider", "after-dispatch", "after-write"]) {
    const stateDir = makeStoreDir(t);
    const db = openTestStore(t, stateDir);
    const jobId = await fx.createDriverJob(db, { delayMs: 30000 });
    mailbox.sendToChain(db, { ref: jobId }, { text: "first message" });
    const pids = fx.trackProcesses(t);
    const { dir, env } = pointEnv(stateDir, point);
    const worker = fx.startTestWorker(stateDir, jobId, fx.workerEnv(env), pids);
    await fx.waitFor(() => reached(dir, point), { describe: point });
    pids.push(...fx.providerIdentities(stateDir, jobId));
    await stopOwnedProcess(worker.child);
    await worker.exit;
    pids.push(...fx.providerIdentities(stateDir, jobId));
    const row = fx.jobRow(stateDir, jobId);
    const message = rawAll(stateDir, "SELECT dispatched_at FROM messages")[0];
    const starts = startRequests(stateDir, jobId);
    if (point === "after-write") {
      assert.equal(starts.length, 1, point);
    } else {
      assert.equal(starts.length, 0, point);
    }
    for (const start of starts) {
      assert.ok(message.dispatched_at !== null && start.at >= message.dispatched_at, `${point}: ${start.at} < ${message.dispatched_at}`);
      assert.ok(row.submit_intent_at !== null && start.at >= row.submit_intent_at, `${point}: before the submit intent`);
    }
    // The first byte of every request, including one written in pieces, follows the commits.
    assert.deepEqual(firstByteViolations(stateDir, jobId), [], point);
  }
});

test("a stop during the dispatch pause sends nothing", { timeout: 60000 }, async (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const jobId = await fx.createDriverJob(db, { delayMs: 30000 });
  const { messageId } = mailbox.sendToChain(db, { ref: jobId }, { text: "paused message" });
  const pids = fx.trackProcesses(t);
  const { dir, env } = pointEnv(stateDir, "after-dispatch");
  const worker = fx.startTestWorker(stateDir, jobId, fx.workerEnv(env), pids);
  await fx.waitFor(() => reached(dir, "after-dispatch"), { describe: "the dispatch pause" });
  pids.push(...fx.providerIdentities(stateDir, jobId));
  state.requestStop(db, { jobIds: [jobId] }, { reason: "session-end" });
  fs.writeFileSync(path.join(dir, "after-dispatch.release"), "");
  const exit = await worker.exit;
  assert.equal(exit.code, 0, exit.stderr);
  assert.deepEqual(startRequests(stateDir, jobId), []);
  const message = rawAll(stateDir, `SELECT state, attempts, dispatched_job_id FROM messages WHERE id = ${messageId}`)[0];
  assert.deepEqual(message, { state: "dispatched", attempts: 1, dispatched_job_id: jobId });
  assert.equal(fx.jobRow(stateDir, jobId).end_state, "interrupted");
});

test("a stop or turn end during the steer pause sends no steer", { timeout: 90000 }, async (t) => {
  for (const variant of ["stop", "turn end"]) {
    const stateDir = makeStoreDir(t);
    const db = openTestStore(t, stateDir);
    const helper = await startHelperProcess();
    const pids = fx.trackProcesses(t);
    pids.push(helper.process);
    const requester = { sessionId: "s", leaderPid: helper.pid, leaderStartToken: null };
    const jobId = await fx.createDriverJob(db, { delayMs: variant === "stop" ? 30000 : 1500, steer: true }, { requester });
    const { dir, env } = pointEnv(stateDir, "after-dispatch#2");
    const worker = fx.startTestWorker(stateDir, jobId, fx.workerEnv(env), pids);
    await fx.waitFor(() => fx.jobRow(stateDir, jobId).started_at !== null, { describe: "the turn start" });
    pids.push(...fx.providerIdentities(stateDir, jobId));
    const { messageId } = mailbox.sendToChain(db, { ref: jobId }, { text: "steer me" });
    await fx.waitFor(() => reached(dir, "after-dispatch"), { describe: "the steer pause" });
    if (variant === "stop") {
      state.requestStop(db, { jobIds: [jobId] }, { reason: "session-end" });
    } else {
      await fx.waitFor(() => fx.readTrace(stateDir, jobId).some((entry) => entry.type === "turn-ended"), { describe: "the turn end" });
    }
    fs.writeFileSync(path.join(dir, "after-dispatch.release"), "");
    const exit = await worker.exit;
    assert.equal(exit.code, 0, `${variant}: ${exit.stderr}`);
    const steers = fx.readTrace(stateDir, jobId).filter((entry) => entry.request === "steer");
    assert.deepEqual(steers, [], variant);
    const message = rawAll(stateDir, `SELECT state, dispatched_job_id FROM messages WHERE id = ${messageId}`)[0];
    assert.deepEqual(message, { state: "dispatched", dispatched_job_id: jobId }, variant);
  }
});

test("no transaction is open at any external boundary", { timeout: 90000 }, async (t) => {
  const stateDir = makeStoreDir(t);
  const txnLog = path.join(stateDir, "txn.log");
  process.env.AGENT_PLUGIN_TEST_TXN_LOG = txnLog;
  t.after(() => delete process.env.AGENT_PLUGIN_TEST_TXN_LOG);
  const db = openTestStore(t, stateDir);
  const jobId = await fx.createDriverJob(db, { delayMs: 30000, steer: true });
  mailbox.sendToChain(db, { ref: jobId }, { text: "opening" });
  const pids = fx.trackProcesses(t);
  const worker = fx.startTestWorker(stateDir, jobId, fx.workerEnv({ AGENT_PLUGIN_TEST_TXN_LOG: txnLog }), pids);
  await fx.waitFor(() => fx.jobRow(stateDir, jobId).started_at !== null, { describe: "the turn start" });
  pids.push(...fx.providerIdentities(stateDir, jobId));
  mailbox.sendToChain(db, { ref: jobId }, { text: "steered" });
  await fx.waitFor(() => fx.readTrace(stateDir, jobId).some((entry) => entry.request === "steer"), { describe: "the steer" });
  const queued = await fx.createDriverJob(db, { delayMs: 100 }, { title: "launched" });
  state.requestStop(db, { jobIds: [jobId] }, { reason: "session-end" });
  await worker.exit;
  const scan = await runLibChild("control.reconcileStore", [stateDir, {}], fx.workerEnv({ AGENT_PLUGIN_TEST_TXN_LOG: txnLog }));
  assert.equal(scan.ok, true, JSON.stringify(scan.error));
  await fx.waitFor(() => fx.jobRow(stateDir, queued).exec_released_at !== null, { timeoutMs: 30000, describe: "the launched job" });
  pids.push(...fx.jobProcesses(stateDir, queued));
  const lines = fs.readFileSync(txnLog, "utf8").trim().split(/\r?\n/);
  const kinds = new Set(lines.map((line) => line.split(" ")[0]));
  for (const kind of ["provider-request", "spawn", "process-query"]) {
    assert.ok(kinds.has(kind), `no ${kind} boundary in ${[...kinds].join(", ")}`);
  }
  assert.deepEqual(
    lines.filter((line) => !line.endsWith(" 0")),
    []
  );
});

test("a job launched twice runs once", { timeout: 240000 }, async (t) => {
  for (let batch = 0; batch < 4; batch += 1) {
    await Promise.all(
      Array.from({ length: 5 }, async () => {
        const stateDir = makeStoreDir(t);
        const db = store.openStore(stateDir);
        const jobId = await fx.createDriverJob(db, { delayMs: 200 });
        db.close();
        const pids = fx.trackProcesses(t);
        const workers = [0, 1].map(() => fx.startTestWorker(stateDir, jobId, fx.workerEnv(), pids));
        const exits = await Promise.all(workers.map((worker) => worker.exit));
        pids.push(...fx.providerIdentities(stateDir, jobId));
        assert.deepEqual(exits.map((exit) => exit.code), [0, 0], exits.map((exit) => exit.stderr).join("\n"));
        const trace = fx.readTrace(stateDir, jobId);
        assert.equal(trace.filter((entry) => entry.type === "spawned").length, 1);
        assert.equal(startRequests(stateDir, jobId).length, 1);
        assert.equal(fx.jobRow(stateDir, jobId).exec_gen, 1);
      })
    );
  }
});

test("a crash between claim and start leaves a resumable stored prompt", { timeout: 60000 }, async (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const jobId = await fx.createDriverJob(db, { delayMs: 200 }, { prompt: "the stored prompt" });
  const pids = fx.trackProcesses(t);
  const { dir, env } = pointEnv(stateDir, "after-claim");
  const worker = fx.startTestWorker(stateDir, jobId, fx.workerEnv(env), pids);
  await fx.waitFor(() => reached(dir, "after-claim"), { describe: "the claim" });
  await stopOwnedProcess(worker.child);
  await worker.exit;
  await scanOnce(db);
  const row = fx.jobRow(stateDir, jobId);
  assert.deepEqual({ state: row.end_state, reason: row.end_reason, method: row.resume_method, release: row.release_kind }, {
    state: "interrupted",
    reason: "worker-dead",
    method: "stored-prompt",
    release: "confirmed"
  });
  const { successorId } = state.decideNext(db, { ref: jobId, observedTipId: jobId }, { action: "continue", requester: REQUESTER });
  const next = fx.startTestWorker(stateDir, successorId, fx.workerEnv(), pids);
  assert.equal((await next.exit).code, 0);
  pids.push(...fx.providerIdentities(stateDir, successorId));
  assert.deepEqual(startRequests(stateDir, successorId).map((entry) => entry.text), ["the stored prompt"]);
});

test("a successor committed by a stopped requester is launched by the next scan with the requester's identity", { timeout: 90000 }, async (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const jobId = await fx.createDriverJob(db, { delayMs: 100 }, { requester: { sessionId: "session-a", leaderPid: null, leaderStartToken: null } });
  const pids = fx.trackProcesses(t);
  assert.equal((await fx.startTestWorker(stateDir, jobId, fx.workerEnv(), pids).exit).code, 0);
  pids.push(...fx.providerIdentities(stateDir, jobId));
  const requesterB = { sessionId: "session-b", leaderPid: 424242, leaderStartToken: "b-token" };
  const { dir, env } = pointEnv(stateDir, "after-decide-commit");
  const requester = runLibChild("state.decideNext", [{ $store: stateDir }, { ref: jobId, observedTipId: jobId }, { action: "continue", message: "hello", requester: requesterB }], env);
  await fx.waitFor(() => reached(dir, "after-decide-commit"), { describe: "the decision commit" });
  await stopOwnedProcess(requester.child);
  await requester;
  const successorId = successorsOf(stateDir, jobId)[0];
  assert.ok(successorId);
  const started = Date.now();
  const scans = await Promise.all([0, 1].map(() => runLibChild("control.reconcileStore", [stateDir, {}], fx.workerEnv())));
  for (const scan of scans) {
    assert.equal(scan.ok, true, JSON.stringify(scan.error));
  }
  await fx.waitFor(() => fx.jobRow(stateDir, successorId).claimed_at !== null, { timeoutMs: 6000, describe: "the successor's claim" });
  t.diagnostic(`successor claimed ${Date.now() - started} ms after the scans started`);
  await fx.waitFor(() => fx.jobRow(stateDir, successorId).exec_released_at !== null, { timeoutMs: 30000, describe: "the successor's release" });
  const row = fx.jobRow(stateDir, successorId);
  pids.push(...fx.jobProcesses(stateDir, successorId));
  assert.equal(row.exec_gen, 1);
  assert.deepEqual([row.session_id, row.leader_pid, row.leader_start_token], ["session-b", 424242, "b-token"]);
  assert.equal(startRequests(stateDir, successorId).length, 1);
  assert.equal(rawAll(stateDir, "SELECT state FROM messages")[0].state, "consumed");
});

test("every post-end crash point ends released", { timeout: 600000 }, async (t) => {
  const behaviours = {
    completed: { delayMs: 150 },
    waiting: { delayMs: 150, question: "which branch?" },
    failed: { delayMs: 150, fail: "it broke" },
    cancelled: { delayMs: 30000 }
  };
  const cases = [];
  for (const endState of ["completed", "waiting", "failed", "cancelled"]) {
    const points = endState === "cancelled" ? ["before-release", "after-release"] : ["after-end", "after-provider-exit", "before-release", "after-release"];
    for (const point of points) {
      for (const successor of endState === "completed" || endState === "waiting" ? [true, false] : [false]) {
        for (const closure of process.platform === "win32" ? [true, false] : [true]) {
          cases.push({ endState, point, successor, closure });
        }
      }
    }
  }
  process.env.AGENT_PLUGIN_GRACE_MS = "1500";
  process.env.AGENT_PLUGIN_TEST_WORKER_ENTRY = fx.FIXTURE_SCRIPT;
  t.after(() => {
    delete process.env.AGENT_PLUGIN_GRACE_MS;
    delete process.env.AGENT_PLUGIN_TEST_WORKER_ENTRY;
    delete process.env.AGENT_PLUGIN_TEST_CONTRACTS;
  });
  const runCase = async ({ endState, point, successor, closure }) => {
    const label = `${endState} ${point} successor=${successor} closure=${closure}`;
    const stateDir = makeStoreDir(t);
    const db = store.openStore(stateDir);
    const pids = fx.trackProcesses(t);
    try {
      const jobId = await fx.createDriverJob(db, behaviours[endState], { allowQuestions: endState === "waiting", threadId: `th-${Math.random().toString(36).slice(2)}` });
      // Without closure a worker never releases, so the release points are never reached: the
      // worker leaves the release to reconciliation, and for "after-release" the fixture commits
      // the unobserved release and its barrier itself.
      const releasePoint = point === "before-release" || point === "after-release";
      const killAtPoint = closure || !releasePoint;
      const { dir, env } = pointEnv(stateDir, point);
      const worker = fx.startTestWorker(stateDir, jobId, fx.workerEnv(killAtPoint ? env : {}, { contracts: closure }), pids);
      await fx.waitFor(() => fx.jobRow(stateDir, jobId).started_at !== null, { describe: `${label}: start` });
      pids.push(...fx.providerIdentities(stateDir, jobId));
      if (successor) {
        mailbox.sendToChain(db, { ref: jobId }, { text: "next" });
      }
      if (endState === "cancelled") {
        state.requestStop(db, { jobIds: [jobId] }, { reason: "cancel", cancel: true });
      }
      if (killAtPoint) {
        await fx.waitFor(() => reached(dir, point), { describe: `${label}: point` });
        await stopOwnedProcess(worker.child);
      }
      await worker.exit;
      if (!killAtPoint && point === "after-release") {
        assert.equal(state.releaseExecution(db, jobId, fx.jobRow(stateDir, jobId).exec_gen, { kind: "unobserved" }), true, label);
      }
      const before = rawAll(stateDir, `SELECT ${END_COLUMNS} FROM jobs WHERE id = '${jobId}'`)[0];
      const eventsBefore = rawAll(stateDir, `SELECT id, kind FROM events WHERE job_id = '${jobId}'`);
      // A stopped job's end is recorded together with its release, so before the release a
      // cancelled job has no end yet; the scan then records it with the release.
      const endWithRelease = endState === "cancelled" && point === "before-release";
      assert.equal(before.end_state, endWithRelease ? null : endState, label);
      const launchSuccessor = (successorJob) => launchModule.launchWorker(db, stateDir, successorJob);
      const scanWith = () => state.scanWorkspace(db, { deadline: performance.now() + 30000, launch: async () => null, leaderCheck: async () => new Map() });
      await scanWith();
      if (fx.jobRow(stateDir, jobId).exec_released_at === null) {
        await new Promise((resolve) => setTimeout(resolve, 1700));
        await scanWith();
      }
      const row = fx.jobRow(stateDir, jobId);
      assert.notEqual(row.exec_released_at, null, label);
      assert.equal(row.release_kind, closure ? "confirmed" : "unobserved", label);
      assert.equal(row.active_thread_key, null, label);
      if (endWithRelease) {
        assert.equal(row.end_state, "cancelled", label);
      } else {
        assert.deepEqual(rawAll(stateDir, `SELECT ${END_COLUMNS} FROM jobs WHERE id = '${jobId}'`)[0], before, label);
      }
      assert.deepEqual(rawAll(stateDir, `SELECT id, kind FROM events WHERE job_id = '${jobId}'`), eventsBefore, label);
      assert.equal(eventsBefore.length, endState === "cancelled" ? 0 : 1, label);
      const successorId = successorsOf(stateDir, jobId)[0] ?? null;
      assert.equal(Boolean(successorId), successor, label);
      if (successorId) {
        if (row.release_kind === "confirmed") {
          const launched = await launchSuccessor(successorId);
          assert.ok(launched, label);
          await fx.waitFor(() => fx.jobRow(stateDir, successorId).exec_released_at !== null, { timeoutMs: 30000, describe: `${label}: successor` });
          pids.push(...fx.jobProcesses(stateDir, successorId));
          assert.ok(fx.jobRow(stateDir, successorId).claimed_at >= row.exec_released_at, label);
          assert.equal(startRequests(stateDir, successorId).length, 1, label);
        } else {
          assert.equal(await launchSuccessor(successorId), null, label);
          assert.equal(fx.jobRow(stateDir, successorId).claimed_at, null, label);
          assert.equal(rawAll(stateDir, "SELECT count(*) AS n FROM thread_barriers")[0].n, 1, label);
        }
      }
    } finally {
      db.close();
    }
  };
  const results = [];
  for (const closure of [true, false]) {
    if (closure) {
      process.env.AGENT_PLUGIN_TEST_CONTRACTS = fx.WORKER_CONTRACTS;
    } else {
      delete process.env.AGENT_PLUGIN_TEST_CONTRACTS;
    }
    const phase = cases.filter((entry) => entry.closure === closure);
    for (let index = 0; index < phase.length; index += 6) {
      const batch = phase.slice(index, index + 6);
      const outcomes = await Promise.allSettled(batch.map(runCase));
      outcomes.forEach((outcome, offset) => results.push({ ...batch[offset], outcome }));
    }
  }
  delete process.env.AGENT_PLUGIN_TEST_CONTRACTS;
  const failures = results.filter((entry) => entry.outcome.status === "rejected");
  t.diagnostic(`${results.length} post-end cases, ${failures.length} failed`);
  assert.deepEqual(
    failures.map((entry) => `${entry.endState} ${entry.point} successor=${entry.successor} closure=${entry.closure}: ${entry.outcome.reason?.message}`),
    []
  );
});

test("a worker never sends a second turn", { timeout: 300000 }, async (t) => {
  process.env.AGENT_PLUGIN_TEST_WORKER_ENTRY = fx.FIXTURE_SCRIPT;
  process.env.AGENT_PLUGIN_TEST_CONTRACTS = fx.WORKER_CONTRACTS;
  t.after(() => {
    delete process.env.AGENT_PLUGIN_TEST_WORKER_ENTRY;
    delete process.env.AGENT_PLUGIN_TEST_CONTRACTS;
  });
  for (const steer of [true, false]) {
    for (let batch = 0; batch < 4; batch += 1) {
      await Promise.all(
        Array.from({ length: 5 }, async (_, index) => {
          const stateDir = makeStoreDir(t);
          const db = store.openStore(stateDir);
          const pids = fx.trackProcesses(t);
          try {
            const jobId = await fx.createDriverJob(db, { delayMs: 400, steer }, { threadId: `th-${batch}-${index}` });
            const worker = fx.startTestWorker(stateDir, jobId, fx.workerEnv(), pids);
            await fx.waitFor(() => fx.jobRow(stateDir, jobId).started_at !== null, { describe: "the turn start" });
            await new Promise((resolve) => setTimeout(resolve, 300 + ((batch * 5 + index) % 5) * 40));
            const sent = mailbox.sendToChain(db, { ref: jobId, observedTipId: jobId }, { text: "racing" });
            if (sent.outcome === "continued") {
              // A send that created the successor launches it, as the send command does; its
              // worker is tracked through its recorded identity once it has run.
              await launchModule.launchWorker(db, stateDir, sent.jobId);
            }
            assert.equal((await worker.exit).code, 0);
            pids.push(...fx.providerIdentities(stateDir, jobId));
            const trace = fx.readTrace(stateDir, jobId);
            assert.equal(startRequests(stateDir, jobId).length, 1);
            // A steer may cross the end notification on its way; the provider then refuses it, and
            // its message waits for the successor. No steer is ever taken after the turn ended.
            const endedAt = trace.findIndex((entry) => entry.type === "turn-ended");
            assert.ok(trace.slice(endedAt + 1).every((entry) => entry.type !== "steer-accepted"), JSON.stringify(trace));
            const successorId = successorsOf(stateDir, jobId)[0] ?? null;
            if (successorId) {
              await fx.waitFor(() => fx.jobRow(stateDir, successorId).exec_released_at !== null, { timeoutMs: 30000, describe: "the successor" });
              pids.push(...fx.jobProcesses(stateDir, successorId));
              assert.equal(startRequests(stateDir, successorId).length, 1);
            }
            const message = rawAll(stateDir, `SELECT state, consumed_job_id FROM messages WHERE id = ${sent.messageId}`)[0];
            assert.equal(message.state, "consumed", JSON.stringify({ message, successorId, sent }));
          } finally {
            db.close();
          }
        })
      );
    }
  }
});

test("admission holds oldest first end to end", { timeout: 300000 }, async (t) => {
  const overlap = (intervals) => {
    const points = intervals.flatMap(([start, end]) => [
      [start, 1],
      [end, -1]
    ]);
    points.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    let current = 0;
    let max = 0;
    for (const [, step] of points) {
      current += step;
      max = Math.max(max, current);
    }
    return max;
  };
  const providerIntervals = (stateDir, ids) =>
    ids
      .map((jobId) => fx.readTrace(stateDir, jobId))
      .filter((trace) => trace.some((entry) => entry.type === "spawned"))
      .map((trace) => [trace.find((entry) => entry.type === "spawned").at, trace.at(-1).at]);
  const executionIntervals = (stateDir) =>
    rawAll(stateDir, "SELECT claimed_at, exec_released_at FROM jobs WHERE claimed_at IS NOT NULL").map((row) => [row.claimed_at, row.exec_released_at ?? Date.now()]);
  const setup = (cohortLog) => {
    const stateDir = makeStoreDir(t);
    fs.writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ maxParallel: { codex: 2 } }));
    const db = openTestStore(t, stateDir);
    return { stateDir, db, env: fx.workerEnv({ AGENT_PLUGIN_TEST_COHORT_LOG: cohortLog(stateDir) }) };
  };
  const cohortLogOf = (stateDir) => path.join(stateDir, "cohort.jsonl");
  const checkCohort = (stateDir) => {
    for (const line of readCohortLog(cohortLogOf(stateDir)).filter((entry) => entry.decision === "claimed")) {
      assert.ok(line.cohort.includes(line.jobId), JSON.stringify(line));
    }
  };

  // A: six queued jobs, all workers at once.
  {
    const { stateDir, db, env } = setup(cohortLogOf);
    const pids = fx.trackProcesses(t);
    const ids = [];
    for (let index = 0; index < 6; index += 1) {
      ids.push(await fx.createDriverJob(db, { delayMs: 1000 }, { title: `A${index}` }));
    }
    for (const jobId of ids) {
      fx.startTestWorker(stateDir, jobId, { ...env }, pids);
    }
    await fx.waitFor(() => ids.every((jobId) => fx.jobRow(stateDir, jobId).exec_released_at !== null), { timeoutMs: 90000, describe: "case A" });
    for (const jobId of ids) {
      pids.push(...fx.jobProcesses(stateDir, jobId));
      assert.equal(fx.jobRow(stateDir, jobId).end_state, "completed");
    }
    assert.ok(overlap(executionIntervals(stateDir)) <= 2, JSON.stringify(rawAll(stateDir, "SELECT title, claimed_at, exec_released_at, end_at FROM jobs ORDER BY claimed_at")));
    assert.ok(overlap(providerIntervals(stateDir, ids)) <= 2, JSON.stringify(providerIntervals(stateDir, ids)));
    checkCohort(stateDir);
  }

  // B and C: three queued jobs, then a new job every 200 ms for 20 seconds; in C the oldest job's
  // thread is held by another running job for its first 5 seconds.
  for (const variant of ["B", "C"]) {
    const { stateDir, db, env } = setup(cohortLogOf);
    const pids = fx.trackProcesses(t);
    // New tasks are launched as a task command launches them: through the launcher, which spawns
    // a worker only for a job in its provider's cohort; releasing workers launch the rest.
    const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    const restoreEnv = () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    };
    t.after(restoreEnv);
    try {
      // Launched workers are tracked through their recorded identities after the drain below.
      const launchJob = async (jobId) => {
        await launchModule.launchWorker(db, stateDir, jobId);
      };
      if (variant === "C") {
        const holder = await fx.createDriverJob(db, { delayMs: 5000 }, { title: "holder", threadId: "th-held" });
        await launchJob(holder);
        await fx.waitFor(() => fx.jobRow(stateDir, holder).started_at !== null, { describe: "the holder" });
      }
      const q = [];
      q.push(await fx.createDriverJob(db, { delayMs: 1000 }, { title: "Q1", threadId: variant === "C" ? "th-held" : null }));
      q.push(await fx.createDriverJob(db, { delayMs: 1000 }, { title: "Q2" }));
      q.push(await fx.createDriverJob(db, { delayMs: 1000 }, { title: "Q3" }));
      for (const jobId of q) {
        await launchJob(jobId);
      }
      const newer = [];
      const until = Date.now() + 20000;
      while (Date.now() < until) {
        const jobId = await fx.createDriverJob(db, { delayMs: 1000 }, { title: `new ${newer.length}` });
        newer.push(jobId);
        await launchJob(jobId);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      await fx.waitFor(() => q.every((jobId) => fx.jobRow(stateDir, jobId).claimed_at !== null), { timeoutMs: 30000, describe: `${variant}: Q claims` });
      state.requestStop(db, { sessionId: "session-1" }, { reason: "session-end", sessionId: "session-1" });
      // Drain: every worker stops by itself; an execution stopped before its provider reported its
      // version cannot match a cleanup contract and is released by a scan after the grace window.
      await fx.waitFor(
        async () => {
          const workers = rawAll(stateDir, "SELECT worker_pid FROM jobs WHERE claimed_at IS NOT NULL AND exec_released_at IS NULL").map((row) => row.worker_pid);
          const identities = await processLib.readProcessIdentities(workers, { deadline: performance.now() + 5000 });
          return workers.every((pid) => identities.get(pid)?.state === "absent");
        },
        { timeoutMs: 60000, intervalMs: 500, describe: `${variant}: workers exit` }
      );
      process.env.AGENT_PLUGIN_GRACE_MS = "0";
      try {
        await state.scanWorkspace(db, { deadline: performance.now() + 30000, launch: async () => null, leaderCheck: async () => new Map() });
        await state.scanWorkspace(db, { deadline: performance.now() + 30000, launch: async () => null, leaderCheck: async () => new Map() });
      } finally {
        delete process.env.AGENT_PLUGIN_GRACE_MS;
      }
      assert.equal(rawAll(stateDir, "SELECT count(*) AS n FROM jobs WHERE claimed_at IS NOT NULL AND exec_released_at IS NULL")[0].n, 0, `${variant}: drain`);
      for (const row of rawAll(stateDir, "SELECT id, worker_pid FROM jobs WHERE worker_pid IS NOT NULL")) {
        pids.push(...fx.jobProcesses(stateDir, row.id));
      }
      const claims = rawAll(stateDir, "SELECT id, claimed_at, exec_released_at FROM jobs WHERE claimed_at IS NOT NULL ORDER BY claimed_at, id");
      const claimedAt = (jobId) => fx.jobRow(stateDir, jobId).claimed_at;
      const releasesBefore = (at) => claims.filter((row) => row.exec_released_at !== null && row.exec_released_at <= at).length;
      if (variant === "B") {
        assert.ok(releasesBefore(claimedAt(q[0])) <= 0 + 2, "Q1");
        assert.ok(releasesBefore(claimedAt(q[1])) <= 1 + 2, "Q2");
        assert.ok(releasesBefore(claimedAt(q[2])) <= 2 + 2, "Q3");
      } else {
        const holderReleased = rawAll(stateDir, "SELECT exec_released_at FROM jobs WHERE title = 'holder'")[0].exec_released_at;
        assert.ok(claimedAt(q[1]) < holderReleased && claimedAt(q[2]) < holderReleased, "Q2 and Q3 claim while Q1's thread is held");
        const releasesAfterHolder = claims.filter((row) => row.exec_released_at !== null && row.exec_released_at >= holderReleased && row.exec_released_at <= claimedAt(q[0]));
        assert.ok(releasesAfterHolder.length <= 2, `Q1 waited ${releasesAfterHolder.length} releases after its thread was free`);
      }
      // Claim order inside a cohort is unspecified, so a newer job may claim before Q3 only from a
      // cohort that also held Q3.
      const claimLines = readCohortLog(cohortLogOf(stateDir)).filter((entry) => entry.decision === "claimed");
      for (const jobId of newer) {
        const at = claimedAt(jobId);
        if (at !== null && at < claimedAt(q[2]) && variant === "B") {
          const line = claimLines.find((entry) => entry.jobId === jobId);
          assert.ok(line && line.cohort.includes(q[2]), `a newer job claimed before Q3 outside Q3's cohort: ${JSON.stringify(line)}`);
        }
      }
      assert.ok(overlap(executionIntervals(stateDir)) <= 2, `${variant}: more than two executions`);
      checkCohort(stateDir);
    } finally {
      restoreEnv();
    }
  }

  // D: as A, with the oldest job's worker exiting before its claim three times.
  {
    const { stateDir, db, env } = setup(cohortLogOf);
    const pids = fx.trackProcesses(t);
    const ids = [await fx.createDriverJob(db, { delayMs: 1000, exitBeforeClaim: true }, { title: "D0" })];
    for (let index = 1; index < 6; index += 1) {
      ids.push(await fx.createDriverJob(db, { delayMs: 1000 }, { title: `D${index}` }));
    }
    const until = Date.now() + 90000;
    while (Date.now() < until) {
      const scan = await runLibChild("control.reconcileStore", [stateDir, {}], env);
      assert.equal(scan.ok, true, JSON.stringify(scan.error));
      const rows = ids.map((jobId) => fx.jobRow(stateDir, jobId));
      if (rows[0].end_state !== null && rows.slice(1).every((row) => row.exec_released_at !== null)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5500));
    }
    const rows = ids.map((jobId) => fx.jobRow(stateDir, jobId));
    for (const row of rows) {
      pids.push(...fx.jobProcesses(stateDir, row.id));
    }
    assert.deepEqual([rows[0].end_state, rows[0].end_reason], ["interrupted", "launch-failed"]);
    assert.equal(fx.readTrace(stateDir, ids[0]).filter((entry) => entry.type === "worker-exit-before-claim").length >= 3, true);
    for (const row of rows.slice(1)) {
      assert.equal(row.end_state, "completed", row.title);
    }
    assert.ok(overlap(executionIntervals(stateDir)) <= 2);
  }
});

test("two continuations of one thread never run their providers at once", { timeout: 300000 }, async (t) => {
  for (let batch = 0; batch < 4; batch += 1) {
    await Promise.all(
      Array.from({ length: 5 }, async (_, index) => {
        const stateDir = makeStoreDir(t);
        const db = store.openStore(stateDir);
        const pids = fx.trackProcesses(t);
        try {
          const threadId = `th-shared-${batch}-${index}`;
          const first = await fx.createDriverJob(db, { delayMs: 100 }, { threadId });
          const firstExit = await fx.startTestWorker(stateDir, first, fx.workerEnv(), pids).exit;
          assert.equal(firstExit.code, 0, firstExit.stderr);
          pids.push(...fx.providerIdentities(stateDir, first));
          const { successorId } = state.decideNext(db, { ref: first, observedTipId: first }, { action: "continue", requester: REQUESTER });
          rawExec(stateDir, `UPDATE jobs SET request_json = json_set(request_json, '$.testDriver.delayMs', 600) WHERE id = '${successorId}'`);
          const second = await fx.createDriverJob(db, { delayMs: 600 }, { threadId, title: "second chain" });
          const workers = [successorId, second].map((jobId) => fx.startTestWorker(stateDir, jobId, fx.workerEnv(), pids));
          const exits = await Promise.all(workers.map((worker) => worker.exit));
          assert.deepEqual(exits.map((exit) => exit.code), [0, 0], exits.map((exit) => exit.stderr).join(" | "));
          const spans = [successorId, second].map((jobId) => {
            const trace = fx.readTrace(stateDir, jobId);
            pids.push(...fx.providerIdentities(stateDir, jobId));
            return [trace.find((entry) => entry.type === "spawned").at, trace.at(-1).at];
          });
          spans.sort((left, right) => left[0] - right[0]);
          assert.ok(spans[0][1] <= spans[1][0], `providers overlapped: ${JSON.stringify(spans)}`);
          const refusals = rawAll(stateDir, `SELECT last_refusal FROM jobs WHERE id IN ('${successorId}', '${second}')`).map((row) => row.last_refusal);
          assert.ok(refusals.includes("thread-busy"), JSON.stringify(refusals));
        } finally {
          db.close();
        }
      })
    );
  }
});

// ---------------------------------------------------------------------------------------------
// Offline recovery

function archivesOf(stateDir) {
  return fs.readdirSync(stateDir).filter((name) => /^store\.corrupt-\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(name));
}

function corruptStore(stateDir) {
  store.openStore(stateDir).close();
  const storeDir = path.join(stateDir, "store");
  fs.writeFileSync(path.join(storeDir, "artifacts", "job-1.log"), "kept output\n");
  fs.writeFileSync(path.join(storeDir, "state.db"), Buffer.from(Array.from({ length: 8192 }, (_, index) => (index * 31) % 253)));
  return { db: sha256(path.join(storeDir, "state.db")), log: sha256(path.join(storeDir, "artifacts", "job-1.log")) };
}

test("store recover offline", { timeout: 180000 }, async (t) => {
  // A: a corrupt store is archived whole and the next open creates a fresh one.
  {
    const stateDir = makeStoreDir(t);
    const hashes = corruptStore(stateDir);
    const result = store.recoverStore(stateDir);
    assert.ok(result.renamedTo);
    const archives = archivesOf(stateDir);
    assert.equal(archives.length, 1);
    assert.equal(path.basename(result.renamedTo), archives[0]);
    assert.equal(sha256(path.join(stateDir, archives[0], "state.db")), hashes.db);
    assert.equal(sha256(path.join(stateDir, archives[0], "artifacts", "job-1.log")), hashes.log);
    assert.equal(fs.existsSync(path.join(stateDir, "store")), false);
    const fresh = store.openStore(stateDir);
    assert.equal(fresh.read((db) => db.prepare("PRAGMA user_version").get().user_version), store.SCHEMA_VERSION);
    fresh.close();
    // C: a second run finds the fresh store healthy and moves nothing.
    assert.deepEqual(store.recoverStore(stateDir), { healthy: true });
    assert.equal(archivesOf(stateDir).length, 1);
  }
  // B: a healthy store is left alone; D: with force it is archived.
  {
    const stateDir = makeStoreDir(t);
    store.openStore(stateDir).close();
    const before = sha256(path.join(stateDir, "store", "state.db"));
    assert.deepEqual(store.recoverStore(stateDir), { healthy: true });
    assert.deepEqual(archivesOf(stateDir), []);
    assert.equal(sha256(path.join(stateDir, "store", "state.db")), before);
    const forced = store.recoverStore(stateDir, { force: true });
    assert.ok(forced.renamedTo);
    assert.equal(sha256(path.join(forced.renamedTo, "state.db")), before);
  }
  // E: a recovery stopped by its pid at a random moment leaves the store or one whole archive.
  const outcomes = new Set();
  for (let repetition = 0; repetition < 20; repetition += 1) {
    const stateDir = makeStoreDir(t);
    store.openStore(stateDir).close();
    const before = sha256(path.join(stateDir, "store", "state.db"));
    const child = runLibChild("store.recoverStore", [stateDir, { force: true }]);
    await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 250)));
    // A recovery that already finished is not stopped.
    await stopOwnedProcess(child.child);
    await child;
    const archives = archivesOf(stateDir);
    const storeExists = fs.existsSync(path.join(stateDir, "store"));
    assert.ok((storeExists && archives.length === 0) || (!storeExists && archives.length === 1), `repetition ${repetition}: ${fs.readdirSync(stateDir)}`);
    const dbFile = storeExists ? path.join(stateDir, "store", "state.db") : path.join(stateDir, archives[0], "state.db");
    assert.equal(sha256(dbFile), before, `repetition ${repetition}`);
    outcomes.add(storeExists ? "untouched" : "archived");
  }
  t.diagnostic(`stopped recoveries: ${[...outcomes].join(", ")}`);
});

function spawnHolder(mode, args, pids) {
  const child = fx.spawnFixture(mode, args, {}, { detached: true });
  pids.push(child);
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  const exit = new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout })));
  const ready = fx.waitFor(() => stdout.includes("ready"), { describe: `${mode} ready` });
  return { child, exit, ready, output: () => stdout };
}

test("store recover with a live holder", { timeout: 180000 }, async (t) => {
  process.env.AGENT_PLUGIN_TEST_INTEGRITY_FAIL = "1";
  t.after(() => delete process.env.AGENT_PLUGIN_TEST_INTEGRITY_FAIL);
  const results = [];
  for (const holderKind of ["worker", "reader", "waiter", "folder"]) {
    const stateDir = makeStoreDir(t);
    const db = store.openStore(stateDir);
    const pids = fx.trackProcesses(t);
    const jobId = await fx.createDriverJob(db, { delayMs: 60000 });
    const { messageId } = mailbox.sendToChain(db, { ref: jobId }, { text: "waiting for receipt" });
    db.close();
    let holder;
    let providers = [];
    let providerTargets = [];
    if (holderKind === "worker") {
      const worker = fx.startTestWorker(stateDir, jobId, fx.workerEnv(), pids);
      await fx.waitFor(() => fx.jobRow(stateDir, jobId).started_at !== null, { describe: "the worker's turn" });
      providers = fx.providerPids(stateDir, jobId);
      providerTargets = fx.providerIdentities(stateDir, jobId);
      pids.push(...providerTargets);
      holder = { child: worker.child, exit: worker.exit };
    } else if (holderKind === "reader") {
      holder = spawnHolder("reader", [stateDir], pids);
      await holder.ready;
    } else if (holderKind === "waiter") {
      holder = spawnHolder("waiter", [stateDir, jobId, messageId], pids);
      await holder.ready;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } else {
      holder = spawnHolder("folder-holder", [path.join(stateDir, "store")], pids);
      await holder.ready;
    }
    let first;
    try {
      first = store.recoverStore(stateDir);
    } catch (error) {
      first = error;
    }
    if (process.platform === "win32") {
      if (holderKind === "folder") {
        results.push(`folder-only holder on Windows: ${first instanceof store.StoreError ? `refused (${first.class})` : "renamed"}`);
        assert.ok(first instanceof store.StoreError ? first.class === "in-use" : Boolean(first.renamedTo));
      } else {
        assert.ok(first instanceof store.StoreError && first.class === "in-use", `${holderKind}: ${first?.message ?? JSON.stringify(first)}`);
        assert.ok(Array.isArray(first.liveFiles));
        if (holderKind === "worker") {
          assert.ok(first.liveFiles.some((entry) => entry.role === "worker"), JSON.stringify(first.liveFiles));
        }
        assert.match(first.message, /close/i);
        assert.deepEqual(archivesOf(stateDir), []);
        results.push(`${holderKind} on Windows: refused, ${first.liveFiles.length} identity files listed`);
      }
      if (!(first?.renamedTo)) {
        await stopOwnedProcess(holder.child);
        await holder.exit;
        await stopOwnedProcesses(providerTargets);
        const second = store.recoverStore(stateDir);
        assert.ok(second.renamedTo, holderKind);
        assert.equal(archivesOf(stateDir).length, 1);
      }
    } else {
      assert.ok(first.renamedTo, `${holderKind}: ${first?.message}`);
      if (holderKind === "folder") {
        results.push("folder-only holder on Linux: renamed");
        await stopOwnedProcess(holder.child);
        await holder.exit;
        continue;
      }
      const started = Date.now();
      const exit = await holder.exit;
      const waited = Date.now() - started;
      assert.equal(exit.code, 1, `${holderKind}: ${exit.stdout ?? exit.stderr}`);
      assert.ok(waited <= 1500, `${holderKind} took ${waited} ms`);
      if (holderKind === "worker") {
        await fx.waitFor(async () => {
          const identities = await processLib.readProcessIdentities(providers, { deadline: performance.now() + 2000 });
          return providers.every((pid) => identities.get(pid)?.state === "absent");
        }, { timeoutMs: 2000, describe: "the provider's exit" });
      } else {
        assert.match(exit.stdout, /store-moved/);
      }
      results.push(`${holderKind} on Linux: renamed, holder exited 1 after ${waited} ms`);
    }
  }
  t.diagnostic(results.join("; "));
});

// ---------------------------------------------------------------------------------------------
// Library review findings (store primitives)

test("an execution keeps the first thread it recorded", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const a = runningJob(db, { title: "A", threadId: "first" });
  const before = dumpTables(stateDir);
  const changed = state.recordThread(db, a.jobId, a.execGen, { threadId: "second", resumeMethod: "thread" });
  assert.equal(changed.ok, false, JSON.stringify(changed));
  assert.deepEqual(dumpTables(stateDir), before);
  assert.deepEqual(state.recordThread(db, a.jobId, a.execGen, { threadId: "first", resumeMethod: "thread" }), { ok: true });
  const b = state.createJob(db, jobFields({ title: "B", threadId: "first" }));
  assert.deepEqual(state.claimExecution(db, b.jobId, { ...CLAIM, pid: 5151 }), { claimed: false, reason: "thread-busy" });
  assert.equal(rawAll(stateDir, `SELECT active_thread_key FROM jobs WHERE id = '${a.jobId}'`)[0].active_thread_key, "codex:first");
});

test("an interruption recorded after a committed cancel request ends the job cancelled", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const job = runningJob(db, { threadId: "th-cancel" });
  mailbox.sendToChain(db, { ref: job.jobId }, { text: "open" });
  state.requestStop(db, { jobIds: [job.jobId] }, { reason: "cancel", cancel: true });
  const outcome = state.recordEnd(db, job.jobId, { state: "interrupted", by: "worker", reason: "session-end", execGen: job.execGen, leader: "unknown" });
  assert.equal(outcome.won, true);
  const row = rawAll(stateDir, `SELECT end_state FROM jobs WHERE id = '${job.jobId}'`)[0];
  assert.equal(row.end_state, "cancelled");
  assert.equal(rawAll(stateDir, `SELECT count(*) AS n FROM events WHERE job_id = '${job.jobId}'`)[0].n, 0);
  assert.deepEqual(rawAll(stateDir, `SELECT state, close_cause FROM messages WHERE chain_id = '${job.jobId}'`), [{ state: "dropped", close_cause: "cancelled" }]);
});

test("an automatic continuation needs a deliverable message inside its decision", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const { jobId } = endedJob(db);
  const before = dumpTables(stateDir);
  const outcome = state.decideNext(db, { ref: jobId, observedTipId: jobId }, { action: "continue", automatic: true, leader: "alive" });
  assert.equal(outcome.won, false, JSON.stringify(outcome));
  assert.deepEqual(dumpTables(stateDir), before);
});

test("a launch failure observed before a newer attempt changes nothing", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const [jobId] = createQueued(db, 1);
  for (const at of [100000, 106000]) {
    assert.equal(state.recordLaunchAttempt(db, jobId, { now: at }).ok, true);
  }
  const observed = rawAll(stateDir, `SELECT launch_attempts, last_launch_at FROM jobs WHERE id = '${jobId}'`)[0];
  assert.equal(state.recordLaunchAttempt(db, jobId, { now: 112000 }).ok, true);
  const failed = state.endLaunchFailed(db, jobId, { observed: { attempts: observed.launch_attempts, lastLaunchAt: observed.last_launch_at } });
  assert.equal(failed, false);
  assert.equal(rawAll(stateDir, `SELECT end_state FROM jobs WHERE id = '${jobId}'`)[0].end_state, null);
  const current = rawAll(stateDir, `SELECT launch_attempts, last_launch_at FROM jobs WHERE id = '${jobId}'`)[0];
  assert.equal(state.endLaunchFailed(db, jobId, { observed: { attempts: current.launch_attempts, lastLaunchAt: current.last_launch_at } }), true);
});

test("a fourth launch attempt is refused after three attempts without a claim or refusal", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const [jobId] = createQueued(db, 1);
  for (const at of [100000, 106000, 112000]) {
    assert.equal(state.recordLaunchAttempt(db, jobId, { now: at }).ok, true);
  }
  const before = dumpTables(stateDir);
  const fourth = state.recordLaunchAttempt(db, jobId, { now: 118000 });
  assert.equal(fourth.ok, false, JSON.stringify(fourth));
  assert.deepEqual(dumpTables(stateDir), before);
  assert.equal(state.endLaunchFailed(db, jobId), true);
  assert.equal(state.readJobView(db, jobId).row.end_reason, "launch-failed");
});

test("a release that saw no provider root refuses once a root is recorded", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const { jobId } = state.createJob(db, jobFields({ threadId: "th-root" }));
  const { execGen } = state.claimExecution(db, jobId, CLAIM);
  state.recordIntent(db, jobId, execGen, "spawn", {});
  state.recordIntent(db, jobId, execGen, "provider", { pid: 777, startToken: "root" });
  const before = dumpTables(stateDir);
  const released = state.releaseExecution(db, jobId, execGen, { kind: "unobserved", expectedRoot: null });
  assert.equal(released, false);
  assert.deepEqual(dumpTables(stateDir), before);
  assert.equal(state.releaseExecution(db, jobId, execGen, { kind: "unobserved", expectedRoot: { pid: 777 } }), true);
});

// ---------------------------------------------------------------------------------------------
// Library review findings (closure evidence)

const windowsOnly = process.platform === "win32" ? {} : { skip: "Windows stop and contract semantics" };
const linuxOnly = process.platform === "linux" ? {} : { skip: "Linux process groups" };

test("a failed tree stop followed by the root's own exit is not a stop", windowsOnly, async (t) => {
  const helper = await startHelperProcess();
  t.after(() => stopOwnedProcess(helper.process));
  const observed = await processLib.readProcessIdentity(helper.pid, { deadline: performance.now() + 5000 });
  process.env.AGENT_PLUGIN_TEST_PROCESS = JSON.stringify({ stopCommandFails: true });
  t.after(() => delete process.env.AGENT_PLUGIN_TEST_PROCESS);
  const result = await processLib.stopTree({ pid: helper.pid, startToken: observed.startToken }, { deadline: performance.now() + 10000 });
  assert.equal(result, "absent");
});

test("an emptiness check of a process group is the kernel's answer for the whole group", linuxOnly, async (t) => {
  const member = await startHelperProcess();
  t.after(() => stopOwnedProcess(member.process));
  const observed = await processLib.readProcessIdentity(member.pid, { deadline: performance.now() + 5000 });
  assert.equal(await processLib.groupHasMembers(observed.groupId), true);
  const memberGone = new Promise((resolve) => member.process.on("exit", resolve));
  await stopOwnedProcess(member.process);
  await memberGone;
  assert.equal(await processLib.groupHasMembers(observed.groupId), false);
});

// ---------------------------------------------------------------------------------------------
// Library review findings (the worker's stop paths)

async function absentWithin(pids, deadlineMs) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const identities = await processLib.readProcessIdentities(pids, { deadline: performance.now() + 3000 });
    if (pids.every((pid) => identities.get(pid)?.state === "absent")) {
      return true;
    }
    if (Date.now() > until) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("a stopped job whose provider closure is undecided reads stopping, never interrupted", { timeout: 60000 }, async (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const pids = fx.trackProcesses(t);
  const jobId = await fx.createDriverJob(db, { delayMs: 60000, interrupt: true, ignoreInterrupt: true, ignoreEof: true }, { threadId: "th-undecided" });
  const env = fx.workerEnv({ AGENT_PLUGIN_TEST_PROCESS: JSON.stringify({ stopFails: true }) });
  const worker = fx.startTestWorker(stateDir, jobId, env, pids);
  await fx.waitFor(() => fx.jobRow(stateDir, jobId).started_at !== null, { describe: "the turn start" });
  pids.push(...fx.providerIdentities(stateDir, jobId));
  state.requestStop(db, { jobIds: [jobId] }, { reason: "session-end" });
  const exit = await worker.exit;
  assert.equal(exit.code, 0, exit.stderr);
  const row = fx.jobRow(stateDir, jobId);
  assert.equal(row.end_state, null, `end ${row.end_state} recorded before the release was decided`);
  assert.equal(row.exec_released_at, null);
  assert.equal(row.stopping_cause, "unconfirmed-stop");
  assert.equal(state.readJobView(db, jobId).state, "stopping");
  assert.throws(() => state.decideNext(db, { ref: jobId, observedTipId: jobId }, { action: "continue", requester: REQUESTER }), state.JobStoppingError);
});

test("a worker stopped where the end used to be committed leaves no interrupted end", { timeout: 60000 }, async (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const pids = fx.trackProcesses(t);
  const jobId = await fx.createDriverJob(db, { delayMs: 60000, interrupt: true }, { threadId: "th-crash" });
  const { dir, env } = pointEnv(stateDir, "before-release");
  const worker = fx.startTestWorker(stateDir, jobId, fx.workerEnv(env), pids);
  await fx.waitFor(() => fx.jobRow(stateDir, jobId).started_at !== null, { describe: "the turn start" });
  pids.push(...fx.providerIdentities(stateDir, jobId));
  state.requestStop(db, { jobIds: [jobId] }, { reason: "session-end" });
  await fx.waitFor(() => reached(dir, "before-release"), { describe: "the release point" });
  await stopOwnedProcess(worker.child);
  await worker.exit;
  const row = fx.jobRow(stateDir, jobId);
  assert.equal(row.end_state, null, `end ${row.end_state} committed before the release`);
  assert.notEqual(state.readJobView(db, jobId).state, "interrupted");
});

test("a stop that arrives during the natural shutdown is honoured against its deadline", { timeout: 60000 }, async (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const pids = fx.trackProcesses(t);
  const jobId = await fx.createDriverJob(db, { delayMs: 200, ignoreEof: true }, { threadId: "th-late-stop" });
  const { dir, env } = pointEnv(stateDir, "before-shutdown");
  const worker = fx.startTestWorker(stateDir, jobId, fx.workerEnv(env), pids);
  await fx.waitFor(() => reached(dir, "before-shutdown"), { describe: "the natural shutdown" });
  const providers = fx.providerPids(stateDir, jobId);
  pids.push(...fx.providerIdentities(stateDir, jobId));
  const endBefore = fx.jobRow(stateDir, jobId).end_state;
  state.requestStop(db, { jobIds: [jobId] }, { reason: "session-end", afterMs: 1500 });
  const committedAt = Date.now();
  fs.writeFileSync(path.join(dir, "before-shutdown.release"), "");
  assert.equal((await worker.exit).code, 0);
  t.diagnostic(`worker exited ${Date.now() - committedAt} ms after the stop commit (stored deadline 1500 ms)`);
  assert.equal(await absentWithin(providers, 2000), true);
  const log = fs.readFileSync(path.join(stateDir, "store", "artifacts", `${jobId}.log`), "utf8");
  const observed = /stop observed at ([\d.]+); local deadline ([\d.]+)/.exec(log);
  const stopped = /tree stop at ([\d.]+)/.exec(log);
  assert.ok(observed, `the stop was never observed: ${log}`);
  assert.ok(stopped, `no tree stop: ${log}`);
  assert.ok(Number(stopped[1]) <= Number(observed[2]), `tree stop at ${stopped[1]} after the local deadline ${observed[2]}`);
  assert.equal(fx.jobRow(stateDir, jobId).end_state, endBefore);
});

test("a provider's own exit after its turn is not an end of stdin", { ...windowsOnly, timeout: 60000 }, async (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const pids = fx.trackProcesses(t);
  const stdinOnly = JSON.stringify([{ provider: "codex", platform: process.platform, trigger: "stdin-end", version: "0.0.1", windowMs: 0 }]);
  const jobId = await fx.createDriverJob(db, { delayMs: 200, exitAfterTurn: true }, { threadId: "th-own-exit" });
  const exit = await fx.startTestWorker(stateDir, jobId, fx.workerEnv({ AGENT_PLUGIN_TEST_CONTRACTS: stdinOnly }, { contracts: false }), pids).exit;
  pids.push(...fx.providerIdentities(stateDir, jobId));
  assert.equal(exit.code, 0, exit.stderr);
  assert.ok(fx.readTrace(stateDir, jobId).some((entry) => entry.type === "own-exit"));
  const row = fx.jobRow(stateDir, jobId);
  assert.equal(row.end_state, "completed");
  assert.notEqual(row.release_kind, "confirmed", "a spontaneous exit matched the stdin-end contract");
  assert.equal(row.active_thread_key, "codex:th-own-exit");
});

// ---------------------------------------------------------------------------------------------
// Closure evidence while the worker is alive

const contractsFor = (...triggers) =>
  JSON.stringify(triggers.map((trigger) => ({ provider: "codex", platform: process.platform, trigger, version: "0.0.1", windowMs: 0 })));

test("a provider that forks a child and exits keeps its closure occupied until the child is gone", { ...linuxOnly, timeout: 60000 }, async (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const pids = fx.trackProcesses(t);
  const jobId = await fx.createDriverJob(db, { delayMs: 100, forkAndExit: 2500 }, { threadId: "th-fork" });
  // An empty /proc listing stands for two listings that both miss a child forked between them;
  // the closure check must not depend on listings.
  const env = fx.workerEnv({ AGENT_PLUGIN_TEST_PROCESS: JSON.stringify({ procListing: "empty" }) });
  const exit = await fx.startTestWorker(stateDir, jobId, env, pids).exit;
  pids.push(...fx.providerIdentities(stateDir, jobId));
  assert.equal(exit.code, 0, exit.stderr);
  const forked = fx.readTrace(stateDir, jobId).find((entry) => entry.type === "forked");
  assert.ok(forked, "the provider did not fork its child");
  const forkedExit = await fx.waitFor(() => fx.readTrace(stateDir, jobId).find((entry) => entry.type === "forked-exit"), {
    timeoutMs: 15000,
    describe: "the forked child's exit"
  });
  const row = fx.jobRow(stateDir, jobId);
  assert.ok(
    row.exec_released_at === null || row.exec_released_at >= forkedExit.at,
    `released ${row.release_kind} at ${row.exec_released_at} while the forked child ran until ${forkedExit.at}`
  );
  // Once the child is gone, the provider's empty group confirms the closure.
  await state.scanWorkspace(db, { deadline: performance.now() + 30000, launch: async () => null, leaderCheck: async () => new Map() });
  const after = fx.jobRow(stateDir, jobId);
  assert.equal(after.release_kind, "confirmed");
  assert.equal(after.provider_group_id, after.provider_pid);
});

test("on Windows no release credits the end of stdin; the idle provider is released by its tree stop", { ...windowsOnly, timeout: 60000 }, async (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const pids = fx.trackProcesses(t);
  // Only a stdin-end contract: a release that credits the end of stdin would be confirmed.
  const stdinJob = await fx.createDriverJob(db, { delayMs: 100 }, { threadId: "th-stdin-only" });
  const stdinExit = await fx.startTestWorker(stateDir, stdinJob, fx.workerEnv({ AGENT_PLUGIN_TEST_CONTRACTS: contractsFor("stdin-end") }), pids).exit;
  pids.push(...fx.providerIdentities(stateDir, stdinJob));
  assert.equal(stdinExit.code, 0, stdinExit.stderr);
  const stdinRow = fx.jobRow(stateDir, stdinJob);
  assert.equal(stdinRow.end_state, "completed");
  assert.notEqual(stdinRow.release_kind, "confirmed", "a root exit after the end of stdin was credited to the stdin-end contract");
  assert.equal(stdinRow.active_thread_key, "codex:th-stdin-only");
  // Only a tree-stop contract: the worker stops the idle provider through its handle and releases.
  const stopJob = await fx.createDriverJob(db, { delayMs: 100 }, { threadId: "th-tree-stop" });
  const stopExit = await fx.startTestWorker(stateDir, stopJob, fx.workerEnv({ AGENT_PLUGIN_TEST_CONTRACTS: contractsFor("tree-stop") }), pids).exit;
  pids.push(...fx.providerIdentities(stateDir, stopJob));
  assert.equal(stopExit.code, 0, stopExit.stderr);
  const stopRow = fx.jobRow(stateDir, stopJob);
  assert.equal(stopRow.end_state, "completed");
  assert.equal(stopRow.release_kind, "confirmed");
  assert.equal(fx.readTrace(stateDir, stopJob).some((entry) => entry.type === "eof"), false, "the worker ended the provider's input on Windows");
  assert.match(fs.readFileSync(path.join(stateDir, "store", "artifacts", `${stopJob}.log`), "utf8"), /tree stop at/);
});

test("a slow process query never takes the stop path past the stored deadline", { timeout: 60000 }, async (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const pids = fx.trackProcesses(t);
  const jobId = await fx.createDriverJob(db, { delayMs: 60000, interrupt: true, ignoreInterrupt: true, ignoreEof: true }, { threadId: "th-slow-query" });
  const env = fx.workerEnv({ AGENT_PLUGIN_TEST_PROCESS: JSON.stringify({ queryDelayMs: 2000 }) });
  const worker = fx.startTestWorker(stateDir, jobId, env, pids);
  await fx.waitFor(() => fx.jobRow(stateDir, jobId).started_at !== null, { timeoutMs: 20000, describe: "the turn start" });
  pids.push(...fx.providerIdentities(stateDir, jobId));
  state.requestStop(db, { jobIds: [jobId] }, { reason: "session-end", afterMs: 3000 });
  const committedAt = Date.now();
  const exit = await worker.exit;
  const elapsed = Date.now() - committedAt;
  t.diagnostic(`worker exited ${elapsed} ms after the stop commit (stored deadline 3000 ms)`);
  assert.equal(exit.code, 0, exit.stderr);
  // The margin covers the worker's exit after its last write and the test's own wait for it.
  assert.ok(elapsed <= 3000 + 1000, `the stop path ran ${elapsed} ms against a 3000 ms deadline`);
});

test("a stop of a held root that already exited is its own exit, never a tree stop", { timeout: 30000 }, async (t) => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", detached: process.platform === "linux", windowsHide: true });
  t.after(() => stopOwnedProcess(child));
  await new Promise((resolve) => child.once("spawn", resolve));
  // Blocks the event loop past the child's exit, so its exit event is not processed yet and this
  // process still holds its handle.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  assert.equal(child.exitCode, null, "the exit event was processed before the stop");
  const result = await processLib.stopHeldTree(child, { groupId: child.pid, deadline: performance.now() + 10000 });
  assert.equal(result, "absent");
});

test("a worker killed after its provider started leaves the provider group to the scanner, which stops it", { ...linuxOnly, timeout: 60000 }, async (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const pids = fx.trackProcesses(t);
  // The provider ignores the end of its input, so it outlives its worker with its child.
  const jobId = await fx.createDriverJob(db, { delayMs: 60000, spawnChild: true, ignoreEof: true }, { threadId: "th-killed-worker" });
  const worker = fx.startTestWorker(stateDir, jobId, fx.workerEnv(), pids);
  await fx.waitFor(() => fx.jobRow(stateDir, jobId).started_at !== null, { describe: "the turn start" });
  await fx.waitFor(() => fx.readTrace(stateDir, jobId).some((entry) => entry.type === "child-identity"), { describe: "the provider's child" });
  const targets = fx.providerIdentities(stateDir, jobId);
  pids.push(...targets);
  const row = fx.jobRow(stateDir, jobId);
  assert.equal(row.provider_group_id, row.provider_pid, "the provider does not lead its own group");
  await stopOwnedProcess(worker.child);
  await worker.exit;
  const scanned = await state.scanWorkspace(db, { deadline: performance.now() + 30000, launch: async () => null, leaderCheck: async () => new Map() });
  assert.equal(await absentWithin(targets.map((target) => target.pid), 5000), true, "the provider group outlived the scan");
  const after = fx.jobRow(stateDir, jobId);
  assert.equal(after.release_kind, "confirmed", JSON.stringify(scanned));
});

test("a worker that dies between the spawn and recording the provider leaves stopping, unrecorded-child, then grace", { timeout: 60000 }, async (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const pids = fx.trackProcesses(t);
  const jobId = await fx.createDriverJob(db, { delayMs: 60000, traceSelf: true }, { threadId: "th-unrecorded" });
  const { dir, env } = pointEnv(stateDir, "after-spawn");
  const worker = fx.startTestWorker(stateDir, jobId, fx.workerEnv(env), pids);
  await fx.waitFor(() => reached(dir, "after-spawn"), { describe: "the spawn point" });
  await fx.waitFor(() => fx.readTrace(stateDir, jobId).some((entry) => entry.type === "child-identity"), { describe: "the provider's identity" });
  pids.push(...fx.providerIdentities(stateDir, jobId));
  await stopOwnedProcess(worker.child);
  await worker.exit;
  assert.equal(fx.jobRow(stateDir, jobId).provider_pid, null);
  process.env.AGENT_PLUGIN_GRACE_MS = "1500";
  t.after(() => delete process.env.AGENT_PLUGIN_GRACE_MS);
  const scan = () => state.scanWorkspace(db, { deadline: performance.now() + 30000, launch: async () => null, leaderCheck: async () => new Map() });
  const first = await scan();
  assert.deepEqual(first.stopping, [jobId]);
  const marked = fx.jobRow(stateDir, jobId);
  assert.equal(marked.stopping_cause, "unrecorded-child");
  assert.notEqual(marked.grace_started_at, null);
  assert.equal(marked.exec_released_at, null);
  await new Promise((resolve) => setTimeout(resolve, 1700));
  await scan();
  assert.equal(fx.jobRow(stateDir, jobId).release_kind, "unobserved");
});

test("a held stop with no time left before the deadline starts no stop command and leaves stopping", { ...windowsOnly, timeout: 60000 }, async (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const pids = fx.trackProcesses(t);
  const jobId = await fx.createDriverJob(db, { delayMs: 60000, interrupt: true, ignoreInterrupt: true, ignoreEof: true }, { threadId: "th-no-time" });
  const worker = fx.startTestWorker(stateDir, jobId, fx.workerEnv(), pids);
  await fx.waitFor(() => fx.jobRow(stateDir, jobId).started_at !== null, { timeoutMs: 20000, describe: "the turn start" });
  pids.push(...fx.providerIdentities(stateDir, jobId));
  // A stored deadline at the commit itself: the worker observes it already passed.
  state.requestStop(db, { jobIds: [jobId] }, { reason: "session-end", afterMs: 0 });
  const committedAt = Date.now();
  const exit = await worker.exit;
  const elapsed = Date.now() - committedAt;
  t.diagnostic(`worker exited ${elapsed} ms after a stop whose deadline was the commit`);
  assert.equal(exit.code, 0, exit.stderr);
  const log = fs.readFileSync(path.join(stateDir, "store", "artifacts", `${jobId}.log`), "utf8");
  assert.match(log, /tree stop not started: no time left before the deadline/);
  const row = fx.jobRow(stateDir, jobId);
  assert.equal(row.exec_released_at, null, `released ${row.release_kind} with no stop made`);
  assert.equal(row.stopping_cause, "unconfirmed-stop");
  // The stop poll observes the request within 0.5 s; the margin covers the worker's own exit.
  assert.ok(elapsed <= 500 + 1000, `the stop path ran ${elapsed} ms after a deadline that had already passed`);
});

test("a root exit the worker saw without an own-exit contract is never credited later as owner death", { ...windowsOnly, timeout: 60000 }, async (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const pids = fx.trackProcesses(t);
  // The provider exits by itself after its turn, but its driver does not declare that it does.
  const jobId = await fx.createDriverJob(db, { delayMs: 100, exitAfterTurn: true, ownExit: false }, { threadId: "th-seen-exit" });
  const contracts = contractsFor("owner-death", "tree-stop");
  const exit = await fx.startTestWorker(stateDir, jobId, fx.workerEnv({ AGENT_PLUGIN_TEST_CONTRACTS: contracts }), pids).exit;
  pids.push(...fx.providerIdentities(stateDir, jobId));
  assert.equal(exit.code, 0, exit.stderr);
  assert.ok(fx.readTrace(stateDir, jobId).some((entry) => entry.type === "own-exit"));
  const left = fx.jobRow(stateDir, jobId);
  assert.equal(left.end_state, "completed");
  assert.equal(left.exec_released_at, null, "the worker released a root exit it could not validate");
  process.env.AGENT_PLUGIN_TEST_CONTRACTS = contracts;
  process.env.AGENT_PLUGIN_GRACE_MS = "1500";
  t.after(() => {
    delete process.env.AGENT_PLUGIN_TEST_CONTRACTS;
    delete process.env.AGENT_PLUGIN_GRACE_MS;
  });
  const scan = () => state.scanWorkspace(db, { deadline: performance.now() + 30000, launch: async () => null, leaderCheck: async () => new Map() });
  await scan();
  const first = fx.jobRow(stateDir, jobId);
  assert.equal(first.release_kind, null, `the scanner released ${first.release_kind} on an owner death it never saw cause the exit`);
  await new Promise((resolve) => setTimeout(resolve, 1700));
  await scan();
  const after = fx.jobRow(stateDir, jobId);
  assert.equal(after.release_kind, "unobserved");
  assert.deepEqual(rawAll(stateDir, "SELECT thread_id FROM thread_barriers").map((barrier) => barrier.thread_id), ["th-seen-exit"]);
});

test("a live verified root of a version-1 row without a provider group is stopped by identity", { ...linuxOnly, timeout: 60000 }, async (t) => {
  const workerPid = await exitedProcess();
  const root = await startHelperProcess();
  t.after(() => stopOwnedProcess(root.process));
  const identity = await processLib.readProcessIdentity(root.pid, { deadline: performance.now() + 5000 });
  const stateDir = makeStoreDir(t);
  const created = store.openStore(stateDir);
  const { jobId } = state.createJob(created, jobFields({ threadId: "th-v1-root" }));
  created.close();
  // A version-1 store: no provider group column, and the old row records the worker's group only.
  rawExec(
    stateDir,
    `UPDATE jobs SET exec_gen = 1, worker_pid = ${workerPid}, worker_start_token = 'w', claimed_at = 1,
       worker_group_id = ${identity.groupId}, spawn_intent_at = 2, provider_pid = ${root.pid},
       provider_start_token = '${identity.startToken}', active_thread_key = 'codex:th-v1-root'
     WHERE id = '${jobId}'`
  );
  asVersion1Store(stateDir);
  const db = openTestStore(t, stateDir);
  assert.equal(fx.jobRow(stateDir, jobId).provider_group_id, null);
  process.env.AGENT_PLUGIN_GRACE_MS = "1500";
  t.after(() => delete process.env.AGENT_PLUGIN_GRACE_MS);
  const scan = () => state.scanWorkspace(db, { deadline: performance.now() + 30000, launch: async () => null, leaderCheck: async () => new Map() });
  await scan();
  assert.equal(await absentWithin([root.pid], 3000), true, "the verified root was left running");
  assert.equal(fx.jobRow(stateDir, jobId).release_kind, null, "a root stop without a proved group confirmed the closure");
  await new Promise((resolve) => setTimeout(resolve, 1700));
  await scan();
  assert.equal(fx.jobRow(stateDir, jobId).release_kind, "unobserved");
});

// A worker of one claimed execution, with no provider process, whose write transactions and
// cohort launches are counted.
async function countingWorker(t, threadId) {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const { jobId } = state.createJob(db, jobFields({ threadId }));
  rawExec(
    stateDir,
    `UPDATE jobs SET exec_gen = 1, worker_pid = 1, worker_start_token = 'w', claimed_at = 1, spawn_intent_at = 2,
       provider_pid = 3, provider_start_token = 'r', active_thread_key = 'codex:${threadId}' WHERE id = '${jobId}'`
  );
  const tracked = await import("../plugins/agent/scripts/lib/tracked-jobs.mjs");
  const run = new tracked.WorkerRun(db, stateDir, jobId, {}, {});
  run.execGen = 1;
  run.job = fx.jobRow(stateDir, jobId);
  const counts = { writes: 0, launches: 0 };
  const transact = db.transact.bind(db);
  db.transact = (fn, options) => {
    counts.writes += 1;
    return transact(fn, options);
  };
  run.launchCohort = async () => {
    counts.launches += 1;
  };
  return { stateDir, db, jobId, run, counts };
}

test("past the deadline a worker leaves its fenced state in one write and never releases", async (t) => {
  const T = 1_700_000_000_000;
  const late = { text: "partial answer", json: null, logged: false, truncated: false };
  {
    const { stateDir, jobId, run, counts } = await countingWorker(t, "th-late-leave");
    await run.leaveUnconfirmed({ deadline: performance.now() - 1, rootExitSeenAt: T, stopResult: "late" }, { result: late }, "test");
    assert.equal(counts.writes, 1, `${counts.writes} writes after the deadline`);
    const row = fx.jobRow(stateDir, jobId);
    assert.equal(row.provider_exit_seen_at, T);
    assert.equal(row.stopping_cause, "unconfirmed-stop");
    assert.equal(row.result_text, "partial answer");
    assert.equal(row.exec_released_at, null);
    // The one write allowed after the deadline is spent.
    await assert.rejects(run.writeBy(() => true, performance.now() - 1), /already made/);
  }
  {
    const { stateDir, jobId, run, counts } = await countingWorker(t, "th-late-release");
    const endIfUndecided = { by: "worker", reason: "session-end", end: null, result: null };
    await run.releaseWithin({ deadline: performance.now() - 1, rootExitSeenAt: null, stopResult: null }, "confirmed", endIfUndecided, null);
    const row = fx.jobRow(stateDir, jobId);
    assert.equal(row.exec_released_at, null, `released ${row.release_kind} after the deadline`);
    assert.equal(row.stopping_cause, "unconfirmed-stop");
    assert.equal(counts.launches, 0, "the cohort was launched after the deadline");
    assert.equal(counts.writes, 1, `${counts.writes} writes after the deadline`);
  }
});

test("a held stop past the deadline sends no signal and reports late", { timeout: 30000 }, async (t) => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", detached: process.platform !== "win32", windowsHide: true });
  t.after(() => stopOwnedProcess(child, { tree: true }));
  await new Promise((resolve) => child.once("spawn", resolve));
  const result = await processLib.stopHeldTree(child, { groupId: child.pid, deadline: performance.now() - 1 });
  assert.equal(result, "late");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(child.exitCode, null, "the held root exited after a late stop");
  assert.equal(child.signalCode, null, `the held root got ${child.signalCode} after a late stop`);
});

test("a release refuses a decision from a snapshot without the worker-seen root exit", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const { jobId } = state.createJob(db, jobFields({ threadId: "th-snapshot" }));
  rawExec(stateDir, `UPDATE jobs SET exec_gen = 1, worker_pid = 1, claimed_at = 1, spawn_intent_at = 2, provider_pid = 3 WHERE id = '${jobId}'`);
  state.leaveExecutionUnconfirmed(db, jobId, 1, { exitSeenAt: 5 });
  const endIfUndecided = { by: "reconcile", reason: "worker-dead" };
  assert.equal(state.releaseExecution(db, jobId, 1, { kind: "confirmed", endIfUndecided, expectedRoot: { pid: 3 }, expectedExitSeenAt: null }), false);
  assert.equal(fx.jobRow(stateDir, jobId).exec_released_at, null);
  assert.equal(state.releaseExecution(db, jobId, 1, { kind: "unobserved", endIfUndecided, expectedRoot: { pid: 3 }, expectedExitSeenAt: 5 }), true);
});

test("a scan that read the row before the worker recorded its seen exit does not confirm by owner death", { ...windowsOnly, timeout: 60000 }, async (t) => {
  const workerPid = await exitedProcess();
  const rootPid = await exitedProcess();
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const jobId = deadWorkerJob(stateDir, db, { workerPid, rootPid, groupId: null, threadId: "th-raced" });
  const { dir, env } = pointEnv(stateDir, "scan-before-release");
  const scanner = runLibChild("fixture.scan", [{ $store: stateDir }], { ...env, AGENT_PLUGIN_TEST_CONTRACTS: CLOSURE_CONTRACTS, AGENT_PLUGIN_GRACE_MS: "1500" });
  t.after(() => stopOwnedProcess(scanner.child));
  await fx.waitFor(() => reached(dir, "scan-before-release"), { describe: "the scan's release point" });
  // The worker commits the root exit it saw after the scanner read the row.
  state.leaveExecutionUnconfirmed(db, jobId, 1, { exitSeenAt: Date.now() });
  fs.writeFileSync(path.join(dir, "scan-before-release.release"), "");
  const scanned = await scanner;
  assert.equal(scanned.ok, true, `${JSON.stringify(scanned.error)} ${scanned.stderr}`);
  const first = fx.jobRow(stateDir, jobId);
  assert.notEqual(first.release_kind, "confirmed", "the scan confirmed by owner death from a snapshot without the seen exit");
  process.env.AGENT_PLUGIN_TEST_CONTRACTS = CLOSURE_CONTRACTS;
  process.env.AGENT_PLUGIN_GRACE_MS = "1500";
  t.after(() => {
    delete process.env.AGENT_PLUGIN_TEST_CONTRACTS;
    delete process.env.AGENT_PLUGIN_GRACE_MS;
  });
  await new Promise((resolve) => setTimeout(resolve, 1700));
  await state.scanWorkspace(db, { deadline: performance.now() + 30000, launch: async () => null, leaderCheck: async () => new Map() });
  assert.equal(fx.jobRow(stateDir, jobId).release_kind, "unobserved");
  assert.deepEqual(rawAll(stateDir, "SELECT thread_id FROM thread_barriers").map((barrier) => barrier.thread_id), ["th-raced"]);
});

test("the write after the deadline is one attempt with no retry, even on a busy store", async (t) => {
  // A busy answer that comes back at once: one attempt, no retry wait, no second transaction.
  {
    const { run } = await countingWorker(t, "th-late-busy-fast");
    let attempts = 0;
    const busy = () => {
      attempts += 1;
      throw new store.StoreError("availability", "The job store is busy.", { code: "busy" });
    };
    await assert.rejects(run.writeBy(busy, performance.now() - 1), (error) => error?.code === "busy");
    assert.equal(attempts, 1, `${attempts} attempts after the deadline`);
  }
  // A store another connection holds: the attempt waits at most the 50 ms allowance, then the
  // execution is left to the scanner.
  {
    const { stateDir, jobId, run, counts } = await countingWorker(t, "th-late-busy-held");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const holder = new DatabaseSync(path.join(stateDir, "store", "state.db"));
    t.after(() => holder.close());
    holder.exec("BEGIN IMMEDIATE");
    const started = performance.now();
    await run.leaveUnconfirmed({ deadline: performance.now() - 1, rootExitSeenAt: null, stopResult: null }, null, "test");
    const elapsed = performance.now() - started;
    holder.exec("ROLLBACK");
    t.diagnostic(`the late write ended after ${Math.round(elapsed)} ms`);
    assert.equal(counts.writes, 1, `${counts.writes} transactions after the deadline`);
    // The margin covers SQLite's busy-handler sleeps, which on Windows round up to the 15.6 ms
    // timer resolution (about 100 ms in all for a 50 ms busy timeout), and the log write.
    assert.ok(elapsed <= 50 + 100, `the late write took ${Math.round(elapsed)} ms`);
    assert.equal(fx.jobRow(stateDir, jobId).stopping_cause, null);
    assert.match(fs.readFileSync(path.join(stateDir, "store", "artifacts", `${jobId}.log`), "utf8"), /could not be recorded before the deadline/);
  }
});

test("a cohort launch stops at the deadline: members after it wait for the next scan", async (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const first = state.createJob(db, jobFields({ title: "first" })).jobId;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = state.createJob(db, jobFields({ title: "second" })).jobId;
  assert.deepEqual(state.readCohort(db, "codex").cohort, [first, second]);
  const started = [];
  // The first member's launch outlasts the deadline.
  const launch = async (_store, _stateDir, jobId) => {
    started.push(jobId);
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { pid: 1 };
  };
  const launched = await launchModule.launchEligible(db, stateDir, "codex", { deadline: performance.now() + 30, launch });
  assert.deepEqual(started, [first], `launches started: ${JSON.stringify(started)}`);
  assert.deepEqual(launched, [first]);
});

test("a held stop whose probe outlasts the deadline sends nothing and reports late", { timeout: 30000 }, async (t) => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", detached: process.platform !== "win32", windowsHide: true });
  t.after(() => stopOwnedProcess(child, { tree: true }));
  await new Promise((resolve) => child.once("spawn", resolve));
  process.env.AGENT_PLUGIN_TEST_PROCESS = JSON.stringify({ heldProbeDelayMs: 200 });
  t.after(() => delete process.env.AGENT_PLUGIN_TEST_PROCESS);
  const result = await processLib.stopHeldTree(child, { groupId: child.pid, deadline: performance.now() + 50 });
  assert.equal(result, "late");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(child.exitCode, null, "the held root exited after a late stop");
  assert.equal(child.signalCode, null, `the held root got ${child.signalCode} after a late stop`);
});

// Sets AGENT_PLUGIN_TEST_DELAYS for the rest of the test.
function delaysFor(t, delays) {
  process.env.AGENT_PLUGIN_TEST_DELAYS = JSON.stringify(delays);
  t.after(() => delete process.env.AGENT_PLUGIN_TEST_DELAYS);
}

test("a retry with a deadline starts no wait once the deadline has passed", async () => {
  let attempts = 0;
  let timers = 0;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (...args) => {
    timers += 1;
    return realSetTimeout(...args);
  };
  try {
    // The attempt outlasts the deadline, then the store answers busy.
    const busyLate = () => {
      attempts += 1;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
      throw new store.StoreError("availability", "The job store is busy.", { code: "busy" });
    };
    await assert.rejects(store.withRetry(busyLate, "worker", { deadline: performance.now() + 30 }), (error) => error?.code === "busy");
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(attempts, 1);
  assert.equal(timers, 0, `${timers} retry waits started after the deadline`);
});

test("launch attempts the deadline refuses at COMMIT count nothing, spawn nothing and never end the job launch-failed", async (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const [jobId] = createQueued(db, 1);
  // Each launch is the next launch window: the wall clock moves 6 seconds between them.
  const clockFile = path.join(stateDir, "clock-offset");
  fs.writeFileSync(clockFile, "0");
  process.env.AGENT_PLUGIN_TEST_CLOCK_OFFSET_FILE = clockFile;
  t.after(() => delete process.env.AGENT_PLUGIN_TEST_CLOCK_OFFSET_FILE);
  // A slow step inside the attempt transaction, before its COMMIT, takes the launch past its
  // deadline.
  delaysFor(t, { "launch-attempt": 100 });
  for (let launchIndex = 0; launchIndex < 3; launchIndex += 1) {
    fs.writeFileSync(clockFile, String(launchIndex * 6000));
    const launched = await launch.launchWorker(db, stateDir, jobId, { deadline: performance.now() + 50 });
    assert.equal(launched, null, `launch ${launchIndex + 1} spawned a worker after its deadline`);
  }
  const row = fx.jobRow(stateDir, jobId);
  assert.equal(row.launch_attempts, 0, `${row.launch_attempts} launch attempts counted with no worker spawned`);
  assert.equal(row.last_launch_at, null);
  assert.equal(row.claimed_at, null);
  fs.writeFileSync(clockFile, String(30000));
  assert.equal(state.endLaunchFailed(db, jobId), false);
  assert.ok(state.readCohort(db, "codex").cohort.includes(jobId), "the job left its provider's cohort");
  assert.equal(state.readJobView(db, jobId).state, "queued");
});

test("a committed launch attempt is followed by its spawn with nothing asynchronous or I/O between", () => {
  const source = fs.readFileSync(path.join(ROOT, "plugins", "agent", "scripts", "lib", "task-launch.mjs"), "utf8");
  const body = source.slice(source.indexOf("export async function launchWorker"), source.indexOf("export async function launchEligible"));
  const commit = body.indexOf("recordLaunchAttempt(");
  const spawnAt = body.indexOf("spawn(process.execPath");
  assert.ok(commit > 0 && spawnAt > commit, "the attempt or the spawn is missing from launchWorker");
  const between = body.slice(commit, spawnAt);
  const forbidden = /\bawait\b|readJobView|workerEntry|requireModule|boundary\(|testDelay|withdraw|fs\.|store\.|log\(|setTimeout|setImmediate/;
  const statements = between.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("//"));
  const offending = statements.filter((line, index) => index > 0 && forbidden.test(line));
  assert.deepEqual(offending, [], "a step between the committed attempt and the spawn can block, wait or write");
});

test("a verified tree stop whose last step outlasts the deadline sends no signal", { ...linuxOnly, timeout: 30000 }, async (t) => {
  const helper = await startHelperProcess();
  t.after(() => stopOwnedProcess(helper.process, { tree: true }));
  const observed = await processLib.readProcessIdentity(helper.pid, { deadline: performance.now() + 5000 });
  delaysFor(t, { "tree-signal": 400 });
  const identity = { pid: helper.pid, startToken: observed.startToken };
  const result = await processLib.stopTree(identity, { deadline: performance.now() + 200, expectedGroupId: observed.groupId });
  assert.equal(result, "unknown");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await processLib.readProcessIdentity(helper.pid, { deadline: performance.now() + 5000 })).state, "present", "the helper was signalled after the deadline");
});

test("a held stop whose command start outlasts the deadline starts no stop command", { ...windowsOnly, timeout: 30000 }, async (t) => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
  t.after(() => stopOwnedProcess(child, { tree: true }));
  await new Promise((resolve) => child.once("spawn", resolve));
  delaysFor(t, { command: 300 });
  const result = await processLib.stopHeldTree(child, { groupId: child.pid, deadline: performance.now() + 100 });
  assert.equal(result, "late");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(child.exitCode, null, "the held root was stopped after the deadline");
});

// ---------------------------------------------------------------------------------------------
// Library review findings (the dispatch-order guard sees the first byte)

// Requests whose first byte reached the provider before the job's submission intent or the
// dispatch of the message they carry.
function firstByteViolations(stateDir, jobId) {
  const row = fx.jobRow(stateDir, jobId);
  const dispatches = new Map(rawAll(stateDir, "SELECT id, dispatched_at FROM messages").map((message) => [message.id, message.dispatched_at]));
  const violations = [];
  const opening = rawAll(stateDir, "SELECT dispatched_at FROM messages WHERE chain_id = ? ORDER BY id LIMIT 1", [row.chain_id])[0] ?? null;
  const notProviderRequest = /^\{"type":"(prepare|history|interrupt|interrupt-previous)"/;
  const cutOff = fx.readTrace(stateDir, jobId).filter(
    (item) => item.type === "partial-request" || (item.type === "line-start" && !notProviderRequest.test(item.prefix ?? ""))
  );
  for (const entry of cutOff) {
    // A request line seen only in part: its message cannot be read, so its first bytes are
    // checked against the submission intent and the chain's first message.
    const firstByte = entry.firstByteAt;
    if (row.submit_intent_at === null || firstByte < row.submit_intent_at || (opening && (opening.dispatched_at === null || firstByte < opening.dispatched_at))) {
      violations.push({ request: "partial", firstByte, submitIntentAt: row.submit_intent_at, dispatchedAt: opening?.dispatched_at ?? null });
    }
  }
  for (const entry of fx.readTrace(stateDir, jobId).filter((item) => item.request === "start" || item.request === "steer")) {
    const firstByte = entry.firstByteAt ?? entry.at;
    const messageId = Number(/^\[message (\d+)\]/.exec(entry.text ?? "")?.[1] ?? NaN);
    const dispatchedAt = dispatches.get(messageId) ?? null;
    if (row.submit_intent_at === null || firstByte < row.submit_intent_at || (Number.isFinite(messageId) && (dispatchedAt === null || firstByte < dispatchedAt))) {
      violations.push({ request: entry.request, firstByte, submitIntentAt: row.submit_intent_at, dispatchedAt });
    }
  }
  return violations;
}

test("the dispatch-order check catches a request whose first bytes precede the dispatch commit", { timeout: 60000 }, async (t) => {
  const pids = fx.trackProcesses(t);
  for (const defect of [false, true]) {
    const stateDir = makeStoreDir(t);
    const db = openTestStore(t, stateDir);
    const jobId = await fx.createDriverJob(db, { delayMs: 200, earlyPrefix: defect }, { threadId: `th-prefix-${defect}` });
    mailbox.sendToChain(db, { ref: jobId }, { text: "carried" });
    const exit = await fx.startTestWorker(stateDir, jobId, fx.workerEnv(), pids).exit;
    pids.push(...fx.providerIdentities(stateDir, jobId));
    assert.equal(exit.code, 0, exit.stderr);
    assert.equal(startRequests(stateDir, jobId).length, 1);
    const violations = firstByteViolations(stateDir, jobId);
    if (defect) {
      assert.ok(violations.length > 0, "a split write whose prefix preceded the dispatch commit went unnoticed");
    } else {
      assert.deepEqual(violations, []);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Library review findings, round 2

test("a dead claim with a committed cancel ends cancelled and drops its messages", (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const { jobId, execGen } = claimedJob(db);
  mailbox.sendToChain(db, { ref: jobId }, { text: "open" });
  state.requestStop(db, { jobIds: [jobId] }, { reason: "cancel", cancel: true });
  assert.equal(state.endDeadClaim(db, jobId, execGen), true);
  const row = rawAll(stateDir, `SELECT end_state, release_kind FROM jobs WHERE id = '${jobId}'`)[0];
  assert.deepEqual(row, { end_state: "cancelled", release_kind: "confirmed" });
  assert.equal(rawAll(stateDir, `SELECT count(*) AS n FROM events WHERE job_id = '${jobId}'`)[0].n, 0);
  assert.deepEqual(rawAll(stateDir, `SELECT state, close_cause FROM messages WHERE chain_id = '${jobId}'`), [{ state: "dropped", close_cause: "cancelled" }]);
});

test("a root verified present after an unknown first lookup is stopped before any release", { timeout: 60000 }, async (t) => {
  const workerPid = await exitedProcess();
  const root = await startHelperProcess({ child: true });
  t.after(() => stopOwnedProcesses([{ pid: root.childPid, startToken: root.childStartToken }, root.process]));
  const identity = await processLib.readProcessIdentity(root.pid, { deadline: performance.now() + 5000 });
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const { jobId } = state.createJob(db, jobFields({ threadId: "th-unknown-first" }));
  rawExec(
    stateDir,
    `UPDATE jobs SET exec_gen = 1, worker_pid = ${workerPid}, worker_start_token = 'w', claimed_at = 1,
       worker_group_id = ${identity.groupId ?? "NULL"}, provider_group_id = ${identity.groupId ?? "NULL"}, spawn_intent_at = 2, provider_pid = ${root.pid},
       provider_start_token = '${identity.startToken}', grace_started_at = 3, active_thread_key = 'codex:th-unknown-first'
     WHERE id = '${jobId}'`
  );
  process.env.AGENT_PLUGIN_GRACE_MS = "1000";
  process.env.AGENT_PLUGIN_TEST_PROCESS = JSON.stringify({ unknownPidsOnce: [root.pid] });
  t.after(() => {
    delete process.env.AGENT_PLUGIN_GRACE_MS;
    delete process.env.AGENT_PLUGIN_TEST_PROCESS;
  });
  await state.scanWorkspace(db, { deadline: performance.now() + 30000, launch: async () => null, leaderCheck: async () => new Map() });
  const row = fx.jobRow(stateDir, jobId);
  const rootNow = await processLib.readProcessIdentity(root.pid, { deadline: performance.now() + 5000 });
  if (row.exec_released_at !== null) {
    assert.equal(rootNow.state, "absent", `released ${row.release_kind} while the verified root still ran`);
  }
  assert.equal(rootNow.state, "absent", "the verified root was not stopped");
});

test("a worker released before its spawn launches the next queued job", { timeout: 60000 }, async (t) => {
  const stateDir = makeStoreDir(t);
  fs.writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ maxParallel: { codex: 1 } }));
  const db = openTestStore(t, stateDir);
  const pids = fx.trackProcesses(t);
  const first = await fx.createDriverJob(db, { delayMs: 200 }, { title: "first" });
  const queued = await fx.createDriverJob(db, { delayMs: 200 }, { title: "queued" });
  const { dir, env } = pointEnv(stateDir, "after-claim");
  const worker = fx.startTestWorker(stateDir, first, fx.workerEnv(env), pids);
  await fx.waitFor(() => reached(dir, "after-claim"), { describe: "the first claim" });
  state.requestStop(db, { jobIds: [first] }, { reason: "session-end" });
  fs.writeFileSync(path.join(dir, "after-claim.release"), "");
  assert.equal((await worker.exit).code, 0);
  assert.equal(fx.jobRow(stateDir, first).release_kind, "confirmed");
  await fx.waitFor(() => fx.jobRow(stateDir, queued).claimed_at !== null, { timeoutMs: 15000, describe: "the queued job's claim" });
  await fx.waitFor(() => fx.jobRow(stateDir, queued).exec_released_at !== null, { timeoutMs: 30000, describe: "the queued job's release" });
  pids.push(...fx.jobProcesses(stateDir, queued));
});

test("the dispatch-order check catches a cut-off request whose first bytes precede the commit", { timeout: 60000 }, async (t) => {
  const stateDir = makeStoreDir(t);
  const db = openTestStore(t, stateDir);
  const pids = fx.trackProcesses(t);
  const jobId = await fx.createDriverJob(db, { delayMs: 30000, earlyPrefix: true }, { threadId: "th-cut" });
  mailbox.sendToChain(db, { ref: jobId }, { text: "carried" });
  const { dir, env } = pointEnv(stateDir, "after-dispatch");
  const worker = fx.startTestWorker(stateDir, jobId, fx.workerEnv(env), pids);
  await fx.waitFor(() => reached(dir, "after-dispatch"), { describe: "the dispatch pause" });
  pids.push(...fx.providerIdentities(stateDir, jobId));
  await stopOwnedProcess(worker.child);
  await worker.exit;
  assert.equal(startRequests(stateDir, jobId).length, 0);
  assert.ok(firstByteViolations(stateDir, jobId).length > 0, "a cut-off prefix written before the dispatch commit went unnoticed");
});
