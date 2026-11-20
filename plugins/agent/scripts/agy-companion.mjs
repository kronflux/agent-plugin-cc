#!/usr/bin/env node

import process from "node:process";

import { HelpRequested, parseCommandInput, resolveCommandWorkspace, createTrackedProgress } from "./lib/companion-cli.mjs";
import { readStoredJob } from "./lib/job-control.mjs";
import { takeJobRequest, writeJobFile } from "./lib/state.mjs";
import { nowIso, runTrackedJob } from "./lib/tracked-jobs.mjs";
import * as reviewCommand from "./providers/agy/commands/review.mjs";
import * as setupCommand from "./providers/agy/commands/setup.mjs";
import * as taskCommand from "./providers/agy/commands/task.mjs";
import { executeAgyTask } from "./providers/agy/commands/task.mjs";

const SUBCOMMAND_USAGE = {
  setup: setupCommand.usage,
  task: taskCommand.usage,
  review: reviewCommand.usage
};

function printUsage(subcommand = null) {
  const names = subcommand && SUBCOMMAND_USAGE[subcommand] ? [subcommand] : Object.keys(SUBCOMMAND_USAGE);
  console.log(["Usage:", ...names.map((name) => `  node scripts/agy-companion.mjs ${SUBCOMMAND_USAGE[name]}`)].join("\n"));
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd", "job-id"] });
  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }
  // A job cancelled or failed while queued is not run.
  if (storedJob.status !== "queued") {
    return;
  }
  const request = takeJobRequest(workspaceRoot, options["job-id"]);
  if (!request || typeof request !== "object") {
    const errorMessage = `Stored job ${options["job-id"]} is missing its task request payload.`;
    writeJobFile(workspaceRoot, storedJob.id, { ...storedJob, status: "failed", phase: "failed", errorMessage, completedAt: nowIso() });
    throw new Error(errorMessage);
  }
  const { logFile, progress } = createTrackedProgress({ ...storedJob, workspaceRoot }, { logFile: storedJob.logFile ?? null });
  await runTrackedJob({ ...storedJob, workspaceRoot, logFile }, () => executeAgyTask({ ...request, onProgress: progress }), { logFile });
}

async function runSubcommand(subcommand, argv) {
  switch (subcommand) {
    case "setup":
      return setupCommand.run(argv);
    case "task":
      return taskCommand.run(argv);
    case "task-worker":
      return handleTaskWorker(argv);
    case "review":
      return reviewCommand.run(argv);
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printUsage(argv[0] ?? null);
    return;
  }
  try {
    await runSubcommand(subcommand, argv);
  } catch (error) {
    if (!(error instanceof HelpRequested)) {
      throw error;
    }
    printUsage(subcommand);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
