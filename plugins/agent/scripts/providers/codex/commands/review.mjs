import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { normalizeArgv, resolveCommandCwd, resolveCommandWorkspace, runForegroundCommand } from "../../../lib/companion-cli.mjs";
import { collectReviewContext } from "../../../lib/git.mjs";
import { resolveModelSelection } from "../../../lib/model-selection.mjs";
import { renderNativeReviewResult, renderReviewResult } from "../../../lib/render.mjs";
import {
  buildReviewPrompt,
  enqueueBackgroundReview,
  parseReviewArguments,
  resolveReviewStance,
  resolveReviewTarget
} from "../../../lib/review-target.mjs";
import { getConfig, upsertJob } from "../../../lib/state.mjs";
import { createProviderJob, firstMeaningfulLine } from "../../../lib/task-launch.mjs";
import { resolveWorkspaceRoot } from "../../../lib/workspace.mjs";
import { codexProvider } from "../index.mjs";
import { KNOWN_REASONING_EFFORTS } from "../model-catalog.mjs";
import {
  buildReviewThreadName,
  ensureCodexAvailable,
  parseStructuredOutput,
  readOutputSchema,
  runAppServerReview,
  runAppServerTurn
} from "../runtime.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const EFFORT_USAGE = `<${KNOWN_REASONING_EFFORTS.join("|")}>`;

export const usage = `review [--target auto|changes|project] [--path <path>]... [--stance peer|critical] [--base <ref>] [--scope auto|working-tree|branch] [--wait|--background] [--model <id|family|default|configured>] [--effort ${EFFORT_USAGE}] [--] [instructions]`;
export const adversarialUsage = `adversarial-review [--target auto|changes|project] [--path <path>]... [--base <ref>] [--scope auto|working-tree|branch] [--wait] [--model <id|family|default|configured>] [--effort ${EFFORT_USAGE}] [--] [instructions]`;

export function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

/**
 * Codex's built-in reviewer runs only a peer review of git changes with no instructions and no
 * paths; every other review is a turn bound to the review output schema.
 */
export function usesNativeReview(target, stance, instructions) {
  return (
    target.kind === "changes" &&
    stance === "peer" &&
    !String(instructions ?? "").trim() &&
    target.paths.length === 0 &&
    buildNativeReviewTarget(target.changes) !== null
  );
}

function reviewLabelFor(stance) {
  return stance === "critical" ? "Critical Review" : "Review";
}

// The job record keeps the model and effort Codex reports for the review's thread.
function recordReportedSelection(workspaceRoot, jobId) {
  if (!jobId) {
    return null;
  }
  return (reported) =>
    upsertJob(workspaceRoot, {
      id: jobId,
      ...(reported.model ? { model: reported.model } : {}),
      ...(reported.effort ? { effort: reported.effort } : {})
    });
}

/**
 * Runs one Codex review. `request.reviewTarget` is a `resolveReviewTarget` result; `stance`,
 * `instructions` and `native` say how it runs. A native review uses Codex's built-in reviewer
 * on an ephemeral thread; a schema-bound review runs a read-only turn on a persistent thread.
 */
export async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  const target =
    request.reviewTarget ??
    resolveReviewTarget(request.cwd, { target: request.target, paths: request.paths, base: request.base, scope: request.scope });
  const stance = resolveReviewStance(request.stance);
  const instructions = String(request.instructions ?? "").trim();
  const native = request.native ?? usesNativeReview(target, stance, instructions);
  const reviewLabel = reviewLabelFor(stance);
  const jobTitle = `Codex ${reviewLabel}`;
  const onThreadReady = recordReportedSelection(resolveWorkspaceRoot(request.cwd), request.jobId);

  if (native) {
    const result = await runAppServerReview(request.cwd, {
      target: buildNativeReviewTarget(target.changes),
      model: request.model,
      effort: request.effort,
      onThreadReady,
      onProgress: request.onProgress
    });
    const payload = {
      review: reviewLabel,
      target: { ...target.changes, ...target },
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      ...(result.warnings?.length > 0 ? { notes: result.warnings } : {}),
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
      { reviewLabel, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewLabel} completed.`),
      jobTitle,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = target.kind === "changes" ? collectReviewContext(request.cwd, target.changes, { paths: target.paths }) : null;
  const prompt = buildReviewPrompt({
    rootDir: ROOT_DIR,
    providerLabel: codexProvider.label,
    target,
    stance,
    instructions,
    context
  });
  const result = await runAppServerTurn(context?.repoRoot ?? target.root, {
    prompt,
    model: request.model,
    effort: request.effort,
    onThreadReady,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress,
    persistThread: true,
    threadName: buildReviewThreadName(`${reviewLabel} of ${target.label}`)
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewLabel,
    target: { ...target.changes, ...target },
    threadId: result.threadId,
    context: context
      ? {
          repoRoot: context.repoRoot,
          branch: context.branch,
          summary: context.summary
        }
      : { root: target.root, paths: target.paths },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary,
    ...(result.warnings?.length > 0 ? { notes: result.warnings } : {})
  };

  // A turn that ends without valid JSON is a failed review, so it is never handed off as findings.
  return {
    exitStatus: result.status !== 0 ? result.status : parsed.parsed ? 0 : 1,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel,
      targetLabel: target.label,
      targetKind: target.kind,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewLabel} finished.`),
    jobTitle,
    jobClass: "review",
    targetLabel: target.label
  };
}

export function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function printWarnings(selection) {
  for (const warning of selection.warnings ?? []) {
    process.stderr.write(`${warning}\n`);
  }
}

/**
 * Runs the review command in the foreground, or with --background as a job of the background
 * worker. The target, the stance and the model are resolved before the job is created, so a bad
 * value exits with no job record. The job record names the target, the paths,
 * the stance, whether the built-in reviewer runs, and the model and effort with their sources.
 */
export async function handleReviewCommand(argv) {
  const { options, paths, stance, instructions, background } = parseReviewArguments(argv, { aliasMap: { m: "model" } });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const target = resolveReviewTarget(cwd, { target: options.target, paths, base: options.base, scope: options.scope });
  const native = usesNativeReview(target, stance, instructions);
  const reviewLabel = reviewLabelFor(stance);
  ensureCodexAvailable(cwd);
  const selection = await resolveModelSelection(codexProvider, {
    model: options.model,
    effort: options.effort,
    setting: getConfig(workspaceRoot).models?.[codexProvider.id] ?? null,
    cwd
  });
  printWarnings(selection);

  // A native review runs on a single-use thread that Codex does not keep, so no resume command
  // applies to it; a schema-bound review's thread can be continued.
  const job = createProviderJob(codexProvider, {
    prefix: "review",
    kind: "review",
    kindLabel: getJobKindLabel("review", "review"),
    title: `Codex ${reviewLabel}`,
    workspaceRoot,
    jobClass: "review",
    summary: `${reviewLabel} ${target.label}`,
    ephemeralThread: native,
    review: { target: target.kind, paths: target.paths, stance, native },
    model: selection.model,
    effort: selection.effort,
    modelSource: selection.modelSource,
    effortSource: selection.effortSource
  });
  const request = {
    cwd,
    reviewTarget: target,
    stance,
    instructions,
    native,
    model: selection.model,
    effort: selection.effort,
    jobId: job.id
  };
  if (background) {
    enqueueBackgroundReview(cwd, job, request, { workerScript: codexProvider.companionScript, json: options.json });
    return;
  }
  await runForegroundCommand(job, (progress) => executeReviewRun({ ...request, onProgress: progress }), { json: options.json });
}

export async function run(argv) {
  return handleReviewCommand(argv);
}

// The adversarial-review subcommand runs the review command with the critical stance.
export async function runAdversarial(argv) {
  return handleReviewCommand(["--stance", "critical", ...normalizeArgv(argv)]);
}
