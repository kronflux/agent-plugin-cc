#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import * as cancelCommand from "./commands/cancel.mjs";
import * as resultCommand from "./commands/result.mjs";
import * as sendCommand from "./commands/send.mjs";
import * as statusCommand from "./commands/status.mjs";
import * as setupCommand from "./providers/codex/commands/setup.mjs";
import * as reviewCommand from "./providers/codex/commands/review.mjs";
import * as taskCommand from "./providers/codex/commands/task.mjs";
import * as transferCommand from "./providers/codex/commands/transfer.mjs";
import * as usageCommand from "./providers/codex/commands/usage.mjs";
import { executeReviewRun } from "./providers/codex/commands/review.mjs";
import { executeTaskRun } from "./providers/codex/commands/task.mjs";
import { takeJobRequest, writeJobFile } from "./lib/state.mjs";
import { readStoredJob } from "./lib/job-control.mjs";
import { nowIso, runTrackedJob } from "./lib/tracked-jobs.mjs";
import {
  HelpRequested,
  parseCommandInput,
  resolveCommandCwd,
  resolveCommandWorkspace,
  createTrackedProgress
} from "./lib/companion-cli.mjs";

// Seams that tests import from this script.
export { launchManifestTasks } from "./providers/codex/commands/task.mjs";
export { startTurnWithProviderCompanion } from "./lib/task-launch.mjs";
export { cancelJob } from "./commands/cancel.mjs";

const COMPANION_SCRIPT = fileURLToPath(import.meta.url);

const SUBCOMMAND_USAGE = {
  setup: setupCommand.usage,
  review: reviewCommand.usage,
  "adversarial-review": reviewCommand.adversarialUsage,
  task: taskCommand.usage,
  transfer: transferCommand.usage,
  usage: usageCommand.usage
};

// Subcommands that agent-companion.mjs runs; this script forwards them to the same modules so
// existing callers keep working. They are not listed in the usage text.
const FORWARDED_SUBCOMMANDS = {
  status: statusCommand,
  result: resultCommand,
  send: sendCommand,
  cancel: cancelCommand
};

function printUsage(subcommand = null) {
  if (subcommand && Object.hasOwn(FORWARDED_SUBCOMMANDS, subcommand)) {
    console.log(["Usage:", `  node scripts/codex-companion.mjs ${FORWARDED_SUBCOMMANDS[subcommand].usage}`].join("\n"));
    return;
  }
  const names = subcommand && SUBCOMMAND_USAGE[subcommand] ? [subcommand] : Object.keys(SUBCOMMAND_USAGE);
  console.log(["Usage:", ...names.map((name) => `  node scripts/codex-companion.mjs ${SUBCOMMAND_USAGE[name]}`)].join("\n"));
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
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

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      // A queued review request runs as a review; every other request runs as a task.
      (request.requestKind === "review" ? executeReviewRun : executeTaskRun)({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
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

async function runSubcommand(subcommand, argv) {
  switch (subcommand) {
    case "setup":
      await setupCommand.run(argv);
      break;
    case "review":
      await reviewCommand.run(argv);
      break;
    case "adversarial-review":
      await reviewCommand.runAdversarial(argv);
      break;
    case "task":
      await taskCommand.run(argv);
      break;
    case "transfer":
      await transferCommand.run(argv);
      break;
    case "usage":
      await usageCommand.run(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "task-resume-candidate":
      await taskCommand.runResumeCandidate(argv);
      break;
    case "status":
    case "result":
    case "send":
    case "cancel":
      await FORWARDED_SUBCOMMANDS[subcommand].run(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

// The CLI runs only when this file is the process entry point, so tests can import its steps.
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  let resolved;
  try {
    resolved = fs.realpathSync(entry);
  } catch {
    return false;
  }
  return process.platform === "win32"
    ? resolved.toLowerCase() === COMPANION_SCRIPT.toLowerCase()
    : resolved === COMPANION_SCRIPT;
}

if (isEntryPoint()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}