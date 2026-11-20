import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { dumpTables, makeStoreDir, rawAll, rawExec, runLibChild } from "./store-fixtures.mjs";
import { stopOwnedProcess } from "./helpers.mjs";
import {
  EPOCH,
  bindAttempt,
  currentAttempt,
  freshAttemptId,
  openCouncilStore,
  rel,
  seatDefinitions,
  seedRound2,
  seedRun,
  setJob,
  sql,
  useTestClock
} from "./council-helpers.mjs";
import * as store from "../plugins/agent/scripts/lib/store.mjs";
import { decideNext } from "../plugins/agent/scripts/lib/state.mjs";
import { ObjectDamagedError, installObject, publishExport, readObject } from "../plugins/agent/scripts/lib/council/objects.mjs";
import {
  CouncilFenceError,
  acknowledgeStop,
  continueBindingHook,
  createCouncilRun,
  depositObservation,
  depositReceipt,
  readCouncil,
  recordRefusal,
  startRound2
} from "../plugins/agent/scripts/lib/council/state.mjs";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

const COUNCIL_TABLES = [
  "council_attempts",
  "council_ext_decisions",
  "council_ext_events",
  "council_ext_requests",
  "council_ext_turns",
  "council_observations",
  "council_rounds",
  "council_runs",
  "council_seat_rounds",
  "council_seats",
  "council_stop_cancels",
  "council_stops",
  "council_verdicts"
];

// Digests and attempt ids built from one hex character, so each fixture value is easy to read.
const hex = (character) => character.repeat(64);
const id = (character) => character.repeat(32);
const A1 = id("1");
const A2 = id("2");
const A3 = id("3");
const FREE = id("f");

// A migrated store, opened through the library, then a plain connection to it with foreign keys
// on, as the library opens it.
function freshDb(t) {
  const stateDir = makeStoreDir(t);
  store.openStore(stateDir).close();
  const db = new DatabaseSync(path.join(stateDir, "store", "state.db"));
  db.exec("PRAGMA busy_timeout = 10000");
  db.exec("PRAGMA foreign_keys = ON");
  t.after(() => db.close());
  return { db, stateDir };
}

function runStep(db, step) {
  if (typeof step === "string") {
    db.exec(step);
    return;
  }
  const [sql, ...params] = step;
  db.prepare(sql).run(...params);
}

// Runs `steps` in one transaction, then COMMIT when `commit` is set, and rolls back whatever is
// left. Returns `{ index, error }`: the step that threw ("commit" for the COMMIT), or null.
function attemptSteps(db, steps, { commit = false } = {}) {
  db.exec("BEGIN");
  let failure = { index: null, error: null };
  let index = 0;
  try {
    for (; index < steps.length; index += 1) {
      runStep(db, steps[index]);
    }
    if (commit) {
      index = "commit";
      db.exec("COMMIT");
    }
  } catch (error) {
    failure = { index, error };
  }
  try {
    db.exec("ROLLBACK");
  } catch {
    // COMMIT succeeded or the failure already ended the transaction.
  }
  return failure;
}

// Asserts that every setup step runs and the last step (or the COMMIT) throws a message matching
// `pattern`.
function refuses(db, steps, pattern, { commit = false, label = "" } = {}) {
  const { index, error } = attemptSteps(db, steps, { commit });
  const expected = commit ? "commit" : steps.length - 1;
  assert.equal(index, expected, `${label}: step ${index} failed (${error?.message}); expected step ${expected} to fail`);
  assert.match(error.message, pattern, label);
}

function accepts(db, steps, { commit = false, label = "" } = {}) {
  const { index, error } = attemptSteps(db, steps, { commit });
  assert.equal(error, null, `${label}: step ${index} failed: ${error?.message}`);
}

const CHECK = /CHECK constraint failed/;
const FOREIGN_KEY = /FOREIGN KEY constraint failed/;

// The indexes and triggers the extension migration (version 5) adds.
const EXTENSION_INDEXES = ["council_ext_turn_challenge_seat", "council_ext_turn_ordinal", "council_ext_turn_round_seat"];
const EXTENSION_TRIGGERS = [
  "council_ext_core_attempt_bind",
  "council_ext_core_attempt_insert",
  "council_ext_decision_delete",
  "council_ext_decision_insert",
  "council_ext_decision_update",
  "council_ext_event_delete",
  "council_ext_event_insert",
  "council_ext_event_update",
  "council_ext_request_delete",
  "council_ext_request_insert",
  "council_ext_request_update",
  "council_ext_turn_delete",
  "council_ext_turn_insert",
  "council_ext_turn_update"
];
const EXTENSION_TABLES = ["council_ext_decisions", "council_ext_events", "council_ext_turns", "council_ext_requests"];

// A Round 1 seed in insertion order (run, round, seats, then each seat round before its attempt),
// three seats: a Claude prompt seat (s1, running), a Codex seat (s2, issuing) and an Antigravity
// seat (s3, issuing). T=1000.
const SEED = [
  `INSERT INTO council_runs (id, kind, session_id, cwd, brief_sha256, options_json, timeout_ms, seat_count, turn_cap, created_at, clock)
   VALUES ('run-1', 'review', NULL, '/w', '${hex("b")}', '{}', 1000, 3, 12, 0, 0)`,
  "INSERT INTO council_rounds (run_id, round, started_at) VALUES ('run-1', 1, 0)",
  "INSERT INTO council_seats (run_id, seat, family, provider, model, lens, label, created_at) VALUES ('run-1', 's1', 'claude', NULL, NULL, 'correctness', NULL, 0)",
  "INSERT INTO council_seats (run_id, seat, family, provider, model, lens, label, created_at) VALUES ('run-1', 's2', 'codex', 'codex', NULL, 'security', 'run-1-s2', 0)",
  "INSERT INTO council_seats (run_id, seat, family, provider, model, lens, label, created_at) VALUES ('run-1', 's3', 'agy', 'agy', NULL, 'maintainability', 'run-1-s3', 0)",
  `INSERT INTO council_seat_rounds (run_id, round, seat, state, current_id) VALUES ('run-1', 1, 's1', 'running', '${A1}')`,
  `INSERT INTO council_attempts (id, run_id, round, seat, kind, created_at, issue_by, prompt_sha256, issued_at)
   VALUES ('${A1}', 'run-1', 1, 's1', 'prompt', 0, 1000, '${hex("1")}', 0)`,
  `INSERT INTO council_seat_rounds (run_id, round, seat, state, current_id) VALUES ('run-1', 1, 's2', 'issuing', '${A2}')`,
  `INSERT INTO council_attempts (id, run_id, round, seat, kind, created_at, issue_by, prompt_sha256)
   VALUES ('${A2}', 'run-1', 1, 's2', 'create', 0, 1000, '${hex("2")}')`,
  `INSERT INTO council_seat_rounds (run_id, round, seat, state, current_id) VALUES ('run-1', 1, 's3', 'issuing', '${A3}')`,
  `INSERT INTO council_attempts (id, run_id, round, seat, kind, created_at, issue_by, prompt_sha256)
   VALUES ('${A3}', 'run-1', 1, 's3', 'create', 0, 1000, '${hex("3")}')`
];

function seededDb(t) {
  const fresh = freshDb(t);
  accepts(fresh.db, SEED, { commit: true, label: "seed" });
  return fresh;
}

// Binds s2's attempt to job-2 at 1 and moves the seat to running.
const BIND_S2 = [
  `UPDATE council_attempts SET job_id = 'job-2', issued_at = 1 WHERE id = '${A2}'`,
  "UPDATE council_seat_rounds SET state = 'running' WHERE run_id = 'run-1' AND round = 1 AND seat = 's2'"
];
const OBSERVE_S2 = `INSERT INTO council_observations (attempt_id, observed_at, event_at, outcome, answer_sha256)
  VALUES ('${A2}', 2, 2, 'valid', '${hex("a")}')`;
const FINISH_S2 = [
  `UPDATE council_seat_rounds SET state = 'valid', answer_sha256 = '${hex("a")}', final_at = 3 WHERE run_id = 'run-1' AND round = 1 AND seat = 's2'`,
  `UPDATE council_attempts SET retired_at = 3 WHERE id = '${A2}'`
];
const STOP_S2 = "INSERT INTO council_stops (job_id, requested_at, cause) VALUES ('job-2', 2, 'deadline')";
const ACK_S2 = "UPDATE council_stops SET dispatched_at = 4, acknowledged_at = 4 WHERE job_id = 'job-2' AND acknowledged_at IS NULL";
const CANCEL_S2 = "INSERT INTO council_stop_cancels (job_id, committed_at) VALUES ('job-2', 4)";
const REPAIR_S2 = (attemptId, extra = {}) => {
  const row = {
    id: attemptId,
    run_id: "run-1",
    round: 1,
    seat: "s2",
    charge: "repair",
    replaces_id: A2,
    kind: "create",
    created_at: 10,
    issue_by: 1010,
    prompt_sha256: hex("c"),
    predecessor_id: null,
    ...extra
  };
  const columns = Object.keys(row);
  return [`INSERT INTO council_attempts (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, ...columns.map((c) => row[c])];
};

function countObjects(stateDir, type) {
  return rawAll(stateDir, "SELECT count(*) AS n FROM sqlite_master WHERE type = ? AND name LIKE 'council\\_%' ESCAPE '\\'", [type])[0].n;
}

// runLibChild with a time limit; a child still running at the limit is stopped by its own handle.
async function libChildWithin(op, args, env, timeoutMs = 60000) {
  const pending = runLibChild(op, args, env);
  let timer;
  const limit = new Promise((resolve) => {
    timer = setTimeout(() => {
      stopOwnedProcess(pending.child).finally(() => resolve({ ok: false, error: { message: `timed out after ${timeoutMs} ms` } }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([pending, limit]);
  } finally {
    clearTimeout(timer);
  }
}

test("migration 2 creates the council tables once", { timeout: 120000 }, async (t) => {
  assert.equal(store.SCHEMA_VERSION, 5);
  assert.equal(store.MIGRATIONS.at(-1).version, 5);
  const stateDir = makeStoreDir(t);
  const countFile = path.join(stateDir, "migrations.txt");
  const env = { AGENT_PLUGIN_TEST_MIGRATION_COUNT_FILE: countFile, FIXTURE_START_AT: String(Date.now() + 1500) };
  const results = await Promise.all([0, 1].map(() => libChildWithin("fixture.coldOpen", [stateDir], env)));
  for (const result of results) {
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.value.userVersion, 5);
  }
  assert.equal(rawAll(stateDir, "PRAGMA user_version")[0].user_version, 5);
  assert.deepEqual(
    rawAll(stateDir, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'council\\_%' ESCAPE '\\' ORDER BY name").map((r) => r.name),
    COUNCIL_TABLES
  );
  assert.equal(countObjects(stateDir, "index"), 2 + EXTENSION_INDEXES.length);
  assert.deepEqual(
    rawAll(stateDir, "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'council\\_%' ESCAPE '\\' ORDER BY name").map((r) => r.name),
    ["council_ext_turn_challenge_seat", "council_ext_turn_ordinal", "council_ext_turn_round_seat", "council_pending_stops", "council_seat_label"]
  );
  assert.equal(countObjects(stateDir, "trigger"), 24 + EXTENSION_TRIGGERS.length);
  assert.equal(fs.readFileSync(countFile, "utf8").trim().split(/\r?\n/).length, 1);
  const later = await libChildWithin("fixture.coldOpen", [stateDir], { AGENT_PLUGIN_TEST_MIGRATION_COUNT_FILE: countFile });
  assert.equal(later.ok, true, JSON.stringify(later.error));
  assert.equal(fs.readFileSync(countFile, "utf8").trim().split(/\r?\n/).length, 1);
});

test("migration 2 accepts the seed order and refuses the malformed rows", (t) => {
  const { db } = freshDb(t);
  accepts(db, SEED, { label: "seed in one transaction" });
  accepts(db, SEED, { commit: true, label: "seed committed" });

  const seatS4 = "INSERT INTO council_seats (run_id, seat, family, provider, model, lens, label, created_at) VALUES ('run-1', 's4', 'codex', 'codex', NULL, 'cost', 'run-1-s4', 0)";
  refuses(
    db,
    [seatS4, `INSERT INTO council_attempts (id, run_id, round, seat, kind, created_at, issue_by, prompt_sha256) VALUES ('${FREE}', 'run-1', 1, 's4', 'create', 0, 1000, '${hex("4")}')`],
    FOREIGN_KEY,
    { label: "attempt before its seat round" }
  );
  refuses(db, [seatS4, `INSERT INTO council_seat_rounds (run_id, round, seat, state, current_id) VALUES ('run-1', 1, 's4', 'issuing', '${FREE}')`], FOREIGN_KEY, {
    commit: true,
    label: "current_id without an attempt"
  });
  refuses(db, [seatS4, `INSERT INTO council_seat_rounds (run_id, round, seat, state, current_id) VALUES ('run-1', 1, 's4', 'issuing', '${A2}')`], FOREIGN_KEY, {
    commit: true,
    label: "current_id naming another seat's attempt"
  });

  const run = (overrides) => {
    const row = { id: "run-2", kind: "review", cwd: "/w", brief_sha256: hex("b"), options_json: "{}", timeout_ms: 1000, seat_count: 3, turn_cap: 12, created_at: 0, clock: 0, ...overrides };
    const columns = Object.keys(row);
    return [`INSERT INTO council_runs (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, ...columns.map((c) => row[c])];
  };
  accepts(db, [run({})], { label: "free run slot" });
  refuses(db, [run({ brief_sha256: "abc" })], CHECK, { label: "short run brief digest" });
  refuses(db, [run({ turn_cap: 11 })], CHECK, { label: "turn_cap not 2*seats+6" });

  refuses(db, ["INSERT INTO council_rounds (run_id, round, started_at) VALUES ('run-1', 3, 0)"], CHECK, { label: "round 3" });
  refuses(db, ["INSERT INTO council_rounds (run_id, round, started_at) VALUES ('run-1', 2, 0)"], CHECK, { label: "round 2 without a map" });
  accepts(db, [`INSERT INTO council_rounds (run_id, round, started_at, map_sha256) VALUES ('run-1', 2, 0, '${hex("e")}')`], { label: "round 2 with a map" });

  const seat = (overrides) => {
    const row = { run_id: "run-1", seat: "s4", family: "codex", provider: "codex", lens: "cost", label: "run-1-s4", created_at: 0, ...overrides };
    const columns = Object.keys(row);
    return [`INSERT INTO council_seats (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, ...columns.map((c) => row[c])];
  };
  accepts(db, [seat({})], { label: "free seat slot" });
  refuses(db, [seat({ seat: "s0" })], CHECK, { label: "seat s0" });
  refuses(db, [seat({ family: "claude", provider: "codex" })], CHECK, { label: "claude seat with a provider" });

  const s2 = "WHERE run_id = 'run-1' AND round = 1 AND seat = 's2'";
  accepts(db, [`UPDATE council_seat_rounds SET state = 'valid', answer_sha256 = '${hex("a")}', final_at = 5 ${s2}`], { label: "valid seat" });
  refuses(db, [`UPDATE council_seat_rounds SET state = 'valid', final_at = 5 ${s2}`], CHECK, { label: "valid without an answer digest" });
  refuses(db, [`UPDATE council_seat_rounds SET state = 'running', answer_sha256 = '${hex("a")}' ${s2}`], CHECK, { label: "answer digest without valid" });
  refuses(db, [`UPDATE council_seat_rounds SET state = 'valid', answer_sha256 = '${"a".repeat(63)}', final_at = 5 ${s2}`], CHECK, { label: "short answer digest" });
  refuses(db, [`UPDATE council_seat_rounds SET state = 'valid', answer_sha256 = '${"A".repeat(64)}', final_at = 5 ${s2}`], CHECK, { label: "uppercase answer digest" });
  accepts(db, [`UPDATE council_seat_rounds SET state = 'invalid', errors_sha256 = '${hex("d")}', reason = 'schema validation failed', final_at = 5 ${s2}`], {
    label: "invalid seat"
  });
  refuses(db, [`UPDATE council_seat_rounds SET state = 'invalid', errors_sha256 = 'abc', reason = 'schema validation failed', final_at = 5 ${s2}`], CHECK, {
    label: "short errors digest"
  });
  refuses(db, [`UPDATE council_seat_rounds SET state = 'invalid', errors_sha256 = '${"D".repeat(64)}', reason = 'schema validation failed', final_at = 5 ${s2}`], CHECK, {
    label: "uppercase errors digest"
  });
  refuses(db, [`UPDATE council_seat_rounds SET state = 'error', final_at = 5 ${s2}`], CHECK, { label: "final seat without a reason" });

  accepts(db, [REPAIR_S2(FREE)], { label: "free repair slot" });
  refuses(db, [REPAIR_S2("abc")], CHECK, { label: "short attempt id" });
  refuses(db, [REPAIR_S2("F".repeat(32))], CHECK, { label: "uppercase attempt id" });
  refuses(db, [REPAIR_S2(FREE, { prompt_sha256: "c".repeat(63) })], CHECK, { label: "short prompt digest" });
  refuses(db, [REPAIR_S2(FREE, { prompt_sha256: "C".repeat(64) })], CHECK, { label: "uppercase prompt digest" });

  const observation = (overrides) => {
    const row = { attempt_id: A2, observed_at: 2, event_at: 2, outcome: "valid", answer_sha256: hex("a"), reason: null, ...overrides };
    const columns = Object.keys(row);
    return [`INSERT INTO council_observations (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, ...columns.map((c) => row[c])];
  };
  accepts(db, [...BIND_S2, observation({})], { label: "free observation slot" });
  refuses(db, [...BIND_S2, observation({ outcome: "missing", answer_sha256: null, reason: "job pruned or missing" })], CHECK, { label: "missing with event_at" });
  refuses(db, [...BIND_S2, observation({ outcome: "failure", event_at: null, answer_sha256: null, reason: "provider failure" })], CHECK, {
    label: "failure without event_at"
  });
  refuses(db, [...BIND_S2, observation({ answer_sha256: null })], CHECK, { label: "valid without a digest" });
  refuses(db, [...BIND_S2, observation({ outcome: "invalid", answer_sha256: null, reason: "schema validation failed", replacement_required: 1 })], CHECK, {
    label: "replacement_required without a digest"
  });
  refuses(db, [...BIND_S2, observation({ outcome: "invalid", answer_sha256: null, reason: "schema validation failed", transient: 1 })], CHECK, {
    label: "transient on an invalid outcome"
  });

  accepts(db, [...BIND_S2, STOP_S2], { label: "free stop slot" });
  refuses(db, [...BIND_S2, "INSERT INTO council_stops (job_id, requested_at, cause) VALUES ('job-2', 2, 'bored')"], CHECK, { label: "stop cause outside the enum" });
  refuses(db, [...BIND_S2, "INSERT INTO council_stops (job_id, requested_at, cause, dispatched_at, acknowledged_at) VALUES ('job-2', 2, 'queue', 3, 4)"], CHECK, {
    label: "dispatched_at different from acknowledged_at"
  });

  const r1 = "WHERE run_id = 'run-1' AND round = 1";
  refuses(db, [`UPDATE council_rounds SET quorum_at = 100, cutoff_at = 180100 ${r1}`], CHECK, { label: "cutoff not quorum_at+300000" });
  refuses(db, [`UPDATE council_rounds SET quorum_at = 100 ${r1}`], CHECK, { label: "a single seal column" });
  refuses(db, [`UPDATE council_rounds SET quorum_at = 100, cutoff_at = 300100, closed_at = 50, quorum = 1 ${r1}`], CHECK, { label: "closed_at before quorum_at" });
  refuses(db, [`UPDATE council_rounds SET closed_at = 50 ${r1}`], CHECK, { label: "closed_at without quorum" });
});

test("migration 2 refuses every duplicate insert of a protected row", (t) => {
  const { db } = seededDb(t);
  accepts(db, [...BIND_S2, OBSERVE_S2, STOP_S2, ACK_S2, CANCEL_S2], { commit: true, label: "history" });
  const rows = {
    run: [
      "council_runs (id, kind, cwd, brief_sha256, options_json, timeout_ms, seat_count, turn_cap, created_at, clock)",
      `('run-1', 'review', '/w', '${hex("b")}', '{}', 1000, 3, 12, 0, 0)`,
      "(id)",
      /council run already exists/
    ],
    round: ["council_rounds (run_id, round, started_at)", "('run-1', 1, 0)", "(run_id, round)", /council round already exists/],
    seat: [
      "council_seats (run_id, seat, family, provider, lens, label, created_at)",
      "('run-1', 's1', 'claude', NULL, 'correctness', NULL, 0)",
      "(run_id, seat)",
      /council seat or label already exists/
    ],
    "seat round": [
      "council_seat_rounds (run_id, round, seat, state, current_id)",
      `('run-1', 1, 's1', 'running', '${A1}')`,
      "(run_id, round, seat)",
      /council seat round already exists/
    ],
    "attempt id": [
      "council_attempts (id, run_id, round, seat, kind, created_at, issue_by, prompt_sha256, issued_at)",
      `('${A1}', 'run-1', 1, 's1', 'prompt', 0, 1000, '${hex("1")}', 0)`,
      "(id)",
      /council attempt identity or slot already exists/
    ],
    "attempt slot": [
      "council_attempts (id, run_id, round, seat, kind, created_at, issue_by, prompt_sha256, issued_at)",
      `('${FREE}', 'run-1', 1, 's1', 'prompt', 0, 1000, '${hex("1")}', 0)`,
      "(run_id, round, seat, charge)",
      /council attempt identity or slot already exists/
    ],
    observation: [
      "council_observations (attempt_id, observed_at, event_at, outcome, answer_sha256)",
      `('${A2}', 2, 2, 'valid', '${hex("a")}')`,
      "(attempt_id)",
      /council observation already exists/
    ],
    stop: ["council_stops (job_id, requested_at, cause)", "('job-2', 2, 'deadline')", "(job_id)", /council stop already exists/],
    "stop cancellation": ["council_stop_cancels (job_id, committed_at)", "('job-2', 4)", "(job_id)", /council cancellation needs its exact dispatch/]
  };
  for (const [name, [target, values, conflict, pattern]] of Object.entries(rows)) {
    for (const verb of ["INSERT", "INSERT OR REPLACE", "INSERT OR IGNORE"]) {
      refuses(db, [`${verb} INTO ${target} VALUES ${values}`], pattern, { label: `${verb} ${name}` });
    }
    refuses(db, [`INSERT INTO ${target} VALUES ${values} ON CONFLICT ${conflict} DO NOTHING`], pattern, { label: `ON CONFLICT DO NOTHING ${name}` });
  }
});

test("migration 2 refuses updates and deletes of protected rows", (t) => {
  const { db } = seededDb(t);
  const seat = /council seat is immutable/;
  refuses(db, ["UPDATE council_seats SET lens = 'other' WHERE seat = 's1'"], seat, { label: "seat update" });
  refuses(db, ["DELETE FROM council_seats WHERE seat = 's1'"], /council seat cannot be deleted/, { label: "seat delete" });

  refuses(db, [...BIND_S2, OBSERVE_S2, `UPDATE council_observations SET observed_at = 9 WHERE attempt_id = '${A2}'`], /council observation is immutable/, {
    label: "observation update"
  });
  refuses(db, [...BIND_S2, OBSERVE_S2, `DELETE FROM council_observations WHERE attempt_id = '${A2}'`], /council observation cannot be deleted/, {
    label: "observation delete"
  });

  const s2 = "WHERE run_id = 'run-1' AND round = 1 AND seat = 's2'";
  const finalFixed = /council seat round identity or final state is fixed/;
  refuses(db, [...BIND_S2, OBSERVE_S2, ...FINISH_S2, `UPDATE council_seat_rounds SET final_at = 9 ${s2}`], finalFixed, { label: "final seat round update" });
  refuses(db, [`UPDATE council_seat_rounds SET seat = 's9' ${s2}`], finalFixed, { label: "seat round identity" });
  refuses(db, [`DELETE FROM council_seat_rounds ${s2}`], /council seat round cannot be deleted/, { label: "seat round delete" });

  const r1 = "WHERE run_id = 'run-1' AND round = 1";
  const roundFixed = /council round start, map, seal or close is fixed/;
  refuses(db, [`UPDATE council_rounds SET closed_at = 50, quorum = 1 ${r1}`, `UPDATE council_rounds SET closed_at = 60 ${r1}`], roundFixed, { label: "closed round" });
  refuses(db, [`UPDATE council_rounds SET started_at = 1 ${r1}`], roundFixed, { label: "round start" });
  refuses(db, [`UPDATE council_rounds SET quorum_at = 100, cutoff_at = 300100 ${r1}`, `UPDATE council_rounds SET quorum_at = 101, cutoff_at = 300101 ${r1}`], roundFixed, {
    label: "sealed round's seal fields"
  });
  refuses(db, [`DELETE FROM council_rounds ${r1}`], /council round cannot be deleted/, { label: "round delete" });

  const runFixed = /council run identity or revision changed/;
  refuses(db, ["UPDATE council_runs SET failed_at = 5", "UPDATE council_runs SET failed_at = 6"], runFixed, { label: "failed_at rewrite" });
  refuses(db, ["UPDATE council_runs SET failed_at = 5", "UPDATE council_runs SET failed_at = NULL"], runFixed, { label: "failed_at cleared" });
  refuses(db, ["UPDATE council_runs SET clock = 10", "UPDATE council_runs SET clock = 9"], runFixed, { label: "decreasing clock" });
  refuses(db, ["UPDATE council_runs SET input_rev = 2", "UPDATE council_runs SET input_rev = 1"], runFixed, { label: "decreasing input_rev" });
  refuses(db, ["UPDATE council_runs SET verdict_rev = 2", "UPDATE council_runs SET verdict_rev = 1"], runFixed, { label: "decreasing verdict_rev" });
  refuses(db, ["DELETE FROM council_runs"], /council run cannot be deleted/, { label: "run delete" });

  const bindingFixed = /council attempt identity or binding is fixed/;
  const a2 = `WHERE id = '${A2}'`;
  const a3 = `WHERE id = '${A3}'`;
  refuses(db, [...BIND_S2, `UPDATE council_attempts SET job_id = 'job-x' ${a2}`], bindingFixed, { label: "bound job_id rewrite" });
  refuses(db, [...BIND_S2, `UPDATE council_attempts SET job_id = NULL, issued_at = NULL ${a2}`], bindingFixed, { label: "bound job_id to NULL" });
  refuses(db, [...BIND_S2, `UPDATE council_attempts SET issued_at = 2 ${a2}`], bindingFixed, { label: "bound issued_at rewrite" });
  refuses(db, [`UPDATE council_attempts SET retired_at = 5 ${a3}`, `UPDATE council_attempts SET refusal = 'label in use' ${a3}`], bindingFixed, {
    label: "change to a retired attempt"
  });
  refuses(db, [...BIND_S2, `UPDATE council_attempts SET job_id = 'job-2', issued_at = 1 ${a3}`], bindingFixed, { label: "second attempt on one job_id" });
  refuses(db, [...BIND_S2, `UPDATE council_attempts SET refusal = 'label in use' ${a2}`], bindingFixed, { label: "refusal after binding" });
  refuses(db, [`UPDATE council_attempts SET refusal = 'label in use' ${a3}`, `UPDATE council_attempts SET job_id = 'job-3', issued_at = 1 ${a3}`], bindingFixed, {
    label: "binding after a refusal"
  });
  refuses(db, [`UPDATE council_attempts SET retired_at = 5 ${a3}`, `UPDATE council_attempts SET job_id = 'job-3', issued_at = 6 ${a3}`], bindingFixed, {
    label: "binding a retired attempt"
  });
  refuses(db, [`UPDATE council_attempts SET prompt_sha256 = '${hex("9")}' ${a3}`], bindingFixed, { label: "attempt prompt rewrite" });
  refuses(db, [`DELETE FROM council_attempts ${a3}`], /council attempt cannot be deleted/, { label: "attempt delete" });

  const stopFixed = /council stop identity or acknowledgement is fixed/;
  refuses(db, [...BIND_S2, STOP_S2, "UPDATE council_stops SET cause = 'queue'"], stopFixed, { label: "stop cause" });
  refuses(db, [...BIND_S2, STOP_S2, "UPDATE council_stops SET requested_at = 3"], stopFixed, { label: "stop requested_at" });
  refuses(db, [...BIND_S2, STOP_S2, ACK_S2, "UPDATE council_stops SET dispatched_at = 5, acknowledged_at = 5"], stopFixed, { label: "acknowledged stop" });
  refuses(db, [...BIND_S2, STOP_S2, "DELETE FROM council_stops"], /council stop cannot be deleted/, { label: "stop delete" });
  const cancelNeedsDispatch = /council cancellation needs its exact dispatch/;
  refuses(db, [...BIND_S2, STOP_S2, "INSERT INTO council_stop_cancels (job_id, committed_at) VALUES ('job-2', 4)"], cancelNeedsDispatch, {
    label: "cancellation without a dispatch"
  });
  refuses(db, [...BIND_S2, STOP_S2, ACK_S2, "INSERT INTO council_stop_cancels (job_id, committed_at) VALUES ('job-2', 5)"], cancelNeedsDispatch, {
    label: "cancellation at another time"
  });
  refuses(db, [...BIND_S2, STOP_S2, ACK_S2, CANCEL_S2, "UPDATE council_stop_cancels SET committed_at = 4"], /council cancellation is immutable/, {
    label: "cancellation update"
  });
  refuses(db, [...BIND_S2, STOP_S2, ACK_S2, CANCEL_S2, "DELETE FROM council_stop_cancels"], /council cancellation cannot be deleted/, { label: "cancellation delete" });

  // The guarded acknowledgement of an acknowledged stop changes nothing and raises nothing.
  accepts(db, [...BIND_S2, STOP_S2, ACK_S2], { commit: true, label: "acknowledged stop" });
  const guarded = db.prepare("UPDATE council_stops SET dispatched_at = 9, acknowledged_at = 9 WHERE job_id = 'job-2' AND acknowledged_at IS NULL").run();
  assert.equal(guarded.changes, 0);
  assert.throws(() => db.prepare("UPDATE council_stops SET dispatched_at = 9, acknowledged_at = 9 WHERE job_id = 'job-2'").run(), stopFixed);
});

test("migration 2 accepts the Layer 1 and Layer 2 shapes", (t) => {
  const RETRY = id("e");
  const repairByContinuation = [
    `UPDATE council_attempts SET retired_at = 10 WHERE id = '${A2}'`,
    REPAIR_S2(FREE, { kind: "continue", predecessor_id: "job-2" }),
    `UPDATE council_seat_rounds SET current_id = '${FREE}', state = 'issuing' WHERE run_id = 'run-1' AND round = 1 AND seat = 's2'`
  ];
  {
    const { db } = seededDb(t);
    accepts(db, BIND_S2, { commit: true, label: "bind" });
    for (const step of repairByContinuation) {
      runStep(db, step);
    }
    assert.equal(db.prepare("SELECT current_id FROM council_seat_rounds WHERE seat = 's2'").get().current_id, FREE);
  }
  const { db } = seededDb(t);
  accepts(db, BIND_S2, { commit: true, label: "bind" });
  accepts(db, repairByContinuation, { commit: true, label: "repair by continuation in one transaction" });

  const fresh = seededDb(t).db;
  accepts(fresh, [...BIND_S2, `UPDATE council_attempts SET retired_at = 10 WHERE id = '${A2}'`, REPAIR_S2(FREE)], { commit: true, label: "fresh create repair" });
  accepts(
    fresh,
    [
      `UPDATE council_attempts SET retired_at = 20 WHERE id = '${FREE}'`,
      REPAIR_S2(RETRY, { charge: "retry", replaces_id: FREE, created_at: 20, issue_by: 1020 }),
      `UPDATE council_seat_rounds SET current_id = '${RETRY}' WHERE run_id = 'run-1' AND round = 1 AND seat = 's2'`
    ],
    { commit: true, label: "repair then retry" }
  );

  // The Round 2 seed holds a provider continuation of the accepted job and a Claude prompt.
  const R2S1 = id("5");
  const R2S2 = id("6");
  const round2Seed = [
    `INSERT INTO council_rounds (run_id, round, started_at, map_sha256) VALUES ('run-1', 2, 100, '${hex("e")}')`,
    `INSERT INTO council_seat_rounds (run_id, round, seat, state, current_id) VALUES ('run-1', 2, 's1', 'running', '${R2S1}')`,
    `INSERT INTO council_attempts (id, run_id, round, seat, kind, created_at, issue_by, prompt_sha256, issued_at) VALUES ('${R2S1}', 'run-1', 2, 's1', 'prompt', 100, 1100, '${hex("7")}', 100)`,
    `INSERT INTO council_seat_rounds (run_id, round, seat, state, current_id) VALUES ('run-1', 2, 's2', 'issuing', '${R2S2}')`,
    `INSERT INTO council_attempts (id, run_id, round, seat, kind, created_at, issue_by, prompt_sha256, predecessor_id) VALUES ('${R2S2}', 'run-1', 2, 's2', 'continue', 100, 1100, '${hex("8")}', 'job-2')`
  ];
  const r2 = seededDb(t).db;
  accepts(r2, [...BIND_S2, ...round2Seed], { commit: true, label: "round 2 seed" });
  const R2FRESH = id("7");
  accepts(
    r2,
    [
      `UPDATE council_attempts SET job_id = 'job-r2', issued_at = 101 WHERE id = '${R2S2}'`,
      `UPDATE council_attempts SET retired_at = 200 WHERE id = '${R2S2}'`,
      `INSERT INTO council_attempts (id, run_id, round, seat, charge, replaces_id, kind, created_at, issue_by, prompt_sha256) VALUES ('${R2FRESH}', 'run-1', 2, 's2', 'retry', '${R2S2}', 'create', 200, 1200, '${hex("9")}')`,
      `UPDATE council_seat_rounds SET current_id = '${R2FRESH}' WHERE run_id = 'run-1' AND round = 2 AND seat = 's2'`
    ],
    { commit: true, label: "fresh create replacement of a retired round 2 attempt" }
  );
  const slotTaken = /council attempt identity or slot already exists/;
  const layer1 = seededDb(t).db;
  accepts(layer1, BIND_S2, { commit: true, label: "bind" });
  refuses(layer1, [REPAIR_S2(FREE), REPAIR_S2(RETRY, { replaces_id: A3 })], slotTaken, { label: "second repair slot" });
  refuses(layer1, [REPAIR_S2(FREE), REPAIR_S2(RETRY, { charge: "retry" })], slotTaken, { label: "second replacement of one attempt" });
  refuses(layer1, [REPAIR_S2(FREE, { seat: "s3" })], FOREIGN_KEY, { label: "cross-seat replaces_id on an unreplaced target" });
  refuses(
    layer1,
    [
      `INSERT INTO council_rounds (run_id, round, started_at, map_sha256) VALUES ('run-1', 2, 100, '${hex("e")}')`,
      `INSERT INTO council_seat_rounds (run_id, round, seat, state, current_id) VALUES ('run-1', 2, 's2', 'issuing', '${R2S2}')`,
      `INSERT INTO council_attempts (id, run_id, round, seat, charge, replaces_id, kind, created_at, issue_by, prompt_sha256, predecessor_id) VALUES ('${R2S2}', 'run-1', 2, 's2', 'turn', '${A2}', 'continue', 100, 1100, '${hex("8")}', 'job-2')`
    ],
    CHECK,
    { label: "a turn with replaces_id" }
  );
  refuses(layer1, [REPAIR_S2(FREE, { replaces_id: null })], CHECK, { label: "a non-turn without replaces_id" });
  refuses(layer1, [REPAIR_S2(FREE, { kind: "continue" })], CHECK, { label: "continue without a predecessor" });
  refuses(layer1, [REPAIR_S2(FREE, { predecessor_id: "job-2" })], CHECK, { label: "create with a predecessor" });
  refuses(
    layer1,
    [
      `INSERT INTO council_rounds (run_id, round, started_at, map_sha256) VALUES ('run-1', 2, 100, '${hex("e")}')`,
      `INSERT INTO council_seat_rounds (run_id, round, seat, state, current_id) VALUES ('run-1', 2, 's2', 'issuing', '${R2S2}')`,
      `INSERT INTO council_attempts (id, run_id, round, seat, kind, created_at, issue_by, prompt_sha256) VALUES ('${R2S2}', 'run-1', 2, 's2', 'create', 100, 1100, '${hex("8")}')`
    ],
    CHECK,
    { label: "a round 2 turn with create" }
  );

  const r1 = "WHERE run_id = 'run-1' AND round = 1";
  accepts(layer1, [`UPDATE council_rounds SET quorum_at = 100, cutoff_at = 300100 ${r1}`], { label: "seal at 100 and 300100" });
  accepts(layer1, [`UPDATE council_rounds SET quorum_at = 100, cutoff_at = 300100, closed_at = 100, quorum = 1 ${r1}`], { label: "seal and close in one update" });
  accepts(layer1, [`UPDATE council_rounds SET quorum_at = 100, cutoff_at = 300100 ${r1}`, `UPDATE council_rounds SET closed_at = 300100, quorum = 1 ${r1}`], {
    label: "a later close"
  });
  accepts(layer1, ["INSERT INTO council_stops (job_id, requested_at, cause) VALUES ('job-2', 300100, 'quorum-cutoff')"], { label: "a quorum-cutoff stop" });
  const roundFixed = /council round start, map, seal or close is fixed/;
  refuses(layer1, [`UPDATE council_rounds SET quorum_at = 100, cutoff_at = 300100 ${r1}`, `UPDATE council_rounds SET quorum_at = 200, cutoff_at = 300200 ${r1}`], roundFixed, {
    label: "a sealed round's quorum_at"
  });
  refuses(layer1, [`UPDATE council_rounds SET quorum_at = 100, cutoff_at = 300100 ${r1}`, `UPDATE council_rounds SET quorum_at = NULL, cutoff_at = NULL ${r1}`], roundFixed, {
    label: "a sealed round's cutoff_at"
  });
});

// ---------------------------------------------------------------------------------------------
// Objects, deposits, binding hooks and the state interfaces

const DEADLINE = () => performance.now() + 10000;

function councilRows(stateDir) {
  const dump = dumpTables(stateDir);
  return Object.fromEntries(Object.entries(dump).filter(([name]) => name.startsWith("council_") || name === "jobs" || name === "chains"));
}

function attemptRow(store, attemptId) {
  return store.read((db) => ({ ...db.prepare("SELECT * FROM council_attempts WHERE id = ?").get(attemptId) }));
}

function observationRow(store, attemptId) {
  return store.read((db) => {
    const row = db.prepare("SELECT * FROM council_observations WHERE attempt_id = ?").get(attemptId);
    return row ? { ...row } : null;
  });
}

function runClock(store, runId) {
  return rel(store.read((db) => db.prepare("SELECT clock FROM council_runs WHERE id = ?").get(runId).clock));
}

function jobCount(store, where = "1 = 1", ...params) {
  return store.read((db) => db.prepare(`SELECT count(*) AS n FROM jobs WHERE ${where}`).get(...params).n);
}

// Closes Round 1 of a seeded three-seat run with every seat valid, as the reducer would: s1 by an
// accepted receipt, s2 and s3 by bound, completed jobs. Resolves to the jobs of s2 and s3.
async function closeRound1Valid(store, runId, clock, { at = 100, ends = {} } = {}) {
  clock.set(at - 50);
  const [s1, s2, s3] = ["s1", "s2", "s3"].map((seat) => currentAttempt(store, runId, 1, seat));
  const job2 = bindAttempt(store, s2, { provider: "codex" }).jobId;
  const job3 = bindAttempt(store, s3, { provider: "agy" }).jobId;
  const receipt = await depositReceipt(store, { runId, seat: "s1", attemptId: s1, verdict: { outcome: "valid", answerSha256: hex("a") }, layer: 0, deadline: DEADLINE() });
  assert.deepEqual(receipt, { ok: true, round: 1 });
  const end = EPOCH + at - 10;
  setJob(store, job2, { end_state: ends.s2 ?? "completed", end_at: end });
  setJob(store, job3, { end_state: ends.s3 ?? "completed", end_at: end });
  const final = EPOCH + at;
  sql(
    store,
    ...[s1, s2, s3].map((attemptId, index) => [
      "UPDATE council_seat_rounds SET state = 'valid', answer_sha256 = ?, final_at = ? WHERE run_id = ? AND round = 1 AND seat = ?",
      hex(String(index + 1)),
      final,
      runId,
      `s${index + 1}`
    ]),
    ...[s1, s2, s3].map((attemptId) => ["UPDATE council_attempts SET retired_at = ? WHERE id = ?", final, attemptId]),
    ["UPDATE council_rounds SET closed_at = ?, quorum = 1 WHERE run_id = ? AND round = 1", final, runId],
    ["UPDATE council_runs SET clock = max(clock, ?), input_rev = input_rev + 4 WHERE id = ?", final, runId]
  );
  clock.set(at);
  return { job2, job3 };
}

function round2Entries(runDirOf, runId, seats, mapSha256) {
  return seats.map((seat) => ({
    seat,
    attemptId: freshAttemptId(),
    promptSha256: installObject(runDirOf(runId), `Round 2 prompt for ${seat}\n`, "md"),
    mapSha256
  }));
}

// A run with Round 1 closed valid and Round 2 seeded; resolves to the jobs and Round 2 attempts.
async function round2Run(t, { at = 100, ends = {}, clock = useTestClock(t, 0) } = {}) {
  const fixture = openCouncilStore(t);
  const { store, runDir } = fixture;
  await seedRun(store, runDir);
  const jobs = await closeRound1Valid(store, "run-1", clock, { at, ends });
  const mapSha256 = installObject(runDir("run-1"), '{"s1":{}}\n', "json");
  const entries = round2Entries(runDir, "run-1", ["s1", "s2", "s3"], mapSha256);
  assert.deepEqual(await startRound2(store, { runId: "run-1", mapSha256, entries, layer: 0, deadline: DEADLINE() }), { ok: true });
  const attempts = Object.fromEntries(entries.map((entry) => [entry.seat, entry.attemptId]));
  return { ...fixture, clock, ...jobs, attempts, mapSha256 };
}

function continueSeat(store, predecessorId, hookOptions, { force = false } = {}) {
  return decideNext(
    store,
    { ref: predecessorId, observedTipId: predecessorId },
    { action: "continue", message: "round 2 bundle", requester: { sessionId: "session-1" }, force, withinDecision: continueBindingHook({ layer: 0, ...hookOptions }) }
  );
}

test("createCouncilRun seeds in the specified order and refuses bad seats", async (t) => {
  useTestClock(t, 0);
  const { stateDir, store, runDir } = openCouncilStore(t);
  const { seats, result } = await seedRun(store, runDir);
  assert.deepEqual(result, { ok: true });
  const snapshot = readCouncil(store, "run-1");
  assert.equal(rel(snapshot.run.created_at), 0);
  assert.equal(rel(snapshot.run.clock), 0);
  assert.equal(snapshot.run.turn_cap, 12);
  assert.deepEqual(snapshot.rounds.map((round) => [round.round, rel(round.started_at), round.closed_at]), [[1, 0, null]]);
  assert.deepEqual(snapshot.seats.map((seat) => [seat.seat, seat.family, seat.provider, seat.label]), [
    ["s1", "claude", null, null],
    ["s2", "codex", "codex", "run-1-s2"],
    ["s3", "agy", "agy", "run-1-s3"]
  ]);
  assert.deepEqual(snapshot.seatRounds.map((row) => [row.seat, row.state, row.current_id]), [
    ["s1", "running", seats[0].attemptId],
    ["s2", "issuing", seats[1].attemptId],
    ["s3", "issuing", seats[2].attemptId]
  ]);
  const bySeat = Object.fromEntries(snapshot.attempts.map((attempt) => [attempt.seat, attempt]));
  assert.equal(bySeat.s1.kind, "prompt");
  assert.equal(bySeat.s1.issued_at, bySeat.s1.created_at);
  assert.equal(rel(bySeat.s1.issue_by), 1000);
  for (const seat of ["s2", "s3"]) {
    assert.equal(bySeat[seat].kind, "create");
    assert.equal(bySeat[seat].issued_at, null);
    assert.equal(bySeat[seat].job_id, null);
    assert.equal(rel(bySeat[seat].issue_by), 1000);
  }
  assert.deepEqual(snapshot.charges.total, { turn: 1, repair: 0, retry: 0 });

  const missing = await seedRun(store, runDir, { runId: "run-2", missing: ["s3"] });
  assert.deepEqual(missing.result, { ok: true });
  const second = readCouncil(store, "run-2");
  const s3 = second.seatRounds.find((row) => row.seat === "s3");
  assert.deepEqual([s3.state, s3.current_id, s3.reason, rel(s3.final_at)], ["missing-cli", null, "missing CLI", 0]);
  assert.equal(second.attempts.filter((attempt) => attempt.seat === "s3").length, 0);

  const before = councilRows(stateDir);
  const attempt = (seatsFor, overrides = {}) =>
    createCouncilRun(store, {
      runId: "run-3",
      kind: "review",
      cwd: "/workspace",
      briefSha256: hex("b"),
      options: [],
      timeoutMs: 1000,
      seats: seatsFor,
      layer: 0,
      deadline: DEADLINE(),
      ...overrides
    });
  const base = () => seatDefinitions(runDir("run-3"), { runId: "run-3" });
  assert.deepEqual(await attempt(base(), { runId: "run-1" }), { ok: false, reason: "run-exists" });
  assert.deepEqual(await attempt(base().slice(0, 1)), { ok: false, reason: "seat-count" });
  const six = seatDefinitions(runDir("run-3"), { runId: "run-3", families: ["claude", "codex", "agy", "codex", "agy"] });
  six.push({ ...six[1], seat: "s6", label: "run-3-s6", attemptId: freshAttemptId() });
  assert.deepEqual(await attempt(six), { ok: false, reason: "seat-count" });
  const mismatch = base();
  mismatch[1] = { ...mismatch[1], provider: "agy" };
  assert.deepEqual(await attempt(mismatch), { ok: false, reason: "family-provider" });
  const hostWithProvider = base();
  hostWithProvider[0] = { ...hostWithProvider[0], provider: "codex" };
  assert.deepEqual(await attempt(hostWithProvider), { ok: false, reason: "family-provider" });
  const repeated = base();
  repeated[2] = { ...repeated[2], seat: "s2" };
  assert.deepEqual(await attempt(repeated), { ok: false, reason: "duplicate-seat" });
  assert.deepEqual(await attempt(base(), { kind: "decision", options: ["only"] }), { ok: false, reason: "decision-options" });
  assert.deepEqual(await attempt(base(), { kind: "decision", options: ["a", "a"] }), { ok: false, reason: "decision-options" });
  const usedLabel = base();
  usedLabel[1] = { ...usedLabel[1], label: "run-1-s2" };
  assert.deepEqual(await attempt(usedLabel), { ok: false, reason: "label-in-use" });
  assert.deepEqual(councilRows(stateDir), before);
  assert.deepEqual(await attempt(base(), { kind: "decision", options: ["a", "b"] }), { ok: true });
});

test("deposits are write-once through their helpers", async (t) => {
  const clock = useTestClock(t, 0);
  const { store, runDir } = openCouncilStore(t);
  const { seats } = await seedRun(store, runDir);
  const [s1, s2] = [seats[0].attemptId, seats[1].attemptId];
  clock.set(10);
  const job2 = bindAttempt(store, s2).jobId;
  const receipt = { runId: "run-1", seat: "s1", attemptId: s1, layer: 0 };
  assert.deepEqual(await depositReceipt(store, { ...receipt, verdict: { outcome: "valid", answerSha256: hex("a") }, deadline: DEADLINE() }), { ok: true, round: 1 });
  const firstReceipt = observationRow(store, s1);
  clock.set(20);
  assert.deepEqual(
    await depositReceipt(store, { ...receipt, verdict: { outcome: "invalid", errorsSha256: hex("d"), reason: "schema validation failed" }, deadline: DEADLINE() }),
    { ok: false, reason: "duplicate-receipt", round: 1 }
  );
  assert.deepEqual(observationRow(store, s1), firstReceipt);

  setJob(store, job2, { end_state: "completed", end_at: EPOCH + 30 });
  clock.set(40);
  const observation = { attemptId: s2, jobId: job2, layer: 0 };
  assert.deepEqual(await depositObservation(store, { ...observation, verdict: { outcome: "valid", eventAt: EPOCH + 30, answerSha256: hex("b") }, deadline: DEADLINE() }), {
    ok: true
  });
  const firstObservation = observationRow(store, s2);
  assert.equal(rel(firstObservation.event_at), 30);
  assert.equal(rel(firstObservation.observed_at), 40);
  clock.set(50);
  assert.deepEqual(
    await depositObservation(store, { ...observation, verdict: { outcome: "late", eventAt: EPOCH + 30, reason: "execution deadline expired" }, deadline: DEADLINE() }),
    { ok: false, reason: "duplicate-observation" }
  );
  assert.deepEqual(observationRow(store, s2), firstObservation);
  assert.deepEqual(
    await depositObservation(store, { attemptId: s2, jobId: "job-other", verdict: { outcome: "missing", reason: "job pruned or missing" }, layer: 0, deadline: DEADLINE() }),
    { ok: false, reason: "binding-mismatch" }
  );

  sql(store, ["INSERT INTO council_stops (job_id, requested_at, cause) VALUES (?, ?, 'deadline')", job2, EPOCH + 50]);
  assert.deepEqual(await acknowledgeStop(store, { jobId: job2, selected: true, deadline: DEADLINE() }), { ok: true });
  const dispatched = store.read((db) => db.prepare("SELECT dispatched_at FROM council_stops WHERE job_id = ?").get(job2).dispatched_at);
  sql(store, ["INSERT INTO council_stop_cancels (job_id, committed_at) VALUES (?, ?)", job2, dispatched]);
  assert.throws(
    () => sql(store, ["INSERT OR IGNORE INTO council_observations (attempt_id, observed_at, event_at, outcome, answer_sha256) VALUES (?, 1, 1, 'valid', ?)", s2, hex("b")]),
    /council observation already exists/
  );
  assert.throws(() => sql(store, ["INSERT OR IGNORE INTO council_stops (job_id, requested_at, cause) VALUES (?, 1, 'queue')", job2]), /council stop already exists/);
  assert.throws(
    () => sql(store, ["INSERT OR IGNORE INTO council_stop_cancels (job_id, committed_at) VALUES (?, ?)", job2, dispatched]),
    /council cancellation needs its exact dispatch/
  );
});

test("depositReceipt decides the receipt inside its own transaction", async (t) => {
  const clock = useTestClock(t, 0);
  const { store, runDir } = openCouncilStore(t);
  const valid = { outcome: "valid", answerSha256: hex("a") };
  const deposit = (runId, attemptId, seat = "s1") => depositReceipt(store, { runId, seat, attemptId, verdict: valid, layer: 0, deadline: DEADLINE() });
  assert.deepEqual(await deposit("run-none", freshAttemptId()), { ok: false, reason: "unknown-run" });

  const expired = await seedRun(store, runDir, { runId: "run-1" });
  clock.set(1000);
  assert.deepEqual(await deposit("run-1", expired.seats[0].attemptId), { ok: false, reason: "intent-not-open", round: 1 });
  assert.equal(observationRow(store, expired.seats[0].attemptId), null);
  assert.deepEqual(await deposit("run-1", expired.seats[1].attemptId, "s2"), { ok: false, reason: "intent-not-open", round: 1 });
  assert.deepEqual(await deposit("run-1", expired.seats[0].attemptId, "s2"), { ok: false, reason: "intent-not-open", round: 1 });

  clock.set(2000);
  const retired = await seedRun(store, runDir, { runId: "run-2" });
  sql(store, ["UPDATE council_attempts SET retired_at = ? WHERE id = ?", EPOCH + 2001, retired.seats[0].attemptId]);
  clock.set(2002);
  assert.deepEqual(await deposit("run-2", retired.seats[0].attemptId), { ok: false, reason: "intent-not-open", round: 1 });

  clock.set(3000);
  const replaced = await seedRun(store, runDir, { runId: "run-3" });
  const old = replaced.seats[0].attemptId;
  const child = freshAttemptId();
  sql(
    store,
    [
      `INSERT INTO council_attempts (id, run_id, round, seat, charge, replaces_id, kind, created_at, issue_by, prompt_sha256, issued_at)
       VALUES (?, 'run-3', 1, 's1', 'repair', ?, 'prompt', ?, ?, ?, ?)`,
      child,
      old,
      EPOCH + 3001,
      EPOCH + 4001,
      hex("c"),
      EPOCH + 3001
    ],
    ["UPDATE council_seat_rounds SET current_id = ? WHERE run_id = 'run-3' AND round = 1 AND seat = 's1'", child]
  );
  clock.set(3002);
  assert.deepEqual(await deposit("run-3", old), { ok: false, reason: "intent-not-open", round: 1 });

  clock.set(3999);
  const first = await seedRun(store, runDir, { runId: "run-4" });
  clock.set(4998);
  assert.deepEqual(await deposit("run-4", first.seats[0].attemptId), { ok: true, round: 1 });
  assert.equal(rel(observationRow(store, first.seats[0].attemptId).event_at), 4998);

  // A later write at an earlier wall time keeps the run clock.
  clock.set(4100);
  const job = bindAttempt(store, first.seats[1].attemptId).jobId;
  assert.equal(runClock(store, "run-4"), 4998);
  setJob(store, job, { end_state: "failed", end_at: EPOCH + 4101 });
  clock.set(4050);
  assert.deepEqual(
    await depositObservation(store, { attemptId: first.seats[1].attemptId, jobId: job, verdict: { outcome: "failure", eventAt: EPOCH + 4101, reason: "provider failure" }, layer: 0, deadline: DEADLINE() }),
    { ok: true }
  );
  assert.equal(runClock(store, "run-4"), 4998);
  assert.equal(rel(observationRow(store, first.seats[1].attemptId).observed_at), 4998);
});

test("binding hooks bind once and only the current open attempt", async (t) => {
  const { store, runDir, clock, job2, job3, attempts } = await round2Run(t);

  // Create: a retired attempt rolls the job back; a replay leaves one job.
  clock.set(200);
  const other = await seedRun(store, runDir, { runId: "run-2" });
  const [, o2, o3] = other.seats.map((seat) => seat.attemptId);
  sql(store, ["UPDATE council_attempts SET retired_at = ? WHERE id = ?", EPOCH + 201, o2]);
  const jobsBefore = jobCount(store);
  assert.throws(() => bindAttempt(store, o2), (error) => error instanceof CouncilFenceError && error.code === "stale-attempt");
  assert.equal(jobCount(store), jobsBefore);
  const bound = bindAttempt(store, o3, { provider: "agy" });
  assert.equal(attemptRow(store, o3).job_id, bound.jobId);
  assert.equal(rel(attemptRow(store, o3).issued_at), 200);
  assert.throws(() => bindAttempt(store, o3, { provider: "agy" }), (error) => error instanceof CouncilFenceError && error.code === "stale-attempt");
  assert.equal(jobCount(store), jobsBefore + 1);

  // Continue: another predecessor, and the issuance fence.
  assert.throws(
    () => continueSeat(store, job2, { attemptId: attempts.s2, predecessorId: job3 }),
    (error) => error instanceof CouncilFenceError && error.code === "stale-attempt"
  );
  assert.equal(jobCount(store, "continues = ?", job2), 0);
  clock.set(1100);
  assert.throws(
    () => continueSeat(store, job2, { attemptId: attempts.s2, predecessorId: job2 }),
    (error) => error instanceof CouncilFenceError && error.code === "stale-attempt"
  );
  assert.equal(jobCount(store, "continues = ?", job2), 0);
  clock.set(300);

  // A loss to a foreign successor records the refusal while the attempt is open and unbound.
  const foreign = decideNext(store, { ref: job3, observedTipId: job3 }, { action: "continue", message: "elsewhere", requester: { sessionId: "other" } });
  assert.equal(foreign.won, true);
  const lost = continueSeat(store, job3, { attemptId: attempts.s3, predecessorId: job3 });
  assert.equal(lost.won, false);
  assert.equal(attemptRow(store, attempts.s3).refusal, `foreign successor ${foreign.successorId}`);
  assert.equal(attemptRow(store, attempts.s3).job_id, null);

  // A win binds; a replay loses to that successor and leaves the bound attempt alone.
  const won = continueSeat(store, job2, { attemptId: attempts.s2, predecessorId: job2 });
  assert.equal(won.won, true);
  const boundRow = attemptRow(store, attempts.s2);
  assert.deepEqual([boundRow.job_id, rel(boundRow.issued_at), boundRow.force_reason], [won.successorId, 300, null]);
  const replay = continueSeat(store, job2, { attemptId: attempts.s2, predecessorId: job2 });
  assert.equal(replay.won, false);
  assert.deepEqual(attemptRow(store, attempts.s2), boundRow);
});

test("continuation hooks wait for release and carry force reasons", async (t) => {
  const clock = useTestClock(t, 0);
  {
    const { store, job2, attempts } = await round2Run(t, { clock });
    setJob(store, job2, { claimed_at: EPOCH + 60 });
    assert.throws(
      () => continueSeat(store, job2, { attemptId: attempts.s2, predecessorId: job2 }),
      (error) => error instanceof CouncilFenceError && error.code === "release-wait"
    );
    assert.equal(jobCount(store, "continues = ?", job2), 0);
    assert.equal(attemptRow(store, attempts.s2).job_id, null);
    // An unobserved release then needs force; the error carries the reasons.
    setJob(store, job2, { exec_released_at: EPOCH + 70, release_kind: "unobserved", provider_exit_unobserved: 1 });
    assert.throws(
      () => continueSeat(store, job2, { attemptId: attempts.s2, predecessorId: job2 }),
      (error) => error instanceof CouncilFenceError && error.code === "force-required" && JSON.stringify(error.reasons) === '["provider-exit-unobserved"]'
    );
    assert.equal(jobCount(store, "continues = ?", job2), 0);
    // The forced call keeps the earlier reasons beside the evidence it sees now.
    setJob(store, job2, { cancelled_at: EPOCH + 80 });
    const forced = continueSeat(store, job2, { attemptId: attempts.s2, predecessorId: job2, force: true, reasons: ["thread-barrier"] }, { force: true });
    assert.equal(forced.won, true);
    assert.equal(attemptRow(store, attempts.s2).force_reason, `{"predecessorId":"${job2}","reasons":["provider-exit-unobserved","thread-barrier","cancelled-predecessor"]}`);
  }
  {
    const { store, job3, attempts } = await round2Run(t, { clock, ends: { s3: "failed" } });
    const forced = continueSeat(store, job3, { attemptId: attempts.s3, predecessorId: job3, force: true }, { force: true });
    assert.equal(forced.won, true);
    assert.equal(attemptRow(store, attempts.s3).force_reason, `{"predecessorId":"${job3}","reasons":["failed-predecessor"]}`);
  }
  {
    // Every reason at once, in the fixed order, from the production hook on a decision transaction.
    const { store, job2, attempts } = await round2Run(t, { clock, ends: { s2: "cancelled" } });
    setJob(store, job2, { thread_id: "th-1", claimed_at: EPOCH + 60, exec_released_at: EPOCH + 70, release_kind: "unobserved", provider_exit_unobserved: 1 });
    sql(store, ["INSERT INTO thread_barriers (provider, thread_id, job_id, created_at) VALUES ('codex', 'th-1', ?, ?)", job2, EPOCH + 70]);
    const successor = decideNext(store, { ref: job2, observedTipId: job2 }, { action: "continue", message: "x", force: true }).successorId;
    const hook = continueBindingHook({ attemptId: attempts.s2, predecessorId: job2, force: false, layer: 0 });
    assert.throws(
      () => store.transact((db) => hook(db, { won: true, successorId: successor, tipId: job2 })),
      (error) =>
        error instanceof CouncilFenceError &&
        JSON.stringify(error.reasons) === '["provider-exit-unobserved","thread-barrier","cancelled-predecessor"]'
    );
    assert.equal(attemptRow(store, attempts.s2).job_id, null);
  }
});

test("recordRefusal and acknowledgeStop", async (t) => {
  const clock = useTestClock(t, 0);
  const { store, runDir } = openCouncilStore(t);
  const { seats } = await seedRun(store, runDir);
  const [, s2, s3] = seats.map((seat) => seat.attemptId);
  clock.set(10);
  assert.deepEqual(await recordRefusal(store, { attemptId: s2, reason: "label in use", layer: 0, deadline: DEADLINE() }), { ok: true });
  assert.equal(attemptRow(store, s2).refusal, "label in use");
  assert.deepEqual(await recordRefusal(store, { attemptId: s2, reason: "invalid label", layer: 0, deadline: DEADLINE() }), { ok: false, reason: "stale-attempt" });
  const job3 = bindAttempt(store, s3, { provider: "agy" }).jobId;
  assert.deepEqual(await recordRefusal(store, { attemptId: s3, reason: "label in use", layer: 0, deadline: DEADLINE() }), { ok: false, reason: "stale-attempt" });
  assert.equal(attemptRow(store, s3).refusal, null);

  // Selected: dispatched_at = acknowledged_at = t.
  sql(store, ["INSERT INTO council_stops (job_id, requested_at, cause) VALUES (?, ?, 'queue')", job3, EPOCH + 15]);
  clock.set(20);
  assert.deepEqual(await acknowledgeStop(store, { jobId: job3, selected: true, deadline: DEADLINE() }), { ok: true });
  const stopRow = (jobId) => store.read((db) => ({ ...db.prepare("SELECT * FROM council_stops WHERE job_id = ?").get(jobId) }));
  const acknowledged = stopRow(job3);
  assert.deepEqual([rel(acknowledged.dispatched_at), rel(acknowledged.acknowledged_at)], [20, 20]);
  clock.set(30);
  assert.deepEqual(await acknowledgeStop(store, { jobId: job3, selected: true, deadline: DEADLINE() }), { ok: true });
  assert.deepEqual(await acknowledgeStop(store, { jobId: job3, selected: false, deadline: DEADLINE() }), { ok: true });
  assert.deepEqual(stopRow(job3), acknowledged);
  assert.equal(runClock(store, "run-1"), 20);

  // Empty selection: absent and ineligible jobs acknowledge with no dispatch; an eligible live job
  // stays pending.
  const second = await seedRun(store, runDir, { runId: "run-2" });
  const ended = second.seats[2].attemptId;
  sql(store, ["UPDATE council_attempts SET job_id = 'job-gone', issued_at = ? WHERE id = ?", EPOCH + 31, second.seats[1].attemptId]);
  sql(store, ["INSERT INTO council_stops (job_id, requested_at, cause) VALUES ('job-gone', ?, 'queue')", EPOCH + 31]);
  clock.set(40);
  assert.deepEqual(await acknowledgeStop(store, { jobId: "job-gone", selected: false, deadline: DEADLINE() }), { ok: true });
  assert.deepEqual([stopRow("job-gone").dispatched_at, rel(stopRow("job-gone").acknowledged_at)], [null, 40]);
  const endedJob = bindAttempt(store, ended, { provider: "agy" }).jobId;
  setJob(store, endedJob, { end_state: "cancelled", end_at: EPOCH + 40 });
  sql(store, ["INSERT INTO council_stops (job_id, requested_at, cause) VALUES (?, ?, 'queue')", endedJob, EPOCH + 40]);
  assert.deepEqual(await acknowledgeStop(store, { jobId: endedJob, selected: false, deadline: DEADLINE() }), { ok: true });
  assert.equal(stopRow(endedJob).dispatched_at, null);
  assert.notEqual(stopRow(endedJob).acknowledged_at, null);

  const third = await seedRun(store, runDir, { runId: "run-3" });
  const openJob = bindAttempt(store, third.seats[1].attemptId).jobId;
  sql(store, ["INSERT INTO council_stops (job_id, requested_at, cause) VALUES (?, ?, 'queue')", openJob, EPOCH + 40]);
  assert.deepEqual(await acknowledgeStop(store, { jobId: openJob, selected: false, deadline: DEADLINE() }), { ok: false, reason: "stop-still-pending" });
  assert.equal(stopRow(openJob).acknowledged_at, null);
  assert.deepEqual(await acknowledgeStop(store, { jobId: "job-unknown", selected: true, deadline: DEADLINE() }), { ok: false, reason: "unknown-stop" });
});

test("startRound2 seeds Round 2 once", async (t) => {
  const clock = useTestClock(t, 0);
  const { stateDir, store, runDir } = openCouncilStore(t);
  await seedRun(store, runDir);
  const mapSha256 = installObject(runDir("run-1"), '{"s1":{}}\n', "json");
  const start = (entries, runId = "run-1", map = mapSha256) => startRound2(store, { runId, mapSha256: map, entries, layer: 0, deadline: DEADLINE() });
  assert.deepEqual(await start(round2Entries(runDir, "run-1", ["s1", "s2", "s3"], mapSha256)), { ok: false, reason: "round-1-not-closed" });
  const { job2, job3 } = await closeRound1Valid(store, "run-1", clock);

  const before = councilRows(stateDir);
  assert.deepEqual(await start(round2Entries(runDir, "run-1", ["s1", "s2"], mapSha256)), { ok: false, reason: "entries-mismatch" });
  assert.deepEqual(await start(round2Entries(runDir, "run-1", ["s1", "s2", "s3", "s3"], mapSha256)), { ok: false, reason: "entries-mismatch" });
  assert.deepEqual(await start(round2Entries(runDir, "run-1", ["s1", "s2", "s4"], mapSha256)), { ok: false, reason: "entries-mismatch" });
  assert.deepEqual(await start(round2Entries(runDir, "run-1", ["s1", "s2", "s3"], hex("0"))), { ok: false, reason: "entries-mismatch" });
  assert.deepEqual(councilRows(stateDir), before);

  clock.set(150);
  const entries = round2Entries(runDir, "run-1", ["s1", "s2", "s3"], mapSha256);
  assert.deepEqual(await start(entries), { ok: true });
  const snapshot = readCouncil(store, "run-1");
  const round2 = snapshot.rounds.find((round) => round.round === 2);
  assert.deepEqual([rel(round2.started_at), round2.map_sha256, round2.closed_at], [150, mapSha256, null]);
  const attempts = Object.fromEntries(snapshot.attempts.filter((attempt) => attempt.round === 2).map((attempt) => [attempt.seat, attempt]));
  assert.deepEqual([attempts.s1.kind, rel(attempts.s1.issued_at), attempts.s1.predecessor_id], ["prompt", 150, null]);
  assert.deepEqual([attempts.s2.kind, attempts.s2.issued_at, attempts.s2.predecessor_id], ["continue", null, job2]);
  assert.deepEqual([attempts.s3.kind, attempts.s3.issued_at, attempts.s3.predecessor_id], ["continue", null, job3]);
  assert.equal(rel(attempts.s2.issue_by), 1150);
  for (const entry of entries) {
    const row = snapshot.seatRounds.find((seatRound) => seatRound.round === 2 && seatRound.seat === entry.seat);
    assert.equal(row.current_id, entry.attemptId);
    assert.equal(row.state, entry.seat === "s1" ? "running" : "issuing");
    assert.equal(attempts[entry.seat].id, entry.attemptId);
    assert.equal(attempts[entry.seat].prompt_sha256, entry.promptSha256);
  }
  assert.deepEqual(await start(round2Entries(runDir, "run-1", ["s1", "s2", "s3"], mapSha256)), { ok: false, reason: "round-2-already-started" });

  await seedRun(store, runDir, { runId: "run-2" });
  sql(store, [
    "UPDATE council_runs SET failed_at = clock, clock = clock WHERE id = 'run-2'"
  ], ["UPDATE council_rounds SET closed_at = started_at, quorum = 0 WHERE run_id = 'run-2' AND round = 1"]);
  assert.deepEqual(await start(round2Entries(runDir, "run-2", ["s1", "s2", "s3"], mapSha256), "run-2"), { ok: false, reason: "no-quorum" });
  assert.deepEqual(await start([], "run-none"), { ok: false, reason: "unknown-run" });
});

test("seedRound2 builds the bundles and seeds Round 2", async (t) => {
  const clock = useTestClock(t, 0);
  const { store, runDir } = openCouncilStore(t);
  await seedRun(store, runDir);
  await closeRound1Valid(store, "run-1", clock);
  const finding = (id) => ({ id, severity: "P2", claim: `${id} claim`, path: null, line: null, evidence: `${id} evidence` });
  const answer = (ids) => ({ schema: 1, stance: null, confidence: "high", dealbreaker: null, findings: ids.map(finding), assumptions: [], wouldChangeMind: "a test" });
  const answers = { s1: answer(["f1"]), s2: answer(["f1", "f2"]), s3: answer([]) };
  answers.s2.findings[0].claim = "As run-1-s2 (codex) I found f1";
  const { result, mapSha256, entries } = await seedRound2(store, runDir, { answers });
  assert.deepEqual(result, { ok: true });
  assert.equal(readCouncil(store, "run-1").rounds.find((round) => round.round === 2).map_sha256, mapSha256);
  assert.deepEqual(entries.map((entry) => entry.seat), ["s1", "s2", "s3"]);
  const mapping = JSON.parse(readObject(runDir("run-1"), mapSha256, "json").toString("utf8"));
  for (const seat of ["s1", "s2", "s3"]) {
    assert.deepEqual(Object.values(mapping[seat]).sort(), ["s1", "s2", "s3"].filter((other) => other !== seat));
  }
  const promptOf = (seat) => readObject(runDir("run-1"), entries.find((entry) => entry.seat === seat).promptSha256, "md").toString("utf8");
  assert.ok(promptOf("s1").includes("I found f1"), promptOf("s1"));
  assert.doesNotMatch(promptOf("s1"), /run-1-s2|codex/i);
  assert.doesNotMatch(promptOf("s2"), /I found f1/);
  const round2 = readCouncil(store, "run-1").attempts.filter((attempt) => attempt.round === 2);
  assert.deepEqual(round2.map((attempt) => [attempt.seat, attempt.kind]), [["s1", "prompt"], ["s2", "continue"], ["s3", "continue"]]);
  assert.deepEqual(await seedRound2(store, runDir, { answers }).then((value) => value.result), {
    ok: false,
    reason: "round-2-already-started"
  });
});

test("objects install without clobbering and exports re-check the row", (t) => {
  const runDir = path.join(makeStoreDir(t), "council", "run-1");
  const first = installObject(runDir, "answer bytes\n", "json");
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(installObject(runDir, Buffer.from("answer bytes\n"), "json"), first);
  assert.deepEqual(fs.readdirSync(path.join(runDir, "objects")), [`${first}.json`]);
  assert.equal(readObject(runDir, first, "json").toString("utf8"), "answer bytes\n");

  const objectFile = path.join(runDir, "objects", `${first}.json`);
  fs.chmodSync(objectFile, 0o600);
  fs.writeFileSync(objectFile, "changed bytes\n");
  assert.throws(() => readObject(runDir, first, "json"), (error) => error instanceof ObjectDamagedError && error.sha256 === first);
  assert.equal(installObject(runDir, "answer bytes\n", "json"), first);
  assert.equal(readObject(runDir, first, "json").toString("utf8"), "answer bytes\n");
  const absent = hex("9");
  assert.throws(() => readObject(runDir, absent, "md"), (error) => error instanceof ObjectDamagedError && error.sha256 === absent);

  const briefA = installObject(runDir, "brief A\n", "md");
  const briefB = installObject(runDir, "brief B\n", "md");
  const exportFile = path.join(runDir, "brief.md");
  assert.equal(publishExport(runDir, "brief.md", briefA, () => briefA), true);
  assert.equal(fs.readFileSync(exportFile, "utf8"), "brief A\n");
  // The row stops naming B before the rename: the earlier export stays.
  assert.equal(publishExport(runDir, "brief.md", briefB, () => briefA), false);
  assert.equal(fs.readFileSync(exportFile, "utf8"), "brief A\n");
  // The row changes after the rename: the export this call wrote is removed.
  const answers = [briefB, briefA];
  assert.equal(publishExport(runDir, "brief.md", briefB, () => answers.shift()), false);
  assert.equal(fs.existsSync(exportFile), false);
  assert.equal(publishExport(runDir, "brief.md", briefB, () => briefB), true);
  assert.equal(fs.readFileSync(exportFile, "utf8"), "brief B\n");

  const map = installObject(runDir, '{"s1":{"A":"s2"}}\n', "json");
  assert.equal(publishExport(runDir, "private/anonymisation.json", map, () => map), true);
  assert.equal(fs.readFileSync(path.join(runDir, "private", "anonymisation.json"), "utf8"), '{"s1":{"A":"s2"}}\n');
  assert.deepEqual(
    fs.readdirSync(runDir).filter((name) => name.startsWith(".tmp-")),
    []
  );
  assert.throws(() => publishExport(runDir, "report.md", absent, () => absent), ObjectDamagedError);
});

// Turns a store written by this version back into a version-4 store: the council tables of
// migration 4 with their rows, without the extension tables, indexes and triggers.
function asVersion4Store(stateDir) {
  for (const trigger of EXTENSION_TRIGGERS) {
    rawExec(stateDir, `DROP TRIGGER IF EXISTS ${trigger}`);
  }
  for (const table of EXTENSION_TABLES) {
    rawExec(stateDir, `DROP TABLE IF EXISTS ${table}`);
  }
  rawExec(stateDir, "PRAGMA user_version = 4");
}

function migration4Rows(stateDir) {
  const dump = dumpTables(stateDir);
  return Object.fromEntries(Object.entries(dump).filter(([name]) => name.startsWith("council_") && !name.startsWith("council_ext_")));
}

test("migration 5 adds the extension tables to a version-4 store once and keeps its council runs", (t) => {
  const { db, stateDir } = seededDb(t);
  accepts(db, [...BIND_S2, OBSERVE_S2, ...FINISH_S2], { commit: true, label: "a bound, observed and final seat" });
  asVersion4Store(stateDir);
  assert.equal(rawAll(stateDir, "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'council\\_ext\\_%' ESCAPE '\\'")[0].n, 0);
  const before = migration4Rows(stateDir);
  assert.equal(before.council_runs.length, 1);
  const countFile = path.join(stateDir, "migrations.txt");
  process.env.AGENT_PLUGIN_TEST_MIGRATION_COUNT_FILE = countFile;
  try {
    store.openStore(stateDir).close();
    store.openStore(stateDir).close();
  } finally {
    delete process.env.AGENT_PLUGIN_TEST_MIGRATION_COUNT_FILE;
  }
  assert.equal(fs.readFileSync(countFile, "utf8").trim().split(/\r?\n/).length, 1);
  assert.equal(rawAll(stateDir, "PRAGMA user_version")[0].user_version, 5);
  assert.deepEqual(migration4Rows(stateDir), before);
  assert.deepEqual(rawAll(stateDir, "PRAGMA foreign_key_check"), []);
  const names = (type) =>
    rawAll(stateDir, "SELECT name FROM sqlite_master WHERE type = ? AND name LIKE 'council\\_ext\\_%' ESCAPE '\\' ORDER BY name", [type]).map((row) => row.name);
  assert.deepEqual(names("table"), [...EXTENSION_TABLES].sort());
  assert.deepEqual(names("index"), EXTENSION_INDEXES);
  assert.deepEqual(names("trigger"), EXTENSION_TRIGGERS);
});

const TURN = id("e");
const TURN_2 = id("d");
const SUBSTITUTE = (turnId, { round = 1, seat = "s2", kind = "substitute", at = 10 } = {}) =>
  `INSERT INTO council_ext_turns (id, run_id, seat, kind, round, created_at, issue_by, prompt_sha256) VALUES ('${turnId}', 'run-1', '${seat}', '${kind}', ${round}, ${at}, ${at + 1000}, '${hex("5")}')`;
const ISSUE = (turnId, at = 10) => `INSERT INTO council_ext_events (turn_id, kind, at) VALUES ('${turnId}', 'issue', ${at})`;
const DEPOSIT = (turnId, at = 20, code = "valid") =>
  `INSERT INTO council_ext_events (turn_id, kind, at, event_at, code, digest) VALUES ('${turnId}', 'deposit', ${at}, ${at}, '${code}', ${code === "valid" ? `'${hex("6")}'` : "NULL"})`;
const FINISH = (turnId, code, at = 21) =>
  `INSERT INTO council_ext_events (turn_id, kind, at, code, reason) VALUES ('${turnId}', 'finish', ${at}, '${code}', ${code === "valid" ? "NULL" : "'a reason'"})`;
const CLOSE_ROUND_1 = ["UPDATE council_rounds SET closed_at = 30, quorum = 0 WHERE run_id = 'run-1' AND round = 1", "UPDATE council_runs SET failed_at = 30 WHERE id = 'run-1'"];
const DECISION = (decision, at = 31) => `INSERT INTO council_ext_decisions (run_id, kind, scope, at, decision) VALUES ('run-1', 'substitution', 1, ${at}, '${decision}')`;

test("migration 5 accepts one substitute per seat and round and refuses impossible extension rows", (t) => {
  const { db } = seededDb(t);
  accepts(db, [SUBSTITUTE(TURN), ISSUE(TURN), DEPOSIT(TURN), FINISH(TURN, "valid")], { commit: true, label: "substitute, issue, valid deposit, valid finish" });
  accepts(db, [SUBSTITUTE(TURN_2, { seat: "s3" }), ISSUE(TURN_2), FINISH(TURN_2, "timed-out", 1010)], { label: "a silent substitute times out" });
  refuses(db, [SUBSTITUTE(TURN_2)], /duplicate council extension turn/, { label: "a second substitute for the same seat and round" });
  refuses(db, [SUBSTITUTE(TURN_2, { seat: "s3", kind: "carry" })], CHECK, { label: "a carry in round 1" });
  refuses(db, [SUBSTITUTE(TURN_2, { seat: "s3", round: 2 })], /council extension turn outside eligible round/, { label: "a substitute in a round that does not exist" });
  // A finish other than valid on a turn with a timely valid deposit (the migration's one change).
  refuses(db, [SUBSTITUTE(TURN_2, { seat: "s3" }), ISSUE(TURN_2), DEPOSIT(TURN_2), FINISH(TURN_2, "invalid")], /invalid council extension finish/, { label: "invalid finish over a valid deposit" });
  refuses(db, [SUBSTITUTE(TURN_2, { seat: "s3" }), ISSUE(TURN_2), DEPOSIT(TURN_2, 1010)], /invalid council extension deposit/, { label: "a Claude deposit at its issue_by" });
  refuses(db, [SUBSTITUTE(TURN_2, { seat: "s3" }), DEPOSIT(TURN_2)], /council extension event requires issuance/, { label: "a deposit before issue" });
  refuses(db, [SUBSTITUTE(TURN_2, { seat: "s3" }), ISSUE(TURN_2), FINISH(TURN_2, "valid")], /invalid council extension finish/, { label: "a valid finish with no deposit" });
  refuses(db, [FINISH(TURN, "valid", 22)], /duplicate council extension event/, { label: "a second finish" });
  refuses(db, [`UPDATE council_ext_events SET at = 25 WHERE turn_id = '${TURN}' AND kind = 'finish'`], /immutable council extension event/, { label: "event update" });
  refuses(db, [`DELETE FROM council_ext_turns WHERE id = '${TURN}'`], /immutable council extension turn/, { label: "turn delete" });
  // Identity: an extension turn id is never a core attempt id.
  refuses(
    db,
    [
      `INSERT INTO council_attempts (id, run_id, round, seat, charge, replaces_id, kind, created_at, issue_by, prompt_sha256) VALUES ('${TURN}', 'run-1', 1, 's2', 'repair', '${A2}', 'create', 10, 1010, '${hex("c")}')`
    ],
    /council identity already owned by extension/,
    { label: "a core attempt with an extension turn id" }
  );
  // A closed round or failed run takes no new turn and no decision.
  refuses(db, [...CLOSE_ROUND_1, SUBSTITUTE(TURN_2, { seat: "s3" })], /council extension turn outside eligible round/, { label: "a substitute after close" });
  refuses(db, [...CLOSE_ROUND_1, DECISION("decline")], /substitution decision requires open round/, { label: "a decision after close" });
  accepts(db, [DECISION("accept")], { commit: true, label: "a decision" });
  refuses(db, [DECISION("decline", 32)], /duplicate council extension decision/, { label: "a second decision" });
  // Requests: inserted without a result, finalized once.
  const request = `INSERT INTO council_ext_requests (id, run_id, kind, at, payload) VALUES ('${id("a")}', 'run-1', 'collect', 40, '{"round":1}')`;
  refuses(db, [`INSERT INTO council_ext_requests (id, run_id, kind, at, payload, result) VALUES ('${id("a")}', 'run-1', 'collect', 40, '{"round":1}', '{}')`], /invalid or duplicate council extension request/, {
    label: "a request with a result"
  });
  accepts(db, [request, `UPDATE council_ext_requests SET result = '{"decision":"accept"}' WHERE id = '${id("a")}'`], { label: "a request finalized once" });
  refuses(db, [request, `UPDATE council_ext_requests SET result = '{"decision":"accept"}'`, `UPDATE council_ext_requests SET result = '{"decision":"decline"}'`], /immutable council extension request/, {
    label: "a request finalized twice"
  });
});
