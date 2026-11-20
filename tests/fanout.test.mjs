import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { listJobs } from "../plugins/agent/scripts/lib/state.mjs";

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
  return { repo, binDir, env: buildEnv(binDir) };
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function removeWorktrees(repo) {
  for (const job of listJobs(repo)) {
    if (job.worktreePath) {
      run("git", ["worktree", "remove", "--force", job.worktreePath], { cwd: repo });
    }
  }
}

test("a manifest starts one background job per entry", async () => {
  const ctx = makeRepo();
  const manifest = path.join(ctx.repo, "..", `manifest-${path.basename(ctx.repo)}.json`);
  fs.writeFileSync(
    manifest,
    JSON.stringify([
      { label: "lint", prompt: "fix lint" },
      { label: "docs", prompt: "update docs", effort: "low" },
      { label: "tests", prompt: "add tests", write: true }
    ])
  );

  const result = run("node", [SCRIPT, "task", "--manifest", manifest, "--json"], { cwd: ctx.repo, env: ctx.env });

  assert.equal(result.status, 0, result.stderr);
  const { jobs, failed } = JSON.parse(result.stdout);
  assert.deepEqual(failed, []);
  assert.deepEqual(jobs.map((job) => job.label), ["lint", "docs", "tests"]);
  assert.equal(new Set(jobs.map((job) => job.jobId)).size, 3);
  const records = listJobs(ctx.repo);
  assert.equal(records.length, 3);
  assert.deepEqual(records.map((job) => job.title).sort(), ["Codex Task: docs", "Codex Task: lint", "Codex Task: tests"]);
  assert.equal(records.find((job) => job.title === "Codex Task: tests").write, true);
  assert.ok(await waitUntil(() => listJobs(ctx.repo).every((job) => job.status === "completed"), 30000), "the jobs did not finish");
});

test("a manifest with a bad entry starts nothing", () => {
  const ctx = makeRepo();
  const manifest = path.join(ctx.repo, "..", `bad-${path.basename(ctx.repo)}.json`);
  fs.writeFileSync(manifest, JSON.stringify([{ label: "a", prompt: "one" }, { label: "a", prompt: "two" }]));

  const result = run("node", [SCRIPT, "task", "--manifest", manifest], { cwd: ctx.repo, env: ctx.env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Manifest entry 2 repeats the label "a"/);
  assert.equal(listJobs(ctx.repo).length, 0);

  const mixed = run("node", [SCRIPT, "task", "--manifest", manifest, "also this"], { cwd: ctx.repo, env: ctx.env });
  assert.notEqual(mixed.status, 0);
  assert.match(mixed.stderr, /--manifest takes its prompts from the file\. Remove the prompt text/);
});

test("task --worktree leaves the checkout untouched and Codex edits the worktree", () => {
  const ctx = makeRepo("edit-file");
  try {
    const result = run("node", [SCRIPT, "task", "--write", "--worktree", "--json", "edit something"], { cwd: ctx.repo, env: ctx.env });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.worktreeBranch, `agent/${payload.jobId}`);
    assert.equal(fs.readFileSync(path.join(payload.worktreePath, "codex-edit.txt"), "utf8"), "edited by fake codex\n");
    assert.equal(run("git", ["status", "--short"], { cwd: ctx.repo }).stdout, "");
    assert.equal(fs.existsSync(path.join(ctx.repo, "codex-edit.txt")), false);
    const branches = run("git", ["branch", "--list", `agent/${payload.jobId}`], { cwd: ctx.repo }).stdout;
    assert.match(branches, new RegExp(`agent/${payload.jobId}`));

    const text = run("node", [SCRIPT, "result", payload.jobId], { cwd: ctx.repo, env: ctx.env });
    assert.match(text.stdout, /Worktree: .* \(branch agent\/task-[^)]+\)\. Codex worked there, not in your checkout\./);
  } finally {
    removeWorktrees(ctx.repo);
  }
});

test("a background worktree task reports the worktree when it starts", async () => {
  const ctx = makeRepo("edit-file");
  try {
    const launched = run("node", [SCRIPT, "task", "--background", "--write", "--worktree", "edit something"], { cwd: ctx.repo, env: ctx.env });

    assert.equal(launched.status, 0, launched.stderr);
    assert.match(launched.stdout, /It runs in the worktree .* \(branch agent\/task-[^)]+\)\./);
    const [job] = listJobs(ctx.repo);
    assert.ok(await waitUntil(() => fs.existsSync(path.join(job.worktreePath, "codex-edit.txt")), 20000));
    assert.equal(run("git", ["status", "--short"], { cwd: ctx.repo }).stdout, "");
    assert.ok(await waitUntil(() => listJobs(ctx.repo)[0].status === "completed", 20000));
  } finally {
    removeWorktrees(ctx.repo);
  }
});

test("the fan-out command's single argument string keeps a native manifest path", async () => {
  const ctx = makeRepo();
  const manifest = path.join(ctx.repo, "..", `cmd-${path.basename(ctx.repo)}.json`);
  fs.writeFileSync(manifest, JSON.stringify([{ label: "only", prompt: "do one thing" }]));

  // process.execPath avoids a shell, so the string reaches the companion as the command passes it.
  const result = run(process.execPath, [SCRIPT, "task", `--manifest ${manifest} --json`], { cwd: ctx.repo, env: ctx.env });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).jobs.map((job) => job.label), ["only"]);
  assert.ok(await waitUntil(() => listJobs(ctx.repo).every((job) => job.status === "completed"), 20000));
});
