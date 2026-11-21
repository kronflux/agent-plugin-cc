import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { outputCommandResult, resolveCommandCwd, resolveCommandWorkspace } from "../../../lib/companion-cli.mjs";
import { collectReviewContext } from "../../../lib/git.mjs";
import { delegationOptions, resolveModelSelection } from "../../../lib/model-selection.mjs";
import { renderNativeReviewResult, renderReviewResult } from "../../../lib/render.mjs";
import {
  buildReviewPrompt,
  parseReviewArguments,
  resolveReviewTarget
} from "../../../lib/review-target.mjs";
import { readRequesterIdentity } from "../../../lib/host.mjs";
import { codexProvider } from "../index.mjs";
import { KNOWN_REASONING_EFFORTS } from "../model-catalog.mjs";
import { buildTaskJobFields, startStoreJob, waitStoreJob } from "./task.mjs";
import {
  ensureCodexAvailable,
  parseStructuredOutput,
  readOutputSchema
} from "../runtime.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const EFFORT_USAGE = `<${KNOWN_REASONING_EFFORTS.join("|")}>`;

export const usage = `review [--target auto|changes|project] [--path <path>]... [--stance peer|critical] [--base <ref>] [--scope auto|working-tree|branch] [--wait|--background] [--json] [--label <name>] [--model <id|family|default|configured>] [--effort ${EFFORT_USAGE}] [--] [instructions]`;

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

function printWarnings(selection) {
  for (const warning of selection.warnings ?? []) {
    process.stderr.write(`${warning}\n`);
  }
}

// Takes `--label <name>` and `--run-id <id>` (also written `--label=<name>`) out of the review
// arguments; resolves to `{ argv, label, runId }`.
function takeJobFlags(argv) {
  const rest = [];
  const found = { label: null, runId: null };
  const names = { "--label": "label", "--run-id": "runId" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      rest.push(...argv.slice(index));
      break;
    }
    const equalsAt = token.indexOf("=");
    const flag = equalsAt === -1 ? token : token.slice(0, equalsAt);
    if (names[flag]) {
      const value = equalsAt === -1 ? argv[index + 1] : token.slice(equalsAt + 1);
      if (value === undefined) {
        throw new Error(`Missing value for ${flag}`);
      }
      found[names[flag]] = value;
      if (equalsAt === -1) {
        index += 1;
      }
      continue;
    }
    rest.push(token);
  }
  return { argv: rest, ...found };
}

// The rendered result of a finished Codex review, read from its job row.
function renderStoredReview(view, { reviewLabel, targetLabel, targetKind, native }) {
  const row = view?.row ?? {};
  const text = row.result_text ?? "";
  const status = view?.state === "completed" ? 0 : 1;
  if (native) {
    return {
      payload: { review: reviewLabel, threadId: row.thread_id ?? null, codex: { status, stdout: text } },
      rendered: renderNativeReviewResult({ status, stdout: text, stderr: row.error ?? "" }, { reviewLabel, targetLabel, reasoningSummary: [] })
    };
  }
  // The stored structured result is the review; the text may lead with a model warning.
  const parsed = { ...parseStructuredOutput(row.result_json ?? text, { status, failureMessage: row.error ?? "" }), rawOutput: text };
  return {
    payload: { review: reviewLabel, threadId: row.thread_id ?? null, result: parsed.parsed, rawOutput: parsed.rawOutput, parseError: parsed.parseError },
    rendered: renderReviewResult(parsed, { reviewLabel, targetLabel, targetKind, reasoningSummary: [] })
  };
}

/**
 * Runs the review command as a job of the job store, in the foreground or with --background. The
 * target, the stance and the model are resolved before the job is created, so a bad value exits
 * with no job row. A native review runs the built-in Codex reviewer on a single-use thread; every
 * other review is a turn bound to the review schema on a thread that can be continued.
 */
export async function handleReviewCommand(argv) {
  const jobFlags = takeJobFlags(argv);
  const { options, paths, stance, instructions, background } = parseReviewArguments(jobFlags.argv, { aliasMap: { m: "model" } });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const target = resolveReviewTarget(cwd, { target: options.target, paths, base: options.base, scope: options.scope });
  const native = usesNativeReview(target, stance, instructions);
  const reviewLabel = reviewLabelFor(stance);
  ensureCodexAvailable(cwd);
  const selection = await resolveModelSelection(codexProvider, {
    model: options.model,
    effort: options.effort,
    ...delegationOptions(codexProvider, workspaceRoot),
    cwd
  });
  printWarnings(selection);
  const context = !native && target.kind === "changes" ? collectReviewContext(cwd, target.changes, { paths: target.paths }) : null;
  const prompt = native
    ? `${reviewLabel} of ${target.label}`
    : buildReviewPrompt({ rootDir: ROOT_DIR, providerLabel: codexProvider.label, target, stance, instructions, context });
  const requester = await readRequesterIdentity();
  const title = `Codex ${reviewLabel}`;
  const built = buildTaskJobFields(
    {
      kind: "review",
      title,
      prompt,
      write: false,
      sandbox: "read-only",
      model: selection.model,
      effort: selection.effort,
      modelSource: selection.modelSource,
      effortSource: selection.effortSource,
      outputSchema: native ? null : readOutputSchema(REVIEW_SCHEMA),
      review: { target: target.kind, paths: target.paths, stance, native, nativeTarget: native ? buildNativeReviewTarget(target.changes) : null },
      // A native review runs on a single-use thread that Codex does not keep, so it cannot be continued.
      ephemeral: native,
      background,
      label: jobFlags.label,
      runId: jobFlags.runId
    },
    { cwd: context?.repoRoot ?? cwd, requester }
  );
  const { jobId, stateDir } = await startStoreJob(cwd, built, { background, json: options.json, title });
  if (!background) {
    await waitStoredReview(stateDir, jobId, options.json, { reviewLabel, targetLabel: target.label, targetKind: target.kind, native });
  }
}

async function waitStoredReview(stateDir, jobId, json, labels) {
  const outcome = await waitStoreJob(stateDir, jobId, { json });
  if (outcome.timedOut) {
    process.stderr.write(`Job ${jobId} is still running; check /agent:status ${jobId}.\n`);
    process.exitCode = 75;
    return;
  }
  const { payload, rendered } = renderStoredReview(outcome.view, labels);
  const state = outcome.view?.state ?? "failed";
  outputCommandResult({ ...payload, jobId, status: state }, rendered, json);
  // A schema-bound review that ended without valid JSON is a failed review.
  const parsedOk = labels.native || payload.result !== null;
  process.exitCode = (state === "completed" || state === "waiting") && parsedOk ? 0 : 1;
}

export async function run(argv) {
  return handleReviewCommand(argv);
}
