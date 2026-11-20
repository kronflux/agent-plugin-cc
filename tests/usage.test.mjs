import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "agent", "scripts", "codex-companion.mjs");

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

test("usage prints the account's limit windows and plan", () => {
  const { repo, env } = makeRepo();
  const result = run("node", [SCRIPT, "usage"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Plan: plus$/m);
  assert.match(result.stdout, /^Credits: 12\.50$/m);
  assert.match(result.stdout, /^- 5-hour window: 42% used, resets 2026-\d\d-\d\dT\d\d:\d\d:\d\dZ /m);
  assert.match(result.stdout, /^GPT-5\.3-Codex-Spark:\n- 5-hour window: 90% used/m);
});

test("usage --json prints the response Codex returned", () => {
  const { repo, env } = makeRepo();
  const result = run("node", [SCRIPT, "usage", "--json"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).rateLimits.primary.usedPercent, 42);
});

test("usage exits non-zero when Codex cannot read the limits", () => {
  const { repo, env } = makeRepo("rate-limits-fail");
  const result = run("node", [SCRIPT, "usage"], { cwd: repo, env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /failed to fetch codex rate limits: not signed in/);
});

test("setup reports the app server user agent", () => {
  const { repo, env } = makeRepo();
  const result = run("node", [SCRIPT, "setup", "--json"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).appServer, "fake-codex-app-server");
});
