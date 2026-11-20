import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { writeExecutable } from "./helpers.mjs";

const PROCESS_LIB = pathToFileURL(path.join(import.meta.dirname, "..", "plugins", "agent", "scripts", "lib", "process.mjs")).href;

// The behaviours whose processes outlive a quick test and are stopped by it.
const LINGERING = new Set(["slow", "hang"]);

// A stand-in for the Antigravity CLI (agy 1.2.10). In stream-json print mode it answers each
// stdin line with the init, step_update, and result events agy emits, one turn at a time, and
// records every run in agy-state.json next to the script; `pids` lists the process id of every
// print-mode process. With --json-schema it returns a structured review: no findings for a
// changes review, and one finding without a location for a project review.
//
// Behaviours other than "ok":
// - "slow" and "hang": each turn takes 3 s or 10 min.
// - "two-messages": each turn writes two agent messages.
// - "models-fail": `agy models` fails as when nobody is signed in.
// - "exit-before-stdin": exits with code 2 before reading stdin.
// - "result-then-exit": on the first line writes init, one agent message and a SUCCESS result
//   with "early-exit-answer-7f3", then exits at once.
// - "fail-first-turn": holds turn 1 until a second line arrives or 10 s pass, then ends turn 1
//   with status ERROR and a response whose braces are not JSON; the second line gets a normal
//   SUCCESS turn. With --json-schema (a review) turn 1 fails at once.
// - "result-before-done": holds turn 1 the same way, then writes the text delta "partial-" and
//   the result without a DONE agent step; later turns answer normally.
//
// With `recordIdentities` (the default for "slow" and "hang") each print-mode process is also
// added as `{ pid, startToken }` to `identities` once readProcessIdentity has read it, so a test
// can stop it with stopOwnedProcesses.
export function installFakeAgy(binDir, behavior = "ok", { recordIdentities = LINGERING.has(behavior) } = {}) {
  const statePath = path.join(binDir, "agy-state.json");
  const scriptPath = path.join(binDir, "agy");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");

const STATE_PATH = ${JSON.stringify(statePath)};
const BEHAVIOR = ${JSON.stringify(behavior)};
const RECORD_IDENTITIES = ${JSON.stringify(recordIdentities)};
const PROCESS_LIB = ${JSON.stringify(PROCESS_LIB)};
const args = process.argv.slice(2);

const LOCK_PATH = STATE_PATH + ".lock";

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function loadState() {
  return fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) : { runs: [], nextConversation: 1 };
}

function saveState(state) {
  const temp = STATE_PATH + "." + process.pid + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(state, null, 2));
  fs.renameSync(temp, STATE_PATH);
}

// Parallel fake agy processes share the state file. Each change is read, applied and written
// while holding a lock file created exclusively ("wx"); after 5 s a waiting process goes ahead.
function updateState(change) {
  let locked = false;
  for (let attempt = 0; attempt < 500 && !locked; attempt += 1) {
    try {
      fs.closeSync(fs.openSync(LOCK_PATH, "wx"));
      locked = true;
    } catch (error) {
      if (error.code !== "EEXIST") {
        break;
      }
      pause(10);
    }
  }
  try {
    const state = loadState();
    const value = change(state);
    saveState(state);
    return value;
  } finally {
    if (locked) {
      fs.rmSync(LOCK_PATH, { force: true });
    }
  }
}

// Adds the identity of pid (this process, or a child it holds), once read, to identities.
function recordIdentity(pid) {
  if (!RECORD_IDENTITIES) {
    return;
  }
  import(PROCESS_LIB)
    .then((lib) => lib.readProcessIdentity(pid, { deadline: performance.now() + 30000 }))
    .then((identity) => {
      if (identity.state === "present") {
        updateState((current) => {
          current.identities = [...(current.identities || []), { pid, startToken: identity.startToken }];
        });
      }
    })
    .catch(() => {});
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

const { conversationId, runIndex } = updateState((state) => {
  const id = argValue("--conversation") || "conv-" + state.nextConversation++;
  state.runs.push({ args, conversationId: id, inputs: [], pid: process.pid });
  state.pids = [...(state.pids || []), process.pid];
  return { conversationId: id, runIndex: state.runs.length - 1 };
});
recordIdentity(process.pid);

if (BEHAVIOR === "exit-before-stdin") {
  process.exit(2);
}

// Writes synchronously, so every event is out before an immediate process.exit.
function emitNow(event) {
  fs.writeSync(1, JSON.stringify(event) + "\\n");
}

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\\n");
}

function record(update) {
  updateState((current) => {
    Object.assign(current.runs[runIndex], update);
  });
}

const initEvent = { event: "init", conversation_id: conversationId, init: { cwd: process.cwd(), tools: [], permission_mode: "always-proceed" } };
if (BEHAVIOR !== "result-then-exit") {
  emit(initEvent);
}

const HOLD_FIRST_TURN = BEHAVIOR === "fail-first-turn" || BEHAVIOR === "result-before-done";
const queue = [];
let busy = false;
let inputClosed = false;
let turns = 0;
let step = 0;
// Ends the held first turn; set while turn 1 waits for a second line.
let releaseFirstTurn = null;

function holdFirstTurn() {
  const release = () => {
    if (releaseFirstTurn !== release) {
      return;
    }
    releaseFirstTurn = null;
    clearTimeout(fallback);
    if (BEHAVIOR === "fail-first-turn") {
      emit({ event: "result", result: { conversation_id: conversationId, status: "ERROR", response: "Error: the model request failed {code: 7}", duration_seconds: 0.1, num_turns: turns } });
    } else {
      emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: step, state: "ACTIVE", step_type: "agent_response", text_delta: "partial-" } });
      emit({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: "partial-", duration_seconds: 0.1, num_turns: turns } });
    }
    busy = false;
    runNext();
  };
  const fallback = setTimeout(release, 10000);
  releaseFirstTurn = release;
}

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
  if (HOLD_FIRST_TURN && turns === 1) {
    holdFirstTurn();
    // A review sends no second line, so its first turn fails at once.
    if (BEHAVIOR === "fail-first-turn" && args.includes("--json-schema")) {
      releaseFirstTurn();
    }
    return;
  }
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
      // A project review prompt gets one finding without a location.
      result.structured_output = String(content).includes("This is a project review")
        ? {
            verdict: "needs-attention",
            summary: "One project-wide concern surfaced by the fake agy.",
            target: "project",
            findings: [{ severity: "medium", title: "No usage instructions", body: "No file explains how to run the project.", file: null, line_start: null, line_end: null, confidence: 0.6, recommendation: "Add a README." }],
            next_steps: []
          }
        : { verdict: "approve", summary: "No material issues found by the fake agy.", target: "changes", findings: [], next_steps: [] };
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
  updateState((current) => {
    current.runs[runIndex].inputs.push(content);
  });
  if (BEHAVIOR === "result-then-exit") {
    const answer = "early-exit-answer-7f3";
    emitNow(initEvent);
    emitNow({ event: "step_update", step_update: { conversation_id: conversationId, step_index: 0, state: "DONE", step_type: "agent_response", text_delta: answer } });
    emitNow({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: answer, duration_seconds: 0.1, num_turns: 1 } });
    process.exit(0);
  }
  queue.push(content);
  if (releaseFirstTurn) {
    releaseFirstTurn();
    return;
  }
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
