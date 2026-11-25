import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveCommandCwd } from "../../../lib/companion-cli.mjs";
import { collectReviewContext } from "../../../lib/git.mjs";
import { readRequesterIdentity } from "../../../lib/host.mjs";
import { delegationOptions, resolveModelSelection } from "../../../lib/model-selection.mjs";
import { renderReviewResult } from "../../../lib/render.mjs";
import { buildReviewPrompt, parseReviewArguments, resolveReviewTarget } from "../../../lib/review-target.mjs";
import { createJob, InvalidLabelError } from "../../../lib/state.mjs";
import { sanitizeAgentText } from "../../../lib/untrusted.mjs";
import { resolveWorkspaceRoot } from "../../../lib/workspace.mjs";
import { agyProvider } from "../index.mjs";
import { ensureAgyAvailable, outsideFolders, readAgySavedModel } from "../runtime.mjs";
import { launchAndFollow, openWorkspaceStore } from "./store-run.mjs";
import { modelNoteLines, notesText } from "./task.mjs";

export const REVIEW_ROOT_DIR = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
export const REVIEW_SCHEMA = path.join(REVIEW_ROOT_DIR, "schemas", "review-output.schema.json");

export const usage =
  "review [--target auto|changes|project] [--path <path>]... [--stance peer|critical] [--base <ref>] [--scope auto|working-tree|branch] [--wait|--background] [--label <name>] [--model <model>] [--effort <effort>] [--json] [--] [instructions]";

const LABEL_PATTERN = /^[a-z0-9-]{1,40}$/;

/**
 * The structured review in an agy result: its structured output, else the JSON object between the
 * first "{" and the last "}" of its text; `parsed` is null when there is none.
 */
export function parseReviewOutput(result) {
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

export function reviewLabelFor(stance) {
  return stance === "critical" ? "Critical Review" : "Review";
}

// Takes `--<name> <value>` and `--<name>=<value>` out of the arguments before "--"; returns the
// last value given (null when none) and the remaining arguments.
function takeValueOption(argv, name) {
  const rest = [];
  let value = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      rest.push(...argv.slice(index));
      break;
    }
    if (arg === `--${name}`) {
      value = argv[index + 1] ?? "";
      index += 1;
    } else if (arg.startsWith(`--${name}=`)) {
      value = arg.slice(name.length + 3);
    } else {
      rest.push(arg);
    }
  }
  return { value, rest };
}

function renderReview(view, { quotaNote = null } = {}) {
  const request = view.request ?? {};
  const review = request.review ?? {};
  const parsed = parseReviewOutput({
    structuredOutput: view.row.result_json ? JSON.parse(view.row.result_json) : null,
    finalMessage: view.row.result_text ?? "",
    error: view.row.error ? { message: view.row.error } : null
  });
  const meta = { reviewLabel: reviewLabelFor(review.stance), targetLabel: review.targetLabel, targetKind: review.target, providerLabel: agyProvider.label };
  const failure = view.state !== "completed" && view.row.error ? `${sanitizeAgentText(view.row.error)}\n` : "";
  return `${renderReviewResult(parsed, meta)}${failure}${quotaNote ? `${quotaNote}\n` : ""}${notesText(modelNoteLines(request.model, request.providerModel, null))}`;
}

/**
 * Runs the review command as one store job: the target, the stance and the model are resolved and
 * the review prompt is built before the job exists, so a bad value exits with no job. The job runs
 * one read-only agy turn bound to the review schema, in the repository root for a changes review
 * and in the review root for a project review; --background prints its id instead of waiting.
 */
export async function handleReview(argv) {
  const label = takeValueOption(argv, "label");
  const runId = takeValueOption(label.rest, "run-id");
  const { options, paths, stance, instructions, background } = parseReviewArguments(runId.rest);
  if (label.value !== null && !LABEL_PATTERN.test(label.value)) {
    throw new InvalidLabelError({ label: label.value });
  }
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const target = resolveReviewTarget(cwd, { target: options.target, paths, base: options.base, scope: options.scope });
  ensureAgyAvailable(cwd);
  const selection = await resolveModelSelection(agyProvider, {
    model: options.model,
    effort: options.effort,
    ...delegationOptions(agyProvider, workspaceRoot),
    cwd
  });
  for (const warning of selection.warnings ?? []) {
    process.stderr.write(`${warning}\n`);
  }
  const reviewLabel = reviewLabelFor(stance);
  const context = target.kind === "changes" ? collectReviewContext(cwd, target.changes, { paths: target.paths }) : null;
  const prompt = buildReviewPrompt({ rootDir: REVIEW_ROOT_DIR, providerLabel: agyProvider.label, target, stance, instructions, context });
  const workingFolder = context?.repoRoot ?? target.root;
  const request = {
    cwd,
    worktree: null,
    write: false,
    sandbox: "read-only",
    model: selection.model,
    effort: selection.effort,
    modelSource: selection.modelSource,
    effortSource: selection.effortSource,
    review: { target: target.kind, paths: target.paths, stance, native: false, targetLabel: target.label },
    outputSchema: JSON.parse(fs.readFileSync(REVIEW_SCHEMA, "utf8")),
    allowQuestions: false,
    flags: { background, fresh: false },
    // A reviewed path outside the folder agy runs in is readable through its folder.
    addDirs: outsideFolders(workingFolder, (target.paths ?? []).map((entry) => path.resolve(target.root, entry))),
    providerModel: selection.model ? null : readAgySavedModel(),
    savedModelChange: null
  };

  const { stateDir, store } = openWorkspaceStore(cwd);
  let jobId;
  try {
    const requester = await readRequesterIdentity();
    jobId = createJob(
      store,
      {
        provider: agyProvider.id,
        kind: "review",
        title: `Antigravity ${reviewLabel}`,
        prompt,
        request,
        cwd: workingFolder,
        model: selection.model,
        allowQuestions: false,
        foreground: !background,
        threadId: null,
        ephemeral: false,
        runId: runId.value,
        requester,
        force: false
      },
      { label: label.value }
    ).jobId;
  } catch (error) {
    store.close();
    throw error;
  }

  await launchAndFollow({
    store,
    stateDir,
    jobId,
    background,
    json: Boolean(options.json),
    backgroundText: (view) => `${view.row.title} started in the background as ${view.id}. Check /agent:status ${view.id} for progress.\n`,
    render: renderReview
  });
}

export const run = handleReview;
