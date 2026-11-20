import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseCommandInput, resolveCommandCwd } from "../lib/companion-cli.mjs";
import { readRequesterIdentity } from "../lib/host.mjs";
import { reconcileStore } from "../lib/job-control.mjs";
import {
  createJob,
  decideNext,
  InvalidLabelError,
  JobActiveError,
  JobCancelledError,
  JobFailedError,
  JobStoppingError,
  LabelInUseError,
  MessageTooLargeError,
  NotResumableError,
  PromptTooLargeError,
  readJobView,
  requestStop,
  resolveStateDir,
  ThreadBarrierError,
  UnknownJobError
} from "../lib/state.mjs";
import { openStore, RETRY_BUDGETS, StoreError, testPoint, wallNow, withRetry } from "../lib/store.mjs";
import { checkProviders, newRunId } from "../lib/runs.mjs";
import { launchWorker } from "../lib/task-launch.mjs";
import { buildSeatJob, readSeatUsage } from "../lib/council/jobs.mjs";
import { installObject, ObjectDamagedError, publishExport, readObject } from "../lib/council/objects.mjs";
import { buildBundles } from "../lib/council/anonymise.mjs";
import { mergeCouncil, serializeMerge, sortedTally } from "../lib/council/merge.mjs";
import {
  FAMILIES,
  familyProvider,
  planSeats,
  renderRepairPrompt,
  renderRetryPrompt,
  renderRound1Prompt,
  renderRound2Prompt
} from "../lib/council/prompts.mjs";
import {
  acknowledgeStop,
  BUDGET_MS,
  CLEANUP_BUDGET_MS,
  continueBindingHook,
  COUNCIL_LAYER,
  COUNCIL_TEST_POINTS as POINTS,
  CouncilFenceError,
  createBindingHook,
  createCouncilRun,
  depositObservation,
  depositReceipt,
  peekRound,
  POLL_MS,
  readCouncil,
  recordMerge,
  recordRefusal,
  recordReport,
  recordVerdict,
  reduceRun,
  startRound2,
  STOP_RETRY_MS,
  stopHook,
  USAGE_READ_MS
} from "../lib/council/state.mjs";
import { classifyFailure, classifyJob, validateAnswer, validationContext } from "../lib/council/validate.mjs";

// `council`: a panel of read-only seats answers one brief in two rounds; this module runs the
// executor (issuing attempts, exact stops, observing jobs) and the council subcommands.

const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas");
const RECONCILE_EVERY_MS = 10000;
const ROUND_SCHEMA_FILES = { 1: "council-round1.schema.json", 2: "council-round2.schema.json" };

/** The packaged schema file of a council round. */
export function roundSchemaPath(round) {
  return path.join(SCHEMA_DIR, ROUND_SCHEMA_FILES[round]);
}

function readRoundSchema(round) {
  try {
    return JSON.parse(fs.readFileSync(roundSchemaPath(round), "utf8"));
  } catch {
    return null;
  }
}

function refuse(store, attempt, reason, ctx) {
  return recordRefusal(store, { attemptId: attempt.id, reason, layer: ctx.layer, deadline: ctx.deadline });
}

function retried(fn, deadline) {
  return withRetry((opts) => fn(opts), "command", { deadline });
}

async function launchAfterWin(store, stateDir, jobId, ctx) {
  testPoint(POINTS.beforeLaunch);
  try {
    await (ctx.launch ?? launchWorker)(store, stateDir, jobId, { deadline: ctx.deadline });
  } catch (error) {
    // The job is committed and W3 owns its launch from here; the next scan launches it.
    (ctx.diagnosticLines ?? []).push(`The worker of ${jobId} did not start (${error?.message ?? error}); the next scan launches it.`);
  }
  testPoint(POINTS.afterLaunch);
}

async function requesterOf(ctx) {
  ctx.requester ??= await (ctx.readRequester ?? readRequesterIdentity)();
  return ctx.requester;
}

// The refusal string of an error on a forced continuation, from the error or its first reason.
function forcedRefusal(error) {
  const first = error instanceof CouncilFenceError ? error.reasons?.[0] : null;
  if (error instanceof ThreadBarrierError || first === "provider-exit-unobserved" || first === "thread-barrier") {
    return "thread barrier";
  }
  if (error instanceof JobFailedError || first === "failed-predecessor") {
    return "predecessor failed";
  }
  if (error instanceof JobCancelledError || first === "cancelled-predecessor") {
    return "predecessor cancelled";
  }
  return null;
}

// The force reason an unforced continuation error asks for, or null when it asks for none.
function forceAsked(error) {
  if (error instanceof CouncilFenceError && error.code === "force-required") {
    return error.reasons ?? [];
  }
  if (error instanceof ThreadBarrierError) {
    return ["thread-barrier"];
  }
  if (error instanceof JobFailedError) {
    return ["failed-predecessor"];
  }
  if (error instanceof JobCancelledError) {
    return ["cancelled-predecessor"];
  }
  return null;
}

async function dispatchCreate(store, stateDir, runDir, attempt, ctx) {
  const { run, seat } = ctx;
  testPoint(POINTS.beforeCreate);
  let prompt;
  try {
    prompt = readObject(runDir, attempt.prompt_sha256, "md").toString("utf8");
  } catch (error) {
    if (error instanceof ObjectDamagedError) {
      await refuse(store, attempt, "prompt object damaged", ctx);
      return { dispatched: false, diagnostics: [] };
    }
    throw error;
  }
  if (!readRoundSchema(attempt.round)) {
    await refuse(store, attempt, "invalid round schema", ctx);
    return { dispatched: false, diagnostics: [] };
  }
  let built;
  try {
    built = await (ctx.buildJob ?? buildSeatJob)({
      family: seat.family,
      model: seat.model,
      prompt,
      schemaPath: roundSchemaPath(attempt.round),
      label: seat.label,
      runId: run.id,
      cwd: run.cwd,
      requester: await requesterOf(ctx)
    });
  } catch (error) {
    if (error instanceof StoreError) {
      throw error;
    }
    await refuse(store, attempt, "invalid job request", ctx);
    return { dispatched: false, diagnostics: [] };
  }
  let created;
  let label = built.label ?? null;
  for (;;) {
    try {
      created = await retried(
        (opts) => createJob(store, built.fields, { label, withinCreate: createBindingHook({ attemptId: attempt.id, layer: ctx.layer }) }, opts),
        ctx.deadline
      );
      break;
    } catch (error) {
      if (error instanceof CouncilFenceError || error instanceof StoreError) {
        return { dispatched: false, diagnostics: [] };
      }
      // A fresh replacement tries the seat label once, then once without a label.
      if (error instanceof LabelInUseError && attempt.charge !== "turn" && label !== null) {
        label = null;
        continue;
      }
      const reason =
        error instanceof LabelInUseError
          ? "label in use"
          : error instanceof InvalidLabelError
            ? "invalid label"
            : error instanceof PromptTooLargeError
              ? "prompt too large"
              : "invalid job request";
      await refuse(store, attempt, reason, ctx);
      return { dispatched: false, diagnostics: [] };
    }
  }
  testPoint(POINTS.afterCreate);
  await launchAfterWin(store, stateDir, created.jobId, ctx);
  const dropped = label === null && built.label ? [{ seat: attempt.seat, jobId: created.jobId, label: built.label }] : [];
  return { dispatched: true, jobId: created.jobId, diagnostics: dropped };
}

// The continuation refusal that the exact predecessor's projection decides before E17 runs, or
// "wait" while its execution is live or unreleased, or null.
function predecessorProblem(view) {
  if (!view) {
    return "predecessor missing";
  }
  if (view.successorId) {
    return `foreign successor ${view.successorId}`;
  }
  const row = view.row;
  if (["queued", "running", "stopping"].includes(view.state) || (row.claimed_at !== null && row.exec_released_at === null)) {
    return "wait";
  }
  if (row.end_state !== null && !row.thread_id) {
    return "predecessor has no thread";
  }
  return null;
}

async function dispatchContinue(store, stateDir, runDir, attempt, ctx) {
  const predecessorId = attempt.predecessor_id;
  const before = predecessorProblem(readJobView(store, predecessorId));
  if (before === "wait") {
    return { dispatched: false, diagnostics: [] };
  }
  if (before) {
    await refuse(store, attempt, before, ctx);
    return { dispatched: false, diagnostics: [] };
  }
  let message;
  try {
    message = readObject(runDir, attempt.prompt_sha256, "md").toString("utf8");
  } catch (error) {
    if (error instanceof ObjectDamagedError) {
      await refuse(store, attempt, "prompt object damaged", ctx);
      return { dispatched: false, diagnostics: [] };
    }
    throw error;
  }
  const outputSchema = readRoundSchema(attempt.round);
  if (!outputSchema) {
    await refuse(store, attempt, "invalid round schema", ctx);
    return { dispatched: false, diagnostics: [] };
  }
  const requester = await requesterOf(ctx);
  let force = false;
  let reasons = [];
  for (;;) {
    testPoint(POINTS.beforeDecide);
    let result;
    try {
      result = await retried(
        (opts) =>
          (ctx.decideNext ?? decideNext)(
            store,
            { ref: predecessorId, observedTipId: predecessorId },
            {
              action: "continue",
              message,
              requester,
              outputSchema,
              force,
              automatic: false,
              withinDecision: continueBindingHook({ attemptId: attempt.id, predecessorId, force, reasons, layer: ctx.layer })
            },
            opts
          ),
        ctx.deadline
      );
    } catch (error) {
      if (error instanceof StoreError || error instanceof JobActiveError || error instanceof JobStoppingError) {
        return { dispatched: false, diagnostics: [] };
      }
      if (error instanceof CouncilFenceError && error.code !== "force-required") {
        return { dispatched: false, diagnostics: [] };
      }
      const asked = forceAsked(error);
      if (asked && !force) {
        force = true;
        reasons = asked;
        continue;
      }
      if (asked && force) {
        await refuse(store, attempt, forcedRefusal(error) ?? "thread barrier", ctx);
        return { dispatched: false, diagnostics: [] };
      }
      let reason;
      if (error instanceof NotResumableError) {
        const view = readJobView(store, predecessorId);
        reason = view?.successorId
          ? `foreign successor ${view.successorId}`
          : view && view.row.end_state !== null && !view.row.thread_id
            ? "predecessor has no thread"
            : "predecessor not resumable";
      } else if (error instanceof UnknownJobError) {
        reason = "predecessor missing";
      } else if (error instanceof MessageTooLargeError) {
        reason = "message too large";
      } else {
        throw error;
      }
      await refuse(store, attempt, reason, ctx);
      return { dispatched: false, diagnostics: [] };
    }
    testPoint(POINTS.afterDecide);
    if (result.won) {
      await launchAfterWin(store, stateDir, result.successorId, ctx);
      const diagnostics = result.labelDropped ? [{ seat: attempt.seat, jobId: result.successorId, label: ctx.seat.label }] : [];
      return { dispatched: true, jobId: result.successorId, diagnostics };
    }
    if (!result.successorId) {
      await refuse(store, attempt, "continuation lost", ctx);
    }
    return { dispatched: false, diagnostics: [] };
  }
}

/**
 * Issues one provider attempt: a `create` attempt through E10 with the binding hook, a `continue`
 * attempt through E17 with the continuation hook (at most one forced call per dispatch), then E38
 * once after a win. Deterministic failures record the contract's refusal; availability and fence
 * losses leave the attempt pending. `deps` is `{ run, seat, layer, deadline }` plus the optional
 * `buildJob`, `launch` and `readRequester`. A fresh repair or retry whose seat label is held
 * retries once without a label. Resolves to `{ dispatched, jobId?, diagnostics }`, where a job
 * that did not get the seat's label gives `diagnostics: [{ seat, jobId, label }]`.
 */
export async function dispatchAttempt(store, stateDir, runDir, attempt, deps) {
  if (attempt.kind === "create") {
    return dispatchCreate(store, stateDir, runDir, attempt, deps);
  }
  if (attempt.kind === "continue") {
    return dispatchContinue(store, stateDir, runDir, attempt, deps);
  }
  return { dispatched: false, diagnostics: [] };
}

/**
 * Sends each pending exact council stop of the run (`run` is the run row) through E18 with the
 * exact job id, then acknowledges it. A stop whose last E18 attempt in this command completed
 * less than STOP_RETRY_MS ago (`deps.stamps`, job id to a `deps.now()` stamp) waits. Resolves to
 * `{ pending, nextRetryMs, errors }`: the stops still unacknowledged, the delay until the
 * nearest one is due again (null when none waits), and the store-contract errors seen.
 */
export async function dispatchStops(store, run, deps) {
  const now = deps.now ?? (() => performance.now());
  const stamps = deps.stamps ?? new Map();
  const snapshot = readCouncil(store, run.id);
  const pendingStops = (snapshot?.stops ?? []).filter((stop) => stop.acknowledged_at === null);
  let pending = 0;
  let nextRetryMs = null;
  const errors = [];
  for (const stop of pendingStops) {
    const stamp = stamps.get(stop.job_id);
    if (stamp !== undefined && now() - stamp < STOP_RETRY_MS) {
      pending += 1;
      const wait = STOP_RETRY_MS - (now() - stamp);
      nextRetryMs = nextRetryMs === null ? wait : Math.min(nextRetryMs, wait);
      continue;
    }
    const sessionId = run.session_id ?? (await requesterOf(deps)).sessionId ?? null;
    testPoint(POINTS.beforeStop);
    let outcome;
    try {
      outcome = await retried(
        (opts) =>
          (deps.requestStop ?? requestStop)(
            store,
            { jobIds: [stop.job_id] },
            { reason: "cancel", sessionId, cancel: true, afterMs: 4000, withinStop: (deps.layer ?? 0) >= 1 ? stopHook({ jobId: stop.job_id }) : null },
            opts
          ),
        deps.deadline
      );
    } catch (error) {
      stamps.set(stop.job_id, now());
      if (!(error instanceof StoreError)) {
        throw error;
      }
      pending += 1;
      nextRetryMs = nextRetryMs === null ? STOP_RETRY_MS : Math.min(nextRetryMs, STOP_RETRY_MS);
      continue;
    }
    stamps.set(stop.job_id, now());
    testPoint(POINTS.afterStop);
    const selected = (outcome?.selection ?? []).some((entry) => entry.jobId === stop.job_id);
    const ack = await acknowledgeStop(store, { jobId: stop.job_id, selected, deadline: deps.deadline });
    if (!ack.ok) {
      pending += 1;
      nextRetryMs = nextRetryMs === null ? STOP_RETRY_MS : Math.min(nextRetryMs, STOP_RETRY_MS);
      if (ack.reason === "stop-still-pending") {
        errors.push({ error: "store-error", jobId: stop.job_id, message: `The stop request for job ${stop.job_id} did not select it; it stays pending.` });
      }
    }
  }
  return { pending, nextRetryMs, errors };
}

function seatOf(snapshot, seat) {
  return snapshot.seats.find((row) => row.seat === seat);
}

function failureReason(row, cls) {
  if (/launch-failed/.test(`${row.end_reason ?? ""}\n${row.error ?? ""}`)) {
    return "launch failed";
  }
  return cls === "transient" ? "transient provider failure" : "provider failure";
}

// The full round base prompt of an attempt's seat round: the prompt of its initial turn attempt.
function basePromptOf(runDir, snapshot, attempt) {
  const turn = snapshot.attempts.find((row) => row.round === attempt.round && row.seat === attempt.seat && row.charge === "turn");
  return readObject(runDir, turn.prompt_sha256, "md").toString("utf8");
}

/**
 * At `layer` 1 or more, installs the replacement prompt of a new invalid or transient verdict
 * before its deposit and returns the verdict with `replacementSha256`: the repair prompt (full
 * round base prompt, the validation errors, the round schema) for an invalid verdict, the retry
 * prompt (reissued at the job's end time, with the failure reason) for a transient failure. Any
 * other verdict, and every verdict at layer 0, is returned unchanged.
 */
function withReplacement(runDir, snapshot, attempt, verdict, layer) {
  if (!(layer >= 1)) {
    return verdict;
  }
  if (verdict.outcome === "invalid") {
    const errors = verdict.errorsSha256 ? JSON.parse(readObject(runDir, verdict.errorsSha256, "json").toString("utf8")) : [verdict.reason];
    const text = renderRepairPrompt({ basePrompt: basePromptOf(runDir, snapshot, attempt), errors, schemaText: fs.readFileSync(roundSchemaPath(attempt.round), "utf8") });
    return { ...verdict, replacementSha256: installObject(runDir, text, "md") };
  }
  if (verdict.outcome === "failure" && verdict.transient) {
    const text = renderRetryPrompt({ issuedAt: verdict.eventAt, basePrompt: basePromptOf(runDir, snapshot, attempt), reason: verdict.reason });
    return { ...verdict, replacementSha256: installObject(runDir, text, "md") };
  }
  return verdict;
}

// The verdict of a completed, timely job: its structured output checked against the round.
function completedVerdict(runDir, snapshot, attempt, row, eventAt) {
  if (row.result_json_too_large) {
    return { outcome: "invalid", eventAt, reason: "structured output too large" };
  }
  if (row.result_json === null || row.result_json === undefined) {
    return { outcome: "invalid", eventAt, reason: "missing structured output" };
  }
  const bytes = Buffer.from(String(row.result_json), "utf8");
  const answerSha256 = installObject(runDir, bytes, "json");
  let answer;
  try {
    answer = JSON.parse(bytes.toString("utf8"));
  } catch {
    answer = undefined;
  }
  const context = validationContext(runDir, snapshot, attempt.seat, attempt.round);
  const checked = answer === undefined ? { ok: false, errors: ["answer: not valid JSON"] } : validateAnswer(attempt.round, answer, context);
  if (checked.ok) {
    return { outcome: "valid", eventAt, answerSha256 };
  }
  const errorsSha256 = installObject(runDir, `${JSON.stringify(checked.errors)}\n`, "json");
  return { outcome: "invalid", eventAt, reason: "schema validation failed", errorsSha256 };
}

// Starts the usage read of a failed job once per command; the result is used by a later pass.
function startUsageRead(job, family, run, deps) {
  const now = deps.now ?? (() => performance.now());
  const remaining = deps.deadline - now();
  const capMs = Math.min(USAGE_READ_MS, remaining);
  if (!(capMs > 0)) {
    return null;
  }
  const entry = { done: false, result: null, promise: null };
  const read = Promise.resolve()
    .then(() => (deps.readUsage ?? readSeatUsage)(family, { cwd: run.cwd, timeoutMs: capMs }))
    .catch(() => null);
  // The cap of the real clock is cleared once the read settles, so it never holds the process.
  let timer = null;
  const cap = deps.sleep
    ? deps.sleep(capMs)
    : new Promise((resolve) => {
        timer = setTimeout(resolve, capMs);
      });
  entry.promise = Promise.race([read, cap.then(() => null)]).then((result) => {
    clearTimeout(timer);
    entry.done = true;
    entry.result = result ?? null;
  });
  deps.usage.set(job, entry);
  return entry;
}

/**
 * Observes every exact bound job of the snapshot's open rounds that has no observation: reads the
 * job through E11, classifies it, installs the answer and errors objects from its stored result,
 * and deposits the observation. A failed or interrupted job first needs its usage read, started
 * once per command and never awaited here; a finished read is used by this or a later pass.
 * Resolves to the number of observations deposited.
 */
export async function observeJobs(store, runDir, snapshot, deps) {
  deps.usage ??= new Map();
  const observed = new Set(snapshot.observations.map((row) => row.attempt_id));
  const openRounds = new Set(snapshot.rounds.filter((row) => row.closed_at === null).map((row) => row.round));
  let deposited = 0;
  for (const attempt of snapshot.attempts) {
    if (attempt.job_id === null || observed.has(attempt.id) || !openRounds.has(attempt.round)) {
      continue;
    }
    const view = readJobView(store, attempt.job_id);
    const row = view?.row ?? null;
    const cls = classifyJob({ row, T: snapshot.run.timeout_ms });
    if (!cls) {
      continue;
    }
    let verdict;
    switch (cls.kind) {
      case "missing":
        verdict = { outcome: "missing", reason: "job pruned or missing" };
        break;
      case "cancelled":
        verdict = { outcome: "cancelled", eventAt: cls.eventAt, reason: "job cancelled" };
        break;
      case "waiting":
        verdict = { outcome: "failure", eventAt: cls.eventAt, reason: "provider waiting" };
        break;
      case "late":
        verdict = { outcome: "late", eventAt: cls.eventAt, reason: cls.lateReason };
        break;
      case "completed":
        verdict = completedVerdict(runDir, snapshot, attempt, row, cls.eventAt);
        break;
      default: {
        const seat = seatOf(snapshot, attempt.seat);
        const entry = deps.usage.get(attempt.job_id) ?? startUsageRead(attempt.job_id, seat.family, snapshot.run, deps);
        if (!entry || !entry.done) {
          continue;
        }
        const failure = classifyFailure({ family: seat.family, model: row.model ?? seat.model, usage: entry.result, row });
        if (failure === "quota") {
          verdict = { outcome: "quota", eventAt: cls.eventAt, reason: "quota exhausted" };
        } else if (failure === "missing-output") {
          verdict = cls.timely
            ? { outcome: "invalid", eventAt: cls.eventAt, reason: "missing structured output" }
            : { outcome: "late", eventAt: cls.eventAt, reason: cls.lateReason };
        } else {
          verdict = { outcome: "failure", eventAt: cls.eventAt, reason: failureReason(row, failure), transient: failure === "transient" };
        }
      }
    }
    verdict = withReplacement(runDir, snapshot, attempt, verdict, deps.layer);
    const result = await depositObservation(store, { attemptId: attempt.id, jobId: attempt.job_id, verdict, layer: deps.layer, deadline: deps.deadline });
    if (result.ok) {
      deposited += 1;
      testPoint(POINTS.afterDeposit);
    }
  }
  return deposited;
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

/** The prompts a seat's agent should answer now: current, unretired, unanswered and open. */
export function openDeliveries(snapshot, runDir, t) {
  const observed = new Set(snapshot.observations.map((row) => row.attempt_id));
  const closed = new Set(snapshot.rounds.filter((row) => row.closed_at !== null).map((row) => row.round));
  const attempts = new Map(snapshot.attempts.map((row) => [row.id, row]));
  const deliveries = [];
  for (const seatRound of snapshot.seatRounds) {
    const attempt = seatRound.current_id ? attempts.get(seatRound.current_id) : null;
    if (!attempt || attempt.kind !== "prompt" || closed.has(attempt.round) || seatRound.state !== "running") {
      continue;
    }
    if (attempt.retired_at !== null || observed.has(attempt.id) || t >= attempt.issue_by) {
      continue;
    }
    deliveries.push({
      round: attempt.round,
      seat: attempt.seat,
      intentId: attempt.id,
      promptFile: path.join(runDir, "objects", `${attempt.prompt_sha256}.md`),
      deadline: new Date(attempt.issue_by).toISOString()
    });
  }
  return deliveries
    .sort((a, b) => a.round - b.round || (a.seat < b.seat ? -1 : a.seat > b.seat ? 1 : 0))
    .map(({ round: _round, ...delivery }) => delivery);
}

function issuable(snapshot, round) {
  const attempts = new Map(snapshot.attempts.map((row) => [row.id, row]));
  return snapshot.seatRounds
    .filter((row) => row.round === round && row.state === "issuing" && row.current_id)
    .map((row) => attempts.get(row.current_id))
    .filter((attempt) => attempt && attempt.job_id === null && attempt.refusal === null && attempt.retired_at === null);
}

/**
 * Advances one round until it closes, a new prompt is ready, or the command deadline comes: each
 * pass reduces visible work and dispatches known stops before any usage read, issues eligible
 * attempts, observes ended jobs, and reduces again; E43 runs every 10 seconds. A pass with nothing
 * to write makes no write transaction. Between passes it waits on the first of the usage reads in
 * flight, POLL_MS and the wake delay (the reducer's `nextDue` or the stop retry delay), through
 * the injected `sleep(ms)`. With `once` it returns after the first pass. Resolves to `{ wake,
 * nextDue, deliveries, diagnostics, errors, notes }`, `wake` being `closed`, `prompt`, `budget`,
 * or null after a single pass or for a refusal (`errors[0].error` is `unknown-run` or
 * `round-not-started`); `notes` are launch lines for standard error.
 */
export async function advance(runDir, options) {
  const { runId, round, layer = 0, deadline } = options;
  const stateDir = options.stateDir ?? path.dirname(path.dirname(runDir));
  const ownStore = !options.openStore;
  const store = ownStore ? openStore(stateDir, { busyTimeoutMs: RETRY_BUDGETS.command.attemptMs }) : options.openStore();
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? defaultSleep;
  const reconcile = options.reconcile ?? ((dir, args) => reconcileStore(dir, args));
  const deps = {
    layer,
    deadline,
    now,
    sleep: options.sleep,
    readUsage: options.readUsage,
    readRequester: options.readRequester,
    buildJob: options.buildJob,
    launch: options.launch,
    requestStop: options.requestStop,
    stamps: options.stamps ?? new Map(),
    usage: new Map(),
    diagnosticLines: []
  };
  const diagnostics = [];
  const errors = [];
  let lastReconcile = null;
  let initialDeliveries = null;
  const result = (wake, nextDue, deliveries) => ({ wake, nextDue, deliveries, diagnostics, errors, notes: deps.diagnosticLines });
  try {
    for (;;) {
      let snapshot = readCouncil(store, runId);
      if (!snapshot) {
        errors.push({ error: "unknown-run" });
        return result(null, null, []);
      }
      if (!snapshot.rounds.some((row) => row.round === round)) {
        errors.push({ error: "round-not-started" });
        return result(null, null, []);
      }
      const t0 = Math.max(snapshot.run.clock, wallNow());
      initialDeliveries ??= new Set(openDeliveries(snapshot, runDir, t0).map((delivery) => delivery.intentId));
      if (lastReconcile === null || now() - lastReconcile >= RECONCILE_EVERY_MS) {
        lastReconcile = now();
        try {
          await reconcile(stateDir, { deadline, budget: "command" });
        } catch (error) {
          if (!(error instanceof StoreError)) {
            throw error;
          }
        }
      }
      await reduceIfNeeded(store, { runId, round, layer, deadline });
      const stopped = await dispatchStops(store, snapshot.run, deps);
      errors.push(...stopped.errors);
      snapshot = readCouncil(store, runId);
      if (snapshot.rounds.find((row) => row.round === round).closed_at !== null) {
        return result("closed", null, openDeliveries(snapshot, runDir, Math.max(snapshot.run.clock, wallNow())));
      }
      for (const attempt of issuable(snapshot, round)) {
        const outcome = await dispatchAttempt(store, stateDir, runDir, attempt, { ...deps, run: snapshot.run, seat: seatOf(snapshot, attempt.seat) });
        diagnostics.push(...outcome.diagnostics);
      }
      snapshot = readCouncil(store, runId);
      await observeJobs(store, runDir, snapshot, deps);
      testPoint(POINTS.beforeReduce);
      const peek = await reduceIfNeeded(store, { runId, round, layer, deadline });
      snapshot = readCouncil(store, runId);
      const t = Math.max(snapshot.run.clock, wallNow());
      const deliveries = openDeliveries(snapshot, runDir, t);
      if (snapshot.rounds.find((row) => row.round === round).closed_at !== null) {
        return result("closed", null, deliveries);
      }
      const nextDue = peek?.nextDue ?? null;
      if (deliveries.some((delivery) => !initialDeliveries.has(delivery.intentId))) {
        return result("prompt", nextDue, deliveries);
      }
      if (options.once) {
        return result(null, nextDue, deliveries);
      }
      let delay = POLL_MS;
      if (nextDue) {
        delay = Math.min(delay, nextDue.delayMs);
      }
      const stopRetry = (await dispatchStopsDelay(store, snapshot.run, deps)) ?? null;
      if (stopRetry !== null) {
        delay = Math.min(delay, stopRetry);
      }
      if (now() + delay >= deadline) {
        return result("budget", nextDue, deliveries);
      }
      const reads = [...deps.usage.values()].filter((entry) => !entry.done).map((entry) => entry.promise);
      await Promise.race([sleep(delay), ...reads]);
    }
  } finally {
    if (ownStore) {
      store.close();
    }
  }
}

// The delay until the nearest pending stop of the run is due again in this command, or null.
async function dispatchStopsDelay(store, run, deps) {
  const snapshot = readCouncil(store, run.id);
  let delay = null;
  for (const stop of snapshot.stops) {
    if (stop.acknowledged_at !== null) {
      continue;
    }
    const stamp = deps.stamps.get(stop.job_id);
    const wait = stamp === undefined ? 0 : Math.max(0, STOP_RETRY_MS - (deps.now() - stamp));
    delay = delay === null ? wait : Math.min(delay, wait);
  }
  return delay;
}

// Reduces the round only when the reducer has a row to write; resolves to the read-only peek
// after any reduction (its `nextDue` is the next wake).
async function reduceIfNeeded(store, { runId, round, layer, deadline }) {
  const peek = peekRound(store, { runId, round, layer });
  if (!peek || peek.writes.length === 0) {
    return peek;
  }
  await reduceRun(store, { runId, round, layer, deadline });
  return peekRound(store, { runId, round, layer });
}

// ---------------------------------------------------------------------------------------------
// The council subcommands.

export const usage =
  "council start --brief <file> [--kind review|decision] [--seat <family>:<lens>]... [--model <family>=<value>]... [--timeout-ms <ms>] [--json]" +
  " | collect <run-id> --round 1|2 [--budget-ms <ms>] [--json]" +
  " | submit <run-id> <seat> --intent <intent-id> --file <answer.json> [--json]" +
  " | crossexam <run-id> [--json] | merge <run-id> [--json]" +
  " | verdict <run-id> <cluster-id|claim-id> verified|rejected|not-checked [--strongest <n>] [--] [reason]" +
  " | export <run-id> brief|map|merge|report [--json] | status <run-id> [--json] | report <run-id> [--json]";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const BRIEF_KEYS = new Set(["question", "targets", "kind", "options", "claims"]);
const FAMILY_ORDER = FAMILIES;

/** A refusal of a council command: the machine code, the message and exit code 1. */
export class CouncilRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CouncilRefusal";
    this.code = code;
  }
}

/** The refusal text of a run id this store does not hold. */
export function unknownRunMessage(runId) {
  return `No council run ${runId} in this store. If the store was recovered, its coordination rows are in the archive; the files under council/${runId}/ (answers, any report) stay readable, but this council cannot be continued.`;
}

// Splits the repeatable `--seat` and `--model` values out of argv and parses the rest.
function parseCouncilArgs(argv, { valueOptions = [], booleanOptions = [], repeatable = [], dashPositionals = false }) {
  const repeated = Object.fromEntries(repeatable.map((name) => [name, []]));
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const name = repeatable.find((entry) => token === `--${entry}` || token.startsWith(`--${entry}=`));
    if (!name) {
      rest.push(token);
      continue;
    }
    const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : argv[(index += 1)];
    if (value === undefined) {
      throw new CouncilRefusal("invalid-arguments", `Missing value for --${name}`);
    }
    repeated[name].push(value);
  }
  const { options, positionals } = parseCommandInput(rest, { valueOptions: ["cwd", ...valueOptions], booleanOptions: ["json", ...booleanOptions] });
  const unknown = dashPositionals ? null : positionals.find((entry) => entry.startsWith("--"));
  if (unknown) {
    throw new CouncilRefusal("invalid-arguments", `Unknown option ${unknown}.`);
  }
  return { options, positionals, repeated };
}

function positiveInteger(value, name) {
  if (value === undefined) {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new CouncilRefusal("invalid-arguments", `--${name} must be a positive whole number of milliseconds.`);
  }
  return number;
}

function roundOption(value) {
  if (value !== "1" && value !== "2") {
    throw new CouncilRefusal("invalid-arguments", "--round must be 1 or 2.");
  }
  return Number(value);
}

/** The brief file's JSON, checked: `{ question, targets, kind, options, claims }`. */
export function readBrief(file, { kind: kindOverride } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new CouncilRefusal("invalid-brief", `${file}: the brief cannot be read (${error.code ?? error.message}).`);
  }
  let brief;
  try {
    brief = JSON.parse(text);
  } catch (error) {
    throw new CouncilRefusal("invalid-brief", `${file}: the brief is not valid JSON (${error.message}).`);
  }
  const fail = (message) => {
    throw new CouncilRefusal("invalid-brief", `${file}: ${message}`);
  };
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) {
    fail("the brief must be a JSON object.");
  }
  const extra = Object.keys(brief).filter((key) => !BRIEF_KEYS.has(key));
  if (extra.length > 0) {
    fail(`unknown key ${extra.map((key) => `"${key}"`).join(", ")}; the keys are question, targets, kind, options and claims.`);
  }
  if (typeof brief.question !== "string" || !brief.question.trim()) {
    fail('"question" must be a non-empty string.');
  }
  const targets = brief.targets ?? [];
  if (!Array.isArray(targets) || targets.some((target) => typeof target !== "string" || !target.trim())) {
    fail('"targets" must be an array of non-empty strings.');
  }
  const kind = kindOverride ?? brief.kind ?? "review";
  if (kind !== "review" && kind !== "decision") {
    fail('"kind" must be "review" or "decision".');
  }
  const options = brief.options ?? [];
  if (!Array.isArray(options) || options.some((option) => typeof option !== "string" || !option.trim())) {
    fail('"options" must be an array of non-empty strings.');
  }
  if (kind === "decision" && new Set(options).size < 2) {
    fail("a decision needs two or more different options.");
  }
  const claims = brief.claims ?? [];
  if (!Array.isArray(claims)) {
    fail('"claims" must be an array.');
  }
  const parsedClaims = claims.map((claim, index) => {
    if (!claim || typeof claim !== "object" || typeof claim.text !== "string" || !claim.text.trim() || !["observed", "assumed"].includes(claim.status)) {
      fail(`claims[${index}] must be { "text": "...", "status": "observed" | "assumed" }.`);
    }
    const keys = Object.keys(claim).filter((key) => key !== "text" && key !== "status");
    if (keys.length > 0) {
      fail(`claims[${index}] has an unknown key "${keys[0]}".`);
    }
    return { id: `a${index + 1}`, text: claim.text, status: claim.status };
  });
  return { question: brief.question, targets, kind, options: kind === "decision" ? options : [], claims: parsedClaims };
}

/** The brief as the Markdown every seat's prompt quotes. */
export function renderBriefText(brief) {
  const lines = ["# Council brief", "", "Question:", brief.question.trim(), ""];
  lines.push("Targets:");
  lines.push(...(brief.targets.length > 0 ? brief.targets.map((target) => `- ${target}`) : ["- (none named)"]));
  if (brief.kind === "decision") {
    lines.push("", "Options:", ...brief.options.map((option) => `- ${option}`));
  }
  if (brief.claims.length > 0) {
    lines.push("", "Claims:", ...brief.claims.map((claim) => `- ${claim.id} (${claim.status}): ${claim.text}`));
  }
  return `${lines.join("\n")}\n`;
}

function parseModels(values) {
  const models = {};
  for (const value of values) {
    const at = value.indexOf("=");
    const family = at === -1 ? "" : value.slice(0, at).trim();
    const model = at === -1 ? "" : value.slice(at + 1).trim();
    if (!FAMILY_ORDER.includes(family) || !model) {
      throw new CouncilRefusal("invalid-arguments", `--model "${value}" must be <family>=<value> with a family of ${FAMILY_ORDER.join(", ")}.`);
    }
    models[family] = model;
  }
  return models;
}

function commandStore(stateDir, deadline) {
  return withRetry((opts) => openStore(stateDir, { busyTimeoutMs: opts.attemptMs, deadline: opts.deadline }), "command", { deadline });
}

function writeDiagnostics(io, diagnostics, notes = []) {
  for (const entry of diagnostics) {
    io.stderr(`Seat ${entry.seat}: label ${entry.label} was not carried to job ${entry.jobId}.\n`);
  }
  for (const line of notes) {
    io.stderr(`${line}\n`);
  }
}

function minutesText(ms) {
  const minutes = ms / 60000;
  return Number.isInteger(minutes) ? String(minutes) : String(Number(minutes.toFixed(2)));
}

function familyCount(families) {
  return new Set(families).size;
}

/** The family order of the council's displays: the order of FAMILIES, then others by name. */
export function familySort(families) {
  return [...families].sort((a, b) => {
    const ia = FAMILY_ORDER.indexOf(a);
    const ib = FAMILY_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || (a < b ? -1 : a > b ? 1 : 0);
  });
}

function isoOrNull(value) {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

/**
 * The status object of one round: `{ runId, round, closedAt, quorum, validSeats, validFamilies,
 * cleanupPending, memberTurns, repairs, retries, seats }`, each seat `{ seat, family, state,
 * reason, jobId, answerSha256, forcedReasons }`; `closedAt` and `quorum` are null while open.
 */
export function roundObject(snapshot, round) {
  const roundRow = snapshot.rounds.find((row) => row.round === round);
  const seats = new Map(snapshot.seats.map((row) => [row.seat, row]));
  const attempts = new Map(snapshot.attempts.map((row) => [row.id, row]));
  const seatRounds = snapshot.seatRounds.filter((row) => row.round === round);
  const valid = seatRounds.filter((row) => row.state === "valid");
  const roundJobs = new Set(snapshot.attempts.filter((row) => row.round === round && row.job_id).map((row) => row.job_id));
  const charges = snapshot.charges.rounds[round] ?? { turn: 0, repair: 0, retry: 0 };
  return {
    runId: snapshot.run.id,
    round,
    closedAt: isoOrNull(roundRow.closed_at),
    quorum: roundRow.closed_at === null ? null : roundRow.quorum === 1,
    validSeats: valid.length,
    validFamilies: familyCount(valid.map((row) => seats.get(row.seat).family)),
    cleanupPending: snapshot.stops.some((stop) => stop.acknowledged_at === null && roundJobs.has(stop.job_id)),
    memberTurns: charges.turn,
    repairs: charges.repair,
    retries: charges.retry,
    seats: seatRounds.map((row) => ({
      seat: row.seat,
      family: seats.get(row.seat).family,
      state: row.state,
      reason: row.reason ?? null,
      jobId: (row.current_id && attempts.get(row.current_id)?.job_id) ?? null,
      answerSha256: row.answer_sha256 ?? null,
      forcedReasons: snapshot.attempts
        .filter((attempt) => attempt.round === round && attempt.seat === row.seat && attempt.issued_at !== null && attempt.force_reason)
        .sort((a, b) => a.issued_at - b.issued_at || (a.id < b.id ? -1 : 1))
        .map((attempt) => JSON.parse(attempt.force_reason))
    }))
  };
}

function closedText(object) {
  return object.quorum
    ? `Round ${object.round} closed with quorum.`
    : `No quorum: ${object.validSeats} valid seats from ${object.validFamilies} families. A council needs two valid seats from two families.`;
}

function runDirOf(stateDir, runId) {
  return path.join(stateDir, "council", runId);
}

function nodeIo() {
  return { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) };
}

function emit(io, json, payload, text) {
  io.stdout(json ? `${JSON.stringify(payload, null, 2)}\n` : text.endsWith("\n") ? text : `${text}\n`);
}

// At `layer` 1 or more, the digest of a seat's prepared retry prompt: the full round prompt,
// reissued at its preparation time; undefined at layer 0.
function retryPromptOf(runDir, prompt, layer) {
  return layer >= 1 ? installObject(runDir, renderRetryPrompt({ issuedAt: wallNow(), basePrompt: prompt }), "md") : undefined;
}

// `council start`: brief and seats, provider check, objects, the seeded run, one executor pass.
async function startCouncil(options, repeated, ctx) {
  const deadline = performance.now() + BUDGET_MS.start;
  if (!options.brief) {
    throw new CouncilRefusal("invalid-arguments", "council start needs --brief <file>.");
  }
  if (options.kind !== undefined && options.kind !== "review" && options.kind !== "decision") {
    throw new CouncilRefusal("invalid-arguments", "--kind must be review or decision.");
  }
  const cwd = resolveCommandCwd(options);
  const brief = readBrief(path.resolve(cwd, options.brief), { kind: options.kind });
  let planned;
  try {
    planned = planSeats({ kind: brief.kind, seatSpecs: repeated.seat });
  } catch (error) {
    throw new CouncilRefusal("invalid-seats", error.message);
  }
  if (planned.length < 2) {
    throw new CouncilRefusal("invalid-seats", "A council needs at least two seats from two families; one seat can never reach a quorum.");
  }
  const models = parseModels(repeated.model);
  const timeoutMs = positiveInteger(options["timeout-ms"], "timeout-ms") ?? DEFAULT_TIMEOUT_MS;
  const providers = [...new Set(planned.map((seat) => familyProvider(seat.family)).filter(Boolean))];
  const checks = await (ctx.checkProviders ?? checkProviders)(providers, { cwd, env: process.env });
  const failed = new Map(checks.filter((check) => !check.ok).map((check) => [check.id, check.reason]));
  const runnable = planned.filter((seat) => !failed.has(familyProvider(seat.family)));
  if (runnable.length < 2 || familyCount(runnable.map((seat) => seat.family)) < 2) {
    const reasons = [...failed.entries()].map(([id, reason]) => `${id}: ${reason}`);
    throw new CouncilRefusal("no-quorum-possible", `No quorum possible: ${reasons.length > 0 ? reasons.join("; ") : "the seats that can run are from one family"}.`);
  }
  const stateDir = resolveStateDir(cwd);
  const runId = newRunId();
  const runDir = runDirOf(stateDir, runId);
  const briefText = renderBriefText(brief);
  const briefSha256 = installObject(runDir, briefText, "md");
  const schemaText = fs.readFileSync(roundSchemaPath(1), "utf8");
  const seats = planned.map((seat) => {
    const provider = familyProvider(seat.family);
    const missingCli = failed.has(provider);
    const prompt = renderRound1Prompt({ brief: briefText, lens: seat.lens, kind: brief.kind, schemaText });
    return {
      seat: seat.seat,
      family: seat.family,
      provider,
      model: models[seat.family] ?? null,
      lens: seat.lens,
      label: provider ? `${runId}-${seat.seat}` : null,
      attemptId: missingCli ? undefined : randomBytes(16).toString("hex"),
      promptSha256: missingCli ? undefined : installObject(runDir, prompt, "md"),
      retryPromptSha256: missingCli ? undefined : retryPromptOf(runDir, prompt, ctx.layer),
      missingCli
    };
  });
  const sessionId = (await (ctx.readRequester ?? readRequesterIdentity)()).sessionId ?? null;
  const store = await commandStore(stateDir, deadline);
  try {
    const created = await createCouncilRun(store, {
      runId,
      kind: brief.kind,
      sessionId,
      cwd,
      briefSha256,
      options: brief.options,
      timeoutMs,
      seats,
      layer: ctx.layer,
      deadline
    });
    if (!created.ok) {
      throw new CouncilRefusal(created.reason, `The council could not be created: ${created.reason}.`);
    }
    publishExport(runDir, "brief.md", briefSha256, () => readCouncil(store, runId)?.run.brief_sha256 ?? null);
    const passed = await advance(runDir, { runId, round: 1, layer: ctx.layer, deadline, stateDir, once: true, openStore: () => store, ...ctx.advance });
    writeDiagnostics(ctx.io, passed.diagnostics, passed.notes);
    const cap = 2 * seats.length + 6;
    const seatText = seats.map((seat) => `${seat.seat} ${seat.family}/${seat.lens}`).join(", ");
    const text =
      `Council ${runId}: ${seats.length} seats (${seatText}), 2 rounds, member-turn cap ${cap}, time limit ${minutesText(timeoutMs)} minutes per job.\n` +
      `Next: run council status ${runId}.\n`;
    const snapshot = readCouncil(store, runId);
    const payload = {
      runId,
      kind: brief.kind,
      seats: roundObject(snapshot, 1).seats.map((seat) => ({ ...seat, lens: seats.find((entry) => entry.seat === seat.seat).lens })),
      rounds: 2,
      memberTurnCap: cap,
      timeoutMs,
      deliveries: passed.deliveries,
      ...(passed.diagnostics.length > 0 ? { diagnostics: passed.diagnostics } : {})
    };
    emit(ctx.io, options.json, payload, text);
    return 0;
  } finally {
    store.close();
  }
}

// The run-wide pending-stop cleanup of a closed round, bounded by `cleanupDeadline`.
async function cleanupStops(store, runId, { deadline, cleanupDeadline, ctx }) {
  const now = ctx.advance?.now ?? (() => performance.now());
  const sleep = ctx.advance?.sleep ?? defaultSleep;
  const deps = {
    layer: ctx.layer,
    deadline,
    now,
    stamps: new Map(),
    readRequester: ctx.readRequester,
    requestStop: ctx.advance?.requestStop
  };
  for (;;) {
    const run = readCouncil(store, runId).run;
    const outcome = await dispatchStops(store, run, deps);
    if (outcome.pending === 0) {
      return false;
    }
    const wait = Math.min(POLL_MS, outcome.nextRetryMs ?? POLL_MS);
    if (now() + wait >= cleanupDeadline) {
      return true;
    }
    await sleep(wait);
  }
}

async function closedResult(store, runId, round, { deadline, ctx, json, diagnostics = [] }) {
  const now = ctx.advance?.now ?? (() => performance.now());
  const cleanupDeadline = Math.min(deadline, now() + CLEANUP_BUDGET_MS);
  const pendingLeft = await cleanupStops(store, runId, { deadline, cleanupDeadline, ctx });
  const snapshot = readCouncil(store, runId);
  const object = { ...roundObject(snapshot, round), wake: "closed" };
  object.cleanupPending = pendingLeft || object.cleanupPending;
  if (diagnostics.length > 0) {
    object.diagnostics = diagnostics;
  }
  emit(ctx.io, json, object, closedText(object));
  return object.quorum ? 0 : 1;
}

// `council collect <run-id> --round N`: advances an open round, or returns a closed round's result.
async function collectCouncil(options, positionals, ctx) {
  const now = ctx.advance?.now ?? (() => performance.now());
  const budget = positiveInteger(options["budget-ms"], "budget-ms") ?? BUDGET_MS.collect;
  const deadline = now() + budget;
  const runId = positionals[0];
  if (!runId || positionals.length > 1) {
    throw new CouncilRefusal("invalid-arguments", "Usage: council collect <run-id> --round 1|2 [--budget-ms <ms>] [--json]");
  }
  const round = roundOption(options.round);
  const stateDir = resolveStateDir(resolveCommandCwd(options));
  const store = await commandStore(stateDir, deadline);
  try {
    const snapshot = readCouncil(store, runId);
    if (!snapshot) {
      throw new CouncilRefusal("unknown-run", unknownRunMessage(runId));
    }
    const roundRow = snapshot.rounds.find((row) => row.round === round);
    if (!roundRow) {
      throw new CouncilRefusal("round-not-started", `Round ${round} has not started.`);
    }
    if (roundRow.closed_at !== null) {
      return await closedResult(store, runId, round, { deadline, ctx, json: options.json });
    }
    const outcome = await advance(runDirOf(stateDir, runId), { runId, round, layer: ctx.layer, deadline, stateDir, openStore: () => store, ...ctx.advance });
    writeDiagnostics(ctx.io, outcome.diagnostics, outcome.notes);
    if (outcome.wake === "closed") {
      return await closedResult(store, runId, round, { deadline, ctx, json: options.json, diagnostics: outcome.diagnostics });
    }
    const wake = outcome.wake === "prompt" ? "prompt" : "budget";
    const payload = { runId, round, wake, deliveries: outcome.deliveries, ...(outcome.diagnostics.length > 0 ? { diagnostics: outcome.diagnostics } : {}) };
    const fresh = outcome.deliveries[outcome.deliveries.length - 1];
    const text = wake === "prompt" ? `Wake: a prompt for ${fresh.seat} is ready. Run council status.` : "Wake: budget. Run council collect again.";
    emit(ctx.io, options.json, payload, text);
    return 0;
  } finally {
    store.close();
  }
}

// The receipt verdict of a reply's bytes, with its objects (and at layer 1 or more the repair
// prompt of an invalid reply) installed outside any transaction.
function receiptVerdict(runDir, snapshot, attempt, bytes, layer) {
  let answer;
  try {
    answer = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    answer = undefined;
    void error;
  }
  if (!attempt) {
    return { outcome: "invalid", reason: "schema validation failed" };
  }
  const answerSha256 = installObject(runDir, bytes, "json");
  const context = validationContext(runDir, snapshot, attempt.seat, attempt.round);
  const checked = answer === undefined ? { ok: false, errors: ["answer: not valid JSON"] } : validateAnswer(attempt.round, answer, context);
  if (checked.ok) {
    return { outcome: "valid", answerSha256 };
  }
  const errorsSha256 = installObject(runDir, `${JSON.stringify(checked.errors)}\n`, "json");
  return withReplacement(runDir, snapshot, attempt, { outcome: "invalid", errorsSha256, reason: "schema validation failed" }, layer);
}

// `council submit <run-id> <seat> --intent <id> --file <answer.json>`: the receipt, then reduction.
async function submitCouncil(options, positionals, ctx) {
  const deadline = performance.now() + BUDGET_MS.submit;
  const [runId, seat] = positionals;
  if (!runId || !seat || positionals.length > 2 || !options.intent || !options.file) {
    throw new CouncilRefusal("invalid-arguments", "Usage: council submit <run-id> <seat> --intent <intent-id> --file <answer.json> [--json]");
  }
  const intentId = String(options.intent);
  const cwd = resolveCommandCwd(options);
  let bytes;
  try {
    bytes = fs.readFileSync(path.resolve(cwd, options.file));
  } catch (error) {
    throw new CouncilRefusal("invalid-arguments", `${options.file}: the reply cannot be read (${error.code ?? error.message}).`);
  }
  const stateDir = resolveStateDir(cwd);
  const runDir = runDirOf(stateDir, runId);
  const store = await commandStore(stateDir, deadline);
  try {
    const snapshot = readCouncil(store, runId);
    if (!snapshot) {
      throw new CouncilRefusal("unknown-run", unknownRunMessage(runId));
    }
    const attempt = snapshot.attempts.find((row) => row.id === intentId && row.seat === seat && row.kind === "prompt") ?? null;
    const verdict = receiptVerdict(runDir, snapshot, attempt, bytes, ctx.layer);
    testPoint(POINTS.afterReplyValidation);
    const receipt = await depositReceipt(store, { runId, seat, attemptId: intentId, verdict, layer: ctx.layer, deadline });
    const round = receipt.round ?? attempt?.round ?? null;
    if (receipt.ok) {
      testPoint(POINTS.afterDeposit);
    }
    if (round !== null) {
      testPoint(POINTS.beforeReduce);
      try {
        await reduceRun(store, { runId, round, layer: ctx.layer, deadline });
      } catch (error) {
        if (receipt.ok && error instanceof StoreError) {
          throw new CouncilRefusal("store-error", `The reply for intent ${intentId} was recorded, but the round could not be reduced: ${error.message}`);
        }
        throw error;
      }
    }
    if (!receipt.ok) {
      if (receipt.reason === "duplicate-receipt") {
        throw new CouncilRefusal("duplicate-receipt", `A reply for intent ${intentId} was already recorded.`);
      }
      throw new CouncilRefusal("intent-not-open", `Intent ${intentId} is not open for ${seat}; nothing was recorded.`);
    }
    const passed = await advance(runDir, { runId, round, layer: ctx.layer, deadline, stateDir, once: true, openStore: () => store, ...ctx.advance });
    writeDiagnostics(ctx.io, passed.diagnostics, passed.notes);
    const after = readCouncil(store, runId);
    const state = after.seatRounds.find((row) => row.round === round && row.seat === seat)?.state ?? null;
    const payload = { runId, round, seat, intentId, state, deliveries: passed.deliveries };
    emit(ctx.io, options.json, payload, `Recorded the reply of ${seat} for round ${round}: ${state}.`);
    return 0;
  } finally {
    store.close();
  }
}

function readJsonObject(runDir, sha256) {
  return JSON.parse(readObject(runDir, sha256, "json").toString("utf8"));
}

/**
 * Seeds Round 2 once and sends it: requires a closed Round 1 with quorum, reads each valid seat's
 * accepted answer, builds the anonymised bundles with a letter map per recipient, installs the map
 * and each seat's Round 2 prompt, seeds Round 2 (a provider seat continues its accepted job, the
 * host seat gets a prompt), publishes the committed map as `private/anonymisation.json`, then
 * makes one executor pass. `deps` is `{ store, stateDir, runId, layer, deadline, random, advance }`.
 * Resolves to the pass's result; throws CouncilRefusal `round-1-not-closed`, `no-quorum` or
 * `round-2-already-started`.
 */
export async function crossExamine(runDir, deps) {
  const { store, runId, layer, deadline } = deps;
  const snapshot = readCouncil(store, runId);
  if (!snapshot) {
    throw new CouncilRefusal("unknown-run", unknownRunMessage(runId));
  }
  const refusalOf = (reason) =>
    reason === "round-2-already-started"
      ? new CouncilRefusal(reason, "round 2 already sent")
      : reason === "round-1-not-closed"
        ? new CouncilRefusal(reason, "Round 1 has not closed; run council collect first.")
        : reason === "no-quorum"
          ? new CouncilRefusal(reason, "Round 1 closed without a quorum; there is no round 2.")
          : new CouncilRefusal(reason, `Round 2 could not be seeded: ${reason}.`);
  if (snapshot.rounds.some((row) => row.round === 2)) {
    throw refusalOf("round-2-already-started");
  }
  const round1 = snapshot.rounds.find((row) => row.round === 1);
  if (round1.closed_at === null) {
    throw refusalOf("round-1-not-closed");
  }
  if (round1.quorum !== 1 || snapshot.run.failed_at !== null) {
    throw refusalOf("no-quorum");
  }
  const valid = snapshot.seatRounds.filter((row) => row.round === 1 && row.state === "valid");
  const answers = Object.fromEntries(valid.map((row) => [row.seat, readJsonObject(runDir, row.answer_sha256)]));
  // A seat started without a model override still ran on some model: the name its job recorded
  // is scrubbed from the other seats' bundles too.
  const jobModels = (seat) =>
    snapshot.attempts
      .filter((row) => row.seat === seat && row.round === 1 && row.job_id)
      .map((row) => readJobView(store, row.job_id)?.row.model)
      .filter(Boolean);
  const seatRows = snapshot.seats
    .filter((row) => answers[row.seat])
    .map((row) => ({ seat: row.seat, family: row.family, label: row.label, model: row.model, identities: jobModels(row.seat) }));
  const { bundles, mapping } = buildBundles(seatRows, answers, { runId, ...(deps.random ? { random: deps.random } : {}) });
  const mapSha256 = installObject(runDir, `${JSON.stringify(mapping, null, 2)}\n`, "json");
  const briefText = readObject(runDir, snapshot.run.brief_sha256, "md").toString("utf8");
  const schemaText = fs.readFileSync(roundSchemaPath(2), "utf8");
  const lenses = new Map(snapshot.seats.map((row) => [row.seat, row.lens]));
  const entries = valid.map((row) => {
    const prompt = renderRound2Prompt({ brief: briefText, lens: lenses.get(row.seat), ownFindings: answers[row.seat].findings, bundle: bundles[row.seat], schemaText });
    return {
      seat: row.seat,
      attemptId: randomBytes(16).toString("hex"),
      promptSha256: installObject(runDir, prompt, "md"),
      retryPromptSha256: retryPromptOf(runDir, prompt, layer),
      mapSha256
    };
  });
  const seeded = await startRound2(store, { runId, mapSha256, entries, layer, deadline });
  if (!seeded.ok) {
    throw refusalOf(seeded.reason);
  }
  testPoint(POINTS.afterSeed);
  testPoint(POINTS.beforeExport);
  publishExport(runDir, "private/anonymisation.json", mapSha256, () => committedMap(store, runId));
  return advance(runDir, { runId, round: 2, layer, deadline, stateDir: deps.stateDir, once: true, openStore: () => store, ...deps.advance });
}

function committedMap(store, runId) {
  return readCouncil(store, runId)?.rounds.find((row) => row.round === 2)?.map_sha256 ?? null;
}

// `council crossexam <run-id>`: Round 2 with anonymised bundles, seeded once.
async function crossexamCouncil(options, positionals, ctx) {
  const deadline = performance.now() + BUDGET_MS.crossexam;
  const runId = positionals[0];
  if (!runId || positionals.length > 1) {
    throw new CouncilRefusal("invalid-arguments", "Usage: council crossexam <run-id> [--json]");
  }
  const stateDir = resolveStateDir(resolveCommandCwd(options));
  const store = await commandStore(stateDir, deadline);
  try {
    const passed = await crossExamine(runDirOf(stateDir, runId), { store, stateDir, runId, layer: ctx.layer, deadline, random: ctx.random, advance: ctx.advance });
    writeDiagnostics(ctx.io, passed.diagnostics, passed.notes);
    const seats = readCouncil(store, runId).seatRounds.filter((row) => row.round === 2).length;
    const payload = { runId, round: 2, seats, deliveries: passed.deliveries, ...(passed.diagnostics.length > 0 ? { diagnostics: passed.diagnostics } : {}) };
    emit(ctx.io, options.json, payload, `Round 2 sent to ${seats} seats.\nNext: run council status ${runId}.`);
    return 0;
  } finally {
    store.close();
  }
}

/** The merge input of a run from one snapshot: final valid seat rounds and their verified answers. */
export function mergeInput(runDir, snapshot) {
  const answersOf = (round) =>
    Object.fromEntries(
      snapshot.seatRounds.filter((row) => row.round === round && row.state === "valid").map((row) => [row.seat, readJsonObject(runDir, row.answer_sha256)])
    );
  const round2 = snapshot.rounds.find((row) => row.round === 2);
  const charges = snapshot.charges.total;
  return {
    runId: snapshot.run.id,
    kind: snapshot.run.kind,
    options: JSON.parse(snapshot.run.options_json),
    seats: snapshot.seats.map((row) => ({ seat: row.seat, family: row.family })),
    round1: answersOf(1),
    round2: answersOf(2),
    anonymisation: round2?.map_sha256 ? readJsonObject(runDir, round2.map_sha256) : {},
    turns: { used: charges.turn, repairs: charges.repair, retries: charges.retry }
  };
}

function requireRun(store, runId) {
  const snapshot = readCouncil(store, runId);
  if (!snapshot) {
    throw new CouncilRefusal("unknown-run", unknownRunMessage(runId));
  }
  return snapshot;
}

function oneRunId(positionals, usageText) {
  if (positionals.length !== 1) {
    throw new CouncilRefusal("invalid-arguments", `Usage: council ${usageText}`);
  }
  return positionals[0];
}

function clusterTable(merge) {
  const lines = ["| Cluster | Severity | Label | Location | Claim |", "| --- | --- | --- | --- | --- |"];
  for (const cluster of merge.clusters) {
    const location = cluster.path ? `${cluster.path}${cluster.line ? `:${cluster.line}` : ""}` : "-";
    lines.push(`| ${cluster.id} | ${cluster.severity} | ${cluster.label} | ${location} | ${cellText(cluster.claim)} |`);
  }
  return `${lines.join("\n")}\n`;
}

function cellText(text) {
  return String(text ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

// `council merge <run-id>`: the scripted merge of the final valid answers, written once per input.
async function mergeCouncilCommand(options, positionals, ctx) {
  const deadline = performance.now() + BUDGET_MS.submit;
  const runId = oneRunId(positionals, "merge <run-id> [--json]");
  const stateDir = resolveStateDir(resolveCommandCwd(options));
  const runDir = runDirOf(stateDir, runId);
  const store = await commandStore(stateDir, deadline);
  try {
    const snapshot = requireRun(store, runId);
    const round2 = snapshot.rounds.find((row) => row.round === 2);
    if (snapshot.run.failed_at !== null) {
      throw new CouncilRefusal("run-failed", "The council failed; run council report for the failed-council report.");
    }
    if (!round2 || round2.closed_at === null || round2.quorum !== 1) {
      throw new CouncilRefusal("round-2-not-closed", "Round 2 has not closed with a quorum; run council collect --round 2 first.");
    }
    const merge = mergeCouncil(mergeInput(runDir, snapshot));
    const mergeSha256 = installObject(runDir, serializeMerge(merge), "json");
    const recorded = await recordMerge(store, { runId, mergeSha256, inputRev: snapshot.run.input_rev, deadline });
    if (!recorded.ok) {
      throw new CouncilRefusal("stale-input", "The council changed while merging; run council merge again.");
    }
    publishExport(runDir, "merge.json", mergeSha256, () => readCouncil(store, runId)?.run.merge_sha256 ?? null);
    emit(ctx.io, options.json, { runId, mergeSha256, inputRev: snapshot.run.input_rev, merge }, clusterTable(merge));
    return 0;
  } finally {
    store.close();
  }
}

/** The claims of a brief object: `{ id, status, text }` per `- aN (status): text` line. */
export function briefClaims(briefText) {
  return [...String(briefText).matchAll(/^- (a[1-9][0-9]*) \((observed|assumed)\): (.*)$/gm)].map((match) => ({ id: match[1], status: match[2], text: match[3] }));
}

/** The verdict target of a merge cluster: its sorted finding ids, which no later merge renames. */
export function clusterTarget(cluster) {
  return [...cluster.findings].sort().join(",");
}

/** The current merge object of a snapshot (merge_rev = input_rev), or null. */
export function currentMerge(runDir, snapshot) {
  const run = snapshot.run;
  if (!run.merge_sha256 || run.merge_rev !== run.input_rev) {
    return null;
  }
  return readJsonObject(runDir, run.merge_sha256);
}

// `council verdict <run-id> <cluster-id|claim-id> verified|rejected|not-checked [--strongest <n>] [--] [reason]`.
async function verdictCouncil(options, positionals, ctx) {
  const deadline = performance.now() + BUDGET_MS.submit;
  const [runId, targetId, verdict, ...reasonWords] = positionals;
  const usageText = "verdict <run-id> <cluster-id|claim-id> verified|rejected|not-checked [--strongest <n>] [--] [reason]";
  if (!runId || !targetId || !["verified", "rejected", "not-checked"].includes(verdict)) {
    throw new CouncilRefusal("invalid-arguments", `Usage: council ${usageText}`);
  }
  const reason = reasonWords.join(" ").trim() || null;
  if (verdict === "rejected" && !reason) {
    throw new CouncilRefusal("invalid-arguments", "A rejected verdict needs a reason.");
  }
  let strongest = null;
  if (options.strongest !== undefined) {
    if (!/^[1-9][0-9]*$/.test(String(options.strongest))) {
      throw new CouncilRefusal("invalid-arguments", "--strongest must be a positive whole number.");
    }
    strongest = Number(options.strongest);
  }
  const stateDir = resolveStateDir(resolveCommandCwd(options));
  const runDir = runDirOf(stateDir, runId);
  const store = await commandStore(stateDir, deadline);
  try {
    const snapshot = requireRun(store, runId);
    let recorded;
    if (/^c[1-9][0-9]*$/.test(targetId)) {
      const merge = currentMerge(runDir, snapshot);
      if (!merge) {
        throw new CouncilRefusal("stale-merge", "Run council merge first.");
      }
      const cluster = merge.clusters.find((entry) => entry.id === targetId);
      if (!cluster) {
        throw new CouncilRefusal("invalid-target", `The current merge has no cluster ${targetId}.`);
      }
      let strongestSha256 = null;
      if (strongest !== null) {
        if (verdict !== "verified" || cluster.label !== "disputed" || strongest > cluster.challenges.length) {
          throw new CouncilRefusal(
            "invalid-arguments",
            `--strongest needs a verified verdict on a disputed cluster and a number from 1 to its ${cluster.challenges.length} challenges.`
          );
        }
        strongestSha256 = createHash("sha256").update(JSON.stringify(cluster.challenges[strongest - 1])).digest("hex");
      }
      recorded = await recordVerdict(store, {
        runId,
        targetKind: "cluster",
        target: clusterTarget(cluster),
        clusterId: cluster.id,
        verdict,
        reason,
        strongest,
        strongestSha256,
        mergeSha256: snapshot.run.merge_sha256,
        inputRev: snapshot.run.input_rev,
        deadline
      });
    } else if (/^a[1-9][0-9]*$/.test(targetId)) {
      if (strongest !== null) {
        throw new CouncilRefusal("invalid-arguments", "--strongest applies only to a disputed cluster.");
      }
      const claims = briefClaims(readObject(runDir, snapshot.run.brief_sha256, "md").toString("utf8"));
      if (!claims.some((claim) => claim.id === targetId)) {
        throw new CouncilRefusal("invalid-target", `The brief has no claim ${targetId}.`);
      }
      recorded = await recordVerdict(store, { runId, targetKind: "claim", target: targetId, verdict, reason, briefSha256: snapshot.run.brief_sha256, deadline });
    } else {
      throw new CouncilRefusal("invalid-target", `"${targetId}" is neither a cluster id (c1, c2, ...) nor a claim id (a1, a2, ...).`);
    }
    if (!recorded.ok) {
      throw new CouncilRefusal(recorded.reason, "The council changed since its merge; run council merge again.");
    }
    emit(ctx.io, options.json, { runId, target: targetId, verdict, reason, strongest }, `Recorded ${verdict} for ${targetId}.`);
    return 0;
  } finally {
    store.close();
  }
}

const EXPORTS = {
  brief: { file: "brief.md", ext: "md", digest: (snapshot) => snapshot.run.brief_sha256 },
  map: { file: "private/anonymisation.json", ext: "json", digest: (snapshot) => snapshot.rounds.find((row) => row.round === 2)?.map_sha256 ?? null },
  merge: { file: "merge.json", ext: "json", digest: (snapshot) => snapshot.run.merge_sha256 },
  report: { file: "report.md", ext: "md", digest: (snapshot) => snapshot.run.report_sha256 }
};

// `council export <run-id> brief|map|merge|report`: rebuilds one export from its committed object.
async function exportCouncil(options, positionals, ctx) {
  const deadline = performance.now() + BUDGET_MS.submit;
  const [runId, name] = positionals;
  if (!runId || positionals.length !== 2 || !Object.hasOwn(EXPORTS, name)) {
    throw new CouncilRefusal("invalid-arguments", "Usage: council export <run-id> brief|map|merge|report [--json]");
  }
  const stateDir = resolveStateDir(resolveCommandCwd(options));
  const runDir = runDirOf(stateDir, runId);
  const store = await commandStore(stateDir, deadline);
  try {
    const spec = EXPORTS[name];
    const digest = spec.digest(requireRun(store, runId));
    if (!digest) {
      throw new CouncilRefusal("not-committed", `Nothing to export: ${name} is not committed.`);
    }
    readObject(runDir, digest, spec.ext);
    const published = publishExport(runDir, spec.file, digest, () => spec.digest(readCouncil(store, runId)));
    if (!published) {
      throw new CouncilRefusal("stale-input", `The ${name} changed while it was exported; run council export again.`);
    }
    const file = path.join(runDir, spec.file);
    emit(ctx.io, options.json, { runId, name, file, sha256: digest }, file);
    return 0;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Status, the next action and the report.

/** The clusters of a merge that need the leader's verification: P1, consensus or cross-validated. */
export function clustersNeedingVerdict(merge) {
  return (merge?.clusters ?? []).filter((cluster) => cluster.severity === "P1" || cluster.label === "consensus" || cluster.label === "cross-validated");
}

function verdictFor(snapshot, cluster) {
  return snapshot.verdicts.find((row) => row.target_kind === "cluster" && row.target === clusterTarget(cluster) && row.input_rev === snapshot.run.input_rev) ?? null;
}

/**
 * The digest check of every object a snapshot references (`{ damaged, merge, mergeExport,
 * reportExport }`): `damaged` is the digest of the first required object that is missing or
 * damaged (provider answers, which a later observation re-derives, are not required), `merge` the
 * current merge object or null, and the export flags whether `merge.json` and `report.md` hold the
 * committed bytes.
 */
export function checkObjects(runDir, snapshot) {
  const required = [[snapshot.run.brief_sha256, "md"]];
  for (const round of snapshot.rounds) {
    if (round.map_sha256) {
      required.push([round.map_sha256, "json"]);
    }
  }
  for (const attempt of snapshot.attempts) {
    required.push([attempt.prompt_sha256, "md"]);
  }
  const prompts = new Set(snapshot.attempts.filter((row) => row.kind === "prompt").map((row) => row.id));
  for (const observation of snapshot.observations) {
    if (prompts.has(observation.attempt_id) && observation.answer_sha256) {
      required.push([observation.answer_sha256, "json"]);
    }
  }
  if (snapshot.run.merge_sha256) {
    required.push([snapshot.run.merge_sha256, "json"]);
  }
  if (snapshot.run.report_sha256) {
    required.push([snapshot.run.report_sha256, "md"]);
  }
  for (const [sha256, ext] of required) {
    try {
      readObject(runDir, sha256, ext);
    } catch (error) {
      if (error instanceof ObjectDamagedError) {
        return { damaged: sha256, merge: null, mergeExport: false, reportExport: false };
      }
      throw error;
    }
  }
  const exportHolds = (name, sha256) => {
    try {
      return Boolean(sha256) && createHash("sha256").update(fs.readFileSync(path.join(runDir, name))).digest("hex") === sha256;
    } catch {
      return false;
    }
  };
  return {
    damaged: null,
    merge: currentMerge(runDir, snapshot),
    mergeExport: exportHolds("merge.json", snapshot.run.merge_sha256),
    reportExport: exportHolds("report.md", snapshot.run.report_sha256)
  };
}

/**
 * The single next step of the leader, first match wins: `damaged` (with the digest), `collect`
 * for a pending stop (its oldest round), `report-failure` and `done` for a failed run, `collect`
 * for an open round, `crossexam`, `merge`, `verify` (with the clusters needing a verdict at the
 * current input revision), `report`, else `done`. Pure: `t` is the status clock and `objects` the
 * digest check made after the snapshot. Returns `{ action, round, deliveries, clusters, damaged }`.
 */
export function nextAction(snapshot, { t, objects, runDir = "" }) {
  const run = snapshot.run;
  const deliveries = openDeliveries(snapshot, runDir, t);
  const result = (action, round = null, clusters = []) => ({ action, round, deliveries, clusters, damaged: action === "damaged" ? objects.damaged : null });
  if (objects.damaged) {
    return result("damaged");
  }
  const pending = snapshot.stops.filter((stop) => stop.acknowledged_at === null);
  if (pending.length > 0) {
    const rounds = pending.map((stop) => snapshot.attempts.find((row) => row.job_id === stop.job_id)?.round ?? 1);
    return result("collect", Math.min(...rounds));
  }
  const reportCurrent = run.report_sha256 !== null && run.report_input_rev === run.input_rev && run.report_verdict_rev === run.verdict_rev;
  if (run.failed_at !== null) {
    return run.report_outcome === "failed" && reportCurrent && objects.reportExport ? result("done") : result("report-failure");
  }
  const latest = [...snapshot.rounds].sort((a, b) => b.round - a.round)[0];
  if (latest.closed_at === null) {
    return result("collect", latest.round);
  }
  const round1 = snapshot.rounds.find((row) => row.round === 1);
  const round2 = snapshot.rounds.find((row) => row.round === 2);
  if (round1.quorum === 1 && !round2) {
    return result("crossexam", 2);
  }
  if (round2 && round2.quorum === 1 && (run.merge_rev !== run.input_rev || !objects.mergeExport)) {
    return result("merge", 2);
  }
  const unverified = clustersNeedingVerdict(objects.merge).filter((cluster) => !verdictFor(snapshot, cluster));
  if (unverified.length > 0) {
    return result("verify", 2, unverified.map((cluster) => cluster.id));
  }
  if (!reportCurrent || run.report_outcome !== "council" || !objects.reportExport) {
    return result("report", 2);
  }
  return result("done");
}

const ACTION_TEXT = {
  damaged: (next) => `The council object ${next.damaged} is missing or damaged; this council cannot continue.`,
  collect: (next, runId) => `Next: run council collect ${runId} --round ${next.round}.`,
  crossexam: (_next, runId) => `Next: run council crossexam ${runId}.`,
  merge: (_next, runId) => `Next: run council merge ${runId}.`,
  verify: (next, runId) => `Next: check ${next.clusters.join(", ")} and record council verdict ${runId} <cluster-id> verified|rejected|not-checked.`,
  report: (_next, runId) => `Next: run council report ${runId}.`,
  "report-failure": (_next, runId) => `Next: run council report ${runId} (the council failed).`,
  done: () => "Done."
};

// `council status <run-id>`: one read snapshot, the object checks, and the next action; no write.
async function statusCouncil(options, positionals, ctx) {
  const deadline = performance.now() + BUDGET_MS.submit;
  const runId = oneRunId(positionals, "status <run-id> [--json]");
  const stateDir = resolveStateDir(resolveCommandCwd(options));
  const runDir = runDirOf(stateDir, runId);
  const store = await commandStore(stateDir, deadline);
  try {
    const snapshot = requireRun(store, runId);
    const t = Math.max(snapshot.run.clock, wallNow());
    const next = nextAction(snapshot, { t, objects: checkObjects(runDir, snapshot), runId, runDir });
    const payload = {
      runId,
      action: next.action,
      round: next.round,
      rounds: snapshot.rounds.map((row) => roundObject(snapshot, row.round)),
      deliveries: next.deliveries,
      clusters: next.clusters,
      cleanupPending: snapshot.stops.some((stop) => stop.acknowledged_at === null),
      ...(next.damaged ? { damaged: next.damaged } : {})
    };
    const lines = [`Council ${runId}: ${next.action}${next.round ? ` (round ${next.round})` : ""}.`];
    for (const delivery of next.deliveries) {
      lines.push(`Prompt for ${delivery.seat}: ${delivery.promptFile} (intent ${delivery.intentId}, reply by ${delivery.deadline}).`);
    }
    lines.push(ACTION_TEXT[next.action](next, runId));
    emit(ctx.io, options.json, payload, lines.join("\n"));
    return 0;
  } finally {
    store.close();
  }
}

/**
 * The confidence line of a report. A decision gives `Choice: <option> (<tally>), confidence
 * <HIGH|MEDIUM>` or `No consensus (<tally>)`; a review gives `Confidence: HIGH|MEDIUM|LOW` over
 * the P1 and P2 clusters (HIGH when all are consensus or cross-validated, MEDIUM when at least two
 * thirds are, LOW otherwise; with none, HIGH unless a P3 cluster is disputed, then MEDIUM).
 */
export function confidenceLine(merge) {
  if (merge.decision) {
    const tally = sortedTally(merge.decision.tally)
      .map(([option, count]) => `${option} ${count}`)
      .join(", ");
    return merge.decision.choice ? `Choice: ${merge.decision.choice} (${tally}), confidence ${merge.decision.confidence}` : `No consensus (${tally})`;
  }
  const serious = merge.clusters.filter((cluster) => cluster.severity === "P1" || cluster.severity === "P2");
  if (serious.length === 0) {
    return `Confidence: ${merge.clusters.some((cluster) => cluster.severity === "P3" && cluster.label === "disputed") ? "MEDIUM" : "HIGH"}`;
  }
  const agreed = serious.filter((cluster) => cluster.label === "consensus" || cluster.label === "cross-validated").length;
  return `Confidence: ${agreed === serious.length ? "HIGH" : 3 * agreed >= 2 * serious.length ? "MEDIUM" : "LOW"}`;
}

function seatTable(snapshot) {
  const lines = ["| Seat | Family | Model | Lens | Round 1 | Round 2 | Notes |", "| --- | --- | --- | --- | --- | --- | --- |"];
  for (const seat of snapshot.seats) {
    const state = (round) => snapshot.seatRounds.find((row) => row.round === round && row.seat === seat.seat) ?? null;
    const notes = [];
    for (const attempt of snapshot.attempts
      .filter((row) => row.seat === seat.seat && row.issued_at !== null && row.force_reason)
      .sort((a, b) => a.issued_at - b.issued_at || (a.id < b.id ? -1 : 1))) {
      const forced = JSON.parse(attempt.force_reason);
      notes.push(`forced: ${forced.predecessorId} (${forced.reasons.join(", ")})`);
    }
    for (const round of [1, 2]) {
      const row = state(round);
      if (row && row.state !== "valid" && row.reason) {
        notes.push(`round ${round}: ${row.reason}`);
      }
    }
    lines.push(
      `| ${seat.seat} | ${seat.family} | ${seat.model ?? "-"} | ${cellText(seat.lens)} | ${state(1)?.state ?? "-"} | ${state(2)?.state ?? "-"} | ${cellText(notes.join("; "))} |`
    );
  }
  return lines;
}

function runLine(snapshot) {
  const charges = snapshot.charges.total;
  const used = charges.turn;
  return `Run ${snapshot.run.id} · ${snapshot.run.kind} · 2 rounds · member turns ${used} of ${snapshot.run.turn_cap} (repairs ${charges.repair}, retries ${charges.retry})`;
}

function notValidLine(snapshot) {
  const entries = snapshot.seatRounds.filter((row) => row.state !== "valid" && row.final_at !== null).map((row) => `${row.seat} (round ${row.round}: ${row.state}${row.reason ? `, ${row.reason}` : ""})`);
  return `Seats not valid: ${entries.length > 0 ? entries.join("; ") : "none"}`;
}

function lateDeposits(snapshot) {
  const attempts = new Map(snapshot.attempts.map((row) => [row.id, row]));
  const rows = snapshot.observations
    .filter((row) => row.after_close === 1)
    .map((row) => ({ ...row, attempt: attempts.get(row.attempt_id) }))
    .sort((a, b) => a.attempt.round - b.attempt.round || (a.attempt.seat < b.attempt.seat ? -1 : a.attempt.seat > b.attempt.seat ? 1 : 0) || a.observed_at - b.observed_at || (a.attempt_id < b.attempt_id ? -1 : 1));
  const lines = ["## Late deposits", ""];
  if (rows.length === 0) {
    lines.push("None.");
    return lines;
  }
  lines.push("| Seat | Round | Job | Outcome | Event | Deposited |", "| --- | --- | --- | --- | --- | --- |");
  for (const row of rows) {
    lines.push(`| ${row.attempt.seat} | ${row.attempt.round} | ${row.attempt.job_id ?? "-"} | ${row.outcome} | ${isoOrNull(row.event_at) ?? "-"} | ${isoOrNull(row.observed_at)} |`);
  }
  return lines;
}

/** The Markdown report of a failed council: seats, turns and every stored answer. */
export function renderFailedReport(runDir, snapshot) {
  const lines = ["# Failed council", "", runLine(snapshot), "", ...seatTable(snapshot), "", notValidLine(snapshot), "", ...lateDeposits(snapshot), "", "## Answers", ""];
  for (const row of snapshot.seatRounds.filter((entry) => entry.answer_sha256)) {
    lines.push(`Round ${row.round}, ${row.seat}:`, "", "```json", readObject(runDir, row.answer_sha256, "json").toString("utf8").trim(), "```", "");
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/** The Markdown report of a council with its current merge and verdicts. */
export function renderCouncilReport(runDir, snapshot, merge) {
  const verdictOf = (cluster) => verdictFor(snapshot, cluster);
  const lines = ["# Council report", "", runLine(snapshot), "", ...seatTable(snapshot), "", notValidLine(snapshot), "", ...lateDeposits(snapshot), "", "## Verdict", "", confidenceLine(merge)];
  const unresolved = merge.clusters.filter((cluster) => cluster.severity === "P1" && !["verified", "rejected"].includes(verdictOf(cluster)?.verdict));
  if (unresolved.length > 0) {
    lines.push("", `Unresolved P1 findings: ${unresolved.map((cluster) => `${cluster.id} (${verdictOf(cluster)?.verdict ?? "no verdict"})`).join(", ")}.`);
  }
  lines.push("", "## Findings", "", "| Cluster | Severity | Label | Location | Claim | Reported by | Validated by | Challenged by | Leader verdict |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const cluster of merge.clusters) {
    const location = cluster.path ? `${cluster.path}${cluster.line ? `:${cluster.line}` : ""}` : "-";
    const challengers = familySort([...new Set(cluster.challenges.map((entry) => entry.by))]);
    lines.push(
      `| ${cluster.id} | ${cluster.severity} | ${cluster.label} | ${location} | ${cellText(cluster.claim)} | ${cluster.reportedBy.join(", ")} | ${cluster.validatedBy.join(", ") || "-"} | ${challengers.join(", ") || "-"} | ${verdictOf(cluster)?.verdict ?? "-"} |`
    );
  }
  lines.push("", "## Disputes", "");
  const disputed = merge.clusters.filter((cluster) => cluster.label === "disputed");
  if (disputed.length === 0) {
    lines.push("None.");
  }
  for (const cluster of disputed) {
    const verdict = verdictOf(cluster);
    lines.push(`- ${cluster.id}: ${cluster.claim}`);
    if (verdict?.verdict === "verified") {
      lines.push(`  Verdict: verified${verdict.reason ? ` (${verdict.reason})` : ""}.`);
      if (verdict.strongest) {
        const challenge = cluster.challenges[verdict.strongest - 1];
        lines.push(`  Strongest rejected objection (${challenge.by}, ${challenge.disputes}): ${challenge.reason}`);
      } else {
        lines.push("  The leader named no strongest objection.");
      }
    } else if (verdict?.verdict === "rejected") {
      lines.push(`  Claim rejected: ${verdict.reason}`);
    } else {
      lines.push(`  Verdict: ${verdict?.verdict ?? "none"}.`);
      if (cluster.severity === "P1") {
        lines.push(`  Blocker for the user: ${cluster.claim}`);
      }
    }
  }
  lines.push("", "## Minority positions", "");
  const minority = [];
  if (merge.decision) {
    const eligible = snapshot.seatRounds.filter((row) => row.round === 2 && row.state === "valid");
    for (const row of eligible) {
      const stance = readJsonObject(runDir, row.answer_sha256).stance;
      if (!merge.decision.choice || stance !== merge.decision.choice) {
        minority.push(`- ${row.seat}: ${stance ?? "no stance"}`);
      }
    }
  } else {
    for (const cluster of merge.clusters.filter((entry) => entry.label === "solo" && (entry.severity === "P1" || entry.severity === "P2"))) {
      minority.push(`- ${cluster.id} (${cluster.severity}, ${cluster.reportedBy.join(", ")}): ${cluster.claim}`);
    }
  }
  lines.push(...(minority.length > 0 ? minority : ["None."]));
  lines.push("", "## Untested premises", "");
  const claims = briefClaims(readObject(runDir, snapshot.run.brief_sha256, "md").toString("utf8"));
  const decided = new Set(snapshot.verdicts.filter((row) => row.target_kind === "claim" && ["verified", "rejected"].includes(row.verdict)).map((row) => row.target));
  const untested = claims.filter((claim) => claim.status === "assumed" && !decided.has(claim.id)).map((claim) => `- ${claim.id}: ${claim.text}`);
  lines.push(...(untested.length > 0 ? untested : ["None."]));
  return `${lines.join("\n")}\n`;
}

// `council report <run-id>`: renders, records and publishes the report of the current inputs.
async function reportCouncil(options, positionals, ctx) {
  const deadline = performance.now() + BUDGET_MS.submit;
  const runId = oneRunId(positionals, "report <run-id> [--json]");
  const stateDir = resolveStateDir(resolveCommandCwd(options));
  const runDir = runDirOf(stateDir, runId);
  const store = await commandStore(stateDir, deadline);
  try {
    const snapshot = requireRun(store, runId);
    let text;
    let outcome;
    let requiredTargets = [];
    if (snapshot.run.failed_at !== null) {
      text = renderFailedReport(runDir, snapshot);
      outcome = "failed";
    } else {
      const merge = currentMerge(runDir, snapshot);
      if (!merge) {
        throw new CouncilRefusal("stale-merge", "Run council merge first.");
      }
      const needed = clustersNeedingVerdict(merge);
      const missing = needed.filter((cluster) => !verdictFor(snapshot, cluster));
      if (missing.length > 0) {
        throw new CouncilRefusal("verdict-required", `Record a verdict (verified, rejected or not-checked) for ${missing.map((cluster) => cluster.id).join(", ")} first.`);
      }
      requiredTargets = needed.map(clusterTarget);
      text = renderCouncilReport(runDir, snapshot, merge);
      outcome = "council";
    }
    const reportSha256 = installObject(runDir, text, "md");
    const recorded = await recordReport(store, {
      runId,
      reportSha256,
      outcome,
      inputRev: snapshot.run.input_rev,
      verdictRev: snapshot.run.verdict_rev,
      requiredTargets,
      deadline
    });
    if (!recorded.ok) {
      throw new CouncilRefusal("stale-input", "The council changed while reporting; run council report again.");
    }
    publishExport(runDir, "report.md", reportSha256, () => readCouncil(store, runId)?.run.report_sha256 ?? null);
    const file = path.join(runDir, "report.md");
    emit(ctx.io, options.json, { runId, outcome, reportSha256, file }, text);
    return 0;
  } finally {
    store.close();
  }
}

const SUBCOMMANDS = {
  start: {
    args: { valueOptions: ["brief", "kind", "timeout-ms"], repeatable: ["seat", "model"] },
    run: (parsed, ctx) => startCouncil(parsed.options, parsed.repeated, ctx)
  },
  collect: {
    args: { valueOptions: ["round", "budget-ms"] },
    run: (parsed, ctx) => collectCouncil(parsed.options, parsed.positionals, ctx)
  },
  submit: {
    args: { valueOptions: ["intent", "file"] },
    run: (parsed, ctx) => submitCouncil(parsed.options, parsed.positionals, ctx)
  },
  crossexam: {
    args: {},
    run: (parsed, ctx) => crossexamCouncil(parsed.options, parsed.positionals, ctx)
  },
  merge: {
    args: {},
    run: (parsed, ctx) => mergeCouncilCommand(parsed.options, parsed.positionals, ctx)
  },
  verdict: {
    args: { valueOptions: ["strongest"], dashPositionals: true },
    run: (parsed, ctx) => verdictCouncil(parsed.options, parsed.positionals, ctx)
  },
  export: {
    args: {},
    run: (parsed, ctx) => exportCouncil(parsed.options, parsed.positionals, ctx)
  },
  status: {
    args: {},
    run: (parsed, ctx) => statusCouncil(parsed.options, parsed.positionals, ctx)
  },
  report: {
    args: {},
    run: (parsed, ctx) => reportCouncil(parsed.options, parsed.positionals, ctx)
  }
};

/**
 * Runs one council subcommand. `layer` (default COUNCIL_LAYER) is read once and passed to every
 * state interface; `io`, `checkProviders`, `readRequester` and `advance` (options merged into
 * every advance call) replace the process's outputs and services in tests. Resolves to the exit
 * code: 0, or 1 for a refusal, printed as `{ error, message }` with --json and as its message on
 * standard error otherwise.
 */
export async function handleCouncil(argv, { layer = COUNCIL_LAYER, io = nodeIo(), ...services } = {}) {
  const [name, ...rest] = argv;
  const command = Object.hasOwn(SUBCOMMANDS, name ?? "") ? SUBCOMMANDS[name] : null;
  const json = rest.includes("--json");
  let code;
  try {
    if (!command) {
      throw new CouncilRefusal("invalid-arguments", `Usage: council ${usage.replace(/^council /, "")}`);
    }
    const parsed = parseCouncilArgs(rest, { repeatable: [], ...command.args });
    code = await command.run(parsed, { layer, io, ...services });
  } catch (error) {
    let refusal = error;
    if (!(error instanceof CouncilRefusal)) {
      if (error instanceof StoreError) {
        refusal = new CouncilRefusal("store-error", error.class === "availability" ? `The job store is busy or unavailable (${error.code ?? "unknown"}).` : error.message);
      } else if (error instanceof ObjectDamagedError) {
        refusal = new CouncilRefusal("damaged", error.message);
      } else {
        throw error;
      }
    }
    if (json) {
      io.stdout(`${JSON.stringify({ error: refusal.code, message: refusal.message })}\n`);
    } else {
      io.stderr(`${refusal.message}\n`);
    }
    code = 1;
  }
  return code;
}

export async function run(argv) {
  process.exitCode = await handleCouncil(argv);
}
