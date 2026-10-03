#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getCodexAvailability } from "./providers/codex/runtime.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs, resolveStateDir } from "./lib/state.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { readHookInputJson } from "./lib/fs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const VERDICT_SCHEMA = path.join(ROOT_DIR, "schemas", "stop-gate-verdict.schema.json");
const DEFAULT_MAX_ROUNDS = 3;
const DISABLE_HINT = "To turn the review gate off, run /agent:codex-setup --disable-review-gate.";
const UNTRUSTED_TAG = "untrusted-claude-response";

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

// The previous Claude response is quoted between markers carrying a random id, so text in
// the response cannot close the quote early. Marker text inside the response is removed.
function fenceUntrusted(text) {
  const id = randomBytes(6).toString("hex");
  const cleaned = text.replace(new RegExp(`</?${UNTRUSTED_TAG}[^>]*>`, "gi"), "");
  return [`<${UNTRUSTED_TAG} id="${id}">`, cleaned, `</${UNTRUSTED_TAG} id="${id}">`].join("\n");
}

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", fenceUntrusted(lastAssistantMessage)].join("\n")
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

// The last stderr line that is not a Node runtime warning, which is where the companion
// prints the error that stopped it.
function lastErrorLine(stderr) {
  return (
    String(stderr ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("(node:") && !line.startsWith("(Use `node --trace"))
      .at(-1) ?? ""
  );
}

// The verdict comes from the structured `verdict` field. Output that is not the expected JSON
// object counts as a failed review, so "BLOCK" in a reason or in quoted text cannot decide it.
function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return infrastructureFailure("The stop-time Codex review returned no output.");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return infrastructureFailure("The stop-time Codex review did not return a JSON verdict.");
  }
  const reason = typeof parsed?.reason === "string" ? parsed.reason.trim() : "";
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

function runStopReview(cwd, input = {}) {
  const scriptPath = path.join(SCRIPT_DIR, "codex-companion.mjs");
  const prompt = buildStopReviewPrompt(input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  const result = spawnSync(process.execPath, [scriptPath, "task", "--json", "--output-schema", VERDICT_SCHEMA, prompt], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout: STOP_REVIEW_TIMEOUT_MS
  });

  if (result.error?.code === "ETIMEDOUT") {
    return infrastructureFailure("The stop-time Codex review timed out after 15 minutes.");
  }

  let payload = null;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    payload = null;
  }

  if (result.status !== 0) {
    const detail = String(payload?.failureMessage ?? "").trim() || lastErrorLine(result.stderr);
    return infrastructureFailure(
      detail ? `The stop-time Codex review failed: ${detail}` : "The stop-time Codex review failed."
    );
  }

  if (!payload) {
    return infrastructureFailure("The stop-time Codex review printed output that is not JSON.");
  }
  return parseStopReviewOutput(payload.rawOutput);
}

function readMaxRounds() {
  const raw = (process.env.CODEX_REVIEW_GATE_MAX_ROUNDS ?? "").trim();
  return /^\d+$/.test(raw) ? Number(raw) : DEFAULT_MAX_ROUNDS;
}

// Consecutive blocks are counted per Claude session, so a review that keeps blocking cannot
// keep the session from ending. Zero rounds removes the limit.
function roundsFile(workspaceRoot, sessionId) {
  const safeId = String(sessionId || "no-session").replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(resolveStateDir(workspaceRoot), "stop-gate", `${safeId}.json`);
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

function main() {
  const input = readHookInputJson();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `Codex task ${runningJob.id} is still running. Check /agent:status and use /agent:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

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

  const rounds = roundsFile(workspaceRoot, input.session_id || process.env[SESSION_ID_ENV]);
  const review = runStopReview(cwd, input);
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
  emitDecision({
    decision: "block",
    reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
  });
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message} ${DISABLE_HINT}\n`);
  process.exitCode = 1;
}
