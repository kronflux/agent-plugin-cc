import fs from "node:fs";
import path from "node:path";

import { writeExecutable } from "./helpers.mjs";

// A stand-in for the Antigravity CLI (agy 1.2.10). In stream-json print mode it answers each
// stdin line with the init, step_update, and result events agy emits, one turn at a time, and
// records every run in agy-state.json next to the script.
export function installFakeAgy(binDir, behavior = "ok") {
  const statePath = path.join(binDir, "agy-state.json");
  const scriptPath = path.join(binDir, "agy");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");

const STATE_PATH = ${JSON.stringify(statePath)};
const BEHAVIOR = ${JSON.stringify(behavior)};
const args = process.argv.slice(2);

function loadState() {
  return fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) : { runs: [], nextConversation: 1 };
}

function saveState(state) {
  const temp = STATE_PATH + "." + process.pid + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(state, null, 2));
  fs.renameSync(temp, STATE_PATH);
}

function argValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

if (args[0] === "--version") {
  console.log("1.2.10");
  process.exit(0);
}

if (args[0] === "--help") {
  console.log("Usage of agy:");
  console.log("  --effort                        Reasoning effort for the current CLI session (low|medium|high|xhigh)");
  process.exit(0);
}

if (args[0] === "models") {
  if (BEHAVIOR === "models-fail") {
    console.error("not signed in");
    process.exit(1);
  }
  console.log("Fetching available models...");
  console.log("fake-model-high\\tFake Model (High)");
  console.log("fake-model-low\\tFake Model (Low)");
  process.exit(0);
}

const state = loadState();
const conversationId = argValue("--conversation") || "conv-" + state.nextConversation++;
const run = { args, conversationId, inputs: [], pid: process.pid };
state.runs.push(run);
saveState(state);
const runIndex = state.runs.length - 1;

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\\n");
}

function record(update) {
  const current = loadState();
  Object.assign(current.runs[runIndex], update);
  saveState(current);
}

emit({ event: "init", conversation_id: conversationId, init: { cwd: process.cwd(), tools: [], permission_mode: "always-proceed" } });

const queue = [];
let busy = false;
let inputClosed = false;
let turns = 0;
let step = 0;

function runNext() {
  if (busy) {
    return;
  }
  const content = queue.shift();
  if (content === undefined) {
    if (inputClosed) {
      process.exit(0);
    }
    return;
  }
  busy = true;
  turns += 1;
  emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: step++, state: "DONE", step_type: "user_input" } });
  const delay = BEHAVIOR === "slow" ? 3000 : BEHAVIOR === "hang" ? 600000 : 50;
  setTimeout(() => {
    const response = "reply: " + content;
    if (BEHAVIOR === "two-messages") {
      emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: step++, state: "DONE", step_type: "agent_response", text_delta: "Working on it." } });
    }
    emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: step, state: "ACTIVE", step_type: "agent_response", text_delta: response } });
    emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: step++, state: "DONE", step_type: "agent_response", text_delta: "\\n" } });
    const result = { conversation_id: conversationId, status: "SUCCESS", response: (BEHAVIOR === "two-messages" ? "Working on it.\\n" : "") + response + "\\n", duration_seconds: 0.1, num_turns: turns };
    if (args.includes("--json-schema")) {
      result.structured_output = { verdict: "approve", summary: "No material issues found by the fake agy.", findings: [], next_steps: [] };
    }
    emit({ event: "result", result });
    busy = false;
    runNext();
  }, delay);
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  const message = JSON.parse(line);
  const content = message && message.message ? message.message.content : "";
  const current = loadState();
  current.runs[runIndex].inputs.push(content);
  saveState(current);
  queue.push(content);
  runNext();
}).on("close", () => {
  inputClosed = true;
  record({ stdinClosed: true });
  if (!busy && queue.length === 0) {
    process.exit(0);
  }
});
`;
  writeExecutable(scriptPath, source);
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "agy.cmd"), `@echo off\r\nnode "%~dp0agy" %*\r\n`, { encoding: "utf8" });
  }
  return statePath;
}

export function readFakeAgyState(binDir) {
  const file = path.join(binDir, "agy-state.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { runs: [] };
}
