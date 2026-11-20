#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import * as setupCommand from "./providers/codex/commands/setup.mjs";
import * as reviewCommand from "./providers/codex/commands/review.mjs";
import * as taskCommand from "./providers/codex/commands/task.mjs";
import * as transferCommand from "./providers/codex/commands/transfer.mjs";
import * as usageCommand from "./providers/codex/commands/usage.mjs";
import { runJobExecution } from "./lib/tracked-jobs.mjs";
import { checkRuntime, runtimeGateMessage } from "./lib/store.mjs";
import { createCodexDriver } from "./providers/codex/runtime.mjs";
import { HelpRequested, parseCommandInput } from "./lib/companion-cli.mjs";

// Seams that tests import from this script.
export { launchManifestTasks } from "./providers/codex/commands/task.mjs";

const COMPANION_SCRIPT = fileURLToPath(import.meta.url);

const SUBCOMMAND_USAGE = {
  setup: setupCommand.usage,
  review: reviewCommand.usage,
  task: taskCommand.usage,
  transfer: transferCommand.usage,
  usage: usageCommand.usage
};

function printUsage(subcommand = null) {
  const names = subcommand && SUBCOMMAND_USAGE[subcommand] ? [subcommand] : Object.keys(SUBCOMMAND_USAGE);
  console.log(["Usage:", ...names.map((name) => `  node scripts/codex-companion.mjs ${SUBCOMMAND_USAGE[name]}`)].join("\n"));
}

// Runs one job of the job store in this process: claims it, runs its Codex turn in an app server
// of its own and releases it (see runJobExecution).
async function handleWorker(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["state-dir", "job"] });
  if (!options["state-dir"] || !options.job) {
    throw new Error("Missing required --state-dir and --job for worker.");
  }
  process.exitCode = await runJobExecution(options["state-dir"], options.job, createCodexDriver());
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
  // Every subcommand needs a Node.js and SQLite that the job store supports; nothing runs without.
  const gate = checkRuntime();
  if (!gate.ok) {
    process.stderr.write(`${runtimeGateMessage(gate)}\n`);
    process.exitCode = 1;
    return;
  }
  switch (subcommand) {
    case "setup":
      await setupCommand.run(argv);
      break;
    case "review":
      await reviewCommand.run(argv);
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
    case "worker":
      await handleWorker(argv);
      break;
    case "task-resume-candidate":
      await taskCommand.runResumeCandidate(argv);
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