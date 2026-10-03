#!/usr/bin/env node

// Starts the app-server broker and exits. On Windows, `taskkill /T` stops every process
// whose parent chain leads to the target, and a detached child keeps its parent link. The
// broker is shared by every job in a workspace, so it is started from this short-lived
// process: once the launcher exits, no running job process is the broker's ancestor.
// Usage: broker-launcher.mjs <log-file> <broker-script> [broker arguments...]

import fs from "node:fs";
import process from "node:process";
import { spawn } from "node:child_process";

const [logFile, brokerScript, ...brokerArgs] = process.argv.slice(2);
const logFd = fs.openSync(logFile, "a");
const child = spawn(process.execPath, [brokerScript, ...brokerArgs], {
  detached: true,
  stdio: ["ignore", logFd, logFd],
  windowsHide: true
});
child.unref();
fs.closeSync(logFd);
