import fs from "node:fs";

import { getProvider, providerForJob } from "./providers.mjs";
import { isProcessAlive, readProcessCommandLines, terminateProcessTree } from "./process.mjs";
import { getConfig, listJobs, readJobFile, resolveJobFile, upsertJob } from "./state.mjs";
import { nowIso, SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;
export const WORKER_START_GRACE_MS = 30_000;

function isActiveJob(job) {
  return job.status === "queued" || job.status === "running";
}

// The job's provider decides whether a dead worker's turn can still be running elsewhere.
function interruptOrphanedTurn(workspaceRoot, job) {
  return providerForJob(job).interruptOrphanedTurn(workspaceRoot, job);
}

/**
 * Marks active jobs whose worker is gone as failed and returns their ids. A job with a PID
 * fails when that process no longer exists; a queued job without a PID fails once its worker
 * has had `WORKER_START_GRACE_MS` to start. A record that finished in the meantime is kept.
 */
export async function reconcileJobLiveness(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const now = options.now ?? Date.now();
  const isAlive = options.isAlive ?? isProcessAlive;
  const interruptTurn = options.interruptTurn ?? interruptOrphanedTurn;
  const reaped = [];

  for (const job of listJobs(workspaceRoot)) {
    if (!isActiveJob(job)) {
      continue;
    }
    let errorMessage = null;
    if (job.pid == null) {
      if (job.status === "queued" && now - Date.parse(job.createdAt ?? "") > WORKER_START_GRACE_MS) {
        errorMessage = "The background worker did not start.";
      }
    } else if (!isAlive(job.pid)) {
      errorMessage = "The worker process exited before the job finished.";
      if (job.threadId && job.turnId) {
        try {
          await interruptTurn(workspaceRoot, job);
        } catch {
          // The job fails either way; an unreachable broker leaves nothing to interrupt.
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
    const marker = job.processMarker ?? providerForJob(job).processMarker;
    if (commandLines && !commandLines.get(job.pid).includes(marker)) {
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
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
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

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
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

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
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

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => job.status !== "queued" && job.status !== "running" && job.id !== latestFinished?.id)
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
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`);
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
