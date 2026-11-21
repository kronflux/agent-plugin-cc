import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { after } from "node:test";
import { pathToFileURL } from "node:url";

const tempDirs = new Set();

/**
 * A skip reason on a hosted Windows runner, else false. Tests that measure the store against a
 * time budget under several writers pass it as their `skip` option: the disk of such a runner
 * stalls for seconds at a time, so the budgets say nothing there.
 */
export const SLOW_RUNNER_SKIP =
  process.env.CI && process.platform === "win32" ? "time budgets under contention are not stable on a hosted Windows runner" : false;

const BUSY_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"]);

/**
 * Removes a folder and everything in it. A process that a test started can hold a folder for a
 * moment after it was told to stop, and on the Node 22 line `fs.rmSync` does not retry a busy
 * empty folder, so a busy folder is tried again here for up to `waitMs`.
 */
export function removeDir(dir, { waitMs = 15000 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (error) {
      if (!BUSY_CODES.has(error?.code) || Date.now() >= deadline) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

// Removes every folder still registered when the test file ends and reports any it cannot
// remove.
after(async () => {
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

const PROCESS_LIB = pathToFileURL(path.join(import.meta.dirname, "..", "plugins", "agent", "scripts", "lib", "process.mjs")).href;

/**
 * How often stopOwnedProcess ended each way in this test process: `stopped`, `exited` (the
 * target had already ended), `mismatch` (the id now belongs to another process), `unproved`
 * (no held child and no start token, or the identity could not be read) and `failed`.
 */
export const ownedStopCounts = { stopped: 0, exited: 0, mismatch: 0, unproved: 0, failed: 0 };

function count(result) {
  ownedStopCounts[result] += 1;
  return result;
}

function heldAndRunning(child) {
  return Number.isInteger(child.pid) && child.exitCode === null && child.signalCode === null;
}

function signalAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function taskkill(pid, tree) {
  const result = spawnSync("taskkill", ["/PID", String(pid), ...(tree ? ["/T"] : []), "/F"], { windowsHide: true, stdio: "ignore" });
  return result.status === 0;
}

// The identities of `pids` and of this process, read in one query.
async function readIdentities(pids) {
  const { readProcessIdentities } = await import(PROCESS_LIB);
  return readProcessIdentities([...pids, process.pid], { deadline: performance.now() + 15000 });
}

async function stopHeldChild(child, tree) {
  if (!heldAndRunning(child)) {
    return "exited";
  }
  if (tree && process.platform === "win32") {
    // The parent's open handle keeps Windows from giving the id to another process.
    return taskkill(child.pid, true) ? "stopped" : heldAndRunning(child) ? "failed" : "exited";
  }
  if (tree) {
    // A POSIX group stop only for a group this child leads, never this process's own group. An
    // unreaped leader keeps its group id from being reused.
    const identities = await readIdentities([child.pid]);
    const observed = identities.get(child.pid);
    const own = identities.get(process.pid);
    if (heldAndRunning(child) && observed?.state === "present" && observed.groupId === child.pid && own?.groupId !== child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
        return "stopped";
      } catch {
        // The group is gone; the child's own stop below decides.
      }
    }
  }
  if (!heldAndRunning(child)) {
    return "exited";
  }
  // ChildProcess.kill uses the child's own handle on Windows and its unreaped id on POSIX.
  return child.kill("SIGKILL") ? "stopped" : heldAndRunning(child) ? "failed" : "exited";
}

function isRecordedIdentity(target) {
  return (
    target !== null &&
    typeof target === "object" &&
    Number.isInteger(target.pid) &&
    target.pid > 0 &&
    target.pid !== process.pid &&
    typeof target.startToken === "string" &&
    target.startToken !== ""
  );
}

/**
 * Stops processes this test started, each only when it can prove at that moment that the id is
 * still that process's: a held ChildProcess whose exitCode and signalCode are both null, or a
 * recorded `{ pid, startToken }` whose live identity, read with readProcessIdentity, has that
 * token. Anything else (a bare pid, a null token, an unreadable identity) is skipped and counted
 * in ownedStopCounts. Recorded identities are checked in one query, each stopped right after it.
 *
 * Without `tree` only the process itself is stopped: ChildProcess.kill("SIGKILL") for a held
 * child, `taskkill /PID <pid> /F` or SIGKILL for a recorded identity. With `tree` Windows runs
 * `taskkill /PID <pid> /T /F`, and POSIX signals the process group the target leads, never this
 * process's own. Resolves to one result per target, in order: stopped, exited, mismatch,
 * unproved or failed. A held child without `tree` is stopped before the call returns.
 */
export async function stopOwnedProcesses(targets, { tree = false } = {}) {
  const results = new Array(targets.length);
  const recorded = [];
  const pending = [];
  targets.forEach((target, index) => {
    if (target instanceof ChildProcess) {
      pending.push(stopHeldChild(target, tree).then((result) => (results[index] = count(result))));
    } else if (!isRecordedIdentity(target)) {
      results[index] = count("unproved");
    } else if (!signalAlive(target.pid)) {
      // A signal 0 probe stops nothing; an id with no process needs no stop.
      results[index] = count("exited");
    } else {
      recorded.push(index);
    }
  });
  await Promise.all(pending);
  if (recorded.length === 0) {
    return results;
  }
  const { confirmIdentity } = await import(PROCESS_LIB);
  const identities = await readIdentities(recorded.map((index) => targets[index].pid));
  const own = identities.get(process.pid);
  for (const index of recorded) {
    const target = targets[index];
    const observed = identities.get(target.pid);
    const verdict = confirmIdentity(target, observed);
    if (verdict !== "present") {
      results[index] = count(verdict === "absent" ? (observed?.state === "present" ? "mismatch" : "exited") : "unproved");
      continue;
    }
    if (process.platform === "win32") {
      results[index] = count(taskkill(target.pid, tree) ? "stopped" : signalAlive(target.pid) ? "failed" : "exited");
      continue;
    }
    const group = tree && observed.groupId === target.pid && own?.groupId !== target.pid;
    try {
      process.kill(group ? -target.pid : target.pid, "SIGKILL");
      results[index] = count("stopped");
    } catch (error) {
      results[index] = count(error?.code === "ESRCH" ? "exited" : "failed");
    }
  }
  return results;
}

/** One target of stopOwnedProcesses; resolves to its result. */
export async function stopOwnedProcess(target, options = {}) {
  return (await stopOwnedProcesses([target], options))[0];
}

// Stops the child and every process it started. On POSIX the child leads its own process group,
// so the group signal also reaches descendants that inherited its pipes.
function killChildTree(child) {
  stopOwnedProcess(child, { tree: true }).catch((error) => {
    process.stderr.write(`could not stop the timed-out child ${child.pid}: ${error.message}
`);
  });
}

// How long a timed-out call waits for the child's pipes to close after the stop.
const CLOSE_AFTER_KILL_MS = 5000;

export function spawnJson(command, args, { timeoutMs = 30000, env, cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
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
    const detail = () => `; stderr: ${stderr}; stdout: ${stdout}`;
    let closeTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killChildTree(child);
      // A descendant outside the stopped tree can still hold the pipes open; the call then ends
      // without waiting for them.
      closeTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        reject(new Error(`${command} timed out after ${timeoutMs} ms and its output did not close${detail()}`));
      }, CLOSE_AFTER_KILL_MS);
    }, timeoutMs);
    child.on("error", (error) => {
      startError = error;
      clearTimeout(timer);
      reject(new Error(`${command} failed: ${error.message}${detail()}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(closeTimer);
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
    timeout: options.timeout,
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

export function initGitRepo(cwd) {
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
