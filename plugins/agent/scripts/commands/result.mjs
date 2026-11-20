import process from "node:process";

import { outputCommandResult, parseCommandInput, resolveCommandCwd } from "../lib/companion-cli.mjs";
import { readStoredJob, reconcileJobLiveness, resolveResultJob } from "../lib/job-control.mjs";
import { providerForJob } from "../lib/providers.mjs";
import { renderStoredJobResult } from "../lib/render.mjs";
import { markJobResultDelivered } from "../lib/state.mjs";
import { isActiveJobStatus, parseWaitTimeout, waitForSingleJobSnapshot } from "./status.mjs";

// result --wait exits with this code when the job is still running at the end of the wait.
export const STILL_RUNNING_EXIT_CODE = 75;

export const usage = "result [job-id] [--wait] [--timeout-ms <ms>] [--json]";

export async function run(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  parseWaitTimeout(options["timeout-ms"]);
  if (options.wait) {
    if (!reference) {
      throw new Error("`result --wait` requires a job id.");
    }
    const snapshot = await waitForSingleJobSnapshot(cwd, reference, {
      timeoutMs: options["timeout-ms"],
      pollIntervalMs: options["poll-interval-ms"]
    });
    if (snapshot.waitTimedOut) {
      const seconds = Math.round(snapshot.timeoutMs / 1000);
      outputCommandResult(
        { job: snapshot.job, waitTimedOut: true },
        `Job ${snapshot.job.id} is still running after ${seconds} s. Run the same command again to keep waiting.\n`,
        options.json
      );
      process.exitCode = STILL_RUNNING_EXIT_CODE;
      return;
    }
  }
  await reconcileJobLiveness(cwd);
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  let storedJob = readStoredJob(workspaceRoot, job.id);
  let recoveredNote = "";
  const hasOutput = Boolean(storedJob?.result?.rawOutput || storedJob?.rendered || providerForJob(job).storedOutputText(storedJob));
  // A job that stopped without storing its output may still have it in the provider's transcript.
  if (!hasOutput) {
    const provider = providerForJob(job);
    const recovered = provider.recoverTurnResult?.({
      threadId: storedJob?.threadId ?? job.threadId,
      turnId: storedJob?.turnId ?? job.turnId
    });
    if (recovered) {
      storedJob = { ...storedJob, result: { ...(storedJob?.result ?? {}), rawOutput: recovered.text }, recovered };
      recoveredNote = recovered.complete
        ? `Recovered from the ${provider.label} transcript.\n\n`
        : `Recovered from the ${provider.label} transcript. The turn did not finish; this is its last message.\n\n`;
    }
  }
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, `${recoveredNote}${renderStoredJobResult(job, storedJob)}`, options.json);
  if (!isActiveJobStatus(job.status)) {
    markJobResultDelivered(workspaceRoot, job.id);
  }
}
