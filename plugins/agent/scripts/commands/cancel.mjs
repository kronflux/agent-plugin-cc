import process from "node:process";

import { outputCommandResult, parseCommandInput, resolveCommandCwd, sleep } from "../lib/companion-cli.mjs";
import { readStoredJob, reconcileJobLiveness, resolveCancelableJob, terminateJobProcesses } from "../lib/job-control.mjs";
import { isProcessAlive } from "../lib/process.mjs";
import { providerForJob } from "../lib/providers.mjs";
import { renderCancelReport } from "../lib/render.mjs";
import { markJobCancelled, upsertJob } from "../lib/state.mjs";
import { appendLogLine, nowIso } from "../lib/tracked-jobs.mjs";

// How long cancel waits for an interrupted worker to finish its turn and exit by itself.
export const INTERRUPT_EXIT_WAIT_MS = 10000;

export const usage = "cancel [job-id] [--json]";

export async function run(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  await reconcileJobLiveness(cwd);
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const { payload, nextJob } = await cancelJob(workspaceRoot, job, existing);
  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

/**
 * Cancels a job: marks it cancelled, asks its provider to interrupt the turn, stops its
 * processes, and records it as cancelled. `existing` is the job's stored record read before the
 * call; the record is read again after the cancel marker is written. Returns the command payload
 * and the job as reported.
 */
export async function cancelJob(workspaceRoot, job, existing, deps = {}) {
  const {
    interruptTurn = (cwd, ids) => providerForJob(job).interruptTurn(cwd, ids),
    terminate = terminateJobProcesses,
    readStoredJob: readStored = (root, jobId) => readStoredJob(root, jobId, { ignoreCancelMarker: true }),
    isAlive = isProcessAlive,
    sleep: wait = sleep
  } = deps;
  markJobCancelled(workspaceRoot, job.id);
  // A worker publishes its pid and then checks the marker, so the record read after the marker
  // holds the pid of every worker that can still start a turn.
  const current = readStored(workspaceRoot, job.id) ?? existing;
  const threadId = current.threadId ?? job.threadId ?? null;
  const turnId = current.turnId ?? job.turnId ?? null;

  const provider = providerForJob(job);
  const interrupt = await interruptTurn(workspaceRoot, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested ${provider.label} turn interrupt for ${turnId} on ${threadId}.`
        : `${provider.label} turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  // An interrupted worker normally records the stopped turn and exits on its own; it is
  // stopped by force only if it is still running after the wait.
  const workerPid = current.pid ?? job.pid ?? null;
  if (interrupt.interrupted && Number.isInteger(workerPid)) {
    const deadline = Date.now() + INTERRUPT_EXIT_WAIT_MS;
    while (isAlive(workerPid) && Date.now() < deadline) {
      await wait(100);
    }
    if (isAlive(workerPid)) {
      appendLogLine(job.logFile, `The worker was still running ${INTERRUPT_EXIT_WAIT_MS / 1000} s after the interrupt.`);
    }
  }
  const [termination] = terminate([{ ...job, ...current }]);
  if (termination?.outcome === "pid-reused") {
    appendLogLine(job.logFile, `Process ${termination.pid} no longer belongs to this job; it was not stopped.`);
  } else if (termination?.outcome === "failed") {
    appendLogLine(job.logFile, `Stopping process ${termination.pid} failed: ${termination.detail}`);
  }
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  // Only the cancellation fields are replaced, in one read-modify-write, so a result the worker
  // wrote before that read is kept. The step is not locked: a result written between the read
  // and the replace can be lost. The listed job fills in fields the record does not have.
  upsertJob(
    workspaceRoot,
    {
      id: job.id,
      status: "cancelled",
      phase: "cancelled",
      pid: null,
      completedAt,
      cancelledAt: completedAt,
      errorMessage: "Cancelled by user."
    },
    { defaults: job }
  );

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };
  return { payload, nextJob };
}
