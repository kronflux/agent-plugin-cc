import fs from "node:fs";
import process from "node:process";

import { outputCommandResult, parseCommandInput } from "../lib/companion-cli.mjs";
import { getSessionId } from "../lib/host.mjs";
import { listEvents, markEventRead } from "../lib/mailbox.mjs";
import { renderStatusJson, renderStoreResult } from "../lib/render.mjs";
import { listJobViews, readJobView } from "../lib/state.mjs";
import { waitForJob } from "../lib/tracked-jobs.mjs";
import { parseWaitTimeout } from "./status.mjs";
import { commandStateDir, jobLogFile, reconcileAndPrune, resolveReadView, retrying, withCommandStore } from "./store.mjs";

// result --wait exits with this code when the job is still running at the end of the wait.
export const STILL_RUNNING_EXIT_CODE = 75;

export const usage = "result [job-id|label] [--wait] [--timeout-ms <ms>] [--json]";

// The job `result` shows without a reference: the newest job of this session with an end decision.
function newestEnded(store) {
  const views = listJobViews(store, { sessionId: getSessionId(process.env), limit: 50 });
  return views.find((view) => view.row.end_state !== null || view.state === "cancelled") ?? null;
}

// Marks the job's unread event read once its result was shown.
async function markResultRead(store, jobId) {
  const events = listEvents(store, { unread: true }).filter((event) => event.jobId === jobId);
  for (const event of events) {
    await retrying((opts) => markEventRead(store, event.id, opts));
  }
}

function resultPayload(view, successor, extra = {}) {
  const row = view.row;
  return {
    job: renderStatusJson([view]).jobs[0],
    title: row.title,
    resultText: row.result_text ?? null,
    resultJson: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error ?? null,
    successorId: successor?.id ?? view.successorId ?? null,
    ...extra
  };
}

export async function run(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "wait"]
  });
  const stateDir = commandStateDir(options);
  const reference = positionals[0] ?? "";
  const timeoutMs = parseWaitTimeout(options["timeout-ms"]);
  if (options.wait && !reference) {
    throw new Error("`result --wait` requires a job id or label.");
  }
  await reconcileAndPrune(stateDir);

  let view = await withCommandStore(stateDir, (store) => (reference ? resolveReadView(store, reference) : newestEnded(store)));
  if (!view) {
    throw new Error(reference ? `No job matches "${reference}" in this repository.` : "No finished job was found for this session.");
  }
  if (options.wait) {
    // The wait records that the outcome was returned, so the monitor does not announce it again.
    const waited = await waitForJob(stateDir, view.id, { until: "end", timeoutMs, deliver: true });
    view = waited.view ?? view;
    if (waited.timedOut) {
      const seconds = Math.round(timeoutMs / 1000);
      outputCommandResult(
        { ...resultPayload(view, null), waitTimedOut: true },
        `Job ${view.id} is still ${view.state} after ${seconds} s. Run the same command again to keep waiting.\n`,
        options.json
      );
      process.exitCode = STILL_RUNNING_EXIT_CODE;
      return;
    }
  }
  const { current, successor } = await withCommandStore(stateDir, async (store) => {
    const latest = readJobView(store, view.id) ?? view;
    const next = latest.successorId ? readJobView(store, latest.successorId) : null;
    if (latest.row.end_state !== null || latest.state === "cancelled") {
      await markResultRead(store, latest.id);
    }
    return { current: latest, successor: next };
  });
  const logFile = jobLogFile(stateDir, current.id);
  outputCommandResult(
    resultPayload(current, successor),
    renderStoreResult(current, { successor, logFile: fs.existsSync(logFile) ? logFile : null }),
    options.json
  );
}
