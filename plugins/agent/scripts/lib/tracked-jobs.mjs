import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { removeLiveFile, writeLiveFile } from "./live.mjs";
import {
  composeRequestText,
  confirmMessage,
  CONTINUE_LINE,
  deliverableMessages,
  dispatchMessage,
  markDelivered,
  messageClientId,
  readMessageOutcome,
  submitClientId
} from "./mailbox.mjs";
import { currentGroupId, isProcessAlive, leadsOwnGroup, readProcessIdentity, stopHeldTree, stopTree } from "./process.mjs";
import {
  capResult,
  capUtf8,
  claimExecution,
  decideRelease,
  leaderState,
  leaveExecutionUnconfirmed,
  localDeadlineFrom,
  observeClosure,
  readEvidenceInput,
  readExecutionFence,
  readJobView,
  readMaxParallel,
  recordEnd,
  recordIntent,
  recordThread,
  releaseExecution,
  requestStop,
  resumability,
  storeLateResult
} from "./state.mjs";
import { boundary, checkRuntime, openStore, RETRY_BUDGETS, runtimeGateMessage, StoreError, testPoint, wallNow, withRetry } from "./store.mjs";
import { extractQuestion, launchEligible, QUESTION_INSTRUCTION } from "./task-launch.mjs";

// ---------------------------------------------------------------------------------------------
// The worker harness of the job store. A worker runs exactly one provider turn for one job: it
// claims the job, records each step before taking it, commits a message's dispatch before any
// byte of it reaches the provider, honours stop requests, and releases its execution by the
// evidence it saw. The provider driver only reports what happened; the harness writes the store.
//
// The provider driver contract (what a product driver implements for the worker):
// - `spawn(ctx)` starts the provider and resolves to `{ pid, exited, child }`:
//   - `pid` is the provider root's process id;
//   - `exited` is a promise that resolves once with `{ code, signal, at }` when the root exits;
//   - `child` is the root's ChildProcess, which the driver keeps open and never unrefs or detaches
//     from. While the worker holds it and has not seen the exit, the root's id cannot pass to
//     another process, so the worker stops the provider's tree through it without an identity query
//     (Windows `taskkill /PID <pid> /T /F`; Linux SIGKILL to the provider's process group).
//   - On Linux the driver spawns the root with `detached: true`, so that the root leads its own
//     process group and every descendant stays in it. The worker checks this once after the spawn:
//     a root that does not lead a group of its own id gets no recorded group, and its closure stays
//     undecided until the grace window (released unobserved, with a barrier when it held a thread).
//     On Windows the root is not detached. A driver whose provider client spawns the root gets this
//     through that client's own-group option; callers outside the worker leave that option off.
//   - On macOS and other POSIX systems the worker records no group (the group check is Linux
//     only): a held stop sends SIGKILL to the root alone, any descendant is not reached, and every
//     release is decided by the grace window (unobserved, with a barrier when it held a thread).
// - `capabilities`: `{ steer, interrupt, history, ownExit }`. A driver whose provider exits by
//   itself after a normal turn end sets `ownExit`. On Windows a provider without it is stopped by
//   the worker's tree stop once the end decision is committed; its input is not ended first.
// - `prepare(ctx)`, `start(ctx, { text, clientId, outputSchema })`, `turnEnded`, and the optional
//   `steer`, `interrupt`, `interruptPrevious`, `historyHas`, `formatBody` and `additions`, as used
//   below. `endInput(ctx)` ends the provider's input; the worker calls it on every POSIX system
//   and, on Windows, only for a provider with `ownExit`. No release ever credits the end of input.

/** The bytes of a predecessor's output a continuation may carry. */
export const PRIOR_OUTPUT_BUDGET = 65536;

const STOP_POLL_MS = 500;
const HEARTBEAT_MS = 2000;
const HEARTBEAT_LIMIT_MS = 8000;
const DEFAULT_LEADER_CHECK_MS = 5000;
const DEFAULT_NATURAL_EXIT_MS = 5000;
const THREAD_BUSY_RETRY_MS = 1000;
const THREAD_BUSY_LIMIT_MS = 30000;
const PREVIOUS_TURN_LIMIT_MS = 10000;
const INTERRUPT_MARGIN_MS = 1500;
const EXIT_MARGIN_MS = 500;
// The most one process-identity query may take; a busy Windows machine can need several seconds
// to start PowerShell.
const IDENTITY_QUERY_MS = 10000;
// How often a worker reads its own process identity before it gives up claiming.
const OWN_IDENTITY_ATTEMPTS = 3;

class Aborted extends Error {
  constructor(reason) {
    super(`shutdown: ${reason}`);
    this.reason = reason;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

function isLostStore(error) {
  return error instanceof StoreError && (error.class === "store-moved" || error.class === "corruption");
}

function envNumber(env, name, fallback) {
  const value = Number(env[name]);
  return env[name] && Number.isFinite(value) && value > 0 ? value : fallback;
}

// Resolves with `promise`'s value, or with `fallback` once the monotonic `deadline` passes.
function settleBy(promise, deadline, fallback = undefined) {
  const remaining = deadline - performance.now();
  if (remaining <= 0) {
    return Promise.resolve(fallback);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), remaining);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

function tailOf(file, bytes) {
  try {
    const stat = fs.statSync(file);
    const length = Math.min(stat.size, bytes);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buffer, 0, length, stat.size - length);
    } finally {
      fs.closeSync(fd);
    }
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

// The worker of one execution; runJobExecution is its entry. Exported for unit tests of its stop
// phase, which need no provider process.
export class WorkerRun {
  constructor(store, stateDir, jobId, driver, env) {
    this.store = store;
    this.stateDir = stateDir;
    this.jobId = jobId;
    this.driver = driver;
    this.env = env;
    this.logFile = path.join(stateDir, "store", "artifacts", `${jobId}.log`);
    this.execGen = null;
    this.child = null;
    this.childIdentity = null;
    this.exitInfo = null;
    this.requestWritten = false;
    this.turnSettled = false;
    this.turnResult = null;
    this.turnEnded = null;
    this.treeStop = null;
    this.lateWriteUsed = false;
    this.localDeadline = null;
    this.shutdownReason = null;
    this.ending = false;
    this.timers = [];
    this.dispatched = new Map();
    this.steering = false;
    this.abortController = new AbortController();
    let resolveAbort;
    this.abortRequested = new Promise((resolve) => (resolveAbort = resolve));
    this.resolveAbort = resolveAbort;
  }

  log(line) {
    try {
      fs.appendFileSync(this.logFile, `[${new Date().toISOString()}] ${String(line).trimEnd()}\n`);
    } catch {
      // The log is best effort.
    }
  }

  // A store write with the worker's busy budget, never past `deadline` when one is given. A lost
  // or corrupt store stops the run.
  async write(call, { deadline = undefined } = {}) {
    try {
      return await withRetry((opts) => call(opts), "worker", { deadline });
    } catch (error) {
      if (isLostStore(error)) {
        this.requestShutdown("store-lost");
        throw new Aborted("store-lost");
      }
      throw error;
    }
  }

  // A stop-phase write within `deadline`. Once the deadline has passed, the worker has one
  // allowance in total: a single transaction attempt whose busy wait is at most
  // STOP_WRITE_LAST_ATTEMPT_MS, with no retry. Any later write past the deadline is refused; a
  // failed attempt leaves the execution to the scanner.
  async writeBy(call, deadline) {
    if (deadline - performance.now() > 0) {
      return this.write(call, { deadline });
    }
    if (this.lateWriteUsed) {
      throw new Error("the one write allowed after the deadline was already made");
    }
    this.lateWriteUsed = true;
    try {
      return call({ deadline: performance.now() + STOP_WRITE_LAST_ATTEMPT_MS, attemptMs: STOP_WRITE_LAST_ATTEMPT_MS });
    } catch (error) {
      if (isLostStore(error)) {
        this.requestShutdown("store-lost");
        throw new Aborted("store-lost");
      }
      throw error;
    }
  }

  read(call) {
    try {
      return call();
    } catch (error) {
      if (isLostStore(error)) {
        this.requestShutdown("store-lost");
        throw new Aborted("store-lost");
      }
      throw error;
    }
  }

  requestShutdown(reason) {
    if (this.shutdownReason || this.ending) {
      return;
    }
    this.shutdownReason = reason;
    this.abortController.abort();
    this.resolveAbort(reason);
  }

  // Waits for `promise` unless a shutdown is requested first.
  race(promise) {
    return Promise.race([
      promise,
      this.abortRequested.then((reason) => {
        throw new Aborted(reason);
      })
    ]);
  }

  checkpoint() {
    if (this.shutdownReason) {
      throw new Aborted(this.shutdownReason);
    }
  }

  context() {
    return {
      job: this.job,
      cwd: this.job.cwd,
      env: this.env,
      instanceId: this.store.instanceId,
      log: (line) => this.log(line),
      onThread: (threadId) => this.enqueue(() => this.handleThread(threadId)),
      onTurn: (turnId) =>
        this.enqueue(async () => {
          testPoint("after-submit-accepted");
          await this.write((opts) => recordIntent(this.store, this.jobId, this.execGen, "turn", { turnId }, opts));
        }),
      onStarted: () => this.enqueue(() => this.write((opts) => recordIntent(this.store, this.jobId, this.execGen, "started", {}, opts))),
      onReceipt: (clientId) => this.enqueue(() => this.handleReceipt(clientId)),
      signal: this.abortController.signal
    };
  }

  enqueue(task) {
    this.queue = (this.queue ?? Promise.resolve()).then(task).catch((error) => {
      if (!(error instanceof Aborted)) {
        this.log(`store write failed: ${error?.message ?? error}`);
      }
    });
    return this.queue;
  }

  async handleThread(threadId) {
    const result = await this.write((opts) =>
      recordThread(this.store, this.jobId, this.execGen, { threadId, resumeMethod: this.driver.resumeMethod ?? "thread" }, opts)
    );
    if (!result.ok && this.requestWritten) {
      this.threadRefused = true;
      this.requestShutdown("thread-refused");
    }
    return result;
  }

  async handleReceipt(clientId) {
    const messageId = this.dispatched.get(clientId);
    if (messageId === undefined) {
      return;
    }
    await this.write((opts) =>
      confirmMessage(
        this.store,
        messageId,
        { expectedJobId: this.jobId, expectedGen: this.execGen, observingJobId: this.jobId, observingGen: this.execGen, proof: "receipt" },
        opts
      )
    );
  }

  startTimers() {
    const pauseFile = this.env.AGENT_PLUGIN_HEARTBEAT_PAUSE_FILE;
    this.lastHeartbeat = performance.now();
    this.timers.push(
      setInterval(() => {
        if (!(pauseFile && fs.existsSync(pauseFile))) {
          try {
            writeLiveFile(this.stateDir, "worker", { ...this.claim, provider: this.childIdentity });
            this.lastHeartbeat = performance.now();
          } catch {
            // A failed write counts toward the heartbeat limit.
          }
        }
        if (performance.now() - this.lastHeartbeat > HEARTBEAT_LIMIT_MS) {
          this.requestShutdown("heartbeat");
        }
      }, HEARTBEAT_MS)
    );
    this.timers.push(setInterval(() => this.pollStop(), STOP_POLL_MS));
    if (this.job.leader_pid !== null) {
      this.timers.push(setInterval(() => this.checkLeader(), envNumber(this.env, "AGENT_PLUGIN_LEADER_CHECK_MS", DEFAULT_LEADER_CHECK_MS)));
    }
  }

  clearTimers() {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
  }

  observeStop(row) {
    if (this.localDeadline === null) {
      this.localDeadline = localDeadlineFrom(row.stop_deadline) ?? performance.now();
      this.log(`stop observed at ${performance.now().toFixed(1)}; local deadline ${this.localDeadline.toFixed(1)}`);
    }
  }

  pollStop() {
    if (this.shutdownReason || this.ending) {
      return;
    }
    let view;
    try {
      view = readJobView(this.store, this.jobId, { attemptMs: RETRY_BUDGETS.worker.attemptMs });
    } catch (error) {
      if (isLostStore(error)) {
        this.requestShutdown("store-lost");
      }
      return;
    }
    const row = view?.row;
    if (!row || row.exec_gen !== this.execGen || row.exec_released_at !== null) {
      this.requestShutdown("fenced");
      return;
    }
    if (row.stop_requested_at !== null || row.cancel_requested_at !== null) {
      this.observeStop(row);
      this.requestShutdown("stop");
      return;
    }
    if (this.requestWritten && !this.turnSettled && this.driver.capabilities?.steer && this.driver.steer && !this.steering) {
      this.steering = true;
      this.steerPending().finally(() => (this.steering = false));
    }
  }

  async checkLeader() {
    if (this.shutdownReason || this.ending || this.checkingLeader) {
      return;
    }
    this.checkingLeader = true;
    let identity;
    try {
      identity = await readProcessIdentity(this.job.leader_pid, { deadline: performance.now() + IDENTITY_QUERY_MS });
    } finally {
      this.checkingLeader = false;
    }
    if (leaderState({ row: this.job }, identity) === "gone") {
      try {
        await this.write((opts) => requestStop(this.store, { jobIds: [this.jobId] }, { reason: "leader-gone" }, opts));
        this.log("the leader is gone; a stop was requested");
      } catch {
        // The next check or the stop poll covers a failed request.
      }
    }
  }

  // Steers each further deliverable message into the open turn, in id order, after committing
  // its dispatch and re-reading the fence.
  async steerPending() {
    const ctx = this.context();
    for (const message of deliverableMessages(this.store, this.job.chain_id)) {
      if (this.shutdownReason || this.turnSettled || this.endNotified) {
        return;
      }
      if (message.dispatched_job_id === this.jobId && message.dispatched_gen === this.execGen) {
        continue;
      }
      const dispatch = await this.write((opts) => dispatchMessage(this.store, message.id, { jobId: this.jobId, execGen: this.execGen }, opts));
      if (!dispatch.won) {
        continue;
      }
      const clientId = messageClientId(this.store.instanceId, message.id);
      this.dispatched.set(clientId, message.id);
      testPoint("after-dispatch");
      // Lets provider output that arrived during the pause, such as the turn's end, be handled
      // before the fence is checked.
      await new Promise((resolve) => setImmediate(resolve));
      const fence = readExecutionFence(this.store, this.jobId, this.execGen);
      if (!fence.ok || this.turnSettled || this.endNotified) {
        return;
      }
      const body = this.driver.formatBody ? this.driver.formatBody(ctx, { kind: "message", messageText: message.text, storedPrompt: this.job.prompt, predecessor: null, priorOutputBudget: PRIOR_OUTPUT_BUDGET }) : message.text;
      const text = composeRequestText({ messageId: message.id, uncertain: message.state === "dispatched", body, additions: [] });
      boundary("provider-request");
      const outcome = await this.driver.steer(ctx, { text, clientId });
      if (outcome === "turn-ended") {
        return;
      }
    }
  }

  async run() {
    const view = readJobView(this.store, this.jobId);
    if (!view) {
      return 0;
    }
    this.job = view.row;
    // A claim without the worker's start token could never be stopped by verified identity, by the
    // session-end hook or the monitor. The worker reads its own identity up to three times and
    // claims nothing without it; the job stays queued for the next launch.
    let own = { state: "unknown" };
    for (let attempt = 0; attempt < OWN_IDENTITY_ATTEMPTS && own.state !== "present"; attempt += 1) {
      own = await readProcessIdentity(process.pid, { deadline: performance.now() + IDENTITY_QUERY_MS });
    }
    if (own.state !== "present") {
      this.log(`the worker could not read its own process identity (${own.reason ?? own.state}); it claims nothing`);
      return 0;
    }
    this.self = { pid: process.pid, startToken: own.startToken, groupId: currentGroupId() };
    const maxParallel = readMaxParallel(this.stateDir, view.provider);
    const claimStarted = performance.now();
    for (;;) {
      const claim = await withRetry(
        (opts) => claimExecution(this.store, this.jobId, { pid: this.self.pid, startToken: this.self.startToken, groupId: this.self.groupId, limits: { maxParallel } }, opts),
        "worker"
      );
      if (claim.claimed) {
        this.execGen = claim.execGen;
        if (claim.worktreeUnavailable) {
          return this.endWorktreeUnavailable(view);
        }
        break;
      }
      if (claim.reason === "thread-busy" && performance.now() - claimStarted < THREAD_BUSY_LIMIT_MS) {
        await sleep(THREAD_BUSY_RETRY_MS);
        continue;
      }
      return 0;
    }
    testPoint("after-claim");
    this.claim = { pid: this.self.pid, startToken: this.self.startToken, jobId: this.jobId, execGen: this.execGen };
    try {
      writeLiveFile(this.stateDir, "worker", { ...this.claim, provider: null });
    } catch (error) {
      this.log(`the first heartbeat could not be written: ${error?.message ?? error}`);
      return 1;
    }
    this.job = readJobView(this.store, this.jobId).row;
    this.startTimers();
    try {
      return await this.execute();
    } catch (error) {
      if (error instanceof Aborted) {
        return this.shutdown(this.shutdownReason ?? error.reason);
      }
      this.log(`worker error: ${error?.stack ?? error}`);
      // An error before anything was sent to the provider (it could not start, or could not open
      // its thread) is the job's failure, with the provider's own message: the job ends failed
      // through the ordinary release path. A later error keeps the job for the scan, which ends
      // it interrupted, so its turn can be continued.
      const reason = this.requestWritten ? "error" : "start-failed";
      if (reason === "start-failed") {
        this.startFailure = `The job could not start: ${error?.message ?? String(error)}`;
        // The failure is recorded at once, before the provider's processes are confirmed gone:
        // nothing was sent, so there is no turn or thread a continuation could collide with, and
        // the user sees the reason now and not after the release is decided.
        try {
          await this.write((opts) =>
            recordEnd(this.store, this.jobId, { state: "failed", by: "worker", execGen: this.execGen, reason: "start-failed", error: this.startFailure }, opts)
          );
        } catch (writeError) {
          this.log(`the start failure could not be recorded: ${writeError?.message ?? writeError}`);
        }
      }
      this.requestShutdown(reason);
      return this.shutdown(reason);
    }
  }

  async execute() {
    const ctx = this.context();
    if (!(await this.write((opts) => recordIntent(this.store, this.jobId, this.execGen, "spawn", {}, opts)))) {
      return this.refused();
    }
    this.checkpoint();
    boundary("spawn");
    try {
      this.child = await this.driver.spawn(ctx);
    } catch (error) {
      this.log(`the provider could not be started: ${error?.message ?? error}`);
      await this.write((opts) => recordEnd(this.store, this.jobId, { state: "failed", by: "worker", execGen: this.execGen, error: `The provider could not be started: ${error?.message ?? error}` }, opts));
      await this.write((opts) => releaseExecution(this.store, this.jobId, this.execGen, { kind: "confirmed" }, opts));
      return this.finish(0);
    }
    this.child.exited.then((info) => {
      this.exitInfo = { ...info, wallAt: wallNow() };
    });
    testPoint("after-spawn");
    const identity = await readProcessIdentity(this.child.pid, { deadline: performance.now() + IDENTITY_QUERY_MS });
    // On Linux the provider leads its own process group, checked through the held handle (or, for a
    // driver without one, its identity). A provider that does not has no group recorded, and its
    // closure stays undecided until the grace window.
    const leads = this.child.child
      ? leadsOwnGroup(this.child.child)
      : process.platform === "linux" && identity.state === "present" && identity.groupId === this.child.pid;
    const groupId = leads ? this.child.pid : null;
    this.childIdentity = { pid: this.child.pid, startToken: identity.state === "present" ? identity.startToken : null, groupId };
    if (!(await this.write((opts) => recordIntent(this.store, this.jobId, this.execGen, "provider", this.childIdentity, opts)))) {
      await this.stopProviderTree(this.stopDeadline(performance.now() + STOP_WINDOW_FALLBACK_MS));
      return this.refused();
    }
    testPoint("after-provider");
    this.checkpoint();
    const prepared = await this.race(this.driver.prepare(ctx));
    if (prepared?.version) {
      await this.write((opts) => recordIntent(this.store, this.jobId, this.execGen, "version", { version: prepared.version }, opts));
    }
    const threadId = prepared?.threadId ?? this.job.thread_id;
    if (threadId) {
      const registered = await this.write((opts) => recordThread(this.store, this.jobId, this.execGen, { threadId, resumeMethod: this.driver.resumeMethod ?? "thread" }, opts));
      if (!registered.ok) {
        if (registered.reason !== "fenced") {
          await this.write((opts) => recordEnd(this.store, this.jobId, { state: "failed", by: "worker", execGen: this.execGen, error: "the thread is held or barred" }, opts));
        }
        return this.shutdown(registered.reason === "fenced" ? "stop" : "thread-refused");
      }
    }
    if (prepared?.turnInProgress && this.driver.interruptPrevious) {
      const outcome = await this.race(this.driver.interruptPrevious(ctx, prepared.turnInProgress, PREVIOUS_TURN_LIMIT_MS));
      if (outcome !== "ended") {
        await this.write((opts) => recordEnd(this.store, this.jobId, { state: "failed", by: "worker", execGen: this.execGen, error: "the previous turn on this thread did not end" }, opts));
        return this.shutdown("previous-turn");
      }
    }
    for (const message of deliverableMessages(this.store, this.job.chain_id).filter((entry) => entry.state === "dispatched")) {
      const found = this.driver.historyHas ? await this.race(this.driver.historyHas(ctx, [messageClientId(this.store.instanceId, message.id)])) : null;
      if (found && found.has(messageClientId(this.store.instanceId, message.id))) {
        await this.write((opts) =>
          confirmMessage(
            this.store,
            message.id,
            { expectedJobId: message.dispatched_job_id, expectedGen: message.dispatched_gen, observingJobId: this.jobId, observingGen: this.execGen, proof: "history" },
            opts
          )
        );
      }
    }
    this.checkpoint();
    const opening = deliverableMessages(this.store, this.job.chain_id)[0] ?? null;
    const kind = opening ? "message" : this.job.continues === null || this.job.resume_method === "stored-prompt" ? "prompt" : "continue";
    const predecessor = this.job.continues ? this.predecessorOutput() : null;
    const body = this.driver.formatBody
      ? this.driver.formatBody(ctx, { kind, messageText: opening?.text ?? null, storedPrompt: this.job.prompt, predecessor, priorOutputBudget: PRIOR_OUTPUT_BUDGET })
      : kind === "message"
        ? opening.text
        : kind === "prompt"
          ? this.job.prompt
          : CONTINUE_LINE;
    const additions = [this.job.allow_questions ? QUESTION_INSTRUCTION : null, ...(this.driver.additions?.(ctx) ?? [])].filter(Boolean);
    const text = composeRequestText({ messageId: opening?.id ?? null, uncertain: opening?.state === "dispatched", body, additions });
    const clientId = opening ? messageClientId(this.store.instanceId, opening.id) : submitClientId(this.store.instanceId, this.jobId);
    if (!(await this.write((opts) => recordIntent(this.store, this.jobId, this.execGen, "submit", { clientMessageId: clientId }, opts)))) {
      return this.refused();
    }
    if (opening) {
      const dispatch = await this.write((opts) => dispatchMessage(this.store, opening.id, { jobId: this.jobId, execGen: this.execGen }, opts));
      if (!dispatch.won) {
        return this.refused();
      }
      this.dispatched.set(clientId, opening.id);
    }
    testPoint("after-dispatch");
    const fence = readExecutionFence(this.store, this.jobId, this.execGen);
    if (!fence.ok) {
      return this.refused();
    }
    this.checkpoint();
    const request = await this.json(this.job.request_json);
    boundary("provider-request");
    const written = await this.race(this.driver.start(ctx, { text, clientId, outputSchema: request.outputSchema ?? null }));
    this.requestWritten = true;
    testPoint("after-write");
    this.turnEnded = Promise.resolve(written === "rejected" ? { status: "failed", text: "", json: null, error: "the provider rejected the request" } : this.driver.turnEnded);
    this.turnEnded.then(() => (this.endNotified = true));
    const providerGone = this.child.exited.then(() => ({ status: "failed", text: "", json: null, error: "the provider exited before the turn ended" }));
    const ended = await this.race(Promise.race([this.turnEnded, providerGone]));
    this.turnSettled = true;
    this.turnResult = ended;
    await this.queue;
    return this.naturalEnd(ended);
  }

  json(text) {
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  predecessorOutput() {
    const row = readJobView(this.store, this.job.continues)?.row;
    if (!row) {
      return null;
    }
    return {
      resultText: capUtf8(row.result_text ?? "", PRIOR_OUTPUT_BUDGET),
      logTail: capUtf8(tailOf(path.join(this.stateDir, "store", "artifacts", `${row.id}.log`), PRIOR_OUTPUT_BUDGET), PRIOR_OUTPUT_BUDGET)
    };
  }

  // A fenced write changed nothing: a stop or cancel arrived, or the execution was superseded.
  refused() {
    const row = readJobView(this.store, this.jobId)?.row;
    if (row && row.exec_gen === this.execGen && row.exec_released_at === null && (row.stop_requested_at !== null || row.cancel_requested_at !== null)) {
      this.observeStop(row);
      this.shutdownReason = this.shutdownReason ?? "stop";
      return this.shutdown("stop");
    }
    this.shutdownReason = this.shutdownReason ?? "fenced";
    return this.shutdown("fenced");
  }

  providerExited() {
    return this.exitInfo !== null;
  }

  // The deadline of a stop step: the local deadline of an observed stop request, else `fallback`.
  stopDeadline(fallback) {
    return this.localDeadline ?? fallback;
  }

  // Stops the provider's tree within `deadline`. While the worker holds the running ChildProcess it
  // stops through that handle with no identity query (Windows `taskkill /T /F`, Linux SIGKILL to
  // the provider's group); without the handle it stops by the root's verified identity.
  async stopProviderTree(deadline) {
    const result = await this.stopProviderTreeOnce(deadline);
    if (result === "stopped") {
      this.treeStop = { result, at: wallNow() };
    } else if (result === "late") {
      this.log("tree stop not started: no time left before the deadline");
    }
    return result;
  }

  async stopProviderTreeOnce(deadline) {
    if (!this.child || this.providerExited()) {
      return null;
    }
    let result;
    if (this.child.child) {
      result = await stopHeldTree(this.child.child, { groupId: this.childIdentity?.groupId ?? null, deadline });
    } else if (this.childIdentity?.startToken) {
      result = await stopTree(this.childIdentity, { deadline, expectedGroupId: this.childIdentity.groupId ?? null });
    } else {
      return "unknown";
    }
    if (result === "stopped") {
      await settleBy(this.child.exited, Math.min(deadline, performance.now() + 1000));
    }
    return result;
  }

  // What this worker witnessed about its provider: its own tree stop when the stop command
  // succeeded on a running root, and the root's exit when it saw one. An exit is never credited to
  // the end of stdin.
  witnessed({ stopResult, stoppedAt }) {
    const stop = stopResult === "stopped" ? { result: stopResult, at: stoppedAt } : (this.treeStop ?? null);
    const rootExitSeenAt = this.providerExited() ? this.exitInfo.wallAt : null;
    return { stopResult: stop?.result ?? stopResult, stoppedAt: stop?.at ?? stoppedAt, rootExitSeenAt };
  }

  async shutdown(reason) {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.ending = true;
    this.shutdownPromise = this.runShutdown(reason);
    return this.shutdownPromise;
  }

  async runShutdown(reason) {
    const ctx = this.context();
    if (reason === "store-lost" || reason === "heartbeat" || reason === "fenced" || reason === "error") {
      this.log(`shutting down: ${reason}`);
      if (this.child && !this.providerExited()) {
        await this.stopProviderTree(performance.now() + STOP_WINDOW_FALLBACK_MS);
      }
      return this.finish(reason === "fenced" ? 0 : 1, { removeLive: reason !== "store-lost" });
    }
    let row = this.read(() => readJobView(this.store, this.jobId))?.row ?? this.job;
    if (row.stop_requested_at !== null || row.cancel_requested_at !== null) {
      this.observeStop(row);
    }
    const local = this.localDeadline ?? performance.now() + STOP_WINDOW_FALLBACK_MS;
    let stopResult = null;
    let stoppedAt = null;
    let rootExitSeenAt = null;
    const turnRunning = this.requestWritten && !this.turnSettled;
    if (this.child && !this.providerExited()) {
      const canInterrupt = Boolean(this.driver.capabilities?.interrupt && this.driver.interrupt);
      if (turnRunning && canInterrupt) {
        try {
          await this.driver.interrupt(ctx);
        } catch {
          // A failed interrupt falls through to the tree stop.
        }
        const ended = await settleBy(this.turnEnded ?? Promise.resolve(null), local - INTERRUPT_MARGIN_MS, null);
        if (ended) {
          this.turnSettled = true;
          this.turnResult = ended;
        }
      }
      await this.settleOwnExit(local);
      // Linux ends the provider's input and waits for its exit; the provider's process group then
      // decides closure. Windows has no such step: the tree stop follows at once.
      if (process.platform !== "win32" && !this.providerExited() && (!turnRunning || canInterrupt)) {
        try {
          this.driver.endInput(ctx);
        } catch {
          // The provider's input may already be closed.
        }
        await settleBy(this.child.exited, local - EXIT_MARGIN_MS);
      }
      if (!this.providerExited()) {
        this.log(`tree stop at ${performance.now().toFixed(1)}`);
        stopResult = await this.stopProviderTree(local);
        stoppedAt = stopResult === "stopped" ? wallNow() : null;
      }
    }
    await this.queue;
    ({ stopResult, stoppedAt, rootExitSeenAt } = this.witnessed({ stopResult, stoppedAt }));
    row = this.read(() => readJobView(this.store, this.jobId))?.row ?? row;
    // The end of a stopped job is recorded with its release, in one transaction, once the release
    // is decided; until then the job reads stopping and cannot be continued.
    let pendingEnd = null;
    if (row.end_state === null) {
      const cancel = row.cancel_requested_at !== null;
      const { resumable, reason: notResumable } = resumability(row);
      let end;
      if (reason === "thread-refused") {
        end = { state: "failed", error: "the provider reported a thread that is held or barred", reason: "thread-refused" };
      } else if (cancel) {
        end = { state: "cancelled", reason: stopResult === "stopped" ? "tree-stop" : null };
      } else if (reason === "start-failed") {
        end = { state: "failed", error: this.startFailure, reason: "start-failed" };
      } else if (resumable) {
        end = { state: "interrupted", reason: row.stop_reason ?? reason };
      } else {
        end = { state: "failed", reason: row.stop_reason ?? reason, error: `The job stopped before its turn ended and cannot be continued: ${notResumable}.` };
      }
      const result = this.turnResult && this.turnResult.status === "answer" ? this.resultOf(this.turnResult) : null;
      pendingEnd = { end, result };
    }
    await this.releaseByEvidence({ deadline: local, rootExitSeenAt, stopResult, stoppedAt, pendingEnd });
    if (reason === "start-failed") {
      await this.discardUnusedWorktree();
    }
    return this.finish(reason === "start-failed" ? 1 : 0);
  }

  // A worktree made for this job, which failed before the provider did anything in it, is removed
  // with its branch. A continuation works in the worktree of the job it continues, and a job that
  // has a thread may have changed files there; both are kept.
  async discardUnusedWorktree() {
    const row = this.read(() => readJobView(this.store, this.jobId))?.row ?? this.job;
    if (!row || row.end_state !== "failed" || row.end_reason !== "start-failed" || row.continues || row.thread_id) {
      return;
    }
    let worktree = null;
    try {
      worktree = JSON.parse(row.request_json ?? "{}").worktree ?? null;
    } catch {
      worktree = null;
    }
    if (!worktree?.path || !worktree.branch) {
      return;
    }
    try {
      // Loaded here, not at the top: the git module's own imports lead back to this file.
      const [{ removeWorktree }, { resolveWorkspaceRoot }] = await Promise.all([import("./git.mjs"), import("./workspace.mjs")]);
      removeWorktree(resolveWorkspaceRoot(row.cwd), worktree.path, worktree.branch);
      this.log(`removed the unused worktree ${worktree.path}`);
    } catch (error) {
      this.log(`the unused worktree ${worktree.path} could not be removed: ${error?.message ?? error}`);
    }
  }

  resultOf(turn) {
    const capped = capResult({ text: turn.text ?? "", json: turn.json ?? null });
    let logged = false;
    try {
      fs.appendFileSync(this.logFile, `\n[${new Date().toISOString()}] Final output\n${turn.text ?? ""}\n${turn.json === null || turn.json === undefined ? "" : `${JSON.stringify(turn.json)}\n`}`);
      logged = true;
    } catch {
      logged = false;
    }
    return { text: turn.text ?? "", json: turn.json ?? null, logged, truncated: capped.truncated };
  }

  async releaseByEvidence({ deadline, rootExitSeenAt, stopResult, stoppedAt, pendingEnd = null }) {
    const endIfUndecided = { by: "worker", reason: pendingEnd?.end?.reason ?? "worker-dead", end: pendingEnd?.end ?? null, result: pendingEnd?.result ?? null };
    for (;;) {
      const input = this.read(() => readEvidenceInput(this.store, this.jobId));
      if (!input || input.execGen !== this.execGen || input.released) {
        return;
      }
      const witnessed = { deadline, rootExitSeenAt, stopResult };
      if (!input.spawnIntentRecorded || (this.child === null && !input.rootRecorded)) {
        await this.releaseWithin(witnessed, "confirmed", endIfUndecided, pendingEnd);
        return;
      }
      const evidence = await observeClosure(input, { deadline, rootExitSeenAt, stopResult, stoppedAt });
      const decision = decideRelease(evidence);
      if (decision.kind === "confirmed" || decision.kind === "unobserved") {
        testPoint("before-release");
        await this.releaseWithin(witnessed, decision.kind, endIfUndecided, pendingEnd);
        return;
      }
      const until = decision.until ?? null;
      if (until === null || until - wallNow() > deadline - performance.now() || until - wallNow() > RELEASE_WAIT_LIMIT_MS) {
        await this.leaveUnconfirmed(witnessed, pendingEnd, decision.reason);
        return;
      }
      await sleep(Math.max(10, until - wallNow()));
    }
  }

  // Commits the release before the deadline and, still before it, launches the cohort. Past the
  // deadline nothing is released or launched: the execution is left fenced for the scan.
  async releaseWithin(witnessed, kind, endIfUndecided, pendingEnd) {
    if (witnessed.deadline - performance.now() <= 0) {
      await this.leaveUnconfirmed(witnessed, pendingEnd, "the deadline passed before the release");
      return;
    }
    let released;
    try {
      released = await this.write((opts) => releaseExecution(this.store, this.jobId, this.execGen, { kind, endIfUndecided }, opts), { deadline: witnessed.deadline });
    } catch (error) {
      if (error instanceof Aborted) {
        throw error;
      }
      await this.leaveUnconfirmed(witnessed, pendingEnd, `the release did not commit before the deadline: ${error?.message ?? error}`);
      return;
    }
    testPoint("after-release");
    if (released && witnessed.deadline - performance.now() > 0) {
      await this.launchCohort(witnessed.deadline);
    } else if (released) {
      this.log("the next queued jobs are left to the scan: the deadline passed after the release");
    }
  }

  // Leaves an execution whose release is not established to reconciliation in one write: the
  // root exit the worker saw with no tree stop of its own (so a later scan never credits it as
  // owner death) and, for a job with no end decision, `stopping` (`unconfirmed-stop`) with any
  // late result. The write takes the deadline; once it has passed, the worker's single
  // post-deadline write may wait at most STOP_WRITE_LAST_ATTEMPT_MS. The claim, thread key and
  // admission place stay held.
  async leaveUnconfirmed({ deadline, rootExitSeenAt, stopResult }, pendingEnd, reason) {
    const exitSeenAt = rootExitSeenAt !== null && rootExitSeenAt !== undefined && stopResult !== "stopped" ? rootExitSeenAt : null;
    try {
      await this.writeBy(
        (opts) => leaveExecutionUnconfirmed(this.store, this.jobId, this.execGen, { exitSeenAt, result: pendingEnd?.result ?? null }, opts),
        deadline
      );
    } catch (error) {
      if (error instanceof Aborted) {
        throw error;
      }
      this.log(`the fenced state could not be recorded before the deadline: ${error?.message ?? error}`);
    }
    this.log(`release left to reconciliation: ${reason}`);
  }

  // A claimed job whose worktree is under removal or gone ends failed with the reason `worktree
  // removed` and releases its execution without starting its provider, then the provider's cohort
  // is launched into the freed place.
  async endWorktreeUnavailable(view) {
    this.job = view.row;
    this.log("the job's worktree is under removal or gone; the provider is not started");
    await this.write((opts) =>
      recordEnd(
        this.store,
        this.jobId,
        {
          state: "failed",
          by: "worker",
          execGen: this.execGen,
          reason: "worktree removed",
          error: "The job's worktree was removed or is being removed, so the job did not run."
        },
        opts
      )
    );
    await this.write((opts) => releaseExecution(this.store, this.jobId, this.execGen, { kind: "confirmed" }, opts));
    await this.launchCohort();
    return 0;
  }

  // A released execution frees an admission place, so the provider's cohort is launched; a member
  // whose launch would start after `deadline` is left to the next scan.
  async launchCohort(deadline = undefined) {
    try {
      await launchEligible(this.store, this.stateDir, this.job.provider, { deadline });
    } catch (error) {
      this.log(`launching the next queued jobs failed: ${error?.message ?? error}`);
    }
  }

  async naturalEnd(turn) {
    this.ending = true;
    const ctx = this.context();
    let stopResult = null;
    let stoppedAt = null;
    if (turn.stopRoot) {
      stopResult = await this.stopProviderTree(this.stopDeadline(performance.now() + STOP_WINDOW_FALLBACK_MS));
      stoppedAt = stopResult === "stopped" ? wallNow() : null;
    }
    const result = this.resultOf(turn);
    const question = extractQuestion({ text: turn.text ?? "", json: turn.json ?? null, allowQuestions: Boolean(this.job.allow_questions) });
    const endState = turn.status === "failed" ? "failed" : question.question ? "waiting" : "completed";
    testPoint("before-end");
    const leaderIdentity = this.job.leader_pid === null ? null : await readProcessIdentity(this.job.leader_pid, { deadline: performance.now() + IDENTITY_QUERY_MS });
    const leader = this.job.leader_pid === null ? "none" : leaderState({ row: this.job }, leaderIdentity);
    const finalResult = { ...result, json: question.json };
    const outcome = await this.write((opts) =>
      recordEnd(
        this.store,
        this.jobId,
        { state: endState, by: "worker", execGen: this.execGen, question: question.question, error: endState === "failed" ? (turn.error ?? "the turn failed") : null, result: finalResult, leader },
        opts
      )
    );
    if (!outcome.won) {
      await this.write((opts) => storeLateResult(this.store, this.jobId, this.execGen, finalResult, opts));
    }
    testPoint("after-end");
    testPoint("before-shutdown");
    let rootExitSeenAt = null;
    await this.settleOwnExit();
    if (!this.providerExited()) {
      // On Windows a provider that does not exit by itself after its turn is stopped through the
      // held handle once the end decision is committed, without ending its input first. Elsewhere,
      // and for a provider that exits by itself, the worker ends its input and waits for its exit.
      if (process.platform !== "win32" || this.driver.capabilities?.ownExit) {
        try {
          this.driver.endInput(ctx);
        } catch {
          // The provider's input may already be closed.
        }
        await this.waitForNaturalExit(performance.now() + envNumber(this.env, "AGENT_PLUGIN_NATURAL_EXIT_MS", DEFAULT_NATURAL_EXIT_MS));
      }
      if (!this.providerExited()) {
        this.noteStopRequest();
        this.log(`tree stop at ${performance.now().toFixed(1)}`);
        stopResult = await this.stopProviderTree(this.stopDeadline(performance.now() + STOP_WINDOW_FALLBACK_MS));
        stoppedAt = stopResult === "stopped" ? wallNow() : null;
      }
    }
    testPoint("after-provider-exit");
    ({ stopResult, stoppedAt, rootExitSeenAt } = this.witnessed({ stopResult, stoppedAt }));
    const releaseDeadline = this.localDeadline ?? performance.now() + RELEASE_WAIT_LIMIT_MS;
    await this.releaseByEvidence({ deadline: releaseDeadline, rootExitSeenAt, stopResult, stoppedAt });
    return this.finish(0);
  }

  // A root that already exited by itself is waited for (up to 2 seconds, never past `deadline`), so
  // its exit is seen before the worker ends its input or stops its tree.
  async settleOwnExit(deadline = Infinity) {
    await new Promise((resolve) => setImmediate(resolve));
    if (this.child && !this.providerExited() && !isProcessAlive(this.child.pid)) {
      await settleBy(this.child.exited, Math.min(performance.now() + 2000, deadline));
    }
  }

  // Takes the local deadline of a stop request committed during the natural end, once.
  noteStopRequest() {
    if (this.localDeadline !== null) {
      return;
    }
    try {
      const row = readJobView(this.store, this.jobId, { attemptMs: RETRY_BUDGETS.worker.attemptMs })?.row;
      if (row && (row.stop_requested_at !== null || row.cancel_requested_at !== null)) {
        this.observeStop(row);
      }
    } catch {
      // A failed read leaves the fallback budget; the stop poll is not running during the end.
    }
  }

  // Waits for the provider's own exit after its input ended. A stop request committed meanwhile is
  // honoured against its stored deadline: the wait then ends 0.5 s before the local deadline.
  async waitForNaturalExit(naturalDeadline) {
    for (;;) {
      if (this.providerExited()) {
        return;
      }
      this.noteStopRequest();
      const until = this.localDeadline === null ? naturalDeadline : Math.min(naturalDeadline, this.localDeadline - EXIT_MARGIN_MS);
      const remaining = until - performance.now();
      if (remaining <= 0) {
        return;
      }
      await settleBy(this.child.exited, performance.now() + Math.min(remaining, STOP_POLL_MS));
    }
  }

  finish(code, { removeLive = true } = {}) {
    this.clearTimers();
    if (removeLive && this.claim) {
      try {
        removeLiveFile(this.stateDir, "worker", this.self.pid);
      } catch {
        // A file left behind is diagnostic only.
      }
    }
    return code;
  }
}

// A worker that cannot confirm a release within this time leaves it to reconciliation.
const RELEASE_WAIT_LIMIT_MS = 10000;
// The local stop budget when a shutdown has no stored deadline (for example a refused thread).
const STOP_WINDOW_FALLBACK_MS = 4000;
// How long the one stop-phase write made after the deadline may wait for the store.
const STOP_WRITE_LAST_ATTEMPT_MS = 50;

/**
 * Runs one job's execution in this worker process with `driver`; resolves to the exit code
 * (0 after a normal end or a refused claim, 1 when the runtime gate, the store or the heartbeat
 * failed). The worker never submits a second turn.
 */
export async function runJobExecution(stateDir, jobId, driver, { env = process.env } = {}) {
  const gate = checkRuntime();
  if (!gate.ok) {
    process.stderr.write(`${runtimeGateMessage(gate)}\n`);
    return 1;
  }
  let store;
  try {
    store = openStore(stateDir, { busyTimeoutMs: RETRY_BUDGETS.worker.attemptMs });
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    return 1;
  }
  const run = new WorkerRun(store, stateDir, jobId, driver, env);
  try {
    return await run.run();
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    return 1;
  } finally {
    run.clearTimers();
    store.close();
  }
}

/**
 * Waits for a job, polling with one short read every 250 ms: until its end decision (`end`),
 * until it leaves queued, running and stopping (`not-active`), or until `messageId` is consumed or
 * closed (`consumed`). `onLog` receives new log bytes; `deliver` records that the outcome was
 * returned. Resolves with `{ kind, view | outcome, timedOut }`.
 */
export async function waitForJob(stateDir, jobId, { until = "end", messageId = null, timeoutMs = 60000, onLog = null, deliver = false } = {}) {
  const store = openStore(stateDir, { busyTimeoutMs: RETRY_BUDGETS.command.attemptMs });
  const logFile = path.join(stateDir, "store", "artifacts", `${jobId}.log`);
  let offset = 0;
  const readLog = () => {
    if (!onLog) {
      return;
    }
    try {
      const size = fs.statSync(logFile).size;
      if (size > offset) {
        const buffer = Buffer.alloc(size - offset);
        const fd = fs.openSync(logFile, "r");
        try {
          fs.readSync(fd, buffer, 0, buffer.length, offset);
        } finally {
          fs.closeSync(fd);
        }
        offset = size;
        boundary("stdout");
        onLog(buffer.toString("utf8"));
      }
    } catch {
      // A missing log has nothing to print yet.
    }
  };
  const started = performance.now();
  try {
    for (;;) {
      const timedOut = performance.now() - started >= timeoutMs;
      if (until === "consumed") {
        const outcome = readMessageOutcome(store, messageId);
        readLog();
        if (!outcome || ["consumed", "dropped", "withdrawn"].includes(outcome.state) || timedOut) {
          return { kind: "message", outcome, timedOut: timedOut && !(outcome && ["consumed", "dropped", "withdrawn"].includes(outcome.state)) };
        }
      } else {
        const view = readJobView(store, jobId);
        readLog();
        const done = !view || (until === "end" ? view.row.end_state !== null || view.state === "cancelled" : !["queued", "running", "stopping"].includes(view.state));
        if (done || timedOut) {
          if (done && view && deliver) {
            markDelivered(store, jobId);
          }
          return { kind: "end", view, timedOut: !done };
        }
      }
      boundary("wait");
      await sleep(250);
    }
  } finally {
    store.close();
  }
}
