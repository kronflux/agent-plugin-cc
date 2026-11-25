#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getCodexAvailability } from "./providers/codex/runtime.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { delegationOptions, resolveModelSelection } from "./lib/model-selection.mjs";
import { getProvider } from "./lib/providers.mjs";
import { createJob, getConfig, listJobViews, resolveStateDir } from "./lib/state.mjs";
import { checkRuntime, openStore, runtimeGateMessage } from "./lib/store.mjs";
import { launchWorker } from "./lib/task-launch.mjs";
import { waitForJob } from "./lib/tracked-jobs.mjs";
import { formatBlockDecision, getProjectDir, getSessionId, readHookInput, readRequesterIdentity } from "./lib/host.mjs";
import { fenceAgentText, sanitizeAgentText } from "./lib/untrusted.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

// The review waits for its job at most this long, inside the Stop hook's 900 s limit in hooks.json,
// so the hook can still say that the job keeps running. AGENT_PLUGIN_STOP_REVIEW_WAIT_MS replaces it
// in tests.
const STOP_REVIEW_WAIT_MS = 870 * 1000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const VERDICT_SCHEMA = path.join(ROOT_DIR, "schemas", "stop-gate-verdict.schema.json");
const DEFAULT_MAX_ROUNDS = 3;
const DISABLE_HINT = "To turn the review gate off, run /agent:codex-setup --disable-review-gate.";

function emitBlockDecision(reason) {
  process.stdout.write(`${formatBlockDecision(reason)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function readWaitMs() {
  const raw = (process.env.AGENT_PLUGIN_STOP_REVIEW_WAIT_MS ?? "").trim();
  return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : STOP_REVIEW_WAIT_MS;
}

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", fenceAgentText("claude", lastAssistantMessage, { label: "Claude" })].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

function buildSetupNote(cwd) {
  const availability = getCodexAvailability(cwd);
  if (availability.available) {
    return null;
  }

  const detail = availability.detail ? ` ${availability.detail}.` : "";
  return `Codex is not set up for the review gate.${detail} Run /agent:codex-setup.`;
}

function infrastructureFailure(problem) {
  return { ok: false, reason: `${problem} ${DISABLE_HINT}` };
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

// The verdict comes from the structured `verdict` field. Output that is not the expected JSON
// object counts as a failed review, so "BLOCK" in a reason or in quoted text cannot decide it.
function parseVerdict(parsed) {
  const reason = typeof parsed?.reason === "string" ? sanitizeAgentText(parsed.reason).trim() : "";
  if (parsed?.verdict === "allow") {
    return { ok: true, reason: null };
  }
  if (parsed?.verdict === "block") {
    return {
      ok: false,
      reason: `Codex stop-time review found issues that still need fixes before ending the session: ${reason || "no reason given"}`
    };
  }
  return infrastructureFailure("The stop-time Codex review returned an unknown verdict.");
}

// The job's structured result, or its text when that is the JSON object.
function verdictOfJob(view) {
  const row = view.row;
  if (row.end_state !== "completed") {
    const detail = sanitizeAgentText(row.error ?? "").trim();
    return infrastructureFailure(
      detail ? `The stop-time Codex review failed: ${detail}` : `The stop-time Codex review ended ${view.state}.`
    );
  }
  if (row.result_json) {
    try {
      return parseVerdict(JSON.parse(row.result_json));
    } catch {
      // Falls through to the text.
    }
  }
  const text = String(row.result_text ?? "").trim();
  if (!text) {
    return infrastructureFailure("The stop-time Codex review returned no output.");
  }
  try {
    return parseVerdict(JSON.parse(text));
  } catch {
    return infrastructureFailure("The stop-time Codex review did not return a JSON verdict.");
  }
}

// The review request of the shared provider command contract, for a read-only review of the
// working tree's changes with the verdict schema.
async function buildReviewFields(provider, cwd, input) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const selection = await resolveModelSelection(provider, { ...delegationOptions(provider, workspaceRoot), cwd });
  const outputSchema = JSON.parse(fs.readFileSync(VERDICT_SCHEMA, "utf8"));
  const request = {
    cwd,
    worktree: null,
    write: false,
    sandbox: "read-only",
    model: selection.model,
    effort: selection.effort,
    modelSource: selection.modelSource,
    effortSource: selection.effortSource,
    review: { target: "changes", paths: [], stance: "critical", native: false },
    outputSchema,
    allowQuestions: false,
    flags: { background: false, fresh: true }
  };
  // Test seam: AGENT_PLUGIN_TEST_DRIVER (JSON) is the behaviour of the test driver's provider that
  // runs the job in tests; production never sets it.
  if (process.env.AGENT_PLUGIN_TEST_DRIVER) {
    request.testDriver = JSON.parse(process.env.AGENT_PLUGIN_TEST_DRIVER);
  }
  const identity = await readRequesterIdentity();
  return {
    provider: provider.id,
    kind: "review",
    title: `${provider.label} stop-time review`,
    prompt: buildStopReviewPrompt(input),
    request,
    cwd,
    model: selection.model,
    allowQuestions: false,
    foreground: true,
    requester: { ...identity, sessionId: input.session_id || identity.sessionId }
  };
}

// Runs the review as an ordinary foreground job: the job is created and its worker launched
// through the store, and the hook waits for its end within its own limit. When the limit comes
// first, the job keeps running and the result says so.
async function runStopReview(stateDir, cwd, input) {
  const provider = getProvider();
  const fields = await buildReviewFields(provider, cwd, input);
  const store = openStore(stateDir);
  let jobId;
  try {
    ({ jobId } = createJob(store, fields));
    await launchWorker(store, stateDir, jobId);
  } finally {
    store.close();
  }
  const waitMs = readWaitMs();
  const outcome = await waitForJob(stateDir, jobId, { until: "end", deliver: true, timeoutMs: waitMs });
  if (outcome.timedOut || !outcome.view) {
    return infrastructureFailure(
      `The stop-time Codex review job ${jobId} did not finish within ${Math.round(waitMs / 1000)} s and keeps running; ` +
        `check it with /agent:status ${jobId} or stop it with /agent:cancel ${jobId}.`
    );
  }
  return verdictOfJob(outcome.view);
}

function readMaxRounds() {
  const raw = (process.env.CODEX_REVIEW_GATE_MAX_ROUNDS ?? "").trim();
  return /^\d+$/.test(raw) ? Number(raw) : DEFAULT_MAX_ROUNDS;
}

// Consecutive blocks are counted per Claude session, so a review that keeps blocking cannot
// keep the session from ending. Zero rounds removes the limit.
function roundsFile(stateDir, sessionId) {
  const safeId = String(sessionId || "no-session").replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(stateDir, "stop-gate", `${safeId}.json`);
}

function readRounds(file) {
  try {
    return Number(JSON.parse(fs.readFileSync(file, "utf8")).blocks) || 0;
  } catch {
    return 0;
  }
}

function writeRounds(file, blocks) {
  if (blocks === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ blocks })}\n`, "utf8");
}

// A note about the newest queued or running job of this session, read from the store.
function runningJobNote(stateDir, sessionId) {
  if (!fs.existsSync(path.join(stateDir, "store", "state.db"))) {
    return null;
  }
  let views = [];
  const store = openStore(stateDir);
  try {
    views = listJobViews(store, { sessionId, all: !sessionId });
  } finally {
    store.close();
  }
  const running = views.find((view) => view.state === "queued" || view.state === "running");
  return running
    ? `${getProvider(running.provider).label} job ${running.id} is still running. Check /agent:status and use /agent:cancel ${running.id} if you want to stop it before ending the session.`
    : null;
}

async function main() {
  const input = await readHookInput();
  const cwd = input.cwd || getProjectDir() || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const gate = checkRuntime();
  if (!gate.ok) {
    logNote(runtimeGateMessage(gate));
    return;
  }
  const stateDir = resolveStateDir(cwd);
  const sessionId = input.session_id || getSessionId();
  let runningTaskNote = null;
  try {
    runningTaskNote = runningJobNote(stateDir, sessionId);
  } catch (error) {
    logNote(`The job store could not be read: ${messageOf(error)}`);
  }

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  const rounds = roundsFile(stateDir, sessionId);
  const review = await runStopReview(stateDir, cwd, input);
  if (review.ok) {
    writeRounds(rounds, 0);
    logNote(runningTaskNote);
    return;
  }

  const blocks = readRounds(rounds) + 1;
  const maxRounds = readMaxRounds();
  if (maxRounds > 0 && blocks > maxRounds) {
    writeRounds(rounds, 0);
    logNote(`The review gate blocked ${maxRounds} times in a row, so this stop is allowed. Last result: ${review.reason}`);
    logNote(runningTaskNote);
    return;
  }
  writeRounds(rounds, blocks);
  emitBlockDecision(runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason);
}

main().catch((error) => {
  process.stderr.write(`${messageOf(error)} ${DISABLE_HINT}\n`);
  process.exitCode = 1;
});
