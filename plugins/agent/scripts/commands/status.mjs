import fs from "node:fs";
import process from "node:process";

import { outputCommandResult, parseCommandInput } from "../lib/companion-cli.mjs";
import { getSessionId } from "../lib/host.mjs";
import { renderStatusJson, renderStoreJobStatus, renderStoreStatus } from "../lib/render.mjs";
import { listJobViews, readJobView } from "../lib/state.mjs";
import { waitForJob } from "../lib/tracked-jobs.mjs";
import { commandStateDir, jobLogFile, reconcileAndPrune, resolveReadView, withCommandStore } from "./store.mjs";

export const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
export const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
// How many jobs `status` lists: the session's newest, or with --all the repository's newest.
const SESSION_JOB_LIMIT = 20;
const ALL_JOB_LIMIT = 200;
const PROGRESS_LINES = 4;
const PROGRESS_TAIL_BYTES = 16384;

export const usage = "status [job-id|label] [--wait] [--timeout-ms <ms>] [--all] [--json]";

export function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

// Reads a --timeout-ms value; a missing value gives the default wait.
export function parseWaitTimeout(value) {
  if (value === undefined || value === null) {
    return DEFAULT_STATUS_WAIT_TIMEOUT_MS;
  }
  const timeoutMs = Number(String(value).trim());
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number of milliseconds.");
  }
  return timeoutMs;
}

/** The last non-empty lines of a job's log, as its progress. */
export function readProgress(logFile, maxLines = PROGRESS_LINES) {
  let fd;
  try {
    fd = fs.openSync(logFile, "r");
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - PROGRESS_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (start > 0) {
      lines.shift();
    }
    return lines.map((line) => line.trimEnd()).filter(Boolean).slice(-maxLines);
  } finally {
    fs.closeSync(fd);
  }
}

function unknownJob(reference) {
  return new Error(`No job matches "${reference}" in this repository.`);
}

export async function run(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });
  const stateDir = commandStateDir(options);
  const reference = positionals[0] ?? "";
  const timeoutMs = parseWaitTimeout(options["timeout-ms"]);
  if (options.wait && !reference) {
    throw new Error("`status --wait` requires a job id or label.");
  }
  await reconcileAndPrune(stateDir);

  if (!reference) {
    const views = await withCommandStore(stateDir, (store) =>
      listJobViews(store, { sessionId: getSessionId(process.env), all: Boolean(options.all), limit: options.all ? ALL_JOB_LIMIT : SESSION_JOB_LIMIT })
    );
    outputCommandResult(renderStatusJson(views), renderStoreStatus(views, { all: Boolean(options.all) }), options.json);
    return;
  }

  let view = await withCommandStore(stateDir, (store) => resolveReadView(store, reference));
  if (!view) {
    throw unknownJob(reference);
  }
  let waitTimedOut = false;
  if (options.wait) {
    // The wait returns when the job leaves queued, running and stopping, and records that its
    // outcome was returned, so the monitor does not announce it again.
    const waited = await waitForJob(stateDir, view.id, { until: "not-active", timeoutMs, deliver: true });
    waitTimedOut = waited.timedOut;
    view = waited.view ?? (await withCommandStore(stateDir, (store) => readJobView(store, view.id)));
    if (!view) {
      throw unknownJob(reference);
    }
  }
  const logFile = jobLogFile(stateDir, view.id);
  const text =
    renderStoreJobStatus(view, { progress: readProgress(logFile), logFile: fs.existsSync(logFile) ? logFile : null }) +
    (waitTimedOut ? `\nJob ${view.id} is still ${view.state} after ${Math.round(timeoutMs / 1000)} s.\n` : "");
  outputCommandResult({ ...renderStatusJson([view]), ...(options.wait ? { waitTimedOut } : {}) }, text, options.json);
}
