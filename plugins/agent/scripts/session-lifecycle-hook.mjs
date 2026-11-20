#!/usr/bin/env node

import process from "node:process";

import { getPluginDataDir, getSessionId, readHookInput, writeSessionEnv } from "./lib/host.mjs";
import { terminateJobProcesses } from "./lib/job-control.mjs";
import { listJobs, removeJob } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

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
  writeSessionEnv({
    sessionId: input.session_id,
    transcriptPath: input.transcript_path,
    pluginDataDir: getPluginDataDir()
  });
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  cleanupSessionJobs(cwd, input.session_id || getSessionId());
}

async function main() {
  const input = await readHookInput();
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
