#!/usr/bin/env node

// Runs as the plugin's monitor for the whole Claude Code session. Each line it prints reaches
// Claude as a notification and costs a model turn, so it prints one line per job, only when a
// job of this Claude Code process finishes and no command has printed the job's result: a
// background task nobody waited for, or a new turn started by send. Starts, progress, and
// cancellations are not announced.

import process from "node:process";

import { getHostPid, setPluginDataDir } from "./lib/host.mjs";
import { isProcessAlive } from "./lib/process.mjs";
import { providerForJob } from "./lib/providers.mjs";
import { isJobResultDelivered, listJobs } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const POLL_MS = readPositiveInt(process.env.CODEX_COMPANION_MONITOR_POLL_MS, 2000);
// A command that waits for the job, such as the rescue agent's result --wait, gets this long
// to print the result before the job is announced.
const DELIVERY_GRACE_MS = readPositiveInt(process.env.CODEX_COMPANION_MONITOR_GRACE_MS, 5000);
const ACTIVE_STATUSES = new Set(["queued", "running"]);

function readPositiveInt(value, fallback) {
  return /^\d+$/.test(String(value ?? "")) && Number(value) > 0 ? Number(value) : fallback;
}

// The notice adds its own period, so a trailing one is dropped here.
function shorten(text, limit = 120) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ").replace(/\.+$/, "");
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

function agentLabel(job) {
  try {
    return providerForJob(job).label;
  } catch {
    return "Agent";
  }
}

function announcement(job) {
  const label = agentLabel(job);
  if (job.status === "completed") {
    const summary = shorten(job.summary || job.title);
    return `${label} job ${job.id} completed${summary ? `: ${summary}` : ""}. Run /agent:result ${job.id} for the output.`;
  }
  const reason = shorten(job.errorMessage || job.summary || job.title);
  return `${label} job ${job.id} failed${reason ? `: ${reason}` : ""}. Run /agent:result ${job.id} for details.`;
}

function main() {
  // Claude Code substitutes ${CLAUDE_PLUGIN_DATA} into the monitor command but does not export it,
  // while the session's commands get it from the SessionStart hook and keep their jobs there.
  if (process.argv[3]) {
    setPluginDataDir(process.argv[3]);
  }
  const workspaceRoot = resolveWorkspaceRoot(process.argv[2] || process.cwd());
  const ownerPid = getHostPid();
  const startedAt = Date.now();
  // Per job: whether it was seen active, when it was first seen finished, and whether it was announced.
  const tracked = new Map();

  // Without CLAUDE_PID, jobs created after the monitor started are taken as this process's jobs.
  function belongsHere(job) {
    if (ownerPid) {
      return String(job.claudePid ?? "") === ownerPid;
    }
    return Date.parse(job.createdAt ?? "") >= startedAt;
  }

  function poll() {
    if (ownerPid && !isProcessAlive(Number(ownerPid))) {
      process.exit(0);
    }
    let jobs;
    try {
      jobs = listJobs(workspaceRoot);
    } catch {
      return;
    }
    const now = Date.now();
    const listed = new Set(jobs.map((job) => job.id));
    for (const id of tracked.keys()) {
      if (!listed.has(id)) {
        tracked.delete(id);
      }
    }
    for (const job of jobs) {
      if (!belongsHere(job)) {
        continue;
      }
      let entry = tracked.get(job.id);
      if (!entry) {
        entry = { sawActive: Date.parse(job.createdAt ?? "") >= startedAt, finishedAt: null, announced: false };
        tracked.set(job.id, entry);
      }
      if (ACTIVE_STATUSES.has(job.status)) {
        entry.sawActive = true;
        entry.finishedAt = null;
        continue;
      }
      if (!entry.sawActive || entry.announced || (job.status !== "completed" && job.status !== "failed")) {
        continue;
      }
      entry.finishedAt ??= now;
      if (now - entry.finishedAt < DELIVERY_GRACE_MS) {
        continue;
      }
      entry.announced = true;
      if (!isJobResultDelivered(workspaceRoot, job.id)) {
        process.stdout.write(`${announcement(job)}\n`);
      }
    }
  }

  poll();
  setInterval(poll, POLL_MS);
}

main();
