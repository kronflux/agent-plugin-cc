import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { writeExecutable } from "./helpers.mjs";

const PROCESS_LIB = pathToFileURL(path.join(import.meta.dirname, "..", "plugins", "agent", "scripts", "lib", "process.mjs")).href;

// The behaviours whose processes outlive a quick test and are stopped by it.
const LINGERING = new Set(["slow", "hang", "silent", "chatty-silent"]);

// A stand-in for the Antigravity CLI (agy 1.5.10). In stream-json print mode it answers each
// stdin line with the init, step_update and result events agy emits, one turn at a time, with
// the fields recorded from the real CLI: init with tools and permission_mode (and json_schema
// with --json-schema), the reply in several text chunks, a DONE agent step and a result with
// usage, a system_message step on a continued conversation, a finish step and the schema echo
// with --json-schema, and step indexes and turn counts that continue across the processes of
// one conversation. It records every run in agy-state.json next to the script: its arguments,
// its stdin lines (`inputs`) and its stdout lines (`output`); `pids` lists the process id of
// every print-mode process. With --json-schema it returns a structured review: no findings for a
// changes review, and one finding without a location for a project review.
//
// Behaviours other than "ok":
// - "slow" and "hang": each turn takes 3 s (or `{ slowMs }`) or 10 min.
// - "two-messages": each turn writes two agent messages.
// - "models-fail": `agy models` fails as when nobody is signed in.
// - "exit-before-stdin": exits with code 2 before reading stdin.
// - "result-then-exit": on the first line writes init, one agent message and a SUCCESS result
//   with "early-exit-answer-7f3", then exits at once.
// - "denied": a turn whose command was refused: a TOOL_ERROR tool step, then a SUCCESS result
//   with an empty response and denied_actions [{"action":"command","display_name":"Bash"}].
// - "no-agent-text": a SUCCESS result with an empty response after an agent step without text.
// - "exit-without-result": exits with code 0 after the user_input step, with no result.
// - "chatty-silent": writes no agy event, only a diagnostic line, a JSON line of an unknown
//   event and an unterminated fragment, one every 300 ms, and runs until it is stopped.
// - "opening-then-empty": a completed agent step with an opening sentence, then a SUCCESS
//   result with an empty response and no structured output.
// - "silent": writes nothing, not even init, and runs until it is stopped. With
//   `{ spawnChild: true }` it first starts a sleeping child process and records its id in
//   `childPids`.
// - "replayed-events": a continued conversation writes init twice and repeats the previous
//   turn's user_input step before its own.
// - "fail-first-turn": ends turn 1 at once with status ERROR and a response whose braces are not
//   JSON; a later line gets a normal SUCCESS turn.
//
// With `recordIdentities` (the default for "slow", "hang", "silent" and "chatty-silent") each
// print-mode process, and the child of `spawnChild`, is also added as `{ pid, startToken }` to
// `identities` once readProcessIdentity has read it, so a test can stop it with
// stopOwnedProcesses.
export function installFakeAgy(binDir, behavior = "ok", { spawnChild = false, slowMs = 3000, recordIdentities = LINGERING.has(behavior) } = {}) {
  const statePath = path.join(binDir, "agy-state.json");
  const scriptPath = path.join(binDir, "agy");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");

const STATE_PATH = ${JSON.stringify(statePath)};
const BEHAVIOR = ${JSON.stringify(behavior)};
const SPAWN_CHILD = ${JSON.stringify(spawnChild)};
const SLOW_MS = ${JSON.stringify(slowMs)};
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
  console.log("1.5.10");
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

const CONTINUED = Boolean(argValue("--conversation"));
const { conversationId, runIndex, conversation } = updateState((state) => {
  const id = argValue("--conversation") || "conv-" + state.nextConversation++;
  state.runs.push({ args, conversationId: id, inputs: [], output: [], pid: process.pid });
  state.pids = [...(state.pids || []), process.pid];
  state.conversations = state.conversations || {};
  return { conversationId: id, runIndex: state.runs.length - 1, conversation: state.conversations[id] || { steps: 0, turns: 0, lastUserInput: null } };
});
recordIdentity(process.pid);

function readSchema() {
  try {
    return JSON.parse(fs.readFileSync(argValue("--json-schema"), "utf8"));
  } catch {
    return null;
  }
}
const SCHEMA = args.includes("--json-schema") ? readSchema() : null;

if (BEHAVIOR === "exit-before-stdin") {
  process.exit(2);
}

function recordOutput(line) {
  updateState((current) => {
    current.runs[runIndex].output.push(line);
  });
}

// Writes synchronously, so every event is out before an immediate process.exit.
function emitNow(event) {
  recordOutput(JSON.stringify(event));
  fs.writeSync(1, JSON.stringify(event) + "\\n");
}

function emit(event) {
  recordOutput(JSON.stringify(event));
  process.stdout.write(JSON.stringify(event) + "\\n");
}

// Keeps the conversation's step index and turn count for its next process.
function saveConversation() {
  updateState((current) => {
    current.conversations[conversationId] = { steps: step, turns, lastUserInput };
  });
}

const TOOLS = ["read_file", "list_dir", "grep_search", "write_to_file", "replace_file_content", "run_command", "invoke_subagent", "schedule", "run_workflow"];
const USAGE = { input_tokens: 1000, output_tokens: 20, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 1020 };

function record(update) {
  updateState((current) => {
    Object.assign(current.runs[runIndex], update);
  });
}

const initEvent = { event: "init", conversation_id: conversationId, init: { cwd: process.cwd(), tools: TOOLS, permission_mode: "request-review", ...(SCHEMA ? { json_schema: SCHEMA } : {}) } };

const queue = [];
let busy = false;
let inputClosed = false;
let turns = conversation.turns;
let step = conversation.steps;
let lastUserInput = conversation.lastUserInput;

if (BEHAVIOR === "chatty-silent") {
  const noise = ["diagnostic: still working\\n", JSON.stringify({ event: "heartbeat", at: 1 }) + "\\n", "unterminated fragment "];
  let next = 0;
  setInterval(() => {
    process.stdout.write(noise[next % noise.length]);
    next += 1;
  }, 300);
} else if (BEHAVIOR === "silent") {
  // Writes nothing and never exits on its own.
  setInterval(() => {}, 1000);
  if (SPAWN_CHILD) {
    const sleeper = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    updateState((current) => {
      current.childPids = [...(current.childPids || []), sleeper.pid];
    });
    recordIdentity(sleeper.pid);
  }
} else if (BEHAVIOR !== "result-then-exit") {
  emit(initEvent);
  if (BEHAVIOR === "replayed-events" && CONTINUED) {
    emit(initEvent);
  }
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
  if (BEHAVIOR === "replayed-events" && CONTINUED && lastUserInput !== null) {
    emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: lastUserInput, state: "DONE", step_type: "user_input" } });
  }
  lastUserInput = step;
  emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: step++, state: "DONE", step_type: "user_input" } });
  if (CONTINUED) {
    emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: step++, state: "DONE", step_type: "system_message", duration_seconds: 0 } });
  }
  saveConversation();
  if (BEHAVIOR === "exit-without-result") {
    process.exit(0);
  }
  if (BEHAVIOR === "denied") {
    // The headless auto-denial: a TOOL_ERROR tool step, then SUCCESS with an empty response and
    // the refused action in denied_actions.
    const toolInfo = { name: "run_command", parameters: { CommandLine: "ping -n 90 127.0.0.1" } };
    emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: step, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: toolInfo } });
    emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: step++, state: "ERROR", step_type: "tool", tool_name: "run_command", duration_seconds: 0.1, tool_info: { ...toolInfo, error: { type: "TOOL_ERROR", message: "permission to run command: ping -n 90 127.0.0.1 was not granted. Proceed without performing this action." } } } });
    emit({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: "", duration_seconds: 0.1, num_turns: turns, denied_actions: [{ action: "command", display_name: "Bash" }] } });
    busy = false;
    runNext();
    return;
  }
  if (BEHAVIOR === "opening-then-empty") {
    emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: step, state: "ACTIVE", step_type: "agent_response", text_delta: "I will start by reading the files." } });
    emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: step++, state: "DONE", step_type: "agent_response", text_delta: "\\n", duration_seconds: 0.1, usage: USAGE } });
    emit({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: "", duration_seconds: 0.1, num_turns: turns, usage: USAGE } });
    busy = false;
    runNext();
    return;
  }
  if (BEHAVIOR === "no-agent-text") {
    emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: step++, state: "DONE", step_type: "agent_response", duration_seconds: 0.1 } });
    emit({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: "", duration_seconds: 0.1, num_turns: turns } });
    busy = false;
    runNext();
    return;
  }
  if (BEHAVIOR === "fail-first-turn" && turns === 1) {
    emit({ event: "result", result: { conversation_id: conversationId, status: "ERROR", response: "Error: the model request failed {code: 7}", duration_seconds: 0.1, num_turns: turns } });
    busy = false;
    runNext();
    return;
  }
  const delay = BEHAVIOR === "slow" ? SLOW_MS : BEHAVIOR === "hang" ? 600000 : 50;
  setTimeout(() => {
    // The reply quotes the prompt's first line; the plugin's fixed lines follow it.
    const response = "reply: " + String(content).split("\\n")[0];
    if (BEHAVIOR === "two-messages") {
      emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: step++, state: "DONE", step_type: "agent_response", text_delta: "Working on it.", duration_seconds: 0.1, usage: USAGE } });
    }
    // The reply arrives in chunks, as agy streams it.
    const third = Math.ceil(response.length / 3);
    for (const chunk of [response.slice(0, third), response.slice(third, 2 * third), response.slice(2 * third)].filter(Boolean)) {
      emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: step, state: "ACTIVE", step_type: "agent_response", text_delta: chunk } });
    }
    emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: step++, state: "DONE", step_type: "agent_response", text_delta: "\\n", duration_seconds: 0.1, usage: USAGE } });
    const result = { conversation_id: conversationId, status: "SUCCESS", response: (BEHAVIOR === "two-messages" ? "Working on it.\\n" : "") + response + "\\n", duration_seconds: 0.1, num_turns: turns };
    if (args.includes("--json-schema")) {
      emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: step++, state: "DONE", step_type: "finish", duration_seconds: 0.1 } });
      result.json_schema = SCHEMA;
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
    result.usage = USAGE;
    saveConversation();
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
  if (BEHAVIOR === "silent" || BEHAVIOR === "chatty-silent") {
    return;
  }
  if (BEHAVIOR === "result-then-exit") {
    const answer = "early-exit-answer-7f3";
    emitNow(initEvent);
    emitNow({ event: "step_update", step_update: { conversation_id: conversationId, step_index: 0, state: "DONE", step_type: "agent_response", text_delta: answer } });
    emitNow({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: answer, duration_seconds: 0.1, num_turns: 1 } });
    process.exit(0);
  }
  queue.push(content);
  runNext();
}).on("close", () => {
  inputClosed = true;
  record({ stdinClosed: true });
  if (!busy && queue.length === 0 && BEHAVIOR !== "silent") {
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
