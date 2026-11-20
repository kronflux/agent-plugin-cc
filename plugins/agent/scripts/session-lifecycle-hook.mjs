#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateJobProcesses } from "./lib/job-control.mjs";
import { listJobs, removeJob } from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./providers/codex/claude-session-transfer.mjs";
import { readHookInputJson } from "./lib/fs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

// SessionStart runs again on resume, clear, and compaction. A line is appended only when the
// variable's last export in the file has a different value, so repeated runs add nothing.
// The file is only appended to, because other hooks may be appending at the same time.
function appendEnvVar(name, value) {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile || value == null || value === "") {
    return;
  }
  const line = `export ${name}=${shellEscape(value)}`;
  let existing = "";
  try {
    existing = fs.readFileSync(envFile, "utf8");
  } catch {
    // A missing file is created by the append below.
  }
  const lastExport = existing
    .split(/\r?\n/)
    .filter((candidate) => candidate.startsWith(`export ${name}=`))
    .at(-1);
  if (lastExport === line) {
    return;
  }
  const separator = existing && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(envFile, `${separator}${line}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionJobs = listJobs(workspaceRoot).filter((job) => job.sessionId === sessionId);
  terminateJobProcesses(sessionJobs);
  for (const job of sessionJobs) {
    removeJob(workspaceRoot, job);
  }
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
}

async function main() {
  const input = readHookInputJson();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
