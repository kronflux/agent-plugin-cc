import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { binaryAvailable, runCommand } from "../../lib/process.mjs";

// Antigravity (agy) runs one process per turn in print mode with stream-json input and output:
// the prompt is the one NDJSON line written to stdin, and agy answers with init, step_update and
// one result event. The conversation id from those events continues the conversation in a later
// process with --conversation.

const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SILENCE_MS = 5 * 60 * 1000;

// AGENT_PLUGIN_AGY_SILENCE_MS replaces the five minutes without output after which a turn's agy
// process is stopped.
export function readAgySilenceMs(env = process.env) {
  const raw = String(env.AGENT_PLUGIN_AGY_SILENCE_MS ?? "").trim();
  return /^\d+$/.test(raw) && Number(raw) > 0 ? Math.min(Number(raw), 2 ** 31 - 1) : DEFAULT_SILENCE_MS;
}

/**
 * Calls `onSilent` once when `ms` pass without a call of `touch()`. The caller calls `touch()`
 * for each recognised agy event, so diagnostics, unknown JSON and unterminated output do not
 * restart the wait. The watch ends when the child closes or `stop()` is called.
 */
export function startSilenceWatch(child, ms, onSilent) {
  let timer = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    child.off?.("close", stop);
  };
  const touch = () => {
    if (stopped) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      stop();
      onSilent();
    }, ms);
    timer.unref?.();
  };
  child.on("close", stop);
  touch();
  return { touch, stop };
}

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

export function ensureAgyAvailable(cwd) {
  const availability = getAgyAvailability(cwd);
  if (!availability.available) {
    throw new Error("The agy CLI is not installed or not on PATH. Install Antigravity, then rerun `/agent:agy-setup`.");
  }
}

// agy refuses a model id that ends in an effort level together with a different --effort, so
// the pair is refused before a job starts.
function checkSuffixedModel(model, normalized, original, supported) {
  const suffix = model ? supported.find((level) => String(model).endsWith(`-${level}`)) : undefined;
  if (suffix && suffix !== normalized) {
    throw new Error(
      `Antigravity model ${model} already sets effort ${suffix}; remove --effort ${original} or choose a model without an effort suffix.`
    );
  }
}

function normalizeEffort(effort, efforts, cwd, model = null) {
  if (effort == null || !String(effort).trim()) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  const supported = Array.isArray(efforts) ? efforts : readAgyEfforts(cwd);
  if (!supported.includes(normalized)) {
    throw new Error(`agy does not support reasoning effort "${effort}". Use one of: ${supported.join(", ")}.`);
  }
  checkSuffixedModel(model, normalized, String(effort).trim(), supported);
  return normalized;
}

/**
 * Reads the model agy saved as its default from the Antigravity settings file, as agy names it
 * there (a display name such as "Model Name (Medium)"). Returns null when the file cannot be read
 * or names no model.
 */
export function readAgySavedModel({ settingsPath = path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json") } = {}) {
  try {
    const model = JSON.parse(fs.readFileSync(settingsPath, "utf8"))?.model;
    return typeof model === "string" && model.trim() ? model.trim() : null;
  } catch {
    return null;
  }
}

// The model catalog of the Antigravity provider. A requested model is checked against the list
// `agy models` prints when that list can be read, and passed unchecked with a warning when it
// cannot. Without a requested model, agy uses its own saved default.
// Efforts are checked against the list `agy --help` prints.
export const agyModelCatalog = Object.freeze({
  async resolveExplicit(value, { cwd } = {}) {
    const model = value == null || !String(value).trim() ? null : String(value).trim();
    const listed = model ? readAgyModels(cwd) : { ok: false, models: [] };
    if (listed.ok && !listed.models.some((entry) => entry.id === model)) {
      throw new Error(
        `Model "${model}" is not in the Antigravity model list. Available: ${listed.models.map((entry) => entry.id).join(", ")}.`
      );
    }
    // Without a list the value is passed to agy unchecked, and one warning line says so.
    const warning = model && !listed.ok ? `The Antigravity model list is unavailable, so "${model}" was not checked.` : null;
    return { model, defaultEffort: null, efforts: null, ...(warning ? { warning } : {}) };
  },

  async resolveDefault() {
    return { model: null, source: "provider-default", defaultEffort: null, efforts: null, warning: null, savedModel: readAgySavedModel() };
  },

  checkEffort(effort, efforts, { cwd, model = null } = {}) {
    return normalizeEffort(effort, efforts, cwd, model);
  }
});

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

// A session-only settings file that denies agy's file-writing and command tools. It is passed
// with --settings on every read-only turn and leaves agy's own settings files untouched.
export const AGY_READ_ONLY_SETTINGS = fileURLToPath(new URL("./read-only-settings.json", import.meta.url));

// Read-only turns run in the terminal sandbox with the deny settings; workspace-write keeps the
// terminal sandbox; danger-full-access lifts it.
function sandboxArgs(sandboxMode) {
  if (sandboxMode === "danger-full-access") {
    return [];
  }
  if (sandboxMode === "workspace-write") {
    return ["--sandbox"];
  }
  return ["--sandbox", "--settings", AGY_READ_ONLY_SETTINGS];
}

function realPath(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

function isInside(folder, target) {
  const relative = path.relative(folder, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Returns the folders agy must be given with --add-dir so that it can read `paths` from a turn
 * that runs in `workingFolder`: for each path outside the working folder (compared after
 * resolving links), the path itself when it is a folder, else the folder that contains it.
 * Each folder appears once, in the order of the paths.
 */
export function outsideFolders(workingFolder, paths) {
  const root = realPath(workingFolder);
  const folders = [];
  for (const entry of paths ?? []) {
    const target = realPath(path.resolve(workingFolder, String(entry)));
    if (isInside(root, target)) {
      continue;
    }
    let folder = path.dirname(target);
    try {
      folder = fs.statSync(target).isDirectory() ? target : folder;
    } catch {
      // A path that does not exist is given by its containing folder.
    }
    if (!folders.includes(folder)) {
      folders.push(folder);
    }
  }
  return folders;
}

/** The arguments of one agy turn. The prompt is never among them; it goes to stdin. */
export function buildAgyArgs({ conversationId = null, model = null, effort = null, sandboxMode = "read-only", jsonSchema = null, timeoutMs, addDirs = [] }) {
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
    ...(addDirs ?? []).flatMap((folder) => ["--add-dir", folder]),
    ...(jsonSchema ? ["--json-schema", jsonSchema] : [])
  ];
}

// The fixed lines that end every prompt sent to agy; agy reads them as instructions and does
// not enforce them.
export const AGY_DELEGATE_LINE = "Do this work yourself. Do not start subagents, swarms, workflows or scheduled tasks.";
export const AGY_READ_ONLY_LINE =
  "This is a read-only task. Do not use any tool that creates, edits or deletes a file, anywhere, including plan files, and do not run commands.";

/** The one stream-json stdin line that carries a turn's prompt. */
export function encodeAgyPromptLine(text) {
  return `${JSON.stringify({ event: "user", message: { content: text } })}\n`;
}

const promptedChildren = new WeakSet();

/**
 * Writes the turn's prompt to the agy child's stdin as one line. A process runs exactly one
 * turn, so a second call for the same child throws and writes nothing.
 */
export function writeAgyPrompt(child, text) {
  if (promptedChildren.has(child)) {
    throw new Error("This agy process has already received its prompt.");
  }
  promptedChildren.add(child);
  child.stdin.write(encodeAgyPromptLine(text));
}

function isSuccess(result) {
  return String(result?.status ?? "").toUpperCase() === "SUCCESS";
}

const NO_ANSWER_MESSAGE = "Antigravity ended the turn without an answer.";

// The path a tool step names, as agy records it in the tool's parameters.
function toolPath(toolInfo) {
  const parameters = toolInfo?.parameters ?? {};
  const value = parameters.Path ?? parameters.path ?? null;
  return typeof value === "string" && value.trim() ? value : null;
}

// The permission a refused tool step names: the rule name of a deny-rule block ("Permission
// denied for write_file(...)"), the action of a headless refusal ("permission to run command"),
// else the tool's own name.
function deniedAction(message, toolName) {
  const match =
    /permission denied for ([A-Za-z_]+)\(/i.exec(message) ??
    /permission check failed for ([A-Za-z_]+)/i.exec(message) ??
    /permission to run ([A-Za-z_]+)/i.exec(message);
  return match ? match[1] : toolName;
}

/**
 * Turns one line of agy's stream-json output into the events the plugin reads, or none for a
 * line that is not an agy event. Event types: `init`, `user-input`, `text` (an agent_response
 * delta; `done` marks the step's end), `tool` (any tool step), `denied` (a tool step that agy
 * refused for lack of permission, with the action, the tool's name and the path when the step
 * carries one), `step` (other step types) and `result`.
 */
function parseAgyLine(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }
  switch (event?.event) {
    case "init":
      return [{ type: "init", conversationId: event.conversation_id ?? null }];
    case "step_update": {
      const step = event.step_update ?? {};
      if (step.step_type === "user_input") {
        return step.state === "DONE" ? [{ type: "user-input", stepIndex: step.step_index ?? null }] : [];
      }
      if (step.step_type === "agent_response") {
        return [{ type: "text", delta: typeof step.text_delta === "string" ? step.text_delta : "", done: step.state === "DONE" }];
      }
      if (step.step_type === "tool") {
        const error = step.tool_info?.error ?? null;
        const tool = { type: "tool", state: step.state ?? null, name: step.tool_name ?? step.tool_info?.name ?? null, path: toolPath(step.tool_info), error };
        const message = String(error?.message ?? "");
        if (step.state === "ERROR" && error?.type === "TOOL_ERROR" && /permission/i.test(message)) {
          return [tool, { type: "denied", action: deniedAction(message, tool.name), displayName: tool.name, path: tool.path }];
        }
        return [tool];
      }
      return [{ type: "step", stepType: step.step_type ?? null, state: step.state ?? null }];
    }
    case "result": {
      const result = event.result ?? {};
      const denied = Array.isArray(result.denied_actions) ? result.denied_actions : [];
      return [
        {
          type: "result",
          status: String(result.status ?? ""),
          response: typeof result.response === "string" ? result.response : "",
          structuredOutput: result.structured_output ?? null,
          conversationId: result.conversation_id ?? null,
          turns: Number.isInteger(result.num_turns) ? result.num_turns : null,
          deniedActions: denied.map((entry) => ({ action: entry?.action ?? null, displayName: entry?.display_name ?? null, path: null }))
        }
      ];
    }
    default:
      return [];
  }
}

function deniedMessage({ action, displayName, path: deniedPath }) {
  return `Antigravity was denied permission for ${action ?? "an action"}${displayName ? ` (${displayName})` : ""}${deniedPath ? ` on ${deniedPath}` : ""}.`;
}

/**
 * Decides how one agy turn ended from its events (in order) and the process exit
 * `{ code, signal, error, stderr, conversationId }`, where `error` is a failure the runtime saw
 * itself (a timeout, a failed start) and `conversationId` the id the turn continued. A turn
 * fails when the runtime saw a failure, when agy denied a permission (the result's
 * denied_actions, else refused tool steps), when the result status is not SUCCESS, when the
 * result has an empty response and no structured output, and when the process ended without a
 * result. The answer text is the turn's last agent message, else the result's response.
 * `processTurns` counts the turns this process ran: each run of user_input steps that the stream
 * moves past with another step, so a repeated init or a replayed user_input of an earlier turn
 * adds none. `turns` is the conversation's turn count the result reports. `toolEvents` lists each
 * tool call the stream shows as done, with its name and path (null when it carries none).
 */
export function classifyAgyOutcome(events, exit = {}) {
  let conversationId = exit.conversationId ?? null;
  let pending = "";
  let lastMessage = "";
  let result = null;
  let processTurns = 0;
  let inUserInput = false;
  const toolDenials = [];
  const toolEvents = [];
  for (const event of events) {
    if (event.type === "user-input") {
      inUserInput = true;
    } else if (event.type !== "init" && inUserInput) {
      inUserInput = false;
      processTurns += 1;
    }
    if (event.type === "init" && event.conversationId) {
      conversationId = event.conversationId;
    } else if (event.type === "text" && !result) {
      pending += event.delta;
      if (event.done && pending.trim()) {
        lastMessage = pending.trim();
        pending = "";
      }
    } else if (event.type === "denied") {
      toolDenials.push(event);
    } else if (event.type === "tool" && event.state === "DONE") {
      toolEvents.push({ name: event.name, path: event.path });
    } else if (event.type === "result" && !result) {
      result = event;
      conversationId = event.conversationId ?? conversationId;
    }
  }
  const text = lastMessage || (result ? result.response.trim() : "");
  const json = result?.structuredOutput ?? null;
  const deniedActions = result?.deniedActions?.length ? result.deniedActions : toolDenials.map(({ action, displayName, path: deniedPath }) => ({ action, displayName, path: deniedPath }));
  const outcome = { status: "failed", text, json, error: null, conversationId, turns: result?.turns ?? null, processTurns, deniedActions, toolEvents };
  if (exit.error) {
    return { ...outcome, error: String(exit.error) };
  }
  if (deniedActions.length > 0) {
    return { ...outcome, error: [...new Set(deniedActions.map(deniedMessage))].join(" ") };
  }
  if (!result) {
    if (exit.code === 0 && !exit.signal) {
      return { ...outcome, error: NO_ANSWER_MESSAGE };
    }
    const ending = exit.code == null && exit.signal ? `was ended by ${exit.signal}` : `exited with code ${exit.code}`;
    const stderr = String(exit.stderr ?? "").trim();
    return { ...outcome, error: `agy ${ending} before the turn finished.${stderr ? `\n${stderr}` : ""}` };
  }
  if (!isSuccess(result)) {
    return { ...outcome, error: `agy ended the turn with status ${result.status}.` };
  }
  // The result event carries the answer; text of earlier steps alone, such as an opening
  // sentence, is no answer.
  if (!result.response.trim() && json == null) {
    return { ...outcome, error: NO_ANSWER_MESSAGE };
  }
  return { ...outcome, status: "answer" };
}

/**
 * Collects the events of one agy turn. `push(line)` parses one stdout line and returns its
 * events; `outcome(exit)` classifies the turn with `classifyAgyOutcome`.
 */
export function createAgyEventAdapter() {
  const events = [];
  return {
    push(line) {
      const parsed = parseAgyLine(line);
      events.push(...parsed);
      return parsed;
    },
    outcome(exit) {
      return classifyAgyOutcome(events, exit);
    }
  };
}

/**
 * The model a delegation from `cwd` uses, by agy's display name: a `model` given on the command,
 * else the plugin's model setting, each looked up in `agy models` (id to label; the id stands in
 * when the list cannot be read or lacks it); else the model saved in the Antigravity settings,
 * which is already a display name; else unknown.
 */
export function resolveAgyDelegationModel(cwd, { model = null, setting = null, home = undefined } = {}) {
  const chosen = model ? { id: String(model), source: "explicit" } : setting ? { id: String(setting), source: "setting" } : null;
  if (chosen) {
    const listed = readAgyModels(cwd);
    const label = listed.ok ? listed.models.find((entry) => entry.id === chosen.id)?.label ?? null : null;
    return { id: chosen.id, displayName: label ?? chosen.id, source: chosen.source };
  }
  const saved = readAgySavedModel(home === undefined ? {} : { settingsPath: path.join(home, ".gemini", "antigravity-cli", "settings.json") });
  return saved ? { id: null, displayName: saved, source: "agy-settings" } : { id: null, displayName: null, source: "unknown" };
}

const NO_STRUCTURED_OUTPUT_MESSAGE = "Antigravity returned no structured output.";

/**
 * Decides a finished turn from its adapter outcome, in a fixed order: (1) the failures of
 * classifyAgyOutcome keep their messages (a denial first); (2) with a schema, a turn without a
 * structured object fails, whatever its status and prose say, and a structured object is the
 * answer even without prose; (3) with the read-only guard on, a changed file or a write tool in the
 * stream fails the turn; (4) otherwise the turn completed.
 */
export function classifyAgyTurn(turn, { schemaGiven = false, guard = "off", changedPaths = [], writeToolNames = [] } = {}) {
  if (turn.status !== "answer") {
    return { outcome: "failed", error: turn.error ?? NO_ANSWER_MESSAGE };
  }
  if (schemaGiven && !(turn.json && typeof turn.json === "object" && !Array.isArray(turn.json))) {
    return { outcome: "failed", error: NO_STRUCTURED_OUTPUT_MESSAGE };
  }
  if (guard === "on") {
    const written = (turn.toolEvents ?? []).filter((event) => writeToolNames.includes(event.name)).map((event) => event.path ?? event.name);
    const edited = changedPaths.length > 0 ? changedPaths : written;
    if (edited.length > 0) {
      return { outcome: "failed", error: `Antigravity edited files during a read-only task: ${[...new Set(edited)].join(", ")}` };
    }
  }
  return { outcome: "completed", error: null };
}
