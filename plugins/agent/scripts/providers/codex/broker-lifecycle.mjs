import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { isProcessAlive, readProcessCommandLines } from "../../lib/process.mjs";
import { resolveStateDir } from "../../lib/state.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
const BROKER_STATE_FILE = "broker.json";
const BROKER_SCRIPT_NAME = "app-server-broker.mjs";
const SHUTDOWN_REQUEST_MS = 5000;
const QUICK_PROBE_MS = 150;
const LIVE_BROKER_PROBE_MS = 3000;

export function createBrokerSessionDir(prefix = "cxc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

// Sends one broker request and resolves with its result, or with null when the broker cannot
// be reached or does not answer within `timeoutMs`.
function requestBroker(endpoint, method, timeoutMs = SHUTDOWN_REQUEST_MS) {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const socket = connectToEndpoint(endpoint);
    const finish = (value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method, params: {} })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      try {
        finish(JSON.parse(buffer.slice(0, newlineIndex)).result ?? null);
      } catch {
        finish(null);
      }
    });
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}

/** Asks the broker to stop. Resolves within the request timeout whether or not it answers. */
export async function sendBrokerShutdown(endpoint) {
  await requestBroker(endpoint, "broker/shutdown");
}

/**
 * Asks the broker to stop if no other client is connected and no request or turn is in
 * progress. Resolves to "stopped", "busy", or "unreachable".
 */
export async function requestBrokerShutdownIfIdle(endpoint) {
  const result = await requestBroker(endpoint, "broker/shutdownIfIdle");
  if (!result) {
    return "unreachable";
  }
  return result.stopped ? "stopped" : "busy";
}

/** Whether `pid` is a running broker process, judged by its command line. */
export function isBrokerProcess(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  const commandLines = (options.readCommandLines ?? readProcessCommandLines)([pid]);
  if (!commandLines) {
    return isProcessAlive(pid);
  }
  return commandLines.get(pid)?.includes(BROKER_SCRIPT_NAME) ?? false;
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process.env }) {
  const brokerArgs = ["serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile];
  if (process.platform === "win32") {
    const launcherPath = path.join(path.dirname(scriptPath), "broker-launcher.mjs");
    const launcher = spawn(process.execPath, [launcherPath, logFile, scriptPath, ...brokerArgs], {
      cwd,
      env,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    launcher.unref();
    return launcher;
  }
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [scriptPath, ...brokerArgs], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true
  });
  child.unref();
  fs.closeSync(logFd);
  return child;
}

function readBrokerPid(pidFile) {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile, "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

async function isBrokerEndpointReady(endpoint, timeoutMs = QUICK_PROBE_MS) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, timeoutMs);
  } catch {
    return false;
  }
}

const START_LOCK_STALE_MS = 30000;
const START_LOCK_WAIT_MS = 15000;

function removeStaleStartLock(lockFile) {
  try {
    if (Date.now() - fs.statSync(lockFile).mtimeMs > START_LOCK_STALE_MS) {
      fs.rmSync(lockFile, { force: true });
    }
  } catch {
    // The lock was released in the meantime.
  }
}

// Parallel jobs can find no broker at the same moment. Only the process holding the start lock,
// a file created exclusively next to the broker state, starts one; the others wait and then use
// the broker it started. After START_LOCK_WAIT_MS a waiting process goes ahead without the lock.
export async function ensureBrokerSession(cwd, options = {}) {
  const lockFile = `${resolveBrokerStateFile(cwd)}.lock`;
  const deadline = Date.now() + (options.startLockWaitMs ?? START_LOCK_WAIT_MS);
  for (;;) {
    let acquired = false;
    try {
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      fs.closeSync(fs.openSync(lockFile, "wx"));
      acquired = true;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        return startOrReuseBroker(cwd, options);
      }
    }
    if (acquired) {
      try {
        return await startOrReuseBroker(cwd, options);
      } finally {
        fs.rmSync(lockFile, { force: true });
      }
    }
    removeStaleStartLock(lockFile);
    if (Date.now() >= deadline) {
      return startOrReuseBroker(cwd, options);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function startOrReuseBroker(cwd, options) {
  const existing = loadBrokerSession(cwd);
  const probe = options.probeEndpoint ?? isBrokerEndpointReady;
  if (existing && (await probe(existing.endpoint, QUICK_PROBE_MS))) {
    return existing;
  }
  // A broker busy with a large request, or still starting on a slow Windows machine, can miss
  // the quick probe. While its process is alive it gets a longer wait before it is replaced.
  if (
    existing &&
    isBrokerProcess(existing.pid, options) &&
    (await probe(existing.endpoint, LIVE_BROKER_PROBE_MS))
  ) {
    return existing;
  }

  if (existing) {
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    clearBrokerSession(cwd);
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("./app-server-broker.mjs", import.meta.url));

  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: options.env ?? process.env
  });

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  // On Windows the spawned child is the launcher, so the broker's PID comes from its PID file.
  const brokerPid = readBrokerPid(pidFile) ?? (process.platform === "win32" ? null : child.pid ?? null);
  if (!ready) {
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: brokerPid,
      killProcess: options.killProcess ?? null
    });
    return null;
  }

  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: brokerPid
  };
  saveBrokerSession(cwd, session);
  return session;
}

// The recorded PID is signalled only while its command line is a broker's, so a PID reused
// by another program after the broker exited is left alone.
export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null }) {
  if (Number.isFinite(pid) && killProcess && isBrokerProcess(pid)) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
