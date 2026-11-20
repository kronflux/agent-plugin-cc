// The pure extension rows of the council: the shared lifecycle of an extension turn (X1 to X4 for
// a Claude turn; the provider rows X5 to X8 are left to the follow-up extension), the carry cutoff
// (S3), the substitution decision and its batch (S1, S2), the closure gate (S4) and the effective
// panel of a round. No I/O, clock or randomness: callers pass the rows and the council time.

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
