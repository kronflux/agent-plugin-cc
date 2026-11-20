import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "agent", "scripts", "codex-companion.mjs");

function makeRepo() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return { repo, binDir, env: buildEnv(binDir) };
}

function lastPrompt(binDir) {
  return JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8")).lastTurnStart.prompt;
}

test("task --from-last-review sends the newest review's findings", () => {
  const { repo, binDir, env } = makeRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  const review = run("node", [SCRIPT, "review", "--json"], { cwd: repo, env });
  assert.equal(review.status, 0, review.stderr);
  const reviewText = JSON.parse(review.stdout).codex.stdout;
  assert.ok(reviewText.trim());

  const result = run("node", [SCRIPT, "task", "--from-last-review", "fix", "only", "real", "issues"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  const prompt = lastPrompt(binDir);
  assert.match(prompt, /<review_findings>/);
  assert.ok(prompt.includes(reviewText.split("\n")[0]), prompt);
  assert.match(prompt, /Instructions from the user:\nfix only real issues/);
});

test("task --from-last-review without a finished review fails before Codex starts", () => {
  const { repo, binDir, env } = makeRepo();
  const result = run("node", [SCRIPT, "task", "--from-last-review"], { cwd: repo, env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No finished Codex review with output was found/);
  const stateFile = path.join(binDir, "fake-codex-state.json");
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
  assert.equal(state.lastTurnStart, undefined);
});
