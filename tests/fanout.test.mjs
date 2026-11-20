import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeCommittedRepo, makeTempDir, run as runCommand, stopOwnedProcesses, stopWaiting, waitUntil } from "./helpers.mjs";
import { createJob, listJobViews, readJobView, resolveStateDir } from "../plugins/agent/scripts/lib/state.mjs";
import { openStore } from "../plugins/agent/scripts/lib/store.mjs";
import { launchManifestTasks } from "../plugins/agent/scripts/codex-companion.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "agent", "scripts", "codex-companion.mjs");
const NEUTRAL = path.join(ROOT, "plugins", "agent", "scripts", "agent-companion.mjs");

// Every command a test here runs ends within 30 s.
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
  return { repo, binDir, env: buildEnv(binDir) };
}

// Runs `fn` on the job store of the repository and closes the store after.
function withStore(repo, fn) {
  const store = openStore(resolveStateDir(repo));
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

// Every job of the repository's job store, newest first, as job views: `row` holds the columns,
// `request` the stored request (write, worktree { path, branch }) and `state` the job's state.
function jobViews(repo) {
  return withStore(repo, (store) => listJobViews(store, { all: true, limit: 200 }));
}

// The view of one job of the repository's job store, or null.
function jobView(repo, jobId) {
  return withStore(repo, (store) => readJobView(store, jobId));
}

// The worktree folders the repository's jobs ran in.
function jobWorktrees(repo) {
  return [...new Set(jobViews(repo).map((view) => view.request.worktree?.path).filter(Boolean))];
}

// Waits until the job has completed, and stops when it fails.
function waitForCompleted(repo, jobId, timeoutMs = 20000) {
  return waitUntil(
    () => {
      const view = jobView(repo, jobId);
      if (view?.state === "failed") {
        return stopWaiting(`${jobId} failed: ${view.row.error ?? "no message"}`);
      }
      return view?.state === "completed";
    },
    { timeoutMs, describe: `${jobId} to complete` }
  );
}

// Waits until every job of the repository has completed, and stops at the first failed job.
function waitForAllCompleted(repo, timeoutMs) {
  return waitUntil(
    () => {
      const jobs = jobViews(repo);
      const failed = jobs.find((job) => job.state === "failed");
      if (failed) {
        return stopWaiting(`${failed.id} failed: ${failed.row.error ?? "no message"}`);
      }
      return jobs.length > 0 && jobs.every((job) => job.state === "completed");
    },
    { timeoutMs, describe: "every job to complete" }
  );
}

function removeWorktrees(repo) {
  for (const worktreePath of jobWorktrees(repo)) {
    run("git", ["worktree", "remove", "--force", worktreePath], { cwd: repo });
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
  const records = jobViews(ctx.repo);
  assert.equal(records.length, 3);
  assert.deepEqual(records.map((job) => job.row.title).sort(), ["Codex Task: docs", "Codex Task: lint", "Codex Task: tests"]);
  assert.equal(records.find((job) => job.row.title === "Codex Task: tests").request.write, true);
  await waitForAllCompleted(ctx.repo, 30000);
});

test("the fleet command without a manifest asks for one by its command form", () => {
  const ctx = makeRepo();
  for (const argv of [["--manifest "], ["--manifest"], ["--manifest --write"]]) {
    const result = run(process.execPath, [SCRIPT, "task", ...argv], { cwd: ctx.repo, env: ctx.env });
    assert.equal(result.status, 1, JSON.stringify(argv));
    assert.equal(result.stderr.trim(), "Name a manifest file: /agent:codex-fleet <manifest.json>", JSON.stringify(argv));
  }
  assert.deepEqual(jobViews(ctx.repo), []);
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
  assert.deepEqual(jobViews(ctx.repo), []);
});

test("a manifest with a bad entry starts nothing", (t) => {
  const ctx = makeRepo();
  const manifest = path.join(makeTempDir(t), "bad.json");
  fs.writeFileSync(manifest, JSON.stringify([{ label: "a", prompt: "one" }, { label: "a", prompt: "two" }]));

  const result = run("node", [SCRIPT, "task", "--manifest", manifest], { cwd: ctx.repo, env: ctx.env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Manifest entry 2 repeats the label "a"/);
  assert.equal(jobViews(ctx.repo).length, 0);

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
    // The job's stored request names the worktree it ran in.
    const worktree = jobView(ctx.repo, payload.jobId).request.worktree;
    assert.equal(fs.readFileSync(path.join(worktree.path, "codex-edit.txt"), "utf8"), "edited by fake codex\n");
    assert.equal(run("git", ["status", "--short"], { cwd: ctx.repo }).stdout, "");
    assert.equal(fs.existsSync(path.join(ctx.repo, "codex-edit.txt")), false);

    const text = run("node", [NEUTRAL, "result", payload.jobId], { cwd: ctx.repo, env: ctx.env });
    assert.match(text.stdout, /Worktree: .* \(branch agent\/task-[^)]+\)\. Codex worked there, not in your checkout\./);

    // The worktree's branch is named after the job, and the --json reply names the worktree.
    assert.equal(worktree.branch, `agent/${payload.jobId}`);
    const branches = run("git", ["branch", "--list", `agent/${payload.jobId}`], { cwd: ctx.repo }).stdout;
    assert.match(branches, new RegExp(`agent/${payload.jobId}`));
    assert.equal(payload.worktreeBranch, `agent/${payload.jobId}`);
    assert.equal(payload.worktreePath, worktree.path);
  } finally {
    removeWorktrees(ctx.repo);
  }
});

test("a background worktree task reports the worktree when it starts", async () => {
  const ctx = makeRepo("edit-file");
  try {
    const launched = run("node", [SCRIPT, "task", "--background", "--write", "--worktree", "edit something"], { cwd: ctx.repo, env: ctx.env });

    assert.equal(launched.status, 0, launched.stderr);
    await waitUntil(
      () => {
        const [worktreePath] = jobWorktrees(ctx.repo);
        return worktreePath && fs.existsSync(path.join(worktreePath, "codex-edit.txt"));
      },
      { timeoutMs: 20000, describe: "the edit in the worktree" }
    );
    assert.equal(run("git", ["status", "--short"], { cwd: ctx.repo }).stdout, "");
    await waitForAllCompleted(ctx.repo, 20000);
    assert.match(launched.stdout, /It runs in the worktree .* \(branch agent\/task-[^)]+\)\./);
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
  // A Codex job of this session that no worker runs, marked started, so the resume finds a
  // running task.
  const busyId = withStore(repo, (store) => {
    const { jobId } = createJob(store, {
      provider: "codex",
      kind: "task",
      title: "Codex Task",
      prompt: "busy work",
      request: { cwd: repo },
      cwd: repo,
      threadId: "thr-busy",
      requester: { sessionId, leaderPid: null, leaderStartToken: null }
    });
    store.transact((db) => {
      const now = Date.now();
      db.prepare("UPDATE jobs SET claimed_at = ?, started_at = ? WHERE id = ?").run(now, now, jobId);
    });
    return jobId;
  });
  assert.equal(jobView(repo, busyId).state, "running");

  const result = run("node", [SCRIPT, "task", "--worktree", "--resume-last", "x"], {
    cwd: repo,
    env: { ...buildEnv(binDir), AGENT_PLUGIN_SESSION_ID: sessionId }
  });

  assert.equal(result.status, 1, result.stderr);
  // The job store's refusal to continue an active job.
  assert.match(result.stderr, new RegExp(`Job ${busyId} is running`));
  assert.deepEqual(worktreeLeftovers(repo), { worktrees: 1, branches: "" });
});

test("a worktree run whose worktree cannot be created leaves no job", (t) => {
  const repo = makeCommittedRepo(t);
  const binDir = makeTempDir(t);
  installFakeCodex(binDir);
  // A file where the worktrees folder belongs, so no worktree can be created.
  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "worktrees"), "not a folder\n");
  t.after(() => fs.rmSync(path.join(stateDir, "worktrees"), { force: true }));

  const result = run("node", [SCRIPT, "task", "--worktree", "--background", "--json", "x"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 1, result.stderr);
  // The job is created only once its worktree exists, so no scanner can launch it without one.
  assert.deepEqual(jobViews(repo).map((view) => `${view.id} ${view.state}`), []);
  assert.deepEqual(worktreeLeftovers(repo), { worktrees: 1, branches: "" });
});

test("an Antigravity worktree run whose worktree cannot be created leaves no job", (t) => {
  const repo = makeCommittedRepo(t);
  const binDir = makeTempDir(t);
  installFakeAgy(binDir);
  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "worktrees"), "not a folder\n");
  t.after(() => fs.rmSync(path.join(stateDir, "worktrees"), { force: true }));

  const result = run("node", [AGY_SCRIPT, "task", "--worktree", "--background", "--json", "x"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /no job was created/);
  assert.deepEqual(jobViews(repo).map((view) => `${view.id} ${view.state}`), []);
  assert.deepEqual(worktreeLeftovers(repo), { worktrees: 1, branches: "" });
});

test("a worktree run whose thread cannot start leaves nothing behind", async (t) => {
  const repo = makeCommittedRepo(t);
  const binDir = makeTempDir(t);
  installFakeCodex(binDir, "auth-run-fails");

  const launched = run("node", [SCRIPT, "task", "--worktree", "--background", "--json", "x"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);
  const worktreePath = jobView(repo, jobId)?.request.worktree?.path;
  assert.ok(worktreePath);
  // A worker or provider of this job that is still running when the test ends is stopped by the
  // identity the job row recorded, and a worktree folder left in the state folder is removed.
  const stateDir = resolveStateDir(repo);
  t.after(async () => {
    const store = openStore(stateDir);
    let row;
    try {
      row = readJobView(store, jobId)?.row ?? {};
    } finally {
      store.close();
    }
    await stopOwnedProcesses(
      [
        { pid: row.worker_pid, startToken: row.worker_start_token },
        { pid: row.provider_pid, startToken: row.provider_start_token }
      ],
      { tree: true }
    );
    fs.rmSync(worktreePath, { recursive: true, force: true });
  });

  const job = await waitUntil(
    () => {
      const view = jobView(repo, jobId);
      if (view?.state === "completed") {
        return stopWaiting(`${jobId} completed although its thread could not start`);
      }
      if (view?.row.end_state && view.state !== "failed") {
        return stopWaiting(`${jobId} ended ${view.state} instead of failed: ${view.row.error ?? "no message"}`);
      }
      return view?.state === "failed" ? view : null;
    },
    { timeoutMs: 20000, describe: `${jobId} to fail` }
  ).catch((error) => {
    const view = jobView(repo, jobId);
    const logFile = path.join(resolveStateDir(repo), "store", "artifacts", `${jobId}.log`);
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").slice(-2000) : "no log";
    throw new Error(
      `${error.message} (state ${view?.state ?? "missing"}, claimed ${view?.row.claimed_at ?? null}, ` +
        `released ${view?.row.exec_released_at ?? null}, error ${view?.row.error ?? "none"})\n${log}`
    );
  });
  assert.equal(job.row.thread_id ?? null, null);
  assert.match(job.row.error, /could not start: .*authentication expired/);
  // The job reads failed as soon as the failure is recorded; its worker removes the worktree after
  // it has stopped the agent's processes, a moment later.
  await waitUntil(() => !fs.existsSync(worktreePath) && worktreeLeftovers(repo).branches === "", {
    timeoutMs: 20000,
    describe: "the unused worktree and its branch to be removed"
  });
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
  const worktreeFolders = [];
  t.after(() => {
    for (const folder of worktreeFolders) {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  const first = run("node", [SCRIPT, "task", "--write", "--worktree", "--json", "edit something"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const { jobId } = JSON.parse(first.stdout);
  const worktreePath = jobView(repo, jobId).request.worktree.path;
  worktreeFolders.push(worktreePath);
  const edited = path.join(worktreePath, "codex-edit.txt");
  fs.rmSync(edited);

  const sent = run("node", [NEUTRAL, "send", "--json", jobId, "edit again"], { cwd: repo, env });
  assert.equal(sent.status, 0, sent.stderr);
  // The job that continues the finished job on its thread.
  const { status, consumedJobId } = JSON.parse(sent.stdout);
  assert.equal(status, "continued", sent.stdout);
  await waitForCompleted(repo, consumedJobId);

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
  const worktreeFolders = [];
  t.after(() => {
    for (const folder of worktreeFolders) {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  const first = run("node", [SCRIPT, "task", "--write", "--worktree", "--json", "edit something"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const worktreePath = jobView(repo, JSON.parse(first.stdout).jobId).request.worktree.path;
  worktreeFolders.push(worktreePath);
  const edited = path.join(worktreePath, "codex-edit.txt");

  for (const round of ["first", "second"]) {
    fs.rmSync(edited, { force: true });
    const resumed = run("node", [SCRIPT, "task", "--background", "--write", "--resume-last", "--json", `edit again (${round})`], {
      cwd: repo,
      env
    });
    assert.equal(resumed.status, 0, resumed.stderr);
    const { jobId } = JSON.parse(resumed.stdout);
    await waitForCompleted(repo, jobId);
    assert.equal(fs.existsSync(edited), true, `the ${round} resume did not edit the worktree`);
    assert.equal(fs.existsSync(path.join(repo, "codex-edit.txt")), false, `the ${round} resume edited the checkout`);
  }
});

// Loaded with --import, so the companion's detached worker spawn fails with an error event and
// the background launch fails after the job, and the worktree it inherits, were recorded.
const WORKER_SPAWN_FAILS_PRELOAD = [
  'import childProcess from "node:child_process";',
  'import { syncBuiltinESMExports } from "node:module";',
  "const spawn = childProcess.spawn;",
  "childProcess.spawn = function (command, args, ...rest) {",
  '  if (Array.isArray(args) && args.includes("worker")) {',
  "    return {",
  "      pid: undefined,",
  "      once(event, listener) {",
  '        if (event === "error") setImmediate(() => listener(new Error("spawn failed")));',
  "        return this;",
  "      },",
  "      unref() {}",
  "    };",
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
  const worktreeFolders = [];
  t.after(() => {
    for (const folder of worktreeFolders) {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  const first = run("node", [SCRIPT, "task", "--write", "--worktree", "--json", "edit something"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const { path: worktreePath, branch: worktreeBranch } = jobView(repo, JSON.parse(first.stdout).jobId).request.worktree;
  worktreeFolders.push(worktreePath);
  fs.writeFileSync(path.join(worktreePath, "uncommitted.txt"), "work in progress\n");

  const resumed = run(
    process.execPath,
    ["--import", pathToFileURL(preload).href, SCRIPT, "task", "--background", "--write", "--resume-last", "--json", "edit again"],
    { cwd: repo, env }
  );

  // On the job store a committed job whose worker cannot be launched is accepted and stays
  // queued for the next scan or release to launch, in the worktree it inherited.
  assert.equal(resumed.status, 0, resumed.stderr);
  const { jobId: resumedId } = JSON.parse(resumed.stdout);
  const resumedJob = jobView(repo, resumedId);
  assert.equal(resumedJob.state, "queued");
  assert.equal(resumedJob.request.worktree?.path, worktreePath);
  assert.equal(fs.existsSync(path.join(worktreePath, "uncommitted.txt")), true, "the inherited worktree was removed");
  assert.equal(worktreeLeftovers(repo).branches, worktreeBranch, "the inherited branch was deleted");
});
