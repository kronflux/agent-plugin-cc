import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { createRequire } from "node:module";

import { getPluginDataDir, PLUGIN_DATA_ENV } from "./host.mjs";
import { redactSecrets } from "./redact.mjs";
import { readLiveSample } from "./live.mjs";
import { confirmIdentity, groupHasMembers, readProcessIdentities, readProcessIdentity, stopTree } from "./process.mjs";
import { StoreError, testDelay, testPoint, wallNow } from "./store.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

// The temp directory is shared by all users on POSIX systems, so the fallback root is per user.
const FALLBACK_STATE_ROOT_DIR = path.join(
  os.tmpdir(),
  typeof process.getuid === "function" ? `agent-plugin-${process.getuid()}` : "agent-plugin"
);
const LEGACY_STATE_FILE_NAME = "state.json";
const CONFIG_FILE_NAME = "config.json";
const JOBS_DIR_NAME = "jobs";
const ACTIVE_STATUSES = new Set(["queued", "running"]);
const REQUEST_FILE_SUFFIX = ".request.json";
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_CONFIG = Object.freeze({ stopReviewGate: false });
// Free-text fields that can repeat a prompt or a credential from tool output.
const REDACTED_FIELDS = ["summary", "errorMessage"];

// On Windows, replacing a file that another process has open fails with EPERM, EACCES, or
// EBUSY until that process closes it, so the rename is retried for a bounded time.
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_RETRY_LIMIT_MS = 1000;

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

// Resolving the workspace root runs git, so names are cached per directory for the life of
// the process.
const stateDirNames = new Map();

function stateDirName(cwd) {
  if (!stateDirNames.has(cwd)) {
    stateDirNames.set(cwd, computeStateDirName(cwd));
  }
  return stateDirNames.get(cwd);
}

function computeStateDirName(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  return `${slug}-${hash}`;
}

/**
 * The one state folder of the workspace that holds `cwd`: `<plugin data>/state/<slug>-<hash>` when
 * the host sets a plugin data folder, else the same name under the per-user temp root. The job
 * store lives in its `store` folder. Only the readers of the old JSON job records also look in the
 * temp root (`candidateStateDirs`).
 */
export function resolveStateDir(cwd) {
  const pluginDataDir = getPluginDataDir();
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, stateDirName(cwd));
}

let unprivateRootWarned = false;

// On POSIX the fallback root sits in the shared temp directory, so it is read only when it is
// missing or is a private folder of the caller; otherwise it is skipped with one warning.
function fallbackRootReadable({ platform = process.platform, lstat = fs.lstatSync, getuid = process.getuid } = {}) {
  if (platform === "win32") {
    return true;
  }
  try {
    assertPrivateStateRoot(FALLBACK_STATE_ROOT_DIR, { lstat, getuid });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return true;
    }
    if (!unprivateRootWarned) {
      unprivateRootWarned = true;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`warning: ${message}; its jobs are not read\n`);
    }
    return false;
  }
}

/**
 * Returns the state folders that reads look in. A process started without a plugin data folder
 * writes under the temp-directory root, so reads also look there. The configured root comes
 * first and wins for a duplicate job id. `deps` replaces the platform and file checks in tests.
 */
export function candidateStateDirs(cwd, deps = {}) {
  const primary = resolveStateDir(cwd);
  const fallback = path.join(FALLBACK_STATE_ROOT_DIR, stateDirName(cwd));
  const dirs = primary === fallback ? [primary] : [primary, fallback];
  return fallbackRootReadable(deps) ? dirs : dirs.filter((dir) => dir !== fallback);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

/**
 * Throws unless `dir` is a real folder, not a symlink, owned by the calling user. The fallback
 * state root sits in the shared temp directory, where another user could have created it first.
 */
export function assertPrivateStateRoot(dir, { lstat = fs.lstatSync, getuid = process.getuid } = {}) {
  const stat = lstat(dir);
  const ownedByCaller = typeof getuid !== "function" || stat.uid === getuid();
  if (stat.isSymbolicLink() || !stat.isDirectory() || !ownedByCaller) {
    throw new Error(`The plugin state folder ${dir} is not a private folder owned by you; set ${PLUGIN_DATA_ENV}.`);
  }
}

function stateRootOf(dir) {
  const roots = [FALLBACK_STATE_ROOT_DIR];
  if (getPluginDataDir()) {
    roots.unshift(path.join(getPluginDataDir(), "state"));
  }
  return roots.find((root) => dir === root || dir.startsWith(`${root}${path.sep}`)) ?? null;
}

// State directories hold prompts and agent output, so on POSIX systems they are readable by
// their owner only, including directories created before this mode was applied. The mode is
// applied to the folder and its parents up to the state root, never above it.
const privateDirs = new Set();

function ensurePrivateDir(dir) {
  if (privateDirs.has(dir)) {
    return;
  }
  const posix = process.platform !== "win32";
  const root = stateRootOf(dir);
  if (posix && root === FALLBACK_STATE_ROOT_DIR) {
    fs.mkdirSync(root, { recursive: true, mode: PRIVATE_DIR_MODE });
    assertPrivateStateRoot(root);
  }
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (posix) {
    fs.chmodSync(dir, PRIVATE_DIR_MODE);
    for (let current = dir; root && current !== root; ) {
      current = path.dirname(current);
      try {
        fs.chmodSync(current, PRIVATE_DIR_MODE);
      } catch {
        // A parent this user cannot change keeps its mode; the folder itself is private.
      }
    }
  }
  privateDirs.add(dir);
}

export function ensureStateDir(cwd) {
  ensurePrivateDir(resolveJobsDir(cwd));
}

function writeJsonAtomic(filePath, value) {
  ensurePrivateDir(path.dirname(filePath));
  const tempFile = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  const deadline = Date.now() + RENAME_RETRY_LIMIT_MS;
  for (let delay = 10; ; delay = Math.min(delay * 2, 100)) {
    try {
      fs.renameSync(tempFile, filePath);
      return;
    } catch (error) {
      if (!RETRYABLE_RENAME_CODES.has(error?.code) || Date.now() >= deadline) {
        fs.rmSync(tempFile, { force: true });
        throw error;
      }
      sleepSync(delay);
    }
  }
}

// Returns null for a missing file. Content that does not parse is read once more before the
// error is raised, which covers files written by a writer that does not replace atomically.
function readJsonFile(filePath) {
  for (let attempt = 0; ; attempt += 1) {
    let text;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      if (attempt >= 1) {
        throw error;
      }
      sleepSync(20);
    }
  }
}

function requestFile(jobFile) {
  return jobFile.replace(/\.json$/, REQUEST_FILE_SUFFIX);
}

// Writes a job record. A `request` field holds the prompt, so it is never kept in the record:
// while the job is active it goes to the job's private request file, and once the job has
// finished that file is deleted. Summaries and error messages are redacted.
function storeRecord(jobFile, record) {
  const { request, ...stored } = record;
  for (const field of REDACTED_FIELDS) {
    if (typeof stored[field] === "string") {
      stored[field] = redactSecrets(stored[field]);
    }
  }
  const active = ACTIVE_STATUSES.has(stored.status);
  if (request !== undefined && active) {
    writeJsonAtomic(requestFile(jobFile), request);
  }
  writeJsonAtomic(jobFile, stored);
  if (!active) {
    fs.rmSync(requestFile(jobFile), { force: true });
  }
  return stored;
}

// Legacy index files that could not be parsed, so each is reported once per process.
const unreadableLegacyFiles = new Set();

// Moves a `state.json` index into per-job files and `config.json`, then renames it to
// `state.json.migrated`. Index fields win over a job file's fields, because the index was
// written after the job file for every update. An index that cannot be parsed is left in place
// with a warning on stderr.
function migrateLegacyState(cwd) {
  for (const stateDir of candidateStateDirs(cwd)) {
    const legacyFile = path.join(stateDir, LEGACY_STATE_FILE_NAME);
    if (!fs.existsSync(legacyFile)) {
      continue;
    }
    let legacy;
    try {
      legacy = readJsonFile(legacyFile) ?? {};
    } catch (error) {
      if (!unreadableLegacyFiles.has(legacyFile)) {
        unreadableLegacyFiles.add(legacyFile);
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`warning: could not read ${legacyFile}: ${message}; it was left in place\n`);
      }
      continue;
    }
    for (const entry of Array.isArray(legacy.jobs) ? legacy.jobs : []) {
      if (typeof entry?.id !== "string" || !entry.id) {
        continue;
      }
      const jobFile = path.join(stateDir, JOBS_DIR_NAME, `${entry.id}.json`);
      let stored = null;
      try {
        stored = readJsonFile(jobFile);
      } catch {
        stored = null;
      }
      storeRecord(jobFile, { ...(stored ?? {}), ...entry });
    }
    const configFile = path.join(stateDir, CONFIG_FILE_NAME);
    if (legacy.config && !fs.existsSync(configFile)) {
      writeJsonAtomic(configFile, { ...DEFAULT_CONFIG, ...legacy.config });
    }
    try {
      fs.renameSync(legacyFile, `${legacyFile}.migrated`);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function resolveConfigFile(cwd) {
  return path.join(resolveStateDir(cwd), CONFIG_FILE_NAME);
}

export function getConfig(cwd) {
  migrateLegacyState(cwd);
  let stored = null;
  try {
    stored = readJsonFile(resolveConfigFile(cwd));
  } catch {
    stored = null;
  }
  return { ...DEFAULT_CONFIG, ...(stored ?? {}) };
}

export function setConfig(cwd, key, value) {
  const next = { ...getConfig(cwd), [key]: value };
  writeJsonAtomic(resolveConfigFile(cwd), next);
  return next;
}

// The settings that apply in every workspace, below each workspace's own config.
const USER_CONFIG_FILE_NAME = "user-config.json";
const USER_CONFIG_VERSION = 1;
const USER_CONFIG_LOCK_RETRY_MS = 5000;
// A lock file older than this was left by a process that ended inside its write.
const USER_CONFIG_LOCK_STALE_MS = 30000;
const warnedUserConfigFiles = new Set();

// Claude Code keeps a plugin's data in <profile>/plugins/data/<plugin> and deletes that folder
// when the plugin is uninstalled. User settings must outlive a reinstall, so for such a data
// folder they live in <profile>/agent-plugin instead; `profileSettingsDir` is that folder, or null
// for a data folder of any other shape.
function profileSettingsDir(pluginDataDir) {
  const dataRoot = path.dirname(pluginDataDir);
  const pluginsDir = path.dirname(dataRoot);
  if (path.basename(dataRoot) !== "data" || path.basename(pluginsDir) !== "plugins") {
    return null;
  }
  return path.join(path.dirname(pluginsDir), "agent-plugin");
}

// The user config file inside the plugin data folder (or the fallback state root), where earlier
// versions kept it.
function dataUserConfigFile() {
  return path.join(getPluginDataDir() || FALLBACK_STATE_ROOT_DIR, USER_CONFIG_FILE_NAME);
}

/**
 * The user config file: <profile>/agent-plugin/user-config.json for a plugin data folder inside
 * a Claude Code profile, else in the plugin data folder, else in the fallback state root.
 */
export function userConfigFile() {
  const pluginDataDir = getPluginDataDir();
  const settingsDir = pluginDataDir ? profileSettingsDir(path.resolve(pluginDataDir)) : null;
  return settingsDir ? path.join(settingsDir, USER_CONFIG_FILE_NAME) : dataUserConfigFile();
}

// Moves a user config that an earlier version wrote into the plugin data folder to its place in
// the profile, once, when no file is there yet.
function adoptDataUserConfig(file) {
  const earlier = dataUserConfigFile();
  if (earlier === file || fs.existsSync(file) || !fs.existsSync(earlier)) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(earlier, file, fs.constants.COPYFILE_EXCL);
    fs.rmSync(earlier, { force: true });
  } catch {
    // Another process adopted it first, or the folder cannot be written; the read decides.
  }
}

function defaultUserConfig() {
  return { version: USER_CONFIG_VERSION, models: {} };
}

// Reads the user config file. Returns `{ config }`, or `{ error }` when the file exists but
// cannot be read, does not parse, or has a version this plugin does not know.
function readUserConfigFile(file) {
  let stored;
  try {
    stored = readJsonFile(file);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (stored == null) {
    return { config: defaultUserConfig() };
  }
  if (typeof stored !== "object" || Array.isArray(stored)) {
    return { error: "it does not hold a JSON object" };
  }
  if (stored.version !== USER_CONFIG_VERSION) {
    return { error: `it has version ${JSON.stringify(stored.version ?? null)}, and this plugin reads version ${USER_CONFIG_VERSION}` };
  }
  const models = stored.models && typeof stored.models === "object" && !Array.isArray(stored.models) ? stored.models : {};
  return { config: { ...stored, version: USER_CONFIG_VERSION, models } };
}

/**
 * The user config `{ version: 1, models, writeSandbox? }`. A missing file reads as the defaults;
 * a file that cannot be read reads as the defaults with one warning per file and process.
 */
export function getUserConfig() {
  const file = userConfigFile();
  adoptDataUserConfig(file);
  const read = readUserConfigFile(file);
  if (read.error) {
    if (!warnedUserConfigFiles.has(file)) {
      warnedUserConfigFiles.add(file);
      process.stderr.write(`warning: could not read ${file}: ${read.error}; the user settings are not used\n`);
    }
    return defaultUserConfig();
  }
  return read.config;
}

function readLockToken(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Takes the user config lock `lockFile` and returns the random token it now holds. The lock is
 * created exclusively. A lock older than `staleMs` was left by a process that ended inside its
 * write; it is recovered only by renaming it to a unique name, which one process alone can do,
 * and the renamed file is checked to still hold the token that was judged stale. A fresh lock
 * taken by mistake is put back. Throws, naming the lock file, when the lock stays held past
 * `retryMs`. `hooks.beforeStaleRename` (tests) runs between the stale check and the rename.
 * Exported for tests.
 */
export function acquireUserConfigLock(lockFile, { retryMs = USER_CONFIG_LOCK_RETRY_MS, staleMs = USER_CONFIG_LOCK_STALE_MS, hooks = null } = {}) {
  ensurePrivateDir(path.dirname(lockFile));
  const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + retryMs;
  for (let delay = 10; ; delay = Math.min(delay * 2, 100)) {
    try {
      fs.writeFileSync(lockFile, `${token}\n`, { flag: "wx", mode: PRIVATE_FILE_MODE });
      return token;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
    let stale = null;
    try {
      if (Date.now() - fs.statSync(lockFile).mtimeMs > staleMs) {
        stale = readLockToken(lockFile);
      }
    } catch {
      continue;
    }
    if (stale !== null) {
      hooks?.beforeStaleRename?.();
      const moved = `${lockFile}.stale-${token}`;
      let renamed = false;
      try {
        fs.renameSync(lockFile, moved);
        renamed = true;
      } catch {
        // Another process moved or released it first.
      }
      if (renamed) {
        if (readLockToken(moved) === stale) {
          fs.rmSync(moved, { force: true });
          continue;
        }
        // The lock was replaced by a fresh one after the stale check: put it back, unless a third
        // process has taken the free lock meanwhile; that holder and the owner of the moved lock
        // then meet in `holdsUserConfigLock` before either writes.
        try {
          fs.linkSync(moved, lockFile);
        } catch {
          // The lock is held again; the owner of the moved one fails its check.
        }
        fs.rmSync(moved, { force: true });
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`The user settings file is locked by another setup (${lockFile}); try again.`);
    }
    sleepSync(delay);
  }
}

/** True when `lockFile` still holds `token`. Exported for tests. */
export function holdsUserConfigLock(lockFile, token) {
  return readLockToken(lockFile) === token;
}

/** Removes `lockFile` only when it still holds `token`. Exported for tests. */
export function releaseUserConfigLock(lockFile, token) {
  if (holdsUserConfigLock(lockFile, token)) {
    fs.rmSync(lockFile, { force: true });
  }
}

/**
 * Changes the user config under an exclusive lock: reads it, passes a copy to `mutator`, and
 * writes the result atomically. A file that exists but cannot be read, or has an unknown version,
 * is never overwritten; the call throws an error that names it. The lock is checked again just
 * before the write, so a writer that lost it writes nothing. Returns the written config.
 */
export function updateUserConfig(mutator, lockOptions = {}) {
  const file = userConfigFile();
  adoptDataUserConfig(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lockFile = `${file}.lock`;
  const token = acquireUserConfigLock(lockFile, lockOptions);
  try {
    const read = readUserConfigFile(file);
    if (read.error) {
      throw new Error(`The user settings file ${file} cannot be used: ${read.error}. Fix or remove it, then run setup again.`);
    }
    const next = mutator(structuredClone(read.config)) ?? read.config;
    const written = { ...next, version: USER_CONFIG_VERSION, models: next.models ?? {} };
    if (!holdsUserConfigLock(lockFile, token)) {
      throw new Error(`The user settings lock ${lockFile} was taken by another setup; nothing was written. Run setup again.`);
    }
    writeJsonAtomic(file, written);
    return written;
  } finally {
    releaseUserConfigLock(lockFile, token);
  }
}

/** Sets one key of the user config; see `updateUserConfig`. */
export function setUserConfig(key, value) {
  return updateUserConfig((config) => ({ ...config, [key]: value }));
}

// ---------------------------------------------------------------------------------------------
// Job store. Everything below keeps job state in the SQLite store of lib/store.mjs; nothing below
// reads or writes the JSON job records above. Mutation primitives run exactly one transaction and
// re-read every predicate they depend on inside it.

export const PROMPT_LIMIT_BYTES = 8388608;
export const MESSAGE_LIMIT_BYTES = 1048576;
const LABEL_PATTERN = /^[a-z0-9-]{1,40}$/;

class JobStoreError extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.name = new.target.name;
    Object.assign(this, fields);
  }
}

export class LabelInUseError extends JobStoreError {
  constructor({ label, holderJobId }) {
    super(`The label "${label}" is held by job ${holderJobId}.`, { label, holderJobId });
  }
}

export class InvalidLabelError extends JobStoreError {
  constructor({ label }) {
    super(`The label "${label}" is not 1 to 40 characters of a-z, 0-9 and "-".`, { label });
  }
}

export class PromptTooLargeError extends JobStoreError {
  constructor({ bytes, limit = PROMPT_LIMIT_BYTES }) {
    super(`The prompt is ${bytes} bytes; the limit is ${limit} bytes.`, { bytes, limit });
  }
}

export class MessageTooLargeError extends JobStoreError {
  constructor({ bytes, limit = MESSAGE_LIMIT_BYTES }) {
    super(`The message is ${bytes} bytes; the limit is ${limit} bytes.`, { bytes, limit });
  }
}

export class ThreadBarrierError extends JobStoreError {
  constructor({ threadId, barrierJobId }) {
    super(
      `Thread ${threadId} was last used by job ${barrierJobId}, whose provider exit was not observed; pass --force to use it anyway.`,
      { threadId, barrierJobId }
    );
  }
}

export class UnknownJobError extends JobStoreError {
  constructor({ ref }) {
    super(`No job matches "${ref}".`, { ref });
  }
}

export class JobActiveError extends JobStoreError {
  constructor({ jobId, state }) {
    super(`Job ${jobId} is ${state}; use send to give it a message.`, { jobId, state });
  }
}

export class JobStoppingError extends JobStoreError {
  constructor({ jobId }) {
    super(`Job ${jobId} is stopping: its earlier provider process has not been confirmed gone.`, { jobId });
  }
}

export class JobCancelledError extends JobStoreError {
  constructor({ jobId }) {
    super(`Job ${jobId} was cancelled; use resume --force to continue it.`, { jobId });
  }
}

export class JobFailedError extends JobStoreError {
  constructor({ jobId }) {
    super(`Job ${jobId} failed; use resume --force to continue it.`, { jobId });
  }
}

export class NotResumableError extends JobStoreError {
  constructor({ jobId = null, reason }) {
    super(jobId ? `Job ${jobId} cannot be continued: ${reason}.` : `No job can be continued: ${reason}.`, { jobId, reason });
  }
}

function utf8Bytes(text) {
  return Buffer.byteLength(String(text ?? ""), "utf8");
}

function assertLabel(label) {
  if (label === undefined || label === null) {
    return null;
  }
  if (typeof label !== "string" || !LABEL_PATTERN.test(label)) {
    throw new InvalidLabelError({ label });
  }
  return label;
}

function isThenableValue(value) {
  return value !== null && (typeof value === "object" || typeof value === "function") && typeof value.then === "function";
}

// Runs a caller's hook inside the current transaction; a promise it returns is refused.
function runHook(hook, handle, args, name) {
  const result = hook(handle, args);
  if (isThenableValue(result)) {
    result.then(
      () => {},
      () => {}
    );
    throw new TypeError(`${name} must be synchronous; it returned a promise.`);
  }
}

// AGENT_PLUGIN_TEST_FAIL_STATEMENT names an internal statement that throws inside its transaction.
function failStatementForTest(name) {
  if (process.env.AGENT_PLUGIN_TEST_FAIL_STATEMENT === name) {
    throw new Error(`statement ${name} failed (AGENT_PLUGIN_TEST_FAIL_STATEMENT)`);
  }
}

function threadKey(provider, threadId) {
  return threadId ? `${provider}:${threadId}` : null;
}

function getJobRow(db, jobId) {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) ?? null;
}

function getChainRow(db, chainId) {
  return db.prepare("SELECT * FROM chains WHERE id = ?").get(chainId) ?? null;
}

function barrierFor(db, provider, threadId) {
  if (!threadId) {
    return null;
  }
  return db.prepare("SELECT job_id FROM thread_barriers WHERE provider = ? AND thread_id = ?").get(provider, threadId)?.job_id ?? null;
}

// The provider registry imports the provider modules, one of which imports this module's
// dependents, so it is loaded when first needed rather than at import time.
const requireModule = createRequire(import.meta.url);

function providerRegistry() {
  return requireModule("./providers.mjs");
}

function providerCanResume(providerId) {
  try {
    return Boolean(providerRegistry().getProvider(providerId).capabilities?.resume);
  } catch {
    return false;
  }
}

/** The state a reader shows, from one row (S3-R4e order). */
export function jobState(row) {
  if (row.cancelled_at !== null && row.cancelled_at !== undefined) {
    return "cancelled";
  }
  if (row.end_state) {
    return row.end_state;
  }
  if (row.stopping_since !== null && row.stopping_since !== undefined) {
    return "stopping";
  }
  if (row.started_at !== null && row.started_at !== undefined) {
    return "running";
  }
  return "queued";
}

/**
 * Whether a job can be continued: its stored prompt never reached a provider (no submission
 * intent), or it has a recorded thread or conversation that is not ephemeral and its provider
 * can resume.
 */
export function resumability(row) {
  if (row.submit_intent_at === null || row.submit_intent_at === undefined) {
    return { resumable: true, reason: null };
  }
  if (!row.thread_id) {
    return { resumable: false, reason: "no thread or conversation id was recorded" };
  }
  if (row.ephemeral) {
    return { resumable: false, reason: "its thread is ephemeral" };
  }
  if (!providerCanResume(row.provider)) {
    return { resumable: false, reason: "its provider cannot resume" };
  }
  return { resumable: true, reason: null };
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function viewOf(db, row) {
  const chain = getChainRow(db, row.chain_id);
  const successorId = db.prepare("SELECT id FROM jobs WHERE continues = ?").get(row.id)?.id ?? null;
  const chainPosition = db
    .prepare(
      `WITH RECURSIVE ancestors(id, continues) AS (
         SELECT id, continues FROM jobs WHERE id = ?
         UNION ALL SELECT jobs.id, jobs.continues FROM jobs JOIN ancestors ON jobs.id = ancestors.continues)
       SELECT count(*) AS n FROM ancestors`
    )
    .get(row.id).n;
  const pendingMessages = db
    .prepare("SELECT count(*) AS n FROM messages WHERE chain_id = ? AND state IN ('pending', 'dispatched')")
    .get(row.chain_id).n;
  const unreadEvents = db.prepare("SELECT count(*) AS n FROM events WHERE job_id = ? AND read_at IS NULL").get(row.id).n;
  const { resumable, reason } = resumability(row);
  return {
    id: row.id,
    chainId: row.chain_id,
    provider: row.provider,
    label: row.label,
    row: { ...row },
    state: jobState(row),
    isTip: chain?.tip_job_id === row.id,
    successorId,
    chainPosition,
    pendingMessages,
    unreadEvents,
    resumable,
    notResumableReason: reason,
    request: parseJson(row.request_json, {}),
    providerExitUnobserved: Boolean(row.provider_exit_unobserved)
  };
}

function tipRowOf(db, chainId) {
  const chain = getChainRow(db, chainId);
  return chain ? getJobRow(db, chain.tip_job_id) : null;
}

// The chain a reference names: a job id names its chain; otherwise a label names the chain that
// holds it, else the chain of the newest job ever given it (ties by job id).
function chainForRef(db, ref) {
  if (typeof ref !== "string" || !ref) {
    return null;
  }
  const job = getJobRow(db, ref);
  if (job) {
    return job.chain_id;
  }
  if (!LABEL_PATTERN.test(ref)) {
    return null;
  }
  const holder = db.prepare("SELECT id FROM chains WHERE live_label = ?").get(ref);
  if (holder) {
    return holder.id;
  }
  return db.prepare("SELECT chain_id FROM jobs WHERE label = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(ref)?.chain_id ?? null;
}

/** The view of one job, or null. */
export function readJobView(store, jobId, opts = {}) {
  return store.read((db) => {
    const row = getJobRow(db, jobId);
    return row ? viewOf(db, row) : null;
  }, opts);
}

/** The view of exactly the job with this id, ancestors included; null when it does not exist. */
export function resolveExactJob(store, jobId, opts = {}) {
  return readJobView(store, jobId, opts);
}

/**
 * The view of the chain tip a job id or label names (a snapshot; a mutation re-reads the tip
 * inside its own transaction); null when nothing matches.
 */
export function resolveActionableTip(store, ref, opts = {}) {
  return store.read((db) => {
    const chainId = chainForRef(db, ref);
    const tip = chainId ? tipRowOf(db, chainId) : null;
    return tip ? viewOf(db, tip) : null;
  }, opts);
}

/**
 * Job views, newest first: the jobs of `sessionId` unless `all` is set or no session is given,
 * at most `limit` of them.
 */
export function listJobViews(store, { sessionId = null, all = false, limit = 50 } = {}, opts = {}) {
  return store.read((db) => {
    const rows =
      !all && sessionId
        ? db.prepare("SELECT * FROM jobs WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(sessionId, limit)
        : db.prepare("SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT ?").all(limit);
    return rows.map((row) => viewOf(db, row));
  }, opts);
}

function boolInt(value) {
  return value ? 1 : 0;
}

/**
 * Creates a job and its chain in one transaction. The label must be free (no live chain holds
 * it); a thread behind a barrier needs `fields.force`, which marks the job forced. The job gets
 * the id `fields.jobId` when it is given (from generateJobId), else a new one. The optional
 * `withinCreate(db, { jobId, chainId })` runs once in the same transaction after both rows exist.
 */
export function createJob(store, fields, { label = null, withinCreate = null } = {}, opts = {}) {
  const checkedLabel = assertLabel(label);
  const prompt = String(fields.prompt ?? "");
  const bytes = utf8Bytes(prompt);
  if (bytes > PROMPT_LIMIT_BYTES) {
    throw new PromptTooLargeError({ bytes });
  }
  const requester = fields.requester ?? {};
  return store.transact((db) => {
    if (checkedLabel) {
      const holder = db.prepare("SELECT tip_job_id FROM chains WHERE live_label = ?").get(checkedLabel);
      if (holder) {
        throw new LabelInUseError({ label: checkedLabel, holderJobId: holder.tip_job_id });
      }
    }
    const threadId = fields.threadId ?? null;
    const barrierJobId = barrierFor(db, fields.provider, threadId);
    if (barrierJobId && !fields.force) {
      throw new ThreadBarrierError({ threadId, barrierJobId });
    }
    const now = wallNow();
    const jobId = fields.jobId ?? generateJobId(fields.kind ?? "job");
    db.prepare("INSERT INTO chains (id, tip_job_id, live_label, created_at, activity_at) VALUES (?, ?, ?, ?, ?)").run(
      jobId,
      jobId,
      checkedLabel,
      now,
      now
    );
    db.prepare(
      `INSERT INTO jobs (id, chain_id, provider, kind, title, label, run_id, prompt, request_json, cwd, model,
         allow_questions, foreground, forced, thread_id, ephemeral, resume_method, session_id, leader_pid,
         leader_start_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      jobId,
      jobId,
      fields.provider,
      fields.kind,
      // The title is shown by status and the session-start note; it often quotes the prompt.
      redactSecrets(String(fields.title ?? "")),
      checkedLabel,
      fields.runId ?? null,
      prompt,
      JSON.stringify(fields.request ?? {}),
      String(fields.cwd ?? ""),
      fields.model ?? null,
      boolInt(fields.allowQuestions),
      boolInt(fields.foreground),
      boolInt(barrierJobId && fields.force),
      threadId,
      boolInt(fields.ephemeral),
      fields.resumeMethod ?? null,
      requester.sessionId ?? null,
      requester.leaderPid ?? null,
      requester.leaderStartToken ?? null,
      now,
      now
    );
    if (withinCreate) {
      runHook(withinCreate, db, { jobId, chainId: jobId }, "withinCreate");
    }
    return { jobId, chainId: jobId, barrierJobId: barrierJobId ?? null };
  }, opts);
}

// ---------------------------------------------------------------------------------------------
// The end decision. applyEnd is the only code that sets one.

const FINAL_STATES = new Set(["completed", "failed", "cancelled"]);

function redactedOrNull(text) {
  return typeof text === "string" ? redactSecrets(text) : (text ?? null);
}

function dropOpenMessages(db, chainId, cause, at) {
  db.prepare(
    "UPDATE messages SET state = 'dropped', closed_at = ?, close_cause = ? WHERE chain_id = ? AND state IN ('pending', 'dispatched')"
  ).run(at, cause, chainId);
}

function clearLiveLabelIfTip(db, row) {
  db.prepare("UPDATE chains SET live_label = NULL WHERE id = ? AND tip_job_id = ?").run(row.chain_id, row.id);
}

function bumpActivity(db, chainId, at) {
  db.prepare("UPDATE chains SET activity_at = max(activity_at, ?) WHERE id = ?").run(at, chainId);
}

// Sets the end decision when none exists. On a win it inserts the job's event (none for
// cancelled), releases the chain's label when the state is final, drops the chain's open
// messages for failed and cancelled, and records chain activity.
function applyEnd(db, row, { state, by, reason = null, question: rawQuestion = null, error: rawError = null, summary: rawSummary = null, at = wallNow(), resumeMethod = null }) {
  // Status, result and the monitor's lines show these texts, so credentials in them are redacted
  // before they are stored. The result itself is kept as the provider gave it.
  const question = redactedOrNull(rawQuestion);
  const error = redactedOrNull(rawError);
  const summary = redactedOrNull(rawSummary);
  const update = db
    .prepare(
      `UPDATE jobs SET end_state = ?, end_at = ?, end_by = ?, end_reason = ?, question = ?, error = ?,
         summary = COALESCE(?, summary), resume_method = COALESCE(?, resume_method), updated_at = ?
       WHERE id = ? AND end_state IS NULL`
    )
    .run(state, at, by, reason, question, error, summary, resumeMethod, at, row.id);
  if (update.changes !== 1) {
    return { won: false, eventId: null };
  }
  let eventId = null;
  if (state !== "cancelled") {
    failStatementForTest("event-insert");
    const text = state === "waiting" ? (question ?? "") : state === "failed" ? (error ?? "") : "";
    eventId = Number(
      db.prepare("INSERT INTO events (job_id, kind, text, created_at) VALUES (?, ?, ?, ?)").run(row.id, state, text, at).lastInsertRowid
    );
  }
  if (FINAL_STATES.has(state)) {
    clearLiveLabelIfTip(db, row);
  }
  if (state === "failed" || state === "cancelled") {
    dropOpenMessages(db, row.chain_id, state, at);
  }
  bumpActivity(db, row.chain_id, at);
  return { won: true, eventId };
}

// ---------------------------------------------------------------------------------------------
// Admission and thread exclusivity

export const DEFAULT_MAX_PARALLEL = 8;

function readConfigMaxParallel(stateDir) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(stateDir, CONFIG_FILE_NAME), "utf8"));
    return config && typeof config.maxParallel === "object" && config.maxParallel ? config.maxParallel : {};
  } catch {
    return {};
  }
}

function limitFrom(map, providerId) {
  const value = map?.[providerId];
  return Number.isInteger(value) && value >= 1 ? value : DEFAULT_MAX_PARALLEL;
}

/** The admission limit of a provider: `maxParallel[<provider id>]` in config.json, else 8. */
export function readMaxParallel(stateDir, providerId) {
  return limitFrom(readConfigMaxParallel(stateDir), providerId);
}

function threadHeldByOther(db, key, jobId) {
  return Boolean(key && db.prepare("SELECT 1 FROM jobs WHERE active_thread_key = ? AND id <> ?").get(key, jobId));
}

// Why a queued job may not run now, apart from admission: its thread is held by another active
// execution, or it is behind a barrier and not forced.
function threadBlock(db, row) {
  if (threadHeldByOther(db, threadKey(row.provider, row.thread_id), row.id)) {
    return "thread-busy";
  }
  if (row.thread_id && !row.forced && barrierFor(db, row.provider, row.thread_id)) {
    return "barrier";
  }
  return null;
}

// The one eligibility calculation of claims, launches and launch failures: the provider's free
// places, its eligible queued jobs oldest first, and the cohort of the first `free` of them.
function computeEligibility(db, providerId, maxParallel) {
  const used = db
    .prepare("SELECT count(*) AS n FROM jobs WHERE provider = ? AND claimed_at IS NOT NULL AND exec_released_at IS NULL")
    .get(providerId).n;
  const free = Math.max(0, maxParallel - used);
  const queued = db
    .prepare(
      `SELECT * FROM jobs WHERE provider = ? AND end_state IS NULL AND claimed_at IS NULL AND cancelled_at IS NULL
         AND stop_requested_at IS NULL ORDER BY created_at, id`
    )
    .all(providerId);
  const eligible = [];
  const blocked = new Map();
  for (const row of queued) {
    const block = threadBlock(db, row);
    if (block) {
      blocked.set(row.id, block);
    } else {
      eligible.push(row.id);
    }
  }
  return { free, eligible, cohort: eligible.slice(0, free), blocked };
}

function logCohort(jobId, eligibility, decision) {
  const file = process.env.AGENT_PLUGIN_TEST_COHORT_LOG;
  if (file) {
    fs.appendFileSync(file, `${JSON.stringify({ jobId, cohort: eligibility.cohort, free: eligibility.free, decision })}\n`);
  }
}

function recordRefusal(db, jobId, refusal, at) {
  db.prepare("UPDATE jobs SET last_refusal = ?, launch_attempts = 0, updated_at = ? WHERE id = ?").run(refusal, at, jobId);
}

function isUniqueViolation(error) {
  return typeof error?.errcode === "number" && (error.errcode & 0xff) === 19 && /UNIQUE/i.test(String(error.message));
}

/**
 * The marker a removal of the worktree at `worktreePath` holds while it runs:
 * `.removing-<folder name>` next to the folder.
 */
export function worktreeRemovalMarker(worktreePath) {
  return path.join(path.dirname(worktreePath), `.removing-${path.basename(worktreePath)}`);
}

/**
 * True when a job may not use the worktree at `worktreePath`: its removal marker exists, or the
 * folder is gone. The marker is checked first and the folder second; a removal deletes its marker
 * only after the folder is gone, so no order of the two leaves a worker with a folder under
 * removal. `hooks.beforeMarkerCheck` and `hooks.afterMarkerCheck` run around the marker check.
 */
export function worktreeUnavailable(worktreePath, hooks = null) {
  hooks?.beforeMarkerCheck?.();
  const marked = fs.existsSync(worktreeRemovalMarker(worktreePath));
  hooks?.afterMarkerCheck?.();
  if (marked) {
    return true;
  }
  return !fs.existsSync(worktreePath);
}

function requestWorktreePath(requestJson) {
  try {
    const worktreePath = JSON.parse(requestJson ?? "{}")?.worktree?.path;
    return typeof worktreePath === "string" && worktreePath ? worktreePath : null;
  } catch {
    return null;
  }
}

/**
 * Claims a queued job for one worker, under admission (the job must be in its provider's oldest
 * eligible cohort) and thread exclusivity. A refusal by admission, barrier or a held thread is
 * recorded on the job and resets its launch attempts. After a claim commits, the worktree the job
 * runs in is checked outside the transaction (worktreeUnavailable); when it is under removal or
 * gone the result also carries `worktreeUnavailable: true`, and the worker must release the
 * execution without starting its provider. `hooks` is passed to that check.
 */
export function claimExecution(store, jobId, { pid, startToken, groupId = null, limits = {}, hooks = null }, opts = {}) {
  let worktreePath = null;
  const claim = store.transact((db) => {
    worktreePath = null;
    const row = getJobRow(db, jobId);
    if (!row) {
      throw new UnknownJobError({ ref: jobId });
    }
    if (row.claimed_at !== null || row.worker_pid !== null) {
      return { claimed: false, reason: "claimed" };
    }
    if (row.end_state) {
      return { claimed: false, reason: "ended" };
    }
    if (row.cancelled_at !== null) {
      return { claimed: false, reason: "cancelled" };
    }
    if (row.stop_requested_at !== null) {
      return { claimed: false, reason: "stop-requested" };
    }
    const now = wallNow();
    const eligibility = computeEligibility(db, row.provider, limits.maxParallel ?? DEFAULT_MAX_PARALLEL);
    const block = eligibility.blocked.get(jobId);
    const refusal = block ?? (eligibility.cohort.includes(jobId) ? null : "admission");
    if (refusal) {
      recordRefusal(db, jobId, refusal === "thread-busy" ? "thread-busy" : "admission", now);
      logCohort(jobId, eligibility, refusal);
      return { claimed: false, reason: refusal };
    }
    let update;
    try {
      update = db
        .prepare(
          `UPDATE jobs SET exec_gen = exec_gen + 1, worker_pid = ?, worker_start_token = ?, claimed_at = ?,
             worker_group_id = ?, active_thread_key = ?, updated_at = ?
           WHERE id = ? AND worker_pid IS NULL AND end_state IS NULL AND cancelled_at IS NULL AND stop_requested_at IS NULL`
        )
        .run(pid, startToken ?? null, now, groupId ?? null, threadKey(row.provider, row.thread_id), now, jobId);
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      recordRefusal(db, jobId, "thread-busy", now);
      logCohort(jobId, eligibility, "thread-busy");
      return { claimed: false, reason: "thread-busy" };
    }
    if (update.changes !== 1) {
      return { claimed: false, reason: "claimed" };
    }
    logCohort(jobId, eligibility, "claimed");
    worktreePath = requestWorktreePath(row.request_json);
    return { claimed: true, execGen: row.exec_gen + 1 };
  }, opts);
  if (claim.claimed && worktreePath && worktreeUnavailable(worktreePath, hooks)) {
    return { ...claim, worktreeUnavailable: true };
  }
  return claim;
}

// The predicate every write of a worker's execution carries: the claim of this generation, not
// released, no stop or cancel request, no end decision.
const EXECUTION_FENCE = `exec_gen = ? AND claimed_at IS NOT NULL AND exec_released_at IS NULL AND stop_requested_at IS NULL
  AND cancel_requested_at IS NULL AND cancelled_at IS NULL AND end_state IS NULL`;

function fenceHolds(row, execGen) {
  return Boolean(
    row &&
      row.exec_gen === execGen &&
      row.claimed_at !== null &&
      row.exec_released_at === null &&
      row.stop_requested_at === null &&
      row.cancel_requested_at === null &&
      row.cancelled_at === null &&
      row.end_state === null
  );
}

const INTENTS = {
  spawn: { sql: "spawn_intent_at = ?", values: (fields, now) => [now] },
  provider: {
    sql: "provider_pid = ?, provider_start_token = ?, provider_group_id = ?",
    values: (fields) => [fields.pid ?? null, fields.startToken ?? null, fields.groupId ?? null]
  },
  version: {
    sql: "request_json = json_set(request_json, '$.providerVersion', ?)",
    values: (fields) => [fields.version === undefined || fields.version === null ? null : String(fields.version)]
  },
  submit: { sql: "submit_intent_at = ?, client_message_id = ?", values: (fields, now) => [now, fields.clientMessageId ?? null] },
  turn: { sql: "turn_id = ?", values: (fields) => [fields.turnId ?? null] },
  started: { sql: "started_at = ?", values: (fields, now) => [now] }
};

/**
 * Records one step of a worker's execution (`spawn`, `provider`, `version`, `submit`, `turn`,
 * `started`) under the execution fence; false when the fence refused it.
 */
export function recordIntent(store, jobId, execGen, kind, fields = {}, opts = {}) {
  const intent = INTENTS[kind];
  if (!intent) {
    throw new TypeError(`Unknown intent: ${kind}`);
  }
  return store.transact((db) => {
    const now = wallNow();
    const update = db
      .prepare(`UPDATE jobs SET ${intent.sql}, updated_at = ? WHERE id = ? AND ${EXECUTION_FENCE}`)
      .run(...intent.values(fields, now), now, jobId, execGen);
    return update.changes === 1;
  }, opts);
}

/**
 * Records the thread or conversation a worker's provider reported and takes its thread key.
 * Refused with `fenced` outside the execution fence, `barrier` behind a barrier when the job is
 * not forced, `changed` when the execution already holds a different thread, and `held` when
 * another active execution holds the key.
 */
export function recordThread(store, jobId, execGen, { threadId, resumeMethod = null }, opts = {}) {
  return store.transact((db) => {
    const row = getJobRow(db, jobId);
    if (!fenceHolds(row, execGen)) {
      return { ok: false, reason: "fenced" };
    }
    if (!row.forced && barrierFor(db, row.provider, threadId)) {
      return { ok: false, reason: "barrier" };
    }
    const key = threadKey(row.provider, threadId);
    if ((row.active_thread_key !== null && row.active_thread_key !== key) || (row.thread_id !== null && row.thread_id !== threadId)) {
      // An unreleased execution keeps the thread it first recorded or claimed with, so the thread
      // it may still be using is never handed to another execution.
      return { ok: false, reason: "changed" };
    }
    if (threadHeldByOther(db, key, jobId)) {
      return { ok: false, reason: "held" };
    }
    const now = wallNow();
    try {
      db.prepare(
        `UPDATE jobs SET thread_id = ?, resume_method = COALESCE(?, resume_method), active_thread_key = ?, updated_at = ?
         WHERE id = ? AND ${EXECUTION_FENCE}`
      ).run(threadId, resumeMethod, key, now, jobId, execGen);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { ok: false, reason: "held" };
      }
      throw error;
    }
    return { ok: true };
  }, opts);
}

/** Whether an execution may still send to its provider: a read of the execution fence. */
export function readExecutionFence(store, jobId, execGen, opts = {}) {
  return store.read((db) => {
    const row = getJobRow(db, jobId);
    if (!row || row.exec_gen !== execGen || row.claimed_at === null) {
      return { ok: false, reason: "superseded" };
    }
    if (row.exec_released_at !== null) {
      return { ok: false, reason: "released" };
    }
    if (row.cancelled_at !== null || row.cancel_requested_at !== null) {
      return { ok: false, reason: "cancel" };
    }
    if (row.stop_requested_at !== null) {
      return { ok: false, reason: "stop" };
    }
    if (row.end_state) {
      return { ok: false, reason: "ended" };
    }
    return { ok: true };
  }, opts);
}

const LAUNCH_SPACING_MS = 5000;
const LAUNCH_FAILURE_ATTEMPTS = 3;

// Why a queued job may not be launched or failed by a scanner now; null when it is in its
// provider's cohort.
function launchRefusal(db, row, maxParallelMap) {
  if (!row) {
    return { reason: "unknown", eligibility: null };
  }
  if (row.claimed_at !== null) {
    return { reason: "claimed", eligibility: null };
  }
  if (row.end_state) {
    return { reason: "ended", eligibility: null };
  }
  if (row.stop_requested_at !== null || row.cancelled_at !== null) {
    return { reason: "stop", eligibility: null };
  }
  const eligibility = computeEligibility(db, row.provider, limitFrom(maxParallelMap, row.provider));
  const block = eligibility.blocked.get(row.id);
  if (block) {
    return { reason: block, eligibility };
  }
  if (!eligibility.cohort.includes(row.id)) {
    return { reason: "admission", eligibility };
  }
  return { reason: null, eligibility };
}

/**
 * Records a launch attempt before a worker is spawned for a queued job: refused unless the job is
 * in its provider's cohort, its last launch is more than 5 seconds old, and it has had fewer than
 * three attempts (`attempts`: the scanner then ends it `launch-failed`). With `opts.deadline` the
 * store checks it as the last step before COMMIT: once it has passed the transaction rolls back
 * with a deadline error and nothing is counted.
 */
export function recordLaunchAttempt(store, jobId, { now = wallNow() } = {}, opts = {}) {
  const maxParallelMap = readConfigMaxParallel(store.stateDir);
  return store.transact((db) => {
    const row = getJobRow(db, jobId);
    const { reason, eligibility } = launchRefusal(db, row, maxParallelMap);
    if (reason) {
      if (eligibility) {
        logCohort(jobId, eligibility, `launch-refused:${reason}`);
      }
      return { ok: false, reason };
    }
    if (row.last_launch_at !== null && now - row.last_launch_at <= LAUNCH_SPACING_MS) {
      return { ok: false, reason: "recent" };
    }
    if (row.launch_attempts >= LAUNCH_FAILURE_ATTEMPTS) {
      // Three launches produced neither a claim nor a refusal; the scanner ends the job instead.
      return { ok: false, reason: "attempts" };
    }
    db.prepare("UPDATE jobs SET launch_attempts = launch_attempts + 1, last_launch_at = ?, updated_at = ? WHERE id = ?").run(
      now,
      now,
      jobId
    );
    logCohort(jobId, eligibility, "launched");
    testDelay("launch-attempt");
    return { ok: true, attempts: row.launch_attempts + 1 };
  }, opts);
}

/**
 * Ends a queued job `interrupted` with reason `launch-failed` after three launch attempts that
 * produced neither a claim nor a refusal, while it is still in its provider's cohort. With
 * `opts.observed` (`{ attempts, lastLaunchAt }`) it changes nothing when a newer attempt exists.
 */
export function endLaunchFailed(store, jobId, opts = {}) {
  const maxParallelMap = readConfigMaxParallel(store.stateDir);
  return store.transact((db) => {
    const row = getJobRow(db, jobId);
    const { reason, eligibility } = launchRefusal(db, row, maxParallelMap);
    if (reason || row.launch_attempts < LAUNCH_FAILURE_ATTEMPTS) {
      return false;
    }
    const observed = opts.observed;
    if (observed && (row.launch_attempts !== observed.attempts || row.last_launch_at !== observed.lastLaunchAt)) {
      return false;
    }
    logCohort(jobId, eligibility, "launch-failed");
    return applyEnd(db, row, {
      state: "interrupted",
      by: "reconcile",
      reason: "launch-failed",
      resumeMethod: row.thread_id ? null : "stored-prompt"
    }).won;
  }, opts);
}

// ---------------------------------------------------------------------------------------------
// Results, successors and the recorded end of a turn

export const RESULT_LIMIT_BYTES = 1048576;

function cutUtf8(text, limit) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= limit) {
    return { text, cut: false };
  }
  let end = limit;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return { text: buffer.subarray(0, end).toString("utf8"), cut: true };
}

/** Cuts a UTF-8 text to at most `limit` bytes at the last whole character. */
export function capUtf8(text, limit) {
  return cutUtf8(String(text ?? ""), limit).text;
}

/**
 * Applies the result caps: the text is cut at the last whole UTF-8 character within 1,048,576
 * bytes; structured output is kept only as complete JSON of at most 1,048,576 bytes.
 */
export function capResult({ text = "", json = null } = {}) {
  const capped = cutUtf8(String(text ?? ""), RESULT_LIMIT_BYTES);
  let serialized = null;
  let jsonTooLarge = false;
  if (json !== null && json !== undefined) {
    let value = json;
    if (typeof json === "string") {
      try {
        value = JSON.parse(json);
      } catch {
        value = undefined;
      }
    }
    const candidate = value === undefined ? undefined : JSON.stringify(value);
    if (candidate !== undefined) {
      if (utf8Bytes(candidate) <= RESULT_LIMIT_BYTES) {
        serialized = candidate;
      } else {
        jsonTooLarge = true;
      }
    }
  }
  return { text: capped.text, truncated: capped.cut || jsonTooLarge, json: serialized, jsonTooLarge };
}

function writeResult(db, jobId, result, at, extraWhere = "", params = []) {
  const capped = capResult(result);
  return db
    .prepare(
      `UPDATE jobs SET result_text = ?, result_json = ?, result_truncated = ?, result_json_too_large = ?, result_logged = ?,
         result_at = ?, updated_at = ? WHERE id = ? ${extraWhere}`
    )
    .run(
      capped.text,
      capped.json,
      boolInt(capped.truncated),
      boolInt(capped.jsonTooLarge),
      boolInt(result.logged),
      at,
      at,
      jobId,
      ...params
    );
}

function deliverableIn(db, chainId) {
  return db
    .prepare("SELECT * FROM messages WHERE chain_id = ? AND state IN ('pending', 'dispatched') ORDER BY id")
    .all(chainId);
}

// The resume method a continuation records: the chain's thread or conversation method when a
// thread id exists, else the stored prompt.
function successorResumeMethod(db, tip) {
  if (!tip.thread_id) {
    return "stored-prompt";
  }
  if (tip.resume_method === "thread" || tip.resume_method === "conversation") {
    return tip.resume_method;
  }
  return (
    db
      .prepare(
        "SELECT resume_method FROM jobs WHERE chain_id = ? AND resume_method IN ('thread', 'conversation') ORDER BY created_at DESC, id DESC LIMIT 1"
      )
      .get(tip.chain_id)?.resume_method ?? "thread"
  );
}

// Inserts the continuation of `tip` in its chain and moves the chain's tip to it. The label is
// inherited unless another live chain holds it; the optional message is stored pending.
function insertSuccessor(db, tip, { requester, outputSchema = null, forced = false, message = null, at }) {
  failStatementForTest("successor-insert");
  const successorId = generateJobId(tip.kind);
  let label = tip.label;
  let labelDropped = false;
  if (label && db.prepare("SELECT 1 FROM chains WHERE live_label = ? AND id <> ?").get(label, tip.chain_id)) {
    label = null;
    labelDropped = true;
  }
  const request = parseJson(tip.request_json, {});
  delete request.providerVersion;
  if (outputSchema !== null && outputSchema !== undefined) {
    request.outputSchema = outputSchema;
  }
  db.prepare(
    `INSERT INTO jobs (id, chain_id, continues, provider, kind, title, label, run_id, prompt, request_json, cwd, model,
       allow_questions, foreground, forced, thread_id, ephemeral, resume_method, session_id, leader_pid,
       leader_start_token, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    successorId,
    tip.chain_id,
    tip.id,
    tip.provider,
    tip.kind,
    tip.title,
    label,
    tip.run_id,
    tip.prompt,
    JSON.stringify(request),
    tip.cwd,
    tip.model,
    tip.allow_questions,
    boolInt(forced),
    tip.thread_id,
    tip.ephemeral,
    successorResumeMethod(db, tip),
    requester?.sessionId ?? null,
    requester?.leaderPid ?? null,
    requester?.leaderStartToken ?? null,
    at,
    at
  );
  db.prepare("UPDATE chains SET tip_job_id = ?, live_label = COALESCE(?, live_label), activity_at = max(activity_at, ?) WHERE id = ?").run(
    successorId,
    label,
    at,
    tip.chain_id
  );
  let messageId = null;
  if (message !== null && message !== undefined) {
    messageId = Number(
      db
        .prepare("INSERT INTO messages (chain_id, text, sender_session_id, created_at) VALUES (?, ?, ?, ?)")
        .run(tip.chain_id, String(message), requester?.sessionId ?? null, at).lastInsertRowid
    );
  }
  return { successorId, messageId, labelDropped };
}

function identityOf(row) {
  return { sessionId: row.session_id, leaderPid: row.leader_pid, leaderStartToken: row.leader_start_token };
}

/**
 * Records how a job's turn ended, once. A worker passes its `execGen`. On a win the result is
 * stored with the end decision; a worker's `completed` or `waiting` end with deliverable chain
 * messages, no stop request, no next decision, no barrier on the thread and a leader `alive` or
 * `none` also records `continue` and inserts the successor with the job's own requester.
 */
export function recordEnd(store, jobId, { state, by, reason = null, question = null, error = null, summary = null, result = null, execGen = null, leader = "unknown" }, opts = {}) {
  return store.transact((db) => {
    const row = getJobRow(db, jobId);
    if (!row) {
      throw new UnknownJobError({ ref: jobId });
    }
    if (execGen !== null && execGen !== undefined && row.exec_gen !== execGen) {
      return { won: false, view: viewOf(db, row) };
    }
    const at = wallNow();
    // A committed cancel request outranks an interruption, whoever decided on the interruption.
    const cancelled = state === "interrupted" && row.cancel_requested_at !== null;
    const end = cancelled ? { state: "cancelled", reason: null } : { state, reason };
    const { won, eventId } = applyEnd(db, row, { ...end, by, question, error, summary, at });
    if (!won) {
      return { won: false, view: viewOf(db, getJobRow(db, jobId)) };
    }
    if (result) {
      writeResult(db, jobId, result, at);
    }
    let successorId = null;
    const natural = state === "completed" || state === "waiting";
    if (
      by === "worker" &&
      natural &&
      row.stop_requested_at === null &&
      row.next_action === null &&
      (leader === "alive" || leader === "none") &&
      !barrierFor(db, row.provider, row.thread_id) &&
      deliverableIn(db, row.chain_id).length > 0
    ) {
      const decided = db
        .prepare("UPDATE jobs SET next_action = 'continue', next_at = ?, next_session_id = ? WHERE id = ? AND next_action IS NULL")
        .run(at, row.session_id, jobId);
      if (decided.changes === 1) {
        successorId = insertSuccessor(db, getJobRow(db, jobId), { requester: identityOf(row), at }).successorId;
      }
    }
    return { won: true, eventId, successorId };
  }, opts);
}

/** Stores a worker's result after it lost the end decision; true when no result was stored yet. */
export function storeLateResult(store, jobId, execGen, result, opts = {}) {
  if (!result) {
    return false;
  }
  return store.transact((db) => writeResult(db, jobId, result, wallNow(), "AND exec_gen = ? AND result_at IS NULL", [execGen]).changes === 1, opts);
}

// ---------------------------------------------------------------------------------------------
// Next decision and continuation

function successorIdOf(db, jobId) {
  return db.prepare("SELECT id FROM jobs WHERE continues = ?").get(jobId)?.id ?? null;
}

/**
 * The one way a decision that lost to an existing continuation returns: runs the caller's
 * `withinDecision` hook once with `won: false` and returns `{ won: false, view, successorId }`.
 */
export function concludeLoss(db, { tipId, successorId, view }, withinDecision = null) {
  if (withinDecision) {
    runHook(withinDecision, db, { won: false, successorId, tipId }, "withinDecision");
  }
  return { won: false, view, successorId };
}

// The chain tip a decision acts on, and the tip the caller observed.
function resolveDecisionTarget(db, target) {
  if (target && typeof target === "object" && target.resumeLast) {
    const { provider, sessionId } = target.resumeLast;
    const tips = db
      .prepare(
        `SELECT jobs.* FROM chains JOIN jobs ON jobs.id = chains.tip_job_id
         WHERE jobs.provider = ? AND jobs.session_id IS ? ORDER BY jobs.created_at DESC, jobs.id DESC`
      )
      .all(provider, sessionId ?? null);
    const tip = tips.find((row) => resumability(row).resumable);
    if (!tip) {
      throw new NotResumableError({ reason: "no job of this session can be continued" });
    }
    return { tip, observed: null };
  }
  if (!target || typeof target !== "object" || typeof target.ref !== "string") {
    throw new TypeError("A decision needs a target object: { ref, observedTipId } or { resumeLast }.");
  }
  const chainId = chainForRef(db, target.ref);
  const tip = chainId ? tipRowOf(db, chainId) : null;
  if (!tip) {
    throw new UnknownJobError({ ref: target.ref });
  }
  const observed = target.observedTipId ? getJobRow(db, target.observedTipId) : null;
  if (target.observedTipId && (!observed || observed.chain_id !== tip.chain_id)) {
    throw new UnknownJobError({ ref: target.observedTipId });
  }
  return { tip, observed };
}

function decideCancel(db, tip, { requester, at, withinDecision }) {
  const current = jobState(tip);
  if (current === "queued" || current === "running") {
    throw new JobActiveError({ jobId: tip.id, state: current });
  }
  if (current === "stopping") {
    throw new JobStoppingError({ jobId: tip.id });
  }
  if (current !== "waiting" && current !== "interrupted") {
    return { won: false, view: viewOf(db, tip), successorId: null };
  }
  const update = db
    .prepare(
      `UPDATE jobs SET next_action = 'cancel', next_at = ?, next_session_id = ?, cancelled_at = ?, updated_at = ?
       WHERE id = ? AND next_action IS NULL`
    )
    .run(at, requester?.sessionId ?? null, at, at, tip.id);
  if (update.changes !== 1) {
    const successorId = successorIdOf(db, tip.id);
    const view = viewOf(db, getJobRow(db, tip.id));
    return successorId ? concludeLoss(db, { tipId: tip.id, successorId, view }, withinDecision) : { won: false, view, successorId: null };
  }
  dropOpenMessages(db, tip.chain_id, "cancelled", at);
  clearLiveLabelIfTip(db, tip);
  bumpActivity(db, tip.chain_id, at);
  return { won: true, successorId: null, messageId: null, labelDropped: false, barrierJobId: null };
}

/**
 * Records what is done with a chain's tip after its turn ended, once: `continue` inserts the
 * successor (with the optional message) in the same transaction; `cancel` cancels a waiting or
 * interrupted tip. A decision that finds an existing continuation returns `won: false` with it
 * and stores no message. `force` continues a failed or cancelled tip or a thread behind a
 * barrier; an `automatic` continuation is never forced and needs a leader `alive` or `none`.
 */
export function decideNext(
  store,
  target,
  { action = "continue", message = null, requester = null, outputSchema = null, force = false, automatic = false, leader = "unknown", withinDecision = null } = {},
  opts = {}
) {
  if (message !== null && message !== undefined && utf8Bytes(message) > MESSAGE_LIMIT_BYTES) {
    throw new MessageTooLargeError({ bytes: utf8Bytes(message) });
  }
  const outcome = store.transact((db) => {
    const { tip, observed } = resolveDecisionTarget(db, target);
    const tipId = tip.id;
    const at = wallNow();
    if (observed && observed.id !== tip.id && observed.next_action === "continue") {
      return concludeLoss(db, { tipId, successorId: successorIdOf(db, observed.id), view: viewOf(db, tip) }, withinDecision);
    }
    if (action === "cancel") {
      return decideCancel(db, tip, { requester, at, withinDecision });
    }
    if (action !== "continue") {
      throw new TypeError(`Unknown decision: ${action}`);
    }
    const current = jobState(tip);
    if (current === "queued" || current === "running") {
      throw new JobActiveError({ jobId: tipId, state: current });
    }
    if (current === "stopping") {
      throw new JobStoppingError({ jobId: tipId });
    }
    const forcing = Boolean(force) && !automatic;
    if (automatic) {
      const leaderOk = leader === "alive" || leader === "none";
      if (!leaderOk || tip.stop_requested_at !== null || (current !== "completed" && current !== "waiting")) {
        return { won: false, view: viewOf(db, tip), successorId: null };
      }
    }
    const cancelledByNext = tip.next_action === "cancel";
    if (!forcing) {
      if (tip.end_state === "failed") {
        throw new JobFailedError({ jobId: tipId });
      }
      if (tip.end_state === "cancelled" || cancelledByNext) {
        throw new JobCancelledError({ jobId: tipId });
      }
    }
    const { resumable, reason } = resumability(tip);
    if (!resumable) {
      throw new NotResumableError({ jobId: tipId, reason });
    }
    const barrierJobId = barrierFor(db, tip.provider, tip.thread_id);
    if (barrierJobId && !forcing) {
      throw new ThreadBarrierError({ threadId: tip.thread_id, barrierJobId });
    }
    if (automatic && deliverableIn(db, tip.chain_id).length === 0) {
      return { won: false, view: viewOf(db, tip), successorId: null };
    }
    const nextSession = automatic ? tip.session_id : (requester?.sessionId ?? null);
    let changes = 0;
    if (process.env.AGENT_PLUGIN_TEST_FORCE_BRANCH !== "decision-zero-rows") {
      const where = cancelledByNext ? "next_action = 'cancel'" : "next_action IS NULL";
      changes = db
        .prepare(`UPDATE jobs SET next_action = 'continue', next_at = ?, next_session_id = ?, updated_at = ? WHERE id = ? AND ${where}`)
        .run(at, nextSession, at, tipId).changes;
    }
    if (changes !== 1) {
      const now = getJobRow(db, tipId);
      const successorId = successorIdOf(db, tipId);
      if (successorId) {
        return concludeLoss(db, { tipId, successorId, view: viewOf(db, now) }, withinDecision);
      }
      if (now.next_action === "cancel") {
        throw new JobCancelledError({ jobId: tipId });
      }
      return { won: false, view: viewOf(db, now), successorId: null };
    }
    const inserted = insertSuccessor(db, getJobRow(db, tipId), {
      requester: automatic ? identityOf(tip) : (requester ?? {}),
      outputSchema,
      forced: Boolean(barrierJobId && forcing),
      message,
      at
    });
    if (withinDecision) {
      runHook(withinDecision, db, { won: true, successorId: inserted.successorId, tipId }, "withinDecision");
    }
    return {
      won: true,
      successorId: inserted.successorId,
      messageId: inserted.messageId,
      labelDropped: inserted.labelDropped,
      barrierJobId: barrierJobId && forcing ? barrierJobId : null
    };
  }, opts);
  testPoint("after-decide-commit");
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// Stop requests, the session-end batch, stopping, grace, release, dead claims and stale marks

const STOP_WINDOW_MS = 4000;
const END_BY_FOR_REASON = { "session-end": "hook", cancel: "cancel" };

/** The evidence input of an execution: what a release decision needs from its row. */
function evidenceInputOf(row) {
  const request = parseJson(row.request_json, {});
  return {
    jobId: row.id,
    execGen: row.exec_gen,
    provider: row.provider,
    providerVersion: typeof request.providerVersion === "string" ? request.providerVersion : null,
    expectedGroupId: row.provider_group_id ?? null,
    rootRecorded: row.provider_pid !== null,
    root: row.provider_pid !== null ? { pid: row.provider_pid, startToken: row.provider_start_token } : null,
    graceStartedAt: row.grace_started_at,
    providerExitSeenAt: row.provider_exit_seen_at ?? null,
    stopDeadline: row.stop_deadline
  };
}

/**
 * Records, in one transaction, the fenced state a worker leaves when it cannot release its
 * execution: once, the root exit it saw with no tree stop of its own (`exitSeenAt`); for a job
 * with no end decision, `stopping` (`unconfirmed-stop`) and, when no result is stored yet, the
 * worker's late `result`. Nothing changes unless the execution is this claimed, unreleased
 * generation. Resolves to `{ exitRecorded, stopping, resultStored }`.
 */
export function leaveExecutionUnconfirmed(store, jobId, execGen, { exitSeenAt = null, result = null } = {}, opts = {}) {
  return store.transact((db) => {
    const outcome = { exitRecorded: false, stopping: false, resultStored: false };
    const row = getJobRow(db, jobId);
    if (!claimedUnreleased(row, execGen)) {
      return outcome;
    }
    const now = wallNow();
    if (exitSeenAt !== null && exitSeenAt !== undefined) {
      outcome.exitRecorded =
        db
          .prepare("UPDATE jobs SET provider_exit_seen_at = ?, updated_at = ? WHERE id = ? AND exec_gen = ? AND provider_exit_seen_at IS NULL")
          .run(exitSeenAt, now, jobId, execGen).changes === 1;
    }
    if (row.end_state === null) {
      outcome.stopping = markStoppingRow(db, row, "unconfirmed-stop", now);
      if (result) {
        outcome.resultStored = writeResult(db, jobId, result, now, "AND exec_gen = ? AND result_at IS NULL", [execGen]).changes === 1;
      }
    }
    return outcome;
  }, opts);
}

/** Converts a stored epoch deadline once into a local monotonic deadline, at most 4 seconds away. */
export function localDeadlineFrom(storedDeadline, wallAt = wallNow(), monoAt = performance.now()) {
  if (storedDeadline === null || storedDeadline === undefined) {
    return null;
  }
  return monoAt + Math.max(0, Math.min(storedDeadline - wallAt, STOP_WINDOW_MS));
}

function selectionEntryOf(row, { deadline, localDeadline, hadCancelRequest, wasEnded, endedUnclaimed }) {
  return {
    jobId: row.id,
    execGen: row.exec_gen,
    deadline,
    localDeadline,
    worker: row.worker_pid !== null ? { pid: row.worker_pid, startToken: row.worker_start_token, groupId: row.worker_group_id } : null,
    provider: row.provider_pid !== null ? { pid: row.provider_pid, startToken: row.provider_start_token, groupId: row.provider_group_id ?? null } : null,
    ended: row.end_state !== null,
    endedUnclaimed,
    hadCancelRequest,
    wasEnded,
    evidence: evidenceInputOf(row)
  };
}

function isUnreleasedExecution(row) {
  return row.claimed_at !== null && row.exec_released_at === null;
}

function isUnclaimedOpenTip(db, row) {
  return row.claimed_at === null && row.end_state === null && getChainRow(db, row.chain_id)?.tip_job_id === row.id;
}

// The rows a stop request selects: for a session, its unreleased executions (ended jobs and
// ancestors included) and its unclaimed tips with no end decision; for job ids, exactly those
// jobs when they are such an execution or tip.
function selectStopRows(db, selector) {
  if (selector && Array.isArray(selector.jobIds)) {
    const seen = new Set();
    const rows = [];
    for (const jobId of selector.jobIds) {
      if (seen.has(jobId)) {
        continue;
      }
      seen.add(jobId);
      const row = getJobRow(db, jobId);
      if (row && (isUnreleasedExecution(row) || isUnclaimedOpenTip(db, row))) {
        rows.push(row);
      }
    }
    return rows;
  }
  if (selector && typeof selector.sessionId === "string") {
    const executions = db
      .prepare("SELECT * FROM jobs WHERE session_id = ? AND claimed_at IS NOT NULL AND exec_released_at IS NULL ORDER BY created_at, id")
      .all(selector.sessionId);
    const tips = db
      .prepare(
        `SELECT jobs.* FROM jobs JOIN chains ON chains.tip_job_id = jobs.id
         WHERE jobs.session_id = ? AND jobs.claimed_at IS NULL AND jobs.end_state IS NULL ORDER BY jobs.created_at, jobs.id`
      )
      .all(selector.sessionId);
    return [...executions, ...tips];
  }
  throw new TypeError("A stop request needs a selector: { jobIds } or { sessionId }.");
}

/**
 * Records a stop request with one deadline on every selected execution, keeping an earlier
 * deadline and never changing an end decision, and ends each selected unclaimed tip (`cancelled`
 * with `cancel`, else `interrupted` from its stored prompt). The stored deadline is `afterMs`
 * after the commit, capped by `maxLocalDeadline`. The optional `withinStop(db, { commitWall,
 * selection })` runs once before the commit.
 */
export function requestStop(store, selector, { reason, sessionId = null, afterMs = STOP_WINDOW_MS, maxLocalDeadline = null, cancel = false, withinStop = null } = {}, opts = {}) {
  return store.transact((db) => {
    const rows = selectStopRows(db, selector).map((row) => ({
      row,
      claimed: row.claimed_at !== null,
      hadCancelRequest: row.cancel_requested_at !== null,
      wasEnded: row.end_state !== null
    }));
    const commitMono = performance.now();
    const commitWall = wallNow();
    const localDeadline = Math.min(commitMono + afterMs, maxLocalDeadline ?? Infinity);
    const storedDeadline = Math.round(commitWall + (localDeadline - commitMono));
    const selection = [];
    for (const entry of rows) {
      db.prepare(
        `UPDATE jobs SET stop_requested_at = COALESCE(stop_requested_at, ?),
           stop_reason = CASE WHEN ? = 1 THEN ? ELSE COALESCE(stop_reason, ?) END,
           stop_session_id = COALESCE(stop_session_id, ?),
           stop_deadline = min(COALESCE(stop_deadline, ?), ?),
           cancel_requested_at = CASE WHEN ? = 1 THEN COALESCE(cancel_requested_at, ?) ELSE cancel_requested_at END,
           updated_at = ?
         WHERE id = ?`
      ).run(commitWall, boolInt(cancel), reason, reason, sessionId, storedDeadline, storedDeadline, boolInt(cancel), commitWall, commitWall, entry.row.id);
      let endedUnclaimed = false;
      if (!entry.claimed) {
        const end = cancel
          ? { state: "cancelled", by: "cancel", reason: null }
          : { state: "interrupted", by: END_BY_FOR_REASON[reason] ?? "reconcile", reason, resumeMethod: "stored-prompt" };
        endedUnclaimed = applyEnd(db, getJobRow(db, entry.row.id), { ...end, at: commitWall }).won;
      }
      const after = getJobRow(db, entry.row.id);
      const deadline = after.stop_deadline;
      const entryLocal = deadline === storedDeadline ? localDeadline : commitMono + Math.max(0, Math.min(deadline - commitWall, STOP_WINDOW_MS));
      selection.push(
        selectionEntryOf(after, { deadline, localDeadline: entryLocal, hadCancelRequest: entry.hadCancelRequest, wasEnded: entry.wasEnded, endedUnclaimed })
      );
    }
    if (withinStop) {
      runHook(withinStop, db, { commitWall, selection }, "withinStop");
    }
    return { commitWall, commitMono, localDeadline, storedDeadline, selection };
  }, opts);
}

/** The evidence input of one job's current execution, with whether it is released; null for an unknown job. */
export function readEvidenceInput(store, jobId, opts = {}) {
  return store.read((db) => {
    const row = getJobRow(db, jobId);
    return row ? { ...evidenceInputOf(row), released: row.exec_released_at !== null, spawnIntentRecorded: row.spawn_intent_at !== null } : null;
  }, opts);
}

/** The same selection as a session's stop request, from one read, with no writes. */
export function readSessionSelection(store, sessionId, opts = {}) {
  return store.read((db) => {
    const wallAt = wallNow();
    const monoAt = performance.now();
    return selectStopRows(db, { sessionId }).map((row) =>
      selectionEntryOf(row, {
        deadline: row.stop_deadline,
        localDeadline: localDeadlineFrom(row.stop_deadline, wallAt, monoAt),
        hadCancelRequest: row.cancel_requested_at !== null,
        wasEnded: row.end_state !== null,
        endedUnclaimed: false
      })
    );
  }, opts);
}

function undecidedEnd(row, { by, reason }) {
  if (row.cancel_requested_at !== null || row.cancelled_at !== null) {
    return { state: "cancelled", by, reason: null };
  }
  const { resumable, reason: why } = resumability(row);
  if (resumable) {
    return { state: "interrupted", by, reason, resumeMethod: row.thread_id ? null : "stored-prompt" };
  }
  return { state: "failed", by, reason, error: `The job stopped before its turn ended and cannot be continued: ${why}.` };
}

// Releases a claimed, unreleased execution: records the end decision only when none exists,
// frees the thread key and the admission place, and writes the barrier of an unobserved release
// or removes it on a confirmed release of a forced job.
function releaseRow(db, row, { kind, endIfUndecided = null, at = wallNow() }) {
  if (row.end_state === null) {
    const by = endIfUndecided?.by ?? "reconcile";
    let end = undecidedEnd(row, { by, reason: endIfUndecided?.reason ?? row.stop_reason ?? "worker-dead" });
    const proposed = endIfUndecided?.end;
    // A caller's own end (a worker that stopped its provider) stands unless a committed cancel
    // request outranks it.
    if (proposed && !(proposed.state !== "cancelled" && end.state === "cancelled")) {
      end = { ...proposed, by };
    }
    applyEnd(db, row, { ...end, at });
    if (endIfUndecided?.result) {
      writeResult(db, row.id, endIfUndecided.result, at, "AND result_at IS NULL");
    }
  }
  const update = db
    .prepare(
      `UPDATE jobs SET exec_released_at = ?, release_kind = ?, active_thread_key = NULL,
         provider_exit_unobserved = CASE WHEN ? = 'unobserved' THEN 1 ELSE provider_exit_unobserved END, updated_at = ?
       WHERE id = ? AND exec_gen = ? AND claimed_at IS NOT NULL AND exec_released_at IS NULL`
    )
    .run(at, kind, kind, at, row.id, row.exec_gen);
  if (update.changes !== 1) {
    throw new Error(`The execution of job ${row.id} changed while it was released.`);
  }
  if (row.thread_id && kind === "unobserved") {
    db.prepare(
      `INSERT INTO thread_barriers (provider, thread_id, job_id, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (provider, thread_id) DO UPDATE SET job_id = excluded.job_id, created_at = excluded.created_at`
    ).run(row.provider, row.thread_id, row.id, at);
  } else if (row.thread_id && kind === "confirmed" && row.forced) {
    db.prepare("DELETE FROM thread_barriers WHERE provider = ? AND thread_id = ?").run(row.provider, row.thread_id);
  }
}

function claimedUnreleased(row, execGen) {
  return Boolean(row && row.exec_gen === execGen && row.claimed_at !== null && row.exec_released_at === null);
}

const RELEASE_KINDS = new Set(["confirmed", "unobserved"]);

/**
 * Releases one execution as `confirmed` or `unobserved`; records an end decision only for a job
 * that has none (cancelled when a cancel was requested, interrupted when resumable, else failed).
 * With `expectedRoot` (`{ pid }`, or null for none) the release changes nothing when the recorded
 * provider root differs from the one the caller decided on; with `expectedExitSeenAt` (a time, or
 * null for none) it changes nothing when the worker-seen root exit differs from the caller's.
 */
export function releaseExecution(store, jobId, execGen, { kind, endIfUndecided = null, expectedRoot = undefined, expectedExitSeenAt = undefined } = {}, opts = {}) {
  if (!RELEASE_KINDS.has(kind)) {
    throw new TypeError(`Unknown release kind: ${kind}`);
  }
  return store.transact((db) => {
    const row = getJobRow(db, jobId);
    if (!claimedUnreleased(row, execGen)) {
      return false;
    }
    if (expectedRoot !== undefined && row.provider_pid !== (expectedRoot?.pid ?? null)) {
      // The caller decided from a snapshot whose provider root differs from the recorded one.
      return false;
    }
    if (expectedExitSeenAt !== undefined && (row.provider_exit_seen_at ?? null) !== (expectedExitSeenAt ?? null)) {
      // The caller decided from a snapshot without the root exit a worker has since recorded.
      return false;
    }
    releaseRow(db, row, { kind, endIfUndecided });
    return true;
  }, opts);
}

function markStoppingRow(db, row, cause, at) {
  return (
    db
      .prepare(
        `UPDATE jobs SET stopping_since = ?, stopping_cause = ?, updated_at = ?
         WHERE id = ? AND exec_gen = ? AND claimed_at IS NOT NULL AND exec_released_at IS NULL AND end_state IS NULL
           AND stopping_since IS NULL`
      )
      .run(at, cause, at, row.id, row.exec_gen).changes === 1
  );
}

/**
 * Commits the session-end decisions in one transaction: each candidate whose execution still has
 * this generation, is unreleased and has a stop request is released, or, with `release: null`,
 * marked stopping `unconfirmed-stop` when it has no end decision. An ended execution with
 * `release: null` is listed as unreleased and left unchanged; a candidate that fails its fence is
 * skipped, and so is a release whose `expectedExitSeenAt` (a time, or null for none) differs from
 * the worker-seen root exit now recorded. Any other error rolls back the whole batch.
 */
export function commitSessionEnd(store, decisions, opts = {}) {
  return store.transact((db) => {
    const at = wallNow();
    const result = { released: [], stopping: [], unreleased: [], skipped: [] };
    decisions.forEach((decision, index) => {
      if (index === 1) {
        failStatementForTest("batch-second");
      }
      const row = getJobRow(db, decision.jobId);
      if (!claimedUnreleased(row, decision.execGen) || row.stop_requested_at === null) {
        result.skipped.push(decision.jobId);
        return;
      }
      const seenAt = decision.release?.expectedExitSeenAt;
      if (seenAt !== undefined && (row.provider_exit_seen_at ?? null) !== (seenAt ?? null)) {
        // The release was decided from a snapshot without the root exit a worker has since recorded.
        result.skipped.push(decision.jobId);
        return;
      }
      if (decision.release) {
        releaseRow(db, row, { kind: decision.release.kind, endIfUndecided: { by: "hook", reason: row.stop_reason ?? "session-end" }, at });
        result.released.push(decision.jobId);
      } else if (row.end_state === null) {
        markStoppingRow(db, row, "unconfirmed-stop", at);
        result.stopping.push(decision.jobId);
      } else {
        result.unreleased.push(decision.jobId);
      }
    });
    return result;
  }, opts);
}

/**
 * Marks a job stopping: its execution is claimed, unreleased, of this generation and has no end
 * decision, and its provider could not be confirmed gone yet. True when the row changed.
 */
export function markStopping(store, jobId, { cause, execGen }, opts = {}) {
  return store.transact((db) => {
    const row = getJobRow(db, jobId);
    return claimedUnreleased(row, execGen) ? markStoppingRow(db, row, cause, wallNow()) : false;
  }, opts);
}

/**
 * Records the first time an execution's owner was confirmed absent, once; returns the stored
 * `grace_started_at` (null when the execution is no longer this unreleased generation).
 */
export function startGrace(store, jobId, execGen, _options = {}, opts = {}) {
  return store.transact((db) => {
    const at = wallNow();
    db.prepare(
      `UPDATE jobs SET grace_started_at = ?, updated_at = ?
       WHERE id = ? AND exec_gen = ? AND claimed_at IS NOT NULL AND exec_released_at IS NULL AND grace_started_at IS NULL`
    ).run(at, at, jobId, execGen);
    const row = getJobRow(db, jobId);
    return claimedUnreleased(row, execGen) ? row.grace_started_at : null;
  }, opts);
}

/**
 * Ends a claim whose worker is confirmed absent before it recorded a spawn intent: the job ends
 * `interrupted` (`worker-dead`, from its stored prompt when no thread id exists) and the execution
 * is released `confirmed`, since no provider existed.
 */
export function endDeadClaim(store, jobId, execGen, opts = {}) {
  return store.transact((db) => {
    const row = getJobRow(db, jobId);
    if (!claimedUnreleased(row, execGen) || row.spawn_intent_at !== null) {
      return false;
    }
    const at = wallNow();
    if (row.end_state === null) {
      // A committed cancel request outranks the interruption of a dead claim.
      const end =
        row.cancel_requested_at !== null
          ? { state: "cancelled", by: "reconcile", reason: null }
          : { state: "interrupted", by: "reconcile", reason: "worker-dead", resumeMethod: row.thread_id ? null : "stored-prompt" };
      applyEnd(db, row, { ...end, at });
    }
    releaseRow(db, getJobRow(db, jobId), { kind: "confirmed", at });
    return true;
  }, opts);
}

/**
 * Marks a stale worker's execution: re-reads its heartbeat file inside the transaction and, only
 * when no valid sample has a counter above `lastValidCounter` and the execution is unchanged, sets
 * `stopping_since` (`stale-worker`) when the job has no end decision and records a stop request
 * (`stale-worker`, deadline 4 seconds later) when none exists. True when it changed the row.
 */
export function markStale(store, jobId, execGen, { claim, lastValidCounter, stateDir = null }, opts = {}) {
  return store.transact((db) => {
    const row = getJobRow(db, jobId);
    if (!claimedUnreleased(row, execGen)) {
      return false;
    }
    const sample = readLiveSample(stateDir ?? store.stateDir, claim);
    if (sample.valid && (lastValidCounter === null || lastValidCounter === undefined || sample.counter > lastValidCounter)) {
      return false;
    }
    const at = wallNow();
    let changed = false;
    if (row.end_state === null && row.stopping_since === null) {
      changed = markStoppingRow(db, row, "stale-worker", at) || changed;
    }
    if (row.stop_requested_at === null) {
      db.prepare(
        "UPDATE jobs SET stop_requested_at = ?, stop_reason = 'stale-worker', stop_deadline = ?, updated_at = ? WHERE id = ? AND stop_requested_at IS NULL"
      ).run(at, at + STOP_WINDOW_MS, at, jobId);
      changed = true;
    }
    return changed;
  }, opts);
}

// ---------------------------------------------------------------------------------------------
// Pruning

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const PRUNE_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const PRUNE_KEEP_CHAINS = 50;

/**
 * Deletes whole quiescent chains, at most once an hour (`meta.last_prune_at`), in one transaction.
 * A chain is kept while any job has no end decision or an unreleased execution, any message is
 * pending or dispatched, its last activity is younger than 14 days, or it is among the 50 most
 * recently active. Thread barriers are never touched. Returns the deleted job ids.
 */
export function pruneChains(store, { now = wallNow() } = {}, opts = {}) {
  return store.transact((db) => {
    const last = Number(db.prepare("SELECT value FROM meta WHERE key = 'last_prune_at'").get()?.value);
    if (Number.isFinite(last) && now - last < PRUNE_INTERVAL_MS) {
      return { prunedJobIds: [] };
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('last_prune_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(now));
    const victims = db
      .prepare(
        `SELECT id FROM chains
         WHERE activity_at <= ?
           AND id NOT IN (SELECT id FROM chains ORDER BY activity_at DESC, id DESC LIMIT ?)
           AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.chain_id = chains.id
                             AND (end_state IS NULL OR (claimed_at IS NOT NULL AND exec_released_at IS NULL)))
           AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.chain_id = chains.id AND state IN ('pending', 'dispatched'))`
      )
      .all(now - PRUNE_KEEP_MS, PRUNE_KEEP_CHAINS)
      .map((row) => row.id);
    const prunedJobIds = [];
    for (const chainId of victims) {
      for (const row of db.prepare("SELECT id FROM jobs WHERE chain_id = ? ORDER BY created_at, id").all(chainId)) {
        prunedJobIds.push(row.id);
      }
      db.prepare("DELETE FROM chains WHERE id = ?").run(chainId);
    }
    testPoint("inside-prune");
    return { prunedJobIds };
  }, opts);
}

// ---------------------------------------------------------------------------------------------
// Release evidence and decision

/** The grace window after which an execution whose closure cannot be established is released. */
export const DEFAULT_GRACE_MS = 60000;

function compareVersionText(left, right) {
  const parse = (text) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ""));
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) {
    return null;
  }
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] - b[index];
    }
  }
  return 0;
}

function providerDescriptor(providerId) {
  try {
    return providerRegistry().getProvider(providerId);
  } catch {
    return null;
  }
}

/**
 * The validated cleanup contracts of a provider: `{ provider, platform, trigger, version,
 * windowMs }`, from the provider descriptor (AGENT_PLUGIN_TEST_CONTRACTS replaces them).
 */
export function cleanupContracts(providerId) {
  const seam = process.env.AGENT_PLUGIN_TEST_CONTRACTS;
  let contracts;
  if (seam) {
    try {
      contracts = JSON.parse(seam);
    } catch {
      contracts = [];
    }
  } else {
    const declared = providerDescriptor(providerId)?.cleanupContracts;
    contracts = typeof declared === "function" ? declared() : (declared ?? []);
  }
  return (Array.isArray(contracts) ? contracts : []).filter((entry) => entry?.provider === providerId);
}

/** The grace window of a provider on this platform (AGENT_PLUGIN_GRACE_MS replaces it). */
export function graceWindowMs(providerId) {
  const seam = Number(process.env.AGENT_PLUGIN_GRACE_MS);
  if (process.env.AGENT_PLUGIN_GRACE_MS && Number.isFinite(seam) && seam >= 0) {
    return seam;
  }
  const declared = providerDescriptor(providerId)?.graceWindowMs;
  const value = typeof declared === "function" ? declared(process.platform) : declared;
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_GRACE_MS;
}

/**
 * Gathers the evidence a release decision needs, outside any transaction, within `deadline`: the
 * root by exact identity (not asked when the caller saw the root's exit), on Linux whether the
 * provider's recorded process group has any member (one kernel answer for the whole group), and
 * the trigger the caller witnessed: a tree stop only when its stop command succeeded on a running
 * root, the provider's own exit for any other root exit the caller saw or that a worker recorded
 * (`providerExitSeenAt`), or owner death from the stored grace start. A root exit a worker
 * recorded is never credited as owner death. No release path credits the end of stdin.
 */
export async function observeClosure(input, { deadline, rootExitSeenAt: seenByCaller = null, stopResult = null, stoppedAt = null } = {}) {
  const rootExitSeenAt = seenByCaller ?? input.providerExitSeenAt ?? null;
  const exitSeen = rootExitSeenAt !== null && rootExitSeenAt !== undefined;
  let root = "unknown";
  if (exitSeen) {
    root = "absent";
  } else if (input.rootRecorded && input.root) {
    root = confirmIdentity(input.root, await readProcessIdentity(input.root.pid, { deadline }));
  }
  let group = null;
  if (process.platform === "linux") {
    if (input.expectedGroupId === null || input.expectedGroupId === undefined) {
      group = "unknown";
    } else {
      const members = await groupHasMembers(input.expectedGroupId, { deadline });
      group = members === "unknown" ? "unknown" : !members;
    }
  }
  let trigger = null;
  if (stopResult === "stopped") {
    trigger = { kind: "tree-stop", at: stoppedAt ?? wallNow() };
  } else if (exitSeen) {
    trigger = { kind: "own-exit", at: rootExitSeenAt };
  } else if (input.graceStartedAt !== null && input.graceStartedAt !== undefined) {
    trigger = { kind: "owner-death", at: input.graceStartedAt };
  }
  return {
    platform: process.platform,
    provider: input.provider,
    providerVersion: input.providerVersion ?? null,
    expectedGroupId: input.expectedGroupId ?? null,
    rootRecorded: Boolean(input.rootRecorded),
    root,
    rootExitSeenAt: rootExitSeenAt ?? null,
    group,
    trigger,
    graceStartedAt: input.graceStartedAt ?? null,
    graceMs: graceWindowMs(input.provider),
    contracts: cleanupContracts(input.provider)
  };
}

/**
 * Decides an execution's release from its evidence: `confirmed` only when the root's exit was
 * seen or its identity is confirmed absent and descendant closure holds (Linux: the provider's
 * process group is empty; elsewhere: a contract for the observed trigger, validated at or below
 * the running provider version, whose window has passed); `unobserved` once the grace window has
 * passed since the first owner absence; otherwise `wait`. Root absence alone never confirms.
 */
export function decideRelease(evidence, { now = wallNow() } = {}) {
  const rootGone = evidence.rootExitSeenAt !== null || evidence.root === "absent";
  if (evidence.platform === "linux") {
    if (rootGone && evidence.group === true) {
      return { kind: "confirmed", reason: "the provider root is gone and the provider's process group is empty" };
    }
  } else if (rootGone && evidence.trigger) {
    const matching = (evidence.contracts ?? []).find(
      (entry) =>
        entry.provider === evidence.provider &&
        entry.platform === evidence.platform &&
        entry.trigger === evidence.trigger.kind &&
        (compareVersionText(evidence.providerVersion, entry.version) ?? -1) >= 0
    );
    if (matching) {
      if (now - evidence.trigger.at >= matching.windowMs) {
        return { kind: "confirmed", reason: `the ${matching.trigger} cleanup contract's window has passed` };
      }
      return { kind: "wait", reason: `the ${matching.trigger} cleanup contract's window has not passed`, until: evidence.trigger.at + matching.windowMs };
    }
  }
  if (evidence.graceStartedAt !== null && evidence.graceStartedAt !== undefined && now - evidence.graceStartedAt >= evidence.graceMs) {
    return { kind: "unobserved", reason: "the grace window passed without proof that the provider's processes are gone" };
  }
  return {
    kind: "wait",
    reason: "closure of the provider's processes is not established yet",
    until: evidence.graceStartedAt === null || evidence.graceStartedAt === undefined ? null : evidence.graceStartedAt + evidence.graceMs
  };
}

// ---------------------------------------------------------------------------------------------
// The scanner: execution cleanup, launches and automatic continuations

/** The launch cohort of a provider now: the oldest eligible queued jobs that fit its free places. */
export function readCohort(store, providerId, opts = {}) {
  const maxParallel = limitFrom(readConfigMaxParallel(store.stateDir), providerId);
  return store.read((db) => {
    const { free, cohort } = computeEligibility(db, providerId, maxParallel);
    return { free, cohort };
  }, opts);
}

function isFatalStoreError(error) {
  return error instanceof StoreError && (error.class === "store-moved" || error.class === "corruption");
}

// Runs one primitive of a scan: an availability error or a refused decision skips that item; a
// lost or corrupt store ends the scan, and any other error is a defect that is raised.
function scanStep(call) {
  try {
    return { ok: true, value: call() };
  } catch (error) {
    if (isFatalStoreError(error) || !(error instanceof StoreError || error instanceof JobStoreError)) {
      throw error;
    }
    return { ok: false, error };
  }
}

function heartbeatVerdicts(heartbeats, stateDir, executions) {
  if (!heartbeats) {
    return new Map();
  }
  if (heartbeats instanceof Map) {
    return heartbeats;
  }
  const samples = new Map();
  for (const row of executions) {
    const claim = { pid: row.worker_pid, startToken: row.worker_start_token, jobId: row.id, execGen: row.exec_gen };
    samples.set(`${row.id}:${row.exec_gen}`, { claim, sample: readLiveSample(stateDir, claim) });
  }
  return heartbeats.observeBatch(performance.now(), samples);
}

const ROOT_EXIT_WAIT_MS = 1000;
const ROOT_EXIT_POLL_MS = 50;

// After a stop that succeeded, waits for the killed root to leave the process table (up to one
// second, never past `deadline`), because a killed process is not gone at the moment of the signal.
async function rootExitAfterStop(root, stopResult, deadline) {
  if ((stopResult !== "stopped" && stopResult !== "root-stopped") || !root) {
    return;
  }
  const until = Math.min(performance.now() + ROOT_EXIT_WAIT_MS, deadline ?? Infinity);
  while (performance.now() < until) {
    const observed = await readProcessIdentity(root.pid, { deadline: until });
    if (confirmIdentity(root, observed) !== "present") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, ROOT_EXIT_POLL_MS));
  }
}

// Cleans up one execution whose worker is gone: anchors the grace window, stops a recorded root
// that is still present by its exact identity, then releases by the evidence or marks stopping.
// The stop reaches the provider's recorded group; with no recorded group (a row from before the
// provider group was recorded, or a provider that led none) POSIX stops the verified root alone,
// and closure stays undecided until the grace window.
async function cleanUpAbsentWorker(store, row, { deadline, opts, rootIdentity, result, retried = false }) {
  if (row.spawn_intent_at === null) {
    const ended = scanStep(() => endDeadClaim(store, row.id, row.exec_gen, opts));
    (ended.ok && ended.value ? result.released : result.skipped).push(row.id);
    return;
  }
  const grace = scanStep(() => startGrace(store, row.id, row.exec_gen, { cause: "owner-death" }, opts));
  if (!grace.ok || grace.value === null) {
    result.skipped.push(row.id);
    return;
  }
  const input = { ...evidenceInputOf(row), graceStartedAt: grace.value };
  let stopResult = null;
  let stoppedAt = null;
  if (input.rootRecorded && confirmIdentity(input.root, rootIdentity) === "present") {
    stopResult = await stopTree(input.root, { deadline, expectedGroupId: row.provider_group_id ?? null, rootAlone: true });
    stoppedAt = stopResult === "stopped" ? wallNow() : null;
    await rootExitAfterStop(input.root, stopResult, deadline);
  }
  let evidence = await observeClosure(input, { deadline, stopResult, stoppedAt });
  if (evidence.root === "present" && stopResult === null) {
    // The first lookup could not tell, but the closure lookup verified the recorded root present:
    // it is stopped by its identity before anything is released.
    stopResult = await stopTree(input.root, { deadline, expectedGroupId: row.provider_group_id ?? null, rootAlone: true });
    stoppedAt = stopResult === "stopped" ? wallNow() : null;
    await rootExitAfterStop(input.root, stopResult, deadline);
    evidence = await observeClosure(input, { deadline, stopResult, stoppedAt });
  }
  if (evidence.root === "present") {
    // A verified live root is never released, not even after the grace window.
    const marked = scanStep(() => markStopping(store, row.id, { cause: "unconfirmed-stop", execGen: row.exec_gen }, opts));
    (marked.ok && marked.value ? result.stopping : result.skipped).push(row.id);
    return;
  }
  const decision = decideRelease(evidence);
  if (decision.kind === "confirmed" || decision.kind === "unobserved") {
    const expectedRoot = row.provider_pid === null ? null : { pid: row.provider_pid };
    const expectedExitSeenAt = row.provider_exit_seen_at ?? null;
    testPoint("scan-before-release");
    const released = scanStep(() =>
      releaseExecution(
        store,
        row.id,
        row.exec_gen,
        { kind: decision.kind, endIfUndecided: { by: "reconcile", reason: row.stop_reason ?? "worker-dead" }, expectedRoot, expectedExitSeenAt },
        opts
      )
    );
    if (released.ok && released.value) {
      result.released.push(row.id);
      return;
    }
    // A provider root, or a worker-seen root exit, recorded after this scan read the row is
    // cleaned up from the fresh row: a live root is stopped by its identity, and a seen exit is
    // credited as the provider's own exit, before any release.
    const fresh = scanStep(() => store.read((db) => getJobRow(db, row.id), opts));
    const changed =
      fresh.ok &&
      claimedUnreleased(fresh.value, row.exec_gen) &&
      (fresh.value.provider_pid !== row.provider_pid || (fresh.value.provider_exit_seen_at ?? null) !== expectedExitSeenAt);
    if (!retried && changed) {
      const freshRoot = await readProcessIdentity(fresh.value.provider_pid, { deadline });
      await cleanUpAbsentWorker(store, fresh.value, { deadline, opts, rootIdentity: freshRoot, result, retried: true });
      return;
    }
    result.skipped.push(row.id);
    return;
  }
  const cause = input.rootRecorded ? "unconfirmed-stop" : "unrecorded-child";
  const marked = scanStep(() => markStopping(store, row.id, { cause, execGen: row.exec_gen }, opts));
  (marked.ok && marked.value ? result.stopping : result.skipped).push(row.id);
}

function remainingOf(deadline) {
  return deadline === undefined || deadline === null ? Infinity : deadline - performance.now();
}

/**
 * One scan of a workspace, each phase under its share of `deadline`: (1) execution cleanup of
 * every claimed, unreleased execution (dead claims, absent workers, stale workers when
 * `heartbeats` is given, workers past their stop deadline); (2) launch failures and launches of
 * each provider's cohort through `launch(jobId)`; (3) automatic continuations of completed or
 * waiting tips with deliverable messages, using `leaderCheck(views)`. Pruning is the caller's.
 */
export async function scanWorkspace(store, { deadline, stateDir = store.stateDir, launch = async () => null, heartbeats = null, leaderCheck = null, attemptMs } = {}) {
  const opts = { deadline, attemptMs };
  const result = { released: [], launched: [], continued: [], stopping: [], skipped: [], launchFailed: [] };
  const started = performance.now();
  const total = remainingOf(deadline);
  const phaseEnd = (share) => (total === Infinity ? undefined : started + total * share);

  // Phase 1: execution cleanup.
  const cleanupDeadline = phaseEnd(0.6);
  const executions = store.read((db) => db.prepare("SELECT * FROM jobs WHERE claimed_at IS NOT NULL AND exec_released_at IS NULL ORDER BY claimed_at, id").all(), opts);
  const pids = executions.flatMap((row) => [row.worker_pid, row.provider_pid]).filter((pid) => Number.isInteger(pid));
  const identities = await readProcessIdentities(pids, { deadline: cleanupDeadline });
  const verdicts = heartbeatVerdicts(heartbeats, stateDir, executions);
  for (const row of executions) {
    if (remainingOf(cleanupDeadline) <= 0) {
      result.skipped.push(row.id);
      continue;
    }
    const workerIdentity = { pid: row.worker_pid, startToken: row.worker_start_token };
    const rootIdentity = identities.get(row.provider_pid) ?? null;
    const worker = confirmIdentity(workerIdentity, identities.get(row.worker_pid));
    if (worker === "unknown") {
      result.skipped.push(row.id);
      continue;
    }
    if (worker === "absent") {
      await cleanUpAbsentWorker(store, row, { deadline: cleanupDeadline, opts, rootIdentity, result });
      continue;
    }
    const pastDeadline = row.stop_deadline !== null && wallNow() > row.stop_deadline;
    const heartbeat = verdicts.get(`${row.id}:${row.exec_gen}`);
    let stopWorker = pastDeadline;
    if (!stopWorker && heartbeat?.verdict === "stale") {
      const again = await readProcessIdentity(row.worker_pid, { deadline: cleanupDeadline });
      if (confirmIdentity(workerIdentity, again) !== "present") {
        result.skipped.push(row.id);
        continue;
      }
      const marked = scanStep(() =>
        markStale(store, row.id, row.exec_gen, { claim: heartbeat.claim, lastValidCounter: heartbeat.lastValidCounter, stateDir }, opts)
      );
      const current = store.read((db) => getJobRow(db, row.id), opts);
      stopWorker = (marked.ok && marked.value) || (current?.stop_deadline !== null && current?.stop_deadline !== undefined && wallNow() > current.stop_deadline);
    }
    if (!stopWorker) {
      continue;
    }
    const stopped = await stopTree(workerIdentity, { deadline: cleanupDeadline, expectedGroupId: row.worker_group_id });
    if (stopped !== "stopped" && stopped !== "absent") {
      result.skipped.push(row.id);
      continue;
    }
    const fresh = store.read((db) => getJobRow(db, row.id), opts);
    if (!claimedUnreleased(fresh, row.exec_gen)) {
      continue;
    }
    const rootNow = fresh.provider_pid === null ? null : await readProcessIdentity(fresh.provider_pid, { deadline: cleanupDeadline });
    await cleanUpAbsentWorker(store, fresh, { deadline: cleanupDeadline, opts, rootIdentity: rootNow, result });
  }

  // Phase 2: launch failures, then each provider's cohort.
  const launchDeadline = phaseEnd(0.85);
  const queued = store.read(
    (db) => db.prepare("SELECT id, provider, launch_attempts, last_launch_at FROM jobs WHERE claimed_at IS NULL AND end_state IS NULL ORDER BY created_at, id").all(),
    opts
  );
  for (const row of queued) {
    if (row.launch_attempts >= LAUNCH_FAILURE_ATTEMPTS && row.last_launch_at !== null && wallNow() - row.last_launch_at > LAUNCH_SPACING_MS) {
      const failed = scanStep(() => endLaunchFailed(store, row.id, { ...opts, observed: { attempts: row.launch_attempts, lastLaunchAt: row.last_launch_at } }));
      if (failed.ok && failed.value) {
        result.launchFailed.push(row.id);
      }
    }
  }
  for (const providerId of [...new Set(queued.map((row) => row.provider))]) {
    if (remainingOf(launchDeadline) <= 0) {
      break;
    }
    const cohort = scanStep(() => readCohort(store, providerId, opts));
    for (const jobId of cohort.ok ? cohort.value.cohort : []) {
      if (remainingOf(launchDeadline) <= 0) {
        break;
      }
      const launched = await launch(jobId);
      if (launched) {
        result.launched.push(jobId);
      }
    }
  }

  // Phase 3: automatic continuations.
  const candidates = store.read((db) => {
    const rows = db
      .prepare(
        `SELECT jobs.* FROM chains JOIN jobs ON jobs.id = chains.tip_job_id
         WHERE jobs.end_state IN ('completed', 'waiting') AND jobs.next_action IS NULL AND jobs.cancelled_at IS NULL
           AND EXISTS (SELECT 1 FROM messages WHERE messages.chain_id = chains.id AND messages.state IN ('pending', 'dispatched'))
         ORDER BY jobs.created_at, jobs.id`
      )
      .all();
    return rows.map((row) => viewOf(db, row));
  }, opts);
  if (candidates.length > 0 && remainingOf(deadline) > 0) {
    const leaders = leaderCheck ? await leaderCheck(candidates) : new Map();
    for (const view of candidates) {
      if (remainingOf(deadline) <= 0) {
        break;
      }
      const leader = leaders.get(view.id) ?? "unknown";
      const decided = scanStep(() => decideNext(store, { ref: view.id, observedTipId: view.id }, { action: "continue", automatic: true, leader }, opts));
      if (decided.ok && decided.value.won) {
        result.continued.push(decided.value.successorId);
        if (await launch(decided.value.successorId)) {
          result.launched.push(decided.value.successorId);
        }
      }
    }
  }
  return result;
}

// Helpers lib/mailbox.mjs uses inside its own transactions. They are not part of the store's
// public interface.
export const storeInternals = Object.freeze({
  getJobRow,
  getChainRow,
  chainForRef,
  tipRowOf,
  viewOf,
  barrierFor,
  fenceHolds,
  insertSuccessor,
  utf8Bytes
});

/**
 * The state of a job's leader from its row and an observed identity: `none` without a recorded
 * leader process, `unknown` with a null token or an unknown lookup, `gone` when confirmed absent,
 * `alive` when confirmed present.
 */
export function leaderState(view, identityResult) {
  const row = view?.row ?? view ?? {};
  if (row.leader_pid === null || row.leader_pid === undefined) {
    return "none";
  }
  if (row.leader_start_token === null || row.leader_start_token === undefined) {
    return "unknown";
  }
  const verdict = confirmIdentity({ pid: row.leader_pid, startToken: row.leader_start_token }, identityResult);
  return verdict === "present" ? "alive" : verdict === "absent" ? "gone" : "unknown";
}
