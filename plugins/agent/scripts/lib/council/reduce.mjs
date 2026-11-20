// The pure reducer of one council round: the collection rows applied to a view of the round's
// rows and exact jobs, at a raw wall sample `w` and a council time `t`.
import { STOP_BOUND_MS } from "./state.mjs";

/** The persisted seat reason of each exact council stop cause. */
export const STOP_CAUSE_REASONS = Object.freeze({
  queue: "queue deadline expired",
  deadline: "execution deadline expired",
  "quorum-cutoff": "quorum cutoff"
});

const FINAL_STATES = new Set(["valid", "invalid", "timed-out", "error", "missing-cli", "quota-exhausted"]);

/**
 * The timing of a provider job against the per-run limit `timeoutMs`: a timely answer was claimed
 * strictly before `created_at + T` and ended strictly before `claimed_at + T`. Returns
 * `{ timely: true, reason: null }` or `{ timely: false, reason }` with the late observation's
 * reason (`queue deadline expired` for an absent or late claim, else `execution deadline expired`).
 */
export function providerTiming(job, timeoutMs) {
  const queueBy = job.created_at + timeoutMs;
  if (job.claimed_at === null || job.claimed_at === undefined || job.claimed_at >= queueBy) {
    return { timely: false, reason: "queue deadline expired" };
  }
  if (job.end_at === null || job.end_at === undefined || job.end_at >= job.claimed_at + timeoutMs) {
    return { timely: false, reason: "execution deadline expired" };
  }
  return { timely: true, reason: null };
}

function indexBy(rows, key) {
  const map = new Map();
  for (const row of rows ?? []) {
    map.set(row[key], row);
  }
  return map;
}

// The seat state and reason a provider observation gives (the reason table).
function observationOutcome(observation, stop) {
  switch (observation.outcome) {
    case "valid":
      return { state: "valid", reason: null, answerSha256: observation.answer_sha256 };
    case "invalid":
      return { state: "invalid", reason: observation.reason, errorsSha256: observation.errors_sha256 ?? null };
    case "late":
      return { state: "timed-out", reason: observation.reason };
    case "cancelled":
      return stop ? { state: "timed-out", reason: STOP_CAUSE_REASONS[stop.cause] } : { state: "error", reason: "external cancellation" };
    case "quota":
      return { state: "quota-exhausted", reason: "quota exhausted" };
    case "missing":
      return { state: "error", reason: "job pruned or missing" };
    default:
      return { state: "error", reason: observation.reason };
  }
}

// The queue and execution limits of an unended exact job on the raw wall axis.
function wallLimits(job, timeoutMs) {
  const queueBy = job.created_at + timeoutMs;
  const timelyClaim = job.claimed_at !== null && job.claimed_at < queueBy;
  return timelyClaim ? { due: job.claimed_at + timeoutMs, cause: "deadline" } : { due: queueBy, cause: "queue" };
}

function finishWrite(seat, outcome) {
  return {
    op: "finish",
    seat,
    state: outcome.state,
    reason: outcome.reason ?? null,
    answerSha256: outcome.answerSha256 ?? null,
    errorsSha256: outcome.errorsSha256 ?? null
  };
}

/**
 * Applies the Layer 0 rows to an open round, in order: B1 to B3 over the seats in seat order,
 * then B4 to B8 (first matching row per seat), then B9. `view` is `{ run, round, seats,
 * seatRounds, attempts, observations, stops, cancels, jobs, freshIds }` with `jobs` an object
 * from exact job id to its projection row. W3 times are compared with `w`, council times with `t`.
 * Returns `{ writes, nextDue }`: writes are `{ op: "account", seat }`, `{ op: "finish", seat,
 * state, reason, answerSha256, errorsSha256 }`, `{ op: "stop", jobId, cause }` and
 * `{ op: "close", quorum }`; `nextDue` is the nearest remaining delay after the writes.
 */
export function reduceRound(view, { w, t, layer = 0 }) {
  if (!view.round || view.round.closed_at !== null) {
    return { writes: [], nextDue: null };
  }
  const T = view.run.timeout_ms;
  const attempts = indexBy(view.attempts, "id");
  const observations = indexBy(view.observations, "attempt_id");
  const stops = indexBy(view.stops, "job_id");
  const jobs = view.jobs ?? {};
  const states = new Map(view.seatRounds.map((row) => [row.seat, row.state]));
  const writes = [];
  const finish = (seat, outcome) => {
    writes.push(finishWrite(seat, outcome));
    states.set(seat, outcome.state);
  };
  const ordered = [...view.seatRounds].sort((a, b) => (a.seat < b.seat ? -1 : a.seat > b.seat ? 1 : 0));

  for (const row of ordered) {
    if (states.get(row.seat) !== "issuing") {
      continue;
    }
    const current = attempts.get(row.current_id);
    if (current.job_id !== null) {
      writes.push({ op: "account", seat: row.seat });
      states.set(row.seat, "running");
    } else if (current.refusal !== null) {
      finish(row.seat, { state: "error", reason: current.refusal });
    } else if (t >= current.issue_by) {
      finish(row.seat, { state: "error", reason: "issuance deadline expired" });
    }
  }

  const newStops = [];
  for (const row of ordered) {
    if (states.get(row.seat) !== "running") {
      continue;
    }
    const current = attempts.get(row.current_id);
    const observation = observations.get(current.id);
    if (current.kind === "prompt") {
      if (observation) {
        finish(row.seat, observationOutcome(observation, null));
      } else if (t >= current.issue_by) {
        finish(row.seat, { state: "timed-out", reason: "reply deadline expired" });
      }
      continue;
    }
    const stop = stops.get(current.job_id) ?? null;
    if (observation) {
      finish(row.seat, observationOutcome(observation, stop));
      continue;
    }
    const job = jobs[current.job_id];
    if (!job || job.end_state !== null) {
      continue;
    }
    if (!stop && job.isTip && job.cancel_requested_at === null) {
      const limit = wallLimits(job, T);
      if (w >= limit.due) {
        writes.push({ op: "stop", jobId: current.job_id, cause: limit.cause });
        newStops.push({ job_id: current.job_id, requested_at: t, cause: limit.cause, dispatched_at: null, acknowledged_at: null });
        continue;
      }
    }
    if (stop && stop.dispatched_at !== null && t >= stop.dispatched_at + STOP_BOUND_MS) {
      finish(row.seat, { state: "timed-out", reason: STOP_CAUSE_REASONS[stop.cause] });
      continue;
    }
    if (!stop && job.cancel_requested_at !== null && w >= job.cancel_requested_at + STOP_BOUND_MS) {
      finish(row.seat, { state: "error", reason: "external cancellation did not settle" });
    }
  }

  if (ordered.every((row) => FINAL_STATES.has(states.get(row.seat)))) {
    const familyOf = new Map(view.seats.map((seat) => [seat.seat, seat.family]));
    const validSeats = ordered.filter((row) => states.get(row.seat) === "valid").map((row) => row.seat);
    const families = new Set(validSeats.map((seat) => familyOf.get(seat)));
    writes.push({ op: "close", quorum: validSeats.length >= 2 && families.size >= 2 ? 1 : 0 });
    return { writes, nextDue: null };
  }

  const after = {
    ...view,
    seatRounds: view.seatRounds.map((row) => ({ ...row, state: states.get(row.seat) })),
    stops: [...(view.stops ?? []), ...newStops]
  };
  return { writes, nextDue: nextDue(after, { w, t, layer }) };
}

/**
 * The nearest remaining delay of an open round, or null: each deadline converted on its own
 * clock, a W3 column (queue and execution limits, external cancellation bound) against `w` with
 * `axis: "wall"`, a council column (`issue_by`, selected-dispatch bound) against `t` with
 * `axis: "council"`. Returns `{ delayMs, axis, source }` with `source` naming the seat and the
 * deadline; a delay already due is 0.
 */
export function nextDue(view, { w, t, layer = 0 }) {
  void layer;
  if (!view.round || view.round.closed_at !== null) {
    return null;
  }
  const T = view.run.timeout_ms;
  const attempts = indexBy(view.attempts, "id");
  const observations = indexBy(view.observations, "attempt_id");
  const stops = indexBy(view.stops, "job_id");
  const jobs = view.jobs ?? {};
  const candidates = [];
  const add = (seat, name, axis, deadline, now) => candidates.push({ delayMs: Math.max(0, deadline - now), axis, source: `${seat}:${name}` });
  for (const row of view.seatRounds) {
    const current = row.current_id ? attempts.get(row.current_id) : null;
    if (!current || FINAL_STATES.has(row.state)) {
      continue;
    }
    if (current.kind === "prompt") {
      if (!observations.has(current.id)) {
        add(row.seat, "issue_by", "council", current.issue_by, t);
      }
      continue;
    }
    if (current.job_id === null) {
      if (current.refusal === null) {
        add(row.seat, "issue_by", "council", current.issue_by, t);
      }
      continue;
    }
    const job = jobs[current.job_id];
    if (observations.has(current.id) || !job || job.end_state !== null) {
      continue;
    }
    const stop = stops.get(current.job_id) ?? null;
    if (!stop && job.isTip && job.cancel_requested_at === null) {
      const limit = wallLimits(job, T);
      add(row.seat, limit.cause === "queue" ? "queue" : "execution", "wall", limit.due, w);
    }
    if (stop && stop.dispatched_at !== null) {
      add(row.seat, "stop-dispatch", "council", stop.dispatched_at + STOP_BOUND_MS, t);
    }
    if (!stop && job.cancel_requested_at !== null) {
      add(row.seat, "external-cancel", "wall", job.cancel_requested_at + STOP_BOUND_MS, w);
    }
  }
  if (candidates.length === 0) {
    return null;
  }
  return candidates.reduce((best, candidate) => (candidate.delayMs < best.delayMs ? candidate : best));
}
