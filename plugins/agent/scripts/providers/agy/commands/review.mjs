import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseCommandInput, resolveCommandCwd, resolveCommandWorkspace, runForegroundCommand } from "../../../lib/companion-cli.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "../../../lib/git.mjs";
import { resolveModelSelection } from "../../../lib/model-selection.mjs";
import { interpolateTemplate, loadPromptTemplate } from "../../../lib/prompts.mjs";
import { renderReviewResult } from "../../../lib/render.mjs";
import { createProviderJob } from "../../../lib/task-launch.mjs";
import { agyProvider } from "../index.mjs";
import { ensureAgyAvailable, runAgyTurn } from "../runtime.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");

export const usage = "review [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <effort>] [focus text]";

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

export async function handleReview(argv) {
  // --background and --wait are accepted because the command wrapper passes its arguments
  // through; the wrapper decides background execution, and the review itself always runs in
  // the foreground of this process.
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "cwd"],
    booleanOptions: ["json", "background", "wait"]
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  ensureGitRepository(cwd);
  ensureAgyAvailable(cwd);
  const { model, effort } = await resolveModelSelection(agyProvider, { model: options.model, effort: options.effort, cwd });
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
  const job = createProviderJob(agyProvider, {
    prefix: "review",
    kind: "review",
    kindLabel: "review",
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
        // A failed run reports its own failure; a parse error only explains a successful run.
        summary:
          result.status !== 0
            ? result.error?.message ?? parsed.parseError ?? "Antigravity review failed."
            : parsed.parsed?.summary ?? parsed.parseError ?? "Antigravity review finished.",
        jobTitle: "Antigravity Review",
        jobClass: "review",
        targetLabel: context.target.label
      };
    },
    { json: options.json }
  );
}

export const run = handleReview;
