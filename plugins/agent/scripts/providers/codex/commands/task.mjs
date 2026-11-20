import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isActiveJobStatus } from "../../../commands/status.mjs";
import {
  enqueueBackgroundTask,
  outputCommandResult,
  parseCommandInput,
  resolveCommandCwd,
  resolveCommandWorkspace,
  runForegroundCommand
} from "../../../lib/companion-cli.mjs";
import { readStdinIfPiped } from "../../../lib/fs.mjs";
import { getSessionId } from "../../../lib/host.mjs";
import { readStoredJob, reconcileJobLiveness, sortJobsNewestFirst } from "../../../lib/job-control.mjs";
import { newestJobOnThread, resolveModelSelection, storedSelection } from "../../../lib/model-selection.mjs";
import { interpolateTemplate, loadPromptTemplate } from "../../../lib/prompts.mjs";
import { renderTaskResult } from "../../../lib/render.mjs";
import { getConfig, listJobs, takeJobMessages, upsertJob, writeJobMessageOutcome } from "../../../lib/state.mjs";
import {
  attachWorktree,
  buildTaskRequest,
  createProviderJob,
  discardLaunchWorktree,
  firstMeaningfulLine,
  readTaskManifest,
  shorten
} from "../../../lib/task-launch.mjs";
import { resolveWorkspaceRoot } from "../../../lib/workspace.mjs";
import { codexProvider } from "../index.mjs";
import { KNOWN_REASONING_EFFORTS } from "../model-catalog.mjs";
import {
  buildPersistentTaskThreadName,
  DEFAULT_CONTINUE_PROMPT,
  ensureCodexAvailable,
  findLatestTaskThread,
  readOutputSchema,
  runAppServerTurn
} from "../runtime.mjs";
import { getJobKindLabel } from "./review.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
// Background tasks run in a worker started from the Codex companion script.
const COMPANION_SCRIPT = codexProvider.companionScript;
const EFFORT_USAGE = `<${KNOWN_REASONING_EFFORTS.join("|")}>`;
export const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

export const usage = `task [--background] [--write] [--worktree] [--resume-last|--resume|--resume-thread <thread-id>|--fresh] [--from-last-review] [--model <id|family|default|configured>] [--effort ${EFFORT_USAGE}] [--output-schema <file>] [--manifest <file.json>] [--] [prompt]`;

export function filterJobsForCurrentSession(jobs) {
  const sessionId = getSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

// Codex resumes only its own threads; a record without a provider is a Codex job.
function isCodexJob(job) {
  return (job.provider ?? codexProvider.id) === codexProvider.id;
}

export function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        isCodexJob(job) &&
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

export async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  await reconcileJobLiveness(workspaceRoot);
  const sessionId = getSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentSession(jobs);
  const activeTask = visibleJobs.find((job) => isCodexJob(job) && job.jobClass === "task" && isActiveJobStatus(job.status));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /agent:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return {
      id: trackedTask.threadId,
      worktreePath: trackedTask.worktreePath ?? null,
      worktreeBranch: trackedTask.worktreeBranch ?? null
    };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

// A worktree created for this run is removed when the run fails before Codex starts a thread in
// it, because nothing was done there.
export async function executeTaskRun(request) {
  let threadStarted = false;
  const onProgress = (event) => {
    if (event && typeof event === "object" && event.threadId) {
      threadStarted = true;
    }
    request.onProgress?.(event);
  };
  try {
    return await runTaskRequest({ ...request, onProgress });
  } catch (error) {
    if (request.newWorktree && request.worktreePath && !threadStarted) {
      throw discardLaunchWorktree(resolveWorkspaceRoot(request.cwd), request, error);
    }
    throw error;
  }
}

async function runTaskRequest(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast || Boolean(request.resumeThreadId)
  });

  let resumeThreadId = request.resumeThreadId ?? null;
  let worktreePath = request.worktreePath ?? null;
  let worktreeBranch = request.worktreeBranch ?? null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
    // The resumed thread continues in the worktree its job ran in.
    if (!worktreePath && latestThread.worktreePath) {
      worktreePath = latestThread.worktreePath;
      worktreeBranch = latestThread.worktreeBranch ?? null;
    }
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    modelResolved: request.modelResolved === true,
    // The job record keeps the model and effort the turn runs with: the values turn/start sends,
    // and for a value it does not send, the one Codex reports for the thread.
    onThreadReady: request.jobId
      ? (reported) =>
          upsertJob(workspaceRoot, {
            id: request.jobId,
            ...(reported.model ? { model: reported.model } : {}),
            ...(reported.effort ? { effort: reported.effort } : {})
          })
      : null,
    sandbox: request.write ? getConfig(workspaceRoot).writeSandbox ?? "workspace-write" : "read-only",
    onProgress: request.onProgress,
    outputSchema: request.outputSchema ?? null,
    threadCwd: worktreePath,
    messageInbox: request.jobId
      ? {
          take: () => takeJobMessages(workspaceRoot, request.jobId),
          report: (messageId, outcome) => writeJobMessageOutcome(workspaceRoot, request.jobId, messageId, outcome)
        }
      : null,
    persistThread: true,
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write),
      worktreePath,
      worktreeBranch
    }
  );
  const payload = {
    status: result.status,
    jobId: request.jobId ?? null,
    ...(worktreePath ? { worktreePath, worktreeBranch } : {}),
    threadId: result.threadId,
    rawOutput,
    ...(result.status !== 0 && failureMessage ? { failureMessage } : {}),
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

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

// The job record names the model and effort the job runs with and how each was chosen.
function buildTaskJob(workspaceRoot, taskMetadata, write, selection = null) {
  return createProviderJob(codexProvider, {
    prefix: "task",
    kind: "task",
    kindLabel: getJobKindLabel("task", "task"),
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write,
    ...(selection ? selectionFields(selection) : {})
  });
}

function selectionFields(selection) {
  return {
    model: selection.model,
    effort: selection.effort,
    modelSource: selection.modelSource,
    effortSource: selection.effortSource
  };
}

// A request built from a resolved selection is not checked again by the worker.
function resolvedRequest(fields, selection) {
  return { ...buildTaskRequest({ ...fields, model: selection.model, effort: selection.effort }), modelResolved: true };
}

function printWarnings(selection) {
  for (const warning of selection.warnings ?? []) {
    process.stderr.write(`${warning}\n`);
  }
}

/**
 * Resolves the model and effort of a Codex task from its options and the workspace setting. A
 * task that continues the thread `continuesThreadId` keeps the model and effort of the newest
 * job on that thread, except for a value the options give.
 */
export async function resolveTaskSelection(workspaceRoot, cwd, { model, effort, continuesThreadId = null } = {}) {
  const continued = newestJobOnThread(workspaceRoot, codexProvider.id, continuesThreadId);
  return resolveModelSelection(codexProvider, {
    model,
    effort,
    setting: getConfig(workspaceRoot).models?.[codexProvider.id] ?? null,
    stored: storedSelection(continued),
    cwd
  });
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

// Builds a task prompt from the newest finished review in this repository, preferring reviews
// run from the current Claude session.
export function buildReviewHandoffPrompt(workspaceRoot, userRequest) {
  const reviews = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot))).filter(
    (job) => job.jobClass === "review" && job.status === "completed"
  );
  for (const job of reviews) {
    const stored = readStoredJob(workspaceRoot, job.id);
    const output = String(stored?.rendered ?? stored?.result?.codex?.stdout ?? "").trim();
    if (!output) {
      continue;
    }
    return interpolateTemplate(loadPromptTemplate(ROOT_DIR, "review-handoff"), {
      TARGET_LABEL: stored?.result?.target?.label ?? "the reviewed changes",
      REVIEW_OUTPUT: output,
      USER_REQUEST: userRequest?.trim() ? `Instructions from the user:
${userRequest.trim()}` : ""
    });
  }
  throw new Error(
    "No finished Codex review with output was found for this repository. Run /agent:codex-review or /agent:codex-adversarial-review first."
  );
}

/**
 * Starts a new background turn on the thread of a finished Codex job. The turn runs in the
 * worktree of the job it continues.
 */
export async function startCodexFollowUpTurn(cwd, workspaceRoot, job, text) {
  ensureCodexAvailable(cwd);
  const write = Boolean(job.write);
  // The new turn runs on the model and effort of the job it continues.
  const selection = await resolveTaskSelection(workspaceRoot, cwd, { continuesThreadId: job.threadId });
  printWarnings(selection);
  // The new turn runs in the worktree of the job it continues.
  const worktree = job.worktreePath ? { worktreePath: job.worktreePath, worktreeBranch: job.worktreeBranch ?? null } : {};
  const newJob = { ...buildTaskJob(workspaceRoot, buildTaskRunMetadata({ prompt: text, resumeLast: true }), write, selection), ...worktree };
  const request = resolvedRequest({
    cwd,
    prompt: text,
    write,
    resumeLast: false,
    resumeThreadId: job.threadId,
    jobId: newJob.id,
    ...worktree
  }, selection);
  enqueueBackgroundTask(cwd, newJob, request, { workerScript: COMPANION_SCRIPT });
  return { status: "started", jobId: job.id, newJobId: newJob.id, threadId: job.threadId };
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
// and `defaults.effort`, are sent as given.
export function launchManifestTasks(cwd, workspaceRoot, options, positionals, defaults, deps = { enqueue: enqueueBackgroundTask }) {
  const enqueue = deps.enqueue ?? enqueueBackgroundTask;
  checkManifestOptions(options, positionals);
  const entries = defaults.manifestEntries ?? readTaskManifest(cwd, options.manifest);
  if (defaults.manifestEntries && defaults.entries && defaults.entries.length !== entries.length) {
    throw new Error("Each manifest entry needs one resolved selection.");
  }
  ensureCodexAvailable(cwd);

  const launched = [];
  const failed = [];
  for (const [index, entry] of entries.entries()) {
    let job = null;
    try {
      const write = entry.write ?? Boolean(options.write);
      const metadata = { ...buildTaskRunMetadata({ prompt: entry.prompt }), title: `Codex Task: ${entry.label}` };
      const selection = defaults.entries?.[index] ?? null;
      const baseJob = buildTaskJob(workspaceRoot, metadata, write, selection);
      job = entry.worktree ?? options.worktree ? attachWorktree(baseJob) : baseJob;
      const fields = {
        cwd,
        model: entry.model ?? defaults.model,
        effort: entry.effort ?? defaults.effort,
        prompt: entry.prompt,
        write,
        resumeLast: false,
        jobId: job.id,
        worktreePath: job.worktreePath ?? null,
        worktreeBranch: job.worktreeBranch ?? null,
        newWorktree: true
      };
      const request = selection ? resolvedRequest(fields, selection) : buildTaskRequest(fields);
      enqueue(cwd, job, request, { workerScript: COMPANION_SCRIPT });
      launched.push({ label: entry.label, jobId: job.id, ...(job.worktreePath ? { worktreePath: job.worktreePath } : {}) });
    } catch (caught) {
      const error = job?.worktreePath ? discardLaunchWorktree(workspaceRoot, job, caught) : caught;
      failed.push({ label: entry.label, error: error instanceof Error ? error.message : String(error) });
    }
  }

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
}

export async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "output-schema", "resume-thread", "manifest"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "from-last-review", "worktree"],
    stopAtFirstPositional: true,
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  if (options.manifest) {
    checkManifestOptions(options, positionals);
    const { entries, selections } = await resolveManifestSelections(cwd, workspaceRoot, options);
    selections.forEach(printWarnings);
    launchManifestTasks(cwd, workspaceRoot, options, positionals, { model: null, effort: null, manifestEntries: entries, entries: selections });
    return;
  }
  // The model is resolved before any job, worktree or worker exists, so a bad choice creates none.
  // A resumed thread keeps the model and effort of the job that ran it.
  const resolveSelection = async (continuesThreadId) => {
    const resolved = await resolveTaskSelection(workspaceRoot, cwd, { model: options.model, effort: options.effort, continuesThreadId });
    printWarnings(resolved);
    return resolved;
  };
  const requestText = await readTaskPrompt(cwd, options, positionals);
  const prompt = options["from-last-review"] ? buildReviewHandoffPrompt(workspaceRoot, requestText) : requestText;
  const outputSchema = options["output-schema"] ? readOutputSchema(path.resolve(cwd, options["output-schema"])) : null;

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  const resumeThreadId = options["resume-thread"] ? String(options["resume-thread"]).trim() : null;
  if ([resumeLast, fresh, Boolean(resumeThreadId)].filter(Boolean).length > 1) {
    throw new Error("Choose only one of --resume/--resume-last, --resume-thread, and --fresh.");
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast: resumeLast || Boolean(resumeThreadId)
  });

  if (options.background) {
    ensureCodexAvailable(cwd);
    requireTaskRequest(prompt, resumeLast || Boolean(resumeThreadId));

    // A resumed thread continues in its job's worktree, which the new job records, so a later
    // follow-up on the new job runs there too. A thread that is not found yet is resolved by the
    // worker, which reports the failure.
    const resumed = resumeLast ? await resolveLatestTrackedTaskThread(workspaceRoot) : null;
    const selection = await resolveSelection(resumed?.id ?? resumeThreadId);
    const baseJob = buildTaskJob(workspaceRoot, taskMetadata, write, selection);
    const job = resumed?.worktreePath
      ? { ...baseJob, worktreePath: resumed.worktreePath, worktreeBranch: resumed.worktreeBranch ?? null }
      : options.worktree
        ? attachWorktree(baseJob)
        : baseJob;
    // Only a worktree this launch created is removed when the launch fails; an inherited one
    // holds the earlier job's work.
    const createdWorktree = Boolean(job.worktreePath) && !resumed?.worktreePath;
    const request = resolvedRequest({
      cwd,
      prompt,
      write,
      resumeLast: resumeLast && !resumed,
      resumeThreadId: resumed?.id ?? resumeThreadId,
      jobId: job.id,
      outputSchema,
      worktreePath: job.worktreePath ?? null,
      worktreeBranch: job.worktreeBranch ?? null,
      newWorktree: !resumed?.worktreePath
    }, selection);
    let launch;
    try {
      launch = enqueueBackgroundTask(cwd, job, request, { workerScript: COMPANION_SCRIPT });
    } catch (error) {
      throw createdWorktree ? discardLaunchWorktree(workspaceRoot, job, error) : error;
    }
    outputCommandResult(launch.payload, renderQueuedTaskLaunch(launch.payload), options.json);
    return;
  }

  // The request and the thread to resume are checked before a worktree is created.
  requireTaskRequest(prompt, resumeLast || Boolean(resumeThreadId));
  ensureCodexAvailable(cwd);
  let resumed = null;
  if (resumeLast) {
    resumed = await resolveLatestTrackedTaskThread(workspaceRoot);
    if (!resumed) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
  }
  const selection = await resolveSelection(resumed?.id ?? resumeThreadId);

  // A resumed thread continues in its job's worktree; --worktree creates one only otherwise.
  const baseJob = buildTaskJob(workspaceRoot, taskMetadata, write, selection);
  const job = resumed?.worktreePath
    ? { ...baseJob, worktreePath: resumed.worktreePath, worktreeBranch: resumed.worktreeBranch ?? null }
    : options.worktree
      ? attachWorktree(baseJob)
      : baseJob;
  const newWorktree = Boolean(job.worktreePath) && !resumed?.worktreePath;
  // A run that fails before Codex starts a thread removes the worktree created for it.
  const discardUnusedWorktree = (error) => {
    if (!newWorktree || readStoredJob(workspaceRoot, job.id)?.threadId) {
      return error;
    }
    return discardLaunchWorktree(workspaceRoot, job, error);
  };
  let execution;
  try {
    execution = await runForegroundCommand(
      job,
      (progress) =>
        executeTaskRun({
          cwd,
          model: selection.model,
          effort: selection.effort,
          modelResolved: true,
          prompt,
          write,
          resumeLast: false,
          resumeThreadId: resumed?.id ?? resumeThreadId,
          jobId: job.id,
          outputSchema,
          worktreePath: job.worktreePath ?? null,
          worktreeBranch: job.worktreeBranch ?? null,
          newWorktree,
          onProgress: progress
        }),
      { json: options.json }
    );
  } catch (error) {
    throw discardUnusedWorktree(error);
  }
  if (execution.exitStatus !== 0 && !execution.threadId) {
    const cleanupError = discardUnusedWorktree(null);
    if (cleanupError) {
      throw cleanupError;
    }
  }
}

export const run = handleTask;

export async function runResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getSessionId();
  await reconcileJobLiveness(workspaceRoot);
  const jobs = filterJobsForCurrentSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}
