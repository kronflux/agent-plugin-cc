import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { createWorktree, removeWorktree } from "./git.mjs";
import { generateJobId, resolveStateDir } from "./state.mjs";
import { createJobRecord } from "./tracked-jobs.mjs";

// How long send waits for the agent to confirm a message by default, and how long a provider's
// companion may take to start a follow-up turn.
export const DEFAULT_SEND_TIMEOUT_MS = 60000;

export function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

export function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

/** Creates the record of a new job that `provider` runs. Extra fields are kept on the record. */
export function createProviderJob(provider, { prefix, kind, kindLabel, title, workspaceRoot, jobClass, summary, write = false, ...extra }) {
  return createJobRecord({
    id: generateJobId(prefix),
    provider: provider.id,
    kind,
    kindLabel,
    title,
    workspaceRoot,
    jobClass,
    summary,
    write,
    ...extra
  });
}

// A worktree job gets its own checkout of HEAD under the state directory, on the new branch
// agent/<job-id>. The job's record stays with the repository; only the agent works in the worktree.
export function attachWorktree(job) {
  const worktreePath = path.join(resolveStateDir(job.workspaceRoot), "worktrees", job.id);
  const worktreeBranch = `agent/${job.id}`;
  createWorktree(job.workspaceRoot, worktreePath, worktreeBranch);
  return { ...job, worktreePath, worktreeBranch };
}

// Removes the worktree a failed launch created and returns the launch's error (null when there
// is none), extended with the reason when the worktree cannot be removed.
export function discardLaunchWorktree(workspaceRoot, { worktreePath, worktreeBranch }, error) {
  try {
    removeWorktree(workspaceRoot, worktreePath, worktreeBranch);
    return error;
  } catch (cleanupError) {
    const message = error == null ? "" : `${error instanceof Error ? error.message : String(error)} `;
    return new Error(`${message}The worktree ${worktreePath} (branch ${worktreeBranch}) could not be removed: ${cleanupError.message}`);
  }
}

// newWorktree marks a worktree created for this request, which a failed start removes; a
// follow-up turn in an earlier job's worktree leaves it in place.
export function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, resumeThreadId = null, jobId, outputSchema = null, worktreePath = null, worktreeBranch = null, newWorktree = false }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    resumeThreadId,
    jobId,
    outputSchema,
    worktreePath,
    worktreeBranch,
    newWorktree: Boolean(worktreePath && newWorktree)
  };
}

export const MANIFEST_FIELDS = new Set(["label", "prompt", "model", "effort", "write", "worktree"]);
export const MANIFEST_SHAPE = "a JSON array of {label, prompt, model?, effort?, write?, worktree?}";

function trimmedOrUndefined(value) {
  if (value == null) {
    return undefined;
  }
  return String(value).trim() || undefined;
}

/**
 * Reads and checks every manifest entry before any job starts. An entry's model and effort are
 * trimmed strings, or undefined when the entry does not set them. `checkEntry(read, raw)`, when
 * given, runs on each entry as it is read, with the entry as written in the file, and returns
 * the entry to keep, so its error comes in entry order with the shape errors.
 */
export function readTaskManifest(cwd, file, checkEntry = null) {
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(path.resolve(cwd, file), "utf8"));
  } catch (error) {
    throw new Error(`Could not read the manifest ${file}: ${error.message}`);
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`The manifest must be ${MANIFEST_SHAPE}.`);
  }
  const labels = new Set();
  return entries.map((entry, index) => {
    const position = `Manifest entry ${index + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${position} is not an object. The manifest must be ${MANIFEST_SHAPE}.`);
    }
    const unknown = Object.keys(entry).filter((key) => !MANIFEST_FIELDS.has(key));
    if (unknown.length > 0) {
      throw new Error(`${position} has unknown fields: ${unknown.join(", ")}.`);
    }
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    const prompt = typeof entry.prompt === "string" ? entry.prompt.trim() : "";
    if (!label || !prompt) {
      throw new Error(`${position} needs a label and a prompt.`);
    }
    if (labels.has(label)) {
      throw new Error(`${position} repeats the label "${label}".`);
    }
    labels.add(label);
    for (const flag of ["write", "worktree"]) {
      if (entry[flag] !== undefined && typeof entry[flag] !== "boolean") {
        throw new Error(`${position}: ${flag} must be true or false.`);
      }
    }
    const read = {
      label,
      prompt,
      model: trimmedOrUndefined(entry.model),
      effort: trimmedOrUndefined(entry.effort),
      write: entry.write,
      worktree: entry.worktree
    };
    return checkEntry ? checkEntry(read, entry) : read;
  });
}

// Another provider's follow-up turn is started by that provider's companion as a new
// background task on the same thread.
export function startTurnWithProviderCompanion(cwd, provider, job, text, deps = { spawnSyncImpl: spawnSync }) {
  const spawnSyncImpl = deps.spawnSyncImpl ?? spawnSync;
  const label = provider.label;
  const result = spawnSyncImpl(
    process.execPath,
    [provider.companionScript, "task", "--background", "--json", "--cwd", cwd, "--resume-thread", job.threadId, ...(job.write ? ["--write"] : []), "--", text],
    { cwd, env: process.env, encoding: "utf8", windowsHide: true, timeout: DEFAULT_SEND_TIMEOUT_MS }
  );
  if (result.error?.code === "ETIMEDOUT" || result.signal) {
    throw new Error(`${label} did not start the turn within ${Math.round(DEFAULT_SEND_TIMEOUT_MS / 1000)} s.`);
  }
  if (result.error) {
    throw new Error(`${label} could not start the turn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(String(result.stderr || `${label} could not start the turn.`).trim());
  }
  let launched;
  try {
    launched = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} started the turn but printed output that is not JSON: ${firstMeaningfulLine(result.stdout, "")}`);
  }
  const newJobId = launched?.jobId;
  if (typeof newJobId !== "string" || !newJobId.trim()) {
    throw new Error(`${label} printed no job id for the new turn.`);
  }
  return { status: "started", jobId: job.id, newJobId, threadId: job.threadId };
}
