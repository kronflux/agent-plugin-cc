import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { readTurnResultFromRollout } from "../plugins/agent/scripts/providers/codex/rollout.mjs";
import { writeJobFile } from "../plugins/agent/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "agent", "scripts", "codex-companion.mjs");
const NEUTRAL = path.join(ROOT, "plugins", "agent", "scripts", "agent-companion.mjs");

function makeRepo(behavior) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return { repo, env: buildEnv(binDir) };
}

// Writes a rollout file with one line per record. A string record is written as it is, so a
// test can add a line that is not JSON.
function writeRollout(codexHome, threadId, records) {
  const dir = path.join(codexHome, "sessions", "2026", "10", "02");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-02T10-00-00-${threadId}.jsonl`);
  const lines = records.map((record) => (typeof record === "string" ? record : JSON.stringify(record)));
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

test("a turn that stops sending events ends with the output it produced", () => {
  const { repo, env } = makeRepo("stall-after-message");
  const started = Date.now();
  const result = run("node", [SCRIPT, "task", "--json", "investigate"], {
    cwd: repo,
    env: { ...env, CODEX_COMPANION_TURN_IDLE_TIMEOUT_MS: "1500" }
  });

  assert.ok(Date.now() - started < 20000);
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.rawOutput, "Partial answer before the stall.");
  assert.match(payload.failureMessage, /sent no events for 2 s/);
});

test("readTurnResultFromRollout reads only the requested turn", () => {
  const codexHome = makeTempDir();
  writeRollout(codexHome, "thr-1", [
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-a", last_agent_message: "Answer A" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-b" } },
    { type: "event_msg", payload: { type: "item_completed", turn_id: "turn-b", item: { type: "AgentMessage", content: [{ type: "Text", text: "Half of B" }] } } },
    "not json"
  ]);

  assert.deepEqual(
    { ...readTurnResultFromRollout("thr-1", "turn-a", { codexHome }), file: undefined },
    { text: "Answer A", complete: true, file: undefined }
  );
  const turnB = readTurnResultFromRollout("thr-1", "turn-b", { codexHome });
  assert.ok(turnB, "turn-b was not found in the rollout");
  assert.equal(turnB.text, "Half of B");
  assert.equal(turnB.complete, false);
  assert.equal(readTurnResultFromRollout("thr-1", "turn-c", { codexHome }), null);
  assert.equal(readTurnResultFromRollout("thr-1", null, { codexHome }), null);
});

test("result prints a lost answer from the Codex transcript", () => {
  const { repo, env } = makeRepo();
  const codexHome = makeTempDir();
  writeRollout(codexHome, "thr-lost", [
    { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-lost", last_agent_message: "The recovered answer." } }
  ]);
  writeJobFile(repo, "task-lost", {
    id: "task-lost",
    status: "failed",
    title: "Codex Task",
    jobClass: "task",
    threadId: "thr-lost",
    turnId: "turn-lost"
  });

  const result = run("node", [NEUTRAL, "result", "task-lost"], { cwd: repo, env: { ...env, CODEX_HOME: codexHome } });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Recovered from the Codex transcript\.\n/);
  assert.match(result.stdout, /The recovered answer\./);
});

test("a missing Codex home yields no recovered result", () => {
  assert.equal(readTurnResultFromRollout("no-such-thread", "no-turn", { codexHome: path.join(os.tmpdir(), "absent-codex-home") }), null);
});
