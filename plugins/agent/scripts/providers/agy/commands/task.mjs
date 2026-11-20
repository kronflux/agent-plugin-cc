import { parseCommandInput, resolveCommandCwd, resolveCommandWorkspace } from "../../../lib/companion-cli.mjs";
import { readStdinIfPiped } from "../../../lib/fs.mjs";
import { getSessionId, readRequesterIdentity } from "../../../lib/host.mjs";
import { delegationOptions, resolveModelSelection, storedSelection } from "../../../lib/model-selection.mjs";
import { renderTaskResult } from "../../../lib/render.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createJob, decideNext, generateJobId, getConfig, InvalidLabelError, listJobViews, PROMPT_LIMIT_BYTES, PromptTooLargeError } from "../../../lib/state.mjs";
import { attachWorktree, buildSessionReviewHandoff, discardLaunchWorktree, readTaskInputFiles } from "../../../lib/task-launch.mjs";
import { agyProvider } from "../index.mjs";
import { ensureAgyAvailable, readAgySavedModel } from "../runtime.mjs";
import { launchAndFollow, openWorkspaceStore } from "./store-run.mjs";

export const usage =
  "task [--background] [--write] [--worktree] [--from-last-review] [--prompt-file <file>] [--resume-last|--resume-thread <conversation-id>|--fresh] [--force] [--label <name>] [--model <model>] [--effort <effort>] [--allow-questions] [--output-schema <file>] [--json] [--] [prompt]";

const LABEL_PATTERN = /^[a-z0-9-]{1,40}$/;
// The plugin root, which holds the prompt templates.
const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

export function writeSandboxMode(workspaceRoot, write) {
  return write ? getConfig(workspaceRoot).writeSandbox ?? "workspace-write" : "read-only";
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

/** The warning printed when a job uses a thread behind a barrier because of --force. */
export function overlapWarning(threadId, barrierJobId) {
  return `Thread ${threadId} was last used by job ${barrierJobId}, whose provider exit was not observed; it may still run and overlap this job.`;
}

/**
 * The `createJob` arguments of an Antigravity task, from its parsed options (the prompt, the
 * resolved model choice, the schema already read and augmented) and the requester.
 */
export function buildTaskJobFields(options, { cwd, workspaceRoot = cwd, requester }) {
  const request = {
    cwd,
    worktree: null,
    write: Boolean(options.write),
    sandbox: options.sandbox ?? (options.write ? "workspace-write" : "read-only"),
    model: options.model ?? null,
    effort: options.effort ?? null,
    modelSource: options.modelSource ?? null,
    effortSource: options.effortSource ?? null,
    review: null,
    outputSchema: options.outputSchema ?? null,
    allowQuestions: Boolean(options.allowQuestions),
    flags: { background: Boolean(options.background), fresh: Boolean(options.fresh) },
    providerModel: options.providerModel ?? null,
    savedModelChange: options.savedModelChange ?? null
  };
  return {
    fields: {
      provider: agyProvider.id,
      kind: "task",
      title: options.threadId ? "Antigravity Resume" : "Antigravity Task",
      prompt: options.prompt,
      request,
      cwd: workspaceRoot,
      model: request.model,
      allowQuestions: request.allowQuestions,
      foreground: !options.background,
      threadId: options.threadId ?? null,
      ephemeral: false,
      runId: options.runId ?? null,
      requester,
      force: Boolean(options.force)
    },
    label: options.label ?? null
  };
}

// The newest Antigravity chain tip of this session (of jobs without a session when none is set)
// that can be continued: the tip resume-last continues.
function resumeCandidate(store, sessionId) {
  return (
    listJobViews(store, { sessionId, all: !sessionId, limit: 500 }).find(
      (view) => view.provider === agyProvider.id && view.isTip && (view.row.session_id ?? null) === (sessionId ?? null) && view.resumable
    ) ?? null
  );
}

// The newest Antigravity job on a conversation, whose model choice a resumed conversation keeps.
function newestOnThread(store, threadId) {
  return listJobViews(store, { all: true, limit: 500 }).find((view) => view.provider === agyProvider.id && view.row.thread_id === threadId) ?? null;
}

function selectionOf(view) {
  if (!view) {
    return null;
  }
  const { model = null, effort = null, modelSource = null, effortSource = null } = view.request ?? {};
  return storedSelection({ model, effort, modelSource, effortSource });
}

// Applies a resume's own choices to the successor the decision inserted, inside its transaction.
function applyResumeChoices(db, successorId, request) {
  const row = db.prepare("SELECT request_json FROM jobs WHERE id = ?").get(successorId);
  const merged = { ...JSON.parse(row.request_json), ...request };
  db.prepare("UPDATE jobs SET request_json = ?, model = ?, allow_questions = ? WHERE id = ?").run(
    JSON.stringify(merged),
    merged.model ?? null,
    merged.allowQuestions ? 1 : 0,
    successorId
  );
}

function renderTask(view) {
  const request = view.request ?? {};
  const rendered = renderTaskResult(
    {
      rawOutput: view.row.result_text ?? "",
      failureMessage: view.row.error ?? "",
      structuredOutput: view.row.result_json ? JSON.parse(view.row.result_json) : null,
      structuredResultTooLarge: Boolean(view.row.result_json_too_large)
    },
    {
      title: view.row.title,
      jobId: view.id,
      write: Boolean(request.write),
      providerLabel: agyProvider.label,
      worktreePath: request.worktree?.path ?? null,
      worktreeBranch: request.worktree?.branch ?? null
    }
  );
  return `${rendered}${notesText(modelNoteLines(request.model, request.providerModel, request.savedModelChange))}`;
}

export async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "resume-thread", "label", "run-id", "output-schema", "prompt-file"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "allow-questions", "force", "worktree", "from-last-review"],
    stopAtFirstPositional: true
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  const resumeThreadId = options["resume-thread"] ? String(options["resume-thread"]).trim() : null;
  if ([resumeLast, fresh, Boolean(resumeThreadId)].filter(Boolean).length > 1) {
    throw new Error("Choose only one of --resume/--resume-last, --resume-thread, and --fresh.");
  }
  const allowQuestions = Boolean(options["allow-questions"]);
  const files = readTaskInputFiles(cwd, { promptFile: options["prompt-file"] ?? null, outputSchema: options["output-schema"] ?? null, allowQuestions });
  if (files.prompt !== null && positionals.length > 0) {
    throw new Error("Give the prompt either as text or with --prompt-file, not both.");
  }
  let prompt = (files.prompt ?? (positionals.join(" ") || (await readStdinIfPiped()))).trim();
  // --from-last-review asks agy to address the newest finished review of this session, of any
  // provider; the prompt, when given, becomes the user's instructions in it.
  if (options["from-last-review"]) {
    const handoff = openWorkspaceStore(cwd);
    try {
      prompt = buildSessionReviewHandoff(handoff.store, { sessionId: getSessionId(), userRequest: prompt, rootDir: PLUGIN_ROOT });
    } finally {
      handoff.store.close();
    }
  }
  if (!prompt) {
    throw new Error("Provide a prompt or piped stdin.");
  }
  const worktree = Boolean(options.worktree);
  if (worktree && (resumeLast || resumeThreadId)) {
    throw new Error("--worktree starts a new job in a new worktree; a continued conversation runs where its job ran.");
  }
  // Every check that needs no provider runs before agy is contacted and before any job exists.
  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes > PROMPT_LIMIT_BYTES) {
    throw new PromptTooLargeError({ bytes });
  }
  const label = options.label === undefined ? null : String(options.label);
  if (label !== null && !LABEL_PATTERN.test(label)) {
    throw new InvalidLabelError({ label });
  }
  const outputSchema = files.schema;
  ensureAgyAvailable(cwd);

  const { stateDir, store } = openWorkspaceStore(cwd);
  let jobId;
  try {
    const requester = await readRequesterIdentity();
    const continued = resumeLast ? resumeCandidate(store, requester.sessionId) : resumeThreadId ? newestOnThread(store, resumeThreadId) : null;
    if (resumeLast && !continued) {
      throw new Error("No previous Antigravity conversation was found for this session.");
    }
    // A resumed conversation keeps the model and effort of the job it continues, except for a
    // value the command gives.
    const selection = await resolveModelSelection(agyProvider, {
      model: options.model,
      effort: options.effort,
      ...delegationOptions(agyProvider, workspaceRoot),
      stored: selectionOf(continued),
      cwd
    });
    for (const warning of selection.warnings ?? []) {
      process.stderr.write(`${warning}\n`);
    }
    // Without a model agy runs on the model saved in its settings; the job names the one saved now.
    const providerModel = selection.model ? null : readAgySavedModel();
    const started = continued?.request?.providerModel ?? null;
    const savedModelChange =
      started && providerModel && started !== providerModel
        ? `Antigravity's saved model changed from ${started} to ${providerModel} since this conversation started.`
        : null;
    if (savedModelChange) {
      process.stderr.write(`${savedModelChange}\n`);
    }
    const write = Boolean(options.write);
    const built = buildTaskJobFields(
      {
        prompt,
        write,
        sandbox: writeSandboxMode(workspaceRoot, write),
        model: selection.model,
        effort: selection.effort,
        modelSource: selection.modelSource,
        effortSource: selection.effortSource,
        providerModel,
        savedModelChange,
        outputSchema,
        allowQuestions,
        background: Boolean(options.background),
        fresh,
        label,
        runId: options["run-id"] ? String(options["run-id"]) : null,
        threadId: resumeThreadId,
        force: Boolean(options.force)
      },
      { cwd, workspaceRoot, requester }
    );
    let barrierJobId = null;
    let threadId = resumeThreadId;
    if (resumeLast) {
      // The continued job runs in the checkout of the job it continues, so it keeps that worktree.
      const { cwd: _cwd, outputSchema: _schema, worktree: _worktree, ...choices } = built.fields.request;
      const decided = decideNext(
        store,
        { resumeLast: { provider: agyProvider.id, sessionId: requester.sessionId ?? null } },
        {
          action: "continue",
          message: prompt,
          requester,
          outputSchema,
          force: Boolean(options.force),
          withinDecision: (db, { won, successorId }) => {
            if (won) {
              applyResumeChoices(db, successorId, choices);
            }
          }
        }
      );
      if (!decided.won) {
        throw new Error(`Job ${decided.view?.id ?? continued.id} was already continued by ${decided.successorId}.`);
      }
      jobId = decided.successorId;
      barrierJobId = decided.barrierJobId ?? null;
      threadId = continued.row.thread_id;
    } else {
      // A worktree job's worktree exists before its row, so no scanner launches the job without
      // it. The job records its worktree, working folder and work line with the row itself.
      let jobFields = built.fields;
      let attached = null;
      if (worktree) {
        const newId = generateJobId(built.fields.kind ?? "job");
        try {
          attached = attachWorktree({ id: newId, workspaceRoot });
        } catch (error) {
          throw new Error(`The worktree of ${newId} could not be created, so no job was created: ${error.message}`);
        }
        const planned = { path: attached.worktreePath, branch: attached.worktreeBranch };
        jobFields = {
          ...built.fields,
          jobId: newId,
          cwd: planned.path,
          prompt: `${prompt}\n\nWork only inside ${planned.path}.`,
          request: { ...built.fields.request, worktree: planned }
        };
      }
      let created;
      try {
        created = createJob(store, jobFields, { label: built.label });
      } catch (error) {
        throw attached ? discardLaunchWorktree(workspaceRoot, attached, error) : error;
      }
      jobId = created.jobId;
      barrierJobId = created.barrierJobId ?? null;
    }
    if (barrierJobId) {
      process.stderr.write(`${overlapWarning(threadId, barrierJobId)}\n`);
    }
  } catch (error) {
    store.close();
    throw error;
  }

  await launchAndFollow({
    store,
    stateDir,
    jobId,
    background: Boolean(options.background),
    json: Boolean(options.json),
    backgroundText: (view) => `${view.row.title} started in the background as ${view.id}. Check /agent:status ${view.id} for progress.\n`,
    render: renderTask
  });
}

export const run = handleTask;

const CANDIDATE_STATES = new Set(["waiting", "interrupted", "completed", "failed", "cancelled"]);

/**
 * Prints one JSON object naming the Antigravity job a resume would continue: the newest chain tip of
 * this session, in the order resume-last uses, that can be continued and is waiting, interrupted,
 * completed, failed or cancelled; `available: false` with null fields when there is none.
 */
export async function handleResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const { store } = openWorkspaceStore(resolveCommandCwd(options));
  try {
    const sessionId = getSessionId() ?? null;
    const view =
      listJobViews(store, { sessionId, all: !sessionId, limit: 500 }).find(
        (entry) => entry.provider === agyProvider.id && entry.isTip && (entry.row.session_id ?? null) === sessionId && entry.resumable && CANDIDATE_STATES.has(entry.state)
      ) ?? null;
    const reply = view
      ? { available: true, jobId: view.id, threadId: view.row.thread_id ?? null, label: view.label ?? null, status: view.state, provider: agyProvider.id }
      : { available: false, jobId: null, threadId: null, label: null, status: null, provider: agyProvider.id };
    process.stdout.write(`${JSON.stringify(reply)}\n`);
  } finally {
    store.close();
  }
}
