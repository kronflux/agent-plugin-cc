import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseCommandInput, resolveCommandCwd, resolveCommandWorkspace, runForegroundCommand } from "../../../lib/companion-cli.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "../../../lib/git.mjs";
import { resolveModelSelection } from "../../../lib/model-selection.mjs";
import { interpolateTemplate, loadPromptTemplate } from "../../../lib/prompts.mjs";
import { renderNativeReviewResult, renderReviewResult } from "../../../lib/render.mjs";
import { createProviderJob, firstMeaningfulLine } from "../../../lib/task-launch.mjs";
import { codexProvider } from "../index.mjs";
import { KNOWN_REASONING_EFFORTS } from "../model-catalog.mjs";
import { ensureCodexAvailable, parseStructuredOutput, readOutputSchema, runAppServerReview, runAppServerTurn } from "../runtime.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const EFFORT_USAGE = `<${KNOWN_REASONING_EFFORTS.join("|")}>`;

export const usage = `review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model|spark>] [--effort ${EFFORT_USAGE}]`;
export const adversarialUsage = `adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model|spark>] [--effort ${EFFORT_USAGE}] [focus text]`;

export function buildAdversarialReviewPrompt(context, focusText) {
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

export function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

export function validateNativeReviewRequest(target, focusText) {
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

export async function executeReviewRun(request) {
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

export function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

export function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

export async function handleReviewCommand(argv, config) {
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
  const job = createProviderJob(codexProvider, {
    prefix: "review",
    kind: metadata.kind,
    kindLabel: getJobKindLabel(metadata.kind, "review"),
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary,
    ephemeralThread: true
  });
  await runForegroundCommand(
    job,
    async (progress) => {
      const selection = await resolveModelSelection(codexProvider, { model: options.model, effort: options.effort, cwd });
      return executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: selection.model,
        effort: selection.effort,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      });
    },
    { json: options.json }
  );
}

export async function run(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

export async function runAdversarial(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Adversarial Review"
  });
}
