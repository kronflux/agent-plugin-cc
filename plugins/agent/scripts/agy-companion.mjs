#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  enqueueBackgroundTask,
  HelpRequested,
  outputCommandResult,
  parseCommandInput,
  resolveCommandCwd,
  resolveCommandWorkspace,
  runForegroundCommand,
  createTrackedProgress
} from "./lib/companion-cli.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { readStoredJob, sortJobsNewestFirst } from "./lib/job-control.mjs";
import { binaryAvailable } from "./lib/process.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import { renderReviewResult, renderTaskResult } from "./lib/render.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  takeJobMessages,
  takeJobRequest,
  writeJobFile,
  writeJobMessageOutcome
} from "./lib/state.mjs";
import { createJobRecord, nowIso, runTrackedJob, SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { agyProvider } from "./providers/agy/index.mjs";
import { getAgyAvailability, readAgyModels, runAgyTurn } from "./providers/agy/runtime.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const COMPANION_SCRIPT = fileURLToPath(import.meta.url);
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const AGY_EFFORTS = ["low", "medium", "high"];

const SUBCOMMAND_USAGE = {
  setup: "setup [--json]",
  task: "task [--background] [--write] [--resume-last|--resume-thread <conversation-id>|--fresh] [--model <model>] [--effort <low|medium|high>] [--] [prompt]",
  review: "review [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <low|medium|high>] [focus text]"
};

function printUsage(subcommand = null) {
  const names = subcommand && SUBCOMMAND_USAGE[subcommand] ? [subcommand] : Object.keys(SUBCOMMAND_USAGE);
  console.log(["Usage:", ...names.map((name) => `  node scripts/agy-companion.mjs ${SUBCOMMAND_USAGE[name]}`)].join("\n"));
}

function normalizeEffort(effort) {
  if (effort == null || !String(effort).trim()) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!AGY_EFFORTS.includes(normalized)) {
    throw new Error(`agy does not support reasoning effort "${effort}". Use one of: ${AGY_EFFORTS.join(", ")}.`);
  }
  return normalized;
}

function normalizeModel(model) {
  return model == null || !String(model).trim() ? null : String(model).trim();
}

function firstMeaningfulLine(text, fallback) {
  return (
    String(text ?? "")
      .split(/\r?\n/)
      .map((value) => value.trim())
      .find(Boolean) ?? fallback
  );
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

function ensureAgyAvailable(cwd) {
  const availability = getAgyAvailability(cwd);
  if (!availability.available) {
    throw new Error("The agy CLI is not installed or not on PATH. Install Antigravity, then rerun `/agent:agy-setup`.");
  }
}

function createAgyJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    provider: agyProvider.id,
    kind,
    kindLabel: jobClass === "review" ? "review" : "rescue",
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function writeSandboxMode(workspaceRoot, write) {
  return write ? getConfig(workspaceRoot).writeSandbox ?? "workspace-write" : "read-only";
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  const node = binaryAvailable("node", ["--version"], { cwd });
  const agy = getAgyAvailability(cwd);
  const login = agy.available ? readAgyModels(cwd) : { ok: false, models: [], detail: "skipped: agy is not installed" };
  const nextSteps = [];
  if (!agy.available) {
    nextSteps.push("Install the Antigravity CLI (agy), then rerun /agent:agy-setup.");
  } else if (!login.ok) {
    nextSteps.push("Run `!agy` once and sign in, then rerun /agent:agy-setup.");
  }
  const report = {
    ready: node.available && agy.available && login.ok,
    node,
    agy,
    login: { ok: login.ok, detail: login.detail },
    models: login.models,
    writeSandbox: getConfig(resolveCommandWorkspace(options)).writeSandbox ?? "workspace-write",
    nextSteps
  };
  const lines = [
    "# Antigravity Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${node.detail}`,
    `- agy: ${agy.detail}`,
    `- sign-in: ${login.ok ? `signed in (${login.detail})` : login.detail}`,
    `- write sandbox: ${report.writeSandbox}`
  ];
  if (nextSteps.length > 0) {
    lines.push("", "Next steps:", ...nextSteps.map((step) => `- ${step}`));
  }
  outputCommandResult(report, `${lines.join("\n")}\n`, options.json);
}

// The newest agy task of this Claude session that has a conversation, else of the repository.
function resolveLatestConversation(workspaceRoot) {
  const sessionId = process.env[SESSION_ID_ENV] ?? null;
  const tasks = sortJobsNewestFirst(listJobs(workspaceRoot)).filter(
    (job) => job.provider === agyProvider.id && job.jobClass === "task" && job.threadId
  );
  const active = tasks.find((job) => job.status === "queued" || job.status === "running");
  if (active) {
    throw new Error(`Task ${active.id} is still running. Use /agent:status before continuing it.`);
  }
  return (sessionId ? tasks.find((job) => job.sessionId === sessionId) : null) ?? tasks[0] ?? null;
}

async function executeAgyTask(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureAgyAvailable(request.cwd);
  const title = request.resumeThreadId ? "Antigravity Resume" : "Antigravity Task";
  const result = await runAgyTurn(workspaceRoot, {
    prompt: request.prompt,
    conversationId: request.resumeThreadId ?? null,
    model: request.model,
    effort: request.effort,
    sandboxMode: writeSandboxMode(workspaceRoot, request.write),
    onProgress: request.onProgress,
    messageInbox: request.jobId
      ? {
          take: () => takeJobMessages(workspaceRoot, request.jobId),
          report: (messageId, outcome) => writeJobMessageOutcome(workspaceRoot, request.jobId, messageId, outcome)
        }
      : null
  });
  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  return {
    exitStatus: result.status,
    threadId: result.conversationId,
    turnId: result.turnId,
    payload: {
      status: result.status,
      jobId: request.jobId ?? null,
      threadId: result.conversationId,
      rawOutput,
      ...(result.status !== 0 && failureMessage ? { failureMessage } : {})
    },
    rendered: renderTaskResult({ rawOutput, failureMessage }, { title, jobId: request.jobId ?? null, write: Boolean(request.write), providerLabel: agyProvider.label }),
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${title} finished.`)),
    jobTitle: title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "resume-thread"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    stopAtFirstPositional: true
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeModel(options.model);
  const effort = normalizeEffort(options.effort);
  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  let resumeThreadId = options["resume-thread"] ? String(options["resume-thread"]).trim() : null;
  if ([resumeLast, fresh, Boolean(resumeThreadId)].filter(Boolean).length > 1) {
    throw new Error("Choose only one of --resume/--resume-last, --resume-thread, and --fresh.");
  }
  const prompt = (positionals.join(" ") || readStdinIfPiped()).trim();
  if (!prompt) {
    throw new Error("Provide a prompt or piped stdin.");
  }
  ensureAgyAvailable(cwd);
  if (resumeLast) {
    const latest = resolveLatestConversation(workspaceRoot);
    if (!latest) {
      throw new Error("No previous Antigravity conversation was found for this repository.");
    }
    resumeThreadId = latest.threadId;
  }

  const write = Boolean(options.write);
  const job = createAgyJob({
    prefix: "task",
    kind: "task",
    title: resumeThreadId ? "Antigravity Resume" : "Antigravity Task",
    workspaceRoot,
    jobClass: "task",
    summary: shorten(prompt),
    write
  });
  const request = { cwd, model, effort, prompt, write, resumeThreadId, jobId: job.id };

  if (options.background) {
    const { payload } = enqueueBackgroundTask(cwd, job, request, { workerScript: COMPANION_SCRIPT });
    outputCommandResult(
      payload,
      `${payload.title} started in the background as ${payload.jobId}. Check /agent:status ${payload.jobId} for progress.\n`,
      options.json
    );
    return;
  }

  await runForegroundCommand(job, (progress) => executeAgyTask({ ...request, onProgress: progress }), { json: options.json });
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd", "job-id"] });
  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }
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
  const { logFile, progress } = createTrackedProgress({ ...storedJob, workspaceRoot }, { logFile: storedJob.logFile ?? null });
  await runTrackedJob({ ...storedJob, workspaceRoot, logFile }, () => executeAgyTask({ ...request, onProgress: progress }), { logFile });
}

function parseReviewOutput(result) {
  if (result.structuredOutput && typeof result.structuredOutput === "object") {
    return { parsed: result.structuredOutput, rawOutput: JSON.stringify(result.structuredOutput, null, 2), parseError: null };
  }
  const text = String(result.finalMessage ?? "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return { parsed: JSON.parse(text.slice(start, end + 1)), rawOutput: text, parseError: null };
    } catch (error) {
      return { parsed: null, rawOutput: text, parseError: error.message };
    }
  }
  return { parsed: null, rawOutput: text, parseError: result.error?.message ?? "agy returned no structured review." };
}

async function handleReview(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "cwd"],
    booleanOptions: ["json", "background", "wait"]
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  ensureGitRepository(cwd);
  ensureAgyAvailable(cwd);
  const model = normalizeModel(options.model);
  const effort = normalizeEffort(options.effort);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
  const job = createAgyJob({
    prefix: "review",
    kind: "review",
    title: "Antigravity Review",
    workspaceRoot,
    jobClass: "review",
    summary: `Review ${target.label}`
  });

  await runForegroundCommand(
    job,
    async (progress) => {
      const context = collectReviewContext(cwd, target);
      const prompt = interpolateTemplate(loadPromptTemplate(ROOT_DIR, "adversarial-review"), {
        AGENT_NAME: agyProvider.label,
        REVIEW_KIND: "Review",
        TARGET_LABEL: context.target.label,
        USER_FOCUS: focusText || "No extra focus provided.",
        REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
        REVIEW_INPUT: context.content
      });
      const result = await runAgyTurn(context.repoRoot, {
        prompt,
        model,
        effort,
        sandboxMode: "read-only",
        jsonSchema: REVIEW_SCHEMA,
        onProgress: progress
      });
      const parsed = parseReviewOutput(result);
      const meta = { reviewLabel: "Review", targetLabel: context.target.label, providerLabel: agyProvider.label };
      return {
        exitStatus: result.status === 0 && parsed.parsed ? 0 : 1,
        threadId: result.conversationId,
        turnId: result.turnId,
        payload: {
          review: "Review",
          target,
          threadId: result.conversationId,
          result: parsed.parsed,
          rawOutput: parsed.rawOutput,
          parseError: parsed.parseError,
          ...(result.error ? { failureMessage: result.error.message } : {})
        },
        rendered: renderReviewResult(parsed, meta),
        summary: parsed.parsed?.summary ?? parsed.parseError ?? "Antigravity review finished.",
        jobTitle: "Antigravity Review",
        jobClass: "review",
        targetLabel: context.target.label
      };
    },
    { json: options.json }
  );
}

async function runSubcommand(subcommand, argv) {
  switch (subcommand) {
    case "setup":
      return handleSetup(argv);
    case "task":
      return handleTask(argv);
    case "task-worker":
      return handleTaskWorker(argv);
    case "review":
      return handleReview(argv);
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
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

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
