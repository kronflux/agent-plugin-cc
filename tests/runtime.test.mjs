import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeCommittedRepo, makeTempDir, run as runCommand, stopOwnedProcess, stopOwnedProcesses, waitUntil } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/agent/scripts/lib/state.mjs";
import { createCodexDriver } from "../plugins/agent/scripts/providers/codex/runtime.mjs";
import { isProcessAlive } from "../plugins/agent/scripts/lib/process.mjs";
import * as storeLib from "../plugins/agent/scripts/lib/store.mjs";
import * as storeState from "../plugins/agent/scripts/lib/state.mjs";
import { launchWorker } from "../plugins/agent/scripts/lib/task-launch.mjs";
import * as storeFixtures from "./store-fixtures.mjs";
import * as mailbox from "../plugins/agent/scripts/lib/mailbox.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "agent");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const NEUTRAL = path.join(PLUGIN_ROOT, "scripts", "agent-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

// Every command a test here runs ends within 30 s unless the test names a longer limit.
function run(command, args, options = {}) {
  return runCommand(command, args, { timeout: 30000, ...options });
}

// Reads the log of the newest job of the job store for workspace `repo`.
function readStoreJobLog(repo) {
  const artifacts = path.join(resolveStateDir(repo), "store", "artifacts");
  const [newest] = fs
    .readdirSync(artifacts)
    .filter((name) => name.endsWith(".log"))
    .map((name) => ({ name, mtime: fs.statSync(path.join(artifacts, name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime);
  assert.ok(newest, "the job store holds no job log");
  return fs.readFileSync(path.join(artifacts, newest.name), "utf8");
}

// Reads the process ids of every fake app server started with this bin folder, in start order.
function readAppServerPids(binDir) {
  const statePath = path.join(binDir, "fake-codex-state.json");
  if (!fs.existsSync(statePath)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(statePath, "utf8")).appServerPids ?? [];
}

// The recorded `{ pid, startToken }` of every fake app server started with this bin folder by a
// fake Codex installed with recordIdentities.
function readAppServerIdentities(binDir) {
  const statePath = path.join(binDir, "fake-codex-state.json");
  if (!fs.existsSync(statePath)) {
    return [];
  }
  return (JSON.parse(fs.readFileSync(statePath, "utf8")).processIdentities ?? []).filter((entry) => entry.key === "appServerPids");
}

// Registers a cleanup that stops, through stopOwnedProcesses, every app server of the bin folder
// `getBinDir()` names that recorded its identity and has not been seen exiting. Register it
// before the bin folder, so the cleanup runs before the folder is removed.
function stopLeftoverProcesses(t, getBinDir, exited) {
  t.after(() => {
    const binDir = getBinDir();
    return binDir ? stopOwnedProcesses(readAppServerIdentities(binDir).filter((entry) => !exited.has(entry.pid))) : [];
  });
}

// Waits until every listed process has exited and records each one as exited.
async function waitForExit(pids, exited, describe) {
  await waitUntil(() => pids.every((pid) => !isProcessAlive(pid)), { timeoutMs: 5000, describe });
  for (const pid of pids) {
    exited.add(pid);
  }
}

// Adds a queued Codex job that no worker runs to the job store of workspace `repo`; resolves to
// its id. A queued job stays active, so a wait on it blocks until its time limit.
function seedQueuedCodexJob(repo, { sessionId = null, title = "Codex Task" } = {}) {
  const db = storeLib.openStore(resolveStateDir(repo));
  try {
    return storeState.createJob(db, {
      provider: "codex",
      kind: "task",
      title,
      prompt: "queued work",
      request: { cwd: repo },
      cwd: repo,
      requester: { sessionId, leaderPid: null, leaderStartToken: null }
    }).jobId;
  } finally {
    db.close();
  }
}

test("setup reports ready when fake codex is installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.match(payload.codex.detail, /advanced runtime available/);
  assert.equal(payload.sessionRuntime.mode, "direct");
});

test("setup is ready without npm when Codex is already installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  // cmd.exe finds `node` only with a PATHEXT extension. A hard link needs no symlink
  // privilege; a copy covers a temp folder on another volume.
  if (process.platform === "win32") {
    const nodeCopy = path.join(binDir, "node.exe");
    try {
      fs.linkSync(process.execPath, nodeCopy);
    } catch {
      fs.copyFileSync(process.execPath, nodeCopy);
    }
  } else {
    fs.symlinkSync(process.execPath, path.join(binDir, "node"));
  }

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: binDir
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.npm.available, false);
  assert.equal(payload.codex.available, true);
  assert.equal(payload.auth.loggedIn, true);
});

test("setup trusts app-server API key auth even when login status alone would fail", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "api-key-account-only");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, "apiKey");
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /API key configured \(unverified\)/);
});

test("setup is ready when the active provider does not require OpenAI login", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

test("setup treats custom providers with app-server-ready config as ready", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "env-key-provider");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

test("setup reports not ready when app-server config read fails", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "config-read-fails");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /config\/read failed for cwd/);
});

test("review renders a no-findings result from app-server review/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed uncommitted changes/);
  assert.match(result.stdout, /No material issues found/);
});

test("task runs when the active provider does not require OpenAI login", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check auth preflight"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("task runs without auth preflight so Codex can refresh an expired session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check refreshable auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("task reports the actual Codex auth error when the run is rejected", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "auth-run-fails");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check failed auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /authentication expired; run codex login/);
});

test("review accepts the quoted raw argument style for built-in base-branch review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review", "--base main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed changes against main/);
  assert.match(result.stdout, /No material issues found/);
});

test("review --stance critical renders structured findings over app-server turn/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "review", "--stance", "critical"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test("review --stance critical accepts the same base-branch targeting as review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "review", "--stance", "critical", "--base", "main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Branch review against main|against main/i);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test("review --stance critical asks Codex to inspect larger diffs itself", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(repo, "src", name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "src/a.js", "src/b.js", "src/c.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "a.js"), 'export const value = "PROMPT_SELF_COLLECT_A";\n');
  fs.writeFileSync(path.join(repo, "src", "b.js"), 'export const value = "PROMPT_SELF_COLLECT_B";\n');
  fs.writeFileSync(path.join(repo, "src", "c.js"), 'export const value = "PROMPT_SELF_COLLECT_C";\n');

  const result = run("node", [SCRIPT, "review", "--stance", "critical"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.match(state.lastTurnStart.prompt, /lightweight summary/i);
  assert.match(state.lastTurnStart.prompt, /read-only git commands/i);
  assert.doesNotMatch(state.lastTurnStart.prompt, /PROMPT_SELF_COLLECT_[ABC]/);
});

test("review includes reasoning output when the app server returns it", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  // The job's log, its reasoning summary included, is printed on stderr while the review runs.
  assert.match(result.stderr, /Reasoning summary/);
  assert.match(result.stderr, /Reviewed the changed files and checked the likely regression paths/i);
});

test("review logs reasoning summaries and review output to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const log = readStoreJobLog(repo);
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Reviewed the changed files and checked the likely regression paths/);
  assert.match(log, /Review output/);
  assert.match(log, /Reviewed uncommitted changes\./);
});

test("task --resume-last resumes the latest persisted task thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Resumed the prior run.\nFollow-up prompt accepted.\n");
});

for (const value of ["0", "abc"]) {
  test(`status --timeout-ms ${value} is rejected`, (t) => {
    const repo = makeCommittedRepo(t);
    // A queued job stays active, so a wait that accepted the value would block.
    const jobId = seedQueuedCodexJob(repo);

    const result = spawnSync(process.execPath, [NEUTRAL, "status", jobId, "--wait", "--timeout-ms", value], {
      cwd: repo,
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true
    });

    assert.equal(result.error?.code ?? null, null, "status kept waiting");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /--timeout-ms must be a positive number of milliseconds\./);
  });
}

// Records a finished agy task job with a conversation id, written after every earlier record.
// Adds a finished agy job of session `sessionId` to the job store of workspace `repo`, newer than
// every job there; resolves to its id.
async function seedFinishedAgyJob(repo, sessionId) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stateDir = resolveStateDir(repo);
  const db = storeLib.openStore(stateDir);
  try {
    const { jobId } = storeState.createJob(db, {
      provider: "agy",
      kind: "task",
      title: "Agy Task",
      prompt: "agy work",
      request: { cwd: repo },
      cwd: repo,
      threadId: "agy-conversation-1",
      requester: { sessionId, leaderPid: null, leaderStartToken: null }
    });
    storeFixtures.rawExec(stateDir, "UPDATE jobs SET end_state = 'completed', end_at = ?, end_by = 'worker' WHERE id = ?", [Date.now(), jobId]);
    return jobId;
  } finally {
    db.close();
  }
}

test("task --resume-last ignores a finished agy job", async (t) => {
  const repo = makeCommittedRepo(t);
  const binDir = makeTempDir(t);
  installFakeCodex(binDir);
  const env = { ...buildEnv(binDir), AGENT_PLUGIN_SESSION_ID: "sess-agy" };
  const firstRun = run("node", [SCRIPT, "task", "initial task"], { cwd: repo, env });
  assert.equal(firstRun.status, 0, firstRun.stderr);
  await seedFinishedAgyJob(repo, "sess-agy");

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], { cwd: repo, env });

  assert.equal(resume.status, 0, resume.stderr);
  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  // The follow-up reaches Codex as the first message of the continuing job.
  assert.match(fakeState.lastTurnStart.prompt, /^\[message \d+\]\nfollow up$/);
});

test("task-resume-candidate offers only Codex jobs", async (t) => {
  const repo = makeCommittedRepo(t);
  const binDir = makeTempDir(t);
  installFakeCodex(binDir);
  const env = { ...buildEnv(binDir), AGENT_PLUGIN_SESSION_ID: "sess-agy" };
  const firstRun = run("node", [SCRIPT, "task", "codex work"], { cwd: repo, env });
  assert.equal(firstRun.status, 0, firstRun.stderr);
  const [codexJob] = storeFixtures.rawAll(resolveStateDir(repo), "SELECT id, thread_id FROM jobs");
  await seedFinishedAgyJob(repo, "sess-agy");

  const result = run("node", [SCRIPT, "task-resume-candidate", "--json"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.jobId, codexJob.id);
  assert.equal(payload.threadId, codexJob.thread_id);
  assert.equal(payload.provider, "codex");
});

test("task-resume-candidate returns the latest rescue thread from the current session", (t) => {
  const repo = makeCommittedRepo(t);
  const binDir = makeTempDir(t);
  installFakeCodex(binDir);
  const current = run("node", [SCRIPT, "task", "investigate the flaky test"], {
    cwd: repo,
    env: { ...buildEnv(binDir), AGENT_PLUGIN_SESSION_ID: "sess-current" }
  });
  assert.equal(current.status, 0, current.stderr);
  const [currentJob] = storeFixtures.rawAll(resolveStateDir(repo), "SELECT id, thread_id FROM jobs");
  // A newer job of another session is not this session's candidate.
  const other = run("node", [SCRIPT, "task", "old rescue run"], {
    cwd: repo,
    env: { ...buildEnv(binDir), AGENT_PLUGIN_SESSION_ID: "sess-other" }
  });
  assert.equal(other.status, 0, other.stderr);

  const result = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: repo,
    env: { ...buildEnv(binDir), AGENT_PLUGIN_SESSION_ID: "sess-current" }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.jobId, currentJob.id);
  assert.equal(payload.threadId, currentJob.thread_id);
});

test("task --resume-last does not resume a task from another Claude session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const otherEnv = {
    ...buildEnv(binDir),
    AGENT_PLUGIN_SESSION_ID: "sess-other"
  };
  const currentEnv = {
    ...buildEnv(binDir),
    AGENT_PLUGIN_SESSION_ID: "sess-current"
  };

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: otherEnv
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const candidate = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).available, false);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /no job of this session can be continued/);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "initial task");
});

test("task --resume-last ignores running tasks from other Claude sessions", (t) => {
  const repo = makeCommittedRepo(t);
  const binDir = makeTempDir(t);
  installFakeCodex(binDir);
  const stateDir = resolveStateDir(repo);
  // A queued Codex job of another session, never launched.
  const db = storeLib.openStore(stateDir);
  t.after(() => db.close());
  storeState.createJob(db, {
    provider: "codex",
    kind: "task",
    title: "Codex Task",
    prompt: "Other session active task",
    request: { cwd: repo },
    cwd: repo,
    threadId: "thr_other",
    requester: { sessionId: "sess-other", leaderPid: null, leaderStartToken: null }
  });

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: { ...buildEnv(binDir), AGENT_PLUGIN_SESSION_ID: "sess-current" }
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /no job of this session can be continued/);
  assert.equal(storeFixtures.rawAll(stateDir, "SELECT id FROM jobs").length, 1);
});

test("session start hook exports the Claude session id, transcript path, and plugin data dir", () => {
  const repo = makeTempDir();
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "", "utf8");
  const pluginDataDir = makeTempDir();
  const transcriptPath = path.join(repo, "session.jsonl");

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PLUGIN_DATA: pluginDataDir
    },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-current",
      transcript_path: transcriptPath,
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(envFile, "utf8"),
    `export AGENT_PLUGIN_SESSION_ID='sess-current'\nexport AGENT_PLUGIN_TRANSCRIPT_PATH='${transcriptPath}'\nexport CLAUDE_PLUGIN_DATA='${pluginDataDir}'\n`
  );
});

test("write task output focuses on the Codex result without generic follow-up hints", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--write", "fix the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task --resume acts like --resume-last without leaking the flag into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--resume", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  // The follow-up reaches Codex as the first message of the continuing job, without the flag.
  assert.match(fakeState.lastTurnStart.prompt, /^\[message \d+\]\nfollow up$/);
});

test("task --fresh is treated as routing control and does not leak into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--fresh", "diagnose the flaky test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "diagnose the flaky test");
});

test("task forwards model selection and reasoning effort to app-server turn/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--model", "luna", "--effort", "low", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "gpt-5.6-luna");
  assert.equal(fakeState.lastTurnStart.effort, "low");
});

test("task logs reasoning summaries and assistant messages to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const log = readStoreJobLog(repo);
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Inspected the prompt, gathered evidence, and checked the highest-risk paths first/);
  assert.match(log, /Assistant message/);
  assert.match(log, /Handled the requested task/);
});

test("task logs subagent reasoning and messages with a subagent prefix", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const log = readStoreJobLog(repo);
  assert.match(log, /Starting subagent design-challenger via collaboration tool: wait\./);
  assert.match(log, /Subagent design-challenger reasoning:/);
  assert.match(log, /Questioned the retry strategy and the cache invalidation boundaries\./);
  assert.match(log, /Subagent design-challenger:/);
  assert.match(
    log,
    /The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees\./
  );
});

test("task waits for the main thread to complete before returning the final result", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task ignores later subagent messages when choosing the final returned output", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-late-subagent-message");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task can finish after subagent work even if the parent turn/completed event is missing", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent-no-main-turn-completed");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task on its own app server completes when Codex spawns subagents", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent", { recordIdentities: true });
  const exited = new Set();
  stopLeftoverProcesses(t, () => binDir, exited);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
  const pids = readAppServerPids(binDir);
  assert.ok(pids.length >= 1, "no app server was started");
  await waitForExit(pids, exited, "every app server to exit");
});

test("task --background enqueues a detached worker and exposes per-job status", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.ok(["queued", "running"].includes(launchPayload.status), launchPayload.status);
  assert.match(launchPayload.jobId, /^task-/);

  assert.equal(launchPayload.provider, "codex");
  const stateDir = resolveStateDir(repo);
  await storeFixtures.waitFor(() => storeFixtures.jobRow(stateDir, launchPayload.jobId)?.end_state === "completed", {
    timeoutMs: 30000,
    describe: "the background job's end"
  });
  assert.match(storeFixtures.jobRow(stateDir, launchPayload.jobId).result_text, /Handled the requested task/);
});

test("review with focus text runs a schema-bound peer review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review", "--scope working-tree focus on auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.ok(state.lastTurnStart.outputSchema?.properties?.verdict, "the turn carried no review schema");
  assert.match(state.lastTurnStart.prompt, /focus on auth/);
  assert.equal(state.lastReviewStart, undefined);
});

test("review rejects staged-only scope because it is native-review only", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("review --stance critical rejects staged-only scope to match review target selection", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "review", "--stance", "critical", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("review --background runs as a tracked background review job", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const launched = run("node", [SCRIPT, "review", "--background", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.ok(["queued", "running"].includes(launchPayload.status), launchPayload.status);
  assert.equal(launchPayload.provider, "codex");
  const stateDir = resolveStateDir(repo);
  await storeFixtures.waitFor(() => storeFixtures.jobRow(stateDir, launchPayload.jobId)?.end_state === "completed", {
    timeoutMs: 30000,
    describe: "the background review's end"
  });
  const row = storeFixtures.jobRow(stateDir, launchPayload.jobId);
  assert.equal(row.title, "Codex Review");
  assert.match(row.result_text, /No material issues found/);
});

test("result for a finished write-capable task returns the raw Codex final response", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const taskRun = run("node", [SCRIPT, "task", "--write", "fix the flaky integration test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskRun.status, 0, taskRun.stderr);

  const result = run("node", [NEUTRAL, "result"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Handled the requested task\.\nTask prompt accepted\.\n/);
  // The store result names the thread; it prints no resume command.
  assert.match(result.stdout, /Codex session ID: thr_[a-z0-9]+/i);
});

test("stop hook runs a stop-time review task and blocks on findings when the review gate is enabled", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);
  const setupPayload = JSON.parse(setup.stdout);
  assert.equal(setupPayload.reviewGateEnabled, true);

  const taskResult = run("node", [SCRIPT, "task", "--write", "fix the issue"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskResult.status, 0, taskResult.stderr);

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-stop-review",
      last_assistant_message: "I completed the refactor and updated the retry logic."
    })
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  const blockedPayload = JSON.parse(blocked.stdout);
  assert.equal(blockedPayload.decision, "block");
  assert.match(blockedPayload.reason, /Codex stop-time review found issues that still need fixes/i);
  assert.match(blockedPayload.reason, /Missing empty-state guard/i);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.match(fakeState.lastTurnStart.prompt, /<task>/i);
  assert.match(fakeState.lastTurnStart.prompt, /<compact_output_contract>/i);
  assert.match(fakeState.lastTurnStart.prompt, /Only review the work from the previous Claude turn/i);
  assert.match(fakeState.lastTurnStart.prompt, /I completed the refactor and updated the retry logic\./);

  const titles = storeFixtures.rawAll(resolveStateDir(repo), "SELECT title FROM jobs").map((row) => row.title);
  assert.ok(titles.includes("Codex stop-time review"), titles.join(", "));
});

test("stop hook logs running tasks to stderr without blocking when the review gate is disabled", (t) => {
  const repo = makeCommittedRepo(t);
  const jobId = seedQueuedCodexJob(repo, { sessionId: "sess-current" });

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      AGENT_PLUGIN_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.stdout.trim(), "");
  assert.ok(blocked.stderr.includes(`Codex job ${jobId} is still running`), blocked.stderr);
  assert.match(blocked.stderr, /\/agent:status/i);
  assert.ok(blocked.stderr.includes(`/agent:cancel ${jobId}`), blocked.stderr);
});

test("stop hook allows the stop when the review gate is enabled and the stop-time review task is clean", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "adversarial-clean");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo, session_id: "sess-stop-clean" })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
});

test("stop hook does not block when Codex is unavailable even if the review gate is enabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: ""
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
  assert.match(allowed.stderr, /Codex is not set up for the review gate/i);
  assert.match(allowed.stderr, /Run \/agent:codex-setup/i);
});

test("stop hook runs the actual task when auth status looks stale", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.doesNotMatch(allowed.stderr, /Codex is not set up for the review gate/i);
  const payload = JSON.parse(allowed.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /Missing empty-state guard/i);
});

test("each command starts its own app server and stops it", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, undefined, { recordIdentities: true });
  const exited = new Set();
  stopLeftoverProcesses(t, () => binDir, exited);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);
  // setup checks the login and reads the model catalog, and review reads the model catalog and
  // then runs a turn, each in an app server of its own; status reads only local job records.
  for (const [args, started] of [
    [["setup", "--json"], 2],
    [["review"], 2],
    [["status"], 0]
  ]) {
    const before = readAppServerPids(binDir);
    const result = run("node", [args[0] === "status" ? NEUTRAL : SCRIPT, ...args], { cwd: repo, env });
    assert.equal(result.status, 0, result.stderr);
    const after = readAppServerPids(binDir);
    assert.equal(after.length, before.length + started, `app servers started by ${args[0]}`);
    await waitForExit(after, exited, `every app server to exit after ${args[0]}`);
  }
});

test("setup and status read the workspace named by --cwd", async (t) => {
  const exited = new Set();
  let binDir = null;
  stopLeftoverProcesses(t, () => binDir, exited);
  const targetWorkspace = makeTempDir(t);
  const invocationWorkspace = makeTempDir(t);
  binDir = makeTempDir(t);
  installFakeCodex(binDir, undefined, { recordIdentities: true });
  const env = buildEnv(binDir);
  const targetJobId = seedQueuedCodexJob(targetWorkspace);

  const status = run("node", [NEUTRAL, "status", "--all", "--cwd", targetWorkspace, "--json"], { cwd: invocationWorkspace, env });
  assert.equal(status.status, 0, status.stderr);
  assert.ok(status.stdout.includes(targetJobId), status.stdout);
  const localStatus = run("node", [NEUTRAL, "status", "--all", "--json"], { cwd: invocationWorkspace, env });
  assert.equal(localStatus.status, 0, localStatus.stderr);
  assert.equal(localStatus.stdout.includes(targetJobId), false, localStatus.stdout);

  const enable = run("node", [SCRIPT, "setup", "--cwd", targetWorkspace, "--enable-review-gate", "--json"], {
    cwd: invocationWorkspace,
    env
  });
  assert.equal(enable.status, 0, enable.stderr);
  assert.equal(JSON.parse(enable.stdout).reviewGateEnabled, true);
  const localSetup = run("node", [SCRIPT, "setup", "--json"], { cwd: invocationWorkspace, env });
  assert.equal(localSetup.status, 0, localSetup.stderr);
  assert.equal(JSON.parse(localSetup.stdout).reviewGateEnabled, false);
  await waitForExit(readAppServerPids(binDir), exited, "the setup app servers to exit");
});

// Runs a foreground task with a reasoning effort, which makes the companion read the model list,
// and stops the companion after 20 s so a paging loop fails the test instead of hanging it.
function runTaskWithEffort(t, behavior, effort = "high") {
  const exited = new Set();
  let binDir = null;
  stopLeftoverProcesses(t, () => binDir, exited);
  const repo = makeCommittedRepo(t);
  binDir = makeTempDir(t);
  installFakeCodex(binDir, behavior, { recordIdentities: true });
  const result = spawnSync(process.execPath, [SCRIPT, "task", "--effort", effort, "check the cache"], {
    cwd: repo,
    env: buildEnv(binDir),
    encoding: "utf8",
    timeout: 20000,
    windowsHide: true
  });
  const statePath = path.join(binDir, "fake-codex-state.json");
  return { result, fakeState: JSON.parse(fs.readFileSync(statePath, "utf8")) };
}

test("a repeating model cursor does not loop", (t) => {
  const { result, fakeState } = runTaskWithEffort(t, "model-list-repeat-cursor");

  assert.equal(result.error?.code ?? null, null, "the model list kept paging");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fakeState.modelListPages, 2);
  assert.equal(fakeState.lastTurnStart.effort, "high");
});

test("an endless model cursor stops after 50 pages", (t) => {
  const { result, fakeState } = runTaskWithEffort(t, "model-list-endless-cursor");

  assert.equal(result.error?.code ?? null, null, "the model list kept paging");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fakeState.modelListPages, 50);
});

test("a model list that is not an array skips the effort check", (t) => {
  // The well-formed effort list of the default model does not contain xhigh, so only a skipped
  // check lets it through.
  const { result, fakeState } = runTaskWithEffort(t, "model-list-not-array", "xhigh");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fakeState.lastTurnStart.effort, "xhigh");
});

test("a foreign thread start is not counted as a subagent", (t) => {
  const repo = makeCommittedRepo(t);
  const binDir = makeTempDir(t);
  installFakeCodex(binDir, "foreign-thread-start");

  const result = run("node", [SCRIPT, "task", "--json", "check the cache"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.doesNotMatch(payload.rawOutput, /Answer from another session/);
  const log = readStoreJobLog(repo);
  assert.doesNotMatch(log, /other-session|Answer from another session|turn_foreign/);
});

test("a native review's job records its single-use thread as ephemeral", (t) => {
  const repo = makeCommittedRepo(t);
  const binDir = makeTempDir(t);
  installFakeCodex(binDir);
  const env = buildEnv(binDir);
  fs.writeFileSync(path.join(repo, "README.md"), "changed\n");

  const review = run("node", [SCRIPT, "review", "--json"], { cwd: repo, env });
  assert.equal(review.status, 0, review.stderr);
  const [job] = storeFixtures.rawAll(resolveStateDir(repo), "SELECT thread_id, ephemeral FROM jobs WHERE kind = 'review'");
  assert.ok(job?.thread_id, "the review recorded no thread");
  assert.equal(job.ephemeral, 1);
});

// The app server that exits after accepting the turn ends it; the one that stops reading before it
// answers the turn start leaves the request refused.
for (const [behavior, name, failure] of [
  ["exit-mid-turn", "a task whose app server dies mid-turn fails within 30 seconds", /the provider exited before the turn ended/],
  ["close-stdin-on-turn", "a task whose app server closes its input fails the job", /the provider rejected the request/]
]) {
  test(name, (t) => {
    const exited = new Set();
    let binDir = null;
    stopLeftoverProcesses(t, () => binDir, exited);
    const repo = makeCommittedRepo(t);
    binDir = makeTempDir(t);
    installFakeCodex(binDir, behavior, { recordIdentities: true });

    const result = spawnSync(process.execPath, [SCRIPT, "task", "check the cache"], {
      cwd: repo,
      env: buildEnv(binDir),
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true
    });

    assert.equal(result.error?.code ?? null, null, "the task did not end within 30 s");
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, failure);
    assert.doesNotMatch(result.stderr, /Unhandled 'error' event/);
    const [job] = storeFixtures.rawAll(resolveStateDir(repo), "SELECT end_state FROM jobs");
    assert.equal(job.end_state, "failed");
  });
}

// ---------------------------------------------------------------------------------------------
// Codex jobs on the job store: the worker, its driver and its own app server

const STORE_REQUESTER = { sessionId: "session-codex", leaderPid: null, leaderStartToken: null };
// Cleanup contracts for the fake Codex on this platform, so a worker that saw its app server end
// or stopped it releases confirmed. They include own-exit because on Windows the fake runs behind
// a codex.cmd wrapper: a tree stop kills the fake first, and the wrapper can then exit before the
// stop command reaches it, which the worker can only count as the root's own exit. The contract
// tests of the stop path set their own contracts.
const FAKE_CODEX_CONTRACTS = JSON.stringify(
  ["tree-stop", "owner-death", "own-exit"].map((trigger) => ({ provider: "codex", platform: process.platform, trigger, version: "0.0.0", windowMs: 0 }))
);

// Sets a process environment variable for the rest of the test.
function setEnvFor(t, name, value) {
  const saved = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (saved === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = saved;
    }
  });
}

// A fresh store and a fake Codex on PATH for every worker this test starts or launches. Every app
// server the fake starts and every worker the store records are stopped when the test ends.
// With `contracts: "descriptor"` the Codex descriptor's own cleanup contracts apply.
async function codexStore(t, behavior = "review-ok", { contracts = FAKE_CODEX_CONTRACTS } = {}) {
  const exited = new Set();
  let binDir = null;
  stopLeftoverProcesses(t, () => binDir, exited);
  // The children a fake app server started and recorded are stopped by their identities too.
  t.after(() => {
    const file = binDir ? path.join(binDir, "fake-codex-state.json") : null;
    const identities = file && fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")).processIdentities ?? []) : [];
    return stopOwnedProcesses(identities.filter((entry) => entry.key !== "appServerPids").map(({ pid, startToken }) => ({ pid, startToken })));
  });
  binDir = makeTempDir(t);
  installFakeCodex(binDir, behavior, { recordIdentities: true, version: "0.169.0" });
  setEnvFor(t, "PATH", buildEnv(binDir).PATH);
  if (contracts === "descriptor") {
    const saved = process.env.AGENT_PLUGIN_TEST_CONTRACTS;
    delete process.env.AGENT_PLUGIN_TEST_CONTRACTS;
    t.after(() => {
      if (saved !== undefined) {
        process.env.AGENT_PLUGIN_TEST_CONTRACTS = saved;
      }
    });
  } else {
    setEnvFor(t, "AGENT_PLUGIN_TEST_CONTRACTS", contracts);
  }
  const stateDir = storeFixtures.makeStoreDir(t);
  const db = storeLib.openStore(stateDir);
  t.after(() => db.close());
  const workers = storeFixtures.trackProcesses(t);
  const cwd = makeTempDir(t);
  const createCodexJob = (prompt, extra = {}) =>
    storeState.createJob(db, {
      provider: "codex",
      kind: "task",
      title: prompt.slice(0, 40),
      prompt,
      request: { cwd, ...(extra.request ?? {}) },
      cwd,
      threadId: extra.threadId ?? null,
      ephemeral: extra.ephemeral ?? false,
      allowQuestions: extra.allowQuestions ?? false,
      requester: STORE_REQUESTER
    }).jobId;
  // Starts `codex-companion.mjs worker` for a job directly, held by this test.
  const startWorker = (jobId, env = {}) => {
    const child = spawn(process.execPath, [SCRIPT, "worker", "--state-dir", stateDir, "--job", jobId], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    });
    workers.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const exit = new Promise((resolve) => child.on("close", (code) => resolve({ code, stderr })));
    return { child, exit };
  };
  // Records the worker a launch started, so it is stopped by its identity if it outlives the test.
  const trackLaunched = (jobId) => {
    const identity = storeFixtures.workerIdentity(stateDir, jobId);
    if (identity) {
      workers.push(identity);
    }
  };
  const readFake = () => {
    const file = path.join(binDir, "fake-codex-state.json");
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  };
  return { stateDir, db, cwd, binDir, createCodexJob, startWorker, trackLaunched, readFake };
}

// Waits for a worker's exit; after `timeoutMs` fails with the job's row and log instead of
// waiting on.
async function waitWorkerExit(store, jobId, worker, timeoutMs = 60000) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve("late"), timeoutMs);
  });
  const outcome = await Promise.race([worker.exit.then(() => "exited"), late]);
  clearTimeout(timer);
  if (outcome === "late") {
    const logFile = path.join(store.stateDir, "store", "artifacts", `${jobId}.log`);
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "(no log)";
    throw new Error(`the worker of ${jobId} did not exit within ${timeoutMs} ms; row ${JSON.stringify(storeFixtures.jobRow(store.stateDir, jobId))}; log ${log.slice(-3000)}`);
  }
}

// Waits until a job's execution is released, recording its worker while it runs. A release the
// worker left to reconciliation (on Windows its tree stop can find the wrapper's root already gone)
// is completed by a scan once the job ended and its worker exited, as the next command's scan
// would; the scan launches nothing.
async function waitReleased(store, jobId, timeoutMs = 60000) {
  let lastScan = performance.now();
  let scanning = false;
  try {
    await storeFixtures.waitFor(
      () => {
        store.trackLaunched(jobId);
        const row = storeFixtures.jobRow(store.stateDir, jobId);
        if (row?.exec_released_at !== null) {
          return true;
        }
        const workerGone = row?.end_state !== null && row?.worker_pid !== null && !isProcessAlive(row.worker_pid);
        if (workerGone && !scanning && performance.now() - lastScan > 2000) {
          scanning = true;
          storeState
            .scanWorkspace(store.db, { deadline: performance.now() + 10000, launch: async () => null, leaderCheck: async (views) => new Map(views.map((view) => [view.id, "none"])) })
            .catch(() => {})
            .finally(() => {
              scanning = false;
              lastScan = performance.now();
            });
        }
        return false;
      },
      { timeoutMs, describe: `the release of ${jobId}` }
    );
  } catch (error) {
    const row = storeFixtures.jobRow(store.stateDir, jobId);
    const logFile = path.join(store.stateDir, "store", "artifacts", `${jobId}.log`);
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "(no log)";
    const fields = row ? { end_state: row.end_state, end_reason: row.end_reason, stopping_cause: row.stopping_cause, claimed_at: row.claimed_at, provider_pid: row.provider_pid, last_refusal: row.last_refusal, error: row.error } : null;
    throw new Error(`${error.message}; row ${JSON.stringify(fields)}; log ${log.slice(-1500)}`);
  }
  return storeFixtures.jobRow(store.stateDir, jobId);
}

test("a job launched twice on the fake Codex sends one turn/start", { timeout: 300000 }, async (t) => {
  const store = await codexStore(t);
  for (let batch = 0; batch < 4; batch += 1) {
    const jobIds = Array.from({ length: 5 }, (_, index) => store.createCodexJob(`launch twice ${batch}-${index}`));
    await Promise.all(
      jobIds.map(async (jobId) => {
        // One launch through the store's launcher and one worker started directly race to claim.
        const direct = store.startWorker(jobId);
        await launchWorker(store.db, store.stateDir, jobId);
        await direct.exit;
        await waitReleased(store, jobId);
      })
    );
    for (const [index, jobId] of jobIds.entries()) {
      const starts = store.readFake().turnStarts.filter((entry) => entry.prompt.includes(`launch twice ${batch}-${index}`));
      assert.equal(starts.length, 1, `${jobId} sent ${starts.length} turn/start requests`);
      assert.equal(storeFixtures.jobRow(store.stateDir, jobId).end_state, "completed");
    }
  }
});

test("a crash between claim and start replays the stored prompt to Codex", { timeout: 120000 }, async (t) => {
  const store = await codexStore(t);
  const jobId = store.createCodexJob("replay this stored prompt");
  const pointsDir = makeTempDir(t);
  const worker = store.startWorker(jobId, { AGENT_PLUGIN_TEST_POINTS: "after-claim", AGENT_PLUGIN_TEST_POINTS_DIR: pointsDir });
  await storeFixtures.waitFor(() => fs.readdirSync(pointsDir).some((name) => name.startsWith("after-claim-")), { describe: "the claim" });
  await stopOwnedProcess(worker.child);
  await worker.exit;
  assert.equal(store.readFake().turnStarts?.length ?? 0, 0);
  await storeState.scanWorkspace(store.db, { deadline: performance.now() + 30000, launch: async () => null, leaderCheck: async () => new Map() });
  const ended = storeFixtures.jobRow(store.stateDir, jobId);
  assert.equal(ended.end_state, "interrupted");
  assert.equal(ended.resume_method, "stored-prompt");
  const { successorId } = storeState.decideNext(store.db, { ref: jobId, observedTipId: jobId }, { action: "continue", requester: STORE_REQUESTER });
  await launchWorker(store.db, store.stateDir, successorId);
  await waitReleased(store, successorId);
  const starts = store.readFake().turnStarts;
  assert.equal(starts.length, 1);
  assert.match(starts[0].prompt, /replay this stored prompt/);
});

test("a turn end racing a stop never loses the Codex output", { timeout: 300000 }, async (t) => {
  const store = await codexStore(t, "slow-task");
  for (let repetition = 0; repetition < 20; repetition += 1) {
    const jobId = store.createCodexJob(`race the stop ${repetition}`);
    const worker = store.startWorker(jobId);
    await storeFixtures.waitFor(() => storeFixtures.jobRow(store.stateDir, jobId).started_at !== null, { describe: "the turn start" });
    // The fake ends the turn 400 ms after turn/start; the stop lands around that moment.
    await new Promise((resolve) => setTimeout(resolve, 300 + (repetition % 5) * 50));
    storeState.requestStop(store.db, { jobIds: [jobId] }, { reason: "session-end" });
    await worker.exit;
    const row = await waitReleased(store, jobId);
    assert.notEqual(row.result_text, null, `repetition ${repetition}: the Codex output was lost (${row.end_state})`);
  }
});

test("no transaction is open at any Codex request", { timeout: 120000 }, async (t) => {
  const store = await codexStore(t);
  const jobId = store.createCodexJob("watch the transactions");
  const logFile = path.join(makeTempDir(t), "txn.log");
  const worker = store.startWorker(jobId, { AGENT_PLUGIN_TEST_TXN_LOG: logFile });
  const exit = await worker.exit;
  assert.equal(exit.code, 0, exit.stderr);
  const requests = fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter((line) => line.startsWith("provider-request"));
  assert.ok(requests.length >= 3, `only ${requests.length} Codex requests were logged`);
  assert.deepEqual(requests.filter((line) => line !== "provider-request 0"), [], "a Codex request was sent inside a transaction");
});

// The job that continues `jobId`, or null.
function successorOf(store, jobId) {
  return storeFixtures.rawAll(store.stateDir, "SELECT id FROM jobs WHERE continues = ?", [jobId])[0]?.id ?? null;
}

// Runs one scan that launches what it continues or finds eligible, with every leader absent.
function scanAndLaunch(store) {
  return storeState.scanWorkspace(store.db, {
    deadline: performance.now() + 30000,
    launch: (id) => launchWorker(store.db, store.stateDir, id),
    leaderCheck: async (views) => new Map(views.map((view) => [view.id, "none"]))
  });
}

test("a steered message is confirmed by its clientId and carries its message line", { timeout: 120000 }, async (t) => {
  const store = await codexStore(t, "interruptible-slow-task");
  const jobId = store.createCodexJob("work while a message arrives");
  const worker = store.startWorker(jobId);
  await storeFixtures.waitFor(() => storeFixtures.jobRow(store.stateDir, jobId).started_at !== null, { describe: "the turn start" });
  const sent = mailbox.sendToChain(store.db, { ref: jobId, observedTipId: jobId }, { text: "steer this in", requester: STORE_REQUESTER });
  assert.equal(sent.outcome, "running");
  await storeFixtures.waitFor(() => mailbox.readMessageOutcome(store.db, sent.messageId).state === "consumed", { describe: "the steered message's receipt" });
  const outcome = mailbox.readMessageOutcome(store.db, sent.messageId);
  assert.equal(outcome.consumedJobId, jobId);
  const steers = store.readFake().steers;
  assert.equal(steers.length, 1);
  assert.equal(steers[0].clientUserMessageId, mailbox.messageClientId(store.db.instanceId, sent.messageId));
  assert.match(steers[0].text, new RegExp(`^\\[message ${sent.messageId}\\]`));
  assert.match(steers[0].text, /steer this in/);
  await worker.exit;
  await waitReleased(store, jobId);
});

test("a steer racing the end notification is not sent and the successor delivers it", { timeout: 600000 }, async (t) => {
  const store = await codexStore(t, "steer-turn-ended");
  for (let batch = 0; batch < 4; batch += 1) {
    const jobIds = Array.from({ length: 5 }, (_, index) => store.createCodexJob(`end before the steer ${batch}-${index}`));
    await Promise.all(
      jobIds.map(async (jobId) => {
        const worker = store.startWorker(jobId);
        await storeFixtures.waitFor(() => storeFixtures.jobRow(store.stateDir, jobId).started_at !== null, { describe: "the turn start" });
        const sent = mailbox.sendToChain(store.db, { ref: jobId, observedTipId: jobId }, { text: `deliver after ${jobId}`, requester: STORE_REQUESTER });
        // The fake answers every steer as if the turn had just ended.
        await storeFixtures.waitFor(() => (store.readFake().steerAttempts ?? 0) > 0 && mailbox.readMessageOutcome(store.db, sent.messageId).state !== "pending", {
          describe: "the steer attempt"
        });
        await waitWorkerExit(store, jobId, worker);
        await waitReleased(store, jobId);
        if (!successorOf(store, jobId)) {
          await scanAndLaunch(store);
        }
        const successorId = successorOf(store, jobId);
        assert.ok(successorId, `no successor continued ${jobId}`);
        await storeFixtures.waitFor(() => storeFixtures.jobRow(store.stateDir, successorId).claimed_at !== null || (scanAndLaunch(store), false), {
          timeoutMs: 30000,
          describe: `the successor of ${jobId} starting`
        });
        await waitReleased(store, successorId);
        const outcome = mailbox.readMessageOutcome(store.db, sent.messageId);
        assert.equal(outcome.state, "consumed", `${jobId}: the message ended ${outcome.state}`);
        assert.equal(outcome.consumedJobId, successorId);
      })
    );
  }
  // No steer was accepted, and each message reached Codex once, as a successor's request.
  const fake = store.readFake();
  assert.equal((fake.steers ?? []).length, 0);
  const delivered = fake.turnStarts.filter((entry) => /^\[message \d+\]/.test(entry.prompt));
  assert.equal(delivered.length, 20);
});

test("a message survives a worker stopped before the steer returns", { timeout: 180000 }, async (t) => {
  const store = await codexStore(t, "interruptible-slow-task");
  const jobId = store.createCodexJob("work until the worker is stopped");
  const pointsDir = makeTempDir(t);
  // The first after-dispatch is the job's own request; the second is the steer's.
  const worker = store.startWorker(jobId, { AGENT_PLUGIN_TEST_POINTS: "after-dispatch#2", AGENT_PLUGIN_TEST_POINTS_DIR: pointsDir });
  await storeFixtures.waitFor(() => storeFixtures.jobRow(store.stateDir, jobId).started_at !== null, { describe: "the turn start" });
  const sent = mailbox.sendToChain(store.db, { ref: jobId, observedTipId: jobId }, { text: "survive the stop", requester: STORE_REQUESTER });
  await storeFixtures.waitFor(() => fs.readdirSync(pointsDir).some((name) => name.startsWith("after-dispatch-")), { describe: "the steer's dispatch" });
  const providers = storeFixtures.providerIdentities(store.stateDir, jobId);
  await stopOwnedProcess(worker.child);
  await worker.exit;
  assert.equal(mailbox.readMessageOutcome(store.db, sent.messageId).state, "dispatched");
  assert.equal((store.readFake().steers ?? []).length, 0, "the steer reached Codex");
  // The scanner cleans up the dead worker; the message is kept for the next request.
  for (let scan = 0; scan < 20 && storeFixtures.jobRow(store.stateDir, jobId).exec_released_at === null; scan += 1) {
    await storeState.scanWorkspace(store.db, { deadline: performance.now() + 30000, launch: async () => null, leaderCheck: async () => new Map() });
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await stopOwnedProcesses(providers, { tree: true });
  assert.notEqual(storeFixtures.jobRow(store.stateDir, jobId).exec_released_at, null);
  assert.equal(mailbox.readMessageOutcome(store.db, sent.messageId).state, "dispatched");
  const { successorId } = storeState.decideNext(store.db, { ref: jobId, observedTipId: jobId }, { action: "continue", requester: STORE_REQUESTER });
  await launchWorker(store.db, store.stateDir, successorId);
  await waitReleased(store, successorId);
  const outcome = mailbox.readMessageOutcome(store.db, sent.messageId);
  assert.equal(outcome.state, "consumed");
  assert.equal(outcome.consumedJobId, successorId);
  const resent = store.readFake().turnStarts.find((entry) => entry.prompt.includes("survive the stop"));
  assert.ok(resent, "the successor did not send the message");
  assert.match(resent.prompt, new RegExp(`^\\[message ${sent.messageId}\\]`));
});

// Runs a first job to its release, so its Codex thread exists, then continues it with a message;
// returns the first job, the message and the continuation (created, not launched).
async function firstTurnThenMessage(store, prompt, text) {
  const firstId = store.createCodexJob(prompt);
  await launchWorker(store.db, store.stateDir, firstId);
  await waitReleased(store, firstId);
  const sent = mailbox.sendToChain(store.db, { ref: firstId, observedTipId: firstId }, { text, requester: STORE_REQUESTER });
  let successorId = sent.outcome === "continued" ? sent.jobId : successorOf(store, firstId);
  if (!successorId) {
    successorId = storeState.decideNext(store.db, { ref: firstId, observedTipId: firstId }, { action: "continue", requester: STORE_REQUESTER }).successorId;
  }
  return { firstId, messageId: sent.messageId, successorId };
}

// Starts a worker for `jobId` that stops at `point`, then stops it there by its held handle.
async function crashAtPoint(t, store, jobId, point) {
  const pointsDir = makeTempDir(t);
  const worker = store.startWorker(jobId, { AGENT_PLUGIN_TEST_POINTS: point, AGENT_PLUGIN_TEST_POINTS_DIR: pointsDir });
  await storeFixtures.waitFor(() => fs.readdirSync(pointsDir).some((name) => name.startsWith(`${point.split("#")[0]}-`)), { describe: `the point ${point}` });
  const providers = storeFixtures.providerIdentities(store.stateDir, jobId);
  await stopOwnedProcess(worker.child);
  await worker.exit;
  for (let scan = 0; scan < 20 && storeFixtures.jobRow(store.stateDir, jobId).exec_released_at === null; scan += 1) {
    await storeState.scanWorkspace(store.db, { deadline: performance.now() + 30000, launch: async () => null, leaderCheck: async () => new Map() });
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await stopOwnedProcesses(providers, { tree: true });
  assert.notEqual(storeFixtures.jobRow(store.stateDir, jobId).exec_released_at, null, `${jobId} was not released after its worker stopped`);
}

// Continues a released job and runs the continuation to its release; returns its id.
async function continueAndRun(store, jobId) {
  const { successorId } = storeState.decideNext(store.db, { ref: jobId, observedTipId: jobId }, { action: "continue", requester: STORE_REQUESTER });
  await launchWorker(store.db, store.stateDir, successorId);
  await waitReleased(store, successorId);
  return successorId;
}

test("a dispatched message on the history's second page is not resent", { timeout: 180000 }, async (t) => {
  const store = await codexStore(t, "history-pages");
  const { messageId, successorId } = await firstTurnThenMessage(store, "first turn of the paged thread", "delivered on page two");
  // The continuation sends the message, then stops before it handles the receipt.
  await crashAtPoint(t, store, successorId, "after-write");
  assert.equal(mailbox.readMessageOutcome(store.db, messageId).state, "dispatched");
  const thirdId = await continueAndRun(store, successorId);
  const outcome = mailbox.readMessageOutcome(store.db, messageId);
  assert.equal(outcome.state, "consumed");
  const fake = store.readFake();
  assert.equal(fake.turnStarts.filter((entry) => entry.prompt.includes("delivered on page two")).length, 1, "the delivered message was sent again");
  assert.ok(fake.historyPagesServed >= 2, `the history was read through ${fake.historyPagesServed} pages`);
  assert.equal(storeFixtures.jobRow(store.stateDir, thirdId).end_state, "completed");
});

test("after a crash around dispatch the history decides between consumed and resent", { timeout: 240000 }, async (t) => {
  const store = await codexStore(t);
  // Stopped after the dispatch commit and before the request: the message never reached Codex.
  const beforeWrite = await firstTurnThenMessage(store, "first turn, crash before the write", "never written");
  await crashAtPoint(t, store, beforeWrite.successorId, "after-dispatch");
  // Stopped after the request was written: Codex has the message in its history.
  const afterWrite = await firstTurnThenMessage(store, "first turn, crash after the write", "already written");
  await crashAtPoint(t, store, afterWrite.successorId, "after-write");
  await continueAndRun(store, beforeWrite.successorId);
  await continueAndRun(store, afterWrite.successorId);
  const starts = store.readFake().turnStarts;
  const neverWritten = starts.filter((entry) => entry.prompt.includes("never written"));
  assert.equal(neverWritten.length, 1, "the message that never reached Codex was not sent exactly once");
  assert.match(neverWritten[0].prompt, new RegExp(`^\\[message ${beforeWrite.messageId}\\]`));
  assert.equal(starts.filter((entry) => entry.prompt.includes("already written")).length, 1, "the message Codex already had was sent again");
  assert.equal(mailbox.readMessageOutcome(store.db, beforeWrite.messageId).state, "consumed");
  assert.equal(mailbox.readMessageOutcome(store.db, afterWrite.messageId).state, "consumed");
});

test("a continuation interrupts a turn still in progress and fails if it does not end in 10 s", { timeout: 240000 }, async (t) => {
  // The previous turn ends on its interrupt: the continuation runs its own turn.
  {
    const store = await codexStore(t, "turn-in-progress");
    const firstId = store.createCodexJob("leave a turn running");
    await launchWorker(store.db, store.stateDir, firstId);
    await waitReleased(store, firstId);
    const continuedId = await continueAndRun(store, firstId);
    assert.equal(storeFixtures.jobRow(store.stateDir, continuedId).end_state, "completed");
    assert.deepEqual(store.readFake().lastInterrupt, { threadId: storeFixtures.jobRow(store.stateDir, continuedId).thread_id, turnId: "turn-prev" });
  }
  // The previous turn never ends: the continuation fails after 10 seconds and sends no turn.
  {
    const store = await codexStore(t, "turn-in-progress-stuck");
    const firstId = store.createCodexJob("leave a turn stuck");
    await launchWorker(store.db, store.stateDir, firstId);
    await waitReleased(store, firstId);
    const startsBefore = store.readFake().turnStarts.length;
    const started = Date.now();
    const continuedId = await continueAndRun(store, firstId);
    const row = storeFixtures.jobRow(store.stateDir, continuedId);
    assert.equal(row.end_state, "failed");
    assert.match(row.error ?? "", /previous turn on this thread did not end/);
    assert.ok(Date.now() - started >= 10000, `the continuation failed after ${Date.now() - started} ms`);
    assert.equal(store.readFake().turnStarts.length, startsBefore, "the continuation sent a turn");
  }
});

// Whether every process the fake recorded under `key` is gone.
async function recordedAbsent(store, key) {
  const { readProcessIdentities } = await import("../plugins/agent/scripts/lib/process.mjs");
  const recorded = (store.readFake().processIdentities ?? []).filter((entry) => entry.key === key);
  const identities = await readProcessIdentities(recorded.map((entry) => entry.pid), { deadline: performance.now() + 15000 });
  return recorded.every((entry) => identities.get(entry.pid)?.state !== "present" || identities.get(entry.pid)?.startToken !== entry.startToken);
}

test("a provider that ignores interrupt and end-of-file is stopped by identity before cancelled", { timeout: 120000 }, async (t) => {
  const store = await codexStore(t, "interrupt-ignored-eof");
  const jobId = store.createCodexJob("ignore every polite stop");
  const worker = store.startWorker(jobId);
  await storeFixtures.waitFor(() => storeFixtures.jobRow(store.stateDir, jobId).started_at !== null, { describe: "the turn start" });
  await storeFixtures.waitFor(() => (store.readFake().processIdentities ?? []).some((entry) => entry.key === "childPids"), { describe: "the app server's child" });
  storeState.requestStop(store.db, { jobIds: [jobId] }, { reason: "cancel", cancel: true });
  const exit = await worker.exit;
  assert.equal(exit.code, 0, exit.stderr);
  const row = await waitReleased(store, jobId);
  assert.equal(row.end_state, "cancelled");
  assert.equal(store.readFake().lastInterrupt?.turnId, row.turn_id, "the turn was not interrupted first");
  assert.equal(await recordedAbsent(store, "appServerPids"), true, "the app server outlived the cancel");
  assert.equal(await recordedAbsent(store, "childPids"), true, "the app server's child outlived the cancel");
});

test("a Codex job stopped in its first turn is resumable", { timeout: 120000 }, async (t) => {
  const store = await codexStore(t, "interruptible-slow-task");
  const jobId = store.createCodexJob("stop me in my first turn");
  const worker = store.startWorker(jobId);
  await storeFixtures.waitFor(() => storeFixtures.jobRow(store.stateDir, jobId).started_at !== null, { describe: "the turn start" });
  storeState.requestStop(store.db, { jobIds: [jobId] }, { reason: "session-end" });
  await worker.exit;
  const row = await waitReleased(store, jobId);
  assert.equal(row.end_state, "interrupted");
  assert.notEqual(row.thread_id, null);
  assert.equal(storeState.readJobView(store.db, jobId).resumable, true);
  const continuedId = await continueAndRun(store, jobId);
  const continued = storeFixtures.jobRow(store.stateDir, continuedId);
  assert.equal(continued.thread_id, row.thread_id);
  assert.equal(store.readFake().lastThreadResume?.threadId, row.thread_id);
});

test("owner death after turn/start acceptance releases before resume", { timeout: 120000 }, async (t) => {
  const store = await codexStore(t, "interruptible-slow-task");
  const jobId = store.createCodexJob("lose my worker after acceptance");
  await crashAtPoint(t, store, jobId, "after-submit-accepted");
  const row = storeFixtures.jobRow(store.stateDir, jobId);
  assert.equal(row.end_state, "interrupted");
  assert.equal(row.end_reason, "worker-dead");
  assert.equal(row.active_thread_key, null);
  const continuedId = await continueAndRun(store, jobId);
  assert.equal(storeFixtures.jobRow(store.stateDir, continuedId).thread_id, row.thread_id);
});

test("an absent Codex root is not confirmation without closure", async (t) => {
  const saved = process.env.AGENT_PLUGIN_TEST_CONTRACTS;
  delete process.env.AGENT_PLUGIN_TEST_CONTRACTS;
  t.after(() => {
    if (saved !== undefined) {
      process.env.AGENT_PLUGIN_TEST_CONTRACTS = saved;
    }
  });
  const contracts = storeState.cleanupContracts("codex");
  assert.deepEqual(contracts.map((entry) => `${entry.platform} ${entry.trigger} ${entry.version} ${entry.windowMs}`), ["win32 owner-death 0.169.0 1000", "win32 tree-stop 0.169.0 1000"]);
  const T = 5_000_000;
  const evidence = (fields) => ({
    platform: "win32",
    provider: "codex",
    providerVersion: "0.169.0",
    rootRecorded: true,
    root: "absent",
    rootExitSeenAt: null,
    group: null,
    trigger: null,
    graceStartedAt: T,
    graceMs: 60000,
    contracts,
    ...fields
  });
  // A: the root ended by itself, and Codex has no own-exit contract.
  assert.equal(storeState.decideRelease(evidence({ rootExitSeenAt: T, trigger: { kind: "own-exit", at: T } }), { now: T + 5000 }).kind, "wait");
  // B: owner death on a Codex older than the validated version.
  assert.equal(storeState.decideRelease(evidence({ providerVersion: "0.168.9", trigger: { kind: "owner-death", at: T } }), { now: T + 5000 }).kind, "wait");
  // D: Linux, the root is gone but its process group still has a member.
  assert.equal(storeState.decideRelease(evidence({ platform: "linux", group: false, trigger: { kind: "owner-death", at: T } }), { now: T + 5000 }).kind, "wait");
  // Each of them is released unobserved once the grace window has passed.
  assert.equal(storeState.decideRelease(evidence({ rootExitSeenAt: T, trigger: { kind: "own-exit", at: T } }), { now: T + 60000 }).kind, "unobserved");
  // The validated owner-death contract confirms once its window has passed.
  assert.equal(storeState.decideRelease(evidence({ trigger: { kind: "owner-death", at: T } }), { now: T + 1000 }).kind, "confirmed");
});

test("owner death before the child is recorded on the fake Codex", { timeout: 120000 }, async (t) => {
  const store = await codexStore(t, "interruptible-slow-task");
  setEnvFor(t, "AGENT_PLUGIN_GRACE_MS", "1500");
  const jobId = store.createCodexJob("lose my worker before the app server is recorded", { threadId: "th-unrecorded-codex" });
  const pointsDir = makeTempDir(t);
  const worker = store.startWorker(jobId, { AGENT_PLUGIN_TEST_POINTS: "after-spawn", AGENT_PLUGIN_TEST_POINTS_DIR: pointsDir });
  await storeFixtures.waitFor(() => fs.readdirSync(pointsDir).some((name) => name.startsWith("after-spawn-")), { describe: "the spawn point" });
  await stopOwnedProcess(worker.child);
  await worker.exit;
  assert.equal(storeFixtures.jobRow(store.stateDir, jobId).provider_pid, null);
  const scan = () => storeState.scanWorkspace(store.db, { deadline: performance.now() + 30000, launch: async () => null, leaderCheck: async () => new Map() });
  await scan();
  const marked = storeFixtures.jobRow(store.stateDir, jobId);
  assert.equal(marked.stopping_cause, "unrecorded-child");
  assert.equal(marked.exec_released_at, null);
  await new Promise((resolve) => setTimeout(resolve, 1700));
  await scan();
  const released = storeFixtures.jobRow(store.stateDir, jobId);
  assert.equal(released.release_kind, "unobserved");
  assert.deepEqual(storeFixtures.rawAll(store.stateDir, "SELECT thread_id FROM thread_barriers").map((barrier) => barrier.thread_id), ["th-unrecorded-codex"]);
});

test("the contract summary shows the validated and installed versions", async () => {
  const { codexProvider } = await import("../plugins/agent/scripts/providers/codex/index.mjs");
  assert.equal(codexProvider.validatedVersion, "0.169.0");
  const lines = codexProvider.contractSummary("0.170.2");
  assert.match(lines[0], /validated on Codex 0\.169\.0, installed 0\.170\.2/);
  assert.ok(lines.some((line) => /win32 owner-death: every Codex process ends within 1000 ms/.test(line)));
  assert.ok(lines.some((line) => /win32 tree-stop: every Codex process ends within 1000 ms/.test(line)));
  assert.ok(!lines.some((line) => /stdin/.test(line)), "the end of input is listed as a contract");
  assert.match(codexProvider.contractSummary(null)[0], /installed unknown/);
});

// Runs one seeded Codex job with a worker started directly and returns its row once released.
async function runSeededJob(store, prompt, extra = {}) {
  const jobId = store.createCodexJob(prompt, extra);
  if (extra.beforeStart) {
    extra.beforeStart(jobId);
  }
  const exit = await store.startWorker(jobId).exit;
  assert.equal(exit.code, 0, exit.stderr);
  return waitReleased(store, jobId);
}

function eventKinds(store, jobId) {
  return storeFixtures.rawAll(store.stateDir, "SELECT kind FROM events WHERE job_id = ?", [jobId]).map((event) => event.kind);
}

const QUESTION_SCHEMA = { type: "object", properties: { result: { type: "string" }, question: { type: "string" } }, required: ["result"] };

test("a delegate question makes the Codex job waiting with one waiting event", { timeout: 120000 }, async (t) => {
  const store = await codexStore(t, "question-line");
  const row = await runSeededJob(store, "ask me if you must", { allowQuestions: true });
  assert.equal(row.end_state, "waiting");
  assert.equal(row.question, "Which file should change?");
  assert.deepEqual(eventKinds(store, row.id), ["waiting"]);
});

test("a non-empty structured question makes the job waiting and an empty one is stripped", { timeout: 120000 }, async (t) => {
  {
    const store = await codexStore(t, "structured-question");
    const row = await runSeededJob(store, "answer in the schema", { allowQuestions: true, request: { outputSchema: QUESTION_SCHEMA } });
    assert.equal(row.end_state, "waiting");
    assert.equal(row.question, "Keep the old API?");
  }
  {
    const store = await codexStore(t, "structured-empty-question");
    const row = await runSeededJob(store, "answer in the schema", { allowQuestions: true, request: { outputSchema: QUESTION_SCHEMA } });
    assert.equal(row.end_state, "completed");
    assert.equal(row.question, null);
    assert.deepEqual(JSON.parse(row.result_json), { result: "all done" });
  }
});

test("a seeded job without allow_questions completes despite a question line", { timeout: 120000 }, async (t) => {
  const store = await codexStore(t, "question-line");
  const row = await runSeededJob(store, "do not ask", { allowQuestions: false });
  assert.equal(row.end_state, "completed");
  assert.equal(row.question, null);
  assert.match(row.result_text, /AGENT-QUESTION: Which file should change\?/);
  const sent = store.readFake().turnStarts.at(-1).prompt;
  assert.equal(sent, "do not ask", "the prompt of a job without allow_questions was changed");
});

test("Codex results and the question request at their caps", { timeout: 240000 }, async (t) => {
  {
    const store = await codexStore(t, "huge-answer");
    const row = await runSeededJob(store, "write too much");
    assert.equal(row.end_state, "completed");
    assert.equal(row.result_truncated, 1);
    assert.ok(Buffer.byteLength(row.result_text, "utf8") <= 1048576, `result_text holds ${Buffer.byteLength(row.result_text, "utf8")} bytes`);
  }
  {
    const store = await codexStore(t, "huge-json");
    const row = await runSeededJob(store, "answer too much in the schema", { request: { outputSchema: QUESTION_SCHEMA } });
    assert.equal(row.end_state, "completed");
    assert.equal(row.result_json, null);
    assert.equal(row.result_json_too_large, 1);
  }
  {
    // A log that cannot be written leaves the result in the store.
    const store = await codexStore(t);
    const row = await runSeededJob(store, "log nowhere", {
      beforeStart: (jobId) => fs.mkdirSync(path.join(store.stateDir, "store", "artifacts", `${jobId}.log`), { recursive: true })
    });
    assert.equal(row.end_state, "completed");
    assert.equal(row.result_logged, 0);
    assert.notEqual(row.result_text, null);
  }
  {
    // The question instruction adds at most 4,096 bytes to the prompt.
    const store = await codexStore(t);
    const prompt = "p".repeat(10000);
    await runSeededJob(store, prompt, { allowQuestions: true });
    const sent = store.readFake().turnStarts.at(-1).prompt;
    assert.ok(sent.startsWith(prompt), "the prompt is not first in the request");
    const added = Buffer.byteLength(sent, "utf8") - Buffer.byteLength(prompt, "utf8");
    assert.ok(added > 0 && added <= 4096, `the question request added ${added} bytes`);
  }
});

// ---------------------------------------------------------------------------------------------
// The Codex task and review commands on the job store

// A committed repository, a fake Codex and the environment of a CLI run in a Claude session.
// Every worker the store records and every app server the fake records is stopped at the end.
function codexCli(t, behavior = "review-ok") {
  const exited = new Set();
  let binDir = null;
  stopLeftoverProcesses(t, () => binDir, exited);
  const repo = makeCommittedRepo(t);
  const stateDir = resolveStateDir(repo);
  t.after(() => {
    const file = path.join(stateDir, "store", "state.db");
    if (!fs.existsSync(file)) {
      return [];
    }
    const ids = storeFixtures.rawAll(stateDir, "SELECT id FROM jobs").map((row) => row.id);
    return stopOwnedProcesses(ids.flatMap((id) => storeFixtures.jobProcesses(stateDir, id)));
  });
  binDir = makeTempDir(t);
  installFakeCodex(binDir, behavior, { recordIdentities: true, version: "0.169.0" });
  const env = { ...buildEnv(binDir), AGENT_PLUGIN_SESSION_ID: "sess-cli", AGENT_PLUGIN_TEST_CONTRACTS: FAKE_CODEX_CONTRACTS };
  const cli = (...args) => run("node", [SCRIPT, ...args], { cwd: repo, env });
  const rows = () => (fs.existsSync(path.join(stateDir, "store", "state.db")) ? storeFixtures.rawAll(stateDir, "SELECT * FROM jobs ORDER BY created_at, id") : []);
  const readFake = () => {
    const file = path.join(binDir, "fake-codex-state.json");
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  };
  // A release the worker left to reconciliation (on Windows its tree stop can find the wrapper's
  // root already gone) is completed by the scan of the next command, so once the job has ended a
  // status command runs every few seconds, as a user's next command would.
  const released = (jobId) => {
    let lastScan = Date.now();
    return storeFixtures.waitFor(
      () => {
        const row = storeFixtures.jobRow(stateDir, jobId);
        if (row?.exec_released_at !== null) {
          return true;
        }
        if (row?.end_state !== null && Date.now() - lastScan > 3000) {
          cli("status", "--json");
          lastScan = Date.now();
        }
        return false;
      },
      { timeoutMs: 90000, describe: `the release of ${jobId}` }
    );
  };
  return { repo, stateDir, binDir, env, cli, rows, readFake, released };
}

test("task and review accept --label and --run-id and store both", { timeout: 120000 }, async (t) => {
  const codex = codexCli(t);
  const task = codex.cli("task", "--background", "--json", "--label", "r1", "--run-id", "run-1", "label this task");
  assert.equal(task.status, 0, task.stderr);
  const taskReply = JSON.parse(task.stdout);
  assert.ok(taskReply.jobId);
  assert.ok(["queued", "running"].includes(taskReply.status), taskReply.status);
  assert.deepEqual([taskReply.label, taskReply.runId, taskReply.provider], ["r1", "run-1", "codex"]);
  fs.writeFileSync(path.join(codex.repo, "README.md"), "changed\n");
  const review = codex.cli("review", "--background", "--json", "--label", "r2", "--run-id", "run-1");
  assert.equal(review.status, 0, review.stderr);
  const reviewReply = JSON.parse(review.stdout);
  assert.ok(reviewReply.jobId);
  assert.ok(["queued", "running"].includes(reviewReply.status), reviewReply.status);
  const byId = new Map(codex.rows().map((row) => [row.id, row]));
  assert.deepEqual([byId.get(taskReply.jobId).label, byId.get(taskReply.jobId).run_id], ["r1", "run-1"]);
  assert.deepEqual([byId.get(reviewReply.jobId).label, byId.get(reviewReply.jobId).run_id], ["r2", "run-1"]);
  assert.equal(byId.get(reviewReply.jobId).kind, "review");
  await codex.released(taskReply.jobId);
  await codex.released(reviewReply.jobId);
});

test("task keeps option-like text after -- as the prompt", { timeout: 120000 }, async (t) => {
  const codex = codexCli(t);
  const task = codex.cli("task", "--background", "--json", "--write", "--", "fix --model handling");
  assert.equal(task.status, 0, task.stderr);
  const { jobId } = JSON.parse(task.stdout);
  const row = storeFixtures.jobRow(codex.stateDir, jobId);
  assert.equal(row.prompt, "fix --model handling");
  assert.notEqual(row.model, "handling");
  await codex.released(jobId);
});

test("task-resume-candidate prints the newest resumable Codex tip", { timeout: 120000 }, async (t) => {
  const codex = codexCli(t);
  const empty = codex.cli("task-resume-candidate", "--json");
  assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual(JSON.parse(empty.stdout), { available: false, jobId: null, threadId: null, label: null, status: null, provider: "codex" });
  const task = codex.cli("task", "--label", "c1", "finish one task");
  assert.equal(task.status, 0, task.stderr);
  const [row] = codex.rows();
  await codex.released(row.id);
  const found = JSON.parse(codex.cli("task-resume-candidate", "--json").stdout);
  assert.deepEqual(found, { available: true, jobId: row.id, threadId: storeFixtures.jobRow(codex.stateDir, row.id).thread_id, label: "c1", status: "completed", provider: "codex" });
});

test("a second Codex job with a live label exits 1 naming its holder and leaves no row", { timeout: 120000 }, async (t) => {
  const codex = codexCli(t, "interruptible-slow-task");
  const first = codex.cli("task", "--background", "--json", "--label", "dup", "hold the label");
  assert.equal(first.status, 0, first.stderr);
  const holder = JSON.parse(first.stdout).jobId;
  const second = codex.cli("task", "--background", "--label", "dup", "want the label");
  assert.equal(second.status, 1);
  assert.match(second.stderr, new RegExp(`held by job ${holder}`));
  assert.equal(codex.rows().length, 1);
  await codex.released(holder);
});

test("Codex resume flags respect the thread barrier and print the overlap warning with --force", { timeout: 120000 }, async (t) => {
  const codex = codexCli(t);
  // A real thread first, so the forced continuation can resume it on the fake Codex.
  const first = codex.cli("task", "make a thread");
  assert.equal(first.status, 0, first.stderr);
  const threadId = codex.rows()[0].thread_id;
  await codex.released(codex.rows()[0].id);
  // A later job on that thread whose provider exit was not observed leaves a barrier on it.
  const db = storeLib.openStore(codex.stateDir);
  t.after(() => db.close());
  const { jobId: barrierJob } = storeState.createJob(db, {
    provider: "codex",
    kind: "task",
    title: "barrier",
    prompt: "left running",
    request: { cwd: codex.repo },
    cwd: codex.repo,
    threadId,
    requester: { sessionId: "sess-cli", leaderPid: null, leaderStartToken: null }
  });
  storeFixtures.rawExec(codex.stateDir, `UPDATE jobs SET exec_gen = 1, worker_pid = 1, worker_start_token = 'w', claimed_at = 1, spawn_intent_at = 2, provider_pid = 3, provider_start_token = 'r', active_thread_key = 'codex:${threadId}' WHERE id = '${barrierJob}'`);
  assert.equal(storeState.releaseExecution(db, barrierJob, 1, { kind: "unobserved", endIfUndecided: { by: "reconcile", reason: "worker-dead" } }), true);
  const warning = `Thread ${threadId} was last used by job ${barrierJob}, whose provider exit was not observed; it may still run and overlap this job.`;
  const blocked = codex.cli("task", "--background", "--resume-thread", threadId, "continue the barred thread");
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, new RegExp(barrierJob));
  const blockedLast = codex.cli("task", "--background", "--resume-last", "continue the last job");
  assert.equal(blockedLast.status, 1);
  assert.match(blockedLast.stderr, new RegExp(barrierJob));
  const forced = codex.cli("task", "--background", "--json", "--force", "--resume-thread", threadId, "continue anyway");
  assert.equal(forced.status, 0, forced.stderr);
  assert.ok(forced.stderr.includes(warning), forced.stderr);
  await codex.released(JSON.parse(forced.stdout).jobId);
});

test("a foreground Codex job exits by its end state", { timeout: 120000 }, async (t) => {
  {
    const codex = codexCli(t);
    const done = codex.cli("task", "finish in the foreground");
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /Handled the requested task/);
  }
  {
    const codex = codexCli(t, "exit-mid-turn");
    const failed = codex.cli("task", "fail in the foreground");
    assert.equal(failed.status, 1, failed.stdout);
    assert.equal(codex.rows()[0].end_state, "failed");
  }
});

test("without --allow-questions the prompt is unchanged and the job completes", { timeout: 120000 }, async (t) => {
  const codex = codexCli(t, "question-line");
  const result = codex.cli("task", "send exactly this prompt");
  assert.equal(result.status, 0, result.stderr);
  const [row] = codex.rows();
  assert.equal(row.end_state, "completed");
  assert.equal(codex.readFake().turnStarts.at(-1).prompt, "send exactly this prompt");
});

test("question-schema conflicts are refused before any Codex job", { timeout: 120000 }, async (t) => {
  const codex = codexCli(t);
  const accepted = codex.cli("task", "--background", "--json", "one accepted job first");
  assert.equal(accepted.status, 0, accepted.stderr);
  await codex.released(JSON.parse(accepted.stdout).jobId);
  const startsBefore = codex.readFake().appServerStarts ?? 0;
  const schemaFile = path.join(makeTempDir(t), "schema.json");
  fs.writeFileSync(schemaFile, JSON.stringify({ type: "array", items: { type: "string" } }));
  const hash = crypto.createHash("sha256").update(fs.readFileSync(schemaFile)).digest("hex");
  const refused = codex.cli("task", "--background", "--allow-questions", "--output-schema", schemaFile, "ask with a list schema");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /schema/i);
  assert.equal(codex.rows().length, 1, "a job row was created for a refused schema");
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(schemaFile)).digest("hex"), hash);
  assert.equal(codex.readFake().appServerStarts ?? 0, startsBefore, "Codex was contacted for a refused schema");
});

test("--resume-last checks a replacement schema against the question setting the successor inherits", { timeout: 120000 }, async (t) => {
  const codex = codexCli(t);
  const first = codex.cli("task", "--allow-questions", "a job that may ask");
  assert.equal(first.status, 0, first.stderr);
  const schemaDir = makeTempDir(t);
  const withQuestion = path.join(schemaDir, "with-question.json");
  fs.writeFileSync(withQuestion, JSON.stringify({ type: "object", properties: { question: { type: "string" }, answer: { type: "string" } } }));
  const plain = path.join(schemaDir, "plain.json");
  fs.writeFileSync(plain, JSON.stringify({ type: "object", properties: { answer: { type: "string" } } }));

  // The resume command does not pass --allow-questions; the successor may ask all the same.
  const refused = codex.cli("task", "--background", "--resume-last", "--output-schema", withQuestion, "go on");
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /already defines a question property/);
  assert.equal(codex.rows().length, 1, "a successor was created for a schema it cannot use");

  const accepted = codex.cli("task", "--background", "--json", "--resume-last", "--output-schema", plain, "go on");
  assert.equal(accepted.status, 0, accepted.stderr);
  const { jobId } = JSON.parse(accepted.stdout);
  await codex.released(jobId);
  const successor = storeFixtures.jobRow(codex.stateDir, jobId);
  assert.equal(successor.allow_questions, 1);
  assert.deepEqual(Object.keys(JSON.parse(successor.request_json).outputSchema.properties), ["answer", "question"]);
});

test("a Codex prompt of 8,388,608 bytes is accepted and one byte more refused", { timeout: 120000 }, async (t) => {
  const codex = codexCli(t);
  const promptDir = makeTempDir(t);
  const atLimit = path.join(promptDir, "limit.txt");
  fs.writeFileSync(atLimit, "a".repeat(8388608));
  const over = path.join(promptDir, "over.txt");
  fs.writeFileSync(over, "a".repeat(8388609));
  const accepted = codex.cli("task", "--background", "--json", "--prompt-file", atLimit);
  assert.equal(accepted.status, 0, accepted.stderr);
  await codex.released(JSON.parse(accepted.stdout).jobId);
  const refused = codex.cli("task", "--background", "--prompt-file", over);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /8388609 bytes; the limit is 8388608 bytes/);
  assert.equal(codex.rows().length, 1);
});

// A Codex driver on a fake Codex of `behavior`, with a job row of a fresh repository and a worker
// context that records nothing. Every app server the fake starts is stopped when the test ends.
function fakeCodexDriver(t, behavior) {
  let binDir = null;
  stopLeftoverProcesses(t, () => binDir, new Set());
  const repo = makeCommittedRepo(t);
  binDir = makeTempDir(t);
  installFakeCodex(binDir, behavior, { recordIdentities: true });
  const driver = createCodexDriver(null, { env: buildEnv(binDir) });
  const job = { id: "task-driver", cwd: repo, model: null, thread_id: null, ephemeral: 0, request_json: JSON.stringify({ cwd: repo }) };
  const ctx = { job, cwd: repo, log: () => {}, onTurn: () => {}, onStarted: () => {}, onReceipt: () => {} };
  return { driver, ctx };
}

// Resolves to `promise`'s value, or to `fallback` after `ms` milliseconds.
function within(promise, ms, fallback) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => (timer = setTimeout(() => resolve(fallback), ms)))]).finally(() => clearTimeout(timer));
}

test("the Codex driver's spawn returns the child before the handshake, and a stop ends a stalled prepare", { timeout: 60000 }, async (t) => {
  const { driver, ctx } = fakeCodexDriver(t, "initialize-hangs");
  const spawned = await within(driver.spawn(ctx), 10000, "pending");
  assert.notEqual(spawned, "pending", "spawn waited for an initialize reply that never comes");
  t.after(() => stopOwnedProcess(spawned.child, { tree: true }));
  assert.ok(spawned.pid > 0 && spawned.child.pid === spawned.pid);
  const prepared = driver.prepare(ctx).then(
    () => "resolved",
    () => "rejected"
  );
  assert.equal(await within(prepared, 1000, "pending"), "pending");
  // The worker stops the provider through the child handle; the stalled handshake then fails.
  await stopOwnedProcess(spawned.child, { tree: true });
  assert.equal(await within(prepared, 10000, "pending"), "rejected");
});

test("the wait for a previous turn's interrupt ends at the limit when Codex never answers it", { timeout: 60000 }, async (t) => {
  const { driver, ctx } = fakeCodexDriver(t, "interrupt-unanswered");
  const spawned = await within(driver.spawn(ctx), 10000, "pending");
  assert.notEqual(spawned, "pending", "spawn did not return");
  t.after(() => stopOwnedProcess(spawned.child, { tree: true }));
  await driver.prepare(ctx);
  const started = Date.now();
  const outcome = await within(driver.interruptPrevious(ctx, "turn-prev", 500), 10000, "still waiting");
  assert.equal(outcome, "timeout");
  assert.ok(Date.now() - started < 5000, `the wait took ${Date.now() - started} ms`);
});
