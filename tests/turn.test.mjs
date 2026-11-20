import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run as runCommand } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "agent", "scripts", "codex-companion.mjs");

// Every command a test here runs ends within 30 s unless the test names a longer limit.
function run(command, args, options = {}) {
  return runCommand(command, args, { timeout: 30000, ...options });
}

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
