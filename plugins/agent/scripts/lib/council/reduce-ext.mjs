// The pure extension rows of the council: the shared lifecycle of an extension turn (X1 to X4 for
// a Claude turn, X5 to X8 for a provider follow-up), the carry cutoff (S3), the substitution
// decision and its batch (S1, S2), the closure gate (S4), the effective panel of a round and the
// limits of a follow-up. No I/O, clock or randomness: callers pass the rows and the council time.

/** The terminal states of an extension turn. */
export const EXT_FINAL_STATES = new Set(["valid", "invalid", "timed-out", "quota-exhausted", "error"]);

const ORIGINAL_FINAL_STATES = new Set(["valid", "invalid", "timed-out", "error", "missing-cli", "quota-exhausted"]);

/** The actor key of a stand-in for `seat` asked in council round `round`: `<seat>~r<round>`. */
export function actorKey(seat, round) {
  return `${seat}~r${round}`;
}

/** The actor key of an extension turn: a substitute `<seat>~r<round>`, a carry `<seat>~r1`. */
export function turnActor(turn) {
  return turn.kind === "carry" ? actorKey(turn.seat, 1) : actorKey(turn.seat, turn.round);
}

function byCreation(a, b) {
  return a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The events of each turn by kind: `Map(turnId -> { issue, refusal, deposit, stop, ack, finish })`. */
export function eventsByTurn(events) {
  const map = new Map();
  for (const event of events ?? []) {
    if (!map.has(event.turn_id)) {
      map.set(event.turn_id, {});
    }
    map.get(event.turn_id)[event.kind] = event;
  }
  return map;
}

/**
 * The state of one extension turn from its events: `reserved` (no issue or finish), `issued`
 * (issued, no finish), or the finish code; with `deposit` and `finish` events when present.
 */
export function turnState(turn, byTurn) {
  const events = byTurn.get(turn.id) ?? {};
  const state = events.finish ? events.finish.code : events.issue ? "issued" : "reserved";
  return { state, issue: events.issue ?? null, refusal: events.refusal ?? null, deposit: events.deposit ?? null, finish: events.finish ?? null };
}

/**
 * X1 to X4 and the carry cutoff (S3) over `turns`, in `(created_at, id)` order, at council time
 * `t`. A reserved turn finishes `error` from its exact refusal (X1) or at its issuance bound
 * (X2). An issued Claude turn (an issue with no job) finishes from its admitted deposit (X3),
 * else a carry at a due cutoff `cutoffAt` ends `timed-out`, `quorum cutoff` (S3), else at its
 * reply bound it ends `timed-out`, `reply deadline expired` (X4). An issued provider turn is not
 * settled here. Returns `{ op: "ext-finish", turnId, seat, round, kind, state, reason }` writes.
 */
export function lifecycleWrites(turns, events, { t, cutoffAt = null }) {
  const byTurn = eventsByTurn(events);
  const writes = [];
  for (const turn of [...(turns ?? [])].sort(byCreation)) {
    const { issue, refusal, deposit, finish } = turnState(turn, byTurn);
    if (finish) {
      continue;
    }
    let outcome = null;
    if (!issue) {
      if (refusal) {
        outcome = { state: "error", reason: refusal.reason };
      } else if (t >= turn.issue_by) {
        outcome = { state: "error", reason: "issuance deadline expired" };
      }
    } else if (issue.job_id === null) {
      if (deposit && deposit.after_close === 0) {
        outcome = deposit.code === "valid" ? { state: "valid", reason: null } : { state: "invalid", reason: deposit.reason ?? "schema validation failed" };
      } else if (turn.kind === "carry" && cutoffAt !== null && t >= cutoffAt) {
        outcome = { state: "timed-out", reason: "quorum cutoff" };
      } else if (t >= turn.issue_by) {
        outcome = { state: "timed-out", reason: "reply deadline expired" };
      }
    }
    if (outcome) {
      writes.push({ op: "ext-finish", turnId: turn.id, seat: turn.seat, round: turn.round, kind: turn.kind, state: outcome.state, reason: outcome.reason });
    }
  }
  return writes;
}

/**
 * The seats of a round that may get a stand-in: original seat rounds that ended without a valid
 * answer and have no extension turn in that round, in seat order. `states` maps seat to its
 * current state (after the round's sweep).
 */
export function substitutionCandidates(seatRounds, states, roundTurns) {
  const taken = new Set((roundTurns ?? []).map((turn) => turn.seat));
  return [...seatRounds]
    .filter((row) => {
      const state = states.get(row.seat) ?? row.state;
      return ORIGINAL_FINAL_STATES.has(state) && state !== "valid" && !taken.has(row.seat);
    })
    .map((row) => row.seat)
    .sort();
}

/**
 * The extension part of one open round's reduction, after the collection sweep: X1 to X4 and S3
 * on the round's turns, then, once every original seat is final, the substitution decision (S1,
 * S2) and the closure gate (S4). `ext` is `{ enabled, turns, events, decision, optIn, consent,
 * prepared, freshTurnIds, used, cap, timeoutMs }` (turns and events of this round only);
 * `states` maps seat to state after the sweep; `seatRounds` are the round's original seat rounds.
 *
 * With candidates and no decision: with substitution enabled the round holds until a decision is
 * applied. An opt-in request (`optIn`) applies S2 once every candidate's prompt was looked at
 * (`prepared[seat]` is a digest, or null when it cannot be prepared) and every carry is terminal:
 * `accept` with one issued `substitute` turn per candidate with a prompt (reply bound `t + T`),
 * or `capacity` when the batch cannot fit the member-turn cap
 * (Round 1 also holds one future Round 2 slot per seat that can reach it). Without an opt-in, a
 * collect that declines (`consent: "disallow"`) applies `decline`. The round may close (`close`)
 * once every original seat is final, no undecided candidate holds it, and every extension turn of
 * the round is terminal. Returns `{ writes, close, turns, events }`, with the turns and events as
 * they are after the writes.
 */
export function extensionRows(ext, { t, round, states, seatRounds, cutoffAt = null, cutoffDue = false }) {
  const turns = [...(ext?.turns ?? [])];
  const events = [...(ext?.events ?? [])];
  const writes = [];
  for (const write of lifecycleWrites(turns, events, { t, cutoffAt: cutoffDue ? cutoffAt : null })) {
    writes.push(write);
    events.push({ turn_id: write.turnId, kind: "finish", at: t, code: write.state, reason: write.reason });
  }
  const settled = seatRounds.every((row) => ORIGINAL_FINAL_STATES.has(states.get(row.seat) ?? row.state));
  if (!settled) {
    return { writes, close: false, turns, events };
  }
  const byTurn = eventsByTurn(events);
  const terminal = (turn) => EXT_FINAL_STATES.has(turnState(turn, byTurn).state);
  const candidates = substitutionCandidates(seatRounds, states, turns);
  if (ext?.enabled && ext.decision === null && candidates.length > 0) {
    let decision = null;
    // The batch: candidates whose prompt is prepared. A prompt not looked at yet (undefined)
    // holds the decision; one that cannot be prepared (null) gives that seat no stand-in.
    const batch = candidates.filter((seat) => ext.prepared?.[seat]);
    if (ext.optIn) {
      const carriesSettled = turns.filter((turn) => turn.kind === "carry").every(terminal);
      if (!carriesSettled || candidates.some((seat) => ext.prepared?.[seat] === undefined)) {
        return { writes, close: false, turns, events };
      }
      const validOriginals = seatRounds.filter((row) => (states.get(row.seat) ?? row.state) === "valid").length;
      const heldRound2 = round === 1 ? validOriginals + batch.length : 0;
      decision = ext.used + batch.length + heldRound2 > ext.cap ? "capacity" : "accept";
    } else if (ext.consent === "disallow") {
      decision = "decline";
    } else {
      return { writes, close: false, turns, events };
    }
    writes.push({ op: "ext-decision", round, decision });
    if (decision === "accept") {
      batch.forEach((seat, index) => {
        const turn = { id: ext.freshTurnIds[index], seat, kind: "substitute", round, created_at: t, issue_by: t + ext.timeoutMs, prompt_sha256: ext.prepared[seat] };
        writes.push({ op: "ext-turn", turnId: turn.id, seat, round, kind: "substitute", promptSha256: turn.prompt_sha256, issueBy: turn.issue_by });
        turns.push(turn);
        events.push({ turn_id: turn.id, kind: "issue", at: t, job_id: null });
      });
    }
  }
  return { writes, close: turns.every(terminal), turns, events };
}

/**
 * The next deadline of a round's extension turns on the council axis, or none: the issuance or
 * reply bound of each turn that is not terminal and has no deposit. Returns `{ delayMs, axis,
 * source }` entries.
 */
export function extensionDeadlines(turns, events, t) {
  const byTurn = eventsByTurn(events);
  const due = [];
  for (const turn of turns ?? []) {
    const { state, deposit } = turnState(turn, byTurn);
    if (EXT_FINAL_STATES.has(state) || deposit) {
      continue;
    }
    due.push({ delayMs: Math.max(0, turn.issue_by - t), axis: "council", source: `${turnActor(turn)}:issue_by` });
  }
  return due;
}

/**
 * The effective panel of one round: per logical seat in seat order, its effective actor and
 * answer. A valid original answer comes first; otherwise a valid substitute or carry answers for
 * that seat. Each entry is `{ seat, actor, kind: "original"|"substitute"|"carry", family,
 * quorumFamily, valid, answerSha256, state }`; `family` is the author's family (`claude` for an
 * extension actor) and `quorumFamily` the seat's family only for a valid original (a stand-in
 * adds an answer, never a family). `snapshot` holds `seats`, `seatRounds` and `ext.turns` /
 * `ext.events`.
 */
export function effectivePanel(snapshot, round) {
  const seatFamily = new Map(snapshot.seats.map((row) => [row.seat, row.family]));
  const byTurn = eventsByTurn(snapshot.ext?.events ?? []);
  const turns = (snapshot.ext?.turns ?? []).filter((turn) => turn.round === round && (turn.kind === "substitute" || turn.kind === "carry"));
  const seats = new Set([...snapshot.seatRounds.filter((row) => row.round === round).map((row) => row.seat), ...turns.map((turn) => turn.seat)]);
  const entries = [];
  for (const seat of [...seats].sort()) {
    const original = snapshot.seatRounds.find((row) => row.round === round && row.seat === seat) ?? null;
    if (original && original.state === "valid") {
      entries.push({ seat, actor: seat, kind: "original", family: seatFamily.get(seat), quorumFamily: seatFamily.get(seat), valid: true, answerSha256: original.answer_sha256, state: "valid" });
      continue;
    }
    const turn = turns.find((entry) => entry.seat === seat) ?? null;
    if (turn) {
      const { state, deposit } = turnState(turn, byTurn);
      const valid = state === "valid";
      entries.push({ seat, actor: turnActor(turn), kind: turn.kind, family: "claude", quorumFamily: null, valid, answerSha256: valid ? deposit.digest : null, state });
      continue;
    }
    entries.push({ seat, actor: seat, kind: "original", family: seatFamily.get(seat), quorumFamily: null, valid: false, answerSha256: null, state: original?.state ?? null });
  }
  return entries;
}

/** The sorted quorum families of a panel: the families of its valid original actors. */
export function quorumFamilies(panel, sort = (families) => [...families].sort()) {
  return sort([...new Set(panel.filter((entry) => entry.valid && entry.quorumFamily).map((entry) => entry.quorumFamily))]);
}

// ---------------------------------------------------------------------------------------------
// Follow-ups (E1): the provider rows X5 to X8, the limits of an opening, and the read projections.

/** How long a council-first stop, or a foreign cancellation, may stay unsettled. */
export const EXT_STOP_BOUND_MS = 120000;

/** The persisted reason of each extension stop code. */
export const EXT_STOP_REASONS = Object.freeze({ queue: "queue deadline expired", deadline: "execution deadline expired" });

/** The most follow-ups one seat, and one run, may open. */
export const FOLLOWUP_SEAT_LIMIT = 2;
export const FOLLOWUP_RUN_LIMIT = 6;

// X5: the finish an admitted provider deposit gives (the B5 mapping).
function depositOutcome(deposit, stop, ack) {
  switch (deposit.code) {
    case "valid":
      return { state: "valid", reason: null };
    case "invalid":
      return { state: "invalid", reason: deposit.reason ?? "schema validation failed" };
    case "late":
      return { state: "timed-out", reason: deposit.reason };
    case "quota":
      return { state: "quota-exhausted", reason: "quota exhausted" };
    case "missing":
      return { state: "error", reason: "job pruned or missing" };
    case "cancelled":
      return stop && ack?.code === "council" ? { state: "timed-out", reason: EXT_STOP_REASONS[stop.code] } : { state: "error", reason: "external cancellation" };
    default:
      return { state: "error", reason: deposit.reason ?? "provider failure" };
  }
}

// The raw queue or execution bound of an unended exact job: the queue bound while its claim is
// absent or late, else the execution bound from its claim.
function jobBound(job, timeoutMs) {
  const queueBy = job.created_at + timeoutMs;
  const timelyClaim = job.claimed_at !== null && job.claimed_at !== undefined && job.claimed_at < queueBy;
  return timelyClaim ? { due: job.claimed_at + timeoutMs, code: "deadline" } : { due: queueBy, code: "queue" };
}

/**
 * The lifecycle of the run's follow-up turns, in `(created_at, id)` order: X1 to X4 (a reserved
 * turn, and an issued Claude turn, as `lifecycleWrites`), then for an issued provider turn X5 (its
 * admitted deposit finishes it by the B5 mapping), X6 (an unended exact job with no stop and no
 * cancellation whose raw queue or execution bound `w` reached gets a stop), X7 (a council-first
 * acknowledged stop of a still-unended job settles `timed-out` with the stop's cause once `t`
 * reaches the acknowledgement plus 120 s) and X8 (a foreign cancellation of a still-unended job
 * settles `error` once `w` reaches the cancellation request plus 120 s). An ended job without a
 * deposit, and a missing job, await their observation. `jobs` maps a job id to its exact row.
 * Returns `ext-finish` writes and `{ op: "ext-stop", turnId, seat, jobId, code }` writes.
 */
export function followupWrites(turns, events, { t, w, timeoutMs, jobs = {} }) {
  const followups = [...(turns ?? [])].filter((turn) => turn.kind === "followup").sort(byCreation);
  const writes = lifecycleWrites(followups, events, { t });
  const byTurn = eventsByTurn(events);
  const finish = (turn, outcome) =>
    writes.push({ op: "ext-finish", turnId: turn.id, seat: turn.seat, round: null, kind: "followup", state: outcome.state, reason: outcome.reason });
  for (const turn of followups) {
    const { issue, deposit, stop, ack, finish: finished } = byTurn.get(turn.id) ?? {};
    if (finished || !issue || issue.job_id === null || issue.job_id === undefined) {
      continue;
    }
    if (deposit && deposit.after_close === 0) {
      finish(turn, depositOutcome(deposit, stop, ack));
      continue;
    }
    const job = jobs[issue.job_id] ?? null;
    if (!job || job.end_state !== null) {
      continue;
    }
    if (!stop && job.cancel_requested_at === null) {
      const bound = jobBound(job, timeoutMs);
      if (w >= bound.due) {
        writes.push({ op: "ext-stop", turnId: turn.id, seat: turn.seat, jobId: issue.job_id, code: bound.code });
      }
      continue;
    }
    if (stop && ack?.code === "council") {
      if (t >= ack.at + EXT_STOP_BOUND_MS) {
        finish(turn, { state: "timed-out", reason: EXT_STOP_REASONS[stop.code] });
      }
      continue;
    }
    if (job.cancel_requested_at !== null && w >= job.cancel_requested_at + EXT_STOP_BOUND_MS) {
      finish(turn, { state: "error", reason: "external cancellation did not settle" });
    }
  }
  return writes;
}

/** Whether a follow-up turn has no finish yet (reserved or issued). */
export function followupOpen(turn, byTurn) {
  return turn.kind === "followup" && !byTurn.get(turn.id)?.finish;
}

/** The extension stops still waiting for their acknowledgement: `{ turnId, seat, jobId }`. */
export function pendingExtensionStops(ext) {
  const byTurn = eventsByTurn(ext?.events ?? []);
  return (ext?.turns ?? [])
    .filter((turn) => {
      const events = byTurn.get(turn.id) ?? {};
      return events.stop && !events.ack && events.issue?.job_id;
    })
    .map((turn) => ({ turnId: turn.id, seat: turn.seat, jobId: byTurn.get(turn.id).issue.job_id }));
}

/**
 * The limits an opening for `seat` would pass, as refusals in seat, run, cap order: every
 * follow-up turn the seat (and the run) already opened counts, also one that failed or expired
 * unissued, and the member-turn cap needs `used + live + 1 <= cap`. Returns `[]` or
 * `[{ error, message }]`; the first entry's code is the refusal and the messages join with a space.
 */
export function followupLimits({ seat, seatCount, runCount, used, live, cap }) {
  const limits = [];
  if (seatCount >= FOLLOWUP_SEAT_LIMIT) {
    limits.push({ error: "seat-followup-limit", message: `Seat ${seat} has reached the limit of two follow-ups.` });
  }
  if (runCount >= FOLLOWUP_RUN_LIMIT) {
    limits.push({ error: "run-followup-limit", message: "The run has reached the limit of six follow-ups." });
  }
  if (used + live + 1 > cap) {
    limits.push({ error: "member-turn-limit", message: `The run has reached its cap of ${cap} member turns.` });
  }
  return limits;
}
