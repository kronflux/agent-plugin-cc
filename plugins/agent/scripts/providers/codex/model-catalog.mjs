// Everything the plugin asks Codex about models: the app server's model list, the catalog
// `codex debug models` prints, family words, the fallback family, and the effort checks. A model
// is resolved and checked before a job or a thread exists, so a bad choice fails with a clear
// message instead of partway through a turn.

import { spawn } from "node:child_process";
import process from "node:process";

import { resolveCommand, terminateProcessTree } from "../../lib/process.mjs";
import { SpawnedCodexAppServerClient } from "./app-server.mjs";

// The efforts Codex knows; an effort is checked against this list only when no catalog can be read.
export const KNOWN_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

// Shown when no catalog names a model, so no model is sent and Codex picks one.
export const CODEX_CHOSE_MODEL_WARNING = "Codex chose the model; a model set in the Codex configuration applies.";

// The most model list pages read; a server that keeps naming new pages is not followed further.
const MAX_MODEL_LIST_PAGES = 50;

// Reads every page of the model list. Paging stops at a cursor already seen and after
// MAX_MODEL_LIST_PAGES pages. A page without a data array adds no models.
async function listModels(client) {
  const models = [];
  const seenCursors = new Set();
  let cursor = null;
  for (let pages = 0; pages < MAX_MODEL_LIST_PAGES; pages += 1) {
    const page = await client.request("model/list", cursor ? { cursor } : {});
    models.push(...(Array.isArray(page?.data) ? page.data : []));
    cursor = page?.nextCursor ?? null;
    if (!cursor || seenCursors.has(cursor)) {
      break;
    }
    seenCursors.add(cursor);
  }
  return models;
}

// A model whose effort list is not an array lists no efforts, so its effort check is skipped.
function supportedEfforts(model) {
  const efforts = model?.supportedReasoningEfforts;
  return (Array.isArray(efforts) ? efforts : [])
    .map((entry) => (typeof entry === "string" ? entry : entry?.reasoningEffort))
    .filter(Boolean);
}

// How long one catalog read (a model/list call or a `codex debug models` run) may take.
export const CATALOG_TIMEOUT_MS = 10000;

/**
 * @typedef {{ id: string, hidden: boolean, isDefault: boolean, efforts: string[],
 *   defaultEffort: string|null, priority: number|null, visibility: string|null }} CatalogModel
 */

/** @returns {CatalogModel|null} */
function fromModelList(entry) {
  const id = entry?.id ?? entry?.model;
  if (typeof id !== "string" || !id) {
    return null;
  }
  return {
    id,
    hidden: entry.hidden === true,
    isDefault: entry.isDefault === true,
    efforts: supportedEfforts(entry),
    defaultEffort: typeof entry.defaultReasoningEffort === "string" ? entry.defaultReasoningEffort : null,
    priority: null,
    visibility: null
  };
}

/** @returns {CatalogModel|null} */
function fromDebugModels(entry) {
  const id = entry?.slug;
  if (typeof id !== "string" || !id) {
    return null;
  }
  const levels = Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : [];
  return {
    id,
    hidden: entry.visibility !== "list",
    isDefault: false,
    efforts: levels.map((level) => (typeof level === "string" ? level : level?.effort)).filter(Boolean),
    defaultEffort: typeof entry.default_reasoning_level === "string" ? entry.default_reasoning_level : null,
    priority: Number.isFinite(entry.priority) ? entry.priority : null,
    visibility: typeof entry.visibility === "string" ? entry.visibility : null
  };
}

function rejectAfter(promise, timeoutMs, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Reads every page of the app server's model list as CatalogModel entries. Rejects when the
 * list has not been read within `timeoutMs`.
 * @returns {Promise<CatalogModel[]>}
 */
export async function listCatalogModels(client, { timeoutMs = CATALOG_TIMEOUT_MS } = {}) {
  const models = await rejectAfter(
    listModels(client),
    timeoutMs,
    `The Codex model list did not answer within ${Math.round(timeoutMs / 1000)} s.`
  );
  return models.map(fromModelList).filter(Boolean);
}

// How long a `codex debug models` run that was stopped after its timeout may take to exit before
// the read gives up on it.
const DEBUG_STOP_GRACE_MS = 1000;

// The most output bytes, stdout and stderr together, a `codex debug models` read collects; a run
// that prints more is stopped and the catalog is unavailable.
export const DEBUG_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

// Stops a timed-out `codex debug models` run by its own process id. On Windows the whole tree is
// stopped, because when codex is a batch file the direct child is cmd.exe. On POSIX the process
// gets SIGTERM, or SIGKILL when `kill` is true.
function stopDebugModels(child, kill = false) {
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    if (process.platform === "win32") {
      if (!kill) {
        terminateProcessTree(child.pid);
      }
    } else {
      child.kill(kill ? "SIGKILL" : "SIGTERM");
    }
  } catch {
    // A process that cannot be stopped is left; the read gives up on it after the grace.
  }
}

function parseDebugModels(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, models: [], detail: "codex debug models printed output that is not JSON." };
  }
  const models = (Array.isArray(parsed?.models) ? parsed.models : []).map(fromDebugModels).filter(Boolean);
  return models.length > 0
    ? { ok: true, models, detail: `${models.length} models` }
    : { ok: false, models: [], detail: "codex debug models listed no models." };
}

/**
 * Reads the catalog `codex debug models` prints, `{ models: [...] }`. Returns `ok: false` with
 * the reason when the command fails, times out or prints something else. A run still going after
 * `timeoutMs` is stopped by its process id, and the read returns at most DEBUG_STOP_GRACE_MS
 * later, also when the process ignores the stop.
 * @returns {Promise<{ ok: boolean, models: CatalogModel[], detail: string }>}
 */
export function readDebugModels(cwd, { timeoutMs = CATALOG_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve) => {
    const plan = resolveCommand("codex", ["debug", "models"], env);
    const timedOut = `codex debug models did not answer within ${Math.round(timeoutMs / 1000)} s.`;
    let stdout = "";
    let stderr = "";
    let collected = 0;
    let settled = false;
    /** @type {NodeJS.Timeout | null} */
    let graceTimer = null;
    /** @type {import("node:child_process").ChildProcess | null} */
    let child = null;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (graceTimer) {
        clearTimeout(graceTimer);
      }
      resolve(result);
    };
    const failed = (detail) => ({ ok: false, models: [], detail: `codex debug models failed: ${detail}` });
    const timer = setTimeout(() => {
      stopDebugModels(child);
      graceTimer = setTimeout(() => {
        stopDebugModels(child, true);
        // Output pipes that a process which ignored the stop keeps open must not keep this
        // process alive.
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        child?.unref();
        finish({ ok: false, models: [], detail: timedOut });
      }, DEBUG_STOP_GRACE_MS);
    }, timeoutMs);
    try {
      child = spawn(plan.file, plan.args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], ...plan.options, windowsHide: true });
    } catch (error) {
      finish(failed(error instanceof Error ? error.message : String(error)));
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const collect = (chunk, append) => {
      if (settled) {
        return;
      }
      collected += Buffer.byteLength(chunk);
      if (collected > DEBUG_OUTPUT_LIMIT_BYTES) {
        stopDebugModels(child);
        stopDebugModels(child, true);
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        finish(failed(`it printed more than ${DEBUG_OUTPUT_LIMIT_BYTES} bytes.`));
        return;
      }
      append(chunk);
    };
    child.stdout?.on("data", (chunk) => collect(chunk, (text) => (stdout += text)));
    child.stderr?.on("data", (chunk) => collect(chunk, (text) => (stderr += text)));
    child.on("error", (error) => finish(failed(error.message)));
    child.on("close", (code, signal) => {
      if (graceTimer) {
        finish({ ok: false, models: [], detail: timedOut });
      } else if (code !== 0) {
        finish(failed(stderr.trim() || (signal ? `signal ${signal}` : `exit ${code}`)));
      } else {
        finish(parseDebugModels(stdout));
      }
    });
  });
}

// The one model family the plugin names: when Codex marks no default model, the newest visible
// model of this family is used.
const FALLBACK_FAMILY = "sol";

function versionOf(id) {
  const match = String(id).match(/(\d+(?:\.\d+)*)/);
  return match ? match[1].split(".").map(Number) : [];
}

function compareVersions(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

/**
 * Picks the visible fallback-family entry with the highest version number in its id, compared
 * numerically by dotted parts, so 6.1 is newer than 6 and 5.6.
 * @param {CatalogModel[]} models
 * @returns {CatalogModel|null}
 */
export function pickNewestSol(models) {
  const candidates = (models ?? []).filter(
    (model) => model.visibility === "list" && model.id.endsWith(`-${FALLBACK_FAMILY}`)
  );
  let newest = null;
  for (const model of candidates) {
    if (!newest || compareVersions(versionOf(model.id), versionOf(newest.id)) > 0) {
      newest = model;
    }
  }
  return newest;
}

/**
 * Resolves a family word to the entry whose id ends in `-<word>`: from `debugModels`, the visible
 * entry with the lowest priority number. Only when `debugModels` is null, because
 * `codex debug models` could not be read, it comes from `listModels`: the visible default entry
 * when it matches, else the first visible match in list order.
 * @returns {CatalogModel|null}
 */
export function resolveFamily(word, { debugModels = null, listModels: listed = null } = {}) {
  const suffix = `-${String(word).trim().toLowerCase()}`;
  if (debugModels) {
    const fromDebug = debugModels
      .filter((model) => model.visibility === "list" && model.id.endsWith(suffix))
      .sort((left, right) => (left.priority ?? Infinity) - (right.priority ?? Infinity));
    return fromDebug[0] ?? null;
  }
  const fromList = (listed ?? []).filter((model) => !model.hidden && model.id.endsWith(suffix));
  return fromList.find((model) => model.isDefault) ?? fromList[0] ?? null;
}

// Reads the app server's model list once per resolution, with one time limit for starting the
// app server, its initialize handshake and reading every page. A failure or a timeout leaves the
// list unavailable. The app server is closed in every case, including one that never answered
// initialize; close() stops it by its process id when it does not exit on its own.
async function readListOnce(cwd, timeoutMs = CATALOG_TIMEOUT_MS) {
  const client = new SpawnedCodexAppServerClient(cwd);
  const reading = (async () => {
    await client.initialize();
    return listCatalogModels(client, { timeoutMs });
  })();
  reading.catch(() => {});
  try {
    const models = await rejectAfter(reading, timeoutMs, `The Codex model list did not answer within ${Math.round(timeoutMs / 1000)} s.`);
    return { ok: models.length > 0, models };
  } catch (error) {
    return { ok: false, models: [], detail: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.close().catch(() => {});
  }
}

// The catalog reads of one resolution are kept on its context, so each runs at most once.
function catalogReads(context = {}) {
  const cache = (context.cache ??= {});
  return {
    list: () => (cache.codexList ??= readListOnce(context.cwd)),
    debug: () => (cache.codexDebug ??= readDebugModels(context.cwd))
  };
}

function choiceFrom(entry) {
  return { model: entry.id, efforts: entry.efforts, defaultEffort: entry.defaultEffort };
}

async function visibleIds(reads) {
  const list = await reads.list();
  const source = list.ok ? list.models : (await reads.debug()).models;
  return source.filter((model) => !model.hidden).map((model) => model.id);
}

// The efforts any visible model supports, for a choice that names no model; null when no
// catalog can be read.
async function visibleEfforts(reads) {
  const list = await reads.list();
  const debug = list.ok ? null : await reads.debug();
  const models = list.ok ? list.models : debug.ok ? debug.models : null;
  if (!models) {
    return null;
  }
  const efforts = new Set(models.filter((model) => !model.hidden).flatMap((model) => model.efforts));
  return efforts.size > 0 ? [...efforts] : null;
}

function checkKnownEffort(effort, original) {
  if (!KNOWN_REASONING_EFFORTS.includes(effort)) {
    throw new Error(`Unsupported reasoning effort "${original}". Use one of: ${KNOWN_REASONING_EFFORTS.join(", ")}.`);
  }
  return effort;
}

// The model catalog of the Codex provider.
export const codexModelCatalog = Object.freeze({
  /**
   * Resolves a --model value: an exact id of the model list or of `codex debug models`, then a
   * family word. Throws, naming the visible ids, when a catalog is available and nothing
   * matches; passes the value unchecked, with a warning, when no catalog can be read.
   */
  async resolveExplicit(value, context = {}) {
    const reads = catalogReads(context);
    const list = await reads.list();
    const listed = list.ok ? list.models.find((model) => model.id === value) : null;
    if (listed) {
      return choiceFrom(listed);
    }
    const debug = await reads.debug();
    const debugged = debug.ok ? debug.models.find((model) => model.id === value) : null;
    if (debugged) {
      return choiceFrom(debugged);
    }
    const family = resolveFamily(value, {
      debugModels: debug.ok ? debug.models : null,
      listModels: list.ok ? list.models : null
    });
    if (family) {
      return choiceFrom(family);
    }
    if (!list.ok && !debug.ok) {
      return {
        model: value,
        efforts: null,
        defaultEffort: null,
        warning: `The Codex model catalog is unavailable, so "${value}" was not checked.`
      };
    }
    throw new Error(`Model "${value}" is not in the Codex catalog. Available: ${(await visibleIds(reads)).join(", ")}.`);
  },

  /**
   * The model a job runs on when none is chosen: the visible entry the model list marks as the
   * default, else the newest visible model of the fallback family in `codex debug models`, else
   * no model, with a warning.
   */
  async resolveDefault(context = {}) {
    const reads = catalogReads(context);
    const list = await reads.list();
    const marked = list.ok ? list.models.find((model) => !model.hidden && model.isDefault) : null;
    if (marked) {
      return { ...choiceFrom(marked), source: "catalog-default" };
    }
    const debug = await reads.debug();
    const newest = debug.ok ? pickNewestSol(debug.models) : null;
    if (newest) {
      return { ...choiceFrom(newest), source: "family-fallback" };
    }
    return { model: null, source: "provider-default", efforts: null, defaultEffort: null, warning: CODEX_CHOSE_MODEL_WARNING };
  },

  /**
   * Checks an effort against `efforts`, the efforts of the resolved model. A model that lists no
   * efforts is not checked. With no model entry (`efforts` null) the effort is checked against
   * the efforts of the visible models, and against KNOWN_REASONING_EFFORTS when no catalog can
   * be read. An effort inherited from a continued job is not checked against the visible models
   * when the model has no entry, because they say nothing about that model.
   */
  async checkEffort(effort, efforts, context = {}) {
    if (effort == null || !String(effort).trim()) {
      return null;
    }
    const normalized = String(effort).trim().toLowerCase();
    if (Array.isArray(efforts)) {
      if (efforts.length > 0 && !efforts.includes(normalized)) {
        throw new Error(`Model ${context.model} does not support reasoning effort "${effort}". Use one of: ${efforts.join(", ")}.`);
      }
      return normalized;
    }
    if (context.inherited) {
      return normalized;
    }
    const supported = await visibleEfforts(catalogReads(context));
    if (!supported) {
      return checkKnownEffort(normalized, effort);
    }
    if (!supported.includes(normalized)) {
      throw new Error(`No Codex model supports reasoning effort "${effort}". Use one of: ${supported.join(", ")}.`);
    }
    return normalized;
  }
});

/**
 * Throws when `effort` is not supported by the requested model, or by the default model when
 * none is requested. A model the catalog does not list, such as one from a custom provider, is
 * accepted unchecked. When the model list cannot be read within CATALOG_TIMEOUT_MS, the effort
 * is checked against the efforts Codex knows.
 */
export async function validateModelSelection(client, { model = null, effort = null } = {}) {
  if (!effort) {
    return;
  }
  let models;
  try {
    models = await listCatalogModels(client, { timeoutMs: CATALOG_TIMEOUT_MS });
  } catch {
    models = null;
  }
  if (!models || models.length === 0) {
    checkKnownEffort(effort, effort);
    return;
  }
  const selected = model ? models.find((entry) => entry.id === model) : models.find((entry) => entry.isDefault);
  if (!selected) {
    return;
  }
  if (selected.efforts.length > 0 && !selected.efforts.includes(effort)) {
    throw new Error(`Model ${selected.id} does not support reasoning effort "${effort}". Use one of: ${selected.efforts.join(", ")}.`);
  }
}
