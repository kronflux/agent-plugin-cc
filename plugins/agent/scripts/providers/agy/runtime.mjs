import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { binaryAvailable, runCommand } from "../../lib/process.mjs";

// agy's background updater starts `agy --version` with a visible console window, so every agy
// process the plugin starts runs with the updater off, unless the user set the variable. agy
// then updates only when it is run directly.
const AUTO_UPDATE_ENV = "AGY_CLI_DISABLE_AUTO_UPDATE";

/** `env` with agy's background updater turned off, unless the variable is already set. */
export function agyEnv(env = process.env) {
  return env[AUTO_UPDATE_ENV] === undefined ? { ...env, [AUTO_UPDATE_ENV]: "1" } : env;
}

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
// The effort words agy documents. Model ids are split and efforts accepted with these as well as
// the words `agy --help` prints, so an id such as `<base>-xhigh` parses when the help cannot be
// read; with a model list, a composed id must still be listed.
const DOCUMENTED_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** The documented effort words followed by any other word in `efforts`, each once. */
export function agyEffortWords(efforts) {
  return [...new Set([...DOCUMENTED_EFFORTS, ...(efforts ?? [])])];
}

/**
 * Returns the reasoning efforts the installed agy accepts, read from the --effort line of
 * `agy --help`, for example "(low|medium|high|xhigh|max)". The list differs between agy
 * versions; when it cannot be read, the efforts every known version accepts are returned.
 */
export function readAgyEfforts(cwd) {
  const result = runCommand("agy", ["--help"], { cwd, env: agyEnv(), timeout: 30000 });
  const match = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.match(/--effort[^\n]*\(([a-z|]+)\)/);
  return match ? match[1].split("|").filter(Boolean) : FALLBACK_EFFORTS;
}

export function getAgyAvailability(cwd) {
  return binaryAvailable("agy", ["--version"], { cwd, env: agyEnv() });
}

export function ensureAgyAvailable(cwd) {
  const availability = getAgyAvailability(cwd);
  if (!availability.available) {
    throw new Error("The agy CLI is not installed or not on PATH. Install Antigravity, then rerun `/agent:agy-setup`.");
  }
}

function normalizeEffort(effort, efforts, cwd) {
  if (effort == null || !String(effort).trim()) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  const supported = agyEffortWords(Array.isArray(efforts) ? efforts : readAgyEfforts(cwd));
  if (!supported.includes(normalized)) {
    throw new Error(`agy does not support reasoning effort "${effort}". Use one of: ${supported.join(", ")}.`);
  }
  return normalized;
}

// The ids of a model list whose entries are ids or `{ id }` objects.
function modelIds(models) {
  return (models ?? []).map((entry) => (typeof entry === "string" ? entry : entry?.id)).filter(Boolean);
}

/**
 * The efforts that exist for the base name `base`: each effort word `e` of `efforts` for which
 * the model list `models` holds the id `<base>-<e>`, in the order of `efforts`.
 */
export function agyModelEfforts(base, models, efforts) {
  const ids = new Set(modelIds(models));
  return agyEffortWords(efforts).filter((effort) => ids.has(`${base}-${effort}`));
}

/**
 * Splits a model id into `{ base, effort }` when it ends in `-<effort>` for one of agy's effort
 * words: with an available list only for a listed id, without one for any id. Only the last word
 * is split, so a base that itself ends in an effort word stays whole. Returns null otherwise.
 */
export function splitAgyModel(model, { models = [], efforts = [], catalogStatus = "available" } = {}) {
  const id = String(model ?? "");
  if (catalogStatus === "available" && !modelIds(models).includes(id)) {
    return null;
  }
  const effort = agyEffortWords(efforts).find((word) => id.length > word.length + 1 && id.endsWith(`-${word}`));
  return effort ? { base: id.slice(0, -(effort.length + 1)), effort } : null;
}

const FORMS = (base) => `Use --model ${base}-<effort> or --model ${base} --effort <effort>`;

/**
 * Resolves an Antigravity model named as a full id (`<base>-<effort>`) or as a base name plus an
 * effort into the id agy runs, which carries the effort; agy is never given `--effort`.
 *
 * `models` is the list `agy models` printed, `efforts` agy's effort words, and `catalogStatus`
 * `available`, `unavailable` (the list could not be read) or `empty` (it listed nothing). An
 * effort given both in the id and as `effort`, or in neither for a base name, is an error. Without
 * a list, a full id and a base name with an effort run unchecked with a warning.
 *
 * Returns `{ model, effort, warning? }` (effort is the id's effort word, or null for a model
 * without efforts), or `{ error }`.
 */
export function resolveAgyModel({ model, effort = null, models = [], efforts = [], catalogStatus = "available" }) {
  const id = String(model).trim();
  const given = effort == null || !String(effort).trim() ? null : String(effort).trim().toLowerCase();
  const split = splitAgyModel(id, { models, efforts, catalogStatus });
  if (split && given) {
    return {
      error: `Antigravity model ${id} already includes effort ${split.effort}. Use either --model ${id}, or --model ${split.base} --effort <effort>.`
    };
  }
  if (catalogStatus !== "available") {
    const warning = (name) => `The Antigravity model list is unavailable, so "${name}" was not checked.`;
    if (split) {
      return { model: id, effort: split.effort, warning: warning(id) };
    }
    if (!given) {
      return { error: `Antigravity model ${id} needs an effort. ${FORMS(id)}; ${id} has: unknown, because the Antigravity model list is unavailable.` };
    }
    if (!agyEffortWords(efforts).includes(given)) {
      return { error: `agy does not support reasoning effort "${effort}". Use one of: ${agyEffortWords(efforts).join(", ")}.` };
    }
    return { model: `${id}-${given}`, effort: given, warning: warning(`${id}-${given}`) };
  }
  if (split) {
    return { model: id, effort: split.effort };
  }
  const ids = modelIds(models);
  const variants = agyModelEfforts(id, models, efforts);
  if (variants.length > 0) {
    if (!given) {
      return { error: `Antigravity model ${id} needs an effort. ${FORMS(id)}; ${id} has: ${variants.join(", ")}.` };
    }
    if (!variants.includes(given)) {
      return { error: `Antigravity model ${id} has no effort ${given}. ${FORMS(id)}; ${id} has: ${variants.join(", ")}.` };
    }
    return { model: `${id}-${given}`, effort: given };
  }
  if (ids.includes(id)) {
    if (given) {
      return { error: `Antigravity model ${id} has no efforts, so --effort ${given} cannot be used with it. Use --model ${id} alone.` };
    }
    return { model: id, effort: null };
  }
  return { error: `Model "${id}" is not in the Antigravity model list. Available: ${ids.join(", ")}.` };
}

/**
 * The model one agy turn runs with for a stored request `{ model, effort }`. agy is never given
 * `--effort`, but a request written before model ids carried their effort may hold a model
 * without an effort word beside a separate effort. Such a pair runs as `<model>-<effort>` when
 * the model list holds that id, or unchecked, with a warning, when the list cannot be read; when
 * the list lacks it, the model runs alone and a warning says the effort was not used. A recorded
 * effort without a model is not used, with a warning. `readLists()` returns what
 * `readCatalogLists` returns; it is called only when the model has no effort word.
 * Returns `{ model, warning }`, warning null when there is nothing to say.
 */
export function agyTurnModel({ model = null, effort = null } = {}, { readLists }) {
  if (!effort) {
    return { model: model ?? null, warning: null };
  }
  if (!model) {
    return { model: null, warning: `The recorded Antigravity effort ${effort} was not used, because the job names no model.` };
  }
  if (splitAgyModel(model, { efforts: [], catalogStatus: "unavailable" })) {
    return { model, warning: null };
  }
  const lists = readLists();
  if (splitAgyModel(model, lists)) {
    return { model, warning: null };
  }
  const composed = `${model}-${effort}`;
  if (lists.catalogStatus !== "available") {
    return { model: composed, warning: `The Antigravity model list is unavailable, so "${composed}" was not checked.` };
  }
  if (lists.models.includes(composed)) {
    return { model: composed, warning: null };
  }
  return { model, warning: `The recorded Antigravity effort ${effort} was not used, because agy does not list model ${composed}.` };
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

// The model list and effort words of one resolution, read once per resolution.
export function readCatalogLists(cwd, cache = {}) {
  if (!cache.agyLists) {
    const listed = readAgyModels(cwd);
    const catalogStatus = listed.ok ? "available" : listed.failed ? "unavailable" : "empty";
    cache.agyLists = { models: listed.models.map((entry) => entry.id), efforts: readAgyEfforts(cwd), catalogStatus };
  }
  return cache.agyLists;
}

// The model catalog of the Antigravity provider. A model is named by its full id, which carries
// the effort (`<base>-<effort>`), or by its base name plus an effort; `finishSelection` joins the
// two through `resolveAgyModel`, checks them against `agy models`, and agy is never given
// `--effort`. Without a requested model, agy uses its own saved default.
// Efforts are checked against the list `agy --help` prints.
export const agyModelCatalog = Object.freeze({
  async resolveExplicit(value) {
    const model = value == null || !String(value).trim() ? null : String(value).trim();
    return { model, defaultEffort: null, efforts: null };
  },

  async resolveDefault() {
    return { model: null, source: "provider-default", defaultEffort: null, efforts: null, warning: null, savedModel: readAgySavedModel() };
  },

  checkEffort(effort, efforts, { cwd } = {}) {
    return normalizeEffort(effort, efforts, cwd);
  },

  /**
   * Joins the model and effort of a resolved selection into the id agy runs. An effort from the
   * command goes to `resolveAgyModel`, which refuses it beside an id that has one. An effort from
   * a setting or a continued job joins a base name, and beneath a full id it is not used: a
   * setting's effort with a warning, a continued job's with a warning when it differs. The
   * selection reports the full id and its effort word; with no model no effort is used.
   */
  async finishSelection(selection, { cwd, cache, effortOrigin, modelOrigin }) {
    const warnings = [...selection.warnings];
    if (!selection.model) {
      if (selection.effort && effortOrigin === "command") {
        throw new Error(
          `Antigravity needs a model for --effort ${selection.effort}. Use --model <base> --effort ${selection.effort} or --model <base>-${selection.effort}.`
        );
      }
      if (selection.effort && effortOrigin === "setting") {
        warnings.push(`The stored Antigravity effort ${selection.effort} is ignored because no model is stored; run setup again with --model.`);
      }
      return { ...selection, effort: null, effortSource: "provider-default", warnings };
    }
    const lists = readCatalogLists(cwd, cache);
    let effort = effortOrigin === "command" ? selection.effort : null;
    if (!effort && selection.effort && (effortOrigin === "setting" || effortOrigin === "inherited")) {
      const split = splitAgyModel(selection.model, lists);
      if (!split) {
        effort = selection.effort;
      } else if (effortOrigin === "setting") {
        const again = modelOrigin === "setting" ? "; run setup again" : "";
        warnings.push(`The stored Antigravity effort is ignored because model ${selection.model} includes one${again}.`);
      } else if (split.effort !== selection.effort) {
        warnings.push(`Effort ${selection.effort} of the continued job does not apply to model ${selection.model}, so it was not used.`);
      }
    }
    const resolved = resolveAgyModel({ model: selection.model, effort, ...lists });
    if (resolved.error) {
      throw new Error(resolved.error);
    }
    if (resolved.warning) {
      warnings.push(resolved.warning);
    }
    const effortSource = !resolved.effort ? "provider-default" : effort ? selection.effortSource : selection.modelSource;
    return { ...selection, model: resolved.model, effort: resolved.effort, effortSource, warnings };
  }
});

/** Lists the models agy offers; agy has no login-status command, so this doubles as the login check. */
export function readAgyModels(cwd) {
  const result = runCommand("agy", ["models"], { cwd, env: agyEnv(), timeout: 60000 });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || "").trim();
    return { ok: false, failed: true, models: [], detail: detail || `agy models exited with ${result.status}.` };
  }
  const models = String(result.stdout)
    .split(/\r?\n/)
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length >= 2 && parts[0].trim())
    .map(([id, label]) => ({ id: id.trim(), label: label.trim() }));
  return { ok: models.length > 0, models, detail: models.length > 0 ? `${models.length} models available` : "agy listed no models." };
}

// Session-only settings files, passed with --settings; they leave agy's own settings files
// untouched. In print mode agy cannot ask for a permission, so it denies every tool call that
// needs one: a turn gets exactly the permissions its file grants. The read-only file denies the
// file-writing and command tools and allows reading files and URLs; the write file allows every
// tool, so a write-capable job can edit files and run commands.
export const AGY_READ_ONLY_SETTINGS = fileURLToPath(new URL("./read-only-settings.json", import.meta.url));
export const AGY_WRITE_SETTINGS = fileURLToPath(new URL("./write-settings.json", import.meta.url));

// Read-only turns run in the terminal sandbox with the read-only settings. Write-capable turns
// get the write settings; workspace-write also keeps agy's terminal sandbox, where the host has one.
function sandboxArgs(sandboxMode) {
  if (sandboxMode === "danger-full-access") {
    return ["--settings", AGY_WRITE_SETTINGS];
  }
  if (sandboxMode === "workspace-write") {
    return ["--sandbox", "--settings", AGY_WRITE_SETTINGS];
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
export function buildAgyArgs({ conversationId = null, model = null, sandboxMode = "read-only", jsonSchema = null, timeoutMs, addDirs = [] }) {
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
 * tool call that ran: one the stream shows as done, one that failed for a reason other than a
 * refused permission, and one that never reported its end; each with its name and path (null
 * when it carries none).
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
  // Tool steps that started and have not ended, by tool name.
  const openTools = new Map();
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
      openTools.set(event.name, Math.max(0, (openTools.get(event.name) ?? 0) - 1));
    } else if (event.type === "tool" && event.state === "ERROR") {
      openTools.set(event.name, Math.max(0, (openTools.get(event.name) ?? 0) - 1));
      // A refused tool never ran. A tool that failed for another reason may have written first.
      if (!(event.error?.type === "TOOL_ERROR" && /permission/i.test(String(event.error?.message ?? "")))) {
        toolEvents.push({ name: event.name, path: event.path });
      }
    } else if (event.type === "tool") {
      openTools.set(event.name, (openTools.get(event.name) ?? 0) + 1);
    } else if (event.type === "result" && !result) {
      result = event;
      conversationId = event.conversationId ?? conversationId;
    }
  }
  // A tool that started and never reported its end counts as run: it may have written.
  for (const [name, open] of openTools) {
    if (open > 0) {
      toolEvents.push({ name, path: null });
    }
  }
  const text = lastMessage || (result ? result.response.trim() : "");
  const json = result?.structuredOutput ?? null;
  const deniedActions = result?.deniedActions?.length ? result.deniedActions : toolDenials.map(({ action, displayName, path: deniedPath }) => ({ action, displayName, path: deniedPath }));
  const outcome = { status: "failed", text, json, error: null, conversationId, turns: result?.turns ?? null, processTurns, deniedActions, toolEvents };
  if (exit.error) {
    return { ...outcome, error: String(exit.error) };
  }
  // In a read-only turn a refused write or command is the read-only rule at work: the turn still
  // counts when it ends with an answer. A write-capable turn that was refused could not do its work.
  const answered = result && isSuccess(result) && (result.response.trim() || json != null);
  if (deniedActions.length > 0 && !(exit.readOnly && answered)) {
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
 * answer even without prose; (3) with the read-only guard on, a write tool in the stream fails the turn, and so does a
 * changed file when the turn ran any tool other than a reading tool; (4) otherwise the turn completed.
 */
export function classifyAgyTurn(turn, { schemaGiven = false, guard = "off", changedPaths = [], writeToolNames = [], readToolNames = [] } = {}) {
  if (turn.status !== "answer") {
    return { outcome: "failed", error: turn.error ?? NO_ANSWER_MESSAGE };
  }
  if (schemaGiven && !(turn.json && typeof turn.json === "object" && !Array.isArray(turn.json))) {
    return { outcome: "failed", error: NO_STRUCTURED_OUTPUT_MESSAGE };
  }
  if (guard === "on") {
    const tools = turn.toolEvents ?? [];
    const written = tools.filter((event) => writeToolNames.includes(event.name)).map((event) => event.path ?? event.name);
    // A changed file counts against the turn only when the turn ran a tool that can change one.
    // With reading tools alone, another program changed the working tree while the turn ran.
    const couldWrite = tools.some((event) => !readToolNames.includes(event.name));
    const edited = changedPaths.length > 0 && couldWrite ? changedPaths : written;
    if (edited.length > 0) {
      return { outcome: "failed", error: `Antigravity edited files during a read-only task: ${[...new Set(edited)].join(", ")}` };
    }
  }
  return { outcome: "completed", error: null };
}
