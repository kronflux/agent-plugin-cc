// Library-level council fixtures: a migrated store with a test wall clock, seat definitions,
// a seeded run, job rows for the exact-job projection, and the Round 2 seed.
import path from "node:path";
import { randomBytes } from "node:crypto";

import { makeStoreDir } from "./store-fixtures.mjs";
import { openStore } from "../plugins/agent/scripts/lib/store.mjs";
import { createJob } from "../plugins/agent/scripts/lib/state.mjs";
import { installObject } from "../plugins/agent/scripts/lib/council/objects.mjs";
import {
  createBindingHook,
  createCouncilRun,
  depositObservation,
  depositReceipt,
  readCouncil,
  reduceRun,
  startRound2
} from "../plugins/agent/scripts/lib/council/state.mjs";

/** The epoch that test times are relative to. */
export const EPOCH = 1_800_000_000_000;

/**
 * Replaces Date.now for the test, so wallNow() returns EPOCH + the time last set. Returns
 * `{ set(ms), now() }` with times relative to EPOCH.
 */
export function useTestClock(t, start = 0) {
  let current = start;
  t.mock.method(Date, "now", () => EPOCH + current);
  return {
    set(ms) {
      current = ms;
    },
    now() {
      return current;
    }
  };
}

/** A fresh attempt id. */
export function freshAttemptId() {
  return randomBytes(16).toString("hex");
}

/** A migrated store in a fresh state folder, closed when the test ends. */
export function openCouncilStore(t) {
  const stateDir = makeStoreDir(t);
  const store = openStore(stateDir);
  t.after(() => store.close());
  return { stateDir, store, runDir: (runId) => path.join(stateDir, "council", runId) };
}

/** Converts relative times in council rows (absolute epoch values) back to test times. */
export function rel(value) {
  return value === null || value === undefined ? value : value - EPOCH;
}

/**
 * The seat definitions of a three-seat council: s1 Claude, s2 Codex, s3 Antigravity, each with
 * its prompt installed under `runDir` and a fresh attempt id. `missing` lists seats seeded
 * `missing-cli`.
 */
export function seatDefinitions(runDir, { runId = "run-1", missing = [], families = ["claude", "codex", "agy"] } = {}) {
  const lenses = ["correctness", "security", "maintainability", "cost", "risk"];
  return families.map((family, index) => {
    const seat = `s${index + 1}`;
    const host = family === "claude";
    const missingCli = missing.includes(seat);
    return {
      seat,
      family,
      provider: host ? null : family,
      model: null,
      lens: lenses[index],
      label: host ? null : `${runId}-${seat}`,
      attemptId: missingCli ? undefined : freshAttemptId(),
      promptSha256: missingCli ? undefined : installObject(runDir, `Round 1 prompt for ${seat}\n`, "md"),
      missingCli
    };
  });
}

/**
 * Seeds a council run through createCouncilRun with the three default seats and T = 1000 unless
 * overridden. Resolves to `{ runId, seats, result }`.
 */
export async function seedRun(store, runDirOf, { runId = "run-1", timeoutMs = 1000, kind = "review", options = [], missing = [], families, layer = 0 } = {}) {
  const runDir = runDirOf(runId);
  const seats = seatDefinitions(runDir, { runId, missing, families });
  const briefSha256 = installObject(runDir, `Brief of ${runId}\n`, "md");
  const result = await createCouncilRun(store, {
    runId,
    kind,
    sessionId: "session-1",
    cwd: "/workspace",
    briefSha256,
    options,
    timeoutMs,
    seats,
    layer,
    deadline: performance.now() + 10000
  });
  return { runId, seats, result };
}

/** The job fields of a council seat's job, for createJob. */
export function seatJobFields(provider = "codex", overrides = {}) {
  return { provider, kind: "task", title: "council seat", prompt: "seat prompt", request: {}, cwd: "/workspace", ...overrides };
}

/** Creates the job of a provider attempt through createJob with the council binding hook. */
export function bindAttempt(store, attemptId, { provider = "codex", label = null, layer = 0 } = {}) {
  return createJob(store, seatJobFields(provider), { label, withinCreate: createBindingHook({ attemptId, layer }) });
}

/** Applies column values to one job row in a store transaction (a fixture write). */
export function setJob(store, jobId, columns) {
  const names = Object.keys(columns);
  store.transact((db) => {
    db.prepare(`UPDATE jobs SET ${names.map((name) => `${name} = ?`).join(", ")} WHERE id = ?`).run(...names.map((name) => columns[name]), jobId);
  });
}

/** Runs plain SQL steps in one store transaction (a fixture write). */
export function sql(store, ...steps) {
  store.transact((db) => {
    for (const step of steps) {
      if (typeof step === "string") {
        db.exec(step);
      } else {
        const [text, ...params] = step;
        db.prepare(text).run(...params);
      }
    }
  });
}

/** The current attempt id of a seat in a round. */
export function currentAttempt(store, runId, round, seat) {
  return store.read((db) => db.prepare("SELECT current_id FROM council_seat_rounds WHERE run_id = ? AND round = ? AND seat = ?").get(runId, round, seat))
    ?.current_id;
}

const COUNCIL_KEYS = {
  council_runs: ["id"],
  council_rounds: ["run_id", "round"],
  council_seats: ["run_id", "seat"],
  council_seat_rounds: ["run_id", "round", "seat"],
  council_attempts: ["id"],
  council_observations: ["attempt_id"],
  council_stops: ["job_id"],
  council_stop_cancels: ["job_id"],
  council_verdicts: ["run_id", "target_kind", "target"]
};

/** Every council row, by table and primary key; the run clock is left out. */
export function councilSnapshot(store) {
  return store.read((db) => {
    const snapshot = {};
    for (const [table, keys] of Object.entries(COUNCIL_KEYS)) {
      snapshot[table] = {};
      for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
        const copy = { ...row };
        if (table === "council_runs") {
          delete copy.clock;
        }
        snapshot[table][keys.map((key) => row[key]).join("|")] = copy;
      }
    }
    return snapshot;
  });
}

// Times are shown relative to EPOCH so expected changes read as test times.
function shown(value) {
  return typeof value === "number" && value > EPOCH / 2 ? value - EPOCH : value;
}

/**
 * The row changes between two snapshots, sorted: `"<table> <key> <column>: <before> -> <after>"`
 * for a changed column and `"<table> <key> inserted"` for a new row. Attempt keys are shown by
 * seat name through `names` (attempt id to label) when given.
 */
export function councilChanges(before, after, names = {}) {
  const changes = [];
  const label = (key) => names[key] ?? key;
  for (const table of Object.keys(COUNCIL_KEYS)) {
    for (const [key, row] of Object.entries(after[table])) {
      const old = before[table][key];
      if (!old) {
        changes.push(`${table} ${label(key)} inserted`);
        continue;
      }
      for (const column of Object.keys(row)) {
        if (old[column] !== row[column]) {
          changes.push(`${table} ${label(key)} ${column}: ${shown(old[column])} -> ${shown(row[column])}`);
        }
      }
    }
    for (const key of Object.keys(before[table])) {
      if (!after[table][key]) {
        changes.push(`${table} ${label(key)} deleted`);
      }
    }
  }
  return changes.sort();
}

/** reduceRun with the fixture defaults (layer 0, a ten-second deadline). */
export function reduce(store, runId = "run-1", round = 1, layer = 0) {
  return reduceRun(store, { runId, round, layer, deadline: performance.now() + 10000 });
}

/** depositObservation with the fixture defaults. */
export function observe(store, attemptId, jobId, verdict, layer = 0) {
  return depositObservation(store, { attemptId, jobId, verdict, layer, deadline: performance.now() + 10000 });
}

/** depositReceipt with the fixture defaults. */
export function receive(store, runId, seat, attemptId, verdict, layer = 0) {
  return depositReceipt(store, { runId, seat, attemptId, verdict, layer, deadline: performance.now() + 10000 });
}

/**
 * Closes Round 1 of a seeded three-seat run with quorum through the library: at `at` it binds the
 * provider seats, ends their jobs completed and timely, deposits a valid receipt for s1 and valid
 * observations for s2 and s3, and reduces. Resolves to the jobs of s2 and s3.
 */
export async function closeRound1ByReduce(store, runId, clock, { at }) {
  clock.set(at);
  const [s1, s2, s3] = ["s1", "s2", "s3"].map((seat) => currentAttempt(store, runId, 1, seat));
  const job2 = bindAttempt(store, s2, { provider: "codex" }).jobId;
  const job3 = bindAttempt(store, s3, { provider: "agy" }).jobId;
  for (const jobId of [job2, job3]) {
    setJob(store, jobId, { claimed_at: EPOCH + at, started_at: EPOCH + at, end_state: "completed", end_at: EPOCH + at, exec_released_at: EPOCH + at, release_kind: "confirmed" });
  }
  await receive(store, runId, "s1", s1, { outcome: "valid", answerSha256: "1".repeat(64) });
  await observe(store, s2, job2, { outcome: "valid", eventAt: EPOCH + at, answerSha256: "2".repeat(64) });
  await observe(store, s3, job3, { outcome: "valid", eventAt: EPOCH + at, answerSha256: "3".repeat(64) });
  const result = await reduce(store, runId, 1);
  if (!result.closed) {
    throw new Error("Round 1 did not close");
  }
  return { job2, job3 };
}

/**
 * Seeds Round 2 of a run whose Round 1 is closed with quorum: builds the anonymised bundles of
 * the valid seats' answers (`random(max)` picks each shuffle position) (`answers` maps seat to its Round 1 answer object), installs the map
 * and one prompt per seat, and calls startRound2. Resolves to `{ result, mapSha256, entries }`.
 */
export async function seedRound2(store, runDirOf, { runId = "run-1", answers, random = () => 0, layer = 0 } = {}) {
  const { buildBundles } = await import("../plugins/agent/scripts/lib/council/anonymise.mjs");
  const runDir = runDirOf(runId);
  const snapshot = readCouncil(store, runId);
  const valid = snapshot.seatRounds.filter((row) => row.round === 1 && row.state === "valid").map((row) => row.seat);
  const seats = snapshot.seats
    .filter((seat) => valid.includes(seat.seat))
    .map((seat) => ({ seat: seat.seat, family: seat.family, label: seat.label, model: seat.model }));
  const round1 = Object.fromEntries(valid.map((seat) => [seat, answers[seat]]));
  const { bundles, mapping } = buildBundles(seats, round1, { random, runId });
  const mapSha256 = installObject(runDir, `${JSON.stringify(mapping)}\n`, "json");
  const entries = valid.map((seat) => ({
    seat,
    attemptId: freshAttemptId(),
    promptSha256: installObject(runDir, `Round 2 prompt\n${JSON.stringify(bundles[seat])}\n`, "md"),
    mapSha256
  }));
  const result = await startRound2(store, { runId, mapSha256, entries, layer, deadline: performance.now() + 10000 });
  return { result, mapSha256, entries };
}
