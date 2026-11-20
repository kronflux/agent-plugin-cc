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
import { sortJobsNewestFirst } from "../../../lib/job-control.mjs";
import { newestJobOnThread, resolveModelSelection, storedSelection } from "../../../lib/model-selection.mjs";
import { renderTaskResult } from "../../../lib/render.mjs";
import { getConfig, listJobs, takeJobMessages, upsertJob, writeJobMessageOutcome } from "../../../lib/state.mjs";
import { createProviderJob, firstMeaningfulLine, shorten } from "../../../lib/task-launch.mjs";
import { resolveWorkspaceRoot } from "../../../lib/workspace.mjs";
import { agyProvider } from "../index.mjs";
import { ensureAgyAvailable, readAgySavedModel, runAgyTurn } from "../runtime.mjs";

// Background tasks run in a worker started from the agy companion script.
const COMPANION_SCRIPT = agyProvider.companionScript;

export const usage = "task [--background] [--write] [--resume-last|--resume-thread <conversation-id>|--fresh] [--model <model>] [--effort <effort>] [--] [prompt]";

export function writeSandboxMode(workspaceRoot, write) {
  return write ? getConfig(workspaceRoot).writeSandbox ?? "workspace-write" : "read-only";
}

// The newest agy task of this Claude session that has a conversation, else of the repository.
// A queued or running agy task of this session (of any session when none is set) blocks the
// resume, including a queued one that has no conversation yet.
export function resolveLatestConversation(workspaceRoot) {
  const sessionId = getSessionId();
  const agyTasks = sortJobsNewestFirst(listJobs(workspaceRoot)).filter(
    (job) => job.provider === agyProvider.id && job.jobClass === "task"
  );
  const active = agyTasks.find(
    (job) => (job.status === "queued" || job.status === "running") && (!sessionId || job.sessionId === sessionId)
  );
  if (active) {
    throw new Error(`Task ${active.id} is still running. Use /agent:status before continuing it.`);
  }
  const tasks = agyTasks.filter((job) => job.threadId);
  return (sessionId ? tasks.find((job) => job.sessionId === sessionId) : null) ?? tasks[0] ?? null;
}

// The lines of a job's output that name the model agy used when the plugin named none.
export function modelNoteLines(model, providerModel, savedModelChange) {
  if (model) {
    return [];
  }
  const lines = [providerModel ? `Model: ${providerModel} (from the Antigravity settings)` : "Model: chosen by Antigravity"];
  if (savedModelChange) {
    lines.push(savedModelChange);
  }
  return lines;
}

/** Note lines as the text that follows a job's output, one per line; empty for no lines. */
export function notesText(lines) {
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

// Without a model agy runs on the model saved in its settings, which it reads when it starts. The
// settings are therefore read when the job runs, not when it was queued, and the job record and
// output name that model. A resumed conversation whose saved model changed since it started
// gets one line that names both.
export function readRunModel(workspaceRoot, request) {
  if (request.model) {
    return { providerModel: null, savedModelChange: null };
  }
  const providerModel = readAgySavedModel();
  const started = request.continuedProviderModel ?? null;
  const savedModelChange =
    started && providerModel && started !== providerModel
      ? `Antigravity's saved model changed from ${started} to ${providerModel} since this conversation started.`
      : null;
  if (savedModelChange) {
    process.stderr.write(`${savedModelChange}\n`);
  }
  if (request.jobId && providerModel !== (request.providerModel ?? null)) {
    upsertJob(workspaceRoot, { id: request.jobId, providerModel });
  }
  return { providerModel, savedModelChange };
}

export async function executeAgyTask(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureAgyAvailable(request.cwd);
  const { providerModel, savedModelChange } = readRunModel(workspaceRoot, request);
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
  // The payload keeps the model lines, so result prints them after the stored output.
  const notes = modelNoteLines(request.model, providerModel, savedModelChange);
  return {
    exitStatus: result.status,
    threadId: result.conversationId,
    turnId: result.turnId,
    payload: {
      status: result.status,
      jobId: request.jobId ?? null,
      threadId: result.conversationId,
      rawOutput,
      ...(notes.length > 0 ? { notes } : {}),
      ...(result.status !== 0 && failureMessage ? { failureMessage } : {})
    },
    rendered: `${renderTaskResult({ rawOutput, failureMessage }, { title, jobId: request.jobId ?? null, write: Boolean(request.write), providerLabel: agyProvider.label })}${notesText(notes)}`,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${title} finished.`)),
    jobTitle: title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

export async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "resume-thread"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    stopAtFirstPositional: true
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  let resumeThreadId = options["resume-thread"] ? String(options["resume-thread"]).trim() : null;
  if ([resumeLast, fresh, Boolean(resumeThreadId)].filter(Boolean).length > 1) {
    throw new Error("Choose only one of --resume/--resume-last, --resume-thread, and --fresh.");
  }
  const prompt = (positionals.join(" ") || (await readStdinIfPiped())).trim();
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
  // A resumed conversation keeps the model and effort of the newest job on it, except for a value
  // the command gives.
  const continued = newestJobOnThread(workspaceRoot, agyProvider.id, resumeThreadId);
  const selection = await resolveModelSelection(agyProvider, {
    model: options.model,
    effort: options.effort,
    setting: getConfig(workspaceRoot).models?.[agyProvider.id] ?? null,
    stored: storedSelection(continued),
    cwd
  });
  for (const warning of selection.warnings ?? []) {
    process.stderr.write(`${warning}\n`);
  }
  const { model, effort } = selection;
  // Without a model agy runs on the model saved in its settings. The queued job names the model
  // saved now, and the run records the one agy reads when it starts.
  const providerModel = model ? null : readAgySavedModel();

  const write = Boolean(options.write);
  const job = createProviderJob(agyProvider, {
    prefix: "task",
    kind: "task",
    kindLabel: "rescue",
    title: resumeThreadId ? "Antigravity Resume" : "Antigravity Task",
    workspaceRoot,
    jobClass: "task",
    summary: shorten(prompt),
    write,
    model,
    effort,
    modelSource: selection.modelSource,
    effortSource: selection.effortSource,
    providerModel
  });
  const continuedProviderModel = continued?.providerModel ?? null;
  const request = { cwd, model, effort, providerModel, continuedProviderModel, prompt, write, resumeThreadId, jobId: job.id };

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

export const run = handleTask;
