import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { redactSecrets } from "./redact.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
// The temp directory is shared by all users on POSIX systems, so the fallback root is per user.
const FALLBACK_STATE_ROOT_DIR = path.join(
  os.tmpdir(),
  typeof process.getuid === "function" ? `agent-plugin-${process.getuid()}` : "agent-plugin"
);
const LEGACY_STATE_FILE_NAME = "state.json";
const CONFIG_FILE_NAME = "config.json";
const JOBS_DIR_NAME = "jobs";
const MAX_FINISHED_JOBS = 50;
const ACTIVE_STATUSES = new Set(["queued", "running"]);
const CANCELLED_MARKER_SUFFIX = ".cancelled";
const REMOVED_MARKER_SUFFIX = ".removed";
const REMOVED_MARKER_LIFETIME_MS = 60 * 60 * 1000;
const REQUEST_FILE_SUFFIX = ".request.json";
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_CONFIG = Object.freeze({ stopReviewGate: false });
// Fields that hold results, or the prompt in records written before requests had their own
// file. Job listings omit them; `readJobFile` returns them.
const DETAIL_FIELDS = ["request", "result", "rendered"];
// Free-text fields that can repeat a prompt or a credential from tool output.
const REDACTED_FIELDS = ["summary", "errorMessage"];

// On Windows, replacing a file that another process has open fails with EPERM, EACCES, or
// EBUSY until that process closes it, so the rename is retried for a bounded time.
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_RETRY_LIMIT_MS = 1000;

function nowIso() {
  return new Date().toISOString();
}

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

export function resolveStateDir(cwd) {
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, stateDirName(cwd));
}

// A process started without CLAUDE_PLUGIN_DATA writes under the temp-directory root, so
// reads also look there. The configured root comes first and wins for a duplicate job id.
function candidateStateDirs(cwd) {
  const primary = resolveStateDir(cwd);
  const fallback = path.join(FALLBACK_STATE_ROOT_DIR, stateDirName(cwd));
  return primary === fallback ? [primary] : [primary, fallback];
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

// State directories hold prompts and Codex output, so on POSIX systems they are readable by
// their owner only, including directories created before this mode was applied.
const privateDirs = new Set();

function ensurePrivateDir(dir) {
  if (privateDirs.has(dir)) {
    return;
  }
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (process.platform !== "win32") {
    fs.chmodSync(dir, PRIVATE_DIR_MODE);
    fs.chmodSync(path.dirname(dir), PRIVATE_DIR_MODE);
  }
  privateDirs.add(dir);
}

export function ensureStateDir(cwd) {
  ensurePrivateDir(resolveJobsDir(cwd));
}

function isRecordFile(name) {
  return name.endsWith(".json") && !name.endsWith(REQUEST_FILE_SUFFIX);
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

function markerFile(jobFile, suffix) {
  return jobFile.replace(/\.json$/, suffix);
}

function isRemoved(jobFile) {
  return fs.existsSync(markerFile(jobFile, REMOVED_MARKER_SUFFIX));
}

// A cancel marker outranks any status a still-running worker writes after the cancel.
function applyCancelMarker(record, jobFile) {
  if (!fs.existsSync(markerFile(jobFile, CANCELLED_MARKER_SUFFIX))) {
    return record;
  }
  return { ...record, status: "cancelled", phase: "cancelled", pid: null };
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

function summarizeJob(record) {
  const summary = { ...record };
  for (const field of DETAIL_FIELDS) {
    delete summary[field];
  }
  return summary;
}

// Moves a `state.json` index into per-job files and `config.json`, then renames it to
// `state.json.migrated`. Index fields win over a job file's fields, because the index was
// written after the job file for every update.
function migrateLegacyState(cwd) {
  for (const stateDir of candidateStateDirs(cwd)) {
    const legacyFile = path.join(stateDir, LEGACY_STATE_FILE_NAME);
    if (!fs.existsSync(legacyFile)) {
      continue;
    }
    let legacy;
    try {
      legacy = readJsonFile(legacyFile) ?? {};
    } catch {
      legacy = {};
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

export function resolveJobFile(cwd, jobId) {
  const fileName = `${jobId}.json`;
  for (const stateDir of candidateStateDirs(cwd)) {
    const candidate = path.join(stateDir, JOBS_DIR_NAME, fileName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), fileName);
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

/** Reads the full record of a job file, including request and result fields. */
export function readJobFile(jobFile) {
  const record = readJsonFile(jobFile);
  if (!record) {
    throw new Error(`Job file not found: ${jobFile}`);
  }
  return applyCancelMarker(record, jobFile);
}

/** Replaces a job's record. Writes for a removed job are ignored. */
export function writeJobFile(cwd, jobId, payload) {
  migrateLegacyState(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  if (isRemoved(jobFile)) {
    return jobFile;
  }
  const timestamp = nowIso();
  storeRecord(jobFile, applyCancelMarker({ createdAt: timestamp, ...payload, updatedAt: timestamp }, jobFile));
  return jobFile;
}

/** Reads and deletes a job's request, which holds its prompt. Returns null when absent. */
export function takeJobRequest(cwd, jobId) {
  const file = requestFile(resolveJobFile(cwd, jobId));
  const request = readJsonFile(file);
  fs.rmSync(file, { force: true });
  return request;
}

/**
 * Merges `jobPatch` into the job's record, creating it when absent. With `onlyIf`, the patch
 * is applied only when the current record satisfies it; otherwise null is returned.
 */
export function upsertJob(cwd, jobPatch, options = {}) {
  migrateLegacyState(cwd);
  const jobFile = resolveJobFile(cwd, jobPatch.id);
  if (isRemoved(jobFile)) {
    return null;
  }
  const existing = readJsonFile(jobFile);
  if (options.onlyIf && !options.onlyIf(existing ? applyCancelMarker(existing, jobFile) : null)) {
    return null;
  }
  const timestamp = nowIso();
  const next = existing
    ? { ...existing, ...jobPatch, updatedAt: timestamp }
    : { createdAt: timestamp, updatedAt: timestamp, ...jobPatch };
  const stored = storeRecord(jobFile, applyCancelMarker(next, jobFile));
  if (!existing) {
    pruneFinishedJobs(cwd);
  }
  return stored;
}

/** Lists job summaries from every state root, without request and result fields. */
export function listJobs(cwd) {
  migrateLegacyState(cwd);
  const jobs = new Map();
  for (const stateDir of candidateStateDirs(cwd)) {
    const jobsDir = path.join(stateDir, JOBS_DIR_NAME);
    let names;
    try {
      names = fs.readdirSync(jobsDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!isRecordFile(name)) {
        continue;
      }
      const jobFile = path.join(jobsDir, name);
      if (isRemoved(jobFile)) {
        continue;
      }
      let record;
      try {
        record = readJsonFile(jobFile);
      } catch {
        // An unreadable record is left out of the listing rather than failing it.
        continue;
      }
      if (typeof record?.id !== "string" || jobs.has(record.id)) {
        continue;
      }
      // Records written before requests had their own file still hold the prompt.
      if (record.request !== undefined) {
        record = storeRecord(jobFile, record);
      }
      jobs.set(record.id, summarizeJob(applyCancelMarker(record, jobFile)));
    }
  }
  return [...jobs.values()];
}

function removeJobArtifacts(jobFile, record) {
  fs.rmSync(jobFile, { force: true });
  fs.rmSync(markerFile(jobFile, CANCELLED_MARKER_SUFFIX), { force: true });
  fs.rmSync(requestFile(jobFile), { force: true });
  if (record?.logFile) {
    fs.rmSync(record.logFile, { force: true });
  }
}

// Keeps every active job and the newest finished jobs, and deletes removal markers once no
// worker that saw the removal can still be writing.
function pruneFinishedJobs(cwd) {
  const jobsDir = resolveJobsDir(cwd);
  const finished = [];
  for (const name of fs.readdirSync(jobsDir)) {
    if (name.endsWith(REMOVED_MARKER_SUFFIX)) {
      const marker = path.join(jobsDir, name);
      try {
        if (Date.now() - fs.statSync(marker).mtimeMs > REMOVED_MARKER_LIFETIME_MS) {
          fs.rmSync(marker, { force: true });
        }
      } catch {
        // A marker deleted by another process needs no further work.
      }
      continue;
    }
    if (!isRecordFile(name)) {
      continue;
    }
    const jobFile = path.join(jobsDir, name);
    let record;
    try {
      record = readJsonFile(jobFile);
    } catch {
      continue;
    }
    if (record && !ACTIVE_STATUSES.has(applyCancelMarker(record, jobFile).status)) {
      finished.push({ jobFile, record });
    }
  }
  finished
    .sort((left, right) => String(right.record.updatedAt ?? "").localeCompare(String(left.record.updatedAt ?? "")))
    .slice(MAX_FINISHED_JOBS)
    .forEach(({ jobFile, record }) => removeJobArtifacts(jobFile, record));
}

/** Records that a job was cancelled; the job's status reads as cancelled from then on. */
export function markJobCancelled(cwd, jobId) {
  const jobFile = resolveJobFile(cwd, jobId);
  fs.writeFileSync(markerFile(jobFile, CANCELLED_MARKER_SUFFIX), `${nowIso()}\n`, "utf8");
}

/**
 * Deletes a job's record and log. An active job also gets a removal marker, so a worker
 * that is still running cannot write the record again.
 */
export function removeJob(cwd, job) {
  const jobFile = resolveJobFile(cwd, job.id);
  if (ACTIVE_STATUSES.has(job.status)) {
    fs.writeFileSync(markerFile(jobFile, REMOVED_MARKER_SUFFIX), `${nowIso()}\n`, "utf8");
  }
  let record = null;
  try {
    record = readJsonFile(jobFile);
  } catch {
    record = null;
  }
  removeJobArtifacts(jobFile, record ?? job);
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
