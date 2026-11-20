// Council coordination state in the job store: the collection layer, the time constants, and the
// transactions that seed, deposit, bind, refuse, acknowledge and reduce council rows.
import { randomBytes } from "node:crypto";

import { wallNow, withRetry } from "../store.mjs";
import { reduceRound } from "./reduce.mjs";
import { followupLimits, followupWrites, turnActor } from "./reduce-ext.mjs";

/**
 * The collection layer this release ships: 0 is one attempt per seat, 1 adds repair, retry and
 * exact cancellation attribution, 2 adds the quorum cutoff. Commands read it once and pass it to
 * every state function as `layer`; no state function reads it.
 */
export const COUNCIL_LAYER = 2;

/**
 * The council extensions this release ships: follow-up questions, a Claude stand-in for a seat
 * that ended a round without a valid answer, and the agreed-panel challenge. Commands read the
 * object once and pass it as `extensions`; a disabled extension takes no new request, while the
 * reducer, the read projections and submit still settle extension work already committed.
 */
export const COUNCIL_EXTENSIONS = Object.freeze({ followups: true, substitution: true, challenge: false });

/** How long a selected stop dispatch, or a foreign cancellation, may stay unsettled. */
export const STOP_BOUND_MS = 120000;
/** The time after quorum that the rest of the seats get: five minutes (sealed only at layer 2). */
export const GRACE_MS = 300000;
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

/**
 * The named points (E8 `testPoint`) where a council command pauses under a test; none of them is
 * inside a store transaction.
 */
export const COUNCIL_TEST_POINTS = Object.freeze({
  beforeCreate: "council-before-create",
  afterCreate: "council-after-create",
  beforeDecide: "council-before-decide",
  afterDecide: "council-after-decide",
  beforeStop: "council-before-stop",
  afterStop: "council-after-stop",
  beforeLaunch: "council-before-launch",
  afterLaunch: "council-after-launch",
  afterReplyValidation: "council-after-reply-validation",
  afterDeposit: "council-after-deposit",
  beforeReduce: "council-before-reduce",
  afterSeed: "council-after-seed",
  beforeExport: "council-before-export"
});

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
           r.cutoff_at AS round_cutoff_at, ru.clock AS run_clock
         FROM council_attempts AS a
         JOIN council_seat_rounds AS sr ON sr.run_id = a.run_id AND sr.round = a.round AND sr.seat = a.seat
         JOIN council_rounds AS r ON r.run_id = a.run_id AND r.round = a.round
         JOIN council_runs AS ru ON ru.id = a.run_id
         WHERE a.id = ?`
      )
      .get(attemptId)
  );
}

// Whether a sealed round's quorum cutoff has come: after it nothing is issued or received.
function cutoffPassed(context, t) {
  return context.round_cutoff_at !== null && t >= context.round_cutoff_at;
}

// The issuance fence: the current, unretired, unbound, unrefused provider attempt of an open
// round, before its issue_by and before the round's quorum cutoff.
function issuanceOpen(context, t) {
  return (
    context.round_closed_at === null &&
    !cutoffPassed(context, t) &&
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

// The extension rows of a run: turns in creation order, their events, the decisions, the
// requests, and the issued extension turns per round and in total (each issue is one charge).
function readExtension(db, runId) {
  const all = (sql) => db.prepare(sql).all(runId).map(plain);
  const turns = all("SELECT * FROM council_ext_turns WHERE run_id = ? ORDER BY created_at, id");
  const events = all(
    `SELECT e.* FROM council_ext_events AS e JOIN council_ext_turns AS x ON x.id = e.turn_id
     WHERE x.run_id = ? ORDER BY x.created_at, x.id, e.at, e.kind`
  );
  const issued = { total: 0, rounds: {} };
  const roundOf = new Map(turns.map((turn) => [turn.id, turn.round]));
  for (const event of events) {
    if (event.kind !== "issue") {
      continue;
    }
    issued.total += 1;
    const round = roundOf.get(event.turn_id);
    if (round !== null && round !== undefined) {
      issued.rounds[round] = (issued.rounds[round] ?? 0) + 1;
    }
  }
  return {
    turns,
    events,
    decisions: all("SELECT * FROM council_ext_decisions WHERE run_id = ? ORDER BY kind, scope"),
    requests: all("SELECT * FROM council_ext_requests WHERE run_id = ? ORDER BY at, id"),
    issued
  };
}

// The Round 1 answer digest of each Round 1 stand-in with a valid finish, by actor key (`s2~r1`):
// the answers a Round 2 letter map names.
function actorAnswers(ext) {
  const answers = {};
  for (const turn of ext.turns) {
    if (turn.kind !== "substitute" || turn.round !== 1) {
      continue;
    }
    const finish = ext.events.find((event) => event.turn_id === turn.id && event.kind === "finish");
    const deposit = ext.events.find((event) => event.turn_id === turn.id && event.kind === "deposit");
    if (finish?.code === "valid" && deposit?.digest) {
      answers[turnActor(turn)] = deposit.digest;
    }
  }
  return answers;
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
  const ext = readExtension(db, runId);
  return {
    run,
    rounds: all("SELECT * FROM council_rounds WHERE run_id = ? ORDER BY round"),
    seats: all("SELECT * FROM council_seats WHERE run_id = ? ORDER BY seat"),
    seatRounds: all("SELECT * FROM council_seat_rounds WHERE run_id = ? ORDER BY round, seat"),
    ext,
    actorAnswers: actorAnswers(ext),
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
 * running, open round, receipt time before `issue_by` and before a sealed round's cutoff), and
 * at layer 1 or more an invalid verdict's prepared replacement digest. `verdict` is `{ outcome:
 * "valid" | "invalid", answerSha256, errorsSha256, reason, replacementSha256 }`. Resolves to
 * `{ ok: true, round }` or `{ ok: false, reason, round? }`.
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
      !cutoffPassed(context, t) &&
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

/**
 * The `withinStop` hook of the exact stop request for `jobId` (Layer 1): when the request selected
 * the job and its council stop is still pending, it records `dispatched_at = acknowledged_at = t`
 * (t ratcheted from the request's commit time) and, only when the job had no earlier cancel request
 * and had not ended, the first-cancellation evidence in the same transaction. An acknowledged
 * stop, an empty selection or a job with no council stop writes nothing.
 */
export function stopHook({ jobId } = {}) {
  return (db, { commitWall, selection }) => {
    const entry = (selection ?? []).find((item) => item.jobId === jobId);
    if (!entry) {
      return;
    }
    const stop = plain(
      db
        .prepare(
          `SELECT s.*, a.run_id AS run_id, ru.clock AS run_clock FROM council_stops AS s
           JOIN council_attempts AS a ON a.job_id = s.job_id JOIN council_runs AS ru ON ru.id = a.run_id
           WHERE s.job_id = ?`
        )
        .get(jobId)
    );
    if (!stop || stop.acknowledged_at !== null) {
      return;
    }
    const t = Math.max(stop.run_clock, commitWall);
    db.prepare("UPDATE council_stops SET dispatched_at = ?, acknowledged_at = ? WHERE job_id = ? AND acknowledged_at IS NULL").run(t, t, jobId);
    if (!entry.hadCancelRequest && !entry.wasEnded) {
      db.prepare("INSERT INTO council_stop_cancels (job_id, committed_at) VALUES (?, ?)").run(jobId, t);
    }
    writeClock(db, stop.run_id, t);
  };
}

/**
 * Thrown by the extension stop hook when W3 left an eligible exact job out of the selection; the
 * stop request rolls back and the stop stays pending.
 */
export class CouncilStopSelectionError extends Error {
  constructor() {
    super("Exact stop selection omitted an eligible job.");
    this.name = "CouncilStopSelectionError";
  }
}

// An extension turn with its run clock and its events by kind, read in the caller's transaction.
function extensionTurnContext(db, turnId) {
  const turn = plain(
    db
      .prepare("SELECT x.*, ru.clock AS run_clock, ru.timeout_ms AS run_timeout_ms FROM council_ext_turns AS x JOIN council_runs AS ru ON ru.id = x.run_id WHERE x.id = ?")
      .get(turnId)
  );
  if (!turn) {
    return null;
  }
  const events = {};
  for (const event of db.prepare("SELECT * FROM council_ext_events WHERE turn_id = ?").all(turnId)) {
    events[event.kind] = plain(event);
  }
  return { turn, events };
}

// Whether a reserved extension turn may still be issued or refused at `t`.
function extensionIssuable(context, t) {
  const { turn, events } = context;
  return !events.issue && !events.refusal && !events.finish && t < turn.issue_by;
}

/**
 * The `withinDecision` hook of a provider follow-up's continuation of `predecessorId` for the
 * reserved turn `intentId`. On a win it checks the reservation (no issue, refusal or finish,
 * before `issue_by`), the exact predecessor and tip, the successor's predecessor, the release of
 * the predecessor's execution (else `release-wait`) and, on an unforced call, that no force is now
 * needed (else `force-required`); then it records the issue with the successor's job id and, on a
 * forced call, COL's force JSON in `code`. On a loss to a successor it records the refusal
 * `foreign successor <jobId>` while the turn is still issuable.
 */
export function extensionDecisionHook({ intentId, predecessorId, force = false, reasons = [] } = {}) {
  return (db, { won, successorId, tipId }) => {
    const context = extensionTurnContext(db, intentId);
    if (!won) {
      if (!successorId || !context) {
        return;
      }
      const { t } = sampleTimes(context.turn.run_clock);
      if (extensionIssuable(context, t)) {
        db.prepare("INSERT INTO council_ext_events (turn_id, kind, at, reason) VALUES (?, 'refusal', ?, ?)").run(intentId, t, `foreign successor ${successorId}`);
        writeClock(db, context.turn.run_id, t);
      }
      return;
    }
    if (!context) {
      throw new CouncilFenceError("stale-attempt");
    }
    const { t } = sampleTimes(context.turn.run_clock);
    if (context.turn.predecessor_id !== predecessorId || tipId !== predecessorId || !extensionIssuable(context, t)) {
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
    db.prepare("INSERT INTO council_ext_events (turn_id, kind, at, job_id, code) VALUES (?, 'issue', ?, ?, ?)").run(intentId, t, successorId, forceReason);
    writeClock(db, context.turn.run_id, t);
  };
}

/**
 * The `withinStop` hook of the exact stop request for an extension turn's job (P3): when the
 * request selected `jobId` and the turn's stop is still unacknowledged, it records the
 * acknowledgement, `council` when the job had no earlier cancel request and had not ended, else
 * `foreign`, with `event_at` the commit wall time and `at` the council time. With the job not
 * selected it records `ineligible` when the job is absent or no longer selectable, and throws
 * CouncilStopSelectionError (rolling the request back) when an eligible job was left out.
 */
export function extensionStopHook({ intentId, jobId } = {}) {
  return (db, { commitWall, selection }) => {
    const context = extensionTurnContext(db, intentId);
    if (!context || !context.events.stop || context.events.ack) {
      return;
    }
    const t = Math.max(context.turn.run_clock, commitWall);
    const entry = (selection ?? []).find((item) => item.jobId === jobId);
    if (entry) {
      const code = !entry.hadCancelRequest && !entry.wasEnded ? "council" : "foreign";
      db.prepare("INSERT INTO council_ext_events (turn_id, kind, at, event_at, code) VALUES (?, 'ack', ?, ?, ?)").run(intentId, t, commitWall, code);
    } else {
      if (stopEligible(db, plain(db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId)))) {
        throw new CouncilStopSelectionError();
      }
      db.prepare("INSERT INTO council_ext_events (turn_id, kind, at, code) VALUES (?, 'ack', ?, 'ineligible')").run(intentId, t);
    }
    writeClock(db, context.turn.run_id, t);
  };
}

/**
 * Records the exact refusal of a reserved extension turn (no issue, refusal or finish yet, before
 * its `issue_by`); the reducer settles it (X1). Resolves to `{ ok: true }` or
 * `{ ok: false, reason: "stale-turn" }`.
 */
export async function depositExtensionRefusal(store, { intentId, reason, deadline } = {}) {
  if (typeof reason !== "string" || reason === "") {
    throw new TypeError("A council extension refusal needs a reason.");
  }
  return transact(store, deadline, (db) => {
    const context = extensionTurnContext(db, intentId);
    if (!context) {
      return { ok: false, reason: "stale-turn" };
    }
    const { t } = sampleTimes(context.turn.run_clock);
    if (!extensionIssuable(context, t)) {
      return { ok: false, reason: "stale-turn" };
    }
    db.prepare("INSERT INTO council_ext_events (turn_id, kind, at, reason) VALUES (?, 'refusal', ?, ?)").run(intentId, t, reason);
    writeClock(db, context.turn.run_id, t);
    return { ok: true };
  });
}

/**
 * Records the classified outcome of the exact job issued for a provider extension turn as its
 * deposit, also after the turn finished (then `after_close` is 1 and the deposit is historical).
 * Checks the binding, then an earlier deposit. `verdict` is `{ outcome, eventAt, answerSha256,
 * errorsSha256, reason }`, `outcome` one of `valid`, `invalid`, `late`, `cancelled`, `quota`,
 * `failure`, `missing`; `eventAt` is the job's end time, unused for `missing`. Resolves to
 * `{ ok: true }` or `{ ok: false, reason }` (`binding-mismatch`, `duplicate-observation`).
 */
export async function depositExtensionObservation(store, { intentId, jobId, verdict, deadline } = {}) {
  if (!verdict || !OBSERVATION_OUTCOMES.has(verdict.outcome)) {
    throw new TypeError("A council extension observation needs a known outcome.");
  }
  const valid = verdict.outcome === "valid";
  if (valid ? !isDigest(verdict.answerSha256) : typeof verdict.reason !== "string" || verdict.reason === "") {
    throw new TypeError("A council extension observation needs a valid answer digest or a reason.");
  }
  if (verdict.outcome !== "missing" && !Number.isInteger(verdict.eventAt)) {
    throw new TypeError("A council extension observation needs the job's end time as eventAt.");
  }
  return transact(store, deadline, (db) => {
    const context = extensionTurnContext(db, intentId);
    if (!context || !context.events.issue || context.events.issue.job_id === null || context.events.issue.job_id !== jobId) {
      return { ok: false, reason: "binding-mismatch" };
    }
    if (context.events.deposit) {
      return { ok: false, reason: "duplicate-observation" };
    }
    const { t } = sampleTimes(context.turn.run_clock);
    db.prepare("INSERT INTO council_ext_events (turn_id, kind, at, event_at, code, reason, digest, after_close) VALUES (?, 'deposit', ?, ?, ?, ?, ?, ?)").run(
      intentId,
      t,
      verdict.outcome === "missing" ? null : verdict.eventAt,
      verdict.outcome,
      valid ? null : verdict.reason,
      valid ? verdict.answerSha256 : (verdict.errorsSha256 ?? null),
      context.events.finish ? 1 : 0
    );
    writeClock(db, context.turn.run_id, t);
    return { ok: true };
  });
}

// The counts an opening for `seat` is limited by, read in the caller's transaction: the
// follow-ups the seat and the run opened, the member turns used (issued core turns and extension
// issues) and the live follow-up reservations.
function followupCounts(db, runId, seat) {
  const turns = db.prepare("SELECT id, seat FROM council_ext_turns WHERE run_id = ? AND kind = 'followup'").all(runId);
  const kinds = (turnId) => new Set(db.prepare("SELECT kind FROM council_ext_events WHERE turn_id = ?").all(turnId).map((row) => row.kind));
  let live = 0;
  let open = false;
  for (const turn of turns) {
    const events = kinds(turn.id);
    if (!events.has("finish")) {
      if (turn.seat === seat) {
        open = true;
      }
      if (!events.has("issue")) {
        live += 1;
      }
    }
  }
  const coreTurns = db.prepare("SELECT count(*) AS n FROM council_attempts WHERE run_id = ? AND charge = 'turn' AND issued_at IS NOT NULL").get(runId).n;
  const extIssues = db
    .prepare("SELECT count(*) AS n FROM council_ext_events AS e JOIN council_ext_turns AS x ON x.id = e.turn_id WHERE x.run_id = ? AND e.kind = 'issue'")
    .get(runId).n;
  return { open, seatCount: turns.filter((turn) => turn.seat === seat).length, runCount: turns.length, used: coreTurns + extIssues, live };
}

/**
 * The counts that limit a follow-up for `seat` now, from one read: `{ open, seatCount, runCount,
 * used, live, cap }`; null for an unknown run.
 */
export function readFollowupCounts(store, { runId, seat }, opts = {}) {
  return store.read((db) => {
    const run = db.prepare("SELECT turn_cap FROM council_runs WHERE id = ?").get(runId);
    return run ? { ...followupCounts(db, runId, seat), cap: run.turn_cap } : null;
  }, opts);
}

/**
 * Opens a follow-up in one transaction, after the command's checks of seat, target and prepared
 * prompt: deposits the request and records its result, allocates the next run ordinal and inserts
 * the turn with `issue_by = t + T`; a Claude turn (`predecessorId` null) is issued, and charged,
 * at once, a provider turn is a reservation on `predecessorId`. Checks again, in the refusal
 * order, a successful closed Round 2, the merge token (`mergeSha256` is the run's merge and
 * `merge_rev = input_rev = inputRev`), an open follow-up of the seat, then the limits. Resolves to
 * `{ ok: true, ordinal, issueBy }` or `{ ok: false, reason, limits? }` (`unknown-run`,
 * `round-2-not-successful`, `stale-merge`, `followup-open`, or a limit code with `limits`).
 */
export async function admitFollowup(store, { runId, seat, turnId, requestId, target, question, promptSha256, predecessorId = null, mergeSha256, inputRev, deadline } = {}) {
  if (!ATTEMPT_ID.test(String(turnId)) || !ATTEMPT_ID.test(String(requestId)) || !isDigest(promptSha256) || !isDigest(mergeSha256)) {
    throw new TypeError("A council follow-up needs a turn id, a request id, its prompt digest and the merge digest.");
  }
  return transact(store, deadline, (db) => {
    const run = plain(db.prepare("SELECT * FROM council_runs WHERE id = ?").get(runId));
    if (!run) {
      return { ok: false, reason: "unknown-run" };
    }
    const round2 = db.prepare("SELECT * FROM council_rounds WHERE run_id = ? AND round = 2").get(runId);
    if (run.failed_at !== null || !round2 || round2.closed_at === null || round2.quorum !== 1) {
      return { ok: false, reason: "round-2-not-successful" };
    }
    if (run.merge_sha256 !== mergeSha256 || run.merge_rev !== inputRev || run.input_rev !== inputRev) {
      return { ok: false, reason: "stale-merge" };
    }
    const counts = followupCounts(db, runId, seat);
    if (counts.open) {
      return { ok: false, reason: "followup-open" };
    }
    const limits = followupLimits({ seat, ...counts, cap: run.turn_cap });
    if (limits.length > 0) {
      return { ok: false, reason: limits[0].error, limits };
    }
    const { t } = sampleTimes(run.clock);
    const ordinal = db.prepare("SELECT coalesce(max(ordinal), 0) + 1 AS n FROM council_ext_turns WHERE run_id = ?").get(runId).n;
    const payload = { seat, target, question, turnId, promptSha256, mergeSha256, inputRev };
    db.prepare("INSERT INTO council_ext_requests (id, run_id, kind, at, payload) VALUES (?, ?, 'followup', ?, ?)").run(requestId, runId, t, JSON.stringify(payload));
    db.prepare(
      `INSERT INTO council_ext_turns (id, run_id, seat, kind, ordinal, created_at, issue_by, prompt_sha256, predecessor_id, target, question, merge_sha256, input_rev)
       VALUES (?, ?, ?, 'followup', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(turnId, runId, seat, ordinal, t, t + run.timeout_ms, promptSha256, predecessorId, target, question, mergeSha256, inputRev);
    if (predecessorId === null) {
      db.prepare("INSERT INTO council_ext_events (turn_id, kind, at) VALUES (?, 'issue', ?)").run(turnId, t);
    }
    db.prepare("UPDATE council_ext_requests SET result = ? WHERE id = ?").run(JSON.stringify({ turnId, ordinal }), requestId);
    writeClock(db, runId, t);
    return { ok: true, ordinal, issueBy: t + run.timeout_ms };
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
 * `carries` are `{ seat, turnId, promptSha256 }`, exactly one per Round 1 stand-in whose answer
 * was valid: after the ordinary seat rounds, each gets a `carry` turn issued at seeding with its
 * own reply bound (a stand-in that answered Round 1 also answers Round 2 for that seat).
 */
export async function startRound2(store, { runId, mapSha256, entries, carries = [], layer = 0, deadline } = {}) {
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
    // The Round 1 stand-ins whose answers were valid: each is carried, exactly once.
    const carried = db
      .prepare(
        `SELECT x.seat AS seat FROM council_ext_turns AS x
         JOIN council_ext_events AS f ON f.turn_id = x.id AND f.kind = 'finish' AND f.code = 'valid'
         WHERE x.run_id = ? AND x.round = 1 AND x.kind = 'substitute' ORDER BY x.seat`
      )
      .all(runId)
      .map((row) => row.seat);
    const carrySeats = (carries ?? []).map((carry) => carry?.seat);
    if (
      carrySeats.length !== carried.length ||
      carried.some((seat) => !carrySeats.includes(seat)) ||
      (carries ?? []).some((carry) => typeof carry.turnId !== "string" || !ATTEMPT_ID.test(carry.turnId) || !isDigest(carry.promptSha256))
    ) {
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
    for (const carry of carries ?? []) {
      db.prepare(
        "INSERT INTO council_ext_turns (id, run_id, seat, kind, round, created_at, issue_by, prompt_sha256) VALUES (?, ?, ?, 'carry', 2, ?, ?, ?)"
      ).run(carry.turnId, runId, carry.seat, t, t + run.timeout_ms, carry.promptSha256);
      db.prepare("INSERT INTO council_ext_events (turn_id, kind, at) VALUES (?, 'issue', ?)").run(carry.turnId, t);
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

// The extension part of the reducer's view of one round: the round's substitute and carry turns
// and their events, the round's substitution decision, whether an opt-in request exists, the
// member turns used by the run (issued core turns and extension issues) and its cap, and the
// caller's options (`extensions`, `consent`, `prepared`, `freshTurnIds`).
function readRoundExtension(db, run, round, { extensions = {}, consent = null, prepared = {}, freshTurnIds = [] } = {}) {
  const turns = db.prepare("SELECT * FROM council_ext_turns WHERE run_id = ? AND round = ? ORDER BY created_at, id").all(run.id, round).map(plain);
  const events = db
    .prepare(
      `SELECT e.* FROM council_ext_events AS e JOIN council_ext_turns AS x ON x.id = e.turn_id
       WHERE x.run_id = ? AND x.round = ? ORDER BY x.created_at, x.id, e.at, e.kind`
    )
    .all(run.id, round)
    .map(plain);
  const decision = db.prepare("SELECT decision FROM council_ext_decisions WHERE run_id = ? AND kind = 'substitution' AND scope = ?").get(run.id, round)?.decision ?? null;
  const optIn = Boolean(
    db
      .prepare(
        `SELECT 1 FROM council_ext_requests WHERE run_id = ? AND kind = 'collect'
           AND json_extract(payload, '$.round') = ? AND json_extract(payload, '$.substitution') = 'allow'`
      )
      .get(run.id, round)
  );
  const coreTurns = db.prepare("SELECT count(*) AS n FROM council_attempts WHERE run_id = ? AND charge = 'turn' AND issued_at IS NOT NULL").get(run.id).n;
  const extIssues = db
    .prepare("SELECT count(*) AS n FROM council_ext_events AS e JOIN council_ext_turns AS x ON x.id = e.turn_id WHERE x.run_id = ? AND e.kind = 'issue'")
    .get(run.id).n;
  return {
    enabled: Boolean(extensions.substitution),
    turns,
    events,
    decision,
    optIn,
    consent,
    prepared,
    freshTurnIds,
    used: coreTurns + extIssues,
    cap: run.turn_cap,
    timeoutMs: run.timeout_ms
  };
}

// The reducer's view of one round, read in the caller's transaction.
function readRoundView(db, run, roundRow, freshIds, extOptions = {}) {
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
    freshIds,
    ext: readRoundExtension(db, run, round, extOptions)
  };
}

// Records the result of every collect request of a round that has none yet.
function finalizeRequests(db, runId, round, result) {
  db.prepare(
    `UPDATE council_ext_requests SET result = ? WHERE run_id = ? AND kind = 'collect' AND result IS NULL
       AND json_extract(payload, '$.round') = ?`
  ).run(JSON.stringify(result), runId, round);
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
    case "replace": {
      // Retire the old attempt, insert its replacement, then switch the seat's current attempt.
      const prompt = write.kind === "prompt";
      db.prepare("UPDATE council_attempts SET retired_at = ? WHERE id = ? AND retired_at IS NULL").run(t, write.replacesId);
      db.prepare(
        `INSERT INTO council_attempts (id, run_id, round, seat, charge, replaces_id, kind, created_at, issue_by, prompt_sha256,
           retry_prompt_sha256, predecessor_id, issued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        write.attemptId,
        runId,
        round,
        write.seat,
        write.charge,
        write.replacesId,
        write.kind,
        t,
        t + view.run.timeout_ms,
        write.promptSha256,
        write.retryPromptSha256 ?? null,
        write.predecessorId ?? null,
        prompt ? t : null
      );
      db.prepare("UPDATE council_seat_rounds SET state = ?, current_id = ? WHERE run_id = ? AND round = ? AND seat = ? AND current_id = ?").run(
        prompt ? "running" : "issuing",
        write.attemptId,
        runId,
        round,
        write.seat,
        write.replacesId
      );
      return;
    }
    case "seal":
      // Set once: the round's trigger refuses any later change of a set cutoff.
      db.prepare("UPDATE council_rounds SET quorum_at = ?, cutoff_at = ? WHERE run_id = ? AND round = ? AND cutoff_at IS NULL").run(
        write.quorumAt,
        write.cutoffAt,
        runId,
        round
      );
      return;
    case "ext-finish":
      db.prepare("INSERT INTO council_ext_events (turn_id, kind, at, code, reason) VALUES (?, 'finish', ?, ?, ?)").run(write.turnId, t, write.state, write.reason);
      if (write.state === "valid") {
        db.prepare("UPDATE council_runs SET input_rev = input_rev + 1 WHERE id = ?").run(runId);
      }
      return;
    case "ext-decision": {
      db.prepare("INSERT INTO council_ext_decisions (run_id, kind, scope, at, decision) VALUES (?, 'substitution', ?, ?, ?)").run(runId, write.round, t, write.decision);
      finalizeRequests(db, runId, write.round, { decision: write.decision });
      return;
    }
    case "ext-turn":
      // A Claude turn is issued, and charged, with its admission.
      db.prepare(
        "INSERT INTO council_ext_turns (id, run_id, seat, kind, round, created_at, issue_by, prompt_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(write.turnId, runId, write.seat, write.kind, write.round, t, write.issueBy, write.promptSha256);
      db.prepare("INSERT INTO council_ext_events (turn_id, kind, at) VALUES (?, 'issue', ?)").run(write.turnId, t);
      return;
    case "close": {
      const decision = db.prepare("SELECT decision FROM council_ext_decisions WHERE run_id = ? AND kind = 'substitution' AND scope = ?").get(runId, round)?.decision ?? null;
      finalizeRequests(db, runId, round, { decision });
      db.prepare("UPDATE council_rounds SET closed_at = ?, quorum = ? WHERE run_id = ? AND round = ?").run(t, write.quorum, runId, round);
      db.prepare("UPDATE council_runs SET input_rev = input_rev + 1 WHERE id = ?").run(runId);
      if (write.quorum === 0) {
        db.prepare("UPDATE council_runs SET failed_at = ? WHERE id = ? AND failed_at IS NULL").run(t, runId);
      }
      return;
    }
    default:
      throw new TypeError(`Unknown council write: ${write.op}`);
  }
}

/**
 * Records the merge object `mergeSha256` computed from the inputs at `inputRev`, when Round 2 is
 * closed with quorum, the run has not failed and `input_rev` is still `inputRev`: sets
 * `merge_sha256` and `merge_rev`. Resolves to `{ ok: true }` or `{ ok: false, reason }`
 * (`unknown-run`, `not-mergeable`, `stale-input`).
 */
export async function recordMerge(store, { runId, mergeSha256, inputRev, deadline } = {}) {
  if (!isDigest(mergeSha256) || !Number.isInteger(inputRev)) {
    throw new TypeError("A council merge needs its digest and input revision.");
  }
  return transact(store, deadline, (db) => {
    const run = plain(db.prepare("SELECT * FROM council_runs WHERE id = ?").get(runId));
    if (!run) {
      return { ok: false, reason: "unknown-run" };
    }
    const round2 = db.prepare("SELECT * FROM council_rounds WHERE run_id = ? AND round = 2").get(runId);
    if (run.failed_at !== null || !round2 || round2.closed_at === null || round2.quorum !== 1) {
      return { ok: false, reason: "not-mergeable" };
    }
    if (run.input_rev !== inputRev) {
      return { ok: false, reason: "stale-input" };
    }
    db.prepare("UPDATE council_runs SET merge_sha256 = ?, merge_rev = ? WHERE id = ?").run(mergeSha256, inputRev, runId);
    return { ok: true };
  });
}

/**
 * Records the leader's verdict on a cluster (`targetKind` `cluster`, `target` its sorted finding
 * ids, valid only while `merge_sha256 = mergeSha256` and `merge_rev = input_rev = inputRev`) or on
 * a brief claim (`claim`, valid only while `brief_sha256 = briefSha256`), replacing an earlier
 * verdict on the same target and raising `verdict_rev`. Resolves to `{ ok: true }` or
 * `{ ok: false, reason }` (`unknown-run`, `stale-merge`, `stale-brief`).
 */
export async function recordVerdict(
  store,
  { runId, targetKind, target, clusterId = null, verdict, reason = null, strongest = null, strongestSha256 = null, mergeSha256 = null, inputRev = null, briefSha256 = null, deadline } = {}
) {
  return transact(store, deadline, (db) => {
    const run = plain(db.prepare("SELECT * FROM council_runs WHERE id = ?").get(runId));
    if (!run) {
      return { ok: false, reason: "unknown-run" };
    }
    const cluster = targetKind === "cluster";
    if (cluster && (run.merge_sha256 !== mergeSha256 || run.merge_rev !== inputRev || run.input_rev !== inputRev)) {
      return { ok: false, reason: "stale-merge" };
    }
    if (!cluster && run.brief_sha256 !== briefSha256) {
      return { ok: false, reason: "stale-brief" };
    }
    const { t } = sampleTimes(run.clock);
    db.prepare(
      `INSERT INTO council_verdicts (run_id, target_kind, target, cluster_id, merge_sha256, input_rev, brief_sha256, verdict, reason,
         strongest, strongest_sha256, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, target_kind, target) DO UPDATE SET cluster_id = excluded.cluster_id, merge_sha256 = excluded.merge_sha256,
         input_rev = excluded.input_rev, brief_sha256 = excluded.brief_sha256, verdict = excluded.verdict, reason = excluded.reason,
         strongest = excluded.strongest, strongest_sha256 = excluded.strongest_sha256, recorded_at = excluded.recorded_at`
    ).run(
      runId,
      targetKind,
      target,
      cluster ? clusterId : null,
      cluster ? mergeSha256 : null,
      cluster ? inputRev : null,
      cluster ? null : briefSha256,
      verdict,
      reason,
      strongest,
      strongestSha256,
      t
    );
    db.prepare("UPDATE council_runs SET verdict_rev = verdict_rev + 1 WHERE id = ?").run(runId);
    writeClock(db, runId, t);
    return { ok: true };
  });
}

/**
 * Records the report object `reportSha256` rendered at `inputRev` and `verdictRev`, while both
 * revisions are current: outcome `failed` needs a failed run; outcome `council` needs the merge at
 * `inputRev` and a verdict at `inputRev` for every cluster target in `requiredTargets`; no
 * follow-up may be open. Resolves to `{ ok: true }` or `{ ok: false, reason }` (`unknown-run`,
 * `stale`, `followup-open`, `not-reportable`).
 */
export async function recordReport(store, { runId, reportSha256, outcome, inputRev, verdictRev, requiredTargets = [], deadline } = {}) {
  if (!isDigest(reportSha256) || (outcome !== "council" && outcome !== "failed")) {
    throw new TypeError("A council report needs its digest and outcome.");
  }
  return transact(store, deadline, (db) => {
    const run = plain(db.prepare("SELECT * FROM council_runs WHERE id = ?").get(runId));
    if (!run) {
      return { ok: false, reason: "unknown-run" };
    }
    if (run.input_rev !== inputRev || run.verdict_rev !== verdictRev) {
      return { ok: false, reason: "stale" };
    }
    const openFollowup = db
      .prepare(
        `SELECT 1 FROM council_ext_turns AS x WHERE x.run_id = ? AND x.kind = 'followup'
           AND NOT EXISTS (SELECT 1 FROM council_ext_events WHERE turn_id = x.id AND kind = 'finish')`
      )
      .get(runId);
    if (openFollowup) {
      return { ok: false, reason: "followup-open" };
    }
    if (outcome === "failed" ? run.failed_at === null : run.merge_rev !== inputRev) {
      return { ok: false, reason: "not-reportable" };
    }
    if (outcome === "council") {
      const verdictAt = db.prepare("SELECT 1 FROM council_verdicts WHERE run_id = ? AND target_kind = 'cluster' AND target = ? AND input_rev = ?");
      if (requiredTargets.some((target) => !verdictAt.get(runId, target, inputRev))) {
        return { ok: false, reason: "not-reportable" };
      }
    }
    db.prepare("UPDATE council_runs SET report_sha256 = ?, report_outcome = ?, report_input_rev = ?, report_verdict_rev = ? WHERE id = ?").run(
      reportSha256,
      outcome,
      inputRev,
      verdictRev,
      runId
    );
    return { ok: true };
  });
}

/**
 * What reducing one round would do now, from one read snapshot and no write: `{ writes, nextDue }`
 * of `reduceRound` at a raw wall sample and the council time, or null for an unknown run or an
 * unstarted round. A collector skips the write transaction when `writes` is empty.
 */
export function peekRound(store, { runId, round, layer = 0, extensions = {}, consent = null, prepared = {} }, opts = {}) {
  return store.read((db) => {
    const run = plain(db.prepare("SELECT * FROM council_runs WHERE id = ?").get(runId));
    const roundRow = run ? plain(db.prepare("SELECT * FROM council_rounds WHERE run_id = ? AND round = ?").get(runId, round)) : null;
    if (!roundRow) {
      return null;
    }
    const view = readRoundView(db, run, roundRow, [], { extensions, consent, prepared, freshTurnIds: [] });
    const { w, t } = sampleTimes(run.clock);
    return reduceRound(view, { w, t, layer });
  }, opts);
}

/**
 * Reduces one round in one transaction: reads the round's rows and exact jobs, takes one raw wall
 * sample and the council time, applies the rows of `reduceRound` in order and writes the clock.
 * Resolves to `{ ok: true, changed, closed }` (`changed` when any row other than the clock was
 * written, `closed` when the round is closed afterwards) or `{ ok: false, reason }` (`unknown-run`,
 * `round-not-started`).
 * The extension rows run in the same transaction: X1 to X4 and S3 on the round's extension turns,
 * then the substitution gate before B9. `extensions` is the shipped flags object; `consent` is
 * `"disallow"` for a collect that declines stand-ins, else null; `prepared` maps a candidate seat
 * to its installed stand-in prompt digest (a candidate without one holds the decision).
 * Every reduction also applies X1 to X8 to the run's follow-up turns (`followupWrites`).
 */
export async function reduceRun(store, { runId, round, layer = 0, extensions = {}, consent = null, prepared = {}, deadline } = {}) {
  const seatCount = 5;
  const freshIds = Array.from({ length: seatCount * 2 }, () => randomBytes(16).toString("hex"));
  const freshTurnIds = Array.from({ length: seatCount }, () => randomBytes(16).toString("hex"));
  return transact(store, deadline, (db) => {
    const run = plain(db.prepare("SELECT * FROM council_runs WHERE id = ?").get(runId));
    if (!run) {
      return { ok: false, reason: "unknown-run" };
    }
    const roundRow = plain(db.prepare("SELECT * FROM council_rounds WHERE run_id = ? AND round = ?").get(runId, round));
    if (!roundRow) {
      return { ok: false, reason: "round-not-started" };
    }
    const view = readRoundView(db, run, roundRow, freshIds.slice(0, run.seat_count * 2), { extensions, consent, prepared, freshTurnIds });
    const { w, t } = sampleTimes(run.clock);
    const { writes } = reduceRound(view, { w, t, layer });
    for (const write of writes) {
      applyWrite(db, view, write, t);
    }
    // The run's follow-up turns settle in every reduction, whatever its round.
    const followups = readFollowupView(db, runId);
    const extWrites = followupWrites(followups.turns, followups.events, { t, w, timeoutMs: run.timeout_ms, jobs: followups.jobs });
    for (const write of extWrites) {
      applyFollowupWrite(db, runId, write, t);
    }
    writeClock(db, runId, t);
    const closed = roundRow.closed_at !== null || writes.some((write) => write.op === "close");
    return { ok: true, changed: writes.length + extWrites.length > 0, closed };
  });
}

// The run's follow-up turns, their events and the exact rows of their issued jobs.
function readFollowupView(db, runId) {
  const turns = db.prepare("SELECT * FROM council_ext_turns WHERE run_id = ? AND kind = 'followup' ORDER BY created_at, id").all(runId).map(plain);
  if (turns.length === 0) {
    return { turns, events: [], jobs: {} };
  }
  const events = db
    .prepare(
      `SELECT e.* FROM council_ext_events AS e JOIN council_ext_turns AS x ON x.id = e.turn_id
       WHERE x.run_id = ? AND x.kind = 'followup' ORDER BY x.created_at, x.id, e.at, e.kind`
    )
    .all(runId)
    .map(plain);
  const jobs = {};
  for (const event of events) {
    if (event.kind === "issue" && event.job_id) {
      const job = db.prepare(EXACT_JOB_SQL).get({ exactJobId: event.job_id });
      if (job) {
        jobs[event.job_id] = plain(job);
      }
    }
  }
  return { turns, events, jobs };
}

// A follow-up write: a finish (every follow-up finish raises the input revision once) or a stop.
function applyFollowupWrite(db, runId, write, t) {
  if (write.op === "ext-finish") {
    db.prepare("INSERT INTO council_ext_events (turn_id, kind, at, code, reason) VALUES (?, 'finish', ?, ?, ?)").run(write.turnId, t, write.state, write.reason);
    db.prepare("UPDATE council_runs SET input_rev = input_rev + 1 WHERE id = ?").run(runId);
    return;
  }
  if (write.op === "ext-stop") {
    db.prepare("INSERT INTO council_ext_events (turn_id, kind, at, code) VALUES (?, 'stop', ?, ?)").run(write.turnId, t, write.code);
    return;
  }
  throw new TypeError(`Unknown council follow-up write: ${write.op}`);
}
