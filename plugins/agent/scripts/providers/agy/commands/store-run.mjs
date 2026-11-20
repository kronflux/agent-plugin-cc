import { readJobView, resolveStateDir } from "../../../lib/state.mjs";
import { openStoreRetrying } from "../../../lib/store.mjs";
import { launchWorker } from "../../../lib/task-launch.mjs";
import { waitForJob } from "../../../lib/tracked-jobs.mjs";
import { readAgyTurnTimeoutMs } from "../runtime.mjs";

// What the Antigravity task and review commands share once their job row exists: the launch of
// its worker, the background reply, and the foreground wait with its exit code.

/** The exit code of a foreground wait that ended before the job did. */
export const STILL_RUNNING_EXIT = 75;

/** The open job store of the workspace that holds `cwd`, with its state folder. */
export function openWorkspaceStore(cwd) {
  const stateDir = resolveStateDir(cwd);
  return { stateDir, store: openStoreRetrying(stateDir) };
}

function parseJson(text) {
  try {
    return text === null || text === undefined ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

/** The one JSON object a background start prints. */
export function backgroundReply(view) {
  return {
    jobId: view.id,
    status: view.state,
    label: view.label ?? null,
    runId: view.row.run_id ?? null,
    provider: view.provider,
    chainId: view.chainId,
    createdAt: new Date(view.row.created_at).toISOString()
  };
}

/** The one JSON object a foreground run prints when it ends. */
function foregroundReply(view) {
  return {
    ...backgroundReply(view),
    threadId: view.row.thread_id ?? null,
    rawOutput: view.row.result_text ?? "",
    result: parseJson(view.row.result_json),
    question: view.row.question ?? null,
    error: view.row.error ?? null
  };
}

/**
 * Launches the worker of a job that was just created, then either prints the background reply
 * (`backgroundText(view)` without --json) or waits for the job's end, printing its log to stderr
 * and `render(view)` to stdout. The exit code is 0 for completed or waiting, 1 for any other end,
 * and STILL_RUNNING_EXIT when the wait ended first, which leaves the job running.
 */
export async function launchAndFollow({ store, stateDir, jobId, background, json, backgroundText, render }) {
  let launchError = null;
  try {
    await launchWorker(store, stateDir, jobId);
  } catch (error) {
    // A refused or failed launch leaves the job queued for the next scan.
    launchError = error;
  }
  const started = readJobView(store, jobId);
  store.close();
  if (launchError) {
    process.stderr.write(`The worker of ${jobId} did not start (${launchError.message ?? launchError}); the next scan launches it.\n`);
  }
  if (background) {
    process.stdout.write(json ? `${JSON.stringify(backgroundReply(started))}\n` : backgroundText(started));
    return;
  }
  const waited = await waitForJob(stateDir, jobId, {
    until: "end",
    timeoutMs: readAgyTurnTimeoutMs() + 60000,
    onLog: json ? null : (text) => process.stderr.write(text),
    deliver: true
  });
  if (waited.timedOut) {
    process.stderr.write(`${jobId} is still running. Check /agent:status ${jobId}.\n`);
    process.exitCode = STILL_RUNNING_EXIT;
    return;
  }
  const view = waited.view;
  process.stdout.write(json ? `${JSON.stringify(foregroundReply(view))}\n` : render(view));
  if (!["completed", "waiting"].includes(view.state)) {
    process.exitCode = 1;
  }
}
