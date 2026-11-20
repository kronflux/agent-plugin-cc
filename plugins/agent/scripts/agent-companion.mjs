#!/usr/bin/env node

import process from "node:process";

import * as cancelCommand from "./commands/cancel.mjs";
import * as fleetCommand from "./commands/fleet.mjs";
import * as resultCommand from "./commands/result.mjs";
import * as resumeCommand from "./commands/resume.mjs";
import * as sendCommand from "./commands/send.mjs";
import * as statusCommand from "./commands/status.mjs";
import * as storeCommand from "./commands/store.mjs";
import * as worktreeCommand from "./commands/worktree.mjs";
import { HelpRequested } from "./lib/companion-cli.mjs";
import { checkRuntime, runtimeGateMessage } from "./lib/store.mjs";

// The subcommands that work on any provider's jobs; each job names the provider that runs it.
const SUBCOMMANDS = {
  status: statusCommand,
  result: resultCommand,
  send: sendCommand,
  resume: resumeCommand,
  cancel: cancelCommand,
  store: storeCommand,
  fleet: fleetCommand,
  worktree: worktreeCommand
};

function printUsage(subcommand = null) {
  const names = subcommand && SUBCOMMANDS[subcommand] ? [subcommand] : Object.keys(SUBCOMMANDS);
  console.log(["Usage:", ...names.map((name) => `  node scripts/agent-companion.mjs ${SUBCOMMANDS[name].usage}`)].join("\n"));
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printUsage(argv[0] ?? null);
    return;
  }
  const command = Object.hasOwn(SUBCOMMANDS, subcommand) ? SUBCOMMANDS[subcommand] : null;
  if (!command) {
    throw new Error(`Unknown subcommand: ${subcommand}`);
  }
  // The runtime gate runs before any store folder or file is created.
  const gate = checkRuntime();
  if (!gate.ok) {
    throw new Error(runtimeGateMessage(gate));
  }
  try {
    await command.run(argv);
  } catch (error) {
    if (!(error instanceof HelpRequested)) {
      throw error;
    }
    printUsage(subcommand);
  }
}

main().catch((error) => {
  const message = storeCommand.storeErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
