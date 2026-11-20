import process from "node:process";

import { HelpRequested, outputCommandResult } from "../lib/companion-cli.mjs";
import { readStdinIfPiped } from "../lib/fs.mjs";
import { readRequesterIdentity } from "../lib/host.mjs";
import { sendToChain } from "../lib/mailbox.mjs";
import { providerLabelOf } from "../lib/render.mjs";
import { UnknownJobError, readJobView, resolveActionableTip } from "../lib/state.mjs";
import { DEFAULT_SEND_TIMEOUT_MS, launchWorker } from "../lib/task-launch.mjs";
import { waitForJob } from "../lib/tracked-jobs.mjs";
import { parseWaitTimeout } from "./status.mjs";
import { commandStateDir, retrying, withCommandStore } from "./store.mjs";

export { DEFAULT_SEND_TIMEOUT_MS };
// How long a message read from stdin may take to start and to finish arriving.
const STDIN_LIMITS = { firstByteTimeoutMs: 10000, totalTimeoutMs: 60000 };

/**
 * The options of a command that takes a job id or label and then a message: value options and
 * flags by token, each mapped to its option name. `--stdin` and `-` read the message from stdin.
 */
export const SEND_SPEC = Object.freeze({
  name: "send",
  values: Object.freeze({ "--timeout-ms": "timeoutMs", "--cwd": "cwd", "-C": "cwd" }),
  flags: Object.freeze({ "--force": "force", "--json": "json" })
});
export const SEND_VALUE_OPTIONS = new Set(Object.keys(SEND_SPEC.values));

export const usage = "send <job-id|label> [--timeout-ms <ms>] [--force] [--json] [--stdin | -] [--] <message>";

function isMessageOption(token, spec) {
  if (Object.hasOwn(spec.flags, token) || Object.hasOwn(spec.values, token)) {
    return true;
  }
  if (["--stdin", "-", "--help", "-h"].includes(token)) {
    return true;
  }
  const equalsAt = token.indexOf("=");
  return token.startsWith("--") && equalsAt > 0 && Object.hasOwn(spec.values, token.slice(0, equalsAt));
}

/**
 * Splits the one argument string a slash command passes. Options, the job id or label and the
 * options right after it are split off the front, and the rest is the message exactly as typed,
 * so quotes and apostrophes survive. Already split arguments are returned unchanged.
 */
export function splitMessageArguments(argv, spec = SEND_SPEC) {
  if (argv.length !== 1 || !/\s/.test(argv[0].trim())) {
    return argv;
  }
  const tokens = [];
  let rest = argv[0].trim();
  let referenceSeen = false;
  while (rest) {
    const match = rest.match(/^(\S+)\s*([\s\S]*)$/);
    const token = match[1];
    if (token === "--") {
      tokens.push(token);
      rest = match[2];
      break;
    }
    if (referenceSeen && !isMessageOption(token, spec)) {
      break;
    }
    tokens.push(token);
    rest = match[2];
    if (Object.hasOwn(spec.values, token) && rest) {
      const value = rest.match(/^(\S+)\s*([\s\S]*)$/);
      tokens.push(value[1]);
      rest = value[2];
    } else if (!token.startsWith("-")) {
      referenceSeen = true;
    }
  }
  const quoted = rest.match(/^(["'])([\s\S]*)\1$/);
  const message = quoted ? quoted[2] : rest;
  if (!message) {
    return tokens;
  }
  return tokens.at(-1) === "--" ? [...tokens, message] : [...tokens, "--", message];
}

export function splitSendArguments(argv) {
  return splitMessageArguments(argv, SEND_SPEC);
}

/**
 * Reads the options, the job id or label and the message words from tokens. Options may come
 * before and right after the reference; `--` or the first other word starts the message.
 */
export function parseMessageTokens(tokens, spec = SEND_SPEC) {
  const options = { stdin: false };
  for (const key of Object.values(spec.flags)) {
    options[key] = false;
  }
  let reference = null;
  const words = [];
  let inMessage = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (inMessage) {
      words.push(token);
      continue;
    }
    if (token === "--") {
      if (reference === null && index + 1 < tokens.length) {
        reference = tokens[index + 1];
        index += 1;
      }
      inMessage = true;
      continue;
    }
    if ((token === "--help" || token === "-h") && reference === null) {
      throw new HelpRequested();
    }
    if (Object.hasOwn(spec.flags, token)) {
      options[spec.flags[token]] = true;
      continue;
    }
    if (token === "--stdin" || token === "-") {
      options.stdin = true;
      continue;
    }
    const equalsAt = token.indexOf("=");
    if (token.startsWith("--") && equalsAt > 0 && Object.hasOwn(spec.values, token.slice(0, equalsAt))) {
      options[spec.values[token.slice(0, equalsAt)]] = token.slice(equalsAt + 1);
      continue;
    }
    if (Object.hasOwn(spec.values, token)) {
      if (index + 1 >= tokens.length) {
        throw new Error(`Missing value for ${token}`);
      }
      options[spec.values[token]] = tokens[index + 1];
      index += 1;
      continue;
    }
    if (reference === null && !token.startsWith("-")) {
      reference = token;
      continue;
    }
    if (reference === null) {
      throw new Error(`Unknown option for ${spec.name}: ${token}`);
    }
    words.push(token);
    inMessage = true;
  }
  return { options, reference, words };
}

export function parseSendTokens(tokens) {
  return parseMessageTokens(tokens, SEND_SPEC);
}

/**
 * The message of a send or resume: from stdin with `--stdin` or `-`, keeping every character
 * except the line end a heredoc adds; otherwise the words, or piped input when there are none.
 */
export async function readMessage({ options, words }, name) {
  if (options.stdin) {
    if (words.length > 0) {
      throw new Error(`${name} --stdin takes the message only from standard input.`);
    }
    if (process.stdin.isTTY) {
      throw new Error(`${name} --stdin reads the message from standard input, but standard input is a terminal.`);
    }
    return (await readStdinIfPiped(STDIN_LIMITS)).replace(/\r?\n$/, "");
  }
  return words.join(" ").trim() || (await readStdinIfPiped()).trim();
}

export function forcedThreadWarning(threadId, barrierJobId) {
  return `Thread ${threadId} was last used by job ${barrierJobId}, whose provider exit was not observed; it may still run and overlap this job.`;
}

/** The reply of send, from what happened to the message. */
export function renderSendReply(result) {
  const lines = [];
  if (result.warning) {
    lines.push(result.warning);
  }
  switch (result.status) {
    case "received":
      lines.push(`${result.provider} received the message in the running turn of ${result.jobId}.`);
      break;
    case "continued":
      lines.push(
        result.started
          ? `${result.sentTo} had ended, so the message started ${result.consumedJobId}, which continues it on the same thread. Check /agent:status ${result.consumedJobId} for progress.`
          : `The message was received by ${result.consumedJobId}, which continues ${result.sentTo} on the same thread. Check /agent:status ${result.consumedJobId} for progress.`
      );
      break;
    case "dropped":
      lines.push(
        result.dispatched
          ? `The message was dropped because job ${result.jobId} was ${result.reason}; it had been sent to the provider, so it may have been delivered.`
          : `The message was dropped because job ${result.jobId} was ${result.reason}; it was not delivered.`
      );
      break;
    default:
      lines.push(
        result.reason === "stopping"
          ? `Job ${result.jobId} is stopping; the message will be delivered when it is continued.`
          : `Job ${result.jobId} has not received the message yet (not yet received after ${Math.round(result.timeoutMs / 1000)} s). It stays with the job's chain; check /agent:status ${result.jobId}.`
      );
  }
  if (result.labelDropped) {
    lines.push(`The label "${result.labelDropped}" is held by another job, so ${result.consumedJobId} has no label.`);
  }
  return `${lines.join("\n")}\n`;
}

export async function run(argv) {
  const parsed = parseSendTokens(splitSendArguments(argv));
  const { options, reference } = parsed;
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_SEND_TIMEOUT_MS : parseWaitTimeout(options.timeoutMs);
  if (!reference) {
    throw new Error("Provide a job id or label and a message: send <job-id|label> <message>.");
  }
  const text = await readMessage(parsed, "send");
  if (!text.trim()) {
    throw new Error("Provide a job id or label and a message: send <job-id|label> <message>.");
  }
  const stateDir = commandStateDir({ cwd: options.cwd });
  const requester = await readRequesterIdentity();

  const sent = await withCommandStore(stateDir, async (store) => {
    const tip = await retrying((opts) => resolveActionableTip(store, reference, opts));
    if (!tip) {
      throw new UnknownJobError({ ref: reference });
    }
    const outcome = await retrying((opts) => sendToChain(store, { ref: reference, observedTipId: tip.id }, { text, requester, force: options.force }, opts));
    let successor = null;
    if (outcome.outcome === "continued") {
      successor = await retrying((opts) => readJobView(store, outcome.jobId, opts));
      await launchWorker(store, stateDir, outcome.jobId).catch(() => null);
    }
    return { tip, outcome, successor };
  });

  const { tip, outcome, successor } = sent;
  const result = {
    status: "pending",
    jobId: outcome.jobId,
    sentTo: outcome.outcome === "continued" ? tip.id : outcome.jobId,
    messageId: outcome.messageId,
    provider: providerLabelOf(tip),
    consumedJobId: null,
    started: false,
    reason: null,
    timeoutMs,
    labelDropped: null,
    warning: outcome.barrierJobId ? forcedThreadWarning(tip.row.thread_id, outcome.barrierJobId) : null
  };
  if (outcome.outcome === "continued") {
    Object.assign(result, { status: "continued", consumedJobId: outcome.jobId, started: true });
    if (tip.label && successor && !successor.label) {
      result.labelDropped = tip.label;
    }
  } else if (outcome.outcome === "pending-stopping") {
    result.reason = "stopping";
  } else {
    const waited = await waitForJob(stateDir, outcome.jobId, { until: "consumed", messageId: outcome.messageId, timeoutMs });
    const message = waited.outcome;
    if (message?.state === "consumed") {
      result.consumedJobId = message.consumedJobId;
      result.status = message.consumedJobId === outcome.jobId ? "received" : "continued";
    } else if (message?.state === "dropped" || message?.state === "withdrawn") {
      result.status = "dropped";
      result.reason = message.closeCause === "failed" ? "failed" : message.closeCause === "withdrawn" ? "withdrawn" : "cancelled";
      // A message dispatched before it was dropped may have reached the provider.
      result.dispatched = Boolean(message.dispatchedJobId);
    } else {
      result.reason = "timeout";
    }
  }
  outputCommandResult(result, renderSendReply(result), options.json);
  if (result.status === "dropped") {
    process.exitCode = 1;
  }
}
