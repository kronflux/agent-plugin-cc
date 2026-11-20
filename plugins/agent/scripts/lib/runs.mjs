import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { DEFAULT_PROVIDER_ID, getProvider, listProviders } from "./providers.mjs";
import { redactSecrets } from "./redact.mjs";
import { blankStatusJsonJob, renderStatusJsonJob } from "./render.mjs";
import { resolveActionableTip } from "./state.mjs";
import { NODE_LAUNCH_FLAGS } from "./store.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

// Fleet runs: the manifest that names a fleet's members, and the checks every member passes
// before any job starts.

/** The most members one fleet manifest may name. */
export const MAX_FLEET_MEMBERS = 8;

const NAME_PATTERN = /^[a-z0-9-]{1,40}$/;
const NAME_RULE = "1 to 40 characters from a-z, 0-9 and -";
const TOP_LEVEL_MESSAGE =
  'The manifest must be a JSON object with "manifestVersion": 1 and "members"; "name" and "defaults" are optional.';

const TOP_LEVEL_KEYS = new Set(["manifestVersion", "name", "defaults", "members"]);
const DEFAULT_KEYS = new Set(["provider", "write", "worktree", "model", "effort"]);
const MEMBER_KEYS = new Set([
  "label",
  "provider",
  "kind",
  "prompt",
  "promptFile",
  "write",
  "worktree",
  "model",
  "effort",
  "outputSchema",
  "allowQuestions",
  "review"
]);
const REVIEW_KEYS = new Set(["target", "paths", "stance"]);
const REVIEW_TARGETS = ["auto", "changes", "project"];
const REVIEW_STANCES = ["peer", "critical"];
const KINDS = ["task", "review"];

// The type each key must have when present: a key whose value is null counts as absent.
const KEY_TYPES = {
  label: "string",
  name: "string",
  provider: "string",
  kind: "string",
  prompt: "string",
  promptFile: "string",
  write: "boolean",
  worktree: "boolean",
  allowQuestions: "boolean",
  model: "string",
  effort: "string",
  outputSchema: "string",
  review: "object"
};

/** A manifest problem; `message` is the text the fleet prints before it exits with code 1. */
export class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = "ManifestError";
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function present(value) {
  return value !== undefined && value !== null;
}

// The first key of `object` that is not in `allowed`, or undefined.
function unknownKey(object, allowed) {
  return Object.keys(object).find((key) => !allowed.has(key));
}

// The first type problem of the present keys of `object`, as `<key> must be <type>`, or null.
function typeProblem(object, keys, prefix = "") {
  for (const key of keys) {
    const value = object[key];
    if (!present(value)) {
      continue;
    }
    const expected = KEY_TYPES[key];
    const actual = Array.isArray(value) ? "array" : typeof value;
    if (actual !== expected) {
      return `${prefix}${key} must be ${expected}`;
    }
  }
  return null;
}

function readManifestJson(file, cwd) {
  const full = path.resolve(cwd, String(file));
  let text;
  try {
    text = fs.readFileSync(full, "utf8");
  } catch (error) {
    throw new ManifestError(`Could not read the manifest ${full}: ${error.code ?? error.message}`);
  }
  try {
    return { full, value: JSON.parse(text) };
  } catch (error) {
    throw new ManifestError(`The manifest ${full} is not valid JSON: ${error.message}`);
  }
}

function checkDefaults(defaults) {
  if (!present(defaults)) {
    return {};
  }
  if (!isObject(defaults)) {
    throw new ManifestError("The manifest's defaults must be object.");
  }
  const unknown = unknownKey(defaults, DEFAULT_KEYS);
  if (unknown !== undefined) {
    throw new ManifestError(`The manifest's defaults have an unknown key "${unknown}".`);
  }
  const problem = typeProblem(defaults, DEFAULT_KEYS, "defaults.");
  if (problem) {
    throw new ManifestError(`The manifest's ${problem}.`);
  }
  return defaults;
}

// The real path of `file`, with symbolic links and junctions resolved and case-folded on Windows;
// throws when it cannot be resolved.
function comparablePath(file) {
  const real = fs.realpathSync.native(file);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

// The real paths of the folders a member's files may lie in: the manifest's folder and the
// workspace (the git repository root of `cwd`, or `cwd` outside a repository).
function containmentRoots(baseDir, cwd) {
  const roots = [];
  for (const folder of [baseDir, resolveWorkspaceRoot(cwd)]) {
    try {
      roots.push(comparablePath(folder));
    } catch {
      // A folder that cannot be resolved holds no file either.
    }
  }
  return roots;
}

// True when the real path `real` is `root` or lies inside it.
function isInside(real, root) {
  const relative = path.relative(root, real);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Reads a file a member names, resolved against the manifest's folder; throws the member problem
// when it cannot be read, or, unless `roots` is null, when its real path is inside none of `roots`
// (real paths, case-folded on Windows), before reading it.
function readMemberFile(baseDir, key, file, roots) {
  const full = path.resolve(baseDir, file);
  if (roots) {
    let real;
    try {
      real = comparablePath(full);
    } catch (error) {
      throw new MemberProblem(`${key} ${full} cannot be read (${error.code ?? error.message})`);
    }
    if (!roots.some((root) => isInside(real, root))) {
      throw new MemberProblem(
        `${key} ${full} is outside the manifest's folder and the workspace; pass --allow-outside-files to fleet start to read it.`
      );
    }
  }
  try {
    return { full, text: fs.readFileSync(full, "utf8") };
  } catch (error) {
    throw new MemberProblem(`${key} ${full} cannot be read (${error.code ?? error.message})`);
  }
}

class MemberProblem extends Error {}

function checkReview(review) {
  const unknown = unknownKey(review, REVIEW_KEYS);
  if (unknown !== undefined) {
    throw new MemberProblem(`unknown key "${unknown}" in review`);
  }
  if (!REVIEW_TARGETS.includes(review.target)) {
    throw new MemberProblem(`review.target must be one of ${REVIEW_TARGETS.join(", ")}`);
  }
  let paths = [];
  if (present(review.paths)) {
    if (!Array.isArray(review.paths) || !review.paths.every((entry) => typeof entry === "string" && entry.trim())) {
      throw new MemberProblem("review.paths must be an array of non-blank strings");
    }
    paths = [...review.paths];
  }
  let stance = null;
  if (present(review.stance)) {
    if (!REVIEW_STANCES.includes(review.stance)) {
      throw new MemberProblem(`review.stance must be one of ${REVIEW_STANCES.join(", ")}`);
    }
    stance = review.stance;
  }
  return { target: review.target, paths, stance };
}

// Checks one member in the fixed rule order and returns it normalised; throws MemberProblem.
function checkMember(entry, index, { defaults, baseDir, roots, inGitRepo, labels }) {
  if (!isObject(entry)) {
    throw new MemberProblem("a member must be object");
  }
  const unknown = unknownKey(entry, MEMBER_KEYS);
  if (unknown !== undefined) {
    throw new MemberProblem(`unknown key "${unknown}"`);
  }
  const typeError = typeProblem(entry, MEMBER_KEYS);
  if (typeError) {
    throw new MemberProblem(typeError);
  }
  if (!present(entry.label)) {
    throw new MemberProblem("label is required");
  }
  if (!NAME_PATTERN.test(entry.label)) {
    throw new MemberProblem(`label must be ${NAME_RULE}`);
  }
  for (const key of ["prompt", "promptFile"]) {
    if (present(entry[key]) && !entry[key].trim()) {
      throw new MemberProblem(`${key} must not be blank`);
    }
  }
  if (present(entry.prompt) === present(entry.promptFile)) {
    throw new MemberProblem("give exactly one of prompt and promptFile");
  }
  const providerIds = listProviders().map((provider) => provider.id);
  const provider = entry.provider ?? defaults.provider ?? DEFAULT_PROVIDER_ID;
  if (!providerIds.includes(provider)) {
    throw new MemberProblem(`provider "${provider}" is not known; known providers: ${providerIds.join(", ")}`);
  }
  const kind = entry.kind ?? "task";
  if (!KINDS.includes(kind)) {
    throw new MemberProblem(`kind must be one of ${KINDS.join(", ")}`);
  }
  if (kind === "review" && !present(entry.review)) {
    throw new MemberProblem("a review member needs review");
  }
  if (kind === "task" && present(entry.review)) {
    throw new MemberProblem("review is only available on a review member");
  }
  if (kind === "review") {
    if (present(entry.outputSchema)) {
      throw new MemberProblem("outputSchema is not available on a review member");
    }
    for (const key of ["allowQuestions", "write", "worktree"]) {
      if (entry[key] === true) {
        throw new MemberProblem(`${key} is not available on a review member`);
      }
    }
  }
  const review = kind === "review" ? checkReview(entry.review) : null;
  let prompt = present(entry.prompt) ? entry.prompt : null;
  let promptFile = null;
  if (present(entry.promptFile)) {
    const read = readMemberFile(baseDir, "promptFile", entry.promptFile, roots);
    if (!read.text.trim()) {
      throw new MemberProblem(`promptFile ${read.full} is blank`);
    }
    promptFile = read.full;
    if (kind === "review") {
      prompt = read.text;
    }
  }
  let outputSchema = null;
  if (present(entry.outputSchema)) {
    const read = readMemberFile(baseDir, "outputSchema", entry.outputSchema, roots);
    let schema;
    try {
      schema = JSON.parse(read.text);
    } catch {
      schema = null;
    }
    if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
      throw new MemberProblem(`outputSchema ${read.full} is not a JSON object`);
    }
    outputSchema = read.full;
  }
  if (kind === "review" && !String(prompt ?? "").trim()) {
    throw new MemberProblem("the review's prompt is blank; a review member needs instructions");
  }
  const earlier = labels.get(entry.label);
  if (earlier !== undefined) {
    throw new MemberProblem(`repeats the label of entry ${earlier}`);
  }
  labels.set(entry.label, index + 1);
  if (index >= MAX_FLEET_MEMBERS) {
    throw new MemberProblem(`a fleet has at most ${MAX_FLEET_MEMBERS} members`);
  }
  const write = kind === "review" ? false : entry.write ?? defaults.write ?? false;
  const worktree = kind === "review" ? false : entry.worktree ?? defaults.worktree ?? false;
  if (worktree && !inGitRepo) {
    throw new MemberProblem("worktree needs a git repository, and this folder is not in one");
  }
  return {
    label: entry.label,
    provider,
    kind,
    prompt,
    promptFile,
    write,
    worktree,
    model: entry.model ?? defaults.model ?? null,
    effort: entry.effort ?? defaults.effort ?? null,
    outputSchema,
    allowQuestions: kind === "review" ? false : entry.allowQuestions ?? false,
    review
  };
}

function memberPrefix(entry, index) {
  const label = isObject(entry) && typeof entry.label === "string" && entry.label ? entry.label : null;
  return label ? `Manifest member "${label}" (entry ${index + 1})` : `Manifest entry ${index + 1}`;
}

/**
 * Reads and checks a fleet manifest (version 1) before anything starts, resolving `file` against
 * `cwd`. Members are checked in order and the first problem throws ManifestError. Returns `{ name,
 * members }`; each member is normalised with its prompt and schema files resolved against the
 * manifest's folder, and a review member's prompt file read into `prompt`. A prompt or schema file
 * whose real path is outside both the manifest's folder and the workspace of `cwd` is refused
 * before it is read, unless `allowOutsideFiles` is true.
 */
export function readFleetManifest(file, { cwd = process.cwd(), inGitRepo = false, allowOutsideFiles = false } = {}) {
  const { full, value } = readManifestJson(file, cwd);
  if (!isObject(value) || value.manifestVersion !== 1 || !Array.isArray(value.members)) {
    throw new ManifestError(TOP_LEVEL_MESSAGE);
  }
  const unknown = unknownKey(value, TOP_LEVEL_KEYS);
  if (unknown !== undefined) {
    throw new ManifestError(`The manifest has an unknown key "${unknown}".`);
  }
  const nameProblem = typeProblem(value, ["name"]);
  if (nameProblem) {
    throw new ManifestError(`The manifest's ${nameProblem}.`);
  }
  if (present(value.name) && !NAME_PATTERN.test(value.name)) {
    throw new ManifestError(`The manifest's name must be ${NAME_RULE}.`);
  }
  const defaults = checkDefaults(value.defaults);
  if (value.members.length === 0) {
    throw new ManifestError("The manifest lists no members.");
  }
  const baseDir = path.dirname(full);
  const roots = allowOutsideFiles ? null : containmentRoots(baseDir, cwd);
  const context = { defaults, baseDir, roots, inGitRepo, labels: new Map() };
  const members = value.members.map((entry, index) => {
    try {
      return checkMember(entry, index, context);
    } catch (error) {
      if (error instanceof MemberProblem) {
        throw new ManifestError(`${memberPrefix(entry, index)}: ${error.message}`);
      }
      throw error;
    }
  });
  return { name: value.name ?? null, members };
}

// ---------------------------------------------------------------------------------------------
// Running a provider's companion

/** How long a provider's readiness check may take. */
export const PROVIDER_CHECK_TIMEOUT_MS = 30000;

/**
 * Runs `node <script> ...args` without a shell and resolves to `{ code, stdout, stderr, error,
 * timedOut }`. After `timeoutMs` the child this call started is stopped through its own handle.
 */
export function runCompanion(script, args, { cwd, env, timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [...NODE_LAUNCH_FLAGS, script, ...args], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", error, timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill();
          }, timeoutMs)
        : null;
    const finish = (outcome) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve({ stdout, stderr, timedOut, ...outcome });
    };
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => finish({ code: null, error }));
    child.once("close", (code) => finish({ code, error: null }));
  });
}

function firstChars(text, limit = 200) {
  const trimmed = String(text ?? "").trim();
  return trimmed ? trimmed.slice(0, limit) : "(no output)";
}

// The readiness of one provider from its `setup --json` run.
async function checkProvider(id, { cwd, env }) {
  const provider = getProvider(id);
  const outcome = await runCompanion(provider.companionScript, ["setup", "--json"], { cwd, env, timeoutMs: PROVIDER_CHECK_TIMEOUT_MS });
  if (outcome.timedOut) {
    return { id, ok: false, reason: `no answer within ${PROVIDER_CHECK_TIMEOUT_MS / 1000} seconds` };
  }
  if (outcome.error) {
    return { id, ok: false, reason: `could not run setup: ${outcome.error.message}` };
  }
  let report;
  try {
    report = JSON.parse(outcome.stdout);
  } catch {
    report = null;
  }
  if (!isObject(report)) {
    return { id, ok: false, reason: `setup --json printed no readable report: ${firstChars(outcome.stdout)}` };
  }
  if (report.ready === true) {
    return { id, ok: true, reason: null };
  }
  const step = Array.isArray(report.nextSteps) ? report.nextSteps.find((entry) => typeof entry === "string" && entry.trim()) : null;
  return { id, ok: false, reason: step ?? "setup --json reported ready: false" };
}

/**
 * Checks each distinct provider once, in parallel, with its companion's `setup --json`: the CLI is
 * installed and signed in. Resolves to `[{ id, ok, reason }]` in first-mention order; `reason` is
 * null when the provider is ready.
 */
export async function checkProviders(providerIds, { cwd = process.cwd(), env = process.env } = {}) {
  const ids = [...new Set(providerIds)];
  return Promise.all(ids.map((id) => checkProvider(id, { cwd, env })));
}

/** The line the fleet prints for a provider that failed its check. */
export function providerFailureLine({ id, reason }) {
  return `Provider ${id} (${getProvider(id).label}) failed the check: ${reason}. Nothing was started.`;
}

// ---------------------------------------------------------------------------------------------
// Run records

/** The version of the run record a fleet writes to `runs/<run-id>.json`. */
export const RUN_RECORD_SCHEMA = 1;
const RUN_ID_PATTERN = /^run-\d+-[0-9a-f]{8}$/;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/** A new run id: `run-<epoch ms>-<8 lowercase hex>`. */
export function newRunId() {
  return `run-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

/** True when `value` has the form of a run id. */
export function isRunId(value) {
  return typeof value === "string" && RUN_ID_PATTERN.test(value);
}

function runRecordPath(stateDir, runId) {
  if (!isRunId(runId)) {
    throw new Error(`"${runId}" is not a run id.`);
  }
  return path.join(stateDir, "runs", `${runId}.json`);
}

/**
 * Writes `record` to `runs/<record.id>.json` in the state folder through a temporary file and a
 * rename, so a reader sees the old record or the new one, never a part. Returns the path.
 */
export function writeRunRecord(stateDir, record) {
  const file = runRecordPath(stateDir, record.id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  return file;
}

/** The run record of `runId`, or null when the state folder has none. */
export function readRunRecord(stateDir, runId) {
  if (!isRunId(runId)) {
    return null;
  }
  let text;
  try {
    text = fs.readFileSync(runRecordPath(stateDir, runId), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return JSON.parse(text);
}

/**
 * Records the start outcome of every member, once: `outcomes[i]` is `{ jobId }` or `{ startError }`
 * for the record's member `i`. Sets `finalizedAt` and rewrites the record; a start error is stored
 * redacted. Throws when the record is missing or already finalised. Returns the new record.
 */
export function finalizeRunRecord(stateDir, runId, outcomes) {
  const record = readRunRecord(stateDir, runId);
  if (!record) {
    throw new Error(`No run record ${runId} to finalise.`);
  }
  if (record.finalizedAt) {
    throw new Error(`The run record ${runId} was already finalised at ${record.finalizedAt}.`);
  }
  if (!Array.isArray(outcomes) || outcomes.length !== record.members.length) {
    throw new Error(`The run record ${runId} needs one outcome per member.`);
  }
  const members = record.members.map((member, index) => {
    const outcome = outcomes[index] ?? {};
    const jobId = typeof outcome.jobId === "string" && outcome.jobId ? outcome.jobId : null;
    const startError = jobId ? null : redactSecrets(String(outcome.startError || "the member did not start"));
    return { ...member, jobId, startError };
  });
  const finalized = { ...record, members, finalizedAt: new Date().toISOString() };
  writeRunRecord(stateDir, finalized);
  return finalized;
}

/** A new, unfinalised fleet run record (schema 1) for normalised manifest members. */
export function buildRunRecord({ id, name = null, sessionId = null, members }) {
  return {
    schema: RUN_RECORD_SCHEMA,
    id,
    kind: "fleet",
    name: name ?? null,
    createdAt: new Date().toISOString(),
    sessionId: sessionId ?? null,
    finalizedAt: null,
    members: members.map((member) => ({ label: member.label, provider: member.provider, jobId: null, startError: null }))
  };
}

// ---------------------------------------------------------------------------------------------
// Starting a member

/** How long one member's background launch may take. */
export const MEMBER_START_TIMEOUT_MS = 120000;

/** The companion arguments that start `member` as a background job of `runId`. */
export function memberStartArguments(member, runId) {
  const args = [member.kind, "--background", "--json", "--label", member.label, "--run-id", runId];
  const selection = [...(member.model ? ["--model", member.model] : []), ...(member.effort ? ["--effort", member.effort] : [])];
  if (member.kind === "review") {
    args.push("--target", member.review.target);
    for (const entry of member.review.paths ?? []) {
      args.push("--path", entry);
    }
    if (member.review.stance) {
      args.push("--stance", member.review.stance);
    }
    args.push(...selection, "--", member.prompt);
    return args;
  }
  if (member.write) {
    args.push("--write");
  }
  if (member.worktree) {
    args.push("--worktree");
  }
  args.push(...selection);
  if (member.outputSchema) {
    args.push("--output-schema", member.outputSchema);
  }
  if (member.allowQuestions) {
    args.push("--allow-questions");
  }
  if (member.promptFile) {
    args.push("--prompt-file", member.promptFile);
  } else {
    args.push("--", member.prompt);
  }
  return args;
}

function firstLine(text) {
  return (
    String(text ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

/**
 * Starts one member as a labelled background job of `runId` through its provider's companion.
 * Resolves to `{ jobId }` when the companion exits 0 with a non-empty `jobId` in its JSON reply,
 * else to `{ startError }` with a non-empty reason. `companionScript` replaces the provider's.
 */
export async function startMember(member, { cwd = process.cwd(), env = process.env, runId, companionScript = null } = {}) {
  const id = member.provider;
  const script = companionScript ?? getProvider(id).companionScript;
  const outcome = await runCompanion(script, memberStartArguments(member, runId), { cwd, env, timeoutMs: MEMBER_START_TIMEOUT_MS });
  if (outcome.timedOut) {
    return { startError: `${id} companion gave no answer within ${MEMBER_START_TIMEOUT_MS / 1000} seconds` };
  }
  if (outcome.error) {
    return { startError: `${id} companion could not run: ${outcome.error.message}` };
  }
  if (outcome.code !== 0) {
    return { startError: `${id} companion exited ${outcome.code}: ${firstLine(outcome.stderr) ?? "(no error output)"}` };
  }
  let reply = null;
  try {
    reply = JSON.parse(outcome.stdout);
  } catch {
    reply = null;
  }
  if (isObject(reply) && typeof reply.jobId === "string" && reply.jobId) {
    return { jobId: reply.jobId };
  }
  return { startError: `${id} companion gave no job id: ${firstChars(outcome.stdout)}` };
}

// ---------------------------------------------------------------------------------------------
// A run's members as job rows

/** The reason a member of a record that was never finalised shows when it has no job. */
export const START_UNKNOWN_REASON = "the fleet stopped before this member's start was recorded";

// The id of the first job a record member started: its recorded job id, or for a record that was
// never finalised, the oldest job of the run with the member's label.
function firstJobIdOf(db, record, member) {
  if (member.jobId) {
    return member.jobId;
  }
  if (member.startError) {
    return null;
  }
  return (
    db.prepare("SELECT id FROM jobs WHERE run_id = ? AND label = ? ORDER BY created_at, id LIMIT 1").get(record.id, member.label)?.id ?? null
  );
}

/**
 * Each record member, in record order, as `{ label, provider, view, status, startError }`: `view`
 * is the job view of the tip of the member's chain, or null with `status` `start-failed`,
 * `start-unknown` (a record never finalised with no job of the member's label) or `pruned` (its
 * chain was deleted). Reads only; nothing is started or changed.
 */
export function readRunMemberViews(store, record, opts = {}) {
  const firstIds = store.read((db) => record.members.map((member) => firstJobIdOf(db, record, member)), opts);
  return record.members.map((member, index) => {
    const base = { label: member.label, provider: member.provider };
    if (member.startError && !member.jobId) {
      return { ...base, view: null, status: "start-failed", startError: member.startError };
    }
    const firstId = firstIds[index];
    if (!firstId) {
      return { ...base, view: null, status: "start-unknown", startError: START_UNKNOWN_REASON };
    }
    const view = resolveActionableTip(store, firstId, opts);
    if (!view) {
      return { ...base, view: null, status: "pruned", startError: null };
    }
    return { ...base, view, status: view.state, startError: null };
  });
}

/**
 * Each record member, in record order, as the `status --json` object of its chain's tip plus
 * `startError`; a member without a job row has its label, provider, status (`start-failed`,
 * `start-unknown` or `pruned`) and start error, and null for every other field.
 */
export function listRunMembers(store, record, opts = {}) {
  return readRunMemberViews(store, record, opts).map(memberStatusObject);
}

/** The `status --json` object plus `startError` of one `readRunMemberViews` entry. */
export function memberStatusObject(entry) {
  if (entry.view) {
    return { ...renderStatusJsonJob(entry.view), startError: null };
  }
  return { ...blankStatusJsonJob({ label: entry.label, provider: entry.provider, status: entry.status }), startError: entry.startError };
}
