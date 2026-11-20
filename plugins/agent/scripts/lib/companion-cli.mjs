import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { parseArgs, splitRawArgumentString } from "./args.mjs";
import { providerForJob } from "./providers.mjs";
import { markJobResultDelivered, writeJobFile } from "./state.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createProgressReporter,
  nowIso,
  runTrackedJob
} from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

// Command-line plumbing shared by the provider companions: argument parsing, output, progress
// tracking, and foreground and background job runs.

// Thrown by parseCommandInput when --help is given, so no command work starts.
export class HelpRequested extends Error {}

export function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

export function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

export function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

export function parseCommandInput(argv, config = {}) {
  const parsed = parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
  if (parsed.options.help) {
    throw new HelpRequested();
  }
  return parsed;
}

export function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

export function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      label: providerForJob(job).progressLabel,
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

export async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  markJobResultDelivered(job.workspaceRoot, job.id);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

export function spawnDetachedTaskWorker(cwd, jobId, workerScript) {
  const child = spawn(process.execPath, [workerScript, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  // A spawn failure also arrives later as an "error" event. The caller reports it from the
  // missing pid, so the event is consumed here instead of ending the process.
  child.once("error", () => {});
  child.unref();
  return child;
}

// Records the queued job with its request and starts `workerScript task-worker` detached to run it.
export function enqueueBackgroundTask(cwd, job, request, { workerScript }) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  // The record exists before the worker starts, because the worker reads its request from it.
  // The worker records its own PID when it starts running.
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  const child = spawnDetachedTaskWorker(cwd, job.id, workerScript);
  if (!child.pid) {
    writeJobFile(job.workspaceRoot, job.id, {
      ...queuedRecord,
      status: "failed",
      phase: "failed",
      errorMessage: "The background worker could not be started.",
      completedAt: nowIso()
    });
    throw new Error("The background worker could not be started.");
  }

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile,
      ...(job.worktreePath ? { worktreePath: job.worktreePath, worktreeBranch: job.worktreeBranch } : {})
    },
    logFile
  };
}
