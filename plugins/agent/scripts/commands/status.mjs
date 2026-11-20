import {
  outputCommandResult,
  outputResult,
  parseCommandInput,
  resolveCommandCwd,
  sleep
} from "../lib/companion-cli.mjs";
import { buildSingleJobSnapshot, buildStatusSnapshot, reconcileJobLiveness } from "../lib/job-control.mjs";
import { renderJobStatusReport, renderStatusReport } from "../lib/render.mjs";

export const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
export const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;

export const usage = "status [job-id] [--wait] [--timeout-ms <ms>] [--all] [--json]";

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

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

export async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = parseWaitTimeout(options.timeoutMs);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  await reconcileJobLiveness(cwd);
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    await reconcileJobLiveness(cwd);
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

export async function run(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (!options.wait) {
    await reconcileJobLiveness(cwd);
  }
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}
