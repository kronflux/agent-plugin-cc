import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

import { createWorktree, removeWorktree } from "./git.mjs";
import { generateJobId, readCohort, readJobView, recordLaunchAttempt, resolveStateDir } from "./state.mjs";
import { boundary, NODE_LAUNCH_FLAGS, wallNow } from "./store.mjs";
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
 * trimmed strings, or undefined when the entry does not set them.
 */
export function readTaskManifest(cwd, file) {
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
    return read;
  });
}

// ---------------------------------------------------------------------------------------------
// Questions at a turn boundary

/** The fixed line `--allow-questions` adds to what a job sends. */
export const QUESTION_INSTRUCTION =
  "If you cannot continue without an answer from the requester, end your reply with one final line of the form AGENT-QUESTION: <one question>.";
const QUESTION_MARKER = "AGENT-QUESTION:";

export class QuestionSchemaError extends Error {
  constructor(rule) {
    super(rule);
    this.name = "QuestionSchemaError";
    this.rule = rule;
  }
}

/** Throws QuestionSchemaError unless `schema` can take the added optional `question` property. */
export function validateQuestionSchema(schema) {
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(schema) || schema.type !== "object" || !isObject(schema.properties)) {
    throw new QuestionSchemaError("the output schema root must be an object schema with properties");
  }
  if (Object.prototype.hasOwnProperty.call(schema.properties, "question")) {
    throw new QuestionSchemaError("the output schema already defines a question property");
  }
}

/** A copy of `schema` with an added optional string property `question`. */
export function augmentSchemaForQuestions(schema) {
  const copy = structuredClone(schema);
  copy.properties = { ...copy.properties, question: { type: "string" } };
  return copy;
}

/**
 * The question a turn asked, when questions are allowed: a non-empty structured `question`, else
 * a final non-empty text line that starts with `AGENT-QUESTION:`. An empty structured `question`
 * is removed from the returned JSON.
 */
export function extractQuestion({ text = "", json = null, allowQuestions = false } = {}) {
  if (!allowQuestions) {
    return { question: null, json };
  }
  let output = json;
  if (json && typeof json === "object" && !Array.isArray(json) && Object.prototype.hasOwnProperty.call(json, "question")) {
    if (typeof json.question === "string" && json.question.trim()) {
      return { question: json.question.trim(), json };
    }
    output = { ...json };
    delete output.question;
  }
  const lastLine = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (lastLine && lastLine.startsWith(QUESTION_MARKER)) {
    const question = lastLine.slice(QUESTION_MARKER.length).trim();
    return { question: question || null, json: output };
  }
  return { question: null, json: output };
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

// ---------------------------------------------------------------------------------------------
// Launching workers for queued store jobs

// The provider registry imports the provider modules, which import this module, so it is loaded
// when a worker is first launched.
const requireModule = createRequire(import.meta.url);

function workerEntry(providerId) {
  return process.env.AGENT_PLUGIN_TEST_WORKER_ENTRY || requireModule("./providers.mjs").getProvider(providerId).companionScript;
}

function timeLeft(deadline) {
  return deadline === undefined || deadline === null ? Infinity : deadline - performance.now();
}

/**
 * Launches a detached worker for a queued job after committing the launch attempt; a refused
 * attempt (not in its provider's cohort, held thread, barrier, claimed, ended or launched less than
 * 5 seconds ago) spawns nothing and resolves to null. The job read, the provider module load and
 * the boundary log come before the attempt; once the attempt commits, the spawn follows in the same
 * synchronous run, so a committed attempt always spawns. With `deadline` (a `performance.now()`
 * value) the attempt transaction checks it as its last step before COMMIT: once it has passed
 * nothing is counted and nothing spawns. A spawn already started may finish after the deadline.
 */
export async function launchWorker(store, stateDir, jobId, { deadline = undefined } = {}) {
  if (timeLeft(deadline) <= 0) {
    return null;
  }
  const view = readJobView(store, jobId);
  if (!view) {
    return null;
  }
  const entry = workerEntry(view.provider);
  const args = [...NODE_LAUNCH_FLAGS, entry, "worker", "--state-dir", stateDir, "--job", jobId];
  boundary("spawn");
  let attempt;
  try {
    attempt = recordLaunchAttempt(store, jobId, { now: wallNow() }, deadline === undefined ? {} : { deadline });
  } catch (error) {
    if (deadline !== undefined && timeLeft(deadline) <= 0) {
      return null;
    }
    throw error;
  }
  if (!attempt.ok) {
    return null;
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    child.once("error", () => resolve(null));
    child.once("spawn", () => {
      child.unref();
      resolve({ pid: child.pid });
    });
  });
}

/**
 * The launch a releasing worker runs: one worker per job of its provider's cohort; resolves to
 * the ids launched. With `deadline`, a member's launch starts only before it, checked just before
 * each member; members not launched wait for the next scan. `launch` replaces launchWorker in
 * tests.
 */
export async function launchEligible(store, stateDir, providerId, { deadline = undefined, launch = launchWorker } = {}) {
  const { cohort } = readCohort(store, providerId);
  const launched = [];
  for (const jobId of cohort) {
    if (timeLeft(deadline) <= 0) {
      break;
    }
    if (await launch(store, stateDir, jobId, { deadline })) {
      launched.push(jobId);
    }
  }
  return launched;
}
