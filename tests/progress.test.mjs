import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run, stopTestBrokers } from "./helpers.mjs";
import { listJobs } from "../plugins/agent/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "agent");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const MONITOR = path.join(PLUGIN_ROOT, "scripts", "job-monitor.mjs");

const monitors = [];
after(async () => {
  for (const child of monitors) {
    child.kill();
  }
  await stopTestBrokers();
});

function makeRepo(behavior) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return { repo, env: { ...buildEnv(binDir), CLAUDE_PID: String(process.pid) } };
}

function startMonitor(repo, env, { graceMs = 300, pluginData = null } = {}) {
  const child = spawn(process.execPath, [MONITOR, repo, ...(pluginData ? [pluginData] : [])], {
    env: { ...env, CODEX_COMPANION_MONITOR_POLL_MS: "100", CODEX_COMPANION_MONITOR_GRACE_MS: String(graceMs) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  monitors.push(child);
  const output = { text: "" };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output.text += chunk;
  });
  return { child, output };
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

function launchBackgroundTask(ctx, env = ctx.env) {
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate"], { cwd: ctx.repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  return JSON.parse(launched.stdout).jobId;
}

function jobStatus(repo, jobId) {
  return listJobs(repo).find((job) => job.id === jobId)?.status;
}

test("the job log gets one line per completed agent message", () => {
  const ctx = makeRepo("three-messages");
  const result = run("node", [SCRIPT, "task", "--json", "investigate"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 0, result.stderr);

  const [job] = listJobs(ctx.repo);
  const log = fs.readFileSync(job.logFile, "utf8");
  const lines = log.split("\n").filter((line) => /^\[[^\]]+\] Assistant message captured: /.test(line));
  assert.equal(lines.length, 3, log);
  assert.match(lines[0], /First progress note\./);
});

test("the monitor announces a finished background job whose result nobody printed", async () => {
  const ctx = makeRepo();
  const { output } = startMonitor(ctx.repo, ctx.env);
  const jobId = launchBackgroundTask(ctx);

  assert.ok(await waitUntil(() => output.text.includes(jobId), 20000), `no announcement: ${output.text}`);
  assert.match(output.text, new RegExp(`^Codex job ${jobId} completed: .*Run /agent:result ${jobId} for the output\\.$`, "m"));
  assert.equal(output.text.trim().split("\n").length, 1);
});

test("the monitor stays silent for a job whose result a command printed", async () => {
  const ctx = makeRepo();
  const { output } = startMonitor(ctx.repo, ctx.env, { graceMs: 4000 });
  const jobId = launchBackgroundTask(ctx);
  const waited = run("node", [SCRIPT, "result", jobId, "--wait", "--timeout-ms", "20000", "--poll-interval-ms", "100"], {
    cwd: ctx.repo,
    env: ctx.env
  });
  assert.equal(waited.status, 0, waited.stderr);

  await new Promise((resolve) => setTimeout(resolve, 5000));
  assert.equal(output.text, "");
});

test("the monitor ignores jobs started from another Claude process", async () => {
  const ctx = makeRepo();
  const { output } = startMonitor(ctx.repo, ctx.env);
  const jobId = launchBackgroundTask(ctx, { ...ctx.env, CLAUDE_PID: "1" });

  assert.ok(await waitUntil(() => jobStatus(ctx.repo, jobId) === "completed", 20000));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(output.text, "");
});

test("the monitor exits when its Claude process is gone", async () => {
  const ctx = makeRepo();
  const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => gone.on("exit", resolve));
  const { child } = startMonitor(ctx.repo, { ...ctx.env, CLAUDE_PID: String(gone.pid) });

  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0);
});

test("the plugin registers the job monitor", () => {
  const monitorsFile = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "monitors", "monitors.json"), "utf8"));
  assert.deepEqual(Object.keys(monitorsFile[0]).sort(), ["command", "description", "name"]);
  assert.match(
    monitorsFile[0].command,
    /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/job-monitor\.mjs" "\$\{CLAUDE_PROJECT_DIR\}" "\$\{CLAUDE_PLUGIN_DATA\}"$/
  );
});

test("the monitor reads jobs from the plugin data directory it is given", async () => {
  const ctx = makeRepo();
  const pluginData = makeTempDir();
  // The session's commands get CLAUDE_PLUGIN_DATA from the SessionStart hook; the monitor
  // process does not, and receives the directory as an argument instead.
  const sessionEnv = { ...ctx.env, CLAUDE_PLUGIN_DATA: pluginData };
  const { output } = startMonitor(ctx.repo, ctx.env, { pluginData });
  const jobId = launchBackgroundTask(ctx, sessionEnv);

  assert.ok(await waitUntil(() => output.text.includes(jobId), 20000), `no announcement: ${output.text}`);
  assert.ok(listJobs(ctx.repo).every((job) => job.id !== jobId), "the job was stored outside the plugin data directory");
});
