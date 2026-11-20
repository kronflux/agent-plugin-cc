import { spawn } from "node:child_process";
import readline from "node:readline";

import { binaryAvailable, resolveCommand, runCommand, terminateProcessTree } from "../../lib/process.mjs";

// Antigravity (agy) runs one process per job in print mode with stream-json input and output:
// each NDJSON line written to stdin starts a turn, and agy answers with init, step_update, and
// one result event per turn. The conversation id from those events resumes the conversation in
// a later process with --conversation.

const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;
const MESSAGE_INBOX_POLL_MS = 500;
const EXIT_WAIT_MS = 5000;

// AGY_COMPANION_TURN_TIMEOUT_MS bounds one agy process. agy itself waits without limit unless
// --print-timeout is given, so the limit is passed to agy and enforced here as well.
export function readAgyTurnTimeoutMs(env = process.env) {
  const raw = String(env.AGY_COMPANION_TURN_TIMEOUT_MS ?? "").trim();
  return /^\d+$/.test(raw) && Number(raw) > 0 ? Math.min(Number(raw), 2 ** 31 - 1) : DEFAULT_TURN_TIMEOUT_MS;
}

const FALLBACK_EFFORTS = ["low", "medium", "high"];

/**
 * Returns the reasoning efforts the installed agy accepts, read from the --effort line of
 * `agy --help`, for example "(low|medium|high|xhigh|max)". The list differs between agy
 * versions; when it cannot be read, the efforts every known version accepts are returned.
 */
export function readAgyEfforts(cwd) {
  const result = runCommand("agy", ["--help"], { cwd, timeout: 30000 });
  const match = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.match(/--effort[^\n]*\(([a-z|]+)\)/);
  return match ? match[1].split("|").filter(Boolean) : FALLBACK_EFFORTS;
}

export function getAgyAvailability(cwd) {
  return binaryAvailable("agy", ["--version"], { cwd });
}

/** Lists the models agy offers; agy has no login-status command, so this doubles as the login check. */
export function readAgyModels(cwd) {
  const result = runCommand("agy", ["models"], { cwd, timeout: 60000 });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || "").trim();
    return { ok: false, models: [], detail: detail || `agy models exited with ${result.status}.` };
  }
  const models = String(result.stdout)
    .split(/\r?\n/)
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length >= 2 && parts[0].trim())
    .map(([id, label]) => ({ id: id.trim(), label: label.trim() }));
  return { ok: models.length > 0, models, detail: models.length > 0 ? `${models.length} models available` : "agy listed no models." };
}

// Read-only runs use plan mode with terminal restrictions; workspace-write keeps the terminal
// restrictions; danger-full-access lifts both.
function sandboxArgs(sandboxMode) {
  if (sandboxMode === "danger-full-access") {
    return [];
  }
  if (sandboxMode === "workspace-write") {
    return ["--sandbox"];
  }
  return ["--mode", "plan", "--sandbox"];
}

export function buildAgyArgs({ conversationId = null, model = null, effort = null, sandboxMode = "read-only", jsonSchema = null, timeoutMs }) {
  return [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--print=",
    "--print-timeout",
    `${Math.ceil(timeoutMs / 1000)}s`,
    ...(conversationId ? ["--conversation", conversationId] : []),
    ...(model ? ["--model", model] : []),
    ...(effort ? ["--effort", effort] : []),
    ...sandboxArgs(sandboxMode),
    ...(jsonSchema ? ["--json-schema", jsonSchema] : [])
  ];
}

function userLine(text) {
  return `${JSON.stringify({ event: "user", message: { content: text } })}\n`;
}

function emit(onProgress, message, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  onProgress(Object.keys(extra).length > 0 ? { message, ...extra } : message);
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

function isSuccess(result) {
  return String(result?.status ?? "").toUpperCase() === "SUCCESS";
}

/**
 * Runs one agy process for `prompt` and resolves when the process has exited and its output is
 * read. Messages taken from `messageInbox` while a turn runs are written to the same process;
 * each starts a turn of its own, and the message counts as received when agy starts that turn.
 * `turnOutcomes` lists each turn's result status; the run fails when the prompt turn (the first)
 * or the last turn did not succeed. `terminate` stops the process tree by id (default
 * `terminateProcessTree`).
 */
export function runAgyTurn(cwd, options = {}) {
  const env = options.env ?? process.env;
  const terminate = options.terminate ?? terminateProcessTree;
  const timeoutMs = options.timeoutMs ?? readAgyTurnTimeoutMs(env);
  const args = buildAgyArgs({ ...options, timeoutMs });
  const plan = resolveCommand("agy", args, env);
  const child = spawn(plan.file, plan.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], ...plan.options, windowsHide: true });
  const inbox = options.messageInbox ?? null;
  const onProgress = options.onProgress ?? null;

  const state = {
    conversationId: options.conversationId ?? null,
    turnsStarted: 1,
    results: [],
    agentText: "",
    // The last agent message of the running turn; a turn's answer is its last message.
    turnText: "",
    turnTexts: [],
    stderr: "",
    error: null,
    // Messages written to agy that have not started their turn yet, oldest first.
    awaitingTurn: [],
    sentMessages: []
  };

  function report(id, outcome) {
    try {
      inbox?.report(id, outcome);
    } catch {
      // The sender reads a missing outcome as not confirmed.
    }
  }

  return new Promise((resolve) => {
    let settled = false;
    let inboxTimer = null;
    let exitTimer = null;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(exitTimer);
      clearInterval(inboxTimer);
      for (const message of state.awaitingTurn) {
        report(message.id, { status: "unconfirmed" });
      }
      const first = state.results[0] ?? null;
      const last = state.results.at(-1) ?? null;
      const failedTurn = [first, last].find((result) => result && !isSuccess(result)) ?? null;
      const succeeded = !state.error && Boolean(last) && !failedTurn;
      resolve({
        status: succeeded ? 0 : 1,
        conversationId: state.conversationId ?? last?.conversation_id ?? null,
        turnId: `turn-${state.results.length || 1}`,
        finalMessage: state.turnTexts.filter(Boolean).join("\n\n") || (typeof last?.response === "string" ? last.response : ""),
        structuredOutput: last?.structured_output ?? null,
        error: state.error ?? (failedTurn ? { message: `agy ended the turn with status ${failedTurn.status}.` } : null),
        stderr: state.stderr.trim(),
        turnOutcomes: state.results.map((result, index) => ({ turnId: `turn-${index + 1}`, status: String(result.status ?? "") }))
      });
    };

    // A failed stop must not end the worker; the process may already be gone.
    const stopTree = () => {
      try {
        terminate(child.pid);
      } catch {
        // The turn already reports its own outcome.
      }
    };

    const stop = (message) => {
      state.error ??= { message };
      stopTree();
      finish();
    };

    const timer = setTimeout(() => stop(`agy did not finish within ${Math.round(timeoutMs / 1000)} s, so it was stopped.`), timeoutMs);
    timer.unref?.();

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      state.stderr += chunk;
    });
    child.on("error", (error) => stop(`agy could not be started: ${error.message}`));
    // A write to an agy that has closed its input fails the turn instead of the worker.
    child.stdin.on("error", (error) => {
      state.error ??= { message: `agy closed its input: ${error.message}` };
    });
    // "close" comes after stdout has ended, so every line agy wrote has been read by then.
    child.on("close", (code, signal) => {
      if (state.results.length < state.turnsStarted) {
        const ending = code === null && signal ? `was ended by ${signal}` : `exited with code ${code}`;
        state.error ??= { message: `agy ${ending} before the turn finished.${state.stderr.trim() ? `\n${state.stderr.trim()}` : ""}` };
      }
      finish();
    });

    const deliverQueuedMessages = () => {
      if (!inbox || settled || state.results.length >= state.turnsStarted) {
        return;
      }
      let queued = [];
      try {
        queued = inbox.take();
      } catch {
        queued = [];
      }
      for (const message of queued) {
        child.stdin.write(userLine(message.text));
        state.turnsStarted += 1;
        state.awaitingTurn.push(message);
        report(message.id, { status: "sent", turnId: `turn-${state.turnsStarted}` });
        emit(onProgress, `Message sent to agy: ${shorten(message.text)}`);
      }
    };

    const lines = readline.createInterface({ input: child.stdout });
    let userInputsSeen = 0;
    lines.on("line", (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      switch (event?.event) {
        case "init": {
          state.conversationId = event.conversation_id ?? state.conversationId;
          emit(onProgress, `Thread ready (${state.conversationId}).`, { phase: "starting", threadId: state.conversationId });
          emit(onProgress, "Turn started (turn-1).", { phase: "starting", threadId: state.conversationId, turnId: "turn-1" });
          if (inbox && !inboxTimer) {
            inboxTimer = setInterval(deliverQueuedMessages, MESSAGE_INBOX_POLL_MS);
            inboxTimer.unref?.();
          }
          break;
        }
        case "step_update": {
          const step = event.step_update ?? {};
          if (step.step_type === "user_input" && step.state === "DONE") {
            userInputsSeen += 1;
            // The first user input is the prompt; each later one is a sent message starting its turn.
            if (userInputsSeen > 1) {
              const message = state.awaitingTurn.shift();
              if (message) {
                report(message.id, { status: "applied", turnId: `turn-${userInputsSeen}` });
                emit(onProgress, `agy received the message: ${shorten(message.text)}`);
              }
            }
          } else if (step.step_type === "agent_response") {
            state.agentText += typeof step.text_delta === "string" ? step.text_delta : "";
            if (step.state === "DONE" && state.agentText.trim()) {
              state.turnText = state.agentText.trim();
              emit(onProgress, { message: `Assistant message captured: ${shorten(state.agentText)}`, logTitle: "Assistant message", logBody: state.agentText.trim() });
              state.agentText = "";
            }
          }
          break;
        }
        case "result": {
          const result = event.result ?? {};
          state.results.push(result);
          state.turnTexts.push(state.turnText || String(result.response ?? "").trim());
          state.turnText = "";
          // Text of a response that never reached DONE belongs to this turn only.
          state.agentText = "";
          state.conversationId = result.conversation_id ?? state.conversationId;
          emit(onProgress, `Turn ${isSuccess(result) ? "completed" : String(result.status ?? "ended").toLowerCase()}.`, { phase: "finalizing" });
          if (state.results.length >= state.turnsStarted) {
            child.stdin.end();
            clearTimeout(exitTimer);
            exitTimer = setTimeout(() => {
              stopTree();
              finish();
            }, EXIT_WAIT_MS);
            exitTimer.unref?.();
          }
          break;
        }
        default:
          break;
      }
    });

    emit(onProgress, "Starting agy task thread.", { phase: "starting" });
    child.stdin.write(userLine(options.prompt));
  });
}
