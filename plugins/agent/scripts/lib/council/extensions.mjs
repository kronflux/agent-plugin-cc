// The council extension writers outside the reducer: request facts in the inbox and Claude
// receipts for extension turns. Neither writer settles a turn or decides anything; `reduceRun`
// applies every outcome in its own transaction.
import { randomBytes } from "node:crypto";

import { wallNow, withRetry } from "../store.mjs";

const TURN_ID = /^[0-9a-f]{32}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const REQUEST_KINDS = new Set(["followup", "collect", "crossexam"]);

function transact(store, deadline, fn) {
  return withRetry((opts) => store.transact(fn, opts), "command", { deadline });
}

// The council time of a transaction: the run clock never goes back.
function councilTime(clock) {
  return Math.max(clock, wallNow());
}

function writeClock(db, runId, t) {
  db.prepare("UPDATE council_runs SET clock = max(clock, ?) WHERE id = ?").run(t, runId);
}

function isDigest(value) {
  return typeof value === "string" && DIGEST.test(value);
}

/**
 * Deposits one request fact in the extension inbox at the council time; the reducer finalizes its
 * result once. `payload` is a plain object. An existing id is returned as `{ ok: true, duplicate:
 * true }` with nothing written. Resolves to `{ ok: true, duplicate }` or `{ ok: false, reason:
 * "unknown-run" }`.
 */
export async function depositExtensionRequest(store, { id, runId, kind, payload, deadline } = {}) {
  if (typeof id !== "string" || !TURN_ID.test(id) || !REQUEST_KINDS.has(kind) || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("A council extension request needs a 32-hex id, a kind and an object payload.");
  }
  return transact(store, deadline, (db) => {
    const run = db.prepare("SELECT clock FROM council_runs WHERE id = ?").get(runId);
    if (!run) {
      return { ok: false, reason: "unknown-run" };
    }
    if (db.prepare("SELECT 1 FROM council_ext_requests WHERE id = ?").get(id)) {
      return { ok: true, duplicate: true };
    }
    const t = councilTime(run.clock);
    db.prepare("INSERT INTO council_ext_requests (id, run_id, kind, at, payload) VALUES (?, ?, ?, ?, ?)").run(id, runId, kind, t, JSON.stringify(payload));
    writeClock(db, runId, t);
    return { ok: true, duplicate: false };
  });
}

/**
 * Records the consent of a collect on an open round to Claude stand-ins: a `collect` request
 * `{ round, substitution: "allow" }`, deposited once per round and only while the round is open
 * and has no substitution decision. Resolves to `{ ok: true, deposited }` or `{ ok: false,
 * reason }` (`unknown-run`, `round-not-started`).
 */
export async function depositSubstitutionOptIn(store, { runId, round, deadline } = {}) {
  const id = randomBytes(16).toString("hex");
  return transact(store, deadline, (db) => {
    const run = db.prepare("SELECT clock FROM council_runs WHERE id = ?").get(runId);
    if (!run) {
      return { ok: false, reason: "unknown-run" };
    }
    const roundRow = db.prepare("SELECT closed_at FROM council_rounds WHERE run_id = ? AND round = ?").get(runId, round);
    if (!roundRow) {
      return { ok: false, reason: "round-not-started" };
    }
    const decided = db.prepare("SELECT 1 FROM council_ext_decisions WHERE run_id = ? AND kind = 'substitution' AND scope = ?").get(runId, round);
    const existing = db
      .prepare(
        `SELECT 1 FROM council_ext_requests WHERE run_id = ? AND kind = 'collect'
           AND json_extract(payload, '$.round') = ? AND json_extract(payload, '$.substitution') = 'allow'`
      )
      .get(runId, round);
    if (roundRow.closed_at !== null || decided || existing) {
      return { ok: true, deposited: false };
    }
    const t = councilTime(run.clock);
    db.prepare("INSERT INTO council_ext_requests (id, run_id, kind, at, payload) VALUES (?, ?, 'collect', ?, ?)").run(id, runId, t, JSON.stringify({ round, substitution: "allow" }));
    writeClock(db, runId, t);
    return { ok: true, deposited: true };
  });
}

/**
 * Records the validated reply to an issued Claude extension turn (a stand-in or a carry) as its
 * deposit. Checks, in order, the run, the turn's identity (run, seat, the expected `round` when
 * given, an issued Claude turn), an earlier deposit, then the open turn (no finish, open round,
 * receipt time before `issue_by`, and for a carry before a sealed round's cutoff). The deposit
 * stores `event_at = at = t`, the outcome and the answer (or errors) digest. `verdict` is
 * `{ outcome: "valid" | "invalid", answerSha256, errorsSha256, reason }`. Resolves to
 * `{ ok: true, round }` or `{ ok: false, reason, round? }` (`unknown-run`, `intent-not-open`,
 * `duplicate-receipt`).
 */
export async function depositExtensionReceipt(store, { runId, seat, round = null, intentId, verdict, deadline } = {}) {
  if (!verdict || (verdict.outcome !== "valid" && verdict.outcome !== "invalid")) {
    throw new TypeError("A council extension receipt needs a valid or invalid outcome.");
  }
  if (verdict.outcome === "valid" ? !isDigest(verdict.answerSha256) : verdict.errorsSha256 != null && !isDigest(verdict.errorsSha256)) {
    throw new TypeError("A council extension receipt has an invalid digest.");
  }
  return transact(store, deadline, (db) => {
    const run = db.prepare("SELECT clock FROM council_runs WHERE id = ?").get(runId);
    if (!run) {
      return { ok: false, reason: "unknown-run" };
    }
    const turn = db.prepare("SELECT * FROM council_ext_turns WHERE id = ?").get(intentId);
    if (!turn || turn.run_id !== runId) {
      return { ok: false, reason: "intent-not-open" };
    }
    const turnRound = turn.round;
    const issue = db.prepare("SELECT * FROM council_ext_events WHERE turn_id = ? AND kind = 'issue'").get(intentId);
    if (turn.seat !== seat || (round !== null && turnRound !== round) || turn.kind === "followup" || !issue || issue.job_id !== null) {
      return { ok: false, reason: "intent-not-open", round: turnRound };
    }
    if (db.prepare("SELECT 1 FROM council_ext_events WHERE turn_id = ? AND kind = 'deposit'").get(intentId)) {
      return { ok: false, reason: "duplicate-receipt", round: turnRound };
    }
    const t = councilTime(run.clock);
    const roundRow = db.prepare("SELECT closed_at, cutoff_at FROM council_rounds WHERE run_id = ? AND round = ?").get(runId, turnRound);
    const finished = db.prepare("SELECT 1 FROM council_ext_events WHERE turn_id = ? AND kind = 'finish'").get(intentId);
    const cutOff = turn.kind === "carry" && roundRow.cutoff_at !== null && t >= roundRow.cutoff_at;
    if (finished || roundRow.closed_at !== null || t >= turn.issue_by || cutOff) {
      return { ok: false, reason: "intent-not-open", round: turnRound };
    }
    const valid = verdict.outcome === "valid";
    db.prepare("INSERT INTO council_ext_events (turn_id, kind, at, event_at, code, reason, digest) VALUES (?, 'deposit', ?, ?, ?, ?, ?)").run(
      intentId,
      t,
      t,
      verdict.outcome,
      valid ? null : (verdict.reason ?? "schema validation failed"),
      valid ? verdict.answerSha256 : (verdict.errorsSha256 ?? null)
    );
    writeClock(db, runId, t);
    return { ok: true, round: turnRound };
  });
}
