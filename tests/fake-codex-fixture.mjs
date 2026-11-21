import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { writeExecutable } from "./helpers.mjs";

const PROCESS_LIB = pathToFileURL(path.join(import.meta.dirname, "..", "plugins", "agent", "scripts", "lib", "process.mjs")).href;

function listEfforts(names) {
  return names.map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }));
}

function debugLevels(names) {
  return names.map((effort) => ({ effort, description: effort }));
}

// The model/list entries of the fake Codex. m-default is the catalog default.
export const FAKE_LIST_MODELS = [
  {
    id: "m-default",
    model: "m-default",
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: listEfforts(["low", "medium", "high"])
  },
  {
    id: "gpt-5.6-luna",
    model: "gpt-5.6-luna",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: listEfforts(["low", "medium", "high"])
  }
];

// The `codex debug models` catalog that matches FAKE_LIST_MODELS.
export const FAKE_DEBUG_DEFAULT_MODELS = [
  { slug: "m-default", visibility: "list", priority: 1, default_reasoning_level: "low", supported_reasoning_levels: debugLevels(["low", "medium", "high"]) },
  { slug: "gpt-5.6-luna", visibility: "list", priority: 9, default_reasoning_level: "medium", supported_reasoning_levels: debugLevels(["low", "medium", "high"]) }
];

// The `codex debug models` catalog of the behaviours that test the Sol fallback.
export const FAKE_DEBUG_SOL_MODELS = [
  { slug: "gpt-6.1-sol", visibility: "list", priority: 1, default_reasoning_level: "medium", supported_reasoning_levels: debugLevels(["low", "medium", "high", "xhigh"]) },
  { slug: "gpt-6-sol", visibility: "list", priority: 4, default_reasoning_level: "medium", supported_reasoning_levels: debugLevels(["low", "medium", "high"]) },
  { slug: "gpt-5.6-sol", visibility: "list", priority: 7, default_reasoning_level: "medium", supported_reasoning_levels: debugLevels(["low", "medium", "high"]) },
  { slug: "gpt-5.6-luna", visibility: "list", priority: 9, default_reasoning_level: "medium", supported_reasoning_levels: debugLevels(["low", "medium", "high"]) }
];

// Model catalog behaviours:
// - "catalog-default": as the default. thread/start with model null reports "m-configured", the
//   model a Codex configuration sets; every behaviour reports that for model null.
// - "list-fails-debug-sols": model/list errors; `codex debug models` lists FAKE_DEBUG_SOL_MODELS.
// - "no-default-mark": model/list marks no default; debug lists FAKE_DEBUG_SOL_MODELS.
// - "no-catalog" and "no-model-list": model/list and `codex debug models` both fail.
// - "model-list-hangs": model/list is never answered; debug lists FAKE_DEBUG_SOL_MODELS.
// - "reports-other-model": thread/start and thread/resume report "m-reported", effort "high".
// - "partial-report": thread/start and thread/resume report a model and effort null.
// - "unknown-model": no catalog, and a turn that names a model fails with modelNotFound.
// - "catalog-initialize-hangs": the first app server, which reads the catalog, never answers
//   initialize and keeps running after its input closes and after SIGTERM; later app servers work.
//   debug lists FAKE_DEBUG_SOL_MODELS.
// - "debug-models-hangs": `codex debug models` records its pid in debugModelsPids, ignores
//   SIGTERM and never exits.
// - "debug-models-floods": `codex debug models` records its pid in debugModelsPids and prints
//   16 MiB of output without a complete JSON document, then never exits.
//
// With `{ recordIdentities: true }` every app server and `codex debug models` process also adds
// `{ pid, startToken, key }` to processIdentities once readProcessIdentity has read its own
// identity, so a test can stop it with stopOwnedProcesses; `key` names the pid list it is in.
// `version` makes the app server report that Codex version in its user agent.
export function installFakeCodex(binDir, behavior = "review-ok", { recordIdentities = false, version = null } = {}) {
  const statePath = path.join(binDir, "fake-codex-state.json");
  const scriptPath = path.join(binDir, "codex");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

	const STATE_PATH = ${JSON.stringify(statePath)};
	const BEHAVIOR = ${JSON.stringify(behavior)};
	const RECORD_IDENTITIES = ${JSON.stringify(recordIdentities)};
	const USER_AGENT = ${JSON.stringify(version ? `fake-codex-app-server/${version}` : "fake-codex-app-server")};
	const PROCESS_LIB = ${JSON.stringify(PROCESS_LIB)};
	const LIST_MODELS = ${JSON.stringify(FAKE_LIST_MODELS)};
	const DEBUG_DEFAULT_MODELS = ${JSON.stringify(FAKE_DEBUG_DEFAULT_MODELS)};
	const DEBUG_SOL_MODELS = ${JSON.stringify(FAKE_DEBUG_SOL_MODELS)};
	const NO_CATALOG_BEHAVIORS = new Set(["no-catalog", "no-model-list", "unknown-model"]);
	const DEBUG_SOL_BEHAVIORS = new Set(["list-fails-debug-sols", "no-default-mark", "model-list-hangs", "catalog-initialize-hangs"]);
	const interruptibleTurns = new Map();
	// Behaviors whose turns stay active for 5 s, so they can be interrupted or steered.
	const SLOW_TURN_BEHAVIORS = new Set(["interruptible-slow-task", "steer-rejected", "steer-no-item", "steer-turn-ended", "steer-foreign-client-id"]);

	function loadState() {
	  if (!fs.existsSync(STATE_PATH)) {
	    return { nextThreadId: 1, nextTurnId: 1, appServerStarts: 0, threads: [], capabilities: null, lastInterrupt: null };
	  }
	  // Parallel jobs can run several fake app servers on one state file.
	  for (let attempt = 0; ; attempt += 1) {
	    try {
	      return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
	    } catch (error) {
	      if (attempt >= 20) {
	        throw error;
	      }
	      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
	    }
	  }
	}

const LOCK_PATH = STATE_PATH + ".lock";
let lockDepth = 0;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// Serialises state access between fake app servers that share one state file. The lock is
// re-entrant within a process, and a lock left by a process that no longer runs is taken over.
function withStateLock(fn) {
  if (lockDepth > 0) {
    lockDepth += 1;
    try {
      return fn();
    } finally {
      lockDepth -= 1;
    }
  }
  // A loaded machine can slow a live holder, so a waiter gives up only after 10 s.
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" });
      break;
    } catch (error) {
      // On Windows a lock file that its holder is removing refuses the open with EPERM, EBUSY or
      // EACCES for a moment; that is a held lock, not a failure.
      const BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);
      if (error.code !== "EEXIST" && !BUSY.has(error.code)) {
        throw error;
      }
      let holder = NaN;
      try {
        holder = Number.parseInt(fs.readFileSync(LOCK_PATH, "utf8"), 10);
      } catch (readError) {
        if (readError.code === "ENOENT") {
          continue;
        }
        if (!BUSY.has(readError.code)) {
          throw readError;
        }
      }
      if (Number.isInteger(holder) && holder > 0 && !processAlive(holder)) {
        fs.rmSync(LOCK_PATH, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("fake codex state lock is held by process " + holder);
      }
      sleepSync(20);
    }
  }
  lockDepth = 1;
  try {
    return fn();
  } finally {
    lockDepth = 0;
    fs.rmSync(LOCK_PATH, { force: true });
  }
}

function saveState(state) {
  withStateLock(() => writeState(state));
}

// Adds this process's own identity, once read, to processIdentities.
function recordOwnIdentity(key) {
  if (!RECORD_IDENTITIES) {
    return;
  }
  import(PROCESS_LIB)
    .then((lib) => lib.readProcessIdentity(process.pid, { deadline: performance.now() + 30000 }))
    .then((identity) => {
      if (identity.state !== "present") {
        return;
      }
      withStateLock(() => {
        const identityState = loadState();
        identityState.processIdentities = [...(identityState.processIdentities || []), { pid: process.pid, startToken: identity.startToken, key }];
        saveState(identityState);
      });
    })
    .catch(() => {});
}

function writeState(state) {
  const tempFile = STATE_PATH + "." + process.pid + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify(state, null, 2));
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(tempFile, STATE_PATH);
      return;
    } catch (error) {
      if (attempt >= 50) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function requiresExperimental(field, message, state) {
  if (!(field in (message.params || {}))) {
    return false;
  }
  return !state.capabilities || state.capabilities.experimentalApi !== true;
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function buildThread(thread) {
  return {
    id: thread.id,
    preview: thread.preview || "",
    ephemeral: Boolean(thread.ephemeral),
    modelProvider: "openai",
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: { type: "idle" },
    path: null,
    cwd: thread.cwd,
    cliVersion: "fake-codex",
    source: "appServer",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: thread.name || null,
    turns: []
  };
}

function buildTurn(id, status = "inProgress", error = null) {
  return { id, status, items: [], error };
}

function buildAccountReadResult() {
  switch (BEHAVIOR) {
    case "logged-out":
    case "refreshable-auth":
    case "auth-run-fails":
      return { account: null, requiresOpenaiAuth: true };
    case "provider-no-auth":
    case "env-key-provider":
      return { account: null, requiresOpenaiAuth: false };
    case "api-key-account-only":
      return { account: { type: "apiKey" }, requiresOpenaiAuth: true };
    default:
      return {
        account: { type: "chatgpt", email: "test@example.com", planType: "plus" },
        requiresOpenaiAuth: true
      };
  }
}

function buildConfigReadResult() {
  switch (BEHAVIOR) {
    case "provider-no-auth":
      return {
        config: { model_provider: "ollama" },
        origins: {}
      };
    case "env-key-provider":
      return {
        config: {
          model_provider: "openai-custom",
          model_providers: {
            "openai-custom": {
              name: "OpenAI custom",
              env_key: "OPENAI_API_KEY",
              requires_openai_auth: false
            }
          }
        },
        origins: {}
      };
    default:
      return {
        config: { model_provider: "openai" },
        origins: {}
      };
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

// The model and effort a thread/start or thread/resume response reports.
function reportedSelection(params) {
  if (BEHAVIOR === "reports-other-model") {
    return { model: "m-reported", reasoningEffort: "high" };
  }
  const model = params.model || "m-configured";
  if (BEHAVIOR === "partial-report") {
    return { model, reasoningEffort: null };
  }
  return { model, reasoningEffort: (params.config && params.config.model_reasoning_effort) || null };
}

function nextThread(state, cwd, ephemeral) {
  const thread = {
    id: "thr_" + state.nextThreadId++,
    cwd: cwd || process.cwd(),
    name: null,
    preview: "",
    ephemeral: Boolean(ephemeral),
    createdAt: now(),
    updatedAt: now()
  };
  state.threads.unshift(thread);
  saveState(state);
  return thread;
}

function ensureThread(state, threadId) {
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (!thread) {
    throw new Error("unknown thread " + threadId);
  }
  return thread;
}

function nextTurnId(state) {
  const turnId = "turn_" + state.nextTurnId++;
  saveState(state);
  return turnId;
}

// Codex records Windows source paths in extended-length form.
const LONG_PATH_PREFIX = String.fromCharCode(92, 92, 63, 92);

function ledgerSourcePath(sourcePath) {
  return process.platform === "win32" ? LONG_PATH_PREFIX + sourcePath : sourcePath;
}

function importLedgerPath() {
  const codexHome = process.env.CODEX_HOME || path.join(process.env.HOME || process.env.USERPROFILE || os.tmpdir(), ".codex");
  return path.join(codexHome, "external_agent_session_imports.json");
}

function loadImportLedger() {
  const ledgerPath = importLedgerPath();
  return fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : { records: [] };
}

function saveImportLedger(ledger) {
  const ledgerPath = importLedgerPath();
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

// "hold-import": writes import-held beside the state file, then waits up to 30 s for
// import-release there before the import reads the staged file.
function holdImportUntilReleased() {
  const dir = path.dirname(STATE_PATH);
  fs.writeFileSync(path.join(dir, "import-held"), String(process.pid));
  const deadline = Date.now() + 30000;
  while (!fs.existsSync(path.join(dir, "import-release")) && Date.now() < deadline) {
    sleepSync(25);
  }
}

// Writes the rollout file of an imported thread under CODEX_HOME/sessions: a session_meta line,
// then one response_item message line per visible message. Returns its path.
function writeImportRollout(threadId, messages) {
  const sessionsDir = path.join(path.dirname(importLedgerPath()), "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const rolloutPath = path.join(sessionsDir, "rollout-" + threadId + ".jsonl");
  const timestamp = new Date().toISOString();
  const lines = [{ timestamp, type: "session_meta", payload: { id: threadId } }].concat(
    messages.map((entry) => ({
      timestamp,
      type: "response_item",
      payload: {
        type: "message",
        role: entry.role,
        content: [{ type: entry.role === "user" ? "input_text" : "output_text", text: entry.text }]
      }
    }))
  );
  fs.writeFileSync(rolloutPath, lines.map((line) => JSON.stringify(line)).join("\\n") + "\\n");
  return rolloutPath;
}

// The importer skips lines that are not JSON.
function parseImportLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// The text an import keeps from a record: string content, or the text blocks of array content;
// tool_use, tool_result and thinking blocks are left out.
function visibleImportText(entry) {
  const content = entry.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.filter((block) => block && block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\\n");
}

function emitTurnCompleted(threadId, turnId, item) {
  const items = Array.isArray(item) ? item : [item];
  send({ method: "turn/started", params: { threadId, turn: buildTurn(turnId) } });
  for (const entry of items) {
    if (entry && entry.started) {
      send({ method: "item/started", params: { threadId, turnId, item: entry.started } });
    }
    if (entry && entry.completed) {
      send({ method: "item/completed", params: { threadId, turnId, item: entry.completed } });
    }
  }
  send({ method: "turn/completed", params: { threadId, turn: buildTurn(turnId, "completed") } });
}

function emitTurnCompletedLater(threadId, turnId, item, delayMs) {
  setTimeout(() => {
    emitTurnCompleted(threadId, turnId, item);
  }, delayMs);
}

function nativeReviewText(target) {
  if (target.type === "baseBranch") {
    return "Reviewed changes against " + target.branch + ".\\nNo material issues found.";
  }
  if (target.type === "custom") {
    return "Reviewed custom target.\\nNo material issues found.";
  }
  return "Reviewed uncommitted changes.\\nNo material issues found.";
}

// A project review prompt gets one finding without a location.
function structuredReviewPayload(prompt) {
  const target = prompt.includes("This is a project review") ? "project" : "changes";
  if (target === "project" && BEHAVIOR !== "invalid-json") {
    return JSON.stringify({
      verdict: "needs-attention",
      summary: "One project-wide concern surfaced.",
      target,
      findings: [
        {
          severity: "medium",
          title: "No usage instructions",
          body: "No file explains how to run the project.",
          file: null,
          line_start: null,
          line_end: null,
          confidence: 0.6,
          recommendation: "Add a README that explains how to run the project."
        }
      ],
      next_steps: []
    });
  }

  if (prompt.includes("critical software review")) {
    if (BEHAVIOR === "adversarial-clean") {
      return JSON.stringify({
        verdict: "approve",
        summary: "No material issues found.",
        target,
        findings: [],
        next_steps: []
      });
    }

    return JSON.stringify({
      verdict: "needs-attention",
      summary: "One adversarial concern surfaced.",
      target,
      findings: [
        {
          severity: "high",
          title: "Missing empty-state guard",
          body: "The change assumes data is always present.",
          file: "src/app.js",
          line_start: 4,
          line_end: 6,
          confidence: 0.87,
          recommendation: "Handle empty collections before indexing."
        }
      ],
      next_steps: ["Add an empty-state test."]
    });
  }

  if (BEHAVIOR === "invalid-json") {
    return "not valid json";
  }

  return JSON.stringify({
    verdict: "approve",
    summary: "No material issues found.",
    target,
    findings: [],
    next_steps: []
  });
}

function taskPayload(prompt, resume) {
  if (prompt.includes("<task>") && prompt.includes("Only review the work from the previous Claude turn.")) {
    if (BEHAVIOR === "adversarial-clean") {
      return JSON.stringify({ verdict: "allow", reason: "No blocking issues found in the previous turn." });
    }
    if (BEHAVIOR === "gate-prose-block") {
      return JSON.stringify({ verdict: "allow", reason: "BLOCK: appears only in this reason text." });
    }
    return JSON.stringify({ verdict: "block", reason: "Missing empty-state guard in src/app.js:4-6." });
  }

  if (resume || prompt.includes("Continue from the current thread state") || prompt.includes("follow up")) {
    return "Resumed the prior run.\\nFollow-up prompt accepted.";
  }

  return "Handled the requested task.\\nTask prompt accepted.";
}

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli 0.169.0");
  process.exit(0);
}
if (args[0] === "app-server" && args[1] === "--help") {
  console.log("fake app-server help");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  if (BEHAVIOR === "logged-out" || BEHAVIOR === "refreshable-auth" || BEHAVIOR === "auth-run-fails" || BEHAVIOR === "provider-no-auth" || BEHAVIOR === "env-key-provider" || BEHAVIOR === "api-key-account-only") {
    console.error("not authenticated");
    process.exit(1);
  }
  console.log("logged in");
  process.exit(0);
}
if (args[0] === "login") {
  process.exit(0);
}
if (args[0] === "debug" && args[1] === "models") {
  if (BEHAVIOR === "debug-models-hangs") {
    withStateLock(() => {
      const hangState = loadState();
      hangState.debugModelsPids = [...(hangState.debugModelsPids || []), process.pid];
      saveState(hangState);
    });
    recordOwnIdentity("debugModelsPids");
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 60000);
    return;
  }
  if (BEHAVIOR === "debug-models-floods") {
    withStateLock(() => {
      const floodState = loadState();
      floodState.debugModelsPids = [...(floodState.debugModelsPids || []), process.pid];
      saveState(floodState);
    });
    recordOwnIdentity("debugModelsPids");
    const block = "x".repeat(1024 * 1024);
    let written = 0;
    const pump = () => {
      if (written >= 16) {
        setInterval(() => {}, 60000);
        return;
      }
      written += 1;
      process.stdout.write(block, pump);
    };
    pump();
    return;
  }
  if (NO_CATALOG_BEHAVIORS.has(BEHAVIOR)) {
    console.error("debug models is not available");
    process.exit(1);
  }
  console.log(JSON.stringify({ models: DEBUG_SOL_BEHAVIORS.has(BEHAVIOR) ? DEBUG_SOL_MODELS : DEBUG_DEFAULT_MODELS }));
  process.exit(0);
}
if (args[0] !== "app-server") {
  process.exit(1);
}
let bootIndex = 0;
withStateLock(() => {
  const bootState = loadState();
  bootState.appServerStarts = (bootState.appServerStarts || 0) + 1;
  bootState.appServerPids = [...(bootState.appServerPids || []), process.pid];
  bootIndex = bootState.appServerStarts;
  saveState(bootState);
});
recordOwnIdentity("appServerPids");
// The catalog app server of catalog-initialize-hangs stays alive until it is killed.
const initializeHangs = BEHAVIOR === "catalog-initialize-hangs" && bootIndex === 1;
if (initializeHangs) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 60000);
}
// initialize-hangs: no app server answers initialize, and each runs until it is stopped.
if (BEHAVIOR === "initialize-hangs") {
  setInterval(() => {}, 60000);
}

// ignore-eof and interrupt-ignored-eof: the app server keeps running after its input ends, until
// it is stopped. interrupt-ignored-eof also starts a sleeping child and records its identity.
if (BEHAVIOR === "ignore-eof" || BEHAVIOR === "interrupt-ignored-eof") {
  setInterval(() => {}, 60000);
}
if (BEHAVIOR === "interrupt-ignored-eof") {
  const sleeper = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
  withStateLock(() => {
    const childState = loadState();
    childState.childPids = [...(childState.childPids || []), sleeper.pid];
    saveState(childState);
  });
  import(PROCESS_LIB)
    .then((lib) => lib.readProcessIdentity(sleeper.pid, { deadline: performance.now() + 30000 }))
    .then((identity) => {
      if (identity.state !== "present") {
        return;
      }
      withStateLock(() => {
        const identityState = loadState();
        identityState.processIdentities = [...(identityState.processIdentities || []), { pid: sleeper.pid, startToken: identity.startToken, key: "childPids" }];
        saveState(identityState);
      });
    })
    .catch(() => {});
}

const rl = readline.createInterface({ input: process.stdin });
// The time the app server's input ended, for tests of how it is ended and stopped.
rl.on("close", () => {
  withStateLock(() => {
    const closeState = loadState();
    closeState.stdinEndedAt = Date.now();
    saveState(closeState);
  });
});
rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  let message = null;
  try {
    message = JSON.parse(line);
  } catch (error) {
    send({ id: null, error: { code: -32700, message: "Parse error: " + error.message } });
    return;
  }

  try {
    withStateLock(() => handleMessage(message));
  } catch (error) {
    send({ id: message.id, error: { code: -32000, message: error.message } });
  }
});

function handleMessage(message) {
  const state = loadState();
    switch (message.method) {
      case "initialize":
        if (initializeHangs || BEHAVIOR === "initialize-hangs") {
          break;
        }
        if (BEHAVIOR === "initialize-fails") {
          send({ id: message.id, error: { code: -32000, message: "initialize failed" } });
          break;
        }
        state.capabilities = message.params.capabilities || null;
        saveState(state);
        send({ id: message.id, result: { userAgent: USER_AGENT } });
        break;

      case "initialized":
        break;

      case "account/read":
        send({ id: message.id, result: buildAccountReadResult() });
        break;

      case "config/read":
        if (BEHAVIOR === "config-read-fails") {
          throw new Error("config/read failed for cwd");
        }
        send({ id: message.id, result: buildConfigReadResult() });
        break;

      case "thread/start": {
        if (BEHAVIOR === "auth-run-fails") {
          throw new Error("authentication expired; run codex login");
        }
        if (requiresExperimental("persistExtendedHistory", message, state) || requiresExperimental("persistFullHistory", message, state)) {
          throw new Error("thread/start.persistFullHistory requires experimentalApi capability");
        }
        state.lastThreadStart = message.params;
        const thread = nextThread(state, message.params.cwd, message.params.ephemeral);
        send({ id: message.id, result: { thread: buildThread(thread), ...reportedSelection(message.params), modelProvider: "openai", serviceTier: null, cwd: thread.cwd, approvalPolicy: "never", sandbox: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false } } });
        send({ method: "thread/started", params: { thread: { id: thread.id } } });
        break;
      }

      case "model/list": {
        if (NO_CATALOG_BEHAVIORS.has(BEHAVIOR)) {
          throw new Error("unknown method model/list");
        }
        if (BEHAVIOR === "list-fails-debug-sols") {
          throw new Error("model/list failed");
        }
        state.modelListPages = (state.modelListPages || 0) + 1;
        saveState(state);
        if (BEHAVIOR === "model-list-hangs") {
          break;
        }
        const data = JSON.parse(JSON.stringify(LIST_MODELS));
        if (BEHAVIOR === "no-default-mark") {
          for (const entry of data) {
            entry.isDefault = false;
          }
        }
        if (BEHAVIOR === "model-list-not-array") {
          // A schema violation: the effort list is an object, not an array.
          data[0].supportedReasoningEfforts = { low: true };
        }
        // model-list-repeat-cursor always names the same next page; model-list-endless-cursor
        // names a new one on every page.
        const nextCursor =
          BEHAVIOR === "model-list-repeat-cursor"
            ? "cursor-repeat"
            : BEHAVIOR === "model-list-endless-cursor"
              ? "cursor-" + state.modelListPages
              : null;
        send({ id: message.id, result: { data, nextCursor } });
        break;
      }

      case "thread/unsubscribe": {
        state.unsubscribedThreads = [...(state.unsubscribedThreads ?? []), message.params.threadId];
        saveState(state);
        send({ id: message.id, result: {} });
        break;
      }

      case "thread/name/set": {
        const thread = ensureThread(state, message.params.threadId);
        thread.name = message.params.name;
        thread.updatedAt = now();
        saveState(state);
        send({ id: message.id, result: {} });
        break;
      }

      case "thread/list": {
        let threads = state.threads.slice();
        if (message.params.cwd) {
          threads = threads.filter((thread) => thread.cwd === message.params.cwd);
        }
        if (message.params.searchTerm) {
          threads = threads.filter((thread) => (thread.name || "").includes(message.params.searchTerm));
        }
        threads.sort((left, right) => right.updatedAt - left.updatedAt);
        send({ id: message.id, result: { data: threads.map(buildThread), nextCursor: null } });
        break;
      }

      case "thread/resume": {
        if (requiresExperimental("persistExtendedHistory", message, state) || requiresExperimental("persistFullHistory", message, state)) {
          throw new Error("thread/resume.persistFullHistory requires experimentalApi capability");
        }
        state.lastThreadResume = message.params;
        const thread = ensureThread(state, message.params.threadId);
        // A resumed thread runs its next turns in the directory the resume names.
        if (message.params.cwd) {
          thread.cwd = message.params.cwd;
        }
        thread.updatedAt = now();
        saveState(state);
        // turn-in-progress and turn-in-progress-stuck resume a thread whose turn turn-prev still runs.
        const resumedThread = BEHAVIOR.startsWith("turn-in-progress")
          ? { ...buildThread(thread), turns: [{ id: "turn-prev", status: "inProgress", items: [], error: null }] }
          : buildThread(thread);
        send({ id: message.id, result: { thread: resumedThread, ...reportedSelection(message.params), modelProvider: "openai", serviceTier: null, cwd: thread.cwd, approvalPolicy: "never", sandbox: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false } } });
        break;
      }

      // thread/read answers for threads this fake imported or started, with the rollout file
      // of an imported thread as its path, and fails for any other id.
      case "thread/read": {
        state.threadReads = [...(state.threadReads || []), message.params.threadId];
        const thread = ensureThread(state, message.params.threadId);
        saveState(state);
        send({ id: message.id, result: { thread: { ...buildThread(thread), path: thread.rolloutPath || null } } });
        break;
      }

      // thread/inject_items records each call with its items, whether thread/resume loaded the
      // thread first, and whether the file a pointer names existed; it appends the items to the
      // thread's rollout file. "inject-fail" answers with an error.
      case "thread/inject_items": {
        if (BEHAVIOR === "inject-fail") {
          send({ id: message.id, error: { code: -32000, message: "thread/inject_items failed for this thread" } });
          break;
        }
        const thread = ensureThread(state, message.params.threadId);
        const items = message.params.items || [];
        const text = items.flatMap((item) => item.content || []).map((part) => part.text || "").join("\\n");
        const named = /is in (.+?)\\. Read it before acting/.exec(text);
        state.injections = [...(state.injections || []), {
          threadId: thread.id,
          items,
          resumedFirst: Boolean(state.lastThreadResume && state.lastThreadResume.threadId === thread.id),
          namedPath: named ? named[1] : null,
          namedPathExisted: named ? fs.existsSync(named[1]) : null
        }];
        if (thread.rolloutPath) {
          fs.appendFileSync(thread.rolloutPath, items.map((item) => JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload: item })).join("\\n") + "\\n");
        }
        saveState(state);
        send({ id: message.id, result: {} });
        break;
      }

      case "externalAgentConfig/import": {
        if (BEHAVIOR === "external-import-unsupported") {
          send({ id: message.id, error: { code: -32601, message: "Unsupported method: externalAgentConfig/import" } });
          break;
        }
        if (BEHAVIOR === "external-import-fails") {
          send({ id: message.id, result: {} });
          send({ method: "externalAgentConfig/import/completed", params: {} });
          break;
        }
        const sessions = (message.params.migrationItems || [])
          .flatMap((item) => item.details && Array.isArray(item.details.sessions) ? item.details.sessions : []);
        const session = sessions[0];
        if (!session) {
          throw new Error("missing external session migration");
        }
        if (BEHAVIOR === "hold-import") {
          holdImportUntilReleased();
        }
        const sourcePath = fs.realpathSync(session.path);
        state.nextImportId = (state.nextImportId || 0) + 1;
        const importId = "import_" + state.nextImportId;
        if (BEHAVIOR === "external-import-ledger-only" || BEHAVIOR === "external-import-stale-ledger") {
          const stale = BEHAVIOR === "external-import-stale-ledger";
          const ledgerThread = nextThread(state, session.cwd, false);
          const staleLedger = loadImportLedger();
          staleLedger.records.push({
            source_path: process.platform === "win32" ? ledgerSourcePath(sourcePath).toUpperCase() : sourcePath,
            content_sha256: "0".repeat(64),
            imported_thread_id: ledgerThread.id,
            imported_at: stale ? now() - 3600 : now(),
            source_modified_at: null
          });
          saveState(state);
          saveImportLedger(staleLedger);
          send({ id: message.id, result: { importId } });
          send({
            method: "externalAgentConfig/import/completed",
            params: {
              importId,
              itemTypeResults: [
                {
                  itemType: "SESSIONS",
                  successes: [],
                  failures: stale
                    ? [{ itemType: "SESSIONS", failureStage: "session_missing", message: "external agent session was not detected for import: " + sourcePath }]
                    : []
                }
              ]
            }
          });
          break;
        }
        const contents = fs.readFileSync(sourcePath, "utf8");
        const contentSha256 = crypto.createHash("sha256").update(contents).digest("hex");
        // Every import records the size, hash and line count of the file it received.
        state.imports = [...(state.imports || []), { sourcePath, bytes: Buffer.byteLength(contents), sha256: contentSha256, lines: contents.split("\\n").filter(Boolean).length }];
        const ledger = loadImportLedger();
        let record = ledger.records.find(
          (candidate) => candidate.source_path === ledgerSourcePath(sourcePath) && candidate.content_sha256 === contentSha256
        );
        let thread;
        if (record) {
          thread = ensureThread(state, record.imported_thread_id);
        } else {
          const records = contents.split(/\\r?\\n/).filter(Boolean).map(parseImportLine).filter(Boolean);
          const title = records.find((entry) => entry.type === "custom-title")?.customTitle || null;
          const messages = records
            .filter((entry) => (entry.type === "user" || entry.type === "assistant") && !entry.isMeta && !entry.isSidechain)
            .map((entry) => ({ role: entry.type, text: visibleImportText(entry) }))
            .filter((entry) => entry.text !== "");
          thread = nextThread(state, session.cwd, false);
          thread.name = title;
          thread.preview = messages.find((entry) => entry.role === "user")?.text || "";
          thread.visibleMessages = messages;
          thread.rolloutPath = writeImportRollout(thread.id, messages);
          state.lastExternalAgentImport = { sourcePath, threadId: thread.id, messages };
          record = {
            source_path: ledgerSourcePath(sourcePath),
            content_sha256: contentSha256,
            imported_thread_id: thread.id,
            imported_at: now(),
            source_modified_at: null
          };
          ledger.records.push(record);
          saveImportLedger(ledger);
        }
        saveState(state);
        send({ id: message.id, result: { importId } });
        send({
          method: "externalAgentConfig/import/completed",
          params: {
            importId,
            itemTypeResults: [
              {
                itemType: "SESSIONS",
                successes: [{ itemType: "SESSIONS", cwd: session.cwd, source: ledgerSourcePath(sourcePath), target: thread.id, title: thread.name }],
                failures: []
              }
            ]
          }
        });
        break;
      }

      case "account/rateLimits/read": {
        if (BEHAVIOR === "rate-limits-fail") {
          send({ id: message.id, error: { code: -32603, message: "failed to fetch codex rate limits: not signed in" } });
          break;
        }
        const codexLimits = {
          limitId: "codex",
          limitName: null,
          primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1790990000 },
          secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1791500000 },
          credits: { hasCredits: true, unlimited: false, balance: "12.50" },
          planType: "plus",
          rateLimitReachedType: null
        };
        send({
          id: message.id,
          result: {
            rateLimits: codexLimits,
            rateLimitsByLimitId: {
              codex: codexLimits,
              "codex-spark": {
                limitId: "codex-spark",
                limitName: "GPT-5.3-Codex-Spark",
                primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: 1790990000 },
                secondary: null,
                credits: null,
                planType: "plus",
                rateLimitReachedType: null
              }
            }
          }
        });
        break;
      }

      case "review/start": {
        state.lastReviewStart = message.params;
        saveState(state);
        const thread = ensureThread(state, message.params.threadId);
        let reviewThread = thread;
        if (message.params.delivery === "detached") {
          reviewThread = nextThread(state, thread.cwd, true);
          send({ method: "thread/started", params: { thread: { id: reviewThread.id } } });
        }
        const turnId = nextTurnId(state);
        send({ id: message.id, result: { turn: buildTurn(turnId), reviewThreadId: reviewThread.id } });
        emitTurnCompleted(reviewThread.id, turnId, [
          {
            started: { type: "enteredReviewMode", id: turnId, review: "current changes" }
          },
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Reviewed the changed files and checked the likely regression paths." }],
                    content: []
                  }
                }
              ]
            : []),
          {
            completed: { type: "exitedReviewMode", id: turnId, review: nativeReviewText(message.params.target) }
          }
        ]);
        break;
      }

	      case "turn/start": {
	        const thread = ensureThread(state, message.params.threadId);
	        const prompt = (message.params.input || [])
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\\n");
        const turnId = nextTurnId(state);
        thread.updatedAt = now();
        if (BEHAVIOR === "edit-file") {
          fs.writeFileSync(path.join(thread.cwd, "codex-edit.txt"), "edited by fake codex\\n");
        }
	        state.lastTurnStart = {
	          threadId: message.params.threadId,
	          turnId,
	          model: message.params.model ?? null,
	          effort: message.params.effort ?? null,
	          prompt,
	          outputSchema: message.params.outputSchema ?? null,
	          clientUserMessageId: message.params.clientUserMessageId ?? null
	        };
	        state.turnStarts = [...(state.turnStarts || []), { pid: process.pid, prompt, clientUserMessageId: message.params.clientUserMessageId ?? null }];
	        // The thread history keeps each turn's user messages under their client ids.
	        state.history = state.history || {};
	        state.history[thread.id] = [...(state.history[thread.id] || []), { id: turnId, clientIds: message.params.clientUserMessageId ? [message.params.clientUserMessageId] : [] }];
	        saveState(state);
	        if (BEHAVIOR === "close-stdin-on-turn") {
	          // Leaves turn/start unanswered and stops reading, so the client's next write finds no reader.
	          // process.stdin.destroy() leaves descriptor 0 open, so it is closed explicitly as well.
	          rl.close();
	          process.stdin.destroy();
	          try {
	            fs.closeSync(0);
	          } catch {}
	          send({ method: "fake/stdinClosed", params: { threadId: thread.id, turnId } });
	          setTimeout(() => process.exit(1), 3000);
	          break;
	        }
	        send({ id: message.id, result: { turn: buildTurn(turnId) } });
	        // history-pages reports no user message for a request, so only the thread history can
	        // show that a message arrived; a receipt could reach the client before it stops.
	        if (message.params.clientUserMessageId && BEHAVIOR !== "history-pages") {
	          // The request's user message carries its client id, as Codex reports it.
	          const userItem = { type: "userMessage", id: "user_" + turnId, clientId: message.params.clientUserMessageId, content: message.params.input || [] };
	          send({ method: "item/started", params: { threadId: thread.id, turnId, item: userItem } });
	        }
	        if (BEHAVIOR === "unknown-model" && message.params.model) {
	          // As Codex 0.169.0 does: the thread exists, and its first turn fails on the model.
	          const error = {
	            message: "The '" + message.params.model + "' model is not supported when using Codex with a ChatGPT account.",
	            codexErrorInfo: "modelNotFound",
	            additionalDetails: null
	          };
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          send({ method: "error", params: { error, willRetry: false, threadId: thread.id, turnId } });
	          send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "failed", error) } });
	          break;
	        }
	        if (BEHAVIOR === "exit-mid-turn") {
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          // Exits once stdout has flushed, so the client sees the response and the notification first.
	          process.stdout.write("", () => process.exit(1));
	          break;
	        }

        const isGateReview = prompt.includes("Only review the work from the previous Claude turn.");
        const basePayload = !isGateReview && message.params.outputSchema && message.params.outputSchema.properties && message.params.outputSchema.properties.verdict
          ? structuredReviewPayload(prompt)
          : taskPayload(prompt, thread.name && thread.name.startsWith("Codex Companion Task") && prompt.includes("Continue from the current thread state"));
        // Answers for the question and size tests of the job store's worker.
        const ANSWERS = {
          "question-line": "Some work is done." + String.fromCharCode(10) + "AGENT-QUESTION: Which file should change?",
          "structured-question": JSON.stringify({ result: "half done", question: "Keep the old API?" }),
          "structured-empty-question": JSON.stringify({ result: "all done", question: "" }),
          "huge-answer": "x".repeat(1048576 + 4096),
          "huge-json": JSON.stringify({ result: "y".repeat(1048576 + 4096) })
        };
        const payload = Object.prototype.hasOwnProperty.call(ANSWERS, BEHAVIOR) ? ANSWERS[BEHAVIOR] : basePayload;

        if (
          BEHAVIOR === "with-subagent" ||
          BEHAVIOR === "with-late-subagent-message" ||
          BEHAVIOR === "with-subagent-no-main-turn-completed"
        ) {
          const subThread = nextThread(state, thread.cwd, true);
          const subThreadRecord = ensureThread(state, subThread.id);
          subThreadRecord.name = "design-challenger";
          saveState(state);
          const subTurnId = nextTurnId(state);

          send({ method: "thread/started", params: { thread: { ...buildThread(subThreadRecord), name: "design-challenger", agentNickname: "design-challenger" } } });
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({
            method: "item/started",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "collabAgentToolCall",
                id: "collab_" + turnId,
                tool: "wait",
                status: "inProgress",
                senderThreadId: thread.id,
                receiverThreadIds: [subThread.id],
                prompt: "Challenge the implementation approach",
                model: null,
                reasoningEffort: null,
                agentsStates: {
                  [subThread.id]: { status: "inProgress", message: "Investigating design tradeoffs" }
                }
              }
            }
          });
          if (BEHAVIOR === "with-late-subagent-message") {
            send({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId,
                item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }
            });
          }
          send({ method: "turn/started", params: { threadId: subThread.id, turn: buildTurn(subTurnId) } });
          send({
            method: "item/completed",
            params: {
              threadId: subThread.id,
              turnId: subTurnId,
              item: {
                type: "reasoning",
                id: "reasoning_" + subTurnId,
                summary: [{ text: "Questioned the retry strategy and the cache invalidation boundaries." }],
                content: []
              }
            }
          });
          send({
            method: "item/completed",
            params: {
              threadId: subThread.id,
              turnId: subTurnId,
              item: {
                type: "agentMessage",
                id: "msg_" + subTurnId,
                text: "The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees.",
                phase: "analysis"
              }
            }
          });
          send({ method: "turn/completed", params: { threadId: subThread.id, turn: buildTurn(subTurnId, "completed") } });
          send({
            method: "item/completed",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "collabAgentToolCall",
                id: "collab_" + turnId,
                tool: "wait",
                status: "completed",
                senderThreadId: thread.id,
                receiverThreadIds: [subThread.id],
                prompt: "Challenge the implementation approach",
                model: null,
                reasoningEffort: null,
                agentsStates: {
                  [subThread.id]: { status: "completed", message: "Finished" }
                }
              }
            }
          });
          if (BEHAVIOR !== "with-late-subagent-message") {
            send({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId,
                item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }
            });
          }
          if (BEHAVIOR !== "with-subagent-no-main-turn-completed") {
            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
          }
          break;
        }

        const items = [
          ...(BEHAVIOR === "three-messages"
            ? [
                { completed: { type: "agentMessage", id: "msg_a_" + turnId, text: "First progress note.", phase: "commentary" } },
                { completed: { type: "agentMessage", id: "msg_b_" + turnId, text: "Second progress note.", phase: "commentary" } }
              ]
            : []),
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Inspected the prompt, gathered evidence, and checked the highest-risk paths first." }],
                    content: []
                  }
              }
            ]
            : []),
          {
            completed: {
              type: "agentMessage",
              id: "msg_" + turnId,
              text: payload,
              phase: "final_answer"
            }
          }
        ];

	        if (BEHAVIOR === "foreign-thread-start") {
	          // Another session's thread starts and answers while this turn runs.
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          send({ method: "thread/started", params: { thread: { id: "thr_foreign", name: "other-session" } } });
	          send({ method: "turn/started", params: { threadId: "thr_foreign", turn: buildTurn("turn_foreign") } });
	          send({
	            method: "item/completed",
	            params: { threadId: "thr_foreign", turnId: "turn_foreign", item: { type: "agentMessage", id: "msg_foreign", text: "Answer from another session.", phase: "final_answer" } }
	          });
	        }
	        if (BEHAVIOR === "stall-after-message") {
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          send({
	            method: "item/completed",
	            params: { threadId: thread.id, turnId, item: { type: "agentMessage", id: "msg_" + turnId, text: "Partial answer before the stall.", phase: "commentary" } }
	          });
	          break;
	        }
	        if (BEHAVIOR === "interrupt-ignored" || BEHAVIOR === "interrupt-ignored-eof") {
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          break;
	        }
	        if (SLOW_TURN_BEHAVIORS.has(BEHAVIOR)) {
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          const timer = setTimeout(() => {
	            if (!interruptibleTurns.has(turnId)) {
	              return;
	            }
	            interruptibleTurns.delete(turnId);
	            for (const entry of items) {
	              if (entry && entry.completed) {
	                send({ method: "item/completed", params: { threadId: thread.id, turnId, item: entry.completed } });
	              }
	            }
	            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
	          }, 5000);
	          interruptibleTurns.set(turnId, { threadId: thread.id, timer });
	        } else if (BEHAVIOR === "slow-task") {
	          emitTurnCompletedLater(thread.id, turnId, items, 400);
	        } else {
	          emitTurnCompleted(thread.id, turnId, items);
	        }
	        break;
	      }

	      case "turn/steer": {
	        const params = message.params || {};
	        state.steerAttempts = (state.steerAttempts || 0) + 1;
	        const active = interruptibleTurns.get(params.expectedTurnId);
	        if (BEHAVIOR === "steer-turn-ended") {
	          saveState(state);
	          send({ id: message.id, error: { code: -32600, message: "no active turn to steer" } });
	          break;
	        }
	        if (BEHAVIOR === "steer-rejected" || !active || active.threadId !== params.threadId) {
	          saveState(state);
	          send({ id: message.id, error: { code: -32600, message: "expected active turn id " + params.expectedTurnId + " does not match the active turn" } });
	          break;
	        }
	        const text = (params.input || []).map((part) => part.text || "").join("");
	        state.steers = [...(state.steers || []), { threadId: params.threadId, expectedTurnId: params.expectedTurnId, clientUserMessageId: params.clientUserMessageId, text }];
	        const steeredTurn = ((state.history || {})[params.threadId] || []).find((entry) => entry.id === params.expectedTurnId);
	        if (steeredTurn && params.clientUserMessageId) {
	          steeredTurn.clientIds.push(params.clientUserMessageId);
	        }
	        saveState(state);
	        send({ id: message.id, result: { turnId: params.expectedTurnId } });
	        if (BEHAVIOR !== "steer-no-item") {
	          // steer-foreign-client-id answers with the same text under another client's id.
	          const clientId = BEHAVIOR === "steer-foreign-client-id" ? "other-client" : params.clientUserMessageId || null;
	          const item = { type: "userMessage", id: "user_" + state.steerAttempts, clientId, content: params.input || [] };
	          setTimeout(() => {
	            send({ method: "item/started", params: { threadId: params.threadId, turnId: params.expectedTurnId, item } });
	            send({ method: "item/completed", params: { threadId: params.threadId, turnId: params.expectedTurnId, item } });
	          }, 300);
	        }
	        break;
	      }

	      case "thread/turns/list": {
	        // history-pages returns one turn per page, so a client id can sit on a later page.
	        const entries = ((state.history || {})[message.params.threadId] || []);
	        const size = BEHAVIOR === "history-pages" ? 1 : Math.max(1, Number(message.params.limit) || 50);
	        const start = Number(message.params.cursor || 0);
	        const page = entries.slice(start, start + size).map((entry) => ({
	          id: entry.id,
	          status: "completed",
	          items: entry.clientIds.map((clientId) => ({ type: "userMessage", id: "user_" + clientId, clientId, content: [] }))
	        }));
	        state.historyPagesServed = (state.historyPagesServed || 0) + 1;
	        saveState(state);
	        send({ id: message.id, result: { data: page, nextCursor: start + size < entries.length ? String(start + size) : null } });
	        break;
	      }

	      case "turn/interrupt": {
	        state.lastInterrupt = {
	          threadId: message.params.threadId,
	          turnId: message.params.turnId
	        };
	        saveState(state);
	        // interrupt-unanswered: turn/interrupt is recorded and never answered.
	        if (BEHAVIOR === "interrupt-unanswered") {
	          break;
	        }
	        const pending = interruptibleTurns.get(message.params.turnId);
	        if (message.params.turnId === "turn-prev" && BEHAVIOR === "turn-in-progress") {
	          // The previous turn ends on its interrupt; under turn-in-progress-stuck it never ends.
	          send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: buildTurn("turn-prev", "interrupted") } });
	        }
	        if (pending) {
	          clearTimeout(pending.timer);
	          interruptibleTurns.delete(message.params.turnId);
	          send({
	            method: "turn/completed",
	            params: {
	              threadId: pending.threadId,
	              turn: buildTurn(message.params.turnId, "interrupted")
	            }
	          });
	        }
	        send({ id: message.id, result: {} });
	        break;
	      }

	      default:
	        send({ id: message.id, error: { code: -32601, message: "Unsupported method: " + message.method } });
        break;
    }
}
`;
  writeExecutable(scriptPath, source);

  // On Windows, npm global binaries are .cmd wrappers. A codex.cmd makes the fake
  // binary resolvable through PATHEXT, the same way as an npm-installed Codex.
  if (process.platform === "win32") {
    const cmdWrapper = `@echo off\r\nnode "%~dp0codex" %*\r\n`;
    fs.writeFileSync(path.join(binDir, "codex.cmd"), cmdWrapper, { encoding: "utf8" });
  }
}

export function buildEnv(binDir) {
  const sep = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH}`
  };
}
