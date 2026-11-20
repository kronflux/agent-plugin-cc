import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
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

test("stdin data that arrives with pauses is read in full", async () => {
  const payload = JSON.stringify({ hook_event_name: "Stop", session_id: "s" });
  const stdin = new PassThrough();
  const reading = readStdinIfPiped({ stdin, firstByteTimeoutMs: 1000, totalTimeoutMs: 5000 });
  stdin.write(payload.slice(0, 10));
  await new Promise((resolve) => setTimeout(resolve, 50));
  stdin.end(payload.slice(10));

  assert.equal(await reading, payload);
});

test("a piped stdin with no writer reads as empty after the first-byte timeout", { timeout: 5000 }, async () => {
  const startedAt = Date.now();
  const text = await readStdinIfPiped({ stdin: new PassThrough(), firstByteTimeoutMs: 100 });
  assert.equal(text, "");
  assert.ok(Date.now() - startedAt < 2000);
});
