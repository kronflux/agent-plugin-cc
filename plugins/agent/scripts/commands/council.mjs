import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseCommandInput, resolveCommandCwd } from "../lib/companion-cli.mjs";
import { sanitizeAgentValue } from "../lib/untrusted.mjs";
import { readRequesterIdentity } from "../lib/host.mjs";
import { reconcileStore } from "../lib/job-control.mjs";
import { markDelivered, readMessageOutcome, sendToChain, withdrawMessage } from "../lib/mailbox.mjs";
import { providerForJob } from "../lib/providers.mjs";
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
import { answerBundle, answerLetterMap, buildBundles, bundleFromMap, selfLabel, standInAnswerMap } from "../lib/council/anonymise.mjs";
import { depositExtensionReceipt, depositSubstitutionOptIn } from "../lib/council/extensions.mjs";
import { canonicalAnswers, mergeCouncil, mergeQuestion, serializeMerge, sortedTally, unanimousPanel } from "../lib/council/merge.mjs";
import {
  CUTOFF_NOTICE,
  FAMILIES,
  familyProvider,
  planSeats,
  renderRepairPrompt,
  renderRetryPrompt,
  renderRound1Prompt,
  renderFollowupPrompt,
  renderRound2Prompt,
  renderSubstitutePrompt
} from "../lib/council/prompts.mjs";
import {
  actorKey,
  effectivePanel,
  eventsByTurn,
  followupLimits,
  followupOpen,
  pendingExtensionStops,
  quorumFamilies,
  substitutionCandidates,
  turnActor,
  turnState
} from "../lib/council/reduce-ext.mjs";
import {
  acknowledgeStop,
  admitFollowup,
  AGREEMENT_VALUES,
  BUDGET_MS,
  CLEANUP_BUDGET_MS,
  continueBindingHook,
  COUNCIL_EXTENSIONS,
  COUNCIL_LAYER,
  COUNCIL_TEST_POINTS as POINTS,
  CouncilFenceError,
  CouncilStopSelectionError,
  createBindingHook,
  createCouncilRun,
  depositExtensionObservation,
  depositExtensionRefusal,
  depositObservation,
  depositReceipt,
  extensionDecisionHook,
  extensionStopHook,
  peekRound,
  POLL_MS,
  readCouncil,
  readFollowupCounts,
  recordAgreement,
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
import {
  answersInOwnWords,
  classifyFailure,
  classifyJob,
  normalizeAnswerBytes,
  roundSchemaName,
  validateAnswer,
  validateFollowupAnswer,
  validationContext
} from "../lib/council/validate.mjs";

// `council`: a panel of read-only seats answers one brief in two rounds; this module runs the
// executor (issuing attempts, exact stops, observing jobs) and the council subcommands.

const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas");
const RECONCILE_EVERY_MS = 10000;
const FOLLOWUP_SCHEMA_FILE = "council-followup.schema.json";
const COUNCIL_KINDS = ["review", "decision", "question", "open"];

/** The packaged schema file of a council round for a run of `kind` (default `review`). */
export function roundSchemaPath(round, kind = "review") {
  return path.join(SCHEMA_DIR, `${roundSchemaName(round, kind)}.schema.json`);
}

function readRoundSchema(round, kind) {
  try {
    return JSON.parse(fs.readFileSync(roundSchemaPath(round, kind), "utf8"));
  } catch {
    return null;
  }
}

/** The packaged schema file of a follow-up answer (the provider wire form, with a nullable stance). */
export function followupSchemaPath() {
  return path.join(SCHEMA_DIR, FOLLOWUP_SCHEMA_FILE);
}

function readFollowupSchema() {
  try {
    return JSON.parse(fs.readFileSync(followupSchemaPath(), "utf8"));
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
  if (!readRoundSchema(attempt.round, run.kind)) {
    await refuse(store, attempt, "invalid round schema", ctx);
    return { dispatched: false, diagnostics: [] };
  }
  let built;
  try {
    built = await (ctx.buildJob ?? buildSeatJob)({
      family: seat.family,
      model: seat.model,
      prompt,
      schemaPath: roundSchemaPath(attempt.round, run.kind),
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

// Continues the exact predecessor `spec.predecessorId` through E17 with `spec.promptSha256` as the
// message, at most one forced call per dispatch, and E38 once after a win. `spec` is
// `{ predecessorId, promptSha256, readSchema, schemaRefusal, refuse(reason), hook(force, reasons),
// seat, label, evidenceForceOnly }`: a deterministic failure goes to `refuse` with the contract's
// reason, an availability or fence loss leaves the work pending. With `evidenceForceOnly` a failed
// or cancelled tip is forced only on unobserved-exit or thread-barrier evidence, and otherwise
// refused with its reason.
async function continueJob(store, stateDir, runDir, spec, ctx) {
  const { predecessorId, refuse: refuseWith } = spec;
  const before = predecessorProblem(readJobView(store, predecessorId));
  if (before === "wait") {
    return { dispatched: false, diagnostics: [] };
  }
  if (before) {
    await refuseWith(before);
    return { dispatched: false, diagnostics: [] };
  }
  let message;
  try {
    message = readObject(runDir, spec.promptSha256, "md").toString("utf8");
  } catch (error) {
    if (error instanceof ObjectDamagedError) {
      await refuseWith("prompt object damaged");
      return { dispatched: false, diagnostics: [] };
    }
    throw error;
  }
  const outputSchema = spec.readSchema();
  if (!outputSchema) {
    await refuseWith(spec.schemaRefusal);
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
              withinDecision: spec.hook(force, reasons)
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
      if (asked && !force && spec.evidenceForceOnly && !forceEvidenceSeen(store, predecessorId, asked)) {
        await refuseWith(forcedRefusal(error) ?? "thread barrier");
        return { dispatched: false, diagnostics: [] };
      }
      if (asked && !force) {
        force = true;
        reasons = asked;
        continue;
      }
      if (asked && force) {
        await refuseWith(forcedRefusal(error) ?? "thread barrier");
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
      await refuseWith(reason);
      return { dispatched: false, diagnostics: [] };
    }
    testPoint(POINTS.afterDecide);
    if (result.won) {
      await launchAfterWin(store, stateDir, result.successorId, ctx);
      const diagnostics = result.labelDropped ? [{ seat: spec.seat, jobId: result.successorId, label: spec.label }] : [];
      return { dispatched: true, jobId: result.successorId, diagnostics };
    }
    if (!result.successorId) {
      await refuseWith("continuation lost");
    }
    return { dispatched: false, diagnostics: [] };
  }
}

// Whether a continuation asked to force may use force on extension work: the reasons or the exact
// predecessor show an unobserved provider exit or a thread barrier.
function forceEvidenceSeen(store, predecessorId, asked) {
  if (asked.includes("provider-exit-unobserved") || asked.includes("thread-barrier")) {
    return true;
  }
  const row = readJobView(store, predecessorId)?.row;
  return Boolean(row && (row.provider_exit_unobserved === 1 || row.release_kind === "unobserved"));
}

async function dispatchContinue(store, stateDir, runDir, attempt, ctx) {
  const predecessorId = attempt.predecessor_id;
  return continueJob(
    store,
    stateDir,
    runDir,
    {
      predecessorId,
      promptSha256: attempt.prompt_sha256,
      readSchema: () => readRoundSchema(attempt.round, ctx.run?.kind),
      schemaRefusal: "invalid round schema",
      refuse: (reason) => refuse(store, attempt, reason, ctx),
      hook: (force, reasons) => continueBindingHook({ attemptId: attempt.id, predecessorId, force, reasons, layer: ctx.layer }),
      seat: attempt.seat,
      label: ctx.seat?.label ?? null,
      evidenceForceOnly: false
    },
    ctx
  );
}

/**
 * Issues one reserved provider follow-up `turn`: continues its exact predecessor through E17 with
 * the extension decision hook and the follow-up answer schema; a deterministic failure records the
 * turn's exact refusal, which the reducer settles. A failed or cancelled predecessor is forced only
 * on unobserved-exit or thread-barrier evidence. `deps` is `{ run, seat, deadline }` plus the
 * optional `launch`, `decideNext` and `readRequester`. Resolves to `{ dispatched, jobId?, diagnostics }`.
 */
export async function dispatchFollowup(store, stateDir, runDir, turn, deps) {
  const predecessorId = turn.predecessor_id;
  return continueJob(
    store,
    stateDir,
    runDir,
    {
      predecessorId,
      promptSha256: turn.prompt_sha256,
      readSchema: readFollowupSchema,
      schemaRefusal: "invalid follow-up schema",
      refuse: (reason) => depositExtensionRefusal(store, { intentId: turn.id, reason, deadline: deps.deadline }),
      hook: (force, reasons) => extensionDecisionHook({ intentId: turn.id, predecessorId, force, reasons }),
      seat: turn.seat,
      label: deps.seat?.label ?? null,
      evidenceForceOnly: true
    },
    deps
  );
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
  // The stops of extension turns: the acknowledgement commits inside the stop request (P3).
  for (const stop of pendingExtensionStops(snapshot?.ext)) {
    const stamp = stamps.get(stop.jobId);
    const waitFor = (ms) => {
      pending += 1;
      nextRetryMs = nextRetryMs === null ? ms : Math.min(nextRetryMs, ms);
    };
    if (stamp !== undefined && now() - stamp < STOP_RETRY_MS) {
      waitFor(STOP_RETRY_MS - (now() - stamp));
      continue;
    }
    const sessionId = run.session_id ?? (await requesterOf(deps)).sessionId ?? null;
    testPoint(POINTS.beforeStop);
    try {
      await retried(
        (opts) =>
          (deps.requestStop ?? requestStop)(
            store,
            { jobIds: [stop.jobId] },
            { reason: "cancel", sessionId, cancel: true, afterMs: 4000, withinStop: extensionStopHook({ intentId: stop.turnId, jobId: stop.jobId }) },
            opts
          ),
        deps.deadline
      );
    } catch (error) {
      stamps.set(stop.jobId, now());
      if (error instanceof CouncilStopSelectionError) {
        errors.push({ error: "store-error", jobId: stop.jobId, message: error.message });
      } else if (!(error instanceof StoreError)) {
        throw error;
      }
      waitFor(STOP_RETRY_MS);
      continue;
    }
    stamps.set(stop.jobId, now());
    testPoint(POINTS.afterStop);
    if (pendingExtensionStops(readCouncil(store, run.id)?.ext).some((entry) => entry.turnId === stop.turnId)) {
      waitFor(STOP_RETRY_MS);
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
    const text = renderRepairPrompt({
      basePrompt: basePromptOf(runDir, snapshot, attempt),
      errors,
      schemaText: fs.readFileSync(roundSchemaPath(attempt.round, snapshot.run.kind), "utf8")
    });
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
  const context = validationContext(runDir, snapshot, attempt.seat, attempt.round);
  const bytes = normalizeAnswerBytes(roundSchemaName(attempt.round, context.kind), Buffer.from(String(row.result_json), "utf8"));
  const answerSha256 = installObject(runDir, bytes, "json");
  let answer;
  try {
    answer = JSON.parse(bytes.toString("utf8"));
  } catch {
    answer = undefined;
  }
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
 * When the replacement prompt of an invalid or transient verdict cannot be prepared (a missing or
 * damaged object, an unreadable file), the job is deposited as the permanent failure
 * `replacement prompt unavailable` and `deps.diagnostics` gets `{ seat, jobId, problem, message }`.
 * Resolves to the number of observations deposited.
 */
// The council reads the end of its seat jobs itself, so the job is recorded as returned to a
// waiting command and the session's monitor prints no line for it. A failed write changes nothing
// for the council; the monitor then prints the line.
function markSeatJobDelivered(store, row) {
  if (!row || row.end_state === null || row.delivered_at !== null) {
    return;
  }
  try {
    markDelivered(store, row.id);
  } catch {
    // The store was busy.
  }
}

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
    markSeatJobDelivered(store, row);
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
    try {
      verdict = withReplacement(runDir, snapshot, attempt, verdict, deps.layer);
    } catch (error) {
      if (!(error instanceof ObjectDamagedError) && typeof error?.code !== "string") {
        throw error;
      }
      // Without its replacement prompt the verdict cannot take a repair or retry: it is deposited
      // as a permanent failure, which the deposit rules accept without a prepared digest.
      deps.diagnostics?.push({ seat: attempt.seat, jobId: attempt.job_id, problem: "replacement-unavailable", message: error.message });
      verdict = { outcome: "failure", eventAt: verdict.eventAt, reason: "replacement prompt unavailable", transient: false };
    }
    const result = await depositObservation(store, { attemptId: attempt.id, jobId: attempt.job_id, verdict, layer: deps.layer, deadline: deps.deadline });
    if (result.ok) {
      deposited += 1;
      testPoint(POINTS.afterDeposit);
    }
  }
  return deposited;
}

// The decision context a follow-up answer is checked against.
function followupContext(snapshot) {
  return { kind: snapshot.run.kind, options: JSON.parse(snapshot.run.options_json ?? "[]") };
}

// The verdict of follow-up reply bytes or a completed job's structured output: a valid answer is
// installed in its canonical form `{ answer, stance? }`, an invalid one with its errors.
function followupAnswerVerdict(runDir, snapshot, text, eventAt) {
  let answer;
  try {
    answer = JSON.parse(text);
  } catch {
    answer = undefined;
  }
  const checked = answer === undefined ? { ok: false, errors: ["answer: not valid JSON"] } : validateFollowupAnswer(sanitizeAgentValue(answer), followupContext(snapshot));
  if (checked.ok) {
    return { outcome: "valid", eventAt, answerSha256: installObject(runDir, `${JSON.stringify(checked.answer)}\n`, "json") };
  }
  return { outcome: "invalid", eventAt, reason: "schema validation failed", errorsSha256: installObject(runDir, `${JSON.stringify(checked.errors)}\n`, "json") };
}

/**
 * Observes the exact job of every issued provider follow-up that has no deposit: classifies it,
 * checks a completed timely job's structured output as a follow-up answer, and deposits the
 * observation (after the turn's finish it is historical). A failed or interrupted job first needs
 * its usage read, started once per command and never awaited here. Resolves to the number of
 * observations deposited.
 */
export async function observeFollowups(store, runDir, snapshot, deps) {
  deps.usage ??= new Map();
  const byTurn = eventsByTurn(snapshot.ext?.events ?? []);
  let deposited = 0;
  for (const turn of snapshot.ext?.turns ?? []) {
    const events = byTurn.get(turn.id) ?? {};
    const jobId = events.issue?.job_id ?? null;
    if (turn.kind !== "followup" || !jobId || events.deposit) {
      continue;
    }
    const row = readJobView(store, jobId)?.row ?? null;
    const cls = classifyJob({ row, T: snapshot.run.timeout_ms });
    if (!cls) {
      continue;
    }
    markSeatJobDelivered(store, row);
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
        if (row.result_json_too_large) {
          verdict = { outcome: "invalid", eventAt: cls.eventAt, reason: "structured output too large" };
        } else if (row.result_json === null || row.result_json === undefined) {
          verdict = { outcome: "invalid", eventAt: cls.eventAt, reason: "missing structured output" };
        } else {
          verdict = followupAnswerVerdict(runDir, snapshot, String(row.result_json), cls.eventAt);
        }
        break;
      default: {
        const seat = seatOf(snapshot, turn.seat);
        const entry = deps.usage.get(jobId) ?? startUsageRead(jobId, seat.family, snapshot.run, deps);
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
          verdict = { outcome: "failure", eventAt: cls.eventAt, reason: failureReason(row, failure) };
        }
      }
    }
    const result = await depositExtensionObservation(store, { intentId: turn.id, jobId, verdict, deadline: deps.deadline });
    if (result.ok) {
      deposited += 1;
      testPoint(POINTS.afterDeposit);
    }
  }
  return deposited;
}

// Whether a follow-up of the run has no finish yet.
function followupsOpen(snapshot) {
  const byTurn = eventsByTurn(snapshot.ext?.events ?? []);
  return (snapshot.ext?.turns ?? []).some((turn) => followupOpen(turn, byTurn));
}

// The reserved provider follow-ups that may still be issued at `t`.
function issuableFollowups(snapshot, t) {
  const byTurn = eventsByTurn(snapshot.ext?.events ?? []);
  return (snapshot.ext?.turns ?? []).filter((turn) => {
    const events = byTurn.get(turn.id) ?? {};
    return turn.kind === "followup" && turn.predecessor_id && !events.issue && !events.refusal && !events.finish && t < turn.issue_by;
  });
}

/**
 * Drives the run's open follow-ups after Round 2 closed, until none is open, a new prompt is
 * ready, or the command deadline comes: each pass reduces (X1 to X8 for the run), sends the
 * pending exact stops, issues reserved provider follow-ups, observes their ended jobs and reduces
 * again; E43 runs every 10 seconds. Between passes it waits on the first of the usage reads in
 * flight, POLL_MS and the stop retry delay, through the injected `sleep(ms)`. With `once` it
 * returns after the first pass. Resolves to `{ wake, deliveries, diagnostics, errors, notes }`,
 * `wake` being `closed` (no follow-up open), `prompt`, `budget`, or null after a single pass.
 */
export async function advanceFollowups(runDir, options) {
  const { runId, layer = 0, deadline, extensions = {} } = options;
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
    launch: options.launch,
    decideNext: options.decideNext,
    requestStop: options.requestStop,
    stamps: options.stamps ?? new Map(),
    usage: new Map(),
    diagnosticLines: [],
    diagnostics: []
  };
  const errors = [];
  let lastReconcile = null;
  let initialDeliveries = null;
  const result = (wake, deliveries) => ({ wake, deliveries, diagnostics: deps.diagnostics, errors, notes: deps.diagnosticLines });
  const reduce = () => reduceRun(store, { runId, round: 2, layer, extensions, deadline });
  try {
    for (;;) {
      let snapshot = readCouncil(store, runId);
      initialDeliveries ??= new Set(openDeliveries(snapshot, runDir, Math.max(snapshot.run.clock, wallNow())).map((delivery) => delivery.intentId));
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
      await reduce();
      const stopped = await dispatchStops(store, snapshot.run, deps);
      errors.push(...stopped.errors);
      snapshot = readCouncil(store, runId);
      for (const turn of issuableFollowups(snapshot, Math.max(snapshot.run.clock, wallNow()))) {
        const outcome = await dispatchFollowup(store, stateDir, runDir, turn, { ...deps, run: snapshot.run, seat: seatOf(snapshot, turn.seat) });
        deps.diagnostics.push(...outcome.diagnostics);
      }
      snapshot = readCouncil(store, runId);
      await observeFollowups(store, runDir, snapshot, deps);
      await reduce();
      snapshot = readCouncil(store, runId);
      const deliveries = openDeliveries(snapshot, runDir, Math.max(snapshot.run.clock, wallNow()));
      if (!followupsOpen(snapshot)) {
        return result("closed", deliveries);
      }
      if (deliveries.some((delivery) => !initialDeliveries.has(delivery.intentId))) {
        return result("prompt", deliveries);
      }
      if (options.once) {
        return result(null, deliveries);
      }
      let delay = POLL_MS;
      const stopRetry = (await dispatchStopsDelay(store, snapshot.run, deps)) ?? null;
      if (stopRetry !== null) {
        delay = Math.min(delay, stopRetry);
      }
      if (now() + delay >= deadline) {
        return result("budget", deliveries);
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

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

// The prompts of issued Claude extension turns (stand-ins, carries and follow-ups) that are open
// at `t`: no deposit or finish, before the turn's own deadline, for a stand-in or carry an open
// round, and for a carry before a sealed round's cutoff. A stand-in asked after the cutoff keeps
// its own full time. A follow-up delivery has `round: 2`, its actor and `kind: "followup"`.
function extensionDeliveries(snapshot, runDir, t) {
  const ext = snapshot.ext ?? { turns: [], events: [] };
  const byTurn = eventsByTurn(ext.events);
  const rounds = new Map(snapshot.rounds.map((row) => [row.round, row]));
  const deliveries = [];
  let round2Panel = null;
  for (const turn of ext.turns) {
    const roundRow = rounds.get(turn.round);
    const { issue, deposit, finish } = turnState(turn, byTurn);
    if (turn.kind === "followup") {
      // A Claude follow-up goes to the actor that gave the seat's Round 2 answer.
      if (!issue || issue.job_id !== null || deposit || finish || t >= turn.issue_by) {
        continue;
      }
      round2Panel ??= effectivePanel(snapshot, 2);
      deliveries.push({
        seat: turn.seat,
        intentId: turn.id,
        promptFile: path.join(runDir, "objects", `${turn.prompt_sha256}.md`),
        deadline: new Date(turn.issue_by).toISOString(),
        round: 2,
        actor: round2Panel.find((entry) => entry.seat === turn.seat)?.actor ?? turn.seat,
        kind: "followup",
        sort: [2, turn.seat, 1, turn.created_at, turn.id]
      });
      continue;
    }
    if (!roundRow || roundRow.closed_at !== null || !issue || issue.job_id !== null || deposit || finish || t >= turn.issue_by) {
      continue;
    }
    if (turn.kind === "carry" && roundRow.cutoff_at !== null && t >= roundRow.cutoff_at) {
      continue;
    }
    deliveries.push({
      seat: turn.seat,
      intentId: turn.id,
      promptFile: path.join(runDir, "objects", `${turn.prompt_sha256}.md`),
      deadline: new Date(turn.issue_by).toISOString(),
      round: turn.round,
      actor: turnActor(turn),
      sort: [turn.round, turn.seat, 1, turn.created_at, turn.id]
    });
  }
  return deliveries;
}

/**
 * The prompts a seat's agent should answer now: current, unretired, unanswered and open (before
 * its own deadline and before a sealed round's cutoff), then the open prompts of Claude extension
 * turns, which add `round` and `actor` (`<seat>~r<round>` of the stand-in; a carry keeps its Round
 * 1 key). Sorted by round, seat, core before extension, creation time, then id.
 */
export function openDeliveries(snapshot, runDir, t) {
  const observed = new Set(snapshot.observations.map((row) => row.attempt_id));
  const closed = new Set(snapshot.rounds.filter((row) => row.closed_at !== null || (row.cutoff_at !== null && t >= row.cutoff_at)).map((row) => row.round));
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
      seat: attempt.seat,
      intentId: attempt.id,
      promptFile: path.join(runDir, "objects", `${attempt.prompt_sha256}.md`),
      deadline: new Date(attempt.issue_by).toISOString(),
      sort: [attempt.round, attempt.seat, 0, attempt.created_at, attempt.id]
    });
  }
  deliveries.push(...extensionDeliveries(snapshot, runDir, t));
  const compare = (a, b) => {
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) {
        return a[index] < b[index] ? -1 : 1;
      }
    }
    return 0;
  };
  return deliveries.sort((a, b) => compare(a.sort, b.sort)).map(({ sort: _sort, ...delivery }) => delivery);
}

// ---------------------------------------------------------------------------------------------
// The cutoff notice: once a round is sealed, each seat still working is told once that the other
// seats have answered. A run-folder marker, created exclusively, records that a seat's notice of a
// round was handled, so no second command hands or sends it again.

function noticeMarker(runDir, round, seat) {
  return path.join(runDir, "notices", `${round}-${seat}.json`);
}

// Creates the marker of a seat's notice; false when another command already created it.
function claimNotice(runDir, round, seat, record) {
  const file = noticeMarker(runDir, round, seat);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
  try {
    fs.writeSync(fd, `${JSON.stringify(record)}\n`);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

// The seats of sealed, open rounds that are still working before the cutoff at `t`, each with its
// current attempt.
function noticeCandidates(snapshot, t) {
  const sealed = new Set(snapshot.rounds.filter((row) => row.closed_at === null && row.cutoff_at !== null && t < row.cutoff_at).map((row) => row.round));
  const attempts = new Map(snapshot.attempts.map((row) => [row.id, row]));
  return snapshot.seatRounds
    .filter((row) => sealed.has(row.round) && (row.state === "running" || row.state === "issuing") && row.current_id)
    .map((row) => ({ round: row.round, seat: row.seat, attempt: attempts.get(row.current_id) }))
    .filter((entry) => entry.attempt && entry.attempt.retired_at === null);
}

// Whom a cutoff notice goes to in the text output: the seat, or the carried stand-in of the seat.
function noticeTarget(notice) {
  return notice.actor ? `${notice.seat} (stand-in ${notice.actor})` : notice.seat;
}

/**
 * The cutoff notices the leader delivers to Claude seats: for each Claude seat of a sealed, open
 * round whose prompt is open at `t`, the first call claims the seat's marker and returns
 * `{ kind: "notice", seat, text }`; later calls, from any command, return nothing for it. A
 * carried stand-in whose Round 2 prompt is open gets the same notice once, with its `actor`.
 */
export function claudeNotices(snapshot, runDir, t) {
  const open = new Set(openDeliveries(snapshot, runDir, t).map((delivery) => delivery.intentId));
  const notices = [];
  for (const entry of noticeCandidates(snapshot, t)) {
    if (entry.attempt.kind !== "prompt" || !open.has(entry.attempt.id)) {
      continue;
    }
    if (claimNotice(runDir, entry.round, entry.seat, { kind: "leader", attemptId: entry.attempt.id })) {
      notices.push({ kind: "notice", seat: entry.seat, text: CUTOFF_NOTICE });
    }
  }
  // A carry is subject to the cutoff of its sealed round, like an original Claude seat.
  const sealed = new Set(snapshot.rounds.filter((row) => row.closed_at === null && row.cutoff_at !== null && t < row.cutoff_at).map((row) => row.round));
  for (const turn of snapshot.ext?.turns ?? []) {
    if (turn.kind !== "carry" || !sealed.has(turn.round) || !open.has(turn.id)) {
      continue;
    }
    if (claimNotice(runDir, turn.round, turn.seat, { kind: "leader", intentId: turn.id })) {
      notices.push({ kind: "notice", seat: turn.seat, actor: turnActor(turn), text: CUTOFF_NOTICE });
    }
  }
  return notices;
}

/**
 * Sends the cutoff notice into the running turn of each provider seat of a sealed, open round,
 * once per seat and round. The first look at a seat after the seal decides: only a running job
 * at its chain's tip, on a provider whose driver takes a message into a running turn
 * (`capabilities.steer`), gets the message through the plugin's message path; any other seat gets
 * none, now or later. A failed send is a diagnostic `{ seat, jobId, notice, message }` and changes
 * nothing in the round. Resolves to the diagnostics.
 */
export async function sendProviderNotices(store, runDir, snapshot, t, deps) {
  const diagnostics = [];
  for (const entry of noticeCandidates(snapshot, t)) {
    if (entry.attempt.kind === "prompt" || fs.existsSync(noticeMarker(runDir, entry.round, entry.seat))) {
      continue;
    }
    const jobId = entry.attempt.job_id;
    const view = jobId ? readJobView(store, jobId) : null;
    const takesMessage =
      view !== null && view.isTip && view.state === "running" && view.row.cancel_requested_at === null && Boolean(providerForJob(view.row).capabilities?.steer);
    if (!claimNotice(runDir, entry.round, entry.seat, { kind: takesMessage ? "message" : "none", jobId })) {
      continue;
    }
    if (!takesMessage) {
      continue;
    }
    const failed = (message) => diagnostics.push({ seat: entry.seat, jobId, notice: "not-sent", message });
    try {
      const requester = await requesterOf(deps);
      const outcome = await retried(
        (opts) => (deps.sendMessage ?? sendToChain)(store, { ref: jobId, observedTipId: jobId }, { text: CUTOFF_NOTICE, requester }, opts),
        deps.deadline
      );
      fs.writeFileSync(noticeMarker(runDir, entry.round, entry.seat), `${JSON.stringify({ kind: "message", jobId, messageId: outcome.messageId })}\n`);
      if (outcome.outcome === "continued") {
        // The job ended between the look and the send, and the message started a new job: the
        // council started that job, so it stops it by its exact id.
        failed(`The job had ended; the notice started job ${outcome.jobId}, which is stopped.`);
        await retried(
          (opts) => (deps.requestStop ?? requestStop)(store, { jobIds: [outcome.jobId] }, { reason: "cancel", sessionId: requester.sessionId ?? null, cancel: true }, opts),
          deps.deadline
        );
      } else if (outcome.outcome !== "running") {
        failed("The job was no longer running; the notice stays pending and is withdrawn later.");
      }
    } catch (error) {
      if (error instanceof TypeError || error instanceof ReferenceError) {
        throw error;
      }
      failed(error?.message ?? String(error));
    }
  }
  return diagnostics;
}

/**
 * Withdraws each cutoff notice message of the run that no worker took while its job's turn was
 * running, so a job that ended first is not continued by it. Best effort: a store error leaves the
 * message for a later command.
 */
export async function withdrawStaleNotices(store, runDir, deadline) {
  let names;
  try {
    names = fs.readdirSync(path.join(runDir, "notices"));
  } catch {
    return;
  }
  for (const name of names) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(runDir, "notices", name), "utf8"));
    } catch {
      continue;
    }
    if (!Number.isInteger(record?.messageId)) {
      continue;
    }
    try {
      const outcome = readMessageOutcome(store, record.messageId);
      if (outcome?.state === "pending" && outcome.tipState !== "running" && outcome.tipState !== "queued") {
        await retried((opts) => withdrawMessage(store, record.messageId, opts), deadline);
      }
    } catch (error) {
      if (!(error instanceof StoreError)) {
        throw error;
      }
    }
  }
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
 * the injected `sleep(ms)`. With `once` it returns after the first pass. Once the round is sealed,
 * each pass sends the cutoff notice to provider seats (`sendProviderNotices`) and hands it for
 * Claude seats (`claudeNotices`) after the prompt deliveries. Resolves to `{ wake, nextDue,
 * deliveries, diagnostics, errors, notes }`, `wake` being `closed`, `prompt`, `notice`, `budget`,
 * or null after a single pass or for a refusal (`errors[0].error` is `unknown-run` or
 * `round-not-started`); `notes` are launch lines for standard error.
 */
export async function advance(runDir, options) {
  const { runId, round, layer = 0, deadline, extensions = {}, consent = null } = options;
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
    sendMessage: options.sendMessage,
    stamps: options.stamps ?? new Map(),
    usage: new Map(),
    diagnosticLines: [],
    diagnostics: []
  };
  const diagnostics = deps.diagnostics;
  const errors = [];
  let lastReconcile = null;
  let initialDeliveries = null;
  // Cutoff notices handed to the leader in this call; they follow the prompt deliveries.
  const notices = [];
  const result = (wake, nextDue, deliveries) => ({ wake, nextDue, deliveries: [...deliveries, ...notices], diagnostics, errors, notes: deps.diagnosticLines });
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
      // A notice no running turn took is withdrawn before E43 could continue its ended job.
      await withdrawStaleNotices(store, runDir, deadline);
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
      // Before a due cutoff is adjudicated, deposit what already ended (no usage read is awaited).
      const cutoffAt = snapshot.rounds.find((row) => row.round === round).cutoff_at;
      if (cutoffAt !== null && t0 >= cutoffAt) {
        await observeJobs(store, runDir, snapshot, deps);
      }
      await reduceIfNeeded(store, { runId, round, layer, deadline, extensions, consent, runDir });
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
      const peek = await reduceIfNeeded(store, { runId, round, layer, deadline, extensions, consent, runDir });
      snapshot = readCouncil(store, runId);
      const t = Math.max(snapshot.run.clock, wallNow());
      const deliveries = openDeliveries(snapshot, runDir, t);
      if (snapshot.rounds.find((row) => row.round === round).closed_at !== null) {
        return result("closed", null, deliveries);
      }
      const nextDue = peek?.nextDue ?? null;
      diagnostics.push(...(await sendProviderNotices(store, runDir, snapshot, t, deps)));
      notices.push(...claudeNotices(snapshot, runDir, t));
      if (deliveries.some((delivery) => !initialDeliveries.has(delivery.intentId))) {
        return result("prompt", nextDue, deliveries);
      }
      if (notices.length > 0) {
        return result("notice", nextDue, deliveries);
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
  const pendingJobs = [
    ...snapshot.stops.filter((stop) => stop.acknowledged_at === null).map((stop) => stop.job_id),
    ...pendingExtensionStops(snapshot.ext).map((stop) => stop.jobId)
  ];
  for (const jobId of pendingJobs) {
    const stamp = deps.stamps.get(jobId);
    const wait = stamp === undefined ? 0 : Math.max(0, STOP_RETRY_MS - (deps.now() - stamp));
    delay = delay === null ? wait : Math.min(delay, wait);
  }
  return delay;
}

// The Round 1 answers of the effective panel by actor key, and the author rows buildBundles
// scrubs: each valid original seat and each Round 1 stand-in that answered validly.
function round1Actors(runDir, snapshot, jobModels = () => []) {
  const panel = effectivePanel(snapshot, 1).filter((entry) => entry.valid);
  const seatRows = new Map(snapshot.seats.map((row) => [row.seat, row]));
  const answers = {};
  const rows = [];
  for (const entry of panel) {
    answers[entry.actor] = readJsonObject(runDir, entry.answerSha256);
    const seat = seatRows.get(entry.seat);
    rows.push(
      entry.kind === "original"
        ? { seat: entry.seat, family: seat.family, label: seat.label, model: seat.model, identities: jobModels(entry.seat) }
        : { seat: entry.actor, family: "claude", label: null, model: null, identities: [entry.seat] }
    );
  }
  return { panel, answers, rows };
}

/**
 * The stand-in prompt of each seat of `round` that may get one now (an original seat round that
 * ended without a valid answer, with no extension turn in the round, while the round has no
 * substitution decision), installed as an object: `{ seat: digest }`, with null for a seat whose
 * prompt cannot be prepared (a missing or damaged object). Round 1 is the seat's Round 1 prompt
 * for its lens; Round 2 answers the seat's `$alternates` bundle, which leaves out that seat's own
 * Round 1 findings, with no own findings of its own. Both sit under the stand-in preface.
 * `jobModels(seat)` gives the model names a seat's Round 1 jobs recorded, which the alternate
 * bundle scrubs as the primary bundles do.
 */
export function prepareStandIns(runDir, snapshot, round, jobModels = () => []) {
  const roundRow = snapshot.rounds.find((row) => row.round === round);
  const decided = (snapshot.ext?.decisions ?? []).some((row) => row.kind === "substitution" && row.scope === round);
  if (!roundRow || roundRow.closed_at !== null || decided) {
    return {};
  }
  const seatRounds = snapshot.seatRounds.filter((row) => row.round === round);
  const states = new Map(seatRounds.map((row) => [row.seat, row.state]));
  const candidates = substitutionCandidates(seatRounds, states, (snapshot.ext?.turns ?? []).filter((turn) => turn.round === round));
  if (candidates.length === 0) {
    return {};
  }
  const prepared = {};
  for (const seat of candidates) {
    try {
      const lens = snapshot.seats.find((row) => row.seat === seat).lens;
      const brief = readObject(runDir, snapshot.run.brief_sha256, "md").toString("utf8");
      let basePrompt;
      const kind = snapshot.run.kind;
      if (round === 1) {
        basePrompt = renderRound1Prompt({ brief, lens, kind, schemaText: fs.readFileSync(roundSchemaPath(1, kind), "utf8") });
      } else {
        const mapping = readJsonObject(runDir, roundRow.map_sha256);
        const letterMap = mapping.$alternates?.[actorKey(seat, 2)];
        if (!letterMap) {
          prepared[seat] = null;
          continue;
        }
        const { answers, rows } = round1Actors(runDir, snapshot, jobModels);
        const bundle = bundleFromMap(rows, answers, letterMap, { runId: snapshot.run.id });
        // A fresh stand-in sees every Round 1 answer, the replaced seat's included, none as its own.
        basePrompt = renderRound2Prompt({
          brief,
          lens,
          ownFindings: [],
          bundle,
          schemaText: fs.readFileSync(roundSchemaPath(2, kind), "utf8"),
          kind,
          answers: answersInOwnWords(kind) ? answerBundle(rows, answers, standInAnswerMap(mapping, actorKey(seat, 2)), null, { runId: snapshot.run.id }) : []
        });
      }
      prepared[seat] = installObject(runDir, renderSubstitutePrompt({ basePrompt }), "md");
    } catch (error) {
      if (!(error instanceof ObjectDamagedError) && typeof error?.code !== "string") {
        throw error;
      }
      prepared[seat] = null;
    }
  }
  return prepared;
}

// The model names each seat's Round 1 jobs recorded, by seat: a seat started without a model
// override still ran on some model, and that name is scrubbed from the other seats' bundles too.
function recordedModels(store, snapshot) {
  return (seat) =>
    snapshot.attempts
      .filter((row) => row.seat === seat && row.round === 1 && row.job_id)
      .map((row) => readJobView(store, row.job_id)?.row.model)
      .filter(Boolean);
}

// Reduces the round only when the reducer has a row to write; resolves to the read-only peek
// after any reduction (its `nextDue` is the next wake). With substitution on, each look first
// prepares the stand-in prompts the current snapshot calls for, and a reduction that makes a new
// seat a candidate is followed by one more look.
async function reduceIfNeeded(store, { runId, round, layer, deadline, extensions = {}, consent = null, runDir = null }) {
  let peek = null;
  for (let pass = 0; pass < 3; pass += 1) {
    const snapshot = extensions.substitution && runDir ? readCouncil(store, runId) : null;
    const prepared = snapshot ? prepareStandIns(runDir, snapshot, round, recordedModels(store, snapshot)) : {};
    const options = { runId, round, layer, extensions, consent, prepared };
    peek = peekRound(store, options);
    if (!peek || peek.writes.length === 0) {
      return peek;
    }
    await reduceRun(store, { ...options, deadline });
  }
  return peekRound(store, { runId, round, layer, extensions, consent });
}

// ---------------------------------------------------------------------------------------------
// The council subcommands.

export const usage =
  "council start --brief <file> [--kind review|decision|question|open] [--seat <family>:<lens>]... [--model <family>=<value>]... [--timeout-ms <ms>] [--json]" +
  " | collect <run-id> --round 1|2 [--disallow-substitute] [--budget-ms <ms>] [--json]" +
  " | submit <run-id> <seat> --intent <intent-id> [--round 1|2] --file <answer.json> [--json]" +
  " | crossexam <run-id> [--json] | merge <run-id> [--json]" +
  " | followup <run-id> <seat> --finding <cluster-id|stance> [--] <question> [--json]" +
  " | verdict <run-id> <cluster-id|claim-id> verified|rejected|not-checked [--strongest <n>] [--] [reason]" +
  " | verdict <run-id> agreement agreed|partly|disagreed [--merge <sha256>] [--] <reason>" +
  " | export <run-id> brief|map|merge|report|followups [--json] | status <run-id> [--json] | report <run-id> [--json]";

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
  if (!COUNCIL_KINDS.includes(kind)) {
    fail('"kind" must be "review", "decision", "question" or "open".');
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
    if (entry.notice) {
      io.stderr(`Seat ${entry.seat}: the cutoff notice was not delivered to job ${entry.jobId} (${entry.message}).\n`);
      continue;
    }
    if (entry.problem === "replacement-unavailable") {
      io.stderr(`Seat ${entry.seat}: job ${entry.jobId} ended without a repair or retry, because its replacement prompt could not be prepared (${entry.message}).\n`);
      continue;
    }
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
 * reason, jobId, answerSha256, forcedReasons }`; `closedAt` and `quorum` are null while open. At
 * `layer` 2 or more it also has `quorumAt` and `cutoffAt`, null until the round is sealed.
 * `validSeats` counts the round's effective panel (a valid original, else a valid stand-in or
 * carry for that seat), `validFamilies` the families of its valid originals only, and
 * `memberTurns` the round's issued turns, stand-ins and carries included. With substitution on
 * (`extensions.substitution`) it also has `families` (the sorted quorum families),
 * `substitutions`, `substitutionDecision` (`null`, `accept`, `decline` or `capacity`) and
 * `substitutionOptIn`.
 */
export function roundObject(snapshot, round, { layer = 0, extensions = {} } = {}) {
  const roundRow = snapshot.rounds.find((row) => row.round === round);
  const seats = new Map(snapshot.seats.map((row) => [row.seat, row]));
  const attempts = new Map(snapshot.attempts.map((row) => [row.id, row]));
  const seatRounds = snapshot.seatRounds.filter((row) => row.round === round);
  const panel = effectivePanel(snapshot, round);
  const families = quorumFamilies(panel, familySort);
  const roundJobs = new Set(snapshot.attempts.filter((row) => row.round === round && row.job_id).map((row) => row.job_id));
  const charges = snapshot.charges.rounds[round] ?? { turn: 0, repair: 0, retry: 0 };
  const extIssued = snapshot.ext?.issued.rounds[round] ?? 0;
  const substitution = extensions.substitution
    ? {
        families,
        substitutions: substitutionEntries(snapshot, round),
        substitutionDecision: snapshot.ext.decisions.find((row) => row.kind === "substitution" && row.scope === round)?.decision ?? null,
        substitutionOptIn: snapshot.ext.requests.some((row) => {
          const payload = JSON.parse(row.payload);
          return row.kind === "collect" && payload.round === round && payload.substitution === "allow";
        })
      }
    : {};
  return {
    runId: snapshot.run.id,
    round,
    closedAt: isoOrNull(roundRow.closed_at),
    quorum: roundRow.closed_at === null ? null : roundRow.quorum === 1,
    ...(layer >= 2 ? { quorumAt: isoOrNull(roundRow.quorum_at), cutoffAt: isoOrNull(roundRow.cutoff_at) } : {}),
    validSeats: panel.filter((entry) => entry.valid).length,
    validFamilies: families.length,
    ...substitution,
    cleanupPending: snapshot.stops.some((stop) => stop.acknowledged_at === null && roundJobs.has(stop.job_id)),
    memberTurns: charges.turn + extIssued,
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

/** The model a Claude stand-in runs on: the `council-member` agent's model. */
const STAND_IN_MODEL = "opus";

/**
 * The stand-ins and carries of a round (every round when `round` is null), in round and seat
 * order: `{ seat, round, actor, kind, family: "claude", model, lens, state, reason, intentId,
 * issuedAt }`, `state` being `issued` until the turn's finish gives its outcome.
 */
export function substitutionEntries(snapshot, round = null) {
  const ext = snapshot.ext ?? { turns: [], events: [] };
  const byTurn = eventsByTurn(ext.events);
  const lens = new Map(snapshot.seats.map((row) => [row.seat, row.lens]));
  return ext.turns
    .filter((turn) => (turn.kind === "substitute" || turn.kind === "carry") && (round === null || turn.round === round))
    .sort((a, b) => a.round - b.round || (a.seat < b.seat ? -1 : a.seat > b.seat ? 1 : 0))
    .map((turn) => {
      const { state, issue, finish } = turnState(turn, byTurn);
      return {
        seat: turn.seat,
        round: turn.round,
        actor: turnActor(turn),
        kind: turn.kind,
        family: "claude",
        model: STAND_IN_MODEL,
        lens: lens.get(turn.seat),
        state,
        reason: finish?.reason ?? null,
        intentId: turn.id,
        issuedAt: isoOrNull(issue?.at ?? null)
      };
    });
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
  // A JSON result can carry the members' words (answers, findings): its strings are sanitised.
  io.stdout(json ? `${JSON.stringify(sanitizeAgentValue(payload), null, 2)}\n` : text.endsWith("\n") ? text : `${text}\n`);
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
  if (options.kind !== undefined && !COUNCIL_KINDS.includes(options.kind)) {
    throw new CouncilRefusal("invalid-arguments", "--kind must be review, decision, question or open.");
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
  const schemaText = fs.readFileSync(roundSchemaPath(1, brief.kind), "utf8");
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
    // The hook that submits the Claude seat's reply runs in the session's folder, which can be
    // another folder than the one this run was started in; this file names the run's own folder.
    try {
      fs.writeFileSync(path.join(runDir, "workspace.json"), `${JSON.stringify({ cwd })}\n`);
    } catch {
      // The hook then uses the session's folder.
    }
    const passed = await advance(runDir, { runId, round: 1, layer: ctx.layer, extensions: ctx.extensions, deadline, stateDir, once: true, openStore: () => store, ...ctx.advance });
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

async function closedResult(store, runId, round, { runDir, deadline, ctx, json, diagnostics = [] }) {
  const now = ctx.advance?.now ?? (() => performance.now());
  const cleanupDeadline = Math.min(deadline, now() + CLEANUP_BUDGET_MS);
  await withdrawStaleNotices(store, runDir, deadline);
  const pendingLeft = await cleanupStops(store, runId, { deadline, cleanupDeadline, ctx });
  const snapshot = readCouncil(store, runId);
  const object = { ...roundObject(snapshot, round, { layer: ctx.layer, extensions: ctx.extensions }), wake: "closed" };
  object.cleanupPending = pendingLeft || object.cleanupPending;
  if (diagnostics.length > 0) {
    object.diagnostics = diagnostics;
  }
  // A stand-in batch that did not fit the member-turn cap is named, with the decision.
  const decision = snapshot.ext.decisions.find((row) => row.kind === "substitution" && row.scope === round)?.decision ?? null;
  let text = closedText(object);
  if (decision === "capacity") {
    object.substitutionDecision = decision;
    object.message = `The run has reached its cap of ${snapshot.run.turn_cap} member turns.`;
    text = `${text}\nStand-in decision: capacity. ${object.message}`;
  }
  emit(ctx.io, json, object, text);
  return object.quorum ? 0 : 1;
}

// The follow-up part of `council collect <run-id> --round 2` after Round 2 closed: drives the open
// follow-ups, then returns the closed round's result, or wakes on a new prompt or the budget.
async function collectFollowups(store, runId, { runDir, stateDir, deadline, ctx, json }) {
  const outcome = await advanceFollowups(runDir, { runId, layer: ctx.layer, extensions: ctx.extensions, deadline, stateDir, openStore: () => store, readRequester: ctx.readRequester, ...ctx.advance });
  writeDiagnostics(ctx.io, outcome.diagnostics, outcome.notes);
  if (outcome.wake === "closed") {
    return closedResult(store, runId, 2, { runDir, deadline, ctx, json, diagnostics: outcome.diagnostics });
  }
  const wake = outcome.wake === "prompt" ? "prompt" : "budget";
  const payload = {
    runId,
    round: 2,
    wake,
    deliveries: outcome.deliveries,
    ...(outcome.diagnostics.length > 0 ? { diagnostics: outcome.diagnostics } : {})
  };
  const fresh = outcome.deliveries[outcome.deliveries.length - 1];
  emit(ctx.io, json, payload, wake === "prompt" ? `Wake: a follow-up prompt for ${fresh.seat} is ready. Run council status.` : "Wake: budget. Run council collect again.");
  return 0;
}

// `council collect <run-id> --round N`: advances an open round, or returns a closed round's result.
async function collectCouncil(options, positionals, ctx) {
  const now = ctx.advance?.now ?? (() => performance.now());
  const budget = positiveInteger(options["budget-ms"], "budget-ms") ?? BUDGET_MS.collect;
  const deadline = now() + budget;
  const runId = positionals[0];
  if (!runId || positionals.length > 1) {
    throw new CouncilRefusal("invalid-arguments", "Usage: council collect <run-id> --round 1|2 [--disallow-substitute] [--budget-ms <ms>] [--json]");
  }
  const round = roundOption(options.round);
  // A plain collect consents to Claude stand-ins; --disallow-substitute declines them.
  const substitution = Boolean(ctx.extensions?.substitution);
  const consent = options["disallow-substitute"] ? "disallow" : null;
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
      // After Round 2, collect drives the open follow-ups until none is open.
      if (round === 2 && followupsOpen(snapshot)) {
        return await collectFollowups(store, runId, { runDir: runDirOf(stateDir, runId), stateDir, deadline, ctx, json: options.json });
      }
      return await closedResult(store, runId, round, { runDir: runDirOf(stateDir, runId), deadline, ctx, json: options.json });
    }
    if (substitution && consent === null) {
      await depositSubstitutionOptIn(store, { runId, round, deadline });
    }
    const outcome = await advance(runDirOf(stateDir, runId), { runId, round, layer: ctx.layer, extensions: ctx.extensions, consent, deadline, stateDir, openStore: () => store, ...ctx.advance });
    writeDiagnostics(ctx.io, outcome.diagnostics, outcome.notes);
    if (outcome.wake === "closed") {
      return await closedResult(store, runId, round, { runDir: runDirOf(stateDir, runId), deadline, ctx, json: options.json, diagnostics: outcome.diagnostics });
    }
    const wake = outcome.wake === "prompt" || outcome.wake === "notice" ? outcome.wake : "budget";
    const standIns = substitution ? substitutionEntries(readCouncil(store, runId), round) : [];
    const payload = {
      runId,
      round,
      wake,
      deliveries: outcome.deliveries,
      ...(standIns.length > 0 ? { substitutions: standIns } : {}),
      ...(outcome.diagnostics.length > 0 ? { diagnostics: outcome.diagnostics } : {})
    };
    const prompts = outcome.deliveries.filter((delivery) => delivery.kind !== "notice");
    const fresh = prompts[prompts.length - 1];
    const lines = [
      wake === "prompt"
        ? `Wake: a ${fresh.actor ? "stand-in " : ""}prompt for ${fresh.seat} is ready. Run council status.`
        : wake === "notice"
          ? "Wake: notice."
          : "Wake: budget. Run council collect again."
    ];
    for (const notice of outcome.deliveries.filter((delivery) => delivery.kind === "notice")) {
      lines.push(`Notice for ${noticeTarget(notice)}: ${notice.text}`);
    }
    const text = lines.join("\n");
    emit(ctx.io, options.json, payload, text);
    return 0;
  } finally {
    store.close();
  }
}

// The receipt verdict of a reply's bytes, with its objects (and at layer 1 or more the repair
// prompt of an invalid reply) installed outside any transaction.
function receiptVerdict(runDir, snapshot, attempt, received, layer) {
  const context = attempt ? validationContext(runDir, snapshot, attempt.seat, attempt.round) : null;
  const bytes = attempt ? normalizeAnswerBytes(roundSchemaName(attempt.round, context.kind), received) : received;
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
  const checked = answer === undefined ? { ok: false, errors: ["answer: not valid JSON"] } : validateAnswer(attempt.round, answer, context);
  if (checked.ok) {
    return { outcome: "valid", answerSha256 };
  }
  const errorsSha256 = installObject(runDir, `${JSON.stringify(checked.errors)}\n`, "json");
  return withReplacement(runDir, snapshot, attempt, { outcome: "invalid", errorsSha256, reason: "schema validation failed" }, layer);
}

// The receipt verdict of a stand-in's or carry's reply: its answer checked as that actor's (a
// carry owns its Round 1 findings, a fresh Round 2 stand-in answers its alternate bundle and owns
// none). An invalid reply has no repair: an extension turn settles once.
function extensionReceiptVerdict(runDir, snapshot, turn, received) {
  const context = validationContext(runDir, snapshot, turn.seat, turn.round, { actor: turnActor(turn) });
  const bytes = normalizeAnswerBytes(roundSchemaName(turn.round, context.kind), received);
  let answer;
  try {
    answer = JSON.parse(bytes.toString("utf8"));
  } catch {
    answer = undefined;
  }
  const answerSha256 = installObject(runDir, bytes, "json");
  const checked = answer === undefined ? { ok: false, errors: ["answer: not valid JSON"] } : validateAnswer(turn.round, answer, context);
  if (checked.ok) {
    return { outcome: "valid", answerSha256 };
  }
  return { outcome: "invalid", errorsSha256: installObject(runDir, `${JSON.stringify(checked.errors)}\n`, "json"), reason: "schema validation failed" };
}

// `council submit` for the intent of a Claude extension turn: the extension receipt, the round's
// reduction and one executor pass. Prints the turn's state (`issued` until it is settled).
async function submitExtension(store, turn, { runId, seat, intentId, bytes, runDir, stateDir, snapshot, deadline, ctx, json }) {
  const verdict = extensionReceiptVerdict(runDir, snapshot, turn, bytes);
  testPoint(POINTS.afterReplyValidation);
  const receipt = await depositExtensionReceipt(store, { runId, seat, intentId, verdict, deadline });
  const round = turn.round;
  testPoint(POINTS.beforeReduce);
  try {
    await reduceRun(store, { runId, round, layer: ctx.layer, extensions: ctx.extensions, deadline });
  } catch (error) {
    if (receipt.ok && error instanceof StoreError) {
      throw new CouncilRefusal("store-error", `The reply for intent ${intentId} was recorded, but the round could not be reduced: ${error.message}`);
    }
    throw error;
  }
  if (!receipt.ok) {
    if (receipt.reason === "duplicate-receipt") {
      throw new CouncilRefusal("duplicate-receipt", `A reply for intent ${intentId} was already recorded.`);
    }
    throw new CouncilRefusal("intent-not-open", `Intent ${intentId} is not open for ${seat}; nothing was recorded.`);
  }
  const passed = await advance(runDir, { runId, round, layer: ctx.layer, extensions: ctx.extensions, deadline, stateDir, once: true, openStore: () => store, ...ctx.advance });
  writeDiagnostics(ctx.io, passed.diagnostics, passed.notes);
  const after = readCouncil(store, runId);
  const state = turnState(turn, eventsByTurn(after.ext.events)).state;
  const actor = turnActor(turn);
  const payload = { runId, round, seat, actor, intentId, state, deliveries: passed.deliveries };
  const lines = [`Recorded the reply of the stand-in ${actor} for ${seat} in round ${round}: ${state}.`];
  for (const delivery of passed.deliveries) {
    if (delivery.kind === "notice") {
      lines.push(`Notice for ${noticeTarget(delivery)}: ${delivery.text}`);
    }
  }
  emit(ctx.io, json, payload, lines.join("\n"));
  return 0;
}

// `council submit <run-id> <seat> --intent <id> --file <answer.json>`: the receipt, then reduction.
async function submitCouncil(options, positionals, ctx) {
  const deadline = performance.now() + BUDGET_MS.submit;
  const [runId, seat] = positionals;
  if (!runId || !seat || positionals.length > 2 || !options.intent || !options.file) {
    throw new CouncilRefusal("invalid-arguments", "Usage: council submit <run-id> <seat> --intent <intent-id> [--round 1|2] --file <answer.json> [--json]");
  }
  const addressedRound = options.round === undefined ? null : roundOption(options.round);
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
    // An extension intent goes to the extension receipt, also when its extension is now off.
    const turn = snapshot.ext.turns.find((row) => row.id === intentId) ?? null;
    // With --round, the intent must belong to that round: a follow-up to round 2, a stand-in or
    // carry to its own round, a core prompt to its attempt's round.
    const intentRound = turn ? (turn.kind === "followup" ? 2 : turn.round) : (snapshot.attempts.find((row) => row.id === intentId)?.round ?? null);
    if (addressedRound !== null && intentRound !== null && intentRound !== addressedRound) {
      throw new CouncilRefusal("intent-not-open", `Intent ${intentId} is not open for ${seat} in round ${addressedRound}; nothing was recorded.`);
    }
    if (turn?.kind === "followup") {
      return await submitFollowup(store, turn, { runId, seat, intentId, bytes, runDir, snapshot, deadline, ctx, json: options.json });
    }
    if (turn) {
      return await submitExtension(store, turn, { runId, seat, intentId, bytes, runDir, stateDir, snapshot, deadline, ctx, json: options.json });
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
        await reduceRun(store, { runId, round, layer: ctx.layer, extensions: ctx.extensions, deadline });
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
    const passed = await advance(runDir, { runId, round, layer: ctx.layer, extensions: ctx.extensions, deadline, stateDir, once: true, openStore: () => store, ...ctx.advance });
    writeDiagnostics(ctx.io, passed.diagnostics, passed.notes);
    const after = readCouncil(store, runId);
    const state = after.seatRounds.find((row) => row.round === round && row.seat === seat)?.state ?? null;
    const payload = { runId, round, seat, intentId, state, deliveries: passed.deliveries };
    const lines = [`Recorded the reply of ${seat} for round ${round}: ${state}.`];
    for (const delivery of passed.deliveries) {
      if (delivery.kind === "notice") {
        lines.push(`Notice for ${noticeTarget(delivery)}: ${delivery.text}`);
      } else if (delivery.seat === seat && delivery.intentId !== intentId) {
        lines.push(`New prompt for ${seat}: ${delivery.promptFile} (intent ${delivery.intentId}, reply by ${delivery.deadline}).`);
      }
    }
    emit(ctx.io, options.json, payload, lines.join("\n"));
    return 0;
  } finally {
    store.close();
  }
}

// `council submit` for the intent of a Claude follow-up: the reply checked as a follow-up answer,
// the extension receipt and the reduction. An invalid reply settles the follow-up once.
async function submitFollowup(store, turn, { runId, seat, intentId, bytes, runDir, snapshot, deadline, ctx, json }) {
  const verdict = followupAnswerVerdict(runDir, snapshot, bytes.toString("utf8"), null);
  testPoint(POINTS.afterReplyValidation);
  const receipt = await depositExtensionReceipt(store, { runId, seat, intentId, verdict, deadline });
  testPoint(POINTS.beforeReduce);
  try {
    await reduceRun(store, { runId, round: 2, layer: ctx.layer, extensions: ctx.extensions, deadline });
  } catch (error) {
    if (receipt.ok && error instanceof StoreError) {
      throw new CouncilRefusal("store-error", `The reply for intent ${intentId} was recorded, but the council could not be reduced: ${error.message}`);
    }
    throw error;
  }
  if (!receipt.ok) {
    if (receipt.reason === "duplicate-receipt") {
      throw new CouncilRefusal("duplicate-receipt", `A reply for intent ${intentId} was already recorded.`);
    }
    throw new CouncilRefusal("intent-not-open", `Intent ${intentId} is not open for ${seat}; nothing was recorded.`);
  }
  const after = readCouncil(store, runId);
  const state = turnState(turn, eventsByTurn(after.ext.events)).state;
  const actor = effectivePanel(after, 2).find((entry) => entry.seat === turn.seat)?.actor ?? turn.seat;
  const deliveries = openDeliveries(after, runDir, Math.max(after.run.clock, wallNow()));
  const payload = { runId, round: 2, seat, actor, intentId, ordinal: turn.ordinal, state, deliveries };
  emit(ctx.io, json, payload, `Recorded the follow-up reply of ${actor} for ${seat}: ${state}.\nNext: run council status ${runId}.`);
  return 0;
}

function readJsonObject(runDir, sha256) {
  return JSON.parse(readObject(runDir, sha256, "json").toString("utf8"));
}

// The exact job a provider follow-up of `seat` continues: the latest issued follow-up job of the
// seat, also a failed one, else the job that gave its accepted Round 2 answer; null when none.
function followupPredecessor(snapshot, seat) {
  const byTurn = eventsByTurn(snapshot.ext?.events ?? []);
  const issued = (snapshot.ext?.turns ?? [])
    .filter((turn) => turn.kind === "followup" && turn.seat === seat && byTurn.get(turn.id)?.issue?.job_id)
    .sort((a, b) => b.ordinal - a.ordinal);
  if (issued.length > 0) {
    return byTurn.get(issued[0].id).issue.job_id;
  }
  const seatRound = snapshot.seatRounds.find((row) => row.round === 2 && row.seat === seat);
  return snapshot.attempts.find((row) => row.id === seatRound?.current_id)?.job_id ?? null;
}

// The refusal reason a provider follow-up's predecessor gives before admission (the usable
// predecessor test), or null: an existing tip with a thread that is not ephemeral and could be
// continued; a failed or cancelled tip only with unobserved-exit evidence. A live or unreleased
// job is usable: the continuation waits for its release.
function predecessorPreflight(view) {
  const problem = predecessorProblem(view);
  if (problem === "wait") {
    return null;
  }
  if (problem) {
    return problem;
  }
  const row = view.row;
  if (row.ephemeral) {
    return "predecessor not resumable";
  }
  const unobserved = row.provider_exit_unobserved === 1 || row.release_kind === "unobserved";
  if (row.end_state === "failed" && !unobserved) {
    return "predecessor failed";
  }
  if ((row.end_state === "cancelled" || row.cancelled_at !== null) && !unobserved) {
    return "predecessor cancelled";
  }
  return null;
}

/**
 * The checks of a follow-up before admission, in the refusal order after the feature flag: a
 * successful closed Round 2, a current merge, a valid effective Round 2 actor for `seat`, an
 * eligible target (a cluster of the current merge, or `stance` on a decision), no open follow-up
 * of the seat, the limits, and for a provider actor a usable predecessor. Throws the CouncilRefusal
 * of the first failed check; returns `{ entry, predecessorId, prompt }`.
 */
export function planFollowup(store, runDir, snapshot, { seat, target, question }) {
  const run = snapshot.run;
  const round2 = snapshot.rounds.find((row) => row.round === 2);
  if (run.failed_at !== null || !round2 || round2.closed_at === null || round2.quorum !== 1) {
    throw new CouncilRefusal("round-2-not-successful", "Follow-ups require a successful closed Round 2.");
  }
  const merge = currentMerge(runDir, snapshot);
  if (!merge) {
    throw new CouncilRefusal("stale-merge", "Council merge is stale. Run council merge again.");
  }
  const entry = effectivePanel(snapshot, 2).find((item) => item.seat === seat && item.valid) ?? null;
  if (!entry) {
    throw new CouncilRefusal("invalid-seat", `Seat ${seat} has no valid Round 2 actor.`);
  }
  const cluster = target === "stance" ? null : (merge.clusters.find((item) => item.id === target) ?? null);
  if (target === "stance" ? run.kind !== "decision" : !cluster) {
    throw new CouncilRefusal("invalid-target", `Finding ${target} is not an eligible follow-up target.`);
  }
  const counts = readFollowupCounts(store, { runId: run.id, seat });
  if (counts.open) {
    throw new CouncilRefusal("followup-open", `Seat ${seat} already has an open follow-up.`);
  }
  const limits = followupLimits({ seat, ...counts });
  if (limits.length > 0) {
    throw new CouncilRefusal(limits[0].error, limits.map((limit) => limit.message).join(" "));
  }
  let predecessorId = null;
  if (entry.kind === "original" && entry.family !== "claude") {
    predecessorId = followupPredecessor(snapshot, seat);
    const problem = predecessorPreflight(predecessorId ? readJobView(store, predecessorId) : null);
    if (problem) {
      throw new CouncilRefusal("predecessor-unusable", `Seat ${seat} cannot continue: ${problem}.`);
    }
  }
  const round1 = effectivePanel(snapshot, 1).find((item) => item.seat === seat && item.valid && item.actor === entry.actor) ?? null;
  const prompt = renderFollowupPrompt({
    brief: readObject(runDir, run.brief_sha256, "md").toString("utf8"),
    lens: seatOf(snapshot, seat).lens,
    round1: round1 ? readJsonObject(runDir, round1.answerSha256) : null,
    round2: readJsonObject(runDir, entry.answerSha256),
    target,
    cluster,
    question,
    kind: run.kind,
    options: JSON.parse(run.options_json ?? "[]"),
    schemaText: fs.readFileSync(followupSchemaPath(), "utf8")
  });
  return { entry, predecessorId, prompt };
}

const ADMISSION_MESSAGES = {
  "round-2-not-successful": () => "Follow-ups require a successful closed Round 2.",
  "stale-merge": () => "Council merge is stale. Run council merge again.",
  "followup-open": (seat) => `Seat ${seat} already has an open follow-up.`
};

// `council followup <run-id> <seat> --finding <cluster-id|stance> [--] <question>`: one question
// to one seat about one merged finding (or its stance on a decision), after a successful Round 2.
async function followupCouncil(options, positionals, ctx) {
  const deadline = performance.now() + BUDGET_MS.submit;
  const [runId, seat, ...words] = positionals;
  const question = words.join(" ");
  if (!runId || !seat || typeof options.finding !== "string" || options.finding === "") {
    throw new CouncilRefusal("invalid-arguments", "Usage: council followup <run-id> <seat> --finding <cluster-id|stance> [--] <question> [--json]");
  }
  if (!question.trim()) {
    throw new CouncilRefusal("invalid-arguments", "Supply one nonblank follow-up question.");
  }
  const target = options.finding;
  const stateDir = resolveStateDir(resolveCommandCwd(options));
  const runDir = runDirOf(stateDir, runId);
  const store = await commandStore(stateDir, deadline);
  try {
    let snapshot = readCouncil(store, runId);
    if (!snapshot) {
      throw new CouncilRefusal("unknown-run", `Unknown council run ${runId}.`);
    }
    if (!ctx.extensions?.followups) {
      throw new CouncilRefusal("extension-disabled", "Council extension followups is disabled.");
    }
    // The existing follow-ups settle first, so a finish that changed the council is seen.
    if (snapshot.rounds.some((row) => row.round === 2)) {
      await reduceRun(store, { runId, round: 2, layer: ctx.layer, extensions: ctx.extensions, deadline });
      snapshot = readCouncil(store, runId);
    }
    const plan = planFollowup(store, runDir, snapshot, { seat, target, question });
    const turnId = randomBytes(16).toString("hex");
    const admitted = await admitFollowup(store, {
      runId,
      seat,
      turnId,
      requestId: randomBytes(16).toString("hex"),
      target,
      question,
      promptSha256: installObject(runDir, plan.prompt, "md"),
      predecessorId: plan.predecessorId,
      mergeSha256: snapshot.run.merge_sha256,
      inputRev: snapshot.run.input_rev,
      deadline
    });
    if (!admitted.ok) {
      if (admitted.limits) {
        throw new CouncilRefusal(admitted.reason, admitted.limits.map((limit) => limit.message).join(" "));
      }
      if (admitted.reason === "unknown-run") {
        throw new CouncilRefusal("unknown-run", `Unknown council run ${runId}.`);
      }
      throw new CouncilRefusal(admitted.reason, ADMISSION_MESSAGES[admitted.reason](seat));
    }
    const diagnostics = [];
    const notes = [];
    if (plan.predecessorId) {
      const reserved = readCouncil(store, runId);
      const turn = reserved.ext.turns.find((row) => row.id === turnId);
      const outcome = await dispatchFollowup(store, stateDir, runDir, turn, {
        layer: ctx.layer,
        deadline,
        run: reserved.run,
        seat: seatOf(reserved, seat),
        launch: ctx.advance?.launch,
        decideNext: ctx.advance?.decideNext,
        readRequester: ctx.readRequester,
        diagnosticLines: notes
      });
      diagnostics.push(...outcome.diagnostics);
      await reduceRun(store, { runId, round: 2, layer: ctx.layer, extensions: ctx.extensions, deadline });
    }
    writeDiagnostics(ctx.io, diagnostics, notes);
    const after = readCouncil(store, runId);
    const turn = after.ext.turns.find((row) => row.id === turnId);
    const { state, issue, finish } = turnState(turn, eventsByTurn(after.ext.events));
    const deliveries = openDeliveries(after, runDir, Math.max(after.run.clock, wallNow()));
    const payload = { runId, seat, intentId: turnId, ordinal: turn.ordinal, state, jobId: issue?.job_id ?? null, deliveries, diagnostics };
    if (finish && finish.code !== "valid") {
      payload.error = "followup-failed";
      payload.message = `Follow-up ${turnId} failed: ${finish.reason}.`;
      if (options.json) {
        emit(ctx.io, true, payload, "");
      } else {
        ctx.io.stderr(`${payload.message}\n`);
      }
      return 1;
    }
    const delivery = deliveries.find((item) => item.intentId === turnId);
    const text = delivery
      ? `Follow-up ${turn.ordinal} for ${seat}: give ${delivery.promptFile} to the agent of ${delivery.actor} and submit its reply with intent ${turnId} by ${delivery.deadline}.`
      : issue
        ? `Follow-up ${turn.ordinal} sent to ${seat} as job ${issue.job_id}. Next: run council collect ${runId} --round 2.`
        : `Follow-up ${turn.ordinal} for ${seat} waits for its job to continue. Next: run council collect ${runId} --round 2.`;
    emit(ctx.io, options.json, payload, text);
    return 0;
  } finally {
    store.close();
  }
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
  const jobModels = recordedModels(store, snapshot);
  // The effective Round 1 panel: valid originals, and each Round 1 stand-in that answered validly
  // under its actor key (`<seat>~r1`), which is carried into Round 2 for that seat.
  const { panel, answers, rows: actorRows } = round1Actors(runDir, snapshot, jobModels);
  const random = deps.random ? { random: deps.random } : {};
  const { bundles, mapping } = buildBundles(actorRows, answers, { runId, ...random });
  const ordinary = panel.filter((entry) => entry.kind === "original");
  if (deps.extensions?.substitution && ordinary.length > 0) {
    // Each ordinary Round 2 seat gets an independently shuffled alternate bundle: what a fresh
    // Round 2 stand-in for that seat answers, without that seat's own Round 1 findings.
    const alternates = buildBundles(actorRows, answers, { runId, ...random }).mapping;
    mapping.$alternates = Object.fromEntries(ordinary.map((entry) => [actorKey(entry.seat, 2), alternates[entry.seat]]));
    if (answersInOwnWords(snapshot.run.kind)) {
      // Its answer labels cover every effective Round 1 answer, the replaced seat's included.
      const authors = actorRows.map((row) => row.seat);
      mapping.$answerAlternates = Object.fromEntries(ordinary.map((entry) => [actorKey(entry.seat, 2), answerLetterMap(authors, random)]));
    }
  }
  const mapSha256 = installObject(runDir, `${JSON.stringify(mapping, null, 2)}\n`, "json");
  const briefText = readObject(runDir, snapshot.run.brief_sha256, "md").toString("utf8");
  const kind = snapshot.run.kind;
  const schemaText = fs.readFileSync(roundSchemaPath(2, kind), "utf8");
  const lenses = new Map(snapshot.seats.map((row) => [row.seat, row.lens]));
  // A question or open seat also sees every answer: the others under its letters, its own last.
  const answersOf = (entry) => (answersInOwnWords(kind) ? answerBundle(actorRows, answers, mapping[entry.actor], answers[entry.actor].answer, { runId }) : []);
  const promptOf = (entry) =>
    renderRound2Prompt({
      brief: briefText,
      lens: lenses.get(entry.seat),
      ownFindings: answers[entry.actor].findings,
      bundle: bundles[entry.actor],
      schemaText,
      kind,
      answers: answersOf(entry)
    });
  const entries = ordinary.map((entry) => {
    const prompt = promptOf(entry);
    return {
      seat: entry.seat,
      attemptId: randomBytes(16).toString("hex"),
      promptSha256: installObject(runDir, prompt, "md"),
      retryPromptSha256: retryPromptOf(runDir, prompt, layer),
      mapSha256
    };
  });
  const carries = panel
    .filter((entry) => entry.kind === "substitute")
    .map((entry) => ({ seat: entry.seat, turnId: randomBytes(16).toString("hex"), promptSha256: installObject(runDir, promptOf(entry), "md") }));
  const seeded = await startRound2(store, { runId, mapSha256, entries, carries, layer, deadline });
  if (!seeded.ok) {
    throw refusalOf(seeded.reason);
  }
  testPoint(POINTS.afterSeed);
  testPoint(POINTS.beforeExport);
  publishExport(runDir, "private/anonymisation.json", mapSha256, () => committedMap(store, runId));
  return advance(runDir, { runId, round: 2, layer, extensions: deps.extensions, deadline, stateDir: deps.stateDir, once: true, openStore: () => store, ...deps.advance });
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
    const passed = await crossExamine(runDirOf(stateDir, runId), { store, stateDir, runId, layer: ctx.layer, extensions: ctx.extensions, deadline, random: ctx.random, advance: ctx.advance });
    writeDiagnostics(ctx.io, passed.diagnostics, passed.notes);
    // The seats Round 2 went to: the ordinary seat rounds and the carried stand-ins.
    const sentTo = readCouncil(store, runId);
    const seats = sentTo.seatRounds.filter((row) => row.round === 2).length + sentTo.ext.turns.filter((turn) => turn.kind === "carry" && turn.round === 2).length;
    const payload = { runId, round: 2, seats, deliveries: passed.deliveries, ...(passed.diagnostics.length > 0 ? { diagnostics: passed.diagnostics } : {}) };
    emit(ctx.io, options.json, payload, `Round 2 sent to ${seats} seats.\nNext: run council status ${runId}.`);
    return 0;
  } finally {
    store.close();
  }
}

/**
 * The merge input of a run from one snapshot: the effective panel's verified answers per logical
 * seat and round (a valid original, else its valid stand-in or carry). A seat answered by a
 * stand-in carries the stand-in's family (`claude`) for that round, no quorum family, and for a
 * fresh Round 2 stand-in its actor key for the findings it adds; each responder's letter map
 * names logical seats. `substitutions` lists every stand-in and carry of the run. With
 * follow-ups on (`extensions.followups`) and follow-ups finished, `followups` lists them and
 * `stances` holds each seat's most recent valid non-null follow-up stance.
 */
export function mergeInput(runDir, snapshot, { extensions = {} } = {}) {
  const panels = { 1: effectivePanel(snapshot, 1), 2: effectivePanel(snapshot, 2) };
  const entryOf = (round, seat) => panels[round].find((entry) => entry.seat === seat && entry.valid) ?? null;
  const answersOf = (round) => Object.fromEntries(panels[round].filter((entry) => entry.valid).map((entry) => [entry.seat, readJsonObject(runDir, entry.answerSha256)]));
  const round2 = snapshot.rounds.find((row) => row.round === 2);
  const map = round2?.map_sha256 ? readJsonObject(runDir, round2.map_sha256) : {};
  const logical = (actor) => String(actor).replace(/~r[12]$/, "");
  const anonymisation = {};
  // A question or open responder's answer labels: its letters, then its own answer's label; a
  // fresh Round 2 stand-in, which has no answer of its own, uses its answer map.
  const answerMaps = {};
  const ownWords = answersInOwnWords(snapshot.run.kind);
  const round1Seats = new Set(panels[1].filter((item) => item.valid).map((item) => item.seat));
  for (const entry of panels[2].filter((item) => item.valid)) {
    const letterMap = (entry.kind === "substitute" ? map.$alternates?.[entry.actor] : map[entry.actor]) ?? {};
    anonymisation[entry.seat] = Object.fromEntries(Object.entries(letterMap).map(([letter, author]) => [letter, logical(author)]));
    if (ownWords && entry.kind === "substitute") {
      const labels = standInAnswerMap(map, entry.actor) ?? {};
      answerMaps[entry.seat] = Object.fromEntries(Object.entries(labels).map(([letter, author]) => [letter, logical(author)]));
    } else if (ownWords) {
      answerMaps[entry.seat] = { ...anonymisation[entry.seat] };
      if (round1Seats.has(entry.seat)) {
        answerMaps[entry.seat][selfLabel(letterMap)] = entry.seat;
      }
    }
  }
  const charges = snapshot.charges.total;
  const standIns = substitutionEntries(snapshot);
  return {
    runId: snapshot.run.id,
    kind: snapshot.run.kind,
    options: JSON.parse(snapshot.run.options_json),
    seats: snapshot.seats.map((row) => {
      const first = entryOf(1, row.seat);
      const second = entryOf(2, row.seat);
      const seat = { seat: row.seat, family: row.family };
      if ((first && first.kind !== "original") || (second && second.kind !== "original")) {
        seat.round1Family = first?.family ?? row.family;
        seat.round2Family = second?.family ?? row.family;
        seat.quorumFamily = second?.kind === "original" ? row.family : null;
        seat.round2Key = second?.kind === "substitute" ? second.actor : null;
      }
      return seat;
    }),
    round1: answersOf(1),
    round2: answersOf(2),
    anonymisation,
    ...(ownWords ? { answerMaps } : {}),
    turns: { used: charges.turn + (snapshot.ext?.issued.total ?? 0), repairs: charges.repair, retries: charges.retry },
    ...(standIns.length > 0 ? { substitutions: standIns } : {}),
    ...followupInput(runDir, snapshot, extensions)
  };
}

/**
 * The finished follow-ups of a run in ordinal order: `{ ordinal, intentId, seat, findingId,
 * question, mergeSha256, state, issuedAt, jobId, answer, stance, at, reason, forceReason }`, with
 * `answer` and `stance` from a valid answer (else null), `issuedAt` and `at` (the answer's event
 * time) in milliseconds, and `forceReason` the decoded force record or null.
 */
export function followupEntries(runDir, snapshot) {
  const byTurn = eventsByTurn(snapshot.ext?.events ?? []);
  return (snapshot.ext?.turns ?? [])
    .filter((turn) => turn.kind === "followup" && byTurn.get(turn.id)?.finish)
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((turn) => {
      const { issue, deposit, finish } = byTurn.get(turn.id);
      const valid = finish.code === "valid";
      const answer = valid ? readJsonObject(runDir, deposit.digest) : null;
      return {
        ordinal: turn.ordinal,
        intentId: turn.id,
        seat: turn.seat,
        findingId: turn.target,
        question: turn.question,
        mergeSha256: turn.merge_sha256,
        state: finish.code,
        issuedAt: issue?.at ?? null,
        jobId: issue?.job_id ?? null,
        answer: answer?.answer ?? null,
        stance: answer?.stance ?? null,
        at: valid ? deposit.event_at : null,
        reason: finish.reason ?? null,
        forceReason: issue?.code ? JSON.parse(issue.code) : null
      };
    });
}

// The follow-up part of the merge input: nothing unless follow-ups are on and some finished.
function followupInput(runDir, snapshot, extensions) {
  if (!extensions.followups) {
    return {};
  }
  const followups = followupEntries(runDir, snapshot);
  if (followups.length === 0) {
    return {};
  }
  const stances = {};
  for (const entry of followups) {
    if (entry.state === "valid" && entry.stance !== null) {
      stances[entry.seat] = entry.stance;
    }
  }
  return { followups, stances };
}

// The bytes of followups.json: each valid follow-up answer in ordinal order as `{ seat,
// findingId, question, answer, at }`, and their digest.
function followupsBytes(runDir, snapshot) {
  const list = followupEntries(runDir, snapshot)
    .filter((entry) => entry.state === "valid")
    .map((entry) => ({ seat: entry.seat, findingId: entry.findingId, question: entry.question, answer: entry.answer, at: entry.at }));
  const text = `${JSON.stringify(list, null, 2)}\n`;
  return { text, sha256: createHash("sha256").update(text).digest("hex") };
}

// Publishes followups.json from the current snapshot while a fresh snapshot gives the same bytes.
function publishFollowups(store, runDir, runId) {
  const { text } = followupsBytes(runDir, readCouncil(store, runId));
  const sha256 = installObject(runDir, text, "json");
  return { sha256, published: publishExport(runDir, "followups.json", sha256, () => followupsBytes(runDir, readCouncil(store, runId)).sha256) };
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

/**
 * The inventory of a failed council: `{ runId, inputRev, outcome: "failed", families,
 * substitutions, answers }`, with every accepted answer of every round (originals and stand-ins)
 * in round, seat and actor order as `{ round, seat, actor, family, answerSha256, answer }`, and
 * `families` the valid original families of the round that failed.
 */
export function failedInventory(runDir, snapshot) {
  const failedRound = [...snapshot.rounds].filter((row) => row.closed_at !== null && row.quorum === 0).sort((a, b) => b.round - a.round)[0];
  const answers = [];
  for (const row of [...snapshot.rounds].sort((a, b) => a.round - b.round)) {
    for (const entry of effectivePanel(snapshot, row.round)) {
      const original = snapshot.seatRounds.find((item) => item.round === row.round && item.seat === entry.seat && item.state === "valid");
      const accepted = [
        ...(original ? [{ actor: entry.seat, family: snapshot.seats.find((seat) => seat.seat === entry.seat).family, sha256: original.answer_sha256 }] : []),
        ...(entry.valid && entry.kind !== "original" ? [{ actor: entry.actor, family: entry.family, sha256: entry.answerSha256 }] : [])
      ];
      for (const item of accepted) {
        answers.push({ round: row.round, seat: entry.seat, actor: item.actor, family: item.family, answerSha256: item.sha256, answer: readJsonObject(runDir, item.sha256) });
      }
    }
  }
  return {
    runId: snapshot.run.id,
    inputRev: snapshot.run.input_rev,
    outcome: "failed",
    families: failedRound ? quorumFamilies(effectivePanel(snapshot, failedRound.round), familySort) : [],
    substitutions: substitutionEntries(snapshot),
    answers
  };
}

// The bytes of a failed inventory, and their digest.
function inventoryBytes(runDir, snapshot) {
  const text = `${JSON.stringify(failedInventory(runDir, snapshot), null, 2)}\n`;
  return { text, sha256: createHash("sha256").update(text).digest("hex") };
}

// Publishes the failed inventory of the current snapshot as merge.json while the inventory of a
// fresh snapshot still has the same digest; the successful merge pointer stays unset.
function publishFailedInventory(store, runDir, runId) {
  const { text } = inventoryBytes(runDir, readCouncil(store, runId));
  const sha256 = installObject(runDir, text, "json");
  return { sha256, published: publishExport(runDir, "merge.json", sha256, () => inventoryBytes(runDir, readCouncil(store, runId)).sha256) };
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
      // A failed council publishes its inventory of answers, then reports the failed quorum.
      publishFailedInventory(store, runDir, runId);
      const failedRound = [...snapshot.rounds].filter((row) => row.closed_at !== null && row.quorum === 0).sort((a, b) => b.round - a.round)[0];
      throw new CouncilRefusal("no-quorum", closedText(roundObject(snapshot, failedRound.round)));
    }
    if (!round2 || round2.closed_at === null || round2.quorum !== 1) {
      throw new CouncilRefusal("round-2-not-closed", "Round 2 has not closed with a quorum; run council collect --round 2 first.");
    }
    const merge = mergeCouncil(mergeInput(runDir, snapshot, { extensions: ctx.extensions }));
    const mergeSha256 = installObject(runDir, serializeMerge(merge), "json");
    const recorded = await recordMerge(store, { runId, mergeSha256, inputRev: snapshot.run.input_rev, deadline });
    if (!recorded.ok) {
      throw new CouncilRefusal("stale-input", "The council changed while merging; run council merge again.");
    }
    publishExport(runDir, "merge.json", mergeSha256, () => readCouncil(store, runId)?.run.merge_sha256 ?? null);
    if (ctx.extensions?.followups && snapshot.ext.turns.some((turn) => turn.kind === "followup")) {
      publishFollowups(store, runDir, runId);
    }
    emit(ctx.io, options.json, { runId, mergeSha256, inputRev: snapshot.run.input_rev, unanimous: panelUnanimous(runDir, snapshot), merge }, clusterTable(merge));
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

/**
 * Whether the panel of a successful council agreed (see `unanimousPanel`), from the base
 * accepted answers of one snapshot; false before Round 2 closed with quorum, for a failed run, or
 * when an answer object is missing or damaged.
 */
export function panelUnanimous(runDir, snapshot) {
  const round2 = snapshot.rounds.find((row) => row.round === 2);
  if (snapshot.run.failed_at !== null || !round2 || round2.closed_at === null || round2.quorum !== 1) {
    return false;
  }
  try {
    return unanimousPanel(mergeInput(runDir, snapshot));
  } catch (error) {
    if (error instanceof ObjectDamagedError) {
      return false;
    }
    throw error;
  }
}

/** The current merge object of a snapshot (merge_rev = input_rev), or null. */
export function currentMerge(runDir, snapshot) {
  const run = snapshot.run;
  if (!run.merge_sha256 || run.merge_rev !== run.input_rev) {
    return null;
  }
  return readJsonObject(runDir, run.merge_sha256);
}

// `council verdict <run-id> agreement agreed|partly|disagreed [--] <reason>`: the leader's judgement
// of how far the answers of an open council agree, on its current merge.
async function agreementCouncil(options, { runId, value, reasonWords }, ctx) {
  const deadline = performance.now() + BUDGET_MS.submit;
  const usageText = "verdict <run-id> agreement agreed|partly|disagreed [--merge <sha256>] [--] <reason>";
  if (!AGREEMENT_VALUES.includes(value)) {
    throw new CouncilRefusal("invalid-arguments", `Usage: council ${usageText}`);
  }
  if (options.merge !== undefined && !/^[0-9a-f]{64}$/.test(String(options.merge))) {
    throw new CouncilRefusal("invalid-arguments", "--merge must be the 64-character SHA-256 of the merge you reviewed (mergeSha256 in the council merge JSON).");
  }
  if (options.strongest !== undefined) {
    throw new CouncilRefusal("invalid-arguments", "--strongest applies only to a disputed cluster.");
  }
  const reason = reasonWords.join(" ").trim();
  if (!reason) {
    throw new CouncilRefusal("invalid-arguments", `An agreement verdict needs a reason. Usage: council ${usageText}`);
  }
  const stateDir = resolveStateDir(resolveCommandCwd(options));
  const runDir = runDirOf(stateDir, runId);
  const store = await commandStore(stateDir, deadline);
  try {
    const snapshot = requireRun(store, runId);
    if (snapshot.run.kind !== "open") {
      throw new CouncilRefusal("not-open", `Council ${runId} is a ${snapshot.run.kind} council; an agreement verdict is recorded only on an open council.`);
    }
    if (!currentMerge(runDir, snapshot)) {
      throw new CouncilRefusal("stale-merge", "Run council merge first.");
    }
    // With --merge, the write transaction compares the reviewed digest with the current merge.
    const mergeSha256 = options.merge ?? snapshot.run.merge_sha256;
    const recorded = await recordAgreement(store, { runId, value, reason, mergeSha256, inputRev: snapshot.run.input_rev, deadline });
    if (!recorded.ok) {
      throw new CouncilRefusal(recorded.reason, recorded.reason === "stale-merge" ? "The council changed since its merge; run council merge again." : `The agreement was not recorded: ${recorded.reason}.`);
    }
    emit(ctx.io, options.json, { runId, target: "agreement", verdict: value, reason }, `Recorded agreement ${value}.`);
    return 0;
  } finally {
    store.close();
  }
}

// `council verdict <run-id> <cluster-id|claim-id> verified|rejected|not-checked [--strongest <n>] [--] [reason]`,
// or the agreement form above.
async function verdictCouncil(options, positionals, ctx) {
  const deadline = performance.now() + BUDGET_MS.submit;
  const [runId, targetId, verdict, ...reasonWords] = positionals;
  if (runId && targetId === "agreement") {
    return agreementCouncil(options, { runId, value: verdict, reasonWords }, ctx);
  }
  if (options.merge !== undefined) {
    throw new CouncilRefusal("invalid-arguments", "--merge applies only to an agreement verdict.");
  }
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

// `council export <run-id> brief|map|merge|report|followups`: rebuilds one export from its committed
// object (followups.json from the current snapshot).
async function exportCouncil(options, positionals, ctx) {
  const deadline = performance.now() + BUDGET_MS.submit;
  const [runId, name] = positionals;
  if (!runId || positionals.length !== 2 || (!Object.hasOwn(EXPORTS, name) && name !== "followups")) {
    throw new CouncilRefusal("invalid-arguments", "Usage: council export <run-id> brief|map|merge|report|followups [--json]");
  }
  const stateDir = resolveStateDir(resolveCommandCwd(options));
  const runDir = runDirOf(stateDir, runId);
  const store = await commandStore(stateDir, deadline);
  try {
    const spec = EXPORTS[name];
    const snapshot = requireRun(store, runId);
    if (name === "followups") {
      const { sha256, published } = publishFollowups(store, runDir, runId);
      if (!published) {
        throw new CouncilRefusal("stale-input", "The follow-ups changed while they were exported; run council export again.");
      }
      const file = path.join(runDir, "followups.json");
      emit(ctx.io, options.json, { runId, name, file, sha256 }, file);
      return 0;
    }
    const run = snapshot.run;
    if (name === "report" && run.report_sha256 && (run.report_input_rev !== run.input_rev || run.report_verdict_rev !== run.verdict_rev)) {
      throw new CouncilRefusal("report-stale", "The council changed while reporting; run council report again.");
    }
    if (name === "merge" && snapshot.run.failed_at !== null) {
      const { sha256, published } = publishFailedInventory(store, runDir, runId);
      if (!published) {
        throw new CouncilRefusal("stale-input", "The merge changed while it was exported; run council export again.");
      }
      const file = path.join(runDir, spec.file);
      emit(ctx.io, options.json, { runId, name, file, sha256 }, file);
      return 0;
    }
    const digest = spec.digest(snapshot);
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
  // Extension turns: every prompt, and the answer of each valid Claude deposit.
  for (const turn of snapshot.ext?.turns ?? []) {
    required.push([turn.prompt_sha256, "md"]);
  }
  for (const event of snapshot.ext?.events ?? []) {
    if (event.kind === "deposit" && event.code === "valid" && event.digest) {
      required.push([event.digest, "json"]);
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
 * for a pending stop (its oldest round; a follow-up stop is owned by round 2), `report-failure`
 * and `done` for a failed run, `collect` for an open round, `crossexam`, `collect` round 2 for
 * an open follow-up, `merge`, `verify` (with the clusters needing a verdict at the
 * current input revision), `agree` (an open council without the leader's agreement verdict at the
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
  // A follow-up's pending stop is owned by Round 2.
  const extPending = pendingExtensionStops(snapshot.ext);
  if (pending.length > 0 || extPending.length > 0) {
    const rounds = [...pending.map((stop) => snapshot.attempts.find((row) => row.job_id === stop.job_id)?.round ?? 1), ...extPending.map(() => 2)];
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
  if (followupsOpen(snapshot)) {
    return result("collect", 2);
  }
  if (round2 && round2.quorum === 1 && (run.merge_rev !== run.input_rev || !objects.mergeExport)) {
    return result("merge", 2);
  }
  const unverified = clustersNeedingVerdict(objects.merge).filter((cluster) => !verdictFor(snapshot, cluster));
  if (unverified.length > 0) {
    return result("verify", 2, unverified.map((cluster) => cluster.id));
  }
  if (run.kind === "open" && snapshot.agreement?.input_rev !== run.input_rev) {
    return result("agree", 2);
  }
  if (!reportCurrent || run.report_outcome !== "council" || !objects.reportExport) {
    return result("report", 2);
  }
  return result("done");
}

// The stand-in candidates of an open round that has no substitution decision yet:
// `{ seat, state, reason, lens }` per original seat that ended the round without a valid answer.
function standInCandidates(snapshot, round) {
  const roundRow = snapshot.rounds.find((row) => row.round === round);
  const decided = snapshot.ext.decisions.some((row) => row.kind === "substitution" && row.scope === round);
  if (!roundRow || roundRow.closed_at !== null || decided) {
    return [];
  }
  const seatRounds = snapshot.seatRounds.filter((row) => row.round === round);
  const states = new Map(seatRounds.map((row) => [row.seat, row.state]));
  return substitutionCandidates(seatRounds, states, snapshot.ext.turns.filter((turn) => turn.round === round)).map((seat) => {
    const row = seatRounds.find((entry) => entry.seat === seat);
    return { seat, state: row.state, reason: row.reason ?? null, lens: snapshot.seats.find((entry) => entry.seat === seat).lens };
  });
}

const ACTION_TEXT = {
  damaged: (next) => `The council object ${next.damaged} is missing or damaged; this council cannot continue.`,
  collect: (next, runId) => `Next: run council collect ${runId} --round ${next.round}.`,
  crossexam: (_next, runId) => `Next: run council crossexam ${runId}.`,
  merge: (_next, runId) => `Next: run council merge ${runId}.`,
  verify: (next, runId) => `Next: check ${next.clusters.join(", ")} and record council verdict ${runId} <cluster-id> verified|rejected|not-checked.`,
  agree: (_next, runId) => `Next: judge how far the answers agree and record council verdict ${runId} agreement agreed|partly|disagreed -- <reason>.`,
  report: (_next, runId) => `Next: run council report ${runId}.`,
  "report-failure": (_next, runId) => `Next: run council report ${runId} (the council failed).`,
  done: () => "Done."
};

// `council status <run-id>`: one read snapshot, the object checks, and the next action; no store
// write (a cutoff notice handed to the leader creates its run-folder marker).
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
    // A cutoff notice for a Claude seat is handed once, by whichever command sees it first.
    const notices = next.action === "damaged" ? [] : claudeNotices(snapshot, runDir, t);
    const payload = {
      runId,
      action: next.action,
      round: next.round,
      rounds: snapshot.rounds.map((row) => roundObject(snapshot, row.round, { layer: ctx.layer, extensions: ctx.extensions })),
      deliveries: [...next.deliveries, ...notices],
      clusters: next.clusters,
      cleanupPending: snapshot.stops.some((stop) => stop.acknowledged_at === null) || pendingExtensionStops(snapshot.ext).length > 0,
      unanimous: next.action === "damaged" ? false : panelUnanimous(runDir, snapshot),
      ...(next.damaged ? { damaged: next.damaged } : {})
    };
    // While the open round waits for its stand-in decision, status names the seats a collect would
    // ask a stand-in for.
    const candidates = next.action === "collect" && ctx.extensions?.substitution ? standInCandidates(snapshot, next.round) : [];
    if (candidates.length > 0) {
      payload.substitutionCandidates = candidates;
    }
    const lines = [`Council ${runId}: ${next.action}${next.round ? ` (round ${next.round})` : ""}.`];
    for (const delivery of next.deliveries) {
      if (delivery.kind === "followup") {
        lines.push(`Follow-up prompt for ${delivery.seat} (to the agent of ${delivery.actor}): ${delivery.promptFile} (intent ${delivery.intentId}, reply by ${delivery.deadline}).`);
        continue;
      }
      const who = delivery.actor ? `${delivery.seat} (stand-in ${delivery.actor}, a fresh council-member agent unless it carries its own earlier answer)` : delivery.seat;
      lines.push(`Prompt for ${who}: ${delivery.promptFile} (intent ${delivery.intentId}, reply by ${delivery.deadline}).`);
    }
    for (const candidate of candidates) {
      lines.push(`Seat ${candidate.seat} ended round ${next.round} ${candidate.state} (${candidate.reason}); a collect asks a Claude stand-in for its lens.`);
    }
    for (const notice of notices) {
      lines.push(`Notice for ${noticeTarget(notice)}: ${notice.text}`);
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
      for (const entry of substitutionEntries(snapshot, round).filter((item) => item.seat === seat.seat)) {
        const kind = entry.kind === "carry" ? "carried substitute" : "substitute";
        notes.push(`round ${round}: ${kind} (same family as leader) ${entry.actor}, ${entry.state}${entry.reason ? `, ${entry.reason}` : ""}`);
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
  const used = charges.turn + (snapshot.ext?.issued.total ?? 0);
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
  const answers = [
    ...snapshot.seatRounds.filter((entry) => entry.answer_sha256).map((row) => ({ round: row.round, seat: row.seat, label: row.seat, sha256: row.answer_sha256, order: 0 })),
    ...[1, 2].flatMap((round) =>
      effectivePanel(snapshot, round)
        .filter((entry) => entry.valid && entry.kind !== "original")
        .map((entry) => ({ round, seat: entry.seat, label: `${entry.seat}, ${entry.kind === "carry" ? "carried substitute" : "substitute"} ${entry.actor}`, sha256: entry.answerSha256, order: 1 }))
    )
  ].sort((a, b) => a.round - b.round || (a.seat < b.seat ? -1 : a.seat > b.seat ? 1 : 0) || a.order - b.order);
  for (const entry of answers) {
    lines.push(`Round ${entry.round}, ${entry.label}:`, "", "```json", readObject(runDir, entry.sha256, "json").toString("utf8").trim(), "```", "");
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

// The answers of a question or open council; on an open council each answer names, from the
// merge's `marks`, the seats that agreed with it and the seats that challenged it, with their
// reasons. Then, on a question, the options of the vote.
function answerSections(merge) {
  const answers = merge.answers ?? [];
  const lines = ["", "## Answers", ""];
  if (answers.length === 0) {
    lines.push("None.");
  }
  for (const entry of answers) {
    lines.push(`- ${entry.label} (${entry.seat}): ${cellText(entry.text)}`);
    if (merge.marks) {
      const agreeing = merge.marks.filter((mark) => mark.agreesWith.includes(entry.label)).map((mark) => mark.seat);
      const challenges = merge.marks.flatMap((mark) =>
        mark.answerResponses.filter((item) => item.answer === entry.label && item.response === "challenge").map((item) => `${mark.seat} (${cellText(item.reason)})`)
      );
      lines.push(`  Agreed with by: ${agreeing.length > 0 ? agreeing.join(", ") : "none"}.`);
      lines.push(`  Challenged by: ${challenges.length > 0 ? challenges.join("; ") : "none"}.`);
    }
  }
  if (merge.options) {
    lines.push("", "## Options", "");
    for (const option of merge.options) {
      const votes = merge.decision?.tally?.[option.id] ?? 0;
      lines.push(`- ${option.id} (answers ${option.labels.join(", ")}; ${votes} ${votes === 1 ? "vote" : "votes"}): ${cellText(option.text)}`);
    }
  }
  return lines;
}

/** The Markdown report of a council with its current merge and verdicts. */
export function renderCouncilReport(runDir, snapshot, merge) {
  const verdictOf = (cluster) => verdictFor(snapshot, cluster);
  const input = mergeInput(runDir, snapshot);
  const lines = ["# Council report", "", runLine(snapshot), "", ...seatTable(snapshot), "", notValidLine(snapshot), "", ...lateDeposits(snapshot), "", "## Verdict", ""];
  if (snapshot.run.kind === "open") {
    const agreement = snapshot.agreement?.input_rev === snapshot.run.input_rev ? snapshot.agreement : null;
    lines.push(`Agreement (leader judgement): ${agreement?.value ?? "not recorded"}`);
    if (agreement) {
      lines.push(`Reason: ${cellText(agreement.reason)}`);
    }
    lines.push("");
  }
  lines.push(confidenceLine(merge));
  if (unanimousPanel(input)) {
    lines.push("", "Unanimous panel: the leader adds a counterargument.");
  }
  const unresolved = merge.clusters.filter((cluster) => cluster.severity === "P1" && !["verified", "rejected"].includes(verdictOf(cluster)?.verdict));
  if (unresolved.length > 0) {
    lines.push("", `Unresolved P1 findings: ${unresolved.map((cluster) => `${cluster.id} (${verdictOf(cluster)?.verdict ?? "no verdict"})`).join(", ")}.`);
  }
  if (merge.answers) {
    lines.push(...answerSections(merge));
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
  if ((merge.followups ?? []).length > 0) {
    lines.push("", "## Follow-ups", "");
    for (const entry of merge.followups) {
      lines.push(`- ${entry.seat} on ${entry.findingId} (follow-up ${entry.ordinal}): ${cellText(entry.question)}`);
      if (entry.state === "valid") {
        lines.push(`  Answer: ${cellText(entry.answer)}`);
        if (entry.stance !== null) {
          lines.push(`  Stance: ${entry.stance}`);
        }
      } else {
        lines.push(`  No answer: ${entry.state} (${entry.reason}).`);
      }
    }
  }
  lines.push("", "## Minority positions", "");
  const minority = [];
  if (merge.options) {
    // A question seat's vote is the option of the answer it endorsed.
    const { stances } = mergeQuestion({ answers: canonicalAnswers(input.seats, input.round1), round2: input.round2, answerMaps: input.answerMaps });
    for (const [seat, option] of Object.entries(stances)) {
      if (!merge.decision.choice || option !== merge.decision.choice) {
        minority.push(`- ${seat}: ${option ? `option ${option}` : "no valid vote"}`);
      }
    }
  } else if (merge.decision) {
    const eligible = effectivePanel(snapshot, 2).filter((entry) => entry.valid);
    // A valid follow-up stance replaces the seat's Round 2 stance.
    const overrides = new Map((merge.followups ?? []).filter((entry) => entry.state === "valid" && entry.stance !== null).map((entry) => [entry.seat, entry.stance]));
    for (const row of eligible) {
      const stance = overrides.get(row.seat) ?? readJsonObject(runDir, row.answerSha256).stance;
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
    let snapshot = requireRun(store, runId);
    if (followupsOpen(snapshot)) {
      // A follow-up past its deadline settles first; one still open withholds the report.
      await reduceRun(store, { runId, round: 2, layer: ctx.layer, extensions: ctx.extensions, deadline });
      snapshot = requireRun(store, runId);
      if (followupsOpen(snapshot)) {
        throw new CouncilRefusal("followup-open-report", "A council follow-up is open. Wait for it to finish.");
      }
    }
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
      if (snapshot.run.kind === "open" && snapshot.agreement?.input_rev !== snapshot.run.input_rev) {
        throw new CouncilRefusal("verdict-required", `Record council verdict ${runId} agreement agreed|partly|disagreed -- <reason> first.`);
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
      if (recorded.reason === "followup-open") {
        throw new CouncilRefusal("followup-open-report", "A council follow-up is open. Wait for it to finish.");
      }
      throw new CouncilRefusal("report-stale", "The council changed while reporting; run council report again.");
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
    args: { valueOptions: ["round", "budget-ms"], booleanOptions: ["disallow-substitute"] },
    run: (parsed, ctx) => collectCouncil(parsed.options, parsed.positionals, ctx)
  },
  submit: {
    args: { valueOptions: ["intent", "file", "round"] },
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
  followup: {
    args: { valueOptions: ["finding"], dashPositionals: true },
    run: (parsed, ctx) => followupCouncil(parsed.options, parsed.positionals, ctx)
  },
  verdict: {
    args: { valueOptions: ["strongest", "merge"], dashPositionals: true },
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
 * Runs one council subcommand. `layer` (default COUNCIL_LAYER) and `extensions` (default
 * COUNCIL_EXTENSIONS) are read once and passed to every state interface; `io`, `checkProviders`, `readRequester` and `advance` (options merged into
 * every advance call) replace the process's outputs and services in tests. Resolves to the exit
 * code: 0, or 1 for a refusal, printed as `{ error, message }` with --json and as its message on
 * standard error otherwise.
 */
export async function handleCouncil(argv, { layer = COUNCIL_LAYER, extensions = COUNCIL_EXTENSIONS, io = nodeIo(), ...services } = {}) {
  const [name, ...rest] = argv;
  const command = Object.hasOwn(SUBCOMMANDS, name ?? "") ? SUBCOMMANDS[name] : null;
  const json = rest.includes("--json");
  let code;
  try {
    if (!command) {
      throw new CouncilRefusal("invalid-arguments", `Usage: council ${usage.replace(/^council /, "")}`);
    }
    const separator = rest.indexOf("--");
    if (name !== "collect" && (separator === -1 ? rest : rest.slice(0, separator)).includes("--disallow-substitute")) {
      throw new CouncilRefusal("invalid-arguments", "--disallow-substitute is only valid on council collect.");
    }
    const parsed = parseCouncilArgs(rest, { repeatable: [], ...command.args });
    code = await command.run(parsed, { layer, extensions, io, ...services });
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
