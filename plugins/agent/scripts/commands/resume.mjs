import path from "node:path";
import process from "node:process";

import { outputCommandResult } from "../lib/companion-cli.mjs";
import { readRequesterIdentity } from "../lib/host.mjs";
import { decideNext, readJobView, resolveActionableTip, resolveExactJob, UnknownJobError } from "../lib/state.mjs";
import { launchWorker, readTaskInputFiles } from "../lib/task-launch.mjs";
import { forcedThreadWarning, parseMessageTokens, readMessage, splitMessageArguments } from "./send.mjs";
import { commandStateDir, reconcileAndPrune, retrying, withCommandStore } from "./store.mjs";

export const usage = "resume <job-id|label> [--force] [--output-schema <file>] [--json] [--stdin | -] [--] [message]";

const RESUME_SPEC = Object.freeze({
  name: "resume",
  values: Object.freeze({ "--output-schema": "outputSchema", "--cwd": "cwd", "-C": "cwd" }),
  flags: Object.freeze({ "--force": "force", "--json": "json" })
});

/** The reply of resume. */
export function renderResumeReply(result) {
  const lines = [];
  if (result.warning) {
    lines.push(result.warning);
  }
  if (result.status === "continued") {
    lines.push(
      `Continued ${result.continues} as ${result.jobId} on the same thread${result.messageId ? " with the message" : ""}. Check /agent:status ${result.jobId} for progress.`
    );
    if (result.labelDropped) {
      lines.push(`The label "${result.labelDropped}" is held by another job, so ${result.jobId} has no label.`);
    }
  } else {
    lines.push(
      `${result.continues} was already continued by ${result.jobId}, an existing continuation (${result.state ?? "unknown"}); nothing was stored. Give it a message with /agent:send ${result.jobId} <message>, or check /agent:status ${result.jobId}.`
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function run(argv) {
  const parsed = parseMessageTokens(splitMessageArguments(argv, RESUME_SPEC), RESUME_SPEC);
  const { options, reference } = parsed;
  if (!reference) {
    throw new Error("Provide a job id or label: resume <job-id|label> [message].");
  }
  const message = (await readMessage(parsed, "resume")) || null;
  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const stateDir = commandStateDir({ cwd: options.cwd });
  const requester = await readRequesterIdentity();

  const result = await withCommandStore(stateDir, async (store) => {
    const tip = await retrying((opts) => resolveActionableTip(store, reference, opts));
    if (!tip) {
      throw new UnknownJobError({ ref: reference });
    }
    // A job id whose own continuation is the chain's active newest job names a decision already
    // taken; it is reported as that existing continuation.
    const exact = await retrying((opts) => resolveExactJob(store, reference, opts));
    const activeContinuation = exact && exact.id !== tip.id && exact.successorId === tip.id && ["queued", "running", "stopping"].includes(tip.state);
    const observedTipId = activeContinuation ? exact.id : tip.id;
    // The schema passes the shared shape and question checks before any successor exists.
    const outputSchema = readTaskInputFiles(cwd, { outputSchema: options.outputSchema ?? null, allowQuestions: Boolean(tip.row.allow_questions) }).schema;
    const outcome = await retrying((opts) =>
      decideNext(store, { ref: reference, observedTipId }, { action: "continue", message, requester, outputSchema, force: options.force }, opts)
    );
    if (outcome.won) {
      await launchWorker(store, stateDir, outcome.successorId).catch(() => null);
      const successor = await retrying((opts) => readJobView(store, outcome.successorId, opts));
      return {
        status: "continued",
        jobId: outcome.successorId,
        continues: tip.id,
        messageId: outcome.messageId ?? null,
        labelDropped: outcome.labelDropped ? (tip.label ?? successor?.label ?? null) : null,
        warning: outcome.barrierJobId ? forcedThreadWarning(tip.row.thread_id, outcome.barrierJobId) : null
      };
    }
    if (outcome.successorId) {
      const existing = await retrying((opts) => readJobView(store, outcome.successorId, opts));
      return {
        status: "existing",
        jobId: outcome.successorId,
        continues: observedTipId,
        state: existing?.state ?? null,
        messageId: null,
        labelDropped: null,
        warning: null
      };
    }
    throw new Error(`Job ${tip.id} could not be continued: it is ${outcome.view?.state ?? tip.state}.`);
  });
  // The recovery scan status runs: committed work whose launcher was lost is launched now. The
  // continuation is already stored, so a scan that fails is reported and the reply still printed.
  await reconcileAndPrune(stateDir).catch((error) => process.stderr.write(`The job scan did not finish: ${error?.message ?? error}\n`));
  outputCommandResult(result, renderResumeReply(result), options.json);
}
