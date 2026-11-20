/**
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").ReviewTarget} ReviewTarget
 * @typedef {import("./app-server-protocol").ThreadItem} ThreadItem
 * @typedef {import("./app-server-protocol").ThreadResumeParams} ThreadResumeParams
 * @typedef {import("./app-server-protocol").ThreadStartParams} ThreadStartParams
 * @typedef {import("./app-server-protocol").Turn} Turn
 * @typedef {import("./app-server-protocol").UserInput} UserInput
 * @typedef {((update: string | { message: string, phase: string | null, threadId?: string | null, turnId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 * @typedef {{
 *   threadId: string,
 *   rootThreadId: string,
 *   threadIds: Set<string>,
 *   threadTurnIds: Map<string, string>,
 *   threadLabels: Map<string, string>,
 *   turnId: string | null,
 *   bufferedNotifications: AppServerNotification[],
 *   completion: Promise<TurnCaptureState>,
 *   resolveCompletion: (state: TurnCaptureState) => void,
 *   rejectCompletion: (error: unknown) => void,
 *   finalTurn: Turn | null,
 *   completed: boolean,
 *   finalAnswerSeen: boolean,
 *   pendingCollaborations: Set<string>,
 *   activeSubagentTurns: Set<string>,
 *   completionTimer: ReturnType<typeof setTimeout> | null,
 *   lastAgentMessage: string,
 *   reviewText: string,
 *   reasoningSummary: string[],
 *   error: unknown,
 *   messages: Array<{ lifecycle: string, phase: string | null, text: string }>,
 *   fileChanges: ThreadItem[],
 *   commandExecutions: ThreadItem[],
 *   onProgress: ProgressReporter | null
 * }} TurnCaptureState
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonFile } from "../../lib/fs.mjs";
import { CodexAppServerClient, spawnAppServer } from "./app-server.mjs";
import { binaryAvailable, stopHeldTree } from "../../lib/process.mjs";
import { boundary } from "../../lib/store.mjs";

const SERVICE_NAME = "claude_code_codex_plugin";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";
const EXTERNAL_AGENT_IMPORT_COMPLETED = "externalAgentConfig/import/completed";
const EXTERNAL_AGENT_IMPORT_TIMEOUT_MS = 2 * 60 * 1000;

function cleanCodexStderr(stderr) {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:"))
    .join("\n");
}

// Thread requests take the effort as the config key model_reasoning_effort, merged with any other
// config the caller sets.
function threadConfig(options) {
  const config = { ...(options.config ?? {}), ...(options.effort ? { model_reasoning_effort: options.effort } : {}) };
  return Object.keys(config).length > 0 ? { config } : {};
}

/** @returns {ThreadStartParams} */
function buildThreadParams(cwd, options = {}) {
  return {
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only",
    serviceName: SERVICE_NAME,
    ephemeral: options.ephemeral ?? true,
    ...threadConfig(options)
  };
}

/** @returns {ThreadResumeParams} */
function buildResumeParams(threadId, cwd, options = {}) {
  return {
    threadId,
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only",
    ...threadConfig(options)
  };
}

// The model and effort a thread/start or thread/resume response says the thread uses; a field
// the response leaves out or sets to null is left out.
function reportedSelection(response) {
  return {
    ...(typeof response?.model === "string" && response.model ? { model: response.model } : {}),
    ...(typeof response?.reasoningEffort === "string" && response.reasoningEffort ? { effort: response.reasoningEffort } : {})
  };
}

// Prints one warning when the thread reports a model or effort other than the one sent, also to
// the job log through `onProgress`, then hands the reported values to `onThreadReady`. A value
// the plugin did not send is not compared. Returns the warning, or null when there is none.
function announceThreadSelection(response, sent, onThreadReady, onProgress = null) {
  const reported = reportedSelection(response);
  const modelDiffers = Boolean(sent.model && reported.model && reported.model !== sent.model);
  const effortDiffers = Boolean(sent.effort && reported.effort && reported.effort !== sent.effort);
  let warning = null;
  if (modelDiffers || effortDiffers) {
    const describe = (model, effort) => `${model ?? "default"} (effort ${effort ?? "default"})`;
    warning = `Codex reported model ${describe(reported.model ?? sent.model, reported.effort ?? sent.effort)} for this thread; the plugin sent ${describe(sent.model, sent.effort)}.`;
    process.stderr.write(`${warning}\n`);
    // The line is already on stderr, so the progress event only writes it to the log.
    emitLogEvent(onProgress, { message: warning, stderrMessage: "" });
  }
  onThreadReady?.(reported);
  return warning;
}

/** @returns {UserInput[]} */
function buildTurnInput(prompt) {
  return [{ type: "text", text: prompt, text_elements: [] }];
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

function extractThreadId(message) {
  return message?.params?.threadId ?? null;
}

function extractTurnId(message) {
  if (message?.params?.turnId) {
    return message.params.turnId;
  }
  if (message?.params?.turn?.id) {
    return message.params.turn.id;
  }
  return null;
}

function normalizeReasoningText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function extractReasoningSections(value) {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    const normalized = normalizeReasoningText(value);
    return normalized ? [normalized] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractReasoningSections(entry));
  }

  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return extractReasoningSections(value.text);
    }
    if ("summary" in value) {
      return extractReasoningSections(value.summary);
    }
    if ("content" in value) {
      return extractReasoningSections(value.content);
    }
    if ("parts" in value) {
      return extractReasoningSections(value.parts);
    }
  }

  return [];
}

function mergeReasoningSections(existingSections, nextSections) {
  const merged = [];
  for (const section of [...existingSections, ...nextSections]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}

/**
 * @param {ProgressReporter | null | undefined} onProgress
 * @param {string | null | undefined} message
 * @param {string | null | undefined} [phase]
 */
function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) {
    return;
  }

  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

function labelForThread(state, threadId) {
  if (!threadId || threadId === state.rootThreadId || threadId === state.threadId) {
    return null;
  }
  return state.threadLabels.get(threadId) ?? threadId;
}

function registerThread(state, threadId, options = {}) {
  if (!threadId) {
    return;
  }

  state.threadIds.add(threadId);
  const label =
    options.threadName ??
    options.name ??
    options.agentNickname ??
    options.agentRole ??
    state.threadLabels.get(threadId) ??
    null;
  if (label) {
    state.threadLabels.set(threadId, label);
  }
}

function describeStartedItem(state, item) {
  switch (item.type) {
    case "enteredReviewMode":
      return { message: `Reviewer started: ${item.review}`, phase: "reviewing" };
    case "commandExecution":
      return {
        message: `Running command: ${shorten(item.command, 96)}`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    case "fileChange":
      return { message: `Applying ${item.changes.length} file change(s).`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Calling ${item.server}/${item.tool}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Running tool: ${item.tool}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Starting subagent ${subagents.join(", ")} via collaboration tool: ${item.tool}.`
          : `Starting collaboration tool: ${item.tool}.`;
      return { message: summary, phase: "investigating" };
    }
    case "webSearch":
      return { message: `Searching: ${shorten(item.query, 96)}`, phase: "investigating" };
    default:
      return null;
  }
}

function describeCompletedItem(state, item) {
  switch (item.type) {
    case "commandExecution": {
      const exitCode = item.exitCode ?? "?";
      const statusLabel = item.status === "completed" ? "completed" : item.status;
      return {
        message: `Command ${statusLabel}: ${shorten(item.command, 96)} (exit ${exitCode})`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    }
    case "fileChange":
      return { message: `File changes ${item.status}.`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Tool ${item.server}/${item.tool} ${item.status}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Tool ${item.tool} ${item.status}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Subagent ${subagents.join(", ")} ${item.status}.`
          : `Collaboration tool ${item.tool} ${item.status}.`;
      return { message: summary, phase: "investigating" };
    }
    case "exitedReviewMode":
      return { message: "Reviewer finished.", phase: "finalizing" };
    default:
      return null;
  }
}

/** @returns {TurnCaptureState} */
function createTurnCaptureState(threadId, options = {}) {
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  return {
    threadId,
    rootThreadId: threadId,
    threadIds: new Set([threadId]),
    threadTurnIds: new Map(),
    threadLabels: new Map(),
    turnId: null,
    bufferedNotifications: [],
    completion,
    resolveCompletion,
    rejectCompletion,
    finalTurn: null,
    completed: false,
    finalAnswerSeen: false,
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Set(),
    completionTimer: null,
    lastAgentMessage: "",
    reviewText: "",
    reasoningSummary: [],
    error: null,
    messages: [],
    fileChanges: [],
    commandExecutions: [],
    onProgress: options.onProgress ?? null
  };
}

function clearCompletionTimer(state) {
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = null;
  }
}

function completeTurn(state, turn = null, options = {}) {
  if (state.completed) {
    return;
  }

  clearCompletionTimer(state);
  state.completed = true;

  if (turn) {
    state.finalTurn = turn;
    if (!state.turnId) {
      state.turnId = turn.id;
    }
  } else if (!state.finalTurn) {
    state.finalTurn = {
      id: state.turnId ?? "inferred-turn",
      status: "completed"
    };
  }

  if (options.inferred) {
    emitProgress(state.onProgress, "Turn completion inferred after the main thread finished and subagent work drained.", "finalizing");
  }

  state.resolveCompletion(state);
}

function scheduleInferredCompletion(state) {
  if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
    return;
  }

  if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
    return;
  }

  clearCompletionTimer(state);
  state.completionTimer = setTimeout(() => {
    state.completionTimer = null;
    if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
      return;
    }
    if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
      return;
    }
    completeTurn(state, null, { inferred: true });
  }, 250);
  state.completionTimer.unref?.();
}

function belongsToTurn(state, message) {
  const messageThreadId = extractThreadId(message);
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
    return false;
  }
  const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
  const messageTurnId = extractTurnId(message);
  return trackedTurnId === null || messageTurnId === null || messageTurnId === trackedTurnId;
}

function recordItem(state, item, lifecycle, threadId = null) {
  if (item.type === "collabAgentToolCall") {
    if (!threadId || threadId === state.threadId) {
      if (lifecycle === "started" || item.status === "inProgress") {
        state.pendingCollaborations.add(item.id);
      } else if (lifecycle === "completed") {
        state.pendingCollaborations.delete(item.id);
        scheduleInferredCompletion(state);
      }
    }
    for (const receiverThreadId of item.receiverThreadIds ?? []) {
      registerThread(state, receiverThreadId);
    }
  }

  if (item.type === "agentMessage") {
    state.messages.push({
      lifecycle,
      phase: item.phase ?? null,
      text: item.text ?? ""
    });
    if (item.text) {
      if (!threadId || threadId === state.threadId) {
        state.lastAgentMessage = item.text;
        if (lifecycle === "completed" && item.phase === "final_answer") {
          state.finalAnswerSeen = true;
          scheduleInferredCompletion(state);
        }
      }
      if (lifecycle === "completed") {
        const sourceLabel = labelForThread(state, threadId);
        emitLogEvent(state.onProgress, {
          message: sourceLabel ? `Subagent ${sourceLabel}: ${shorten(item.text, 96)}` : `Assistant message captured: ${shorten(item.text, 96)}`,
          stderrMessage: null,
          phase: item.phase === "final_answer" ? "finalizing" : null,
          logTitle: sourceLabel ? `Subagent ${sourceLabel} message` : "Assistant message",
          logBody: item.text
        });
      }
    }
    return;
  }

  if (item.type === "exitedReviewMode") {
    state.reviewText = item.review ?? "";
    if (lifecycle === "completed" && item.review) {
      emitLogEvent(state.onProgress, {
        message: "Review output captured.",
        stderrMessage: null,
        phase: "finalizing",
        logTitle: "Review output",
        logBody: item.review
      });
    }
    return;
  }

  if (item.type === "reasoning" && lifecycle === "completed") {
    const nextSections = extractReasoningSections(item.summary);
    state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, nextSections);
    if (nextSections.length > 0) {
      const sourceLabel = labelForThread(state, threadId);
      emitLogEvent(state.onProgress, {
        message: sourceLabel
          ? `Subagent ${sourceLabel} reasoning: ${shorten(nextSections[0], 96)}`
          : `Reasoning summary captured: ${shorten(nextSections[0], 96)}`,
        stderrMessage: null,
        logTitle: sourceLabel ? `Subagent ${sourceLabel} reasoning summary` : "Reasoning summary",
        logBody: nextSections.map((section) => `- ${section}`).join("\n")
      });
    }
    return;
  }

  if (item.type === "fileChange" && lifecycle === "completed") {
    state.fileChanges.push(item);
    return;
  }

  if (item.type === "commandExecution" && lifecycle === "completed") {
    state.commandExecutions.push(item);
  }
}

function applyTurnNotification(state, message) {
  switch (message.method) {
    case "thread/started":
      // A thread that is neither this turn's nor a known subagent keeps only its label, which
      // names it if a collaboration call later registers it as a subagent.
      if (message.params.thread.id !== state.threadId && !state.threadIds.has(message.params.thread.id)) {
        const label = message.params.thread.name ?? message.params.thread.agentNickname ?? message.params.thread.agentRole ?? null;
        if (label) {
          state.threadLabels.set(message.params.thread.id, label);
        }
        break;
      }
      registerThread(state, message.params.thread.id, {
        threadName: message.params.thread.name,
        name: message.params.thread.name,
        agentNickname: message.params.thread.agentNickname,
        agentRole: message.params.thread.agentRole
      });
      break;
    case "thread/name/updated":
      registerThread(state, message.params.threadId, {
        threadName: message.params.threadName ?? null
      });
      break;
    case "turn/started":
      registerThread(state, message.params.threadId);
      state.threadTurnIds.set(message.params.threadId, message.params.turn.id);
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.add(message.params.threadId);
      }
      emitProgress(
        state.onProgress,
        `Turn started (${message.params.turn.id}).`,
        "starting",
        (message.params.threadId ?? null) === state.threadId
          ? {
              threadId: message.params.threadId ?? null,
              turnId: message.params.turn.id ?? null
            }
          : {}
      );
      break;
    case "item/started":
      recordItem(state, message.params.item, "started", message.params.threadId ?? null);
      {
        const update = describeStartedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "item/completed":
      recordItem(state, message.params.item, "completed", message.params.threadId ?? null);
      {
        const update = describeCompletedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "error":
      state.error = message.params.error;
      emitProgress(state.onProgress, `Codex error: ${message.params.error.message}`, "failed");
      break;
    case "turn/completed":
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.delete(message.params.threadId);
        scheduleInferredCompletion(state);
        break;
      }
      // The turn is completed before the progress write, which can throw.
      completeTurn(state, message.params.turn);
      emitProgress(
        state.onProgress,
        `Turn ${message.params.turn.status === "completed" ? "completed" : message.params.turn.status}.`,
        "finalizing"
      );
      break;
    default:
      break;
  }
}

const DEFAULT_TURN_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

// CODEX_COMPANION_TURN_IDLE_TIMEOUT_MS sets how long a running turn may send no event before
// it is ended with the output it produced so far. Zero turns the limit off.
function readTurnIdleTimeoutMs() {
  const raw = (process.env.CODEX_COMPANION_TURN_IDLE_TIMEOUT_MS ?? "").trim();
  return /^\d+$/.test(raw) ? Math.min(Number(raw), 2 ** 31 - 1) : DEFAULT_TURN_IDLE_TIMEOUT_MS;
}

async function withAppServer(cwd, fn) {
  const client = await CodexAppServerClient.connect(cwd);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

// How long a short-lived app server may take to exit by itself after its input ended.
const SHORT_LIVED_EXIT_MS = 2000;
// The time the stop of a short-lived app server that did not exit by itself may take.
const SHORT_LIVED_STOP_MS = 10000;

/**
 * Runs `fn(client)` on an app server of its own, for a short exchange such as an auth check or a
 * rate-limit read. When `fn` settles the app server's input is ended; if it is still running 2
 * seconds later, its tree is stopped through the ChildProcess this call holds, so the stop cannot
 * reach another process that took its id. Resolves or rejects as `fn` did.
 */
export async function withShortLivedAppServer(cwd, fn, { env = undefined } = {}) {
  const { client, child } = await spawnAppServer(cwd, { env });
  try {
    return await fn(client);
  } finally {
    // The exit that follows is the one asked for here, so the client reports no error for it.
    client.closeStarted = true;
    client.closed = true;
    try {
      child.stdin.end();
    } catch {
      // An input that already failed cannot be ended; the stop below still applies.
    }
    if (!(await client.waitForProcessExit(SHORT_LIVED_EXIT_MS))) {
      await stopHeldTree(child, { deadline: performance.now() + SHORT_LIVED_STOP_MS });
      await client.waitForProcessExit(SHORT_LIVED_EXIT_MS);
    }
  }
}

function resolveCodexHome() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function sourceContentSha256(sourcePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
}

// Codex records the source path in its extended-length form on Windows (\\?\C:\...), and
// Windows paths compare without case.
function comparableImportPath(value, platform = process.platform) {
  let text = String(value ?? "");
  if (platform !== "win32") {
    return text;
  }
  if (text.startsWith("\\\\?\\UNC\\")) {
    text = `\\\\${text.slice(8)}`;
  } else if (text.startsWith("\\\\?\\")) {
    text = text.slice(4);
  }
  return path.win32.normalize(text).toLowerCase();
}

function ledgerTimeSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value / 1000 : value;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms / 1000;
  }
  return null;
}

/**
 * Finds the thread Codex recorded for `sourcePath` in its import ledger. A record whose content
 * hash differs is accepted only when Codex wrote it after this import started, because a live
 * Claude transcript keeps growing while it is imported.
 */
function importedThreadIdFromLedger(sourcePath, { contentSha256, importStartedAtMs }) {
  const ledgerPath = path.join(resolveCodexHome(), "external_agent_session_imports.json");
  if (!fs.existsSync(ledgerPath)) {
    return null;
  }
  // A ledger that cannot be parsed records no import, so the caller reports the missing thread.
  let ledger;
  try {
    ledger = readJsonFile(ledgerPath);
  } catch {
    return null;
  }
  const source = comparableImportPath(fs.realpathSync(sourcePath));
  const startedAtSeconds = Math.floor(importStartedAtMs / 1000);
  const records = Array.isArray(ledger?.records) ? ledger.records : [];
  const match = records
    .filter((record) => {
      if (typeof record?.imported_thread_id !== "string" || comparableImportPath(record.source_path) !== source) {
        return false;
      }
      if (record.content_sha256 === contentSha256) {
        return true;
      }
      const importedAt = ledgerTimeSeconds(record.imported_at);
      return importedAt !== null && importedAt >= startedAtSeconds;
    })
    .at(-1);
  return match?.imported_thread_id ?? null;
}

function summarizeSessionImport(completion) {
  const results = Array.isArray(completion?.itemTypeResults) ? completion.itemTypeResults : [];
  const sessions = results.filter((result) => result?.itemType === "SESSIONS");
  const successes = sessions.flatMap((result) => (Array.isArray(result.successes) ? result.successes : []));
  const failures = sessions.flatMap((result) => (Array.isArray(result.failures) ? result.failures : []));
  return {
    threadId: successes.map((success) => success?.target).filter((target) => typeof target === "string" && target.trim()).at(-1) ?? null,
    failures: failures.map((failure) => failure?.message).filter((message) => typeof message === "string" && message.trim())
  };
}

function externalAgentSessionMigration(sourcePath, cwd) {
  return {
    migrationItems: [
      {
        itemType: "SESSIONS",
        description: `Transfer Claude session ${path.basename(sourcePath)}`,
        cwd: null,
        details: {
          plugins: [],
          sessions: [{ path: sourcePath, cwd, title: null }],
          mcpServers: [],
          hooks: [],
          subagents: [],
          commands: []
        }
      }
    ]
  };
}

// Resolves with the completion notification for this import. The import response carries the
// import id; the notification can arrive before the response is read.
async function requestExternalAgentSessionImport(client, params) {
  const previousHandler = client.notificationHandler;
  const completions = [];
  let onCompletion = null;
  let timeout = null;
  client.setNotificationHandler((message) => {
    if (message.method === EXTERNAL_AGENT_IMPORT_COMPLETED) {
      completions.push(message.params ?? {});
      onCompletion?.();
      return;
    }
    previousHandler?.(message);
  });

  try {
    const response = await client.request("externalAgentConfig/import", params);
    const importId = response?.importId ?? null;
    const findCompletion = () =>
      completions.find((completion) => !importId || !completion.importId || completion.importId === importId);
    if (!findCompletion()) {
      await new Promise((resolve, reject) => {
        onCompletion = () => {
          if (findCompletion()) {
            resolve();
          }
        };
        timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for Codex to finish importing the Claude session."));
        }, EXTERNAL_AGENT_IMPORT_TIMEOUT_MS);
      });
    }
    return findCompletion();
  } finally {
    clearTimeout(timeout);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

const BUILTIN_PROVIDER_LABELS = new Map([
  ["openai", "OpenAI"],
  ["ollama", "Ollama"],
  ["lmstudio", "LM Studio"]
]);

function normalizeProviderId(value) {
  const providerId = typeof value === "string" ? value.trim() : "";
  return providerId || null;
}

function formatProviderLabel(providerId, providerConfig = null) {
  const configuredName = typeof providerConfig?.name === "string" ? providerConfig.name.trim() : "";
  if (configuredName) {
    return configuredName;
  }
  if (!providerId) {
    return "The active provider";
  }
  return BUILTIN_PROVIDER_LABELS.get(providerId) ?? providerId;
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "unknown",
    authMethod: null,
    verified: null,
    requiresOpenaiAuth: null,
    provider: null,
    ...fields
  };
}

function resolveProviderConfig(configResponse) {
  const config = configResponse?.config;
  if (!config || typeof config !== "object") {
    return {
      providerId: null,
      providerConfig: null
    };
  }

  const providerId = normalizeProviderId(config.model_provider);
  const providers =
    config.model_providers && typeof config.model_providers === "object" && !Array.isArray(config.model_providers)
      ? config.model_providers
      : null;
  const providerConfig =
    providerId && providers?.[providerId] && typeof providers[providerId] === "object" ? providers[providerId] : null;

  return {
    providerId,
    providerConfig
  };
}

function buildAppServerAuthStatus(accountResponse, configResponse) {
  const account = accountResponse?.account ?? null;
  const requiresOpenaiAuth =
    typeof accountResponse?.requiresOpenaiAuth === "boolean" ? accountResponse.requiresOpenaiAuth : null;
  const { providerId, providerConfig } = resolveProviderConfig(configResponse);
  const providerLabel = formatProviderLabel(providerId, providerConfig);

  if (account?.type === "chatgpt") {
    const email = typeof account.email === "string" && account.email.trim() ? account.email.trim() : null;
    return buildAuthStatus({
      loggedIn: true,
      detail: email ? `ChatGPT login active for ${email}` : "ChatGPT login active",
      source: "app-server",
      authMethod: "chatgpt",
      verified: true,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (account?.type === "apiKey") {
    return buildAuthStatus({
      loggedIn: true,
      detail: "API key configured (unverified)",
      source: "app-server",
      authMethod: "apiKey",
      verified: false,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (requiresOpenaiAuth === false) {
    return buildAuthStatus({
      loggedIn: true,
      detail: `${providerLabel} is configured and does not require OpenAI authentication`,
      source: "app-server",
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  return buildAuthStatus({
    loggedIn: false,
    detail: `${providerLabel} requires OpenAI authentication`,
    source: "app-server",
    requiresOpenaiAuth,
    provider: providerId
  });
}

async function getCodexAuthStatusFromClient(client, cwd) {
  try {
    const accountResponse = await client.request("account/read", { refreshToken: false });
    const configResponse = await client.request("config/read", {
      includeLayers: false,
      cwd
    });

    return buildAppServerAuthStatus(accountResponse, configResponse);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  }
}

export function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/agent:codex-setup`.");
  }
}

export function getCodexAvailability(cwd) {
  const versionStatus = binaryAvailable("codex", ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const appServerStatus = binaryAvailable("codex", ["app-server", "--help"], { cwd });
  if (!appServerStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; advanced runtime unavailable: ${appServerStatus.detail}`
    };
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; advanced runtime available`
  };
}

export function getSessionRuntimeStatus() {
  return {
    mode: "direct",
    label: "direct startup",
    detail: "Each Codex command starts its own app server and stops it when done.",
    endpoint: null
  };
}

export async function getCodexAuthStatus(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      requiresOpenaiAuth: null,
      provider: null
    };
  }

  try {
    return await withShortLivedAppServer(
      cwd,
      async (client) => {
        const status = await getCodexAuthStatusFromClient(client, cwd);
        return { ...status, userAgent: client.serverInfo?.userAgent ?? null };
      },
      { env: options.env }
    );
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  }
}

export async function readCodexRateLimits(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/agent:codex-setup`.");
  }
  return withShortLivedAppServer(cwd, (client) => client.request("account/rateLimits/read", {}));
}

export async function importExternalAgentSession(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/agent:codex-setup`.");
  }
  if (!options.sourcePath) {
    throw new Error("A Claude session source path is required.");
  }

  return withAppServer(cwd, async (client) => {
    emitProgress(options.onProgress, "Importing Claude session into Codex.", "transferring");
    const contentSha256 = options.contentSha256 ?? sourceContentSha256(options.sourcePath);
    const importStartedAtMs = Date.now();
    let completion;
    try {
      completion = await requestExternalAgentSessionImport(client, externalAgentSessionMigration(options.sourcePath, cwd));
    } catch (error) {
      if (error?.rpcCode === -32601) {
        throw new Error(
          "This Codex version does not support Claude session transfer. Update Codex with `npm install -g @openai/codex@latest`, then retry.",
          { cause: error }
        );
      }
      throw error;
    }
    const outcome = summarizeSessionImport(completion);
    const threadId =
      outcome.threadId ?? importedThreadIdFromLedger(options.sourcePath, { contentSha256, importStartedAtMs });
    if (!threadId) {
      if (outcome.failures.length > 0) {
        throw new Error(`Codex could not import the Claude session:\n${outcome.failures.map((message) => `- ${message}`).join("\n")}`);
      }
      const stderr = cleanCodexStderr(client.stderr);
      throw new Error(
        `Codex reported that the Claude import completed, but did not record an imported thread.${stderr ? `\n${stderr}` : " Check the Codex app-server logs for the underlying import error."}`
      );
    }
    emitProgress(options.onProgress, `Claude session imported (${threadId}).`, "completed", { threadId });
    return {
      threadId,
      importId: typeof completion?.importId === "string" ? completion.importId : null,
      codexVersion: /^codex-cli\s+(\S+)/.exec(availability.detail ?? "")?.[1] ?? null,
      stderr: cleanCodexStderr(client.stderr)
    };
  });
}

// Codex answers thread/read for a thread it does not know with an error that says so. Codex
// 0.169.0 answers "thread not loaded: <id>"; the other forms cover earlier and later wording.
const UNKNOWN_THREAD_ERROR = /thread not loaded|unknown thread|thread not found|no thread|not found|does not exist|no rollout/i;

/**
 * Whether Codex still has the thread `threadId`, checked with thread/read. An error that says the
 * thread is unknown answers false; any other error is thrown.
 */
export async function threadExists(cwd, threadId) {
  return withAppServer(cwd, async (client) => {
    try {
      await client.request("thread/read", { threadId });
      return true;
    } catch (error) {
      if (typeof error?.rpcCode === "number" && UNKNOWN_THREAD_ERROR.test(String(error.message))) {
        return false;
      }
      throw error;
    }
  });
}

/**
 * Counts the user and assistant messages of an imported thread from its rollout file, which
 * thread/read names: the `response_item` lines of type `message`, by role. Resolves to null when
 * Codex names no rollout file or the file cannot be read. Call it before anything is appended to
 * the thread.
 */
export async function censusImportedThread(cwd, threadId) {
  const rolloutPath = await withAppServer(cwd, async (client) => {
    const response = await client.request("thread/read", { threadId });
    return typeof response?.thread?.path === "string" && response.thread.path ? response.thread.path : null;
  });
  if (!rolloutPath) {
    return null;
  }
  const census = { userMessages: 0, assistantMessages: 0 };
  try {
    const { createInterface } = await import("node:readline");
    const lines = createInterface({ input: fs.createReadStream(rolloutPath), crlfDelay: Infinity });
    for await (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type !== "response_item" || entry.payload?.type !== "message") {
        continue;
      }
      if (entry.payload.role === "user") {
        census.userMessages += 1;
      } else if (entry.payload.role === "assistant") {
        census.assistantMessages += 1;
      }
    }
  } catch {
    return null;
  }
  return census;
}

/**
 * Appends one user message with `text` to the model-visible history of `threadId`. The thread is
 * loaded with thread/resume first, because thread/inject_items needs a loaded thread.
 */
export async function injectThreadPointer(cwd, threadId, text) {
  await withAppServer(cwd, async (client) => {
    await client.request("thread/resume", { threadId, excludeTurns: true });
    await client.request("thread/inject_items", {
      threadId,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }]
    });
  });
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Codex did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

// ---------------------------------------------------------------------------------------------
// The Codex driver of the job store worker (see "The provider driver contract" in
// lib/tracked-jobs.mjs). The worker owns every store write; the driver only talks to its own app
// server and reports what happened.

// The version a Codex user agent names, such as "codex_cli_rs/0.169.0 (...)".
function versionFromUserAgent(userAgent) {
  const match = /(\d+\.\d+\.\d+)/.exec(String(userAgent ?? ""));
  return match ? match[1] : null;
}

// The id of a turn a resumed thread reports as still running, or null.
function turnInProgressOf(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const running = turns.filter((turn) => turn?.status === "inProgress" || turn?.status === "in_progress");
  return running.length > 0 ? (running.at(-1).id ?? null) : null;
}

function errorText(error) {
  if (!error) {
    return null;
  }
  return typeof error === "string" ? error : (error.message ?? JSON.stringify(error));
}

// The answer a finished turn gives the worker. An interrupted turn keeps the output it produced.
// With `requireJson` (a schema-bound review), an answer that is not valid JSON fails the turn and
// keeps its text, so no hand-off reads it as a finished review.
function turnAnswer(state, outputSchema, { requireJson = false } = {}) {
  const status = state.finalTurn?.status ?? "completed";
  // A native review's answer is the reviewer's text; a turn's is its last agent message.
  const text = state.reviewText || state.lastAgentMessage || "";
  if (status === "failed") {
    return { status: "failed", text, json: null, error: errorText(state.finalTurn?.error ?? state.error) ?? "the Codex turn failed" };
  }
  let json = null;
  if (outputSchema && text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (requireJson && outputSchema && json === null) {
    return { status: "failed", text, json: null, error: "Codex did not return valid structured JSON." };
  }
  return { status: "answer", text, json, error: null };
}

// Writes one capture progress event to the job log through the worker's `log`: its message as a
// line and, when it has one, its titled block below it.
function logProgress(ctx, event) {
  if (!ctx?.log || !event) {
    return;
  }
  const message = typeof event === "string" ? event : String(event.message ?? "");
  if (message.trim()) {
    ctx.log(message);
  }
  if (typeof event === "object" && event.logTitle && event.logBody) {
    ctx.log(`${event.logTitle}\n${String(event.logBody).trimEnd()}`);
  }
}

/**
 * The driver that runs one Codex job in a worker: its own app server (leading its own process
 * group on Linux), `thread/start` or `thread/resume`, `turn/start` with the message's client id,
 * steering into the open turn, interrupts, and the thread history for messages that may have been
 * delivered. `job` may be omitted; the worker passes the job row in each call's context.
 */
export function createCodexDriver(job = null, { env = process.env } = {}) {
  let client = null;
  let child = null;
  let threadId = null;
  let turnId = null;
  let capture = null;
  let resolveTurn = null;
  let outputSchema = null;
  let context = null;
  let idleTimer = null;
  let startAnswered = false;
  let selectionWarning = null;
  let handshakeDone = false;
  const idleTimeoutMs = readTurnIdleTimeoutMs();
  const previousTurns = new Map();

  const request = (method, params) => {
    boundary("provider-request");
    return client.request(method, params);
  };

  // When Codex sends no event for the idle limit while the turn runs, the turn is interrupted and
  // ends failed, keeping the output it produced.
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    if (idleTimeoutMs <= 0 || !capture || capture.completed || !turnId) {
      return;
    }
    idleTimer = setTimeout(() => {
      if (!capture || capture.completed) {
        return;
      }
      const seconds = Math.round(idleTimeoutMs / 1000);
      capture.error = { message: `Codex sent no events for ${seconds} s, so the turn was stopped. Its output so far is kept.` };
      request("turn/interrupt", { threadId, turnId }).catch(() => {});
      completeTurn(capture, { id: turnId, status: "failed", error: capture.error });
      finishTurn();
    }, idleTimeoutMs);
    idleTimer.unref?.();
  };

  const finishTurn = () => {
    if (capture?.completed) {
      clearTimeout(idleTimer);
    }
    if (resolveTurn && capture?.completed) {
      const resolve = resolveTurn;
      resolveTurn = null;
      const review = context?.job ? parseJobRequest(context.job).review : null;
      const answer = turnAnswer(capture, outputSchema, { requireJson: Boolean(review && !review.native) });
      // The model warning leads the stored output, so result shows it; the last line stays the
      // agent's, where a question is read from.
      resolve(selectionWarning ? { ...answer, text: answer.text ? `${selectionWarning}\n\n${answer.text}` : selectionWarning } : answer);
    }
  };

  const onNotification = (message) => {
    const item = message.params?.item;
    if ((message.method === "item/started" || message.method === "item/completed") && item?.type === "userMessage" && item.clientId) {
      context?.onReceipt?.(item.clientId);
    }
    if (message.method === "turn/completed") {
      const endedId = message.params?.turn?.id ?? null;
      const waiter = endedId ? previousTurns.get(endedId) : null;
      if (waiter) {
        previousTurns.delete(endedId);
        waiter();
        return;
      }
      if (turnId && endedId && endedId !== turnId && (message.params?.threadId ?? null) === threadId) {
        return;
      }
    }
    if (capture && !capture.completed) {
      // Until the start request is answered the turn id is unknown, so notifications wait.
      if (!startAnswered) {
        capture.bufferedNotifications.push(message);
        return;
      }
      applyCaptured(message);
    }
  };

  // Applies one notification to the turn's capture when it belongs to this turn or one of its
  // subagents; thread starts and names are always kept, for the labels of later subagents.
  const applyCaptured = (message) => {
    if (!capture || capture.completed) {
      return;
    }
    if (message.method !== "thread/started" && message.method !== "thread/name/updated" && !belongsToTurn(capture, message)) {
      return;
    }
    applyTurnNotification(capture, message);
    armIdleTimer();
    finishTurn();
  };

  const driver = {
    id: "codex",
    resumeMethod: "thread",
    capabilities: Object.freeze({ steer: true, interrupt: true, history: true, ownExit: false }),
    turnEnded: null,

    async spawn(ctx) {
      context = ctx;
      // The handshake waits for prepare, so the worker holds the child, and can stop it, first.
      const started = await spawnAppServer(ctx.cwd ?? ctx.job?.cwd ?? job?.cwd, { env, ownProcessGroup: true, handshake: false });
      client = started.client;
      child = started.child;
      client.setNotificationHandler(onNotification);
      const exited = new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve({ code: child.exitCode, signal: child.signalCode, at: Date.now() });
          return;
        }
        child.once("exit", (code, signal) => resolve({ code, signal, at: Date.now() }));
      });
      return { pid: child.pid, exited, child };
    },

    async prepare(ctx) {
      context = ctx;
      if (!handshakeDone) {
        boundary("provider-request");
        await client.handshake();
        handshakeDone = true;
      }
      const row = ctx.job;
      const requestFields = parseJobRequest(row);
      const options = { model: row.model ?? requestFields.model ?? null, effort: requestFields.effort ?? null, sandbox: requestFields.sandbox ?? undefined };
      // The user agent names the Codex version; when it does not, `codex --version` does.
      const version =
        versionFromUserAgent(client.serverInfo?.userAgent) ?? versionFromUserAgent(binaryAvailable("codex", ["--version"], { cwd: row.cwd, env }).detail);
      const cwd = requestFields.worktree?.path ?? row.cwd;
      // A thread that reports another model or effort than the one sent gets one warning, at the top
      // of the turn's answer: the worker writes that answer to the job log and stores it as the
      // result. Logging it here as well would print it twice in a foreground run.
      const sent = { model: options.model, effort: options.effort };
      const announce = (response) => {
        selectionWarning = announceThreadSelection(response, sent, null);
      };
      if (row.thread_id) {
        const response = await request("thread/resume", buildResumeParams(row.thread_id, cwd, options));
        threadId = response.thread?.id ?? row.thread_id;
        announce(response);
        return { threadId, turnInProgress: turnInProgressOf(response.thread), version };
      }
      const response = await request("thread/start", buildThreadParams(cwd, { ...options, ephemeral: Boolean(row.ephemeral) }));
      threadId = response.thread.id;
      announce(response);
      return { threadId, turnInProgress: null, version };
    },

    async start(ctx, { text, clientId, outputSchema: schema }) {
      context = ctx;
      outputSchema = schema ?? null;
      startAnswered = false;
      // The turn's progress lines, reasoning summaries and messages go to the job log.
      capture = createTurnCaptureState(threadId, { onProgress: (event) => logProgress(ctx, event) });
      // A completion the capture infers on its own timer (the main thread answered and its subagents
      // drained, but no turn/completed came) ends the turn too.
      capture.completion.then(finishTurn, () => {});
      driver.turnEnded = new Promise((resolve) => {
        resolveTurn = resolve;
      });
      const requestFields = parseJobRequest(ctx.job);
      let response;
      try {
        response = requestFields.review?.native
          ? // Codex's built-in reviewer runs on the job's own single-use thread.
            await request("review/start", { threadId, delivery: "inline", target: requestFields.review.nativeTarget })
          : await request("turn/start", {
              threadId,
              input: buildTurnInput(text),
              clientUserMessageId: clientId,
              model: ctx.job.model ?? requestFields.model ?? null,
              effort: requestFields.effort ?? null,
              outputSchema
            });
      } catch {
        return "rejected";
      }
      turnId = response.turn?.id ?? null;
      if (turnId) {
        capture.turnId = turnId;
        capture.threadTurnIds.set(threadId, turnId);
      }
      startAnswered = true;
      for (const message of capture.bufferedNotifications.splice(0)) {
        applyCaptured(message);
      }
      ctx.onTurn(turnId);
      ctx.onStarted();
      armIdleTimer();
      finishTurn();
      return "written";
    },

    async steer(ctx, { text, clientId }) {
      context = ctx;
      try {
        await request("turn/steer", { threadId, expectedTurnId: turnId, input: buildTurnInput(text), clientUserMessageId: clientId });
        return "accepted";
      } catch (error) {
        return /no active turn|turn (has )?ended|not (the )?active|already (completed|ended)/i.test(String(error?.message ?? error)) ? "turn-ended" : "rejected";
      }
    },

    async interrupt() {
      if (threadId && turnId) {
        await request("turn/interrupt", { threadId, turnId });
      }
    },

    async interruptPrevious(ctx, previousTurnId, timeoutMs) {
      const ended = new Promise((resolve) => previousTurns.set(previousTurnId, () => resolve("ended")));
      let timer;
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      // A turn that already ended answers with an error; its end notification still decides. An
      // interrupt that is never answered is waited for no longer than the turn's end.
      const interrupted = (async () => request("turn/interrupt", { threadId, turnId: previousTurnId }))().catch(() => {});
      await Promise.race([interrupted, timedOut]);
      const outcome = await Promise.race([ended, timedOut]);
      clearTimeout(timer);
      previousTurns.delete(previousTurnId);
      return outcome;
    },

    async historyHas(ctx, clientIds) {
      const wanted = new Set(clientIds);
      const found = new Set();
      let cursor = null;
      for (let page = 0; page < 1000; page += 1) {
        const response = await request("thread/turns/list", { threadId, cursor, limit: 50 });
        for (const turn of response.data ?? []) {
          for (const entry of turn.items ?? []) {
            if (entry?.type === "userMessage" && wanted.has(entry.clientId)) {
              found.add(entry.clientId);
            }
          }
        }
        cursor = response.nextCursor ?? null;
        if (!cursor || found.size === wanted.size) {
          break;
        }
      }
      return found;
    },

    endInput() {
      try {
        child?.stdin.end();
      } catch {
        // An input that already failed cannot be ended.
      }
    }
  };
  return driver;
}

function parseJobRequest(row) {
  try {
    return JSON.parse(row?.request_json ?? "{}") ?? {};
  } catch {
    return {};
  }
}

export { DEFAULT_CONTINUE_PROMPT };
