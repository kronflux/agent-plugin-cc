import fs from "node:fs";

import { getProvider, providerForJob } from "./providers.mjs";
import { isProcessAlive, readProcessCommandLines, terminateProcessTree } from "./process.mjs";
import { getConfig, listJobs, readJobFile, resolveJobFile, upsertJob } from "./state.mjs";
import { getSessionId } from "./host.mjs";
import { nowIso } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;
export const WORKER_START_GRACE_MS = 30_000;
const MAX_PROGRESS_LOG_BYTES = 64 * 1024;

function isActiveJob(job) {
  return job.status === "queued" || job.status === "running";
}

// The job's provider decides whether a dead worker's turn can still be running elsewhere.
function interruptOrphanedTurn(workspaceRoot, job) {
  return providerForJob(job).interruptOrphanedTurn(workspaceRoot, job);
}

// The time a queued job's worker had to start from: its creation, else its last update. A
// record with neither timestamp readable has had its chance.
function queuedSince(job) {
  for (const value of [job.createdAt, job.updatedAt]) {
    const parsed = Date.parse(value ?? "");
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return -Infinity;
}

// A record without a marker, or with an empty one, which every command line contains, is
// checked against its provider's marker.
function jobProcessMarker(job) {
  return job.processMarker || providerForJob(job).processMarker;
}

/**
 * Marks active jobs whose worker is gone as failed and returns their ids. A job with a PID
 * fails when that process no longer exists, or when its command line no longer contains the
 * job's marker because the PID now belongs to another program. When the command-line lookup
 * fails or returns an empty line, the job is kept. A queued job without a PID fails once its
 * worker has had `WORKER_START_GRACE_MS` to start. A record that finished in the meantime is kept.
 */
export async function reconcileJobLiveness(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const now = options.now ?? Date.now();
  const isAlive = options.isAlive ?? isProcessAlive;
  const readCommandLines = options.readCommandLines ?? readProcessCommandLines;
  const interruptTurn = options.interruptTurn ?? interruptOrphanedTurn;
  const reaped = [];

  const activeJobs = listJobs(workspaceRoot).filter(isActiveJob);
  const alivePids = new Set();
  for (const job of activeJobs) {
    if (job.pid != null && isAlive(job.pid)) {
      alivePids.add(job.pid);
    }
  }
  const commandLines = alivePids.size > 0 ? readCommandLines([...alivePids]) : new Map();

  for (const job of activeJobs) {
    let errorMessage = null;
    if (job.pid == null) {
      if (job.status === "queued" && now - queuedSince(job) > WORKER_START_GRACE_MS) {
        errorMessage = "The background worker did not start.";
      }
    } else if (!alivePids.has(job.pid)) {
      errorMessage = "The worker process exited before the job finished.";
    } else if (commandLines) {
      const commandLine = commandLines.get(job.pid);
      if (commandLine === undefined) {
        errorMessage = "The worker process exited before the job finished.";
      } else if (commandLine && !commandLine.includes(jobProcessMarker(job))) {
        errorMessage = "The worker process is gone; its process id now belongs to another program.";
      }
    }
    if (errorMessage && job.pid != null) {
      if (job.threadId && job.turnId) {
        try {
          await interruptTurn(workspaceRoot, job);
        } catch {
          // The job fails either way; a turn that cannot be reached leaves nothing to interrupt.
        }
      }
    }
    if (!errorMessage) {
      continue;
    }
    const updated = upsertJob(
      workspaceRoot,
      { id: job.id, status: "failed", phase: "failed", pid: null, errorMessage, completedAt: nowIso() },
      { onlyIf: (current) => current !== null && isActiveJob(current) && current.pid === job.pid }
    );
    if (updated) {
      reaped.push(job.id);
    }
  }
  return reaped;
}

/**
 * Stops the processes of active jobs. A PID is signalled only when its command line still
 * identifies the job, so a PID reused by an unrelated process is left alone. When the lookup
 * itself fails, the PID is signalled.
 */
export function terminateJobProcesses(jobs, options = {}) {
  const readCommandLines = options.readCommandLines ?? readProcessCommandLines;
  const terminate = options.terminate ?? terminateProcessTree;
  const targets = jobs.filter((job) => isActiveJob(job) && Number.isInteger(job.pid) && job.pid > 0);
  const commandLines = targets.length > 0 ? readCommandLines(targets.map((job) => job.pid)) : new Map();

  return targets.map((job) => {
    if (commandLines && !commandLines.has(job.pid)) {
      return { jobId: job.id, pid: job.pid, outcome: "not-running" };
    }
    if (commandLines && !commandLines.get(job.pid).includes(jobProcessMarker(job))) {
      return { jobId: job.id, pid: job.pid, outcome: "pid-reused" };
    }
    try {
      const result = terminate(job.pid);
      return { jobId: job.id, pid: job.pid, outcome: result?.delivered === false ? "not-running" : "terminated" };
    } catch (error) {
      return { jobId: job.id, pid: job.pid, outcome: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
  });
}

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function getCurrentSessionId(options = {}) {
  return getSessionId(options.env) ?? getSessionId(process.env);
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

// Reads at most the last `maxBytes` of a file. When the read starts inside the file, the first
// line is partial and is dropped.
function readFileTail(file, maxBytes) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, start + offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    const text = buffer.subarray(0, offset).toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = readFileTail(logFile, MAX_PROGRESS_LOG_BYTES)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (/^starting \S+ (task|review) thread/.test(line) || line.startsWith("thread ready") || line.startsWith("turn started")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("turn completed")) {
      return "finalizing";
    }
    if (/^\S+ error:/.test(line) || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null
  };

  return {
    ...enriched,
    phase: enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview)
  };
}

export function readStoredJob(workspaceRoot, jobId, options = {}) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile, options);
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  throw new Error(`No job found for "${reference}". Run /agent:status to list known jobs.`);
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), options));
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => job.status !== "queued" && job.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  // Only finished jobs count toward `maxJobs`; active jobs are all listed under `running`.
  const finished = jobs.filter((job) => !isActiveJob(job));
  const recent = (options.all ? finished : finished.slice(0, maxJobs))
    .filter((job) => job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getProvider().sessionRuntimeStatus(options.env, workspaceRoot),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /agent:status to inspect known jobs.`);
  }

  return {
    workspaceRoot,
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines })
  };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot)));
  if (reference) {
    // A reference that names an active job gets the still-running answer, not "No job found".
    let direct = null;
    try {
      direct = matchJobReference(jobs, reference);
    } catch {
      direct = null;
    }
    if (direct && isActiveJob(direct)) {
      throw new Error(`Job ${direct.id} is still ${direct.status}. Check /agent:status and try again once it finishes.`);
    }
  }
  const selected = matchJobReference(
    jobs,
    reference,
    (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled"
  );

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(jobs, reference, (job) => job.status === "queued" || job.status === "running");
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Check /agent:status and try again once it finishes.`);
  }

  if (reference) {
    throw new Error(`No finished job found for "${reference}". Run /agent:status to inspect active jobs.`);
  }

  throw new Error("No finished jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");

  if (reference) {
    const selected = matchJobReference(jobs, reference);
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`);
    }
    if (selected.status !== "queued" && selected.status !== "running") {
      throw new Error(`Job ${selected.id} has already ${selected.status === "completed" ? "completed" : `ended (${selected.status})`}, so there is nothing to cancel.`);
    }
    return { workspaceRoot, job: selected };
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error("Multiple jobs are active. Pass a job id to /agent:cancel.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active jobs to cancel for this session.");
  }

  throw new Error("No active jobs to cancel.");
}
