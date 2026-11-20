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

// The Layer 1 replacement of a seat's current attempt: a repair or retry write, or null when its
// slot is used, its prompt digest is missing, or (for a live job) the job has a thread. The kind
// follows the exact job: a Claude prompt stays a prompt; a provider continues an ended job that
// recorded a thread and otherwise starts a fresh job.
function replacementWrite(view, attempts, row, current, job, { charge, promptSha256, live = false }) {
  if (!promptSha256) {
    return null;
  }
  const seatAttempts = attempts.filter((attempt) => attempt.seat === row.seat);
  if (seatAttempts.some((attempt) => attempt.charge === charge)) {
    return null;
  }
  let kind = "prompt";
  let predecessorId = null;
  if (current.kind !== "prompt") {
    const threaded = Boolean(job && job.thread_id);
    if (live && threaded) {
      return null;
    }
    if (!live && threaded && job.end_state !== null) {
      kind = "continue";
      predecessorId = current.job_id;
    } else {
      kind = "create";
    }
  }
  const index = (Number(row.seat.slice(1)) - 1) * 2 + (charge === "repair" ? 0 : 1);
  return {
    op: "replace",
    seat: row.seat,
    charge,
    attemptId: view.freshIds?.[index],
    kind,
    predecessorId,
    replacesId: current.id,
    promptSha256,
    retryPromptSha256: current.retry_prompt_sha256 ?? null
  };
}

// The prompt digest of an ordinary retry (late output, silent prompt, council-caused timeout):
// the prepared retry object carried on the attempt, else the seat's initial turn prompt.
function retryDigest(attempts, row, current) {
  if (current.retry_prompt_sha256) {
    return current.retry_prompt_sha256;
  }
  return attempts.find((attempt) => attempt.seat === row.seat && attempt.charge === "turn")?.prompt_sha256 ?? null;
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
 * At `layer` 1 or more, an ordinary B4, B5 or B7 candidate first tries L1a (cancellation
 * attribution from `view.cancels`), L1b (one repair of an invalid answer with its prepared digest)
 * and L1c (one retry of a transient failure, a late output, a silent prompt or a council-caused
 * timeout), writing `{ op: "replace", seat, charge, attemptId, kind, predecessorId, replacesId,
 * promptSha256, retryPromptSha256 }` with `attemptId` from `view.freshIds` (two per seat); B8
 * also covers a council stop without first-cancellation evidence.
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

  const roundAttempts = view.attempts ?? [];
  // Exact council-first cancellation evidence, recorded by the stop's own E18 transaction.
  const councilFirst = new Set((view.cancels ?? []).map((row) => row.job_id));
  const replaced = [];
  // Before an ordinary B4, B5 or B7 candidate finishes, Layer 1 tries its repair (L1b) or retry
  // (L1c) slot; the fallback finishes the candidate.
  const settle = (row, current, job, outcome, slot) => {
    const write = layer >= 1 && slot ? replacementWrite(view, roundAttempts, row, current, job, slot) : null;
    if (!write) {
      finish(row.seat, outcome);
      return;
    }
    writes.push(write);
    replaced.push(write);
    states.set(row.seat, write.kind === "prompt" ? "running" : "issuing");
  };
  const newStops = [];
  for (const row of ordered) {
    if (states.get(row.seat) !== "running") {
      continue;
    }
    const current = attempts.get(row.current_id);
    const observation = observations.get(current.id);
    if (current.kind === "prompt") {
      if (observation) {
        const repair = observation.outcome === "invalid" ? { charge: "repair", promptSha256: observation.replacement_sha256 } : null;
        settle(row, current, null, observationOutcome(observation, null), repair);
      } else if (t >= current.issue_by) {
        settle(row, current, null, { state: "timed-out", reason: "reply deadline expired" }, { charge: "retry", promptSha256: retryDigest(roundAttempts, row, current) });
      }
      continue;
    }
    const stop = stops.get(current.job_id) ?? null;
    const job = jobs[current.job_id];
    const proven = councilFirst.has(current.job_id);
    if (observation) {
      let outcome = observationOutcome(observation, stop);
      let slot = null;
      if (layer >= 1) {
        if (observation.outcome === "invalid") {
          slot = { charge: "repair", promptSha256: observation.replacement_sha256 };
        } else if (observation.outcome === "late") {
          slot = { charge: "retry", promptSha256: retryDigest(roundAttempts, row, current) };
        } else if (observation.outcome === "failure" && observation.transient === 1) {
          slot = { charge: "retry", promptSha256: observation.replacement_sha256 };
        } else if (observation.outcome === "cancelled") {
          if (stop && proven) {
            slot = { charge: "retry", promptSha256: retryDigest(roundAttempts, row, current) };
          } else {
            // L1a: a council stop row alone carries no attribution.
            outcome = { state: "error", reason: "external cancellation" };
          }
        }
      }
      settle(row, current, job, outcome, slot);
      continue;
    }
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
      if (layer >= 1 && !proven) {
        // L1a: a selected dispatch with no council-first evidence did not cause the cancellation.
        finish(row.seat, { state: "error", reason: "external cancellation did not settle" });
      } else {
        const slot = { charge: "retry", promptSha256: retryDigest(roundAttempts, row, current), live: true };
        settle(row, current, job, { state: "timed-out", reason: STOP_CAUSE_REASONS[stop.cause] }, slot);
      }
      continue;
    }
    // B8, and at Layer 1 its extension to a council stop without first-cancellation evidence.
    const foreign = layer >= 1 ? !stop || !proven : !stop;
    if (foreign && job.cancel_requested_at !== null && w >= job.cancel_requested_at + STOP_BOUND_MS) {
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

  const replacementOf = new Map(replaced.map((write) => [write.seat, write]));
  const after = {
    ...view,
    seatRounds: view.seatRounds.map((row) => ({ ...row, state: states.get(row.seat), current_id: replacementOf.get(row.seat)?.attemptId ?? row.current_id })),
    attempts: [
      ...roundAttempts,
      ...replaced.map((write) => ({
        id: write.attemptId,
        seat: write.seat,
        charge: write.charge,
        kind: write.kind,
        job_id: null,
        refusal: null,
        created_at: t,
        issue_by: t + T,
        retry_prompt_sha256: write.retryPromptSha256
      }))
    ],
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
  if (!view.round || view.round.closed_at !== null) {
    return null;
  }
  const T = view.run.timeout_ms;
  const attempts = indexBy(view.attempts, "id");
  const observations = indexBy(view.observations, "attempt_id");
  const stops = indexBy(view.stops, "job_id");
  const councilFirst = new Set((view.cancels ?? []).map((row) => row.job_id));
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
    const foreign = layer >= 1 ? !stop || !councilFirst.has(current.job_id) : !stop;
    if (foreign && job.cancel_requested_at !== null) {
      add(row.seat, "external-cancel", "wall", job.cancel_requested_at + STOP_BOUND_MS, w);
    }
  }
  if (candidates.length === 0) {
    return null;
  }
  return candidates.reduce((best, candidate) => (candidate.delayMs < best.delayMs ? candidate : best));
}
