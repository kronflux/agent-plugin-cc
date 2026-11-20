// The real-process entry point of council fixtures: `node tests/council-child.mjs <layer>
// <subcommand> ...` runs handleCouncil with that layer.
//
// COUNCIL_CHILD_USAGE chooses the usage read of a failed provider turn: `hold` writes
// COUNCIL_CHILD_STARTED_FILE (when set), waits until the file COUNCIL_CHILD_RELEASE_FILE exists and
// then answers a reached Codex limit; `answer` answers with
// no reached limit at once. With `hold`, once handleCouncil has returned the child waits for the
// release file, lets the read's continuations run (two setImmediate turns), writes
// COUNCIL_CHILD_ACK_FILE and exits.
import fs from "node:fs";
import process from "node:process";

import { handleCouncil } from "../plugins/agent/scripts/commands/council.mjs";

const [layerText, ...argv] = process.argv.slice(2);
const mode = process.env.COUNCIL_CHILD_USAGE ?? null;
const releaseFile = process.env.COUNCIL_CHILD_RELEASE_FILE ?? null;
const ackFile = process.env.COUNCIL_CHILD_ACK_FILE ?? null;

const REACHED = { raw: { rateLimits: { limitId: "codex", rateLimitReachedType: "primary" } }, normalized: { groups: [] } };
const NOT_REACHED = { raw: { rateLimits: { limitId: "codex", rateLimitReachedType: null } }, normalized: { groups: [] } };

function waitForFile(file) {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (fs.existsSync(file)) {
        clearInterval(timer);
        resolve();
      }
    }, 20);
  });
}

const advance = {};
if (mode === "hold") {
  advance.readUsage = async () => {
    if (process.env.COUNCIL_CHILD_STARTED_FILE) {
      fs.writeFileSync(process.env.COUNCIL_CHILD_STARTED_FILE, "started\n");
    }
    await waitForFile(releaseFile);
    return REACHED;
  };
} else if (mode === "answer") {
  advance.readUsage = async () => NOT_REACHED;
}

process.exitCode = await handleCouncil(argv, { layer: Number(layerText), advance });
if (mode === "hold") {
  await waitForFile(releaseFile);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  fs.writeFileSync(ackFile, "drained\n");
}
