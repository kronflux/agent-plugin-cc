import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

import { installFakeAgy, readFakeAgyState } from "./fake-agy-fixture.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeCommittedRepo, makeTempDir, run as runCommand, stopOwnedProcesses, stopWaiting, waitUntil } from "./helpers.mjs";
import {
  beginWorktreeRemoval,
  finishWorktreeRemoval,
  removePluginWorktree
} from "../plugins/agent/scripts/commands/worktree.mjs";
import { splitRawArgumentString } from "../plugins/agent/scripts/lib/args.mjs";
import {
  claimExecution,
  createJob,
  decideNext,
  listJobViews,
  pruneChains,
  readJobView,
  resolveStateDir
} from "../plugins/agent/scripts/lib/state.mjs";
import { openStore } from "../plugins/agent/scripts/lib/store.mjs";
import { launchWorker } from "../plugins/agent/scripts/lib/task-launch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "agent", "scripts", "codex-companion.mjs");
const NEUTRAL = path.join(ROOT, "plugins", "agent", "scripts", "agent-companion.mjs");
const AGY_SCRIPT = path.join(ROOT, "plugins", "agent", "scripts", "agy-companion.mjs");
const HOOK = path.join(ROOT, "plugins", "agent", "scripts", "session-lifecycle-hook.mjs");

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

// ---------------------------------------------------------------------------------------------
// The worktree command

function git(cwd, args) {
  return run("git", args, { cwd, shell: false, check: true }).stdout.trim();
}

// Runs one finished foreground `task --worktree` job with `label`, waits until its worker has
// released the execution, and returns its id, worktree path and branch. The worktree folder is
// removed when the test ends.
async function finishedWorktreeJob(t, ctx, label) {
  const result = run(process.execPath, [SCRIPT, "task", "--worktree", "--json", "--label", label, `work for ${label}`], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 0, result.stderr);
  const { jobId } = JSON.parse(result.stdout);
  await waitUntil(() => jobView(ctx.repo, jobId)?.row.exec_released_at, { timeoutMs: 20000, describe: `${jobId} to release its execution` });
  const { path: worktreePath, branch } = jobView(ctx.repo, jobId).request.worktree;
  t.after(() => fs.rmSync(worktreePath, { recursive: true, force: true }));
  return { jobId, worktreePath, branch };
}

function neutral(ctx, args) {
  return run(process.execPath, [NEUTRAL, ...args], { cwd: ctx.repo, env: ctx.env, shell: false });
}

test("worktree list shows plugin worktrees with dirty and ahead counts", async (t) => {
  const ctx = makeRepo();
  const dirty = await finishedWorktreeJob(t, ctx, "wt-dirty");
  const ahead = await finishedWorktreeJob(t, ctx, "wt-ahead");
  fs.writeFileSync(path.join(dirty.worktreePath, "notes.txt"), "uncommitted\n");
  fs.writeFileSync(path.join(ahead.worktreePath, "feature.txt"), "committed\n");
  git(ahead.worktreePath, ["add", "feature.txt"]);
  git(ahead.worktreePath, ["commit", "-m", "feature"]);
  const outside = path.join(makeTempDir(t), "outside");
  git(ctx.repo, ["worktree", "add", "-b", "not-plugin", outside, "HEAD"]);

  const listed = neutral(ctx, ["worktree", "list", "--json"]);

  assert.equal(listed.status, 0, listed.stderr);
  const { worktrees } = JSON.parse(listed.stdout);
  assert.equal(worktrees.length, 2, listed.stdout);
  const byLabel = Object.fromEntries(worktrees.map((entry) => [entry.label, entry]));
  assert.deepEqual(byLabel["wt-dirty"], {
    jobId: dirty.jobId,
    label: "wt-dirty",
    branch: dirty.branch,
    path: byLabel["wt-dirty"].path,
    dirty: true,
    ahead: 0,
    jobState: "completed"
  });
  assert.equal(byLabel["wt-ahead"].dirty, false);
  assert.equal(byLabel["wt-ahead"].ahead, 1);
  assert.equal(byLabel["wt-ahead"].jobId, ahead.jobId);
  assert.equal(fs.realpathSync(byLabel["wt-ahead"].path), fs.realpathSync(ahead.worktreePath));

  const text = neutral(ctx, ["worktree", "list"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, new RegExp(`\\| ${dirty.jobId} \\| wt-dirty \\| agent/${dirty.jobId} \\| .* \\| yes \\| 0 \\| completed \\|`));

  const plain = makeTempDir(t);
  const outsideGit = run(process.execPath, [NEUTRAL, "worktree", "list"], { cwd: plain, env: ctx.env, shell: false });
  assert.equal(outsideGit.status, 0, outsideGit.stderr);
  assert.equal(outsideGit.stdout.trim(), "No git repository here, so the plugin has no worktrees.");
});

// The registered worktree folders of the repository, as git prints them.
function registeredWorktrees(repo) {
  return git(repo, ["worktree", "list", "--porcelain"])
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => fs.realpathSync.native(path.resolve(line.slice("worktree ".length))).toLowerCase());
}

function isRegistered(repo, folder) {
  return registeredWorktrees(repo).includes(fs.realpathSync.native(folder).toLowerCase());
}

function branchExists(repo, branch) {
  return run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo, shell: false }).status === 0;
}

function commitIn(folder, name) {
  fs.writeFileSync(path.join(folder, name), `${name}\n`);
  git(folder, ["add", name]);
  git(folder, ["commit", "-m", `add ${name}`]);
}

test("worktree removal is safe", async (t) => {
  const ctx = makeRepo();
  const clean = await finishedWorktreeJob(t, ctx, "rm-clean");
  const dirty = await finishedWorktreeJob(t, ctx, "rm-dirty");
  const ahead = await finishedWorktreeJob(t, ctx, "rm-ahead");
  fs.writeFileSync(path.join(dirty.worktreePath, "notes.txt"), "uncommitted\n");
  commitIn(ahead.worktreePath, "feature.txt");

  const removed = neutral(ctx, ["worktree", "remove", clean.jobId]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(removed.stdout.trim(), `Removed worktree ${clean.worktreePath} and branch ${clean.branch}.`);
  assert.equal(fs.existsSync(clean.worktreePath), false);
  assert.equal(git(ctx.repo, ["branch", "--list", clean.branch]), "");

  const refusedDirty = neutral(ctx, ["worktree", "remove", dirty.jobId]);
  assert.equal(refusedDirty.status, 1, refusedDirty.stdout);
  assert.equal(
    refusedDirty.stderr.trim(),
    `Worktree ${dirty.worktreePath} has uncommitted changes. See them with: git -C "${dirty.worktreePath}" status. ` +
      "To remove it and discard those changes, add --force."
  );

  const refusedAhead = neutral(ctx, ["worktree", "remove", ahead.jobId]);
  assert.equal(refusedAhead.status, 1, refusedAhead.stdout);
  assert.equal(
    refusedAhead.stderr.trim(),
    `Branch ${ahead.branch} has 1 commit(s) that main does not have. See them with: git log main..${ahead.branch}`
  );

  assert.ok(isRegistered(ctx.repo, dirty.worktreePath));
  assert.ok(isRegistered(ctx.repo, ahead.worktreePath));
  assert.ok(branchExists(ctx.repo, ahead.branch));
  assert.ok(branchExists(ctx.repo, dirty.branch));
  assert.deepEqual(
    fs.readdirSync(path.dirname(clean.worktreePath)).filter((name) => name.startsWith(".removing-")),
    []
  );
});

test("removal ignores an upstream that lacks the merged commits", async (t) => {
  const ctx = makeRepo();
  const base = git(ctx.repo, ["rev-parse", "HEAD"]);
  const job = await finishedWorktreeJob(t, ctx, "rm-upstream");
  commitIn(job.worktreePath, "merged.txt");
  git(ctx.repo, ["merge", "--ff-only", job.branch]);
  git(ctx.repo, ["branch", "stale-base", base]);
  git(ctx.repo, ["branch", `--set-upstream-to=stale-base`, job.branch]);

  const removed = neutral(ctx, ["worktree", "remove", job.jobId]);

  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.existsSync(job.worktreePath), false);
  assert.equal(branchExists(ctx.repo, job.branch), false);
});

test("remove --force discards uncommitted changes and unmerged commits", async (t) => {
  const ctx = makeRepo();
  const untracked = await finishedWorktreeJob(t, ctx, "force-untracked");
  const edited = await finishedWorktreeJob(t, ctx, "force-edited");
  const ahead = await finishedWorktreeJob(t, ctx, "force-ahead");
  fs.writeFileSync(path.join(untracked.worktreePath, "notes.txt"), "uncommitted\n");
  fs.writeFileSync(path.join(edited.worktreePath, "README.md"), "edited\n");
  fs.writeFileSync(path.join(edited.worktreePath, "extra.txt"), "new\n");
  commitIn(ahead.worktreePath, "feature.txt");

  for (const job of [untracked, edited]) {
    const refusedDirty = neutral(ctx, ["worktree", "remove", job.jobId]);
    assert.equal(refusedDirty.status, 1, refusedDirty.stdout);
    assert.equal(
      refusedDirty.stderr.trim(),
      `Worktree ${job.worktreePath} has uncommitted changes. See them with: git -C "${job.worktreePath}" status. ` +
        "To remove it and discard those changes, add --force."
    );
    assert.ok(isRegistered(ctx.repo, job.worktreePath));
    assert.ok(branchExists(ctx.repo, job.branch));
  }

  const forcedUntracked = neutral(ctx, ["worktree", "remove", untracked.jobId, "--force"]);
  assert.equal(forcedUntracked.status, 0, forcedUntracked.stderr);
  assert.equal(
    forcedUntracked.stdout.trim(),
    `Removed worktree ${untracked.worktreePath} and branch ${untracked.branch}.\nDiscarded 1 uncommitted path(s).`
  );
  assert.equal(fs.existsSync(untracked.worktreePath), false);
  assert.equal(branchExists(ctx.repo, untracked.branch), false);

  const forcedEdited = neutral(ctx, ["worktree", "remove", "--force", "force-edited", "--json"]);
  assert.equal(forcedEdited.status, 0, forcedEdited.stderr);
  assert.equal(
    JSON.parse(forcedEdited.stdout).message,
    `Removed worktree ${edited.worktreePath} and branch ${edited.branch}.\nDiscarded 2 uncommitted path(s).`
  );
  assert.equal(fs.existsSync(edited.worktreePath), false);
  assert.equal(branchExists(ctx.repo, edited.branch), false);

  const aheadSha = git(ctx.repo, ["rev-parse", `refs/heads/${ahead.branch}`]);
  const forcedAhead = neutral(ctx, ["worktree", "remove", ahead.jobId, "--force"]);
  assert.equal(forcedAhead.status, 0, forcedAhead.stderr);
  assert.equal(
    forcedAhead.stdout.trim(),
    `Removed worktree ${ahead.worktreePath} and branch ${ahead.branch}.\nDiscarded 1 commit(s) that main does not have.\n` +
      `The branch pointed at ${aheadSha}; restore it with: git branch ${ahead.branch} ${aheadSha}`
  );
  assert.equal(fs.existsSync(ahead.worktreePath), false);
  assert.equal(branchExists(ctx.repo, ahead.branch), false);
  assert.equal(git(ctx.repo, ["cat-file", "-t", aheadSha]), "commit");
  assert.deepEqual(
    fs.readdirSync(path.dirname(ahead.worktreePath)).filter((name) => name.startsWith(".removing-")),
    []
  );
});

test("remove --force on a clean merged worktree is a plain removal", async (t) => {
  const ctx = makeRepo();
  const clean = await finishedWorktreeJob(t, ctx, "force-clean");

  const removed = neutral(ctx, ["worktree", "remove", clean.jobId, "--force"]);

  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(removed.stdout.trim(), `Removed worktree ${clean.worktreePath} and branch ${clean.branch}.`);
  assert.equal(fs.existsSync(clean.worktreePath), false);
  assert.equal(branchExists(ctx.repo, clean.branch), false);
});

// A job of the repository's store that holds a worktree the test creates, recorded as claimed
// and ended with no release of its execution.
function unreleasedWorktreeJob(ctx) {
  const stateDir = resolveStateDir(ctx.repo);
  const jobId = withStore(ctx.repo, (store) => {
    const created = createJob(
      store,
      {
        provider: "codex",
        kind: "task",
        title: "Codex Task",
        prompt: "held",
        request: { cwd: ctx.repo },
        cwd: ctx.repo,
        requester: { sessionId: null, leaderPid: null, leaderStartToken: null }
      },
      {
        withinCreate: (db, { jobId: id }) => {
          const worktree = { path: path.join(stateDir, "worktrees", id), branch: `agent/${id}` };
          db.prepare("UPDATE jobs SET request_json = ? WHERE id = ?").run(JSON.stringify({ cwd: ctx.repo, worktree }), id);
        }
      }
    ).jobId;
    store.transact((db) => {
      const now = Date.now();
      db.prepare("UPDATE jobs SET claimed_at = ?, end_state = 'completed', end_at = ?, end_by = 'worker' WHERE id = ?").run(now, now, created);
    });
    return created;
  });
  const worktreePath = path.join(stateDir, "worktrees", jobId);
  git(ctx.repo, ["worktree", "add", "-b", `agent/${jobId}`, worktreePath, "HEAD"]);
  return { jobId, worktreePath };
}

test("removal refuses a running job and an unreleased execution", async (t) => {
  const ctx = makeRepo("interruptible-slow-task");
  const launched = run(process.execPath, [SCRIPT, "task", "--worktree", "--background", "--json", "slow work"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);
  const runningPath = jobView(ctx.repo, jobId).request.worktree.path;
  t.after(async () => {
    await waitUntil(() => ["completed", "failed", "cancelled"].includes(jobView(ctx.repo, jobId)?.state), { timeoutMs: 30000, describe: `${jobId} to end` }).catch(
      () => null
    );
    const row = jobView(ctx.repo, jobId)?.row ?? {};
    await stopOwnedProcesses(
      [
        { pid: row.worker_pid, startToken: row.worker_start_token },
        { pid: row.provider_pid, startToken: row.provider_start_token }
      ].filter((target) => target.pid),
      { tree: true }
    );
  });
  await waitUntil(() => jobView(ctx.repo, jobId)?.row.claimed_at, { timeoutMs: 20000, describe: `${jobId} to be claimed` });

  const running = neutral(ctx, ["worktree", "remove", jobId]);
  assert.equal(running.status, 1, running.stdout);
  assert.match(running.stderr, /not finished/);
  const runningForced = neutral(ctx, ["worktree", "remove", jobId, "--force"]);
  assert.equal(runningForced.status, 1, runningForced.stdout);
  assert.match(runningForced.stderr, /not finished/);

  const held = unreleasedWorktreeJob(ctx);
  const unreleased = neutral(ctx, ["worktree", "remove", held.jobId]);
  assert.equal(unreleased.status, 1, unreleased.stdout);
  assert.match(unreleased.stderr, /not released its provider process/);
  const unreleasedForced = neutral(ctx, ["worktree", "remove", held.jobId, "--force"]);
  assert.equal(unreleasedForced.status, 1, unreleasedForced.stdout);
  assert.match(unreleasedForced.stderr, /not released its provider process/);

  assert.ok(fs.existsSync(runningPath));
  assert.ok(fs.existsSync(held.worktreePath));
});

test("removal by label, an unknown option, and a partial failure is reported", async (t) => {
  const ctx = makeRepo();
  const byLabel = await finishedWorktreeJob(t, ctx, "rm-label");
  const removed = neutral(ctx, ["worktree", "remove", "rm-label"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.existsSync(byLabel.worktreePath), false);

  const forced = await finishedWorktreeJob(t, ctx, "rm-force");
  const refused = neutral(ctx, ["worktree", "remove", forced.jobId, "--forced"]);
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /--forced/);
  assert.match(refused.stderr, /unknown/i);
  assert.match(refused.stderr, /worktree remove <job-id\|label> \[--force\]/);
  // After the end-of-options marker, --force is an argument and gives no permission to discard.
  fs.writeFileSync(path.join(forced.worktreePath, "kept.txt"), "kept\n");
  const literal = neutral(ctx, ["worktree", "remove", forced.jobId, "--", "--force"]);
  assert.equal(literal.status, 1, literal.stdout);
  assert.match(literal.stderr, /Unexpected argument|unknown/i);
  assert.equal(fs.existsSync(path.join(forced.worktreePath, "kept.txt")), true);
  fs.rmSync(path.join(forced.worktreePath, "kept.txt"));
  assert.ok(fs.existsSync(forced.worktreePath));

  // The branch moves to a new commit with the same tree after the merged check, so the worktree
  // is still clean and is removed, and the branch no longer points at the checked commit.
  const stateDir = resolveStateDir(ctx.repo);
  const outcome = withStore(ctx.repo, (store) =>
    removePluginWorktree(forced.jobId, {
      cwd: ctx.repo,
      stateDir,
      store,
      identity: { pid: process.pid, startToken: "test" },
      hooks: {
        beforeRemove: () => {
          const moved = git(ctx.repo, ["commit-tree", `${forced.branch}^{tree}`, "-p", forced.branch, "-m", "moved"]);
          git(ctx.repo, ["update-ref", `refs/heads/${forced.branch}`, moved]);
        }
      }
    })
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, new RegExp(`^Removed worktree .*, but kept branch ${forced.branch}: `));
  assert.equal(fs.existsSync(forced.worktreePath), false);
  assert.ok(branchExists(ctx.repo, forced.branch));
});

const REQUESTER = { sessionId: null, leaderPid: null, leaderStartToken: null };
// A worker identity no running process has, so no scan treats the test process as a worker.
const CLAIM = { pid: 4194000, startToken: "test-claim" };

// Continues the chain of `jobId` and returns the queued successor's id.
function continueChain(store, jobId) {
  const tip = store.read((db) => db.prepare("SELECT tip_job_id FROM chains WHERE id = (SELECT chain_id FROM jobs WHERE id = ?)").get(jobId)).tip_job_id;
  const decided = decideNext(store, { ref: tip, observedTipId: tip }, { action: "continue", message: "more", requester: REQUESTER });
  assert.equal(decided.won, true);
  return decided.successorId;
}

function launchAttempts(store, jobId) {
  return store.read((db) => db.prepare("SELECT launch_attempts FROM jobs WHERE id = ?").get(jobId).launch_attempts);
}

// One fresh repository with one finished worktree job, its store and removal context.
async function raceFixture(t, label) {
  const ctx = makeRepo();
  const job = await finishedWorktreeJob(t, ctx, label);
  const stateDir = resolveStateDir(ctx.repo);
  const store = openStore(stateDir);
  t.after(() => store.close());
  const removal = { cwd: ctx.repo, stateDir, store, identity: { pid: process.pid, startToken: "test" } };
  return { ctx, job, stateDir, store, removal, marker: path.join(path.dirname(job.worktreePath), `.removing-${job.jobId}`) };
}

test("a continuation racing a removal never runs in the removed worktree", async (t) => {
  // (a) A continuation claimed before the removal reads the chain: the removal is refused.
  {
    const { job, store, removal } = await raceFixture(t, "race-a");
    const successor = continueChain(store, job.jobId);
    assert.equal(claimExecution(store, successor, CLAIM).claimed, true);
    const outcome = removePluginWorktree(job.jobId, removal);
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /not finished|not released/);
    assert.ok(fs.existsSync(job.worktreePath));
  }
  // (b) A continuation created and claimed after the removal read the idle chain and before the
  // worktree is removed: its launch spawns nothing and its claim reports the worktree unavailable.
  {
    const { job, store, stateDir, removal } = await raceFixture(t, "race-b");
    let claim = null;
    let launched;
    let successor;
    const outcome = removePluginWorktree(job.jobId, {
      ...removal,
      hooks: {
        afterChainRead: () => {
          successor = continueChain(store, job.jobId);
          launched = launchWorker(store, stateDir, successor);
          claim = claimExecution(store, successor, CLAIM);
        }
      }
    });
    assert.equal(await launched, null);
    assert.equal(launchAttempts(store, successor), 0);
    assert.equal(outcome.ok, true, outcome.message);
    assert.equal(claim.claimed, true);
    assert.equal(claim.worktreeUnavailable, true);
  }
  // (c) A continuation after the removal finished and its marker is gone: the folder is missing,
  // so the launched worker ends the job; it does not stay queued.
  {
    const { job, store, stateDir, removal, marker } = await raceFixture(t, "race-c");
    assert.equal(removePluginWorktree(job.jobId, removal).ok, true);
    assert.equal(fs.existsSync(marker), false);
    const successor = continueChain(store, job.jobId);
    await launchWorker(store, stateDir, successor);
    assert.equal(launchAttempts(store, successor), 1);
    await waitUntil(() => readJobView(store, successor)?.row.exec_released_at, { timeoutMs: 20000, describe: ` to end` });
    const row = readJobView(store, successor).row;
    assert.equal(row.end_state, "failed");
    assert.equal(row.end_reason, "worktree removed");
  }
  // (d) A removal that fails at the merged check deletes its marker; a later claim may run.
  {
    const { job, store, removal, marker } = await raceFixture(t, "race-d");
    commitIn(job.worktreePath, "unmerged.txt");
    const outcome = removePluginWorktree(job.jobId, removal);
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /commit\(s\)/);
    assert.equal(fs.existsSync(marker), false);
    const claim = claimExecution(store, continueChain(store, job.jobId), CLAIM);
    assert.equal(claim.claimed, true);
    assert.equal(claim.worktreeUnavailable, undefined);
  }
  // (e) The worker checks the marker first and the folder second. A removal that completes,
  // folder then marker, just before the worker's marker read leaves no marker and no folder; a
  // removal that deletes the folder after the worker read the marker was seen by that read.
  {
    const { job, store, removal, marker } = await raceFixture(t, "race-e1");
    const begun = beginWorktreeRemoval(job.jobId, removal);
    assert.equal(begun.ok, true, begun.message);
    const successor = continueChain(store, job.jobId);
    let finished;
    const claim = claimExecution(store, successor, {
      ...CLAIM,
      hooks: { beforeMarkerCheck: () => (finished = finishWorktreeRemoval(begun.context)) }
    });
    assert.equal(finished.ok, true, finished.message);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(claim.worktreeUnavailable, true);
  }
  {
    const { job, store, removal } = await raceFixture(t, "race-e2");
    const begun = beginWorktreeRemoval(job.jobId, removal);
    assert.equal(begun.ok, true, begun.message);
    const successor = continueChain(store, job.jobId);
    let finished;
    const claim = claimExecution(store, successor, {
      ...CLAIM,
      hooks: { afterMarkerCheck: () => (finished = finishWorktreeRemoval(begun.context)) }
    });
    assert.equal(finished.ok, true, finished.message);
    assert.equal(claim.worktreeUnavailable, true);
  }
  // (f) Two removers that find a marker left by a stopped remover both refuse and leave it as is.
  {
    const { job, removal, marker } = await raceFixture(t, "race-f");
    const bytes = Buffer.from('{"pid":1,"startToken":"gone"');
    fs.writeFileSync(marker, bytes);
    for (const attempt of [1, 2]) {
      const outcome = removePluginWorktree(job.jobId, removal);
      assert.equal(outcome.ok, false, `attempt ${attempt}`);
      assert.equal(
        outcome.message,
        `Another removal of ${job.worktreePath} is in progress. If no remover and no session uses this workspace, delete ${marker} and run the command again.`
      );
      assert.deepEqual(fs.readFileSync(marker), bytes);
    }
    assert.ok(fs.existsSync(job.worktreePath));
  }
});

test("a worktree result names the worktree remove command", async (t) => {
  const ctx = makeRepo();
  const job = await finishedWorktreeJob(t, ctx, "note-cmd");

  const result = neutral(ctx, ["result", job.jobId]);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(job.worktreePath), result.stdout);
  assert.match(result.stdout, new RegExp(`worktree remove ${job.jobId}\n`));
  assert.doesNotMatch(result.stdout, /git worktree remove/);
  const command = result.stdout.match(/When its work is merged, remove it with: (.+)\n/)?.[1];
  assert.ok(command, result.stdout);
  const [program, ...args] = splitRawArgumentString(command);
  assert.equal(program, "node");
  const removed = run(process.execPath, args, { cwd: ctx.repo, env: ctx.env, shell: false });
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.existsSync(job.worktreePath), false);
  assert.equal(branchExists(ctx.repo, job.branch), false);
});

test("pruning a chain keeps its worktree, which is then listed as job pruned", async (t) => {
  const ctx = makeRepo();
  const job = await finishedWorktreeJob(t, ctx, "prune-kept");
  const prunedIds = withStore(ctx.repo, (store) => {
    const old = Date.now() - 20 * 24 * 60 * 60 * 1000;
    store.transact((db) => {
      db.prepare("UPDATE chains SET activity_at = ? WHERE id = ?").run(old, job.jobId);
      db.prepare("DELETE FROM meta WHERE key = 'last_prune_at'").run();
    });
    for (let index = 0; index < 50; index += 1) {
      const { jobId } = createJob(store, {
        provider: "codex",
        kind: "task",
        title: "Codex Task",
        prompt: `newer ${index}`,
        request: { cwd: ctx.repo },
        cwd: ctx.repo,
        requester: { sessionId: null, leaderPid: null, leaderStartToken: null }
      });
      store.transact((db) => {
        db.prepare("UPDATE jobs SET end_state = 'completed', end_at = ?, end_by = 'worker' WHERE id = ?").run(Date.now(), jobId);
      });
    }
    return pruneChains(store, { now: Date.now() }).prunedJobIds;
  });

  assert.ok(prunedIds.includes(job.jobId), JSON.stringify(prunedIds));
  assert.ok(fs.existsSync(job.worktreePath));
  assert.ok(branchExists(ctx.repo, job.branch));
  const listed = JSON.parse(neutral(ctx, ["worktree", "list", "--json"]).stdout).worktrees;
  assert.deepEqual(
    listed.map((entry) => [entry.jobId, entry.label, entry.jobState]),
    [[job.jobId, null, "job pruned"]]
  );

  const removed = neutral(ctx, ["worktree", "remove", job.jobId]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.existsSync(job.worktreePath), false);
  assert.equal(branchExists(ctx.repo, job.branch), false);
});

test("session end keeps a worktree", async (t) => {
  const ctx = makeRepo();
  const sessionId = "session-keeps-worktree";
  const env = { ...ctx.env, AGENT_PLUGIN_SESSION_ID: sessionId };
  const result = run(process.execPath, [SCRIPT, "task", "--worktree", "--json", "session work"], { cwd: ctx.repo, env });
  assert.equal(result.status, 0, result.stderr);
  const { jobId } = JSON.parse(result.stdout);
  const { path: worktreePath, branch } = jobView(ctx.repo, jobId).request.worktree;
  t.after(() => fs.rmSync(worktreePath, { recursive: true, force: true }));
  await waitUntil(() => jobView(ctx.repo, jobId)?.row.exec_released_at, { timeoutMs: 20000, describe: `${jobId} to release its execution` });

  const hook = run(process.execPath, ["--disable-warning=ExperimentalWarning", HOOK, "SessionEnd"], {
    cwd: ctx.repo,
    env,
    shell: false,
    input: JSON.stringify({ hook_event_name: "SessionEnd", reason: "other", session_id: sessionId, cwd: ctx.repo })
  });

  assert.equal(hook.status, 0, hook.stderr);
  assert.ok(fs.existsSync(worktreePath));
  assert.ok(branchExists(ctx.repo, branch));
});

test("resuming a job whose worktree was removed ends the new job instead of leaving it queued", async (t) => {
  const ctx = makeRepo();
  const job = await finishedWorktreeJob(t, ctx, "resume-after-removal");
  const removed = neutral(ctx, ["worktree", "remove", job.jobId]);
  assert.equal(removed.status, 0, removed.stderr);

  const successor = withStore(ctx.repo, (store) => continueChain(store, job.jobId));
  const store = openStore(resolveStateDir(ctx.repo));
  t.after(() => store.close());
  await launchWorker(store, resolveStateDir(ctx.repo), successor);

  await waitUntil(() => jobView(ctx.repo, successor)?.row.exec_released_at, { timeoutMs: 20000, describe: `${successor} to end` });
  const row = jobView(ctx.repo, successor).row;
  assert.equal(row.end_state, "failed");
  assert.equal(row.end_reason, "worktree removed");
});

test("a worker whose worktree is under removal or gone ends the job without starting its provider", async (t) => {
  const ctx = makeRepo();
  installFakeAgy(ctx.binDir);
  const scripts = { codex: SCRIPT, agy: AGY_SCRIPT };
  const providerRuns = {
    codex: () => JSON.parse(fs.readFileSync(path.join(ctx.binDir, "fake-codex-state.json"), "utf8")).appServerStarts ?? 0,
    agy: () => readFakeAgyState(ctx.binDir).runs.length
  };
  const stateDir = resolveStateDir(ctx.repo);
  for (const [provider, unavailable] of [
    ["codex", "marker"],
    ["agy", "marker"],
    ["codex", "folder"]
  ]) {
    const label = `gone-${provider}-${unavailable}`;
    const result = run(process.execPath, [scripts[provider], "task", "--worktree", "--json", "--label", label, "first turn"], {
      cwd: ctx.repo,
      env: ctx.env,
      shell: false
    });
    assert.equal(result.status, 0, result.stderr);
    const { jobId } = JSON.parse(result.stdout);
    const worktreePath = jobView(ctx.repo, jobId).request.worktree.path;
    t.after(() => fs.rmSync(worktreePath, { recursive: true, force: true }));
    await waitUntil(() => jobView(ctx.repo, jobId)?.row.exec_released_at, { timeoutMs: 20000, describe: `${jobId} to release its execution` });
    const successor = withStore(ctx.repo, (store) => continueChain(store, jobId));
    const marker = path.join(path.dirname(worktreePath), `.removing-${path.basename(worktreePath)}`);
    if (unavailable === "marker") {
      fs.writeFileSync(marker, JSON.stringify({ pid: 1, startToken: "removal" }));
    } else {
      git(ctx.repo, ["worktree", "remove", worktreePath]);
    }
    const runsBefore = providerRuns[provider]();

    const worker = run(process.execPath, ["--disable-warning=ExperimentalWarning", scripts[provider], "worker", "--state-dir", stateDir, "--job", successor], {
      cwd: ctx.repo,
      env: ctx.env,
      shell: false
    });

    const row = jobView(ctx.repo, successor).row;
    assert.equal(worker.status, 0, `${label}: ${worker.stderr}`);
    assert.equal(row.end_state, "failed", `${label}: ${JSON.stringify({ end: row.end_state, error: row.error })}`);
    assert.equal(row.end_reason, "worktree removed", label);
    assert.ok(row.exec_released_at, `${label}: the execution was not released`);
    assert.equal(providerRuns[provider](), runsBefore, `${label}: the provider was started`);
    fs.rmSync(marker, { force: true });
  }
});
