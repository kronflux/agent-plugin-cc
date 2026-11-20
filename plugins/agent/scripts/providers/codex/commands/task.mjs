import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  normalizeArgv,
  outputCommandResult,
  parseCommandInput,
  resolveCommandCwd,
  resolveCommandWorkspace
} from "../../../lib/companion-cli.mjs";
import { readStdinIfPiped } from "../../../lib/fs.mjs";
import { readRequesterIdentity } from "../../../lib/host.mjs";
import { reconcileStore } from "../../../lib/job-control.mjs";
import { resolveModelSelection, storedSelection } from "../../../lib/model-selection.mjs";
import { providerForJob } from "../../../lib/providers.mjs";
import { renderTaskResult } from "../../../lib/render.mjs";
import {
  createJob,
  decideNext,
  generateJobId,
  getConfig,
  listJobViews,
  readJobView,
  resolveStateDir
} from "../../../lib/state.mjs";
import { openStoreRetrying, withRetry } from "../../../lib/store.mjs";
import { waitForJob } from "../../../lib/tracked-jobs.mjs";
import {
  attachWorktree,
  buildSessionReviewHandoff,
  discardLaunchWorktree,
  augmentSchemaForQuestions,
  launchWorker,
  readTaskManifest,
  shorten,
  validateQuestionSchema
} from "../../../lib/task-launch.mjs";
import { codexProvider } from "../index.mjs";
import { KNOWN_REASONING_EFFORTS } from "../model-catalog.mjs";
import {
  DEFAULT_CONTINUE_PROMPT,
  ensureCodexAvailable,
  readOutputSchema
} from "../runtime.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const EFFORT_USAGE = `<${KNOWN_REASONING_EFFORTS.join("|")}>`;
export const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

export const usage = `task [--background] [--json] [--write] [--worktree] [--resume-last|--resume|--resume-thread <thread-id>|--fresh] [--force] [--from-last-review] [--label <name>] [--allow-questions] [--model <id|family|default|configured>] [--effort ${EFFORT_USAGE}] [--output-schema <file>] [--manifest <file.json>] [--] [prompt]`;

export function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

export function renderQueuedTaskLaunch(payload) {
  const worktree = payload.worktreePath ? ` It runs in the worktree ${payload.worktreePath} (branch ${payload.worktreeBranch}).` : "";
  return `${payload.title} started in the background as ${payload.jobId}.${worktree} Check /agent:status ${payload.jobId} for progress.\n`;
}

function printWarnings(selection) {
  for (const warning of selection.warnings ?? []) {
    process.stderr.write(`${warning}\n`);
  }
}

/**
 * Resolves the model and effort of a Codex task from its options and the workspace setting. A
 * task that continues a job keeps the model and effort that job's stored request names, except
 * for a value the options give: the job view `continued`, else the newest Codex job of the store
 * on the thread `continuesThreadId`.
 */
export async function resolveTaskSelection(workspaceRoot, cwd, { model, effort, continuesThreadId = null, continued = null } = {}) {
  const job = continued ?? (continuesThreadId ? newestStoreJobOnThread(workspaceRoot, continuesThreadId) : null);
  return resolveModelSelection(codexProvider, {
    model,
    effort,
    setting: getConfig(workspaceRoot).models?.[codexProvider.id] ?? null,
    stored: storedSelectionOf(job),
    cwd
  });
}

// The newest Codex job of the store on `threadId`, or null.
function newestStoreJobOnThread(workspaceRoot, threadId) {
  const { store } = openCommandStore(workspaceRoot);
  try {
    return listJobViews(store, { all: true, limit: 500 }).find((view) => view.row.provider === codexProvider.id && view.row.thread_id === threadId) ?? null;
  } finally {
    store.close();
  }
}

// The newest Codex chain tip of the session `sessionId` that can be continued, in the order
// --resume-last chooses it; null when there is none.
function resumeLastCandidate(workspaceRoot, sessionId) {
  const { store } = openCommandStore(workspaceRoot);
  try {
    return (
      listJobViews(store, { sessionId, all: !sessionId, limit: 500 }).find(
        (view) => view.row.provider === codexProvider.id && view.isTip && (view.row.session_id ?? null) === (sessionId ?? null) && view.resumable
      ) ?? null
    );
  } finally {
    store.close();
  }
}

// The model and effort a job view's stored request names, as storedSelection reads them.
function storedSelectionOf(view) {
  if (!view) {
    return null;
  }
  const { model = null, effort = null, modelSource = null, effortSource = null } = view.request ?? {};
  return storedSelection({ model, effort, modelSource, effortSource });
}

export async function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || (await readStdinIfPiped());
}

export function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

/**
 * Builds a task from the newest finished review of this session in the job store, of either
 * provider, through buildSessionReviewHandoff. Resolves to `{ prompt }`; the prompt names the
 * provider and the job id of that review.
 */
export async function buildReviewHandoff(workspaceRoot, userRequest) {
  const requester = await readRequesterIdentity();
  const { store } = openCommandStore(workspaceRoot);
  try {
    return { prompt: buildSessionReviewHandoff(store, { sessionId: requester.sessionId, userRequest, rootDir: ROOT_DIR }) };
  } finally {
    store.close();
  }
}

// Reads the manifest once and resolves the model and effort of every entry, in entry order,
// before any job starts. Command-line --model and --effort apply to entries that do not set them.
// Returns the entries and their selections, index for index.
async function resolveManifestSelections(cwd, workspaceRoot, options) {
  const entries = readTaskManifest(cwd, options.manifest);
  const selections = [];
  for (const [index, entry] of entries.entries()) {
    try {
      selections.push(
        await resolveTaskSelection(workspaceRoot, cwd, { model: entry.model ?? options.model, effort: entry.effort ?? options.effort })
      );
    } catch (error) {
      throw new Error(`Manifest entry ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { entries, selections };
}

function checkManifestOptions(options, positionals) {
  const conflicting = ["prompt-file", "resume-last", "resume", "resume-thread", "fresh", "from-last-review", "output-schema"].filter(
    (name) => options[name] !== undefined && options[name] !== false
  );
  if (positionals.length > 0 || conflicting.length > 0) {
    throw new Error(
      `--manifest takes its prompts from the file. Remove ${[...conflicting.map((name) => `--${name}`), ...(positionals.length > 0 ? ["the prompt text"] : [])].join(", ")}.`
    );
  }
}

// Starts one background task per manifest entry. Command-line --write and --worktree apply to
// entries that do not set them. `defaults.manifestEntries` holds the entries as they were read
// when their selections were resolved, and `defaults.entries` each entry's resolved selection at
// the same index; the file is then not read again. Without `defaults.manifestEntries` the file is
// read here, and without `defaults.entries` an entry's model and effort, else `defaults.model`
// and `defaults.effort`, are sent as given. `deps.enqueue(cwd, job, fields)` starts one entry: by
// default it creates the entry's store job (`deps.create`, createJob) and launches its worker
// (`deps.launch`, launchWorker). A committed job is accepted: its worktree is kept through any
// launch error or refusal, and the next scan or release launches it. Only an entry that never
// committed has its worktree removed. Returns a promise when an entry's start is asynchronous.
export function launchManifestTasks(cwd, workspaceRoot, options, positionals, defaults, deps = {}) {
  const enqueue = deps.enqueue ?? ((enqueueCwd, job, built) => enqueueStoreEntry(enqueueCwd, job, built, deps));
  checkManifestOptions(options, positionals);
  const entries = defaults.manifestEntries ?? readTaskManifest(cwd, options.manifest);
  if (defaults.manifestEntries && defaults.entries && defaults.entries.length !== entries.length) {
    throw new Error("Each manifest entry needs one resolved selection.");
  }
  ensureCodexAvailable(cwd);

  const launched = [];
  const failed = [];
  const report = () => {
    const lines = [`Started ${launched.length} of ${entries.length} Codex tasks in the background:`];
    for (const job of launched) {
      lines.push(`- ${job.label}: ${job.jobId}${job.worktreePath ? ` (worktree ${job.worktreePath})` : ""}`);
    }
    for (const job of failed) {
      lines.push(`- ${job.label}: not started. ${job.error}`);
    }
    lines.push("Check /agent:status for progress.");
    outputCommandResult({ jobs: launched, failed }, `${lines.join("\n")}\n`, options.json);
    if (failed.length > 0) {
      process.exitCode = 1;
    }
  };
  const accept = (entry, job, result) => {
    const jobId = result?.jobId ?? result?.payload?.jobId ?? job.id;
    launched.push({ label: entry.label, jobId, ...(job.worktreePath ? { worktreePath: job.worktreePath } : {}) });
  };
  const reject = (entry, job, caught) => {
    const committed = Boolean(caught?.committedJobId);
    const error = job?.worktreePath && !committed ? discardLaunchWorktree(workspaceRoot, job, caught) : caught;
    failed.push({ label: entry.label, error: error instanceof Error ? error.message : String(error) });
  };
  const step = (index) => {
    for (; index < entries.length; index += 1) {
      const entry = entries[index];
      let job = null;
      let result;
      try {
        const write = entry.write ?? Boolean(options.write);
        const selection = defaults.entries?.[index] ?? null;
        const baseJob = { id: generateJobId("task"), workspaceRoot, title: `Codex Task: ${entry.label}`, write };
        job = entry.worktree ?? options.worktree ? attachWorktree(baseJob) : baseJob;
        const taskOptions = {
          prompt: entry.prompt,
          title: job.title,
          write,
          sandbox: write ? getConfig(workspaceRoot).writeSandbox ?? "workspace-write" : "read-only",
          worktree: job.worktreePath ? { path: job.worktreePath, branch: job.worktreeBranch } : null,
          model: selection?.model ?? entry.model ?? defaults.model ?? null,
          effort: selection?.effort ?? entry.effort ?? defaults.effort ?? null,
          modelSource: selection?.modelSource ?? null,
          effortSource: selection?.effortSource ?? null,
          background: true,
          runId: options["run-id"] ?? null
        };
        result = enqueue(cwd, job, taskOptions);
      } catch (caught) {
        reject(entry, job, caught);
        continue;
      }
      if (result && typeof result.then === "function") {
        const current = { entry, job };
        return result.then(
          (value) => {
            accept(current.entry, current.job, value);
            return step(index + 1);
          },
          (caught) => {
            reject(current.entry, current.job, caught);
            return step(index + 1);
          }
        );
      }
      accept(entry, job, result);
    }
    report();
    return undefined;
  };
  return step(0);
}

// Creates one manifest entry's store job and launches its worker. Once the job has committed, a
// launch that throws or is refused leaves the entry accepted; the next scan or release launches it.
async function enqueueStoreEntry(cwd, job, taskOptions, deps) {
  const create = deps.create ?? ((store, fields, label) => createJob(store, fields, { label }));
  const launch = deps.launch ?? launchWorker;
  const requester = await readRequesterIdentity();
  const built = buildTaskJobFields(taskOptions, { cwd, requester });
  const { stateDir, store } = openCommandStore(cwd);
  try {
    const created = create(store, built.fields, built.label);
    try {
      await launch(store, stateDir, created.jobId);
    } catch {
      // The committed job is launched by the next scan or release.
    }
    return { jobId: created.jobId };
  } finally {
    store.close();
  }
}

// /agent:codex-fleet passes its arguments after --manifest, so a missing manifest leaves the
// option without a value or followed by another flag.
const MISSING_MANIFEST_MESSAGE = "Name a manifest file: /agent:codex-fleet <manifest.json>";

function parseTaskInput(argv) {
  let parsed;
  try {
    parsed = parseCommandInput(argv, {
      valueOptions: ["model", "effort", "cwd", "prompt-file", "output-schema", "resume-thread", "manifest", "label", "run-id"],
      booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "from-last-review", "worktree", "allow-questions", "force"],
      stopAtFirstPositional: true,
      aliasMap: {
        m: "model"
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Missing value for --manifest") {
      throw new Error(MISSING_MANIFEST_MESSAGE);
    }
    throw error;
  }
  const manifest = parsed.options.manifest;
  if (manifest !== undefined) {
    const text = String(manifest);
    // The parser takes the next token as the value, so a separate token that starts with a dash
    // cannot be told from a flag. The inline form states the path unambiguously.
    const inline = normalizeArgv(argv).some((token) => token.startsWith("--manifest="));
    if (!text.trim()) {
      throw new Error(MISSING_MANIFEST_MESSAGE);
    }
    if (text.startsWith("--") && !inline) {
      throw new Error(MISSING_MANIFEST_MESSAGE);
    }
    if (text.startsWith("-") && !inline) {
      throw new Error(
        `${MISSING_MANIFEST_MESSAGE}. If the path starts with a dash, write --manifest=${text} or ./${text}.`
      );
    }
  }
  return parsed;
}

export async function handleTask(argv) {
  const { options, positionals } = parseTaskInput(argv);

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  if (options.manifest) {
    checkManifestOptions(options, positionals);
    const { entries, selections } = await resolveManifestSelections(cwd, workspaceRoot, options);
    selections.forEach(printWarnings);
    await launchManifestTasks(cwd, workspaceRoot, options, positionals, { model: null, effort: null, manifestEntries: entries, entries: selections });
    return;
  }
  const requestText = await readTaskPrompt(cwd, options, positionals);
  const handoff = options["from-last-review"] ? await buildReviewHandoff(workspaceRoot, requestText) : null;
  const prompt = handoff ? handoff.prompt : requestText;
  const outputSchema = options["output-schema"] ? readOutputSchema(path.resolve(cwd, options["output-schema"])) : null;

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  const resumeThreadId = options["resume-thread"] ? String(options["resume-thread"]).trim() : null;
  if ([resumeLast, fresh, Boolean(resumeThreadId)].filter(Boolean).length > 1) {
    throw new Error("Choose only one of --resume/--resume-last, --resume-thread, and --fresh.");
  }
  requireTaskRequest(prompt, resumeLast || Boolean(resumeThreadId));
  const allowQuestions = Boolean(options["allow-questions"]);
  // A --resume-last successor keeps its tip's question setting; its schema is checked against it.
  if (allowQuestions && outputSchema && !resumeLast) {
    validateQuestionSchema(outputSchema);
  }
  ensureCodexAvailable(cwd);
  // The model is resolved before any job or worktree exists, so a bad choice creates neither. A
  // resumed thread keeps the model and effort of the job that ran it; --resume-last resolves
  // against the tip it continues.
  const continued = resumeLast ? resumeLastCandidate(workspaceRoot, (await readRequesterIdentity()).sessionId ?? null) : null;
  const selection = await resolveTaskSelection(workspaceRoot, cwd, { model: options.model, effort: options.effort, continuesThreadId: resumeThreadId, continued });
  printWarnings(selection);
  const write = Boolean(options.write);
  const runMetadata = buildTaskRunMetadata({ prompt, resumeLast: resumeLast || Boolean(resumeThreadId) });
  const taskOptions = {
    prompt: prompt || (resumeThreadId ? DEFAULT_CONTINUE_PROMPT : ""),
    title: runMetadata.title,
    write,
    sandbox: write ? getConfig(workspaceRoot).writeSandbox ?? "workspace-write" : "read-only",
    worktree: null,
    // The repository a --worktree job gets its worktree from; the worktree is named after the job,
    // so it is created once the job exists.
    worktreeRoot: options.worktree && !resumeLast ? workspaceRoot : null,
    model: selection.model,
    effort: selection.effort,
    modelSource: selection.modelSource,
    effortSource: selection.effortSource,
    outputSchema,
    allowQuestions,
    background: Boolean(options.background),
    fresh,
    json: Boolean(options.json),
    label: options.label ?? null,
    runId: options["run-id"] ?? null,
    threadId: resumeThreadId,
    force: Boolean(options.force),
    resumeLast
  };
  await runStoreTask(cwd, taskOptions);
}

export const run = handleTask;

// ---------------------------------------------------------------------------------------------
// Codex jobs on the job store: one job row per task or review, run by a worker of its own.

// How long a foreground job is waited for before the command leaves it running and exits 75.
const FOREGROUND_WAIT_MS = 6 * 60 * 60 * 1000;
const FOREGROUND_TIMEOUT_EXIT = 75;
const OVERLAP_WARNING = (threadId, jobId) =>
  `Thread ${threadId} was last used by job ${jobId}, whose provider exit was not observed; it may still run and overlap this job.`;

/**
 * The createJob arguments of one Codex task, from the parsed task flags and the prompt:
 * `options` `{ prompt, title, write, sandbox, worktree: { path, branch } | null, model, effort,
 * modelSource, effortSource, outputSchema, allowQuestions, background, fresh, label, runId,
 * threadId, force, review, kind, ephemeral }`. A schema of a job that may ask is stored augmented
 * with the question field. Resolves to `{ fields, label }`.
 */
export function buildTaskJobFields(options, { cwd, requester }) {
  const allowQuestions = Boolean(options.allowQuestions);
  const outputSchema = options.outputSchema ? (allowQuestions ? augmentSchemaForQuestions(options.outputSchema) : options.outputSchema) : null;
  const request = {
    cwd,
    worktree: options.worktree ?? null,
    write: Boolean(options.write),
    sandbox: options.sandbox ?? (options.write ? "workspace-write" : "read-only"),
    model: options.model ?? null,
    effort: options.effort ?? null,
    modelSource: options.modelSource ?? null,
    effortSource: options.effortSource ?? null,
    review: options.review ?? null,
    outputSchema,
    allowQuestions,
    flags: { background: Boolean(options.background), fresh: Boolean(options.fresh) }
  };
  return {
    fields: {
      provider: codexProvider.id,
      kind: options.kind ?? "task",
      title: options.title ?? "Codex Task",
      prompt: options.prompt ?? "",
      request,
      cwd,
      model: options.model ?? null,
      allowQuestions,
      foreground: !options.background,
      threadId: options.threadId ?? null,
      ephemeral: Boolean(options.ephemeral),
      runId: options.runId ?? null,
      requester,
      force: Boolean(options.force)
    },
    label: options.label ?? null
  };
}

// The checks every Codex job passes before a row exists: the schema of a job that may ask has the
// shape a question needs. The prompt size and the label are checked by createJob before any row.
function checkJobOptions(options) {
  if (options.allowQuestions && options.outputSchema && !options.resumeLast) {
    validateQuestionSchema(options.outputSchema);
  }
}

function openCommandStore(cwd) {
  const stateDir = resolveStateDir(cwd);
  return { stateDir, store: openStoreRetrying(stateDir) };
}

// The reply of a background launch: the job id, or with --json the C-CMD object.
function printBackgroundLaunch(store, jobId, json, title) {
  const view = readJobView(store, jobId);
  const row = view?.row ?? {};
  const payload = {
    jobId,
    status: view?.state ?? "queued",
    label: row.label ?? null,
    runId: row.run_id ?? null,
    provider: codexProvider.id,
    chainId: row.chain_id ?? null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null
  };
  const worktree = view?.request?.worktree;
  const rendered = renderQueuedTaskLaunch({ title, jobId, worktreePath: worktree?.path ?? null, worktreeBranch: worktree?.branch ?? null });
  outputCommandResult(payload, rendered, json);
}

// How long one wait for a foreground job lasts before the store is reconciled again.
const FOREGROUND_SLICE_MS = 10000;

/**
 * Waits for a foreground job's end, printing its log once as it grows (unless `json`). Between
 * waits of 10 seconds the store is reconciled, so a job whose worker died is ended by the scan
 * instead of being waited for. Resolves to waitForJob's outcome; `timedOut` once the foreground
 * wait limit has passed with the job still running.
 */
export async function waitStoreJob(stateDir, jobId, { json = false } = {}) {
  const started = performance.now();
  let printed = 0;
  for (;;) {
    let seen = 0;
    const onLog = json
      ? null
      : (text) => {
          const chunk = Buffer.from(text, "utf8");
          const start = seen;
          seen += chunk.length;
          if (seen > printed) {
            process.stderr.write(chunk.subarray(Math.max(0, printed - start)).toString("utf8"));
            printed = seen;
          }
        };
    const outcome = await waitForJob(stateDir, jobId, { until: "end", timeoutMs: FOREGROUND_SLICE_MS, deliver: true, onLog });
    if (!outcome.timedOut || performance.now() - started >= FOREGROUND_WAIT_MS) {
      return outcome;
    }
    try {
      await reconcileStore(stateDir, { deadline: performance.now() + 3000 });
    } catch {
      // A scan that cannot run now is tried again after the next wait.
    }
  }
}

// Waits for a foreground job's end and prints `render(view)`. The exit code follows the end: 0
// for completed or waiting, 1 otherwise, 75 when the wait ends first and the job keeps running.
async function waitForegroundJob(stateDir, jobId, { json, render }) {
  const outcome = await waitStoreJob(stateDir, jobId, { json });
  if (outcome.timedOut) {
    process.stderr.write(`Job ${jobId} is still running; check /agent:status ${jobId}.\n`);
    process.exitCode = FOREGROUND_TIMEOUT_EXIT;
    return;
  }
  const view = outcome.view;
  const state = view?.state ?? "failed";
  const { payload, rendered } = render(view);
  outputCommandResult({ ...payload, jobId, status: state }, rendered, json);
  process.exitCode = state === "completed" || state === "waiting" ? 0 : 1;
}

/**
 * Creates one Codex job and launches its worker (C-CMD): `createJob`, then `launchWorker`. A
 * background job prints its id (or the C-CMD JSON reply); a foreground job is waited for and its
 * result printed. A forced job over a thread barrier prints the overlap warning. With
 * `worktreeRoot` the job records the worktree `<state dir>/worktrees/<job id>` on the branch
 * `agent/<job id>`, which is created from that repository before the job; when it cannot be
 * created no job is created, and when the job cannot be created the worktree is removed.
 */
export async function startStoreJob(cwd, { fields, label }, { background, json, title, render, worktreeRoot = null }) {
  const { stateDir, store } = openCommandStore(cwd);
  try {
    // A worktree job's worktree exists before its row, so no scanner launches the job without it.
    let jobFields = fields;
    let attached = null;
    if (worktreeRoot) {
      const jobId = generateJobId(fields.kind ?? "job");
      try {
        attached = attachWorktree({ id: jobId, workspaceRoot: worktreeRoot });
      } catch (error) {
        throw new Error(`The worktree of ${jobId} could not be created, so no job was created: ${error.message}`);
      }
      jobFields = { ...fields, jobId, request: { ...fields.request, worktree: { path: attached.worktreePath, branch: attached.worktreeBranch } } };
    }
    let created;
    try {
      created = await withRetry((opts) => createJob(store, jobFields, { label }, opts), "command");
    } catch (error) {
      throw attached ? discardLaunchWorktree(worktreeRoot, attached, error) : error;
    }
    if (created.barrierJobId && fields.threadId) {
      process.stderr.write(`${OVERLAP_WARNING(fields.threadId, created.barrierJobId)}\n`);
    }
    await launchWorker(store, stateDir, created.jobId);
    if (background) {
      printBackgroundLaunch(store, created.jobId, json, title);
    }
    return { jobId: created.jobId, stateDir };
  } finally {
    store.close();
  }
}

// The rendered result of a finished Codex task, read from its job row.
function renderStoredTask(view, { title, write }) {
  const row = view?.row ?? {};
  const request = view?.request ?? {};
  const rawOutput = row.result_text ?? "";
  const failureMessage = row.error ?? "";
  const rendered = renderTaskResult(
    { rawOutput, failureMessage, reasoningSummary: [] },
    { title, jobId: row.id ?? null, write, worktreePath: request.worktree?.path ?? null, worktreeBranch: request.worktree?.branch ?? null }
  );
  return {
    payload: {
      ...(request.worktree?.path ? { worktreePath: request.worktree.path, worktreeBranch: request.worktree.branch ?? null } : {}),
      threadId: row.thread_id ?? null,
      rawOutput,
      ...(row.question ? { question: row.question } : {}),
      ...(failureMessage ? { failureMessage } : {})
    },
    rendered
  };
}

/** Runs one Codex task on the store, in the foreground or with --background. */
async function runStoreTask(cwd, options) {
  checkJobOptions(options);
  const requester = await readRequesterIdentity();
  if (options.resumeLast) {
    return runResumeLast(cwd, options, requester);
  }
  const built = buildTaskJobFields(options, { cwd, requester });
  const title = options.title ?? "Codex Task";
  const { jobId, stateDir } = await startStoreJob(cwd, built, { background: options.background, json: options.json, title, worktreeRoot: options.worktreeRoot ?? null });
  if (!options.background) {
    await waitForegroundJob(stateDir, jobId, { json: options.json, render: (view) => renderStoredTask(view, { title, write: options.write }) });
  }
}

// --resume-last continues the newest resumable Codex tip of this session with the prompt as its
// message, or with the continue line when there is no prompt. The successor runs on the resolved
// model and effort of `options`.
async function runResumeLast(cwd, options, requester) {
  const { stateDir, store } = openCommandStore(cwd);
  let successorId;
  try {
    const outputSchema = options.outputSchema ?? null;
    const choices = { model: options.model ?? null, effort: options.effort ?? null, modelSource: options.modelSource ?? null, effortSource: options.effortSource ?? null };
    const decided = await withRetry(
      (opts) =>
        decideNext(
          store,
          { resumeLast: { provider: codexProvider.id, sessionId: requester.sessionId } },
          {
            action: "continue",
            message: options.prompt ? options.prompt : undefined,
            requester,
            outputSchema,
            force: Boolean(options.force),
            withinDecision: (db, { won, successorId: insertedId }) => {
              if (won) {
                applyQuestionSetting(db, insertedId, outputSchema);
                applySelection(db, insertedId, choices);
              }
            }
          },
          opts
        ),
      "command"
    );
    if (!decided.won) {
      throw new Error(`The last Codex job was already continued by ${decided.successorId ?? "another job"}.`);
    }
    successorId = decided.successorId;
    if (decided.barrierJobId) {
      const row = readJobView(store, successorId)?.row;
      process.stderr.write(`${OVERLAP_WARNING(row?.thread_id ?? "unknown", decided.barrierJobId)}\n`);
    }
    await launchWorker(store, stateDir, successorId);
    if (options.background) {
      printBackgroundLaunch(store, successorId, options.json, "Codex Resume");
      return;
    }
  } finally {
    store.close();
  }
  await waitForegroundJob(stateDir, successorId, { json: options.json, render: (view) => renderStoredTask(view, { title: "Codex Resume", write: options.write }) });
}

// Checks a replacement schema against the question setting the successor inherited, inside the
// decision's transaction: a successor that may ask needs a schema without a question field, and
// stores it with one added. A refused schema throws, so no successor is committed.
function applyQuestionSetting(db, successorId, schema) {
  if (!schema) {
    return;
  }
  const row = db.prepare("SELECT allow_questions, request_json FROM jobs WHERE id = ?").get(successorId);
  if (!row.allow_questions) {
    return;
  }
  validateQuestionSchema(schema);
  const request = { ...JSON.parse(row.request_json), outputSchema: augmentSchemaForQuestions(schema) };
  db.prepare("UPDATE jobs SET request_json = ? WHERE id = ?").run(JSON.stringify(request), successorId);
}

// Stores the model and effort a continuation runs with in the successor the decision inserted,
// inside the decision's transaction.
function applySelection(db, successorId, choices) {
  const row = db.prepare("SELECT request_json FROM jobs WHERE id = ?").get(successorId);
  const request = { ...JSON.parse(row.request_json), ...choices };
  db.prepare("UPDATE jobs SET request_json = ?, model = ? WHERE id = ?").run(JSON.stringify(request), choices.model, successorId);
}

/**
 * Prints the newest chain tip of this session's Codex jobs that can be continued: `{ available,
 * jobId, threadId, label, status, provider }` (C-CMD), with null fields when there is none.
 */
export async function runResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  const requester = await readRequesterIdentity();
  const { store } = openCommandStore(cwd);
  let candidate = null;
  try {
    const views = listJobViews(store, { sessionId: requester.sessionId, limit: 200 });
    candidate =
      views.find(
        (view) =>
          view.row.provider === codexProvider.id &&
          view.isTip &&
          view.resumable &&
          ["waiting", "interrupted", "completed", "failed", "cancelled"].includes(view.state)
      ) ?? null;
  } finally {
    store.close();
  }
  const payload = {
    available: Boolean(candidate),
    jobId: candidate?.id ?? null,
    threadId: candidate?.row.thread_id ?? null,
    label: candidate?.row.label ?? null,
    status: candidate?.state ?? null,
    provider: codexProvider.id
  };
  const rendered = candidate ? `Resumable Codex job found: ${candidate.id} (${candidate.state}).\n` : "No resumable Codex job found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}
