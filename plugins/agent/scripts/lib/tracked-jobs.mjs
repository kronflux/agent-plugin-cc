import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { isJobCancelled, readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
// Text that the command line of a job's process contains. A background worker has its job id
// in its arguments; a foreground run is identified by the companion script name.

function processMarkerFor(jobId) {
  return process.argv.includes(jobId) ? jobId : path.basename(process.argv[1] ?? "") || null;
}

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  // CLAUDE_PID names the Claude Code process the job was started from; the job monitor of that
  // process announces the job.
  const claudePid = /^\d+$/.test(env.CLAUDE_PID ?? "") ? env.CLAUDE_PID : null;
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {}),
    ...(claudePid ? { claudePid } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    upsertJob(workspaceRoot, patch);
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null, label = "agent" } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[${label}] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

const CANCELLED_BEFORE_START = "Cancelled before the turn started.";

function failureMessageOf(execution) {
  const message = execution.payload?.failureMessage;
  if (typeof message === "string" && message.trim()) {
    return message.trim();
  }
  return typeof execution.summary === "string" && execution.summary.trim() ? execution.summary.trim() : null;
}

/**
 * Runs a job and records its outcome. The running record publishes this process's id; then
 * `options.onStarted` runs, and a job cancelled by then returns a cancelled result without
 * calling `runner` (its stored status reads as cancelled through the cancel marker). A
 * failure to write the log block leaves the completed record in place.
 */
export async function runTrackedJob(job, runner, options = {}) {
  const logFile = options.logFile ?? job.logFile ?? null;
  // The prompt of a legacy record is handed to the worker separately and never stored again.
  const { request: _request, ...jobFields } = job;
  const runningRecord = {
    ...jobFields,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    processMarker: processMarkerFor(job.id),
    logFile
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);

  // A cancel that ran before this process's id was recorded could not stop it, so it is
  // honoured here, before the turn starts.
  options.onStarted?.();
  if (isJobCancelled(job.workspaceRoot, job.id)) {
    return {
      exitStatus: 1,
      cancelled: true,
      threadId: null,
      turnId: null,
      payload: { status: "cancelled", jobId: job.id },
      rendered: `${CANCELLED_BEFORE_START}\n`,
      summary: CANCELLED_BEFORE_START
    };
  }

  let execution;
  try {
    execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    const stored = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    // A failed run keeps its message in errorMessage, the field a thrown failure fills too.
    const failureMessage = completionStatus === "failed" ? failureMessageOf(execution) : null;
    writeJobFile(job.workspaceRoot, job.id, {
      ...stored,
      ...(failureMessage ? { errorMessage: failureMessage } : {}),
      status: completionStatus,
      threadId: execution.threadId ?? stored.threadId ?? null,
      turnId: execution.turnId ?? stored.turnId ?? null,
      ...(execution.summary === undefined ? {} : { summary: execution.summary }),
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: execution.payload,
      rendered: execution.rendered
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    let existing;
    try {
      existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    } catch {
      existing = runningRecord;
    }
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt: nowIso(),
      logFile: logFile ?? existing.logFile ?? null
    });
    throw error;
  }

  try {
    appendLogBlock(logFile, "Final output", execution.rendered);
  } catch {
    // The completed record already holds the output; a log that cannot be written loses only its copy.
  }
  return execution;
}
