import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import { readStdinIfPiped } from "../plugins/agent/scripts/lib/fs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_HOOK = path.join(ROOT, "plugins", "agent", "scripts", "session-lifecycle-hook.mjs");

function runSessionStart(envFile, sessionId, cwd) {
  const result = run(process.execPath, [SESSION_HOOK, "SessionStart"], {
    cwd,
    env: { ...process.env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: path.join(cwd, "data") },
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: sessionId, cwd })
  });
  assert.equal(result.status, 0, result.stderr);
}

function exportsOf(envFile, name) {
  return fs
    .readFileSync(envFile, "utf8")
    .split("\n")
    .filter((line) => line.startsWith(`export ${name}=`));
}

test("repeated SessionStart runs add each export once and keep other hooks' lines", () => {
  const cwd = makeTempDir();
  const envFile = path.join(cwd, "env.sh");
  fs.writeFileSync(envFile, "export OTHER=1\n");

  for (let attempt = 0; attempt < 5; attempt += 1) {
    runSessionStart(envFile, "sess-1", cwd);
  }

  assert.deepEqual(exportsOf(envFile, "CODEX_COMPANION_SESSION_ID"), ["export CODEX_COMPANION_SESSION_ID='sess-1'"]);
  assert.equal(exportsOf(envFile, "CLAUDE_PLUGIN_DATA").length, 1);
  assert.deepEqual(exportsOf(envFile, "OTHER"), ["export OTHER=1"]);
});

test("a changed value is appended so the latest export wins", () => {
  const cwd = makeTempDir();
  const envFile = path.join(cwd, "env.sh");

  for (const sessionId of ["sess-a", "sess-b", "sess-b", "sess-a"]) {
    runSessionStart(envFile, sessionId, cwd);
  }

  assert.deepEqual(exportsOf(envFile, "CODEX_COMPANION_SESSION_ID"), [
    "export CODEX_COMPANION_SESSION_ID='sess-a'",
    "export CODEX_COMPANION_SESSION_ID='sess-b'",
    "export CODEX_COMPANION_SESSION_ID='sess-a'"
  ]);
});

test("stdin reads retry EAGAIN until the full payload arrives", () => {
  const payload = Buffer.from(JSON.stringify({ hook_event_name: "Stop", session_id: "s" }));
  const steps = ["EAGAIN", payload.subarray(0, 10), "EAGAIN", "EAGAIN", payload.subarray(10), 0];
  const waits = [];

  const text = readStdinIfPiped({
    stdin: { isTTY: false },
    wait: (milliseconds) => waits.push(milliseconds),
    readSync(_fd, buffer) {
      const step = steps.shift();
      if (step === "EAGAIN") {
        throw Object.assign(new Error("resource temporarily unavailable"), { code: "EAGAIN" });
      }
      if (step === 0) {
        return 0;
      }
      const count = Math.min(step.length, buffer.length);
      step.copy(buffer, 0, 0, count);
      if (count < step.length) {
        steps.unshift(step.subarray(count));
      }
      return count;
    }
  });

  assert.equal(text, payload.toString());
  assert.equal(waits.length, 3);
});

test("a non-blocking stdin with no writer reads as empty after the first-byte timeout", () => {
  let clock = 0;
  const text = readStdinIfPiped({
    stdin: { isTTY: false },
    firstByteTimeoutMs: 100,
    now: () => clock,
    wait: (milliseconds) => {
      clock += milliseconds;
    },
    readSync() {
      throw Object.assign(new Error("resource temporarily unavailable"), { code: "EAGAIN" });
    }
  });
  assert.equal(text, "");
});
