#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    importExternalAgentSession,
    parseStructuredOutput,
    readCodexRateLimits,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./providers/codex/runtime.mjs";
import { resolveClaudeSessionPath, stageClaudeSessionForImport } from "./providers/codex/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, createWorktree, ensureGitRepository, removeWorktree, resolveReviewTarget } from "./lib/git.mjs";
import { KNOWN_REASONING_EFFORTS } from "./providers/codex/model-catalog.mjs";
import { binaryAvailable, isProcessAlive } from "./lib/process.mjs";
import { codexProvider } from "./providers/codex/index.mjs";
import { renderSetupReport, renderUsageReport } from "./providers/codex/render.mjs";
import { providerForJob } from "./lib/providers.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  markJobCancelled,
  markJobResultDelivered,
  queueJobMessage,
  readJobMessageOutcome,
  resolveStateDir,
  takeJobMessages,
  withdrawJobMessage,
  writeJobMessageOutcome,
  setConfig,
  takeJobRequest,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  reconcileJobLiveness,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst,
  terminateJobProcesses
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobRecord,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  enqueueBackgroundTask,
  HelpRequested,
  outputCommandResult,
  outputResult,
  parseCommandInput,
  resolveCommandCwd,
  resolveCommandWorkspace,
  runForegroundCommand,
  createTrackedProgress,
  sleep
} from "./lib/companion-cli.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const COMPANION_SCRIPT = fileURLToPath(import.meta.url);
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
// How long cancel waits for an interrupted worker to finish its turn and exit by itself.
const INTERRUPT_EXIT_WAIT_MS = 10000;
const VALID_REASONING_EFFORTS = new Set(KNOWN_REASONING_EFFORTS);
const WRITE_SANDBOXES = ["workspace-write", "danger-full-access"];
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
// How long send waits for the agent to confirm a message by default.
const DEFAULT_SEND_TIMEOUT_MS = 60000;
// result --wait exits with this code when the job is still running at the end of the wait.
const STILL_RUNNING_EXIT_CODE = 75;
const SEND_VALUE_OPTIONS = new Set(["--timeout-ms", "--cwd", "-C"]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

const EFFORT_USAGE = `<${KNOWN_REASONING_EFFORTS.join("|")}>`;
const SUBCOMMAND_USAGE = {
  setup: `setup [--enable-review-gate|--disable-review-gate] [--write-sandbox <${WRITE_SANDBOXES.join("|")}>] [--json]`,
  review: `review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model|spark>] [--effort ${EFFORT_USAGE}]`,
  "adversarial-review": `adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model|spark>] [--effort ${EFFORT_USAGE}] [focus text]`,
  task: `task [--background] [--write] [--worktree] [--resume-last|--resume|--resume-thread <thread-id>|--fresh] [--from-last-review] [--model <model|spark>] [--effort ${EFFORT_USAGE}] [--output-schema <file>] [--manifest <file.json>] [--] [prompt]`,
  transfer: "transfer [--source <claude-jsonl>] [--json]",
  usage: "usage [--json]",
  send: "send [--timeout-ms <ms>] [--json] <job-id> <message>",
  status: "status [job-id] [--wait] [--timeout-ms <ms>] [--all] [--json]",
  result: "result [job-id] [--wait] [--timeout-ms <ms>] [--json]",
  cancel: "cancel [job-id] [--json]"
};

function printUsage(subcommand = null) {
  const names = subcommand && SUBCOMMAND_USAGE[subcommand] ? [subcommand] : Object.keys(SUBCOMMAND_USAGE);
  console.log(["Usage:", ...names.map((name) => `  node scripts/codex-companion.mjs ${SUBCOMMAND_USAGE[name]}`)].join("\n"));
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(`Unsupported reasoning effort "${effort}". Use one of: ${KNOWN_REASONING_EFFORTS.join(", ")}.`);
  }
  return normalized;
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/agent:codex-setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    appServer: authStatus.userAgent ?? null,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    writeSandbox: config.writeSandbox ?? "workspace-write",
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "write-sandbox"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  if (options["write-sandbox"] !== undefined) {
    const sandbox = String(options["write-sandbox"]).trim();
    if (!WRITE_SANDBOXES.includes(sandbox)) {
      throw new Error(`Unsupported write sandbox "${sandbox}". Use one of: ${WRITE_SANDBOXES.join(", ")}.`);
    }
    setConfig(workspaceRoot, "writeSandbox", sandbox);
    actionsTaken.push(`Write-capable tasks now run with the ${sandbox} sandbox in ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    AGENT_NAME: codexProvider.label,
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/agent:codex-setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/agent:codex-review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/agent:codex-adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/agent:codex-review` target is not supported by the built-in reviewer. Retry with `/agent:codex-adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

// Codex resumes only its own threads; a record without a provider is a Codex job.
function isCodexJob(job) {
  return (job.provider ?? codexProvider.id) === codexProvider.id;
}

function findLatestResumableTaskJob(jobs) {
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

// Reads a --timeout-ms value; a missing value gives the default wait.
function parseWaitTimeout(value) {
  if (value === undefined || value === null) {
    return DEFAULT_STATUS_WAIT_TIMEOUT_MS;
  }
  const timeoutMs = Number(String(value).trim());
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number of milliseconds.");
  }
  return timeoutMs;
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = parseWaitTimeout(options.timeoutMs);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  await reconcileJobLiveness(cwd);
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    await reconcileJobLiveness(cwd);
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  await reconcileJobLiveness(workspaceRoot);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
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

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      effort: request.effort,
      onProgress: request.onProgress
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    effort: request.effort,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


// A worktree created for this run is removed when the run fails before Codex starts a thread in
// it, because nothing was done there.
async function executeTaskRun(request) {
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

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
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

function renderQueuedTaskLaunch(payload) {
  const worktree = payload.worktreePath ? ` It runs in the worktree ${payload.worktreePath} (branch ${payload.worktreeBranch}).` : "";
  return `${payload.title} started in the background as ${payload.jobId}.${worktree} Check /agent:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    provider: codexProvider.id,
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

// A worktree job gets its own checkout of HEAD under the state directory, on the new branch
// agent/<job-id>. The job's record stays with the repository; only Codex works in the worktree.
function attachWorktree(job) {
  const worktreePath = path.join(resolveStateDir(job.workspaceRoot), "worktrees", job.id);
  const worktreeBranch = `agent/${job.id}`;
  createWorktree(job.workspaceRoot, worktreePath, worktreeBranch);
  return { ...job, worktreePath, worktreeBranch };
}

// Removes the worktree a failed launch created and returns the launch's error (null when there
// is none), extended with the reason when the worktree cannot be removed.
function discardLaunchWorktree(workspaceRoot, { worktreePath, worktreeBranch }, error) {
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
function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, resumeThreadId = null, jobId, outputSchema = null, worktreePath = null, worktreeBranch = null, newWorktree = false }) {
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

function renderTransferResult(payload) {
  const lines = [
    "Transferred the Claude session into a Codex thread with visible turn history.",
    `Codex session ID: ${payload.threadId}`,
    `Resume in Codex: ${payload.resumeCommand}`
  ];
  return `${lines.join("\n")}\n`;
}

async function executeTransfer(cwd, options = {}) {
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  let importSource = null;
  let result;
  try {
    importSource = stageClaudeSessionForImport(sourcePath);
    result = await importExternalAgentSession(cwd, { sourcePath: importSource.path });
  } finally {
    importSource?.cleanup();
  }
  const payload = {
    threadId: result.threadId,
    resumeCommand: `codex resume ${result.threadId}`,
    sourcePath,
    sessionId: path.basename(sourcePath, ".jsonl")
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
  };
}

async function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || (await readStdinIfPiped());
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  // Reviews run in single-use threads that Codex does not keep, so no resume command applies.
  const job = {
    ...createCompanionJob({
      prefix: "review",
      kind: metadata.kind,
      title: metadata.title,
      workspaceRoot,
      jobClass: "review",
      summary: metadata.summary
    }),
    ephemeralThread: true
  };
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: normalizeRequestedModel(options.model),
        effort: normalizeReasoningEffort(options.effort),
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

// Builds a task prompt from the newest finished review in this repository, preferring reviews
// run from the current Claude session.
function buildReviewHandoffPrompt(workspaceRoot, userRequest) {
  const reviews = sortJobsNewestFirst(filterJobsForCurrentClaudeSession(listJobs(workspaceRoot))).filter(
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

async function handleUsage(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const response = await readCodexRateLimits(cwd);
  outputCommandResult(response, renderUsageReport(response), options.json);
}

// The slash command passes its arguments as one string. Options and the job id are split off
// the front, and the rest is the message exactly as typed, so quotes and apostrophes survive.
function splitSendArguments(argv) {
  if (argv.length !== 1 || !/\s/.test(argv[0].trim())) {
    return argv;
  }
  const tokens = [];
  let rest = argv[0].trim();
  while (rest) {
    const match = rest.match(/^(\S+)\s*([\s\S]*)$/);
    tokens.push(match[1]);
    rest = match[2];
    if (SEND_VALUE_OPTIONS.has(match[1]) && rest) {
      const value = rest.match(/^(\S+)\s*([\s\S]*)$/);
      tokens.push(value[1]);
      rest = value[2];
    } else if (!match[1].startsWith("-")) {
      break;
    }
  }
  const quoted = rest.match(/^(["'])([\s\S]*)\1$/);
  return rest ? [...tokens, "--", quoted ? quoted[2] : rest] : tokens;
}

function renderSendResult(result, label) {
  switch (result.status) {
    case "applied":
      return `${label} received the message in the running turn of ${result.jobId}.\n`;
    case "sent":
      return `${label} accepted the message for the running turn of ${result.jobId} and had not confirmed it after ${Math.round(result.timeoutMs / 1000)} s. Check /agent:status ${result.jobId}.\n`;
    case "started":
      if (result.reason === "unapplied") {
        return `The turn of ${result.jobId} ended before ${label} applied the message, so it started a new turn on the same thread as ${result.newJobId}. Check /agent:status ${result.newJobId} for progress.\n`;
      }
      return `${result.jobId} had finished, so the message started a new turn on its Codex thread as ${result.newJobId}. Check /agent:status ${result.newJobId} for progress.\n`;
    default:
      return `${result.detail}\n`;
  }
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

function startTurnOnFinishedJob(cwd, workspaceRoot, job, text) {
  const provider = providerForJob(job);
  if (!job.threadId) {
    throw new Error(`${job.id} has no ${provider.label} thread to continue.`);
  }
  if (provider.id !== codexProvider.id) {
    return startTurnWithProviderCompanion(cwd, provider, job, text);
  }
  ensureCodexAvailable(cwd);
  const write = Boolean(job.write);
  // The new turn runs in the worktree of the job it continues.
  const worktree = job.worktreePath ? { worktreePath: job.worktreePath, worktreeBranch: job.worktreeBranch ?? null } : {};
  const newJob = { ...buildTaskJob(workspaceRoot, buildTaskRunMetadata({ prompt: text, resumeLast: true }), write), ...worktree };
  const request = buildTaskRequest({
    cwd,
    prompt: text,
    write,
    resumeLast: false,
    resumeThreadId: job.threadId,
    jobId: newJob.id,
    ...worktree
  });
  enqueueBackgroundTask(cwd, newJob, request, { workerScript: COMPANION_SCRIPT });
  return { status: "started", jobId: job.id, newJobId: newJob.id, threadId: job.threadId };
}

async function waitForMessageOutcome(cwd, workspaceRoot, job, messageId, text, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let sent = null;
  for (;;) {
    const outcome = readJobMessageOutcome(workspaceRoot, job.id, messageId);
    if (outcome?.status === "applied") {
      return { status: outcome.status, jobId: job.id, turnId: outcome.turnId ?? null };
    }
    // The turn ended without applying the message: Codex applies a sent message only at its
    // next model request, so a message that arrives during the final answer is not applied.
    if (outcome?.status === "unconfirmed") {
      return {
        ...startTurnOnFinishedJob(cwd, workspaceRoot, readStoredJob(workspaceRoot, job.id) ?? job, text),
        reason: "unapplied"
      };
    }
    if (outcome?.status === "failed") {
      throw new Error(`${providerForJob(job).label} rejected the message for ${job.id}: ${outcome.error}`);
    }
    if (outcome?.status === "turn-ended") {
      return startTurnOnFinishedJob(cwd, workspaceRoot, readStoredJob(workspaceRoot, job.id) ?? job, text);
    }
    sent = outcome?.status === "sent" ? outcome : sent;
    if (!outcome) {
      const current = readStoredJob(workspaceRoot, job.id) ?? job;
      if (!isActiveJobStatus(current.status) && withdrawJobMessage(workspaceRoot, job.id, messageId)) {
        return startTurnOnFinishedJob(cwd, workspaceRoot, current, text);
      }
    }
    if (Date.now() >= deadline) {
      if (sent) {
        return { status: "sent", jobId: job.id, turnId: sent.turnId ?? null, timeoutMs };
      }
      if (withdrawJobMessage(workspaceRoot, job.id, messageId)) {
        throw new Error(`The worker of ${job.id} did not take the message within ${Math.round(timeoutMs / 1000)} s, so it was withdrawn.`);
      }
      return { status: "sent", jobId: job.id, turnId: null, timeoutMs };
    }
    await sleep(200);
  }
}

async function handleSend(argv) {
  const { options, positionals } = parseCommandInput(splitSendArguments(argv), {
    valueOptions: ["cwd", "timeout-ms"],
    booleanOptions: ["json"],
    stopAtFirstPositional: true
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const [reference, ...words] = positionals.filter((value, index) => !(index === 1 && value === "--"));
  const text = words.join(" ").trim() || (await readStdinIfPiped()).trim();
  if (!reference || !text) {
    throw new Error("Provide a job id and a message: send <job-id> <message>.");
  }
  const timeoutMs = options["timeout-ms"] === undefined ? DEFAULT_SEND_TIMEOUT_MS : parseWaitTimeout(options["timeout-ms"]);

  await reconcileJobLiveness(cwd);
  const job = listJobs(workspaceRoot).find((candidate) => candidate.id === reference);
  if (!job) {
    throw new Error(`No job ${reference} was found for this repository.`);
  }
  if (job.jobClass !== "task") {
    throw new Error(`${job.id} is a ${job.jobClass ?? "non-task"} job. Messages can be sent only to task jobs.`);
  }
  const provider = providerForJob(job);
  if (isActiveJobStatus(job.status) && !provider.capabilities.steer) {
    throw new Error(`${provider.label} cannot take a message during a running turn. Send it after ${job.id} finishes.`);
  }

  const result = isActiveJobStatus(job.status)
    ? await waitForMessageOutcome(cwd, workspaceRoot, job, queueJobMessage(workspaceRoot, job.id, text), text, timeoutMs)
    : startTurnOnFinishedJob(cwd, workspaceRoot, readStoredJob(workspaceRoot, job.id) ?? job, text);
  outputCommandResult(result, renderSendResult(result, provider.label), options.json);
}

const MANIFEST_FIELDS = new Set(["label", "prompt", "model", "effort", "write", "worktree"]);
const MANIFEST_SHAPE = "a JSON array of {label, prompt, model?, effort?, write?, worktree?}";

// Reads and checks every manifest entry before any job starts.
function readTaskManifest(cwd, file) {
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
    return {
      label,
      prompt,
      model: entry.model == null ? undefined : normalizeRequestedModel(String(entry.model)),
      effort: entry.effort == null ? undefined : normalizeReasoningEffort(String(entry.effort)),
      write: entry.write,
      worktree: entry.worktree
    };
  });
}

// Starts one background task per manifest entry. Command-line --model, --effort, --write, and
// --worktree apply to entries that do not set them.
export function launchManifestTasks(cwd, workspaceRoot, options, positionals, defaults, deps = { enqueue: enqueueBackgroundTask }) {
  const enqueue = deps.enqueue ?? enqueueBackgroundTask;
  const conflicting = ["prompt-file", "resume-last", "resume", "resume-thread", "fresh", "from-last-review", "output-schema"].filter(
    (name) => options[name] !== undefined && options[name] !== false
  );
  if (positionals.length > 0 || conflicting.length > 0) {
    throw new Error(
      `--manifest takes its prompts from the file. Remove ${[...conflicting.map((name) => `--${name}`), ...(positionals.length > 0 ? ["the prompt text"] : [])].join(", ")}.`
    );
  }
  const entries = readTaskManifest(cwd, options.manifest);
  ensureCodexAvailable(cwd);

  const launched = [];
  const failed = [];
  for (const entry of entries) {
    let job = null;
    try {
      const write = entry.write ?? Boolean(options.write);
      const metadata = { ...buildTaskRunMetadata({ prompt: entry.prompt }), title: `Codex Task: ${entry.label}` };
      const baseJob = buildTaskJob(workspaceRoot, metadata, write);
      job = entry.worktree ?? options.worktree ? attachWorktree(baseJob) : baseJob;
      const request = buildTaskRequest({
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
      });
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

async function handleTask(argv) {
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
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  if (options.manifest) {
    launchManifestTasks(cwd, workspaceRoot, options, positionals, { model, effort });
    return;
  }
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
    const baseJob = buildTaskJob(workspaceRoot, taskMetadata, write);
    const job = resumed?.worktreePath
      ? { ...baseJob, worktreePath: resumed.worktreePath, worktreeBranch: resumed.worktreeBranch ?? null }
      : options.worktree
        ? attachWorktree(baseJob)
        : baseJob;
    // Only a worktree this launch created is removed when the launch fails; an inherited one
    // holds the earlier job's work.
    const createdWorktree = Boolean(job.worktreePath) && !resumed?.worktreePath;
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      resumeLast: resumeLast && !resumed,
      resumeThreadId: resumed?.id ?? resumeThreadId,
      jobId: job.id,
      outputSchema,
      worktreePath: job.worktreePath ?? null,
      worktreeBranch: job.worktreeBranch ?? null,
      newWorktree: !resumed?.worktreePath
    });
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

  // A resumed thread continues in its job's worktree; --worktree creates one only otherwise.
  const baseJob = buildTaskJob(workspaceRoot, taskMetadata, write);
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
          model,
          effort,
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

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source
  });
  outputCommandResult(payload, rendered, options.json);
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  // A job cancelled or failed while queued is not run.
  if (storedJob.status !== "queued") {
    return;
  }

  const request = takeJobRequest(workspaceRoot, options["job-id"]);
  if (!request || typeof request !== "object") {
    const errorMessage = `Stored job ${options["job-id"]} is missing its task request payload.`;
    writeJobFile(workspaceRoot, storedJob.id, { ...storedJob, status: "failed", phase: "failed", errorMessage, completedAt: nowIso() });
    throw new Error(errorMessage);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (!options.wait) {
    await reconcileJobLiveness(cwd);
  }
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

async function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  parseWaitTimeout(options["timeout-ms"]);
  if (options.wait) {
    if (!reference) {
      throw new Error("`result --wait` requires a job id.");
    }
    const snapshot = await waitForSingleJobSnapshot(cwd, reference, {
      timeoutMs: options["timeout-ms"],
      pollIntervalMs: options["poll-interval-ms"]
    });
    if (snapshot.waitTimedOut) {
      const seconds = Math.round(snapshot.timeoutMs / 1000);
      outputCommandResult(
        { job: snapshot.job, waitTimedOut: true },
        `Job ${snapshot.job.id} is still running after ${seconds} s. Run the same command again to keep waiting.\n`,
        options.json
      );
      process.exitCode = STILL_RUNNING_EXIT_CODE;
      return;
    }
  }
  await reconcileJobLiveness(cwd);
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  let storedJob = readStoredJob(workspaceRoot, job.id);
  let recoveredNote = "";
  const hasOutput = Boolean(storedJob?.result?.rawOutput || storedJob?.result?.codex?.stdout || storedJob?.rendered);
  // A job that stopped without storing its output may still have it in the Codex transcript.
  if (!hasOutput) {
    const provider = providerForJob(job);
    const recovered = provider.recoverTurnResult?.({
      threadId: storedJob?.threadId ?? job.threadId,
      turnId: storedJob?.turnId ?? job.turnId
    });
    if (recovered) {
      storedJob = { ...storedJob, result: { ...(storedJob?.result ?? {}), rawOutput: recovered.text }, recovered };
      recoveredNote = recovered.complete
        ? `Recovered from the ${provider.label} transcript.\n\n`
        : `Recovered from the ${provider.label} transcript. The turn did not finish; this is its last message.\n\n`;
    }
  }
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, `${recoveredNote}${renderStoredJobResult(job, storedJob)}`, options.json);
  if (!isActiveJobStatus(job.status)) {
    markJobResultDelivered(workspaceRoot, job.id);
  }
}

async function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  await reconcileJobLiveness(workspaceRoot);
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
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

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  await reconcileJobLiveness(cwd);
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const { payload, nextJob } = await cancelJob(workspaceRoot, job, existing);
  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

/**
 * Cancels a job: marks it cancelled, asks its provider to interrupt the turn, stops its
 * processes, and records it as cancelled. `existing` is the job's stored record read before the
 * call; the record is read again after the cancel marker is written. Returns the command payload
 * and the job as reported.
 */
export async function cancelJob(workspaceRoot, job, existing, deps = {}) {
  const {
    interruptTurn = (cwd, ids) => providerForJob(job).interruptTurn(cwd, ids),
    terminate = terminateJobProcesses,
    readStoredJob: readStored = (root, jobId) => readStoredJob(root, jobId, { ignoreCancelMarker: true }),
    isAlive = isProcessAlive,
    sleep: wait = sleep
  } = deps;
  markJobCancelled(workspaceRoot, job.id);
  // A worker publishes its pid and then checks the marker, so the record read after the marker
  // holds the pid of every worker that can still start a turn.
  const current = readStored(workspaceRoot, job.id) ?? existing;
  const threadId = current.threadId ?? job.threadId ?? null;
  const turnId = current.turnId ?? job.turnId ?? null;

  const provider = providerForJob(job);
  const interrupt = await interruptTurn(workspaceRoot, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested ${provider.label} turn interrupt for ${turnId} on ${threadId}.`
        : `${provider.label} turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  // An interrupted worker normally records the stopped turn and exits on its own; it is
  // stopped by force only if it is still running after the wait.
  const workerPid = current.pid ?? job.pid ?? null;
  if (interrupt.interrupted && Number.isInteger(workerPid)) {
    const deadline = Date.now() + INTERRUPT_EXIT_WAIT_MS;
    while (isAlive(workerPid) && Date.now() < deadline) {
      await wait(100);
    }
    if (isAlive(workerPid)) {
      appendLogLine(job.logFile, `The worker was still running ${INTERRUPT_EXIT_WAIT_MS / 1000} s after the interrupt.`);
    }
  }
  const [termination] = terminate([{ ...job, ...current }]);
  if (termination?.outcome === "pid-reused") {
    appendLogLine(job.logFile, `Process ${termination.pid} no longer belongs to this job; it was not stopped.`);
  } else if (termination?.outcome === "failed") {
    appendLogLine(job.logFile, `Stopping process ${termination.pid} failed: ${termination.detail}`);
  }
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  // Only the cancellation fields are replaced, in one read-modify-write, so a result the worker
  // wrote before that read is kept. The step is not locked: a result written between the read
  // and the replace can be lost. The listed job fills in fields the record does not have.
  upsertJob(
    workspaceRoot,
    {
      id: job.id,
      status: "cancelled",
      phase: "cancelled",
      pid: null,
      completedAt,
      cancelledAt: completedAt,
      errorMessage: "Cancelled by user."
    },
    { defaults: job }
  );

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };
  return { payload, nextJob };
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printUsage(argv[0] ?? null);
    return;
  }
  try {
    await runSubcommand(subcommand, argv);
  } catch (error) {
    if (!(error instanceof HelpRequested)) {
      throw error;
    }
    printUsage(subcommand);
  }
}

async function runSubcommand(subcommand, argv) {

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "usage":
      await handleUsage(argv);
      break;
    case "send":
      await handleSend(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      await handleResult(argv);
      break;
    case "task-resume-candidate":
      await handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

// The CLI runs only when this file is the process entry point, so tests can import its steps.
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  let resolved;
  try {
    resolved = fs.realpathSync(entry);
  } catch {
    return false;
  }
  return process.platform === "win32"
    ? resolved.toLowerCase() === COMPANION_SCRIPT.toLowerCase()
    : resolved === COMPANION_SCRIPT;
}

if (isEntryPoint()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
