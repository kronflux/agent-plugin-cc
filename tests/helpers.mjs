import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { after } from "node:test";

import { loadBrokerSession, sendBrokerShutdown } from "../plugins/agent/scripts/providers/codex/broker-lifecycle.mjs";

const gitRepos = new Set();

const tempDirs = new Set();

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// Stops test brokers, then removes every folder still registered when the test file ends and
// reports any it cannot remove.
after(async () => {
  await stopTestBrokers();
  const deadline = Date.now() + 10000;
  for (const dir of tempDirs) {
    try {
      if (Date.now() < deadline) {
        removeDir(dir);
      }
    } catch {
      // reported below
    }
    if (fs.existsSync(dir)) {
      process.stderr.write(`leftover temp folder: ${dir}\n`);
    }
  }
  tempDirs.clear();
});

export function makeTempDir(tOrPrefix, prefix = "codex-plugin-test-") {
  const context = tOrPrefix && typeof tOrPrefix === "object" ? tOrPrefix : null;
  const effectivePrefix = typeof tOrPrefix === "string" ? tOrPrefix : prefix;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), effectivePrefix));
  tempDirs.add(dir);
  if (typeof context?.after === "function") {
    context.after(() => {
      removeDir(dir);
      tempDirs.delete(dir);
    });
  }
  return dir;
}

const STOP_WAITING = Symbol("stopWaiting");

export function stopWaiting(reason) {
  return { [STOP_WAITING]: true, reason: String(reason) };
}

function safeJson(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export async function waitUntil(predicate, { timeoutMs = 10000, intervalMs = 100, describe = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  let lastError = null;
  for (;;) {
    let value;
    try {
      value = await predicate();
    } catch (error) {
      lastError = error;
    }
    if (value && typeof value === "object" && value[STOP_WAITING]) {
      throw new Error(value.reason);
    }
    if (value) {
      return value;
    }
    if (value !== undefined) {
      lastValue = value;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(
    `${describe} did not happen within ${timeoutMs} ms; last value: ${safeJson(lastValue)}; last error: ${lastError ? lastError.message : "none"}`
  );
}

function killChild(child) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
}

export function spawnJson(command, args, { timeoutMs = 30000, env, cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let startError = null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, timeoutMs);
    const detail = () => `; stderr: ${stderr}; stdout: ${stdout}`;
    child.on("error", (error) => {
      startError = error;
      clearTimeout(timer);
      reject(new Error(`${command} failed: ${error.message}${detail()}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (startError) {
        return;
      }
      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs} ms${detail()}`));
        return;
      }
      let json;
      try {
        json = JSON.parse(stdout);
      } catch (error) {
        reject(new Error(`${command} did not print JSON (status ${code}, signal ${signal}): ${error.message}${detail()}`));
        return;
      }
      resolve({ code, signal, stdout, stderr, json });
    });
  });
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
  if (options.check && (result.error || result.signal || result.status !== 0)) {
    throw new Error(
      `${command} ${args.join(" ")} failed: status ${result.status}, signal ${result.signal}` +
        (result.error ? `, error ${result.error.message}` : "") +
        `, stderr: ${result.stderr ?? ""}`
    );
  }
  return result;
}

// Brokers are detached and outlive the test that started them. A test file that starts
// them registers this as its `after` hook: each repository's broker gets the broker's own
// shutdown request on its endpoint, so a stale PID can never reach an unrelated process.
export async function stopTestBrokers() {
  const endpoints = [...gitRepos].map((repo) => loadBrokerSession(repo)?.endpoint).filter(Boolean);
  gitRepos.clear();
  await Promise.all(
    endpoints.map((endpoint) =>
      Promise.race([
        sendBrokerShutdown(endpoint),
        new Promise((resolve) => setTimeout(resolve, 2000).unref())
      ])
    )
  );
}

export function initGitRepo(cwd) {
  gitRepos.add(cwd);
  run("git", ["init", "-b", "main"], { cwd, check: true, shell: false });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd, check: true, shell: false });
  run("git", ["config", "user.email", "tests@example.com"], { cwd, check: true, shell: false });
  run("git", ["config", "commit.gpgsign", "false"], { cwd, check: true, shell: false });
  run("git", ["config", "tag.gpgsign", "false"], { cwd, check: true, shell: false });
}

export function makeCommittedRepo(t, { files = { "README.md": "hello\n" }, message = "init" } = {}) {
  const repo = makeTempDir(t);
  initGitRepo(repo);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(repo, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  run("git", ["add", "-A"], { cwd: repo, check: true, shell: false });
  run("git", ["commit", "-m", message], { cwd: repo, check: true, shell: false });
  return repo;
}
