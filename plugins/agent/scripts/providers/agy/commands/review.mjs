import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveCommandCwd, resolveCommandWorkspace, runForegroundCommand } from "../../../lib/companion-cli.mjs";
import { collectReviewContext } from "../../../lib/git.mjs";
import { resolveModelSelection } from "../../../lib/model-selection.mjs";
import { renderReviewResult } from "../../../lib/render.mjs";
import {
  buildReviewPrompt,
  enqueueBackgroundReview,
  parseReviewArguments,
  resolveReviewStance,
  resolveReviewTarget
} from "../../../lib/review-target.mjs";
import { getConfig } from "../../../lib/state.mjs";
import { createProviderJob } from "../../../lib/task-launch.mjs";
import { resolveWorkspaceRoot } from "../../../lib/workspace.mjs";
import { agyProvider } from "../index.mjs";
import { ensureAgyAvailable, readAgySavedModel, runAgyTurn } from "../runtime.mjs";
import { modelNoteLines, notesText, readRunModel } from "./task.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");

export const usage =
  "review [--target auto|changes|project] [--path <path>]... [--stance peer|critical] [--base <ref>] [--scope auto|working-tree|branch] [--wait|--background] [--model <model>] [--effort <effort>] [--] [instructions]";

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

function reviewLabelFor(stance) {
  return stance === "critical" ? "Critical Review" : "Review";
}

/**
 * Runs one Antigravity review: a read-only turn bound to the review output schema, in the
 * repository root for a changes review and in the review root for a project review.
 * `request.reviewTarget` is a `resolveReviewTarget` result. Without a model the review runs on
 * the model saved in the Antigravity settings, which the job record and the output name.
 */
export async function executeAgyReview(request) {
  ensureAgyAvailable(request.cwd);
  const { providerModel, savedModelChange } = readRunModel(resolveWorkspaceRoot(request.cwd), request);
  const target =
    request.reviewTarget ??
    resolveReviewTarget(request.cwd, { target: request.target, paths: request.paths, base: request.base, scope: request.scope });
  const stance = resolveReviewStance(request.stance);
  const reviewLabel = reviewLabelFor(stance);
  const jobTitle = `Antigravity ${reviewLabel}`;
  const context = target.kind === "changes" ? collectReviewContext(request.cwd, target.changes, { paths: target.paths }) : null;
  const prompt = buildReviewPrompt({
    rootDir: ROOT_DIR,
    providerLabel: agyProvider.label,
    target,
    stance,
    instructions: request.instructions ?? "",
    context
  });
  const result = await runAgyTurn(context?.repoRoot ?? target.root, {
    prompt,
    model: request.model,
    effort: request.effort,
    sandboxMode: "read-only",
    jsonSchema: REVIEW_SCHEMA,
    onProgress: request.onProgress
  });
  const parsed = parseReviewOutput(result);
  const notes = modelNoteLines(request.model, providerModel, savedModelChange);
  const meta = { reviewLabel, targetLabel: target.label, targetKind: target.kind, providerLabel: agyProvider.label };
  return {
    exitStatus: result.status === 0 && parsed.parsed ? 0 : 1,
    threadId: result.conversationId,
    turnId: result.turnId,
    payload: {
      review: reviewLabel,
      target: { ...target.changes, ...target },
      threadId: result.conversationId,
      result: parsed.parsed,
      rawOutput: parsed.rawOutput,
      parseError: parsed.parseError,
      ...(notes.length > 0 ? { notes } : {}),
      ...(result.error ? { failureMessage: result.error.message } : {})
    },
    rendered: `${renderReviewResult(parsed, meta)}${notesText(notes)}`,
    // A failed run reports its own failure; a parse error only explains a successful run.
    summary:
      result.status !== 0
        ? result.error?.message ?? parsed.parseError ?? "Antigravity review failed."
        : parsed.parsed?.summary ?? parsed.parseError ?? "Antigravity review finished.",
    jobTitle,
    jobClass: "review",
    targetLabel: target.label
  };
}

/**
 * Runs the review command in the foreground, or with --background as a job of the background
 * worker. The target, the stance and the model are resolved before the job is created, so a bad
 * value exits with no job record.
 */
export async function handleReview(argv) {
  const { options, paths, stance, instructions, background } = parseReviewArguments(argv);
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const target = resolveReviewTarget(cwd, { target: options.target, paths, base: options.base, scope: options.scope });
  ensureAgyAvailable(cwd);
  const selection = await resolveModelSelection(agyProvider, {
    model: options.model,
    effort: options.effort,
    setting: getConfig(workspaceRoot).models?.[agyProvider.id] ?? null,
    cwd
  });
  for (const warning of selection.warnings ?? []) {
    process.stderr.write(`${warning}\n`);
  }
  const reviewLabel = reviewLabelFor(stance);
  // Without a model agy runs on the model saved in its settings. The queued job names the model
  // saved now, and the run records the one agy reads when it starts.
  const providerModel = selection.model ? null : readAgySavedModel();
  const job = createProviderJob(agyProvider, {
    prefix: "review",
    kind: "review",
    kindLabel: "review",
    title: `Antigravity ${reviewLabel}`,
    workspaceRoot,
    jobClass: "review",
    summary: `${reviewLabel} ${target.label}`,
    review: { target: target.kind, paths: target.paths, stance, native: false },
    model: selection.model,
    effort: selection.effort,
    modelSource: selection.modelSource,
    effortSource: selection.effortSource,
    providerModel
  });
  const request = {
    cwd,
    reviewTarget: target,
    stance,
    instructions,
    model: selection.model,
    effort: selection.effort,
    providerModel,
    jobId: job.id
  };

  if (background) {
    enqueueBackgroundReview(cwd, job, request, { workerScript: agyProvider.companionScript, json: options.json });
    return;
  }
  await runForegroundCommand(job, (progress) => executeAgyReview({ ...request, onProgress: progress }), { json: options.json });
}

export const run = handleReview;
