import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { installFakeAgy } from "./fake-agy-fixture.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { listJobs } from "../plugins/agent/scripts/lib/state.mjs";
import { initGitRepo, makeTempDir, run, waitUntil } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "agent", "scripts", "codex-companion.mjs");
const AGY = path.join(ROOT, "plugins", "agent", "scripts", "agy-companion.mjs");

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
  const stateFile = path.join(binDir, "fake-codex-state.json");
  assert.ok(fs.existsSync(stateFile), "the fake Codex recorded no state");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.ok(state.lastTurnStart, "the fake Codex recorded no turn");
  return state.lastTurnStart.prompt;
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

// The jobs of one class in a workspace, newest first.
function jobsOfClass(repo, jobClass) {
  return listJobs(repo)
    .filter((job) => job.jobClass === jobClass)
    .sort((left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")));
}

// Starts a background hand-off and waits until its job has ended; returns the launch payload.
async function backgroundHandoff(repo, env, extra = []) {
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "--from-last-review", ...extra], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const payload = JSON.parse(launched.stdout);
  const ended = await waitUntil(
    () => ["completed", "failed", "cancelled"].includes(listJobs(repo).find((job) => job.id === payload.jobId)?.status),
    { timeoutMs: 30000, describe: `job ${payload.jobId} ending` }
  );
  assert.ok(ended, `job ${payload.jobId} did not end`);
  return payload;
}

test("the hand-off names the provider and job id of the review it continues", async () => {
  const { repo, binDir, env } = makeRepo();
  installFakeAgy(binDir);
  const agyReview = run("node", [AGY, "review", "--target", "project"], { cwd: repo, env });
  assert.equal(agyReview.status, 0, agyReview.stderr);
  const [antigravity] = jobsOfClass(repo, "review");
  const handoff = await backgroundHandoff(repo, env);
  assert.equal(handoff.summary, `Address the findings of the Antigravity review ${antigravity.id}`);
  assert.ok(
    lastPrompt(binDir).includes(`Address the findings of the Antigravity review ${antigravity.id} below.`),
    lastPrompt(binDir)
  );

  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  const codexReview = run("node", [SCRIPT, "review"], { cwd: repo, env });
  assert.equal(codexReview.status, 0, codexReview.stderr);
  const [codex] = jobsOfClass(repo, "review");
  const second = await backgroundHandoff(repo, env, ["skip", "style"]);
  assert.equal(second.summary, `Address the findings of the Codex review ${codex.id}: skip style`);
  assert.ok(lastPrompt(binDir).includes(`Address the findings of the Codex review ${codex.id} below.`), lastPrompt(binDir));
});
