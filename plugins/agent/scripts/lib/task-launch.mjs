import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

import { createWorktree, removeWorktree } from "./git.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./prompts.mjs";
import { readCohort, readJobView, recordLaunchAttempt, resolveStateDir } from "./state.mjs";
import { boundary, NODE_LAUNCH_FLAGS, wallNow } from "./store.mjs";

// How long send waits for the agent to confirm a message by default.
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

// ---------------------------------------------------------------------------------------------
// Prompt and schema files of a task

const SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

/**
 * The first shape error of an output schema, or null: the root is an object; `type`, when present,
 * is one JSON Schema type name or an array of them; `required`, when present, is an array of
 * strings; `properties`, when present, is an object whose values are objects.
 */
export function checkSchemaShape(schema) {
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(schema)) {
    return "the schema root must be a JSON object";
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const unknown = types.find((type) => !SCHEMA_TYPES.has(type));
    if (types.length === 0 || unknown !== undefined) {
      return `"type" must name JSON Schema types, not ${JSON.stringify(unknown ?? schema.type)}`;
    }
  }
  if (schema.required !== undefined && !(Array.isArray(schema.required) && schema.required.every((key) => typeof key === "string"))) {
    return '"required" must be an array of property names';
  }
  if (schema.properties !== undefined && !(isObject(schema.properties) && Object.values(schema.properties).every(isObject))) {
    return '"properties" must be an object of property schemas';
  }
  return null;
}

/**
 * Reads a task's prompt file and output schema file, relative to `cwd`. The schema is checked by
 * checkSchemaShape and, with `allowQuestions`, prepared for an optional question property; the
 * returned copy is what the job stores, and the file itself is only read. An unreadable file,
 * invalid JSON or a schema error throws `Error("<path>: <reason>")`.
 */
export function readTaskInputFiles(cwd, { promptFile = null, outputSchema = null, allowQuestions = false } = {}) {
  const read = (file) => {
    const full = path.resolve(cwd, String(file));
    try {
      return { full, text: fs.readFileSync(full, "utf8") };
    } catch (error) {
      throw new Error(`${full}: the file cannot be read (${error.code ?? error.message})`);
    }
  };
  const prompt = promptFile ? read(promptFile).text : null;
  if (!outputSchema) {
    return { prompt, schema: null, schemaPath: null };
  }
  const { full, text } = read(outputSchema);
  let schema;
  try {
    schema = JSON.parse(text);
  } catch (error) {
    throw new Error(`${full}: the schema is not valid JSON (${error.message})`);
  }
  const shapeError = checkSchemaShape(schema);
  if (shapeError) {
    throw new Error(`${full}: ${shapeError}`);
  }
  if (!allowQuestions) {
    return { prompt, schema, schemaPath: full };
  }
  try {
    validateQuestionSchema(schema);
  } catch (error) {
    if (error instanceof QuestionSchemaError) {
      throw new Error(`${full}: --allow-questions cannot be used with this schema: ${error.rule}`);
    }
    throw error;
  }
  return { prompt, schema: augmentSchemaForQuestions(schema), schemaPath: full };
}

// ---------------------------------------------------------------------------------------------
// The review handoff of a session

/**
 * The prompt that asks a delegate to address the newest review of a session: the newest job of
 * kind review, of any provider, requested by `sessionId`, with end state completed and stored
 * output (text, else its structured result). Its output fills the review-handoff template of `rootDir`. Without such a job it throws,
 * naming each provider's review command.
 */
export function buildSessionReviewHandoff(store, { sessionId, userRequest = "", rootDir }) {
  const registry = requireModule("./providers.mjs");
  const review = store.read((db) =>
    db
      .prepare(
        `SELECT * FROM jobs WHERE kind = 'review' AND session_id IS ? AND end_state = 'completed'
           AND ((result_text IS NOT NULL AND trim(result_text) <> '') OR result_json IS NOT NULL)
           ORDER BY created_at DESC, id DESC LIMIT 1`
      )
      .get(sessionId ?? null)
  );
  if (!review) {
    const commands = registry.listProviders().map((provider) => provider.reviewCommands.review);
    throw new Error(`No finished review with output was found in this session. Run ${commands.join(" or ")} first.`);
  }
  let request = {};
  try {
    request = JSON.parse(review.request_json);
  } catch {
    request = {};
  }
  const userText = String(userRequest ?? "").trim();
  return interpolateTemplate(loadPromptTemplate(rootDir, "review-handoff"), {
    REVIEWER_LABEL: registry.getProvider(review.provider).label,
    REVIEW_JOB_ID: review.id,
    TARGET_LABEL: request.review?.targetLabel ?? "the reviewed changes",
    REVIEW_OUTPUT: String(review.result_text ?? "").trim() || review.result_json,
    USER_REQUEST: userText ? `Instructions from the user:\n${userText}` : ""
  });
}
