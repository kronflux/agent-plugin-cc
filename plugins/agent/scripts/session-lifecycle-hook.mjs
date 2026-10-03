#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./providers/codex/app-server.mjs";
import {
  clearBrokerSession,
  isBrokerProcess,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  requestBrokerShutdownIfIdle,
  teardownBrokerSession
} from "./providers/codex/broker-lifecycle.mjs";
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

// A broker that exited, for example after its idle timeout, leaves its session record and
// files behind; they are removed so the next command starts a new broker without probing.
function removeExitedBrokerSession(cwd) {
  const session = loadBrokerSession(cwd);
  if (!session || isBrokerProcess(session.pid)) {
    return;
  }
  teardownBrokerSession({
    endpoint: session.endpoint ?? null,
    pidFile: session.pidFile ?? null,
    logFile: session.logFile ?? null,
    sessionDir: session.sessionDir ?? null
  });
  clearBrokerSession(cwd);
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
  try {
    removeExitedBrokerSession(input.cwd || process.cwd());
  } catch {
    // A failed cleanup must not stop the session from starting.
  }
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;

  // This session's jobs stop first, so their connections no longer count against the broker.
  // The broker then stops only if no other session is using it.
  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
  if (!brokerEndpoint) {
    return;
  }
  if ((await requestBrokerShutdownIfIdle(brokerEndpoint)) === "busy") {
    return;
  }
  teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    killProcess: terminateProcessTree
  });
  clearBrokerSession(cwd);
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
