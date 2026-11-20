import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeCommittedRepo, makeTempDir, run, stopWaiting, waitUntil } from "./helpers.mjs";
import { listJobs, writeJobFile } from "../plugins/agent/scripts/lib/state.mjs";
import { launchManifestTasks } from "../plugins/agent/scripts/codex-companion.mjs";

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
  return { repo, binDir, env: buildEnv(binDir) };
}

// Waits until every job of the repository has completed, and stops at the first failed job.
function waitForAllCompleted(repo, timeoutMs) {
  return waitUntil(
    () => {
      const jobs = listJobs(repo);
      const failed = jobs.find((job) => job.status === "failed");
      if (failed) {
        return stopWaiting(`${failed.id} failed: ${failed.errorMessage ?? "no message"}`);
      }
      return jobs.length > 0 && jobs.every((job) => job.status === "completed");
    },
    { timeoutMs, describe: "every job to complete" }
  );
}

function removeWorktrees(repo) {
  for (const job of listJobs(repo)) {
    if (job.worktreePath) {
      run("git", ["worktree", "remove", "--force", job.worktreePath], { cwd: repo });
    }
  }
}

test("a manifest starts one background job per entry", async (t) => {
  const ctx = makeRepo();
  const manifest = path.join(makeTempDir(t), "manifest.json");
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
  await waitForAllCompleted(ctx.repo, 30000);
});

test("the fleet command without a manifest asks for one by its command form", () => {
  const ctx = makeRepo();
  for (const argv of [["--manifest "], ["--manifest"], ["--manifest --write"]]) {
    const result = run(process.execPath, [SCRIPT, "task", ...argv], { cwd: ctx.repo, env: ctx.env });
    assert.equal(result.status, 1, JSON.stringify(argv));
    assert.equal(result.stderr.trim(), "Name a manifest file: /agent:codex-fleet <manifest.json>", JSON.stringify(argv));
  }
  assert.deepEqual(listJobs(ctx.repo), []);
});

test("a manifest path that starts with a dash is accepted in the inline form", (t) => {
  const ctx = makeRepo();
  const missing = run(process.execPath, [SCRIPT, "task", "--manifest=-fleet.json"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /-fleet\.json/);
  assert.doesNotMatch(missing.stderr, /^Name a manifest file/);

  const separate = run(process.execPath, [SCRIPT, "task", "--manifest", "-fleet.json"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(separate.status, 1);
  assert.match(separate.stderr, /--manifest=-fleet\.json/);
  assert.match(separate.stderr, /\.\/-fleet\.json/);
  assert.deepEqual(listJobs(ctx.repo), []);
});

test("a manifest with a bad entry starts nothing", (t) => {
  const ctx = makeRepo();
  const manifest = path.join(makeTempDir(t), "bad.json");
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

    const text = run("node", [NEUTRAL, "result", payload.jobId], { cwd: ctx.repo, env: ctx.env });
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
    await waitUntil(
      () => {
        const [job] = listJobs(ctx.repo);
        return job?.worktreePath && fs.existsSync(path.join(job.worktreePath, "codex-edit.txt"));
      },
      { timeoutMs: 20000, describe: "the edit in the worktree" }
    );
    assert.equal(run("git", ["status", "--short"], { cwd: ctx.repo }).stdout, "");
    await waitForAllCompleted(ctx.repo, 20000);
  } finally {
    removeWorktrees(ctx.repo);
  }
});

test("the fan-out command's single argument string keeps a native manifest path", async (t) => {
  const ctx = makeRepo();
  const manifest = path.join(makeTempDir(t), "cmd.json");
  fs.writeFileSync(manifest, JSON.stringify([{ label: "only", prompt: "do one thing" }]));

  // process.execPath avoids a shell, so the string reaches the companion as the command passes it.
  const result = run(process.execPath, [SCRIPT, "task", `--manifest ${manifest} --json`], { cwd: ctx.repo, env: ctx.env });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).jobs.map((job) => job.label), ["only"]);
  await waitForAllCompleted(ctx.repo, 20000);
});

// Counts the repository's worktrees and lists its agent/* branches, the two things a failed
// worktree launch must not leave behind.
function worktreeLeftovers(repo) {
  const worktrees = run("git", ["worktree", "list", "--porcelain"], { cwd: repo, shell: false })
    .stdout.split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "));
  const branches = run("git", ["branch", "--list", "--format=%(refname:short)", "agent/*"], { cwd: repo, shell: false }).stdout.trim();
  return { worktrees: worktrees.length, branches };
}

// A PATH folder that holds git but no Codex, so the companion finds git and not Codex.
function pathWithGitOnly() {
  const sep = process.platform === "win32" ? ";" : ":";
  const gitNames = process.platform === "win32" ? ["git.exe", "git.cmd"] : ["git"];
  const codexNames = process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex.ps1", "codex"] : ["codex"];
  for (const dir of String(process.env.PATH ?? "").split(sep).filter(Boolean)) {
    const hasGit = gitNames.some((name) => fs.existsSync(path.join(dir, name)));
    const hasCodex = codexNames.some((name) => fs.existsSync(path.join(dir, name)));
    if (hasGit && !hasCodex) {
      return dir;
    }
  }
  return null;
}

test("a worktree run without a prompt leaves no worktree or branch", (t) => {
  const repo = makeCommittedRepo(t);
  const binDir = makeTempDir(t);
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "task", "--worktree"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Provide a prompt/);
  assert.deepEqual(worktreeLeftovers(repo), { worktrees: 1, branches: "" });
});

test("a worktree run with Codex unavailable leaves nothing behind", (t) => {
  const gitDir = pathWithGitOnly();
  if (!gitDir) {
    t.skip("no PATH folder holds git without Codex");
    return;
  }
  const repo = makeCommittedRepo(t);

  const result = run(process.execPath, [SCRIPT, "task", "--worktree", "edit something"], {
    cwd: repo,
    env: { ...process.env, PATH: gitDir }
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Codex CLI is not installed/);
  assert.deepEqual(worktreeLeftovers(repo), { worktrees: 1, branches: "" });
});

test("a worktree resume that finds a running task leaves nothing behind", (t) => {
  const repo = makeCommittedRepo(t);
  const binDir = makeTempDir(t);
  installFakeCodex(binDir);
  const sessionId = "session-worktree-resume";
  // A running record without a pid stays active, so the resume lookup sees a running task.
  writeJobFile(repo, "task-busy", {
    id: "task-busy",
    provider: "codex",
    status: "running",
    phase: "running",
    jobClass: "task",
    title: "Codex Task",
    sessionId,
    threadId: "thr-busy",
    pid: null
  });

  const result = run("node", [SCRIPT, "task", "--worktree", "--resume-last", "x"], {
    cwd: repo,
    env: { ...buildEnv(binDir), AGENT_PLUGIN_SESSION_ID: sessionId }
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /still running/);
  assert.deepEqual(worktreeLeftovers(repo), { worktrees: 1, branches: "" });
});

test("a worktree run whose thread cannot start leaves nothing behind", async (t) => {
  const repo = makeCommittedRepo(t);
  const binDir = makeTempDir(t);
  installFakeCodex(binDir, "auth-run-fails");

  const launched = run("node", [SCRIPT, "task", "--worktree", "--background", "--json", "x"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId, worktreePath } = JSON.parse(launched.stdout);
  assert.ok(worktreePath);

  const job = await waitUntil(
    () => {
      const record = listJobs(repo).find((candidate) => candidate.id === jobId);
      if (record?.status === "completed") {
        return stopWaiting(`${jobId} completed although its thread could not start`);
      }
      return record?.status === "failed" ? record : null;
    },
    { timeoutMs: 20000, describe: `${jobId} to fail` }
  );
  assert.equal(job.threadId ?? null, null);
  assert.equal(fs.existsSync(worktreePath), false, "the worktree folder remains");
  assert.deepEqual(worktreeLeftovers(repo), { worktrees: 1, branches: "" });
});

test("a manifest entry that fails after its worktree exists is rolled back and the next entry starts", (t) => {
  const repo = makeCommittedRepo(t);
  const binDir = makeTempDir(t);
  installFakeCodex(binDir);
  const manifest = path.join(makeTempDir(t), "manifest.json");
  fs.writeFileSync(
    manifest,
    JSON.stringify([
      { label: "first", prompt: "one", worktree: true },
      { label: "second", prompt: "two", worktree: true }
    ])
  );
  const enqueued = [];
  const enqueue = (_cwd, job) => {
    enqueued.push(job);
    if (enqueued.length === 1) {
      throw new Error("the worker could not be started");
    }
    return { payload: { jobId: job.id } };
  };

  // The launch checks Codex on PATH and prints its JSON report to stdout, so both are redirected
  // for the call and restored afterwards, with the exit code it sets for the failed entry.
  const savedPath = process.env.PATH;
  const savedWrite = process.stdout.write;
  const savedExitCode = process.exitCode;
  let printed = "";
  process.env.PATH = buildEnv(binDir).PATH;
  process.stdout.write = (chunk) => {
    printed += chunk;
    return true;
  };
  try {
    launchManifestTasks(repo, repo, { manifest, json: true }, [], { model: null, effort: null }, { enqueue });
  } finally {
    process.stdout.write = savedWrite;
    process.env.PATH = savedPath;
    process.exitCode = savedExitCode;
  }
  const [first, second] = enqueued;
  // The worktree folder lives in the state folder, outside the repository the test removes.
  t.after(() => fs.rmSync(second.worktreePath, { recursive: true, force: true }));

  const output = JSON.parse(printed);
  assert.deepEqual(output.failed.map((entry) => entry.label), ["first"]);
  assert.deepEqual(output.jobs.map((entry) => entry.jobId), [second.id]);
  assert.equal(fs.existsSync(first.worktreePath), false, "the failed entry's worktree remains");
  assert.equal(fs.existsSync(second.worktreePath), true);
  assert.equal(worktreeLeftovers(repo).branches, `agent/${second.id}`);
});

test("send to a finished worktree job runs in its worktree", async (t) => {
  const repo = makeCommittedRepo(t);
  const binDir = makeTempDir(t);
  installFakeCodex(binDir, "edit-file");
  const env = buildEnv(binDir);
  // The worktree folders live in the state folder, outside the repository the test removes.
  t.after(() => {
    for (const job of listJobs(repo)) {
      if (job.worktreePath) {
        fs.rmSync(job.worktreePath, { recursive: true, force: true });
      }
    }
  });

  const first = run("node", [SCRIPT, "task", "--write", "--worktree", "--json", "edit something"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const { jobId, worktreePath } = JSON.parse(first.stdout);
  const edited = path.join(worktreePath, "codex-edit.txt");
  fs.rmSync(edited);

  const sent = run("node", [NEUTRAL, "send", "--json", jobId, "edit again"], { cwd: repo, env });
  assert.equal(sent.status, 0, sent.stderr);
  const { newJobId } = JSON.parse(sent.stdout);
  await waitUntil(
    () => {
      const record = listJobs(repo).find((candidate) => candidate.id === newJobId);
      if (record?.status === "failed") {
        return stopWaiting(`${newJobId} failed: ${record.errorMessage}`);
      }
      return record?.status === "completed";
    },
    { timeoutMs: 20000, describe: `${newJobId} to complete` }
  );

  assert.equal(fs.existsSync(edited), true, "the follow-up turn did not edit the worktree");
  assert.equal(fs.existsSync(path.join(repo, "codex-edit.txt")), false, "the follow-up turn edited the checkout");
  assert.equal(run("git", ["status", "--short"], { cwd: repo, shell: false }).stdout, "");
});

test("chained background resumes of a worktree job both run in its worktree", async (t) => {
  const repo = makeCommittedRepo(t);
  const binDir = makeTempDir(t);
  installFakeCodex(binDir, "edit-file");
  const env = buildEnv(binDir);
  // The worktree folders live in the state folder, outside the repository the test removes.
  t.after(() => {
    for (const job of listJobs(repo)) {
      if (job.worktreePath) {
        fs.rmSync(job.worktreePath, { recursive: true, force: true });
      }
    }
  });

  const first = run("node", [SCRIPT, "task", "--write", "--worktree", "--json", "edit something"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const { worktreePath } = JSON.parse(first.stdout);
  const edited = path.join(worktreePath, "codex-edit.txt");

  for (const round of ["first", "second"]) {
    fs.rmSync(edited, { force: true });
    const resumed = run("node", [SCRIPT, "task", "--background", "--write", "--resume-last", "--json", `edit again (${round})`], {
      cwd: repo,
      env
    });
    assert.equal(resumed.status, 0, resumed.stderr);
    const { jobId } = JSON.parse(resumed.stdout);
    await waitUntil(
      () => {
        const record = listJobs(repo).find((candidate) => candidate.id === jobId);
        if (record?.status === "failed") {
          return stopWaiting(`${jobId} failed: ${record.errorMessage}`);
        }
        return record?.status === "completed";
      },
      { timeoutMs: 20000, describe: `${jobId} to complete` }
    );
    assert.equal(fs.existsSync(edited), true, `the ${round} resume did not edit the worktree`);
    assert.equal(fs.existsSync(path.join(repo, "codex-edit.txt")), false, `the ${round} resume edited the checkout`);
  }
});

// Loaded with --import, so the companion's detached worker spawn reports no pid and the
// background launch fails after the job's worktree was chosen.
const WORKER_SPAWN_FAILS_PRELOAD = [
  'import childProcess from "node:child_process";',
  'import { syncBuiltinESMExports } from "node:module";',
  "const spawn = childProcess.spawn;",
  "childProcess.spawn = function (command, args, ...rest) {",
  '  if (Array.isArray(args) && args.includes("task-worker")) {',
  "    return { pid: undefined, once() { return this; }, unref() {} };",
  "  }",
  "  return spawn.call(this, command, args, ...rest);",
  "};",
  "syncBuiltinESMExports();"
].join("\n");

test("a background resume whose launch fails keeps the worktree it inherited", (t) => {
  const repo = makeCommittedRepo(t);
  const binDir = makeTempDir(t);
  installFakeCodex(binDir, "edit-file");
  const env = buildEnv(binDir);
  const preload = path.join(makeTempDir(t), "worker-spawn-fails.mjs");
  fs.writeFileSync(preload, WORKER_SPAWN_FAILS_PRELOAD);
  // The worktree folders live in the state folder, outside the repository the test removes.
  t.after(() => {
    for (const job of listJobs(repo)) {
      if (job.worktreePath) {
        fs.rmSync(job.worktreePath, { recursive: true, force: true });
      }
    }
  });

  const first = run("node", [SCRIPT, "task", "--write", "--worktree", "--json", "edit something"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const { worktreePath, worktreeBranch } = JSON.parse(first.stdout);
  fs.writeFileSync(path.join(worktreePath, "uncommitted.txt"), "work in progress\n");

  const resumed = run(
    process.execPath,
    ["--import", pathToFileURL(preload).href, SCRIPT, "task", "--background", "--write", "--resume-last", "edit again"],
    { cwd: repo, env }
  );

  assert.notEqual(resumed.status, 0, resumed.stdout);
  assert.match(resumed.stderr, /background worker could not be started/);
  assert.equal(fs.existsSync(path.join(worktreePath, "uncommitted.txt")), true, "the inherited worktree was removed");
  assert.equal(worktreeLeftovers(repo).branches, worktreeBranch, "the inherited branch was deleted");
});
