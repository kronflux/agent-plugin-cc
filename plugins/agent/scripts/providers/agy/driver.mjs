import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { capUtf8 } from "../../lib/state.mjs";
import { CONTINUE_LINE } from "../../lib/mailbox.mjs";
import { resolveCommand, runCommand } from "../../lib/process.mjs";
import {
  agyEnv,
  agyTurnModel,
  readCatalogLists,
  AGY_DELEGATE_LINE,
  AGY_READ_ONLY_LINE,
  buildAgyArgs,
  classifyAgyTurn,
  createAgyEventAdapter,
  readAgySilenceMs,
  readAgyTurnTimeoutMs,
  startSilenceWatch,
  writeAgyPrompt
} from "./runtime.mjs";
import { AGY_READ_TOOL_NAMES, AGY_WRITE_TOOL_NAMES, changedPaths, readOnlyGuardMode, snapshotWorkingTree } from "./readonly-guard.mjs";

// The Antigravity driver of the store worker (see "The provider driver contract" in
// lib/tracked-jobs.mjs): one agy process per execution, one stdin line, and the events of that
// one turn reported to the worker, which writes the store.

/** The fixed line that keeps a delegate that may ask a question from using a question tool. */
export const AGY_NO_QUESTION_TOOL_LINE = "Do not use a question tool; write the line instead.";

/** The line before a predecessor's output in a continuation that cannot resume its conversation. */
export const AGY_LOST_CONTEXT_LINE = "Last answer recorded before the interruption:";

let cachedVersion;

/** The installed agy version as `agy --version` prints it, read once per process; null if unread. */
export function readAgyVersion(cwd, env = process.env) {
  if (cachedVersion === undefined) {
    const result = runCommand("agy", ["--version"], { cwd, env: agyEnv(env), timeout: 30000 });
    const match = result.status === 0 ? /\d+\.\d+\.\d+\S*/.exec(String(result.stdout ?? "")) : null;
    cachedVersion = match ? match[0] : null;
  }
  return cachedVersion;
}

function parseRequest(job) {
  try {
    return JSON.parse(job?.request_json ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function sandboxModeOf(request) {
  if (request.sandbox === "workspace-write" || request.sandbox === "danger-full-access" || request.sandbox === "read-only") {
    return request.sandbox;
  }
  return request.write ? "workspace-write" : "read-only";
}

// The fixed lines of a request: the delegate line, the read-only line without --write, and the
// no-question-tool line when the job may end with a question.
function additionsFor(job) {
  const request = parseRequest(job);
  const writes = sandboxModeOf(request) !== "read-only";
  return [AGY_DELEGATE_LINE, writes ? null : AGY_READ_ONLY_LINE, job?.allow_questions ? AGY_NO_QUESTION_TOOL_LINE : null].filter(Boolean);
}

/**
 * The body of an Antigravity request. A job that continues a conversation (it has a thread id)
 * sends the message, the stored prompt or the continue line, because agy resumes the whole
 * conversation with --conversation. A continuation without a conversation to resume starts a new
 * one, so it carries the stored prompt, then the predecessor's last answer (its result, else its
 * log tail, at most `priorOutputBudget` bytes cut on a character boundary), then the message or
 * the continue line.
 */
export function formatAgyBody(job, { kind, messageText = null, storedPrompt = "", predecessor = null, priorOutputBudget = 65536 }) {
  const tail = kind === "message" ? String(messageText ?? "") : kind === "prompt" ? String(storedPrompt ?? "") : CONTINUE_LINE;
  if (job?.thread_id || !job?.continues || kind === "prompt") {
    return tail;
  }
  const prior = capUtf8(predecessor?.resultText || predecessor?.logTail || "", priorOutputBudget);
  return [String(storedPrompt ?? ""), "", AGY_LOST_CONTEXT_LINE, prior, "", tail].join("\n");
}

// A task turn decided by classifyAgyTurn, in the shape the worker expects: a structured object is
// required when the job has an output schema, and `guard` passes the read-only guard's evidence.
function taskOutcome(outcome, request, guard = {}) {
  const decided = classifyAgyTurn(outcome, { schemaGiven: Boolean(request.outputSchema), ...guard });
  return decided.outcome === "completed"
    ? { status: "answer", text: outcome.text, json: outcome.json, error: null }
    : { status: "failed", text: outcome.text, json: outcome.json, error: decided.error };
}

// Why `data` is not a review result, with the checks the review renderer makes; null when it is one.
function reviewShapeError(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  if (typeof data.verdict !== "string" || !data.verdict.trim()) {
    return "Missing string `verdict`.";
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return "Missing string `summary`.";
  }
  if (!Array.isArray(data.findings)) {
    return "Missing array `findings`.";
  }
  if (!Array.isArray(data.next_steps)) {
    return "Missing array `next_steps`.";
  }
  return null;
}

// A finished review keeps its JSON only when it has the review shape; otherwise it fails.
function checkedReview(text, json) {
  const shapeError = reviewShapeError(json);
  return shapeError
    ? { status: "failed", text, json: null, error: `agy returned JSON with an unexpected review shape: ${shapeError}` }
    : { status: "answer", text, json, error: null };
}

// A review answers with a JSON object of the review shape: its structured output, else the object
// between the first "{" and the last "}" of its text. A review without one fails.
function reviewOutcome(outcome) {
  if (outcome.status !== "answer") {
    return { status: outcome.status, text: outcome.text, json: outcome.json, error: outcome.error };
  }
  if (outcome.json && typeof outcome.json === "object") {
    return checkedReview(outcome.text, outcome.json);
  }
  const text = String(outcome.text ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    let json;
    try {
      json = JSON.parse(text.slice(start, end + 1));
    } catch {
      // Not JSON: the review fails below.
    }
    if (json !== undefined) {
      return checkedReview(text, json);
    }
  }
  return { status: "failed", text, json: null, error: "agy returned no structured review." };
}

/**
 * The request's output schema written to a private temporary file for --json-schema; returns
 * `{ file, remove }`, or null without a schema.
 */
function writeSchemaFile(schema) {
  if (!schema || typeof schema !== "object") {
    return null;
  }
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "agy-schema-"));
  const file = path.join(folder, "schema.json");
  fs.writeFileSync(file, JSON.stringify(schema), { mode: 0o600 });
  return {
    file,
    remove() {
      try {
        fs.rmSync(folder, { recursive: true, force: true });
      } catch {
        // A file left in the temp folder is harmless.
      }
    }
  };
}

/**
 * Creates the Antigravity driver for one worker execution. `job` is unused when the worker passes
 * the job row in each call's context. `turnEnded` resolves once with
 * `{ status: "answer" | "failed", text, json, error, stopRoot? }`: at the result event, when the
 * process ends without one, when no event arrives for the silence bound or when the turn timeout
 * passes (both with `stopRoot: true`).
 *
 * A message counts as received when the stream moves past user input: the first step that is not a
 * user_input, after at least one user_input step that followed the prompt's write. A repeated init
 * or a replayed user_input of an earlier turn alone confirms nothing.
 */
export function createAgyDriver(job = null, { env = process.env } = {}) {
  let child = null;
  let adapter = null;
  let schema = null;
  let resolveTurn = null;
  let turnSettled = false;
  let written = false;
  let startedReported = false;
  let sawUserInput = false;
  let receiptClientId = null;
  let receiptSent = false;
  let lastThreadId = null;
  let silence = null;
  let timeoutTimer = null;
  let exitCode = null;

  const settleTurn = (value) => {
    if (turnSettled) {
      return;
    }
    turnSettled = true;
    clearTimeout(timeoutTimer);
    silence?.stop();
    resolveTurn?.(value);
  };

  const driver = {
    id: "agy",
    resumeMethod: "thread",
    capabilities: Object.freeze({ steer: false, interrupt: false, history: false, ownExit: true }),
    turnEnded: new Promise((resolve) => (resolveTurn = resolve)),

    async spawn(ctx) {
      const row = ctx.job ?? job;
      const request = parseRequest(row);
      schema = writeSchemaFile(request.outputSchema ?? null);
      const timeoutMs = readAgyTurnTimeoutMs(ctx.env ?? env);
      // A continuation copies its job's stored request; one recorded before model ids carried
      // their effort is joined into the id here, as agy is never given --effort.
      const turnModel = agyTurnModel(request, { readLists: () => readCatalogLists(ctx.cwd ?? row.cwd) });
      if (turnModel.warning) {
        ctx.log?.(turnModel.warning);
      }
      const args = buildAgyArgs({
        conversationId: row.thread_id ?? null,
        model: turnModel.model,
        sandboxMode: sandboxModeOf(request),
        jsonSchema: schema?.file ?? null,
        timeoutMs,
        addDirs: Array.isArray(request.addDirs) ? request.addDirs : []
      });
      // AGENT_PLUGIN_TEST_AGY_ENTRY (tests only) names a script that Node runs in place of agy, so
      // that on Windows the root is one process, as agy.exe is, rather than a batch file's cmd.exe.
      const testEntry = (ctx.env ?? env).AGENT_PLUGIN_TEST_AGY_ENTRY;
      const plan = testEntry ? { file: process.execPath, args: [testEntry, ...args], options: {} } : resolveCommand("agy", args, ctx.env ?? env);
      // A task without --write is guarded: the working tree is compared before the turn and after its
      // process exited, and the stream is watched for write tools.
      const workingFolder = ctx.cwd ?? row.cwd;
      const readOnly = sandboxModeOf(request) === "read-only";
      const guard = !request.review && readOnly ? readOnlyGuardMode(ctx.env ?? env) : "off";
      const before = guard === "on" ? await snapshotWorkingTree(workingFolder) : null;
      let guardedOutcome = null;
      adapter = createAgyEventAdapter();
      lastThreadId = row.thread_id ?? null;
      child = spawn(plan.file, plan.args, {
        cwd: ctx.cwd ?? row.cwd,
        env: agyEnv(ctx.env ?? env),
        stdio: ["pipe", "pipe", "pipe"],
        ...plan.options,
        windowsHide: true,
        // On Linux the root leads its own process group, as the worker's driver contract asks.
        detached: process.platform === "linux"
      });
      child.stdin.on("error", () => {
        // An agy that already exited takes no more input; its exit decides the turn.
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      silence = startSilenceWatch(child, readAgySilenceMs(ctx.env ?? env), () =>
        settleTurn({ status: "failed", text: "", json: null, error: "Antigravity stopped responding.", stopRoot: true })
      );
      timeoutTimer = setTimeout(
        () => settleTurn({ status: "failed", text: "", json: null, error: `agy did not finish within ${Math.round(timeoutMs / 1000)} s, so it was stopped.`, stopRoot: true }),
        timeoutMs
      );
      timeoutTimer.unref?.();

      readline.createInterface({ input: child.stdout }).on("line", (line) => {
        const events = adapter.push(line);
        if (events.length === 0) {
          return;
        }
        silence.touch();
        for (const event of events) {
          if (event.type === "init" && event.conversationId && event.conversationId !== lastThreadId) {
            lastThreadId = event.conversationId;
            ctx.onThread(event.conversationId);
          }
          if (!written) {
            continue;
          }
          if (!startedReported) {
            startedReported = true;
            ctx.onStarted();
          }
          if (event.type === "user-input") {
            sawUserInput = true;
          } else if (event.type !== "init" && sawUserInput && !receiptSent && receiptClientId) {
            receiptSent = true;
            ctx.onReceipt(receiptClientId);
          }
          if (event.type === "result") {
            const outcome = adapter.outcome({ code: 0, signal: null, conversationId: row.thread_id ?? null, readOnly });
            if (guard === "on") {
              // The guarded turn is decided once agy has exited, so its input ends here.
              guardedOutcome = outcome;
              child.stdin.end();
            } else {
              settleTurn(request.review ? reviewOutcome(outcome) : taskOutcome(outcome, request));
            }
          }
        }
      });

      // "close" follows the end of stdout, so every event was read before the turn is settled and
      // before the worker sees the exit.
      const exited = new Promise((resolve) => {
        child.on("close", async (code, signal) => {
          exitCode = code;
          if (!turnSettled && guardedOutcome) {
            const after = await snapshotWorkingTree(workingFolder);
            const changed = before && after ? changedPaths(before, after) : [];
            settleTurn(taskOutcome(guardedOutcome, request, { guard: "on", changedPaths: changed, writeToolNames: AGY_WRITE_TOOL_NAMES, readToolNames: AGY_READ_TOOL_NAMES }));
          } else if (!turnSettled) {
            const outcome = adapter.outcome({ code, signal, stderr: stderr.trim(), conversationId: row.thread_id ?? null, readOnly });
            settleTurn({ status: outcome.status, text: outcome.text, json: outcome.json, error: outcome.error });
          }
          schema?.remove();
          resolve({ code, signal, at: Date.now() });
        });
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", (error) => {
          schema?.remove();
          reject(error);
        });
      });
      return { pid: child.pid, exited, child };
    },

    async prepare(ctx) {
      const row = ctx.job ?? job;
      return { threadId: row.thread_id ?? null, turnInProgress: null, version: readAgyVersion(ctx.cwd ?? row.cwd, ctx.env ?? env) };
    },

    async start(ctx, { text, clientId }) {
      receiptClientId = clientId;
      written = true;
      writeAgyPrompt(child, text);
      return "written";
    },

    formatBody(ctx, input) {
      return formatAgyBody(ctx.job ?? job, input);
    },

    additions(ctx) {
      return additionsFor(ctx.job ?? job);
    },

    endInput() {
      child?.stdin.end();
    },

    /** The process's exit code once it closed, else null. */
    get exitCode() {
      return exitCode;
    }
  };
  return driver;
}
