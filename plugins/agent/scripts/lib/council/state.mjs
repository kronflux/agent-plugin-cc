// Council coordination state in the job store: the collection layer, the time constants, and the
// transactions that seed, deposit, bind, refuse, acknowledge and reduce council rows.
import { randomBytes } from "node:crypto";

import { wallNow, withRetry } from "../store.mjs";
import { reduceRound } from "./reduce.mjs";

/**
 * The collection layer this release ships: 0 is one attempt per seat, 1 adds repair, retry and
 * exact cancellation attribution, 2 adds the quorum cutoff. Commands read it once and pass it to
 * every state function as `layer`; no state function reads it.
 */
export const COUNCIL_LAYER = 0;

/** How long a selected stop dispatch, or a foreign cancellation, may stay unsettled. */
export const STOP_BOUND_MS = 120000;
/** The time after quorum that the rest of the seats get (read only at layer 2). */
export const GRACE_MS = 180000;
/** The spacing between two stop requests for one job inside one command. */
export const STOP_RETRY_MS = 5000;
/** The longest run-wide stop cleanup pass of a closed collect. */
export const CLEANUP_BUDGET_MS = 30000;
/** The longest usage read. */
export const USAGE_READ_MS = 30000;
/** The longest wait between two looks at the store while collecting. */
export const POLL_MS = 2000;
/** The time budget of each command that advances collection. */
export const BUDGET_MS = Object.freeze({ start: 120000, collect: 540000, submit: 120000, crossexam: 120000 });

const FORCE_REASONS = Object.freeze(["provider-exit-unobserved", "thread-barrier", "failed-predecessor", "cancelled-predecessor"]);
const ATTEMPT_ID = /^[0-9a-f]{32}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const LABEL = /^[a-z0-9-]{1,40}$/;
const RECEIPT_OUTCOMES = new Set(["valid", "invalid"]);
const OBSERVATION_OUTCOMES = new Set(["valid", "invalid", "late", "cancelled", "quota", "failure", "missing"]);

/**
 * A council predicate that failed inside a job store hook, thrown so the store rolls the job
 * creation or decision back. `code` is `stale-attempt`, `release-wait` or `force-required`; a
 * `force-required` error carries the ordered `reasons`.
 */
export class CouncilFenceError extends Error {
  constructor(code, { reasons = undefined } = {}) {
    super(
      code === "force-required"
        ? `The continuation needs force: ${reasons.join(", ")}.`
        : code === "release-wait"
          ? "The predecessor's execution has not been released."
          : "The council attempt is no longer open for issuance."
    );
    this.name = "CouncilFenceError";
    this.code = code;
    if (reasons !== undefined) {
      this.reasons = [...reasons];
    }
  }
}

function transact(store, deadline, fn) {
  return withRetry((opts) => store.transact(fn, opts), "command", { deadline });
}

// The raw wall sample and the council time of a transaction: the run clock never goes back.
function sampleTimes(clock) {
  const w = wallNow();
  return { w, t: Math.max(clock, w) };
}

function writeClock(db, runId, t) {
  db.prepare("UPDATE council_runs SET clock = max(clock, ?) WHERE id = ?").run(t, runId);
}

function plain(row) {
  return row ? { ...row } : null;
}

// An attempt with its seat round, round and run fields, read in the caller's transaction.
function attemptContext(db, attemptId) {
  return plain(
    db
      .prepare(
        `SELECT a.*, sr.current_id AS current_id, sr.state AS seat_state, r.closed_at AS round_closed_at,
           ru.clock AS run_clock
         FROM council_attempts AS a
         JOIN council_seat_rounds AS sr ON sr.run_id = a.run_id AND sr.round = a.round AND sr.seat = a.seat
         JOIN council_rounds AS r ON r.run_id = a.run_id AND r.round = a.round
         JOIN council_runs AS ru ON ru.id = a.run_id
         WHERE a.id = ?`
      )
      .get(attemptId)
  );
}

// The issuance fence: the current, unretired, unbound, unrefused provider attempt of an open
// round, before its issue_by.
function issuanceOpen(context, t) {
  return (
    context.round_closed_at === null &&
    context.current_id === context.id &&
    context.retired_at === null &&
    context.job_id === null &&
    context.issued_at === null &&
    context.refusal === null &&
    context.kind !== "prompt" &&
    t < context.issue_by
  );
}

function observationExists(db, attemptId) {
  return Boolean(db.prepare("SELECT 1 FROM council_observations WHERE attempt_id = ?").get(attemptId));
}

function refuseInTransaction(db, context, reason, t) {
  db.prepare("UPDATE council_attempts SET refusal = ? WHERE id = ?").run(reason, context.id);
  writeClock(db, context.run_id, t);
}

function orderedReasons(reasons) {
  const present = new Set(reasons);
  return FORCE_REASONS.filter((reason) => present.has(reason));
}

// The force a continuation of `predecessor` needs now, in the fixed reason order.
function forceEvidence(db, predecessor) {
  const reasons = [];
  if (predecessor.provider_exit_unobserved === 1 || predecessor.release_kind === "unobserved") {
    reasons.push("provider-exit-unobserved");
  }
  if (
    predecessor.thread_id &&
    db.prepare("SELECT 1 FROM thread_barriers WHERE provider = ? AND thread_id = ?").get(predecessor.provider, predecessor.thread_id)
  ) {
    reasons.push("thread-barrier");
  }
  if (predecessor.end_state === "failed") {
    reasons.push("failed-predecessor");
  }
  if (predecessor.end_state === "cancelled" || predecessor.cancelled_at !== null) {
    reasons.push("cancelled-predecessor");
  }
  return reasons;
}

function isDigest(value) {
  return typeof value === "string" && DIGEST.test(value);
}

function optionalDigest(value) {
  return value === undefined || value === null || isDigest(value);
}

// The reason a seat definition is refused before any store access, or null.
function seatProblem(seat, index) {
  if (seat.seat !== `s${index + 1}` || typeof seat.family !== "string" || seat.family === "") {
    return "invalid-seat";
  }
  if (typeof seat.lens !== "string" || seat.lens === "" || (seat.model !== undefined && seat.model !== null && typeof seat.model !== "string")) {
    return "invalid-seat";
  }
  const host = seat.family === "claude";
  const provider = seat.provider ?? null;
  if (host ? provider !== null : provider !== seat.family) {
    return "family-provider";
  }
  if (host) {
    if ((seat.label ?? null) !== null || seat.missingCli) {
      return "invalid-seat";
    }
  } else if (typeof seat.label !== "string" || !LABEL.test(seat.label)) {
    return "invalid-label";
  }
  if (!seat.missingCli && (typeof seat.attemptId !== "string" || !ATTEMPT_ID.test(seat.attemptId))) {
    return "invalid-seat";
  }
  if (!seat.missingCli && (!isDigest(seat.promptSha256) || !optionalDigest(seat.retryPromptSha256))) {
    return "invalid-seat";
  }
  return null;
}

// The reason a run request is refused before any store access, or null.
function runInputProblem({ runId, kind, cwd, briefSha256, options, timeoutMs, seats }) {
  if (typeof runId !== "string" || runId === "" || (kind !== "review" && kind !== "decision") || typeof cwd !== "string" || cwd === "") {
    return "invalid-run";
  }
  if (!isDigest(briefSha256) || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return "invalid-run";
  }
  if (!Array.isArray(options) || options.some((option) => typeof option !== "string" || option === "")) {
    return "decision-options";
  }
  if (kind === "decision" && new Set(options).size < 2) {
    return "decision-options";
  }
  if (!Array.isArray(seats) || seats.length < 2 || seats.length > 5) {
    return "seat-count";
  }
  if (new Set(seats.map((seat) => seat?.seat)).size !== seats.length) {
    return "duplicate-seat";
  }
  for (const [index, seat] of seats.entries()) {
    const problem = seatProblem(seat, index);
    if (problem) {
      return problem;
    }
  }
  const issued = seats.filter((seat) => !seat.missingCli);
  if (new Set(issued.map((seat) => seat.attemptId)).size !== issued.length) {
    return "invalid-seat";
  }
  const labels = seats.filter((seat) => seat.label).map((seat) => seat.label);
  if (new Set(labels).size !== labels.length) {
    return "invalid-label";
  }
  if (issued.length < 2 || new Set(issued.map((seat) => seat.family)).size < 2) {
    return "no-quorum-possible";
  }
  return null;
}

/**
 * Seeds a council run and its Round 1 in one transaction: run, round, seat definitions, then each
 * seat round with its attempt (a Claude seat `running` with a prompt issued at creation, a
 * provider seat `issuing` with a create attempt, a `missing-cli` seat with no attempt). Seats are
 * `{ seat, family, provider, model, lens, label, attemptId, promptSha256, retryPromptSha256,
 * missingCli }` in planned order `s1`, `s2`, ...; `options` are the decision options. Resolves to
 * `{ ok: true }` or `{ ok: false, reason }` with nothing written.
 */
export async function createCouncilRun(store, { runId, kind, sessionId = null, cwd, briefSha256, options = [], timeoutMs, seats, layer = 0, deadline } = {}) {
  void layer;
  const problem = runInputProblem({ runId, kind, cwd, briefSha256, options, timeoutMs, seats });
  if (problem) {
    return { ok: false, reason: problem };
  }
  return transact(store, deadline, (db) => {
    if (db.prepare("SELECT 1 FROM council_runs WHERE id = ?").get(runId)) {
      return { ok: false, reason: "run-exists" };
    }
    for (const seat of seats) {
      if (seat.label && db.prepare("SELECT 1 FROM council_seats WHERE label = ?").get(seat.label)) {
        return { ok: false, reason: "label-in-use" };
      }
    }
    const w = wallNow();
    db.prepare(
      `INSERT INTO council_runs (id, kind, session_id, cwd, brief_sha256, options_json, timeout_ms, seat_count, turn_cap, created_at, clock)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(runId, kind, sessionId, cwd, briefSha256, JSON.stringify(options), timeoutMs, seats.length, 2 * seats.length + 6, w, w);
    db.prepare("INSERT INTO council_rounds (run_id, round, started_at) VALUES (?, 1, ?)").run(runId, w);
    const insertSeat = db.prepare(
      "INSERT INTO council_seats (run_id, seat, family, provider, model, lens, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const seat of seats) {
      insertSeat.run(runId, seat.seat, seat.family, seat.provider ?? null, seat.model ?? null, seat.lens, seat.label ?? null, w);
    }
    for (const seat of seats) {
      if (seat.missingCli) {
        db.prepare(
          "INSERT INTO council_seat_rounds (run_id, round, seat, state, current_id, reason, final_at) VALUES (?, 1, ?, 'missing-cli', NULL, 'missing CLI', ?)"
        ).run(runId, seat.seat, w);
        continue;
      }
      const host = seat.family === "claude";
      db.prepare("INSERT INTO council_seat_rounds (run_id, round, seat, state, current_id) VALUES (?, 1, ?, ?, ?)").run(
        runId,
        seat.seat,
        host ? "running" : "issuing",
        seat.attemptId
      );
      db.prepare(
        `INSERT INTO council_attempts (id, run_id, round, seat, kind, created_at, issue_by, prompt_sha256, retry_prompt_sha256, issued_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
      ).run(seat.attemptId, runId, seat.seat, host ? "prompt" : "create", w, w + timeoutMs, seat.promptSha256, seat.retryPromptSha256 ?? null, host ? w : null);
    }
    return { ok: true };
  });
}

function emptyCharges() {
  return { turn: 0, repair: 0, retry: 0 };
}

function readSnapshot(db, runId) {
  const run = plain(db.prepare("SELECT * FROM council_runs WHERE id = ?").get(runId));
  if (!run) {
    return null;
  }
  const all = (sql) => db.prepare(sql).all(runId).map(plain);
  const attempts = all("SELECT * FROM council_attempts WHERE run_id = ? ORDER BY round, seat, created_at, id");
  const charges = { total: emptyCharges(), rounds: {} };
  for (const attempt of attempts) {
    if (attempt.issued_at === null) {
      continue;
    }
    charges.rounds[attempt.round] ??= emptyCharges();
    charges.rounds[attempt.round][attempt.charge] += 1;
    charges.total[attempt.charge] += 1;
  }
  return {
    run,
    rounds: all("SELECT * FROM council_rounds WHERE run_id = ? ORDER BY round"),
    seats: all("SELECT * FROM council_seats WHERE run_id = ? ORDER BY seat"),
    seatRounds: all("SELECT * FROM council_seat_rounds WHERE run_id = ? ORDER BY round, seat"),
    attempts,
    observations: all(
      `SELECT o.* FROM council_observations AS o JOIN council_attempts AS a ON a.id = o.attempt_id
       WHERE a.run_id = ? ORDER BY a.round, a.seat, o.observed_at, o.attempt_id`
    ),
    stops: all(
      `SELECT s.* FROM council_stops AS s JOIN council_attempts AS a ON a.job_id = s.job_id
       WHERE a.run_id = ? ORDER BY s.requested_at, s.job_id`
    ),
    cancels: all(
      `SELECT c.* FROM council_stop_cancels AS c JOIN council_attempts AS a ON a.job_id = c.job_id
       WHERE a.run_id = ? ORDER BY c.committed_at, c.job_id`
    ),
    charges,
    verdicts: all("SELECT * FROM council_verdicts WHERE run_id = ? ORDER BY target_kind, target")
  };
}

/**
 * One read snapshot of a council run: run, rounds, seats, seat rounds, attempts, observations,
 * stops, stop cancellations, issued charges (`{ total, rounds: { [round]: { turn, repair, retry } } }`)
 * and verdicts; null for an unknown run.
 */
export function readCouncil(store, runId, opts = {}) {
  return store.read((db) => readSnapshot(db, runId), opts);
}

function verdictProblem(verdict, outcomes) {
  if (!verdict || typeof verdict !== "object" || !outcomes.has(verdict.outcome)) {
    return "outcome";
  }
  const valid = verdict.outcome === "valid";
  if (valid ? !isDigest(verdict.answerSha256) : verdict.answerSha256 != null) {
    return "answerSha256";
  }
  if (verdict.errorsSha256 != null && (verdict.outcome !== "invalid" || !isDigest(verdict.errorsSha256))) {
    return "errorsSha256";
  }
  if (valid ? verdict.reason != null : typeof verdict.reason !== "string" || verdict.reason === "") {
    return "reason";
  }
  if (!optionalDigest(verdict.replacementSha256)) {
    return "replacementSha256";
  }
  return null;
}

function checkVerdict(verdict, outcomes) {
  const problem = verdictProblem(verdict, outcomes);
  if (problem) {
    throw new TypeError(`A council verdict has an invalid ${problem}.`);
  }
}

function insertObservation(db, attemptId, verdict, { observedAt, afterClose }) {
  const replacement = verdict.replacementSha256 ?? null;
  db.prepare(
    `INSERT INTO council_observations (attempt_id, observed_at, event_at, after_close, outcome, answer_sha256, errors_sha256,
       reason, transient, replacement_required, replacement_sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    attemptId,
    observedAt,
    verdict.outcome === "missing" ? null : verdict.eventAt,
    afterClose,
    verdict.outcome,
    verdict.answerSha256 ?? null,
    verdict.errorsSha256 ?? null,
    verdict.reason ?? null,
    verdict.transient ? 1 : 0,
    replacement ? 1 : 0,
    replacement
  );
}

/**
 * Records the validated reply to a Claude prompt as that attempt's receipt. Checks, in order, the
 * run and the attempt's identity, an earlier receipt, the open prompt (current, unretired,
 * running, open round, receipt time before `issue_by`), and at layer 1 or more an invalid
 * verdict's prepared replacement digest. `verdict` is `{ outcome: "valid" | "invalid",
 * answerSha256, errorsSha256, reason, replacementSha256 }`. Resolves to `{ ok: true, round }` or
 * `{ ok: false, reason, round? }`.
 */
export async function depositReceipt(store, { runId, seat, attemptId, verdict, layer = 0, deadline } = {}) {
  checkVerdict(verdict, RECEIPT_OUTCOMES);
  return transact(store, deadline, (db) => {
    if (!db.prepare("SELECT 1 FROM council_runs WHERE id = ?").get(runId)) {
      return { ok: false, reason: "unknown-run" };
    }
    const context = attemptContext(db, attemptId);
    if (!context || context.run_id !== runId) {
      return { ok: false, reason: "intent-not-open" };
    }
    const round = context.round;
    if (context.seat !== seat || context.kind !== "prompt") {
      return { ok: false, reason: "intent-not-open", round };
    }
    if (observationExists(db, attemptId)) {
      return { ok: false, reason: "duplicate-receipt", round };
    }
    const { t } = sampleTimes(context.run_clock);
    const open =
      context.round_closed_at === null &&
      context.current_id === context.id &&
      context.retired_at === null &&
      context.seat_state === "running" &&
      t < context.issue_by;
    if (!open) {
      return { ok: false, reason: "intent-not-open", round };
    }
    if (layer >= 1 && verdict.outcome === "invalid" && !verdict.replacementSha256) {
      return { ok: false, reason: "replacement-digest-missing", round };
    }
    insertObservation(db, attemptId, { ...verdict, eventAt: t }, { observedAt: t, afterClose: 0 });
    writeClock(db, context.run_id, t);
    return { ok: true, round };
  });
}

/**
 * Records the classified outcome of the exact job bound to an attempt, also after the attempt
 * retired or its round closed (then `after_close` is 1). Checks, in order, the binding, an earlier
 * observation, and at layer 1 or more the prepared replacement digest of a new invalid or
 * transient verdict. `verdict` is `{ outcome, eventAt, answerSha256, errorsSha256, reason,
 * transient, replacementSha256 }`; `eventAt` is the job's end time, unused for `missing`.
 * Resolves to `{ ok: true }` or `{ ok: false, reason }`.
 */
export async function depositObservation(store, { attemptId, jobId, verdict, layer = 0, deadline } = {}) {
  checkVerdict(verdict, OBSERVATION_OUTCOMES);
  if (verdict.outcome !== "missing" && !Number.isInteger(verdict.eventAt)) {
    throw new TypeError("A council observation needs the job's end time as eventAt.");
  }
  return transact(store, deadline, (db) => {
    const context = attemptContext(db, attemptId);
    if (!context || context.job_id === null || context.job_id !== jobId) {
      return { ok: false, reason: "binding-mismatch" };
    }
    if (observationExists(db, attemptId)) {
      return { ok: false, reason: "duplicate-observation" };
    }
    if (layer >= 1 && (verdict.outcome === "invalid" || verdict.transient) && !verdict.replacementSha256) {
      return { ok: false, reason: "replacement-digest-missing" };
    }
    const { t } = sampleTimes(context.run_clock);
    insertObservation(db, attemptId, verdict, { observedAt: t, afterClose: context.round_closed_at === null ? 0 : 1 });
    writeClock(db, context.run_id, t);
    return { ok: true };
  });
}

/**
 * Records a durable issuance refusal (an exact reason string) on the current, open, unretired,
 * unbound provider attempt before its `issue_by`. Resolves to `{ ok: true }` or
 * `{ ok: false, reason: "stale-attempt" }`.
 */
export async function recordRefusal(store, { attemptId, reason, layer = 0, deadline } = {}) {
  void layer;
  if (typeof reason !== "string" || reason === "") {
    throw new TypeError("A council refusal needs a reason.");
  }
  return transact(store, deadline, (db) => {
    const context = attemptContext(db, attemptId);
    if (!context) {
      return { ok: false, reason: "stale-attempt" };
    }
    const { t } = sampleTimes(context.run_clock);
    if (!issuanceOpen(context, t)) {
      return { ok: false, reason: "stale-attempt" };
    }
    refuseInTransaction(db, context, reason, t);
    return { ok: true };
  });
}

/**
 * The `withinCreate` hook that binds a new job to the create attempt `attemptId` in the job's
 * creation transaction, writing `job_id` and `issued_at`; throws CouncilFenceError
 * `stale-attempt` (rolling the creation back) when the attempt is not open for issuance.
 */
export function createBindingHook({ attemptId, layer = 0 } = {}) {
  void layer;
  return (db, { jobId }) => {
    const context = attemptContext(db, attemptId);
    if (!context) {
      throw new CouncilFenceError("stale-attempt");
    }
    const { t } = sampleTimes(context.run_clock);
    if (context.kind !== "create" || !issuanceOpen(context, t)) {
      throw new CouncilFenceError("stale-attempt");
    }
    db.prepare("UPDATE council_attempts SET job_id = ?, issued_at = ? WHERE id = ?").run(jobId, t, attemptId);
    writeClock(db, context.run_id, t);
  };
}

/**
 * The `withinDecision` hook of a continuation of `predecessorId` for the continue attempt
 * `attemptId`. On a win it checks the issuance fence, the tip and the successor's predecessor,
 * that the predecessor's execution was released (else `release-wait`) and, on an unforced call,
 * that no force is now needed (else `force-required` with the ordered reasons); then it binds the
 * successor, storing on a forced call `force_reason` as `{"predecessorId","reasons"}` with the
 * reasons of this call and of the earlier unforced call (`reasons`). On a loss to a successor it
 * records the refusal `foreign successor <jobId>` while the attempt is still open for issuance.
 */
export function continueBindingHook({ attemptId, predecessorId, force = false, reasons = [], layer = 0 } = {}) {
  void layer;
  return (db, { won, successorId, tipId }) => {
    const context = attemptContext(db, attemptId);
    if (!won) {
      if (!successorId || !context) {
        return;
      }
      const { t } = sampleTimes(context.run_clock);
      if (context.kind === "continue" && issuanceOpen(context, t)) {
        refuseInTransaction(db, context, `foreign successor ${successorId}`, t);
      }
      return;
    }
    if (!context) {
      throw new CouncilFenceError("stale-attempt");
    }
    const { t } = sampleTimes(context.run_clock);
    if (context.kind !== "continue" || context.predecessor_id !== predecessorId || tipId !== predecessorId || !issuanceOpen(context, t)) {
      throw new CouncilFenceError("stale-attempt");
    }
    const successor = db.prepare("SELECT continues FROM jobs WHERE id = ?").get(successorId);
    const predecessor = plain(db.prepare("SELECT * FROM jobs WHERE id = ?").get(predecessorId));
    if (!successor || successor.continues !== predecessorId || !predecessor) {
      throw new CouncilFenceError("stale-attempt");
    }
    if (predecessor.claimed_at !== null && predecessor.exec_released_at === null) {
      throw new CouncilFenceError("release-wait");
    }
    const evidence = forceEvidence(db, predecessor);
    let forceReason = null;
    if (!force) {
      if (evidence.length > 0) {
        throw new CouncilFenceError("force-required", { reasons: evidence });
      }
    } else {
      const combined = orderedReasons([...reasons, ...evidence]);
      forceReason = combined.length > 0 ? JSON.stringify({ predecessorId, reasons: combined }) : null;
    }
    db.prepare("UPDATE council_attempts SET job_id = ?, issued_at = ?, force_reason = ? WHERE id = ?").run(successorId, t, forceReason, attemptId);
    writeClock(db, context.run_id, t);
  };
}

// Whether a stop request naming this job would select it: an unreleased execution, or an
// unclaimed chain tip with no end decision.
function stopEligible(db, job) {
  if (!job) {
    return false;
  }
  if (job.claimed_at !== null && job.exec_released_at === null) {
    return true;
  }
  if (job.claimed_at !== null || job.end_state !== null) {
    return false;
  }
  return db.prepare("SELECT tip_job_id FROM chains WHERE id = ?").get(job.chain_id)?.tip_job_id === job.id;
}

/**
 * Acknowledges the pending council stop of `jobId` after a stop request: `selected` (the request
 * selected this exact job) records `dispatched_at = acknowledged_at`; an empty selection
 * acknowledges with no dispatch only when the job is absent or no longer selectable, and
 * otherwise resolves to `{ ok: false, reason: "stop-still-pending" }`. An acknowledged stop
 * resolves to `{ ok: true }` with no write; a job with no council stop to
 * `{ ok: false, reason: "unknown-stop" }`.
 */
export async function acknowledgeStop(store, { jobId, selected, deadline } = {}) {
  return transact(store, deadline, (db) => {
    const stop = plain(
      db
        .prepare(
          `SELECT s.*, a.run_id AS run_id, ru.clock AS run_clock FROM council_stops AS s
           JOIN council_attempts AS a ON a.job_id = s.job_id JOIN council_runs AS ru ON ru.id = a.run_id
           WHERE s.job_id = ?`
        )
        .get(jobId)
    );
    if (!stop) {
      return { ok: false, reason: "unknown-stop" };
    }
    if (stop.acknowledged_at !== null) {
      return { ok: true };
    }
    const { t } = sampleTimes(stop.run_clock);
    if (selected) {
      db.prepare("UPDATE council_stops SET dispatched_at = ?, acknowledged_at = ? WHERE job_id = ? AND acknowledged_at IS NULL").run(t, t, jobId);
    } else {
      if (stopEligible(db, plain(db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId)))) {
        return { ok: false, reason: "stop-still-pending" };
      }
      db.prepare("UPDATE council_stops SET acknowledged_at = ? WHERE job_id = ? AND acknowledged_at IS NULL").run(t, jobId);
    }
    writeClock(db, stop.run_id, t);
    return { ok: true };
  });
}

function entriesMatch(entries, mapSha256, validSeats) {
  if (!Array.isArray(entries) || entries.length !== validSeats.length) {
    return false;
  }
  const seen = new Set();
  const attemptIds = new Set();
  for (const entry of entries) {
    if (!entry || !validSeats.includes(entry.seat) || seen.has(entry.seat) || entry.mapSha256 !== mapSha256) {
      return false;
    }
    if (typeof entry.attemptId !== "string" || !ATTEMPT_ID.test(entry.attemptId) || attemptIds.has(entry.attemptId)) {
      return false;
    }
    if (!isDigest(entry.promptSha256) || !optionalDigest(entry.retryPromptSha256)) {
      return false;
    }
    seen.add(entry.seat);
    attemptIds.add(entry.attemptId);
  }
  return true;
}

/**
 * Seeds Round 2 once, after a closed Round 1 with quorum: the round with its map digest, then for
 * each valid Round 1 seat a seat round and its attempt (a provider continues the job whose answer
 * was accepted, a Claude seat gets a prompt issued at creation). `entries` are `{ seat, attemptId,
 * promptSha256, retryPromptSha256, mapSha256 }`, exactly one per valid Round 1 seat. Resolves to
 * `{ ok: true }` or `{ ok: false, reason }` (`unknown-run`, `round-2-already-started`,
 * `round-1-not-closed`, `no-quorum`, `entries-mismatch`) with nothing written.
 */
export async function startRound2(store, { runId, mapSha256, entries, layer = 0, deadline } = {}) {
  void layer;
  return transact(store, deadline, (db) => {
    const run = plain(db.prepare("SELECT * FROM council_runs WHERE id = ?").get(runId));
    if (!run) {
      return { ok: false, reason: "unknown-run" };
    }
    const rounds = db.prepare("SELECT * FROM council_rounds WHERE run_id = ? ORDER BY round").all(runId).map(plain);
    if (rounds.some((round) => round.round === 2)) {
      return { ok: false, reason: "round-2-already-started" };
    }
    const round1 = rounds.find((round) => round.round === 1);
    if (!round1 || round1.closed_at === null) {
      return { ok: false, reason: "round-1-not-closed" };
    }
    if (run.failed_at !== null || round1.quorum !== 1) {
      return { ok: false, reason: "no-quorum" };
    }
    const accepted = db
      .prepare(
        `SELECT sr.seat AS seat, s.family AS family, a.job_id AS job_id FROM council_seat_rounds AS sr
         JOIN council_seats AS s ON s.run_id = sr.run_id AND s.seat = sr.seat
         JOIN council_attempts AS a ON a.id = sr.current_id
         WHERE sr.run_id = ? AND sr.round = 1 AND sr.state = 'valid' ORDER BY sr.seat`
      )
      .all(runId)
      .map(plain);
    if (!isDigest(mapSha256) || !entriesMatch(entries, mapSha256, accepted.map((row) => row.seat))) {
      return { ok: false, reason: "entries-mismatch" };
    }
    if (accepted.some((row) => row.family !== "claude" && row.job_id === null)) {
      return { ok: false, reason: "entries-mismatch" };
    }
    const { t } = sampleTimes(run.clock);
    db.prepare("INSERT INTO council_rounds (run_id, round, started_at, map_sha256) VALUES (?, 2, ?, ?)").run(runId, t, mapSha256);
    const bySeat = new Map(entries.map((entry) => [entry.seat, entry]));
    for (const row of accepted) {
      const entry = bySeat.get(row.seat);
      const host = row.family === "claude";
      db.prepare("INSERT INTO council_seat_rounds (run_id, round, seat, state, current_id) VALUES (?, 2, ?, ?, ?)").run(
        runId,
        row.seat,
        host ? "running" : "issuing",
        entry.attemptId
      );
      db.prepare(
        `INSERT INTO council_attempts (id, run_id, round, seat, kind, created_at, issue_by, prompt_sha256, retry_prompt_sha256,
           predecessor_id, issued_at)
         VALUES (?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        entry.attemptId,
        runId,
        row.seat,
        host ? "prompt" : "continue",
        t,
        t + run.timeout_ms,
        entry.promptSha256,
        entry.retryPromptSha256 ?? null,
        host ? null : row.job_id,
        host ? t : null
      );
    }
    writeClock(db, runId, t);
    return { ok: true };
  });
}

// The exact-job projection of the reducer and the hooks: the job row, its display state, whether
// it is its chain's tip, its direct successor and the barrier on its thread.
const EXACT_JOB_SQL = `SELECT j.*,
       CASE
         WHEN j.cancelled_at IS NOT NULL THEN 'cancelled'
         WHEN j.end_state IS NOT NULL THEN j.end_state
         WHEN j.stopping_since IS NOT NULL THEN 'stopping'
         WHEN j.started_at IS NOT NULL THEN 'running'
         ELSE 'queued'
       END AS state,
       (c.tip_job_id=j.id) AS isTip,
       s.id AS successorId,
       b.job_id AS barrierJobId
FROM jobs AS j
JOIN chains AS c ON c.id=j.chain_id
LEFT JOIN jobs AS s ON s.chain_id=j.chain_id AND s.continues=j.id
LEFT JOIN thread_barriers AS b
  ON b.provider=j.provider AND b.thread_id=j.thread_id
WHERE j.id=:exactJobId;`;

// The reducer's view of one round, read in the caller's transaction.
function readRoundView(db, run, roundRow, freshIds) {
  const runId = run.id;
  const round = roundRow.round;
  const attempts = db.prepare("SELECT * FROM council_attempts WHERE run_id = ? AND round = ? ORDER BY seat, created_at, id").all(runId, round).map(plain);
  const ids = new Set(attempts.map((attempt) => attempt.id));
  const jobIds = attempts.map((attempt) => attempt.job_id).filter((jobId) => jobId !== null);
  const observations = db
    .prepare(
      `SELECT o.* FROM council_observations AS o JOIN council_attempts AS a ON a.id = o.attempt_id
       WHERE a.run_id = ? AND a.round = ? ORDER BY o.attempt_id`
    )
    .all(runId, round)
    .map(plain)
    .filter((row) => ids.has(row.attempt_id));
  const stops = [];
  const cancels = [];
  const jobs = {};
  for (const jobId of jobIds) {
    const stop = db.prepare("SELECT * FROM council_stops WHERE job_id = ?").get(jobId);
    if (stop) {
      stops.push(plain(stop));
    }
    const cancel = db.prepare("SELECT * FROM council_stop_cancels WHERE job_id = ?").get(jobId);
    if (cancel) {
      cancels.push(plain(cancel));
    }
    const job = db.prepare(EXACT_JOB_SQL).get({ exactJobId: jobId });
    if (job) {
      jobs[jobId] = plain(job);
    }
  }
  return {
    run,
    round: roundRow,
    seats: db.prepare("SELECT * FROM council_seats WHERE run_id = ? ORDER BY seat").all(runId).map(plain),
    seatRounds: db.prepare("SELECT * FROM council_seat_rounds WHERE run_id = ? AND round = ? ORDER BY seat").all(runId, round).map(plain),
    attempts,
    observations,
    stops,
    cancels,
    jobs,
    freshIds
  };
}

function applyWrite(db, view, write, t) {
  const runId = view.run.id;
  const round = view.round.round;
  switch (write.op) {
    case "account":
      db.prepare("UPDATE council_seat_rounds SET state = 'running' WHERE run_id = ? AND round = ? AND seat = ? AND state = 'issuing'").run(runId, round, write.seat);
      return;
    case "finish": {
      db.prepare(
        `UPDATE council_seat_rounds SET state = ?, reason = ?, answer_sha256 = ?, errors_sha256 = ?, final_at = ?
         WHERE run_id = ? AND round = ? AND seat = ?`
      ).run(write.state, write.reason, write.answerSha256, write.errorsSha256, t, runId, round, write.seat);
      db.prepare(
        `UPDATE council_attempts SET retired_at = ?
         WHERE id = (SELECT current_id FROM council_seat_rounds WHERE run_id = ? AND round = ? AND seat = ?) AND retired_at IS NULL`
      ).run(t, runId, round, write.seat);
      if (write.state === "valid") {
        db.prepare("UPDATE council_runs SET input_rev = input_rev + 1 WHERE id = ?").run(runId);
      }
      return;
    }
    case "stop":
      db.prepare("INSERT INTO council_stops (job_id, requested_at, cause) VALUES (?, ?, ?)").run(write.jobId, t, write.cause);
      return;
    case "close":
      db.prepare("UPDATE council_rounds SET closed_at = ?, quorum = ? WHERE run_id = ? AND round = ?").run(t, write.quorum, runId, round);
      db.prepare("UPDATE council_runs SET input_rev = input_rev + 1 WHERE id = ?").run(runId);
      if (write.quorum === 0) {
        db.prepare("UPDATE council_runs SET failed_at = ? WHERE id = ? AND failed_at IS NULL").run(t, runId);
      }
      return;
    default:
      throw new TypeError(`Unknown council write: ${write.op}`);
  }
}

/**
 * Reduces one round in one transaction: reads the round's rows and exact jobs, takes one raw wall
 * sample and the council time, applies the rows of `reduceRound` in order and writes the clock.
 * Resolves to `{ ok: true, changed, closed }` (`changed` when any row other than the clock was
 * written, `closed` when the round is closed afterwards) or `{ ok: false, reason }` (`unknown-run`,
 * `round-not-started`).
 */
export async function reduceRun(store, { runId, round, layer = 0, deadline } = {}) {
  const seatCount = 5;
  const freshIds = Array.from({ length: seatCount * 2 }, () => randomBytes(16).toString("hex"));
  return transact(store, deadline, (db) => {
    const run = plain(db.prepare("SELECT * FROM council_runs WHERE id = ?").get(runId));
    if (!run) {
      return { ok: false, reason: "unknown-run" };
    }
    const roundRow = plain(db.prepare("SELECT * FROM council_rounds WHERE run_id = ? AND round = ?").get(runId, round));
    if (!roundRow) {
      return { ok: false, reason: "round-not-started" };
    }
    const view = readRoundView(db, run, roundRow, freshIds.slice(0, run.seat_count * 2));
    const { w, t } = sampleTimes(run.clock);
    const { writes } = reduceRound(view, { w, t, layer });
    for (const write of writes) {
      applyWrite(db, view, write, t);
    }
    writeClock(db, runId, t);
    const closed = roundRow.closed_at !== null || writes.some((write) => write.op === "close");
    return { ok: true, changed: writes.length > 0, closed };
  });
}
