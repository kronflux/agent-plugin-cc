#!/usr/bin/env node

import process from "node:process";

import { HelpRequested, parseCommandInput } from "./lib/companion-cli.mjs";
import { checkRuntime, runtimeGateMessage } from "./lib/store.mjs";
import { runJobExecution } from "./lib/tracked-jobs.mjs";
import { createAgyDriver } from "./providers/agy/driver.mjs";
import * as reviewCommand from "./providers/agy/commands/review.mjs";
import * as setupCommand from "./providers/agy/commands/setup.mjs";
import * as taskCommand from "./providers/agy/commands/task.mjs";
import * as usageCommand from "./providers/agy/commands/usage.mjs";

const SUBCOMMAND_USAGE = {
  setup: setupCommand.usage,
  task: taskCommand.usage,
  review: reviewCommand.usage,
  usage: usageCommand.usage
};

function printUsage(subcommand = null) {
  const names = subcommand && SUBCOMMAND_USAGE[subcommand] ? [subcommand] : Object.keys(SUBCOMMAND_USAGE);
  console.log(["Usage:", ...names.map((name) => `  node scripts/agy-companion.mjs ${SUBCOMMAND_USAGE[name]}`)].join("\n"));
}

// The store worker of one Antigravity job: claims it, runs its one turn and releases it.
async function handleWorker(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["state-dir", "job"] });
  if (!options["state-dir"] || !options.job) {
    throw new Error("Usage: worker --state-dir <path> --job <id>");
  }
  const code = await runJobExecution(options["state-dir"], options.job, createAgyDriver(null, { env: process.env }), { env: process.env });
  process.exit(code);
}

async function runSubcommand(subcommand, argv) {
  switch (subcommand) {
    case "setup":
      return setupCommand.run(argv);
    case "task":
      return taskCommand.run(argv);
    case "worker":
      return handleWorker(argv);
    case "task-resume-candidate":
      return taskCommand.handleResumeCandidate(argv);
    case "review":
      return reviewCommand.run(argv);
    case "usage":
      return usageCommand.run(argv);
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
  // Every subcommand needs the job store, so the runtime gate runs first.
  const gate = checkRuntime();
  if (!gate.ok) {
    process.stderr.write(`${runtimeGateMessage(gate)}
`);
    process.exitCode = 1;
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
