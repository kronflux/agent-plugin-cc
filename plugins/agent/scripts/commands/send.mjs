import {
  outputCommandResult,
  parseCommandInput,
  resolveCommandCwd,
  resolveCommandWorkspace,
  sleep
} from "../lib/companion-cli.mjs";
import { readStdinIfPiped } from "../lib/fs.mjs";
import { readStoredJob, reconcileJobLiveness } from "../lib/job-control.mjs";
import { providerForJob } from "../lib/providers.mjs";
import { listJobs, queueJobMessage, readJobMessageOutcome, withdrawJobMessage } from "../lib/state.mjs";
import { DEFAULT_SEND_TIMEOUT_MS } from "../lib/task-launch.mjs";
import { isActiveJobStatus, parseWaitTimeout } from "./status.mjs";

export { DEFAULT_SEND_TIMEOUT_MS };
export const SEND_VALUE_OPTIONS = new Set(["--timeout-ms", "--cwd", "-C"]);

export const usage = "send [--timeout-ms <ms>] [--json] <job-id> <message>";

// The slash command passes its arguments as one string. Options and the job id are split off
// the front, and the rest is the message exactly as typed, so quotes and apostrophes survive.
export function splitSendArguments(argv) {
  if (argv.length !== 1 || !/\s/.test(argv[0].trim())) {
    return argv;
  }
  const tokens = [];
  let rest = argv[0].trim();
  while (rest) {
    const match = rest.match(/^(\S+)\s*([\s\S]*)$/);
    tokens.push(match[1]);
    rest = match[2];
    if (SEND_VALUE_OPTIONS.has(match[1]) && rest) {
      const value = rest.match(/^(\S+)\s*([\s\S]*)$/);
      tokens.push(value[1]);
      rest = value[2];
    } else if (!match[1].startsWith("-")) {
      break;
    }
  }
  const quoted = rest.match(/^(["'])([\s\S]*)\1$/);
  return rest ? [...tokens, "--", quoted ? quoted[2] : rest] : tokens;
}

export function renderSendResult(result, label) {
  switch (result.status) {
    case "applied":
      return `${label} received the message in the running turn of ${result.jobId}.\n`;
    case "sent":
      return `${label} accepted the message for the running turn of ${result.jobId} and had not confirmed it after ${Math.round(result.timeoutMs / 1000)} s. Check /agent:status ${result.jobId}.\n`;
    case "started":
      if (result.reason === "unapplied") {
        return `The turn of ${result.jobId} ended before ${label} applied the message, so it started a new turn on the same thread as ${result.newJobId}. Check /agent:status ${result.newJobId} for progress.\n`;
      }
      return `${result.jobId} had finished, so the message started a new turn on its ${label} thread as ${result.newJobId}. Check /agent:status ${result.newJobId} for progress.\n`;
    default:
      return `${result.detail}\n`;
  }
}

// The job's provider starts the new turn on the job's thread.
export async function startTurnOnFinishedJob(cwd, workspaceRoot, job, text) {
  const provider = providerForJob(job);
  if (!job.threadId) {
    throw new Error(`${job.id} has no ${provider.label} thread to continue.`);
  }
  return provider.startFollowUpTurn(cwd, workspaceRoot, job, text);
}

export async function waitForMessageOutcome(cwd, workspaceRoot, job, messageId, text, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let sent = null;
  for (;;) {
    const outcome = readJobMessageOutcome(workspaceRoot, job.id, messageId);
    if (outcome?.status === "applied") {
      return { status: outcome.status, jobId: job.id, turnId: outcome.turnId ?? null };
    }
    // The turn ended without applying the message: the agent applies a sent message only at its
    // next model request, so a message that arrives during the final answer is not applied.
    if (outcome?.status === "unconfirmed") {
      return {
        ...(await startTurnOnFinishedJob(cwd, workspaceRoot, readStoredJob(workspaceRoot, job.id) ?? job, text)),
        reason: "unapplied"
      };
    }
    if (outcome?.status === "failed") {
      throw new Error(`${providerForJob(job).label} rejected the message for ${job.id}: ${outcome.error}`);
    }
    if (outcome?.status === "turn-ended") {
      return startTurnOnFinishedJob(cwd, workspaceRoot, readStoredJob(workspaceRoot, job.id) ?? job, text);
    }
    sent = outcome?.status === "sent" ? outcome : sent;
    if (!outcome) {
      const current = readStoredJob(workspaceRoot, job.id) ?? job;
      if (!isActiveJobStatus(current.status) && withdrawJobMessage(workspaceRoot, job.id, messageId)) {
        return startTurnOnFinishedJob(cwd, workspaceRoot, current, text);
      }
    }
    if (Date.now() >= deadline) {
      if (sent) {
        return { status: "sent", jobId: job.id, turnId: sent.turnId ?? null, timeoutMs };
      }
      if (withdrawJobMessage(workspaceRoot, job.id, messageId)) {
        throw new Error(`The worker of ${job.id} did not take the message within ${Math.round(timeoutMs / 1000)} s, so it was withdrawn.`);
      }
      return { status: "sent", jobId: job.id, turnId: null, timeoutMs };
    }
    await sleep(200);
  }
}

export async function run(argv) {
  const { options, positionals } = parseCommandInput(splitSendArguments(argv), {
    valueOptions: ["cwd", "timeout-ms"],
    booleanOptions: ["json"],
    stopAtFirstPositional: true
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const [reference, ...words] = positionals.filter((value, index) => !(index === 1 && value === "--"));
  const text = words.join(" ").trim() || (await readStdinIfPiped()).trim();
  if (!reference || !text) {
    throw new Error("Provide a job id and a message: send <job-id> <message>.");
  }
  const timeoutMs = options["timeout-ms"] === undefined ? DEFAULT_SEND_TIMEOUT_MS : parseWaitTimeout(options["timeout-ms"]);

  await reconcileJobLiveness(cwd);
  const job = listJobs(workspaceRoot).find((candidate) => candidate.id === reference);
  if (!job) {
    throw new Error(`No job ${reference} was found for this repository.`);
  }
  if (job.jobClass !== "task") {
    throw new Error(`${job.id} is a ${job.jobClass ?? "non-task"} job. Messages can be sent only to task jobs.`);
  }
  const provider = providerForJob(job);
  if (isActiveJobStatus(job.status) && !provider.capabilities.steer) {
    throw new Error(`${provider.label} cannot take a message during a running turn. Send it after ${job.id} finishes.`);
  }

  const result = isActiveJobStatus(job.status)
    ? await waitForMessageOutcome(cwd, workspaceRoot, job, queueJobMessage(workspaceRoot, job.id, text), text, timeoutMs)
    : await startTurnOnFinishedJob(cwd, workspaceRoot, readStoredJob(workspaceRoot, job.id) ?? job, text);
  outputCommandResult(result, renderSendResult(result, provider.label), options.json);
}
