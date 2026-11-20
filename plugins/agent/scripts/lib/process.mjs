import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { boundary, testDelay } from "./store.mjs";
import { BATCH_FILE, findWindowsExecutable, windowsSystemTool } from "./system-tools.mjs";

// cmd.exe expands %NAME% even inside double quotes and cannot pass a double quote or a
// line break through to a batch file intact, so those arguments are refused rather than
// altered. A quoted argument doubles its trailing backslashes, so the program behind the batch
// file reads them as backslashes and not as an escaped closing quote.
function quoteForCmd(value) {
  const text = String(value);
  if (/[%"\r\n]/.test(text)) {
    throw new Error(`Cannot pass an argument containing %, ", or a line break to a batch file: ${text}`);
  }
  if (text !== "" && !/[\s&|<>^(),;=!]/.test(text)) {
    return text;
  }
  return `"${text.replace(/\\+$/, (backslashes) => backslashes + backslashes)}"`;
}

/**
 * Returns how to spawn `command` without a shell choosing the interpreter. On Windows the
 * command is looked up through PATH and PATHEXT: an executable runs directly with its
 * argument array, and a batch file (such as the `.cmd` shim of an npm-installed CLI) runs through
 * `%ComSpec%`, because Node refuses to start batch files without one, with delayed expansion
 * turned off so `!` in an argument stays as written. `SHELL` is never read.
 *
 * cmd.exe looks for a bare command name such as `node` in the working folder before PATH, so
 * a repository could plant `node.cmd` for the shim to run. The batch-file plan's `options.env`
 * therefore sets `NoDefaultCurrentDirectoryInExePath=1`, which turns that lookup off; callers
 * spread `options` after their own `env`.
 */
export function resolveCommand(command, args = [], env = process.env, platform = process.platform) {
  if (platform !== "win32") {
    return { file: command, args, options: {} };
  }
  const executable = findWindowsExecutable(command, env);
  if (!executable) {
    return { file: command, args, options: {} };
  }
  if (!BATCH_FILE.test(executable)) {
    return { file: executable, args, options: {} };
  }
  const commandLine = [executable, ...args].map(quoteForCmd).join(" ");
  return {
    file: windowsSystemTool("cmd.exe", { env, platform }),
    args: ["/d", "/v:off", "/s", "/c", `"${commandLine}"`],
    options: { windowsVerbatimArguments: true, env: withoutCurrentDirectoryLookup(env) }
  };
}

const CURRENT_DIRECTORY_GUARD = "NoDefaultCurrentDirectoryInExePath";

function withoutCurrentDirectoryLookup(env) {
  /** @type {NodeJS.ProcessEnv} */
  const childEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() !== CURRENT_DIRECTORY_GUARD.toUpperCase()) {
      childEnv[key] = value;
    }
  }
  childEnv[CURRENT_DIRECTORY_GUARD] = "1";
  return childEnv;
}

// `shell: false` spawns `command` as given, never through cmd.exe, for callers whose
// arguments must not be interpreted by a shell. `status` is null when the child did not exit
// on its own, for example when a signal or the timeout ended it; `signal` then names the signal.
export function runCommand(command, args = [], options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const spawnPlan =
    options.shell === false
      ? { file: command, args, options: {} }
      : resolveCommand(command, args, options.env ?? process.env);
  const result = spawnSyncImpl(spawnPlan.file, spawnPlan.args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    timeout: options.timeout,
    stdio: options.stdio ?? "pipe",
    ...spawnPlan.options,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? null,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (!exitedCleanly(result)) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

function exitedCleanly(result) {
  return result.signal === null && result.status === 0;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (!exitedCleanly(result)) {
    const ending = result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
    const detail = result.stderr.trim() || result.stdout.trim() || ending;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function isProcessAlive(pid, killImpl = process.kill.bind(process)) {
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }
  // Zero and negative values address process groups on POSIX, including the caller's own.
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    throw new RangeError(`Refusing to terminate process ${pid}.`);
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const aliveBefore = isProcessAlive(pid, killImpl);
    const result = runCommandImpl(windowsSystemTool("taskkill", { env: options.env, platform }), ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    // taskkill exits 128 when a process it was asked to stop is not running, in every display
    // language. That is the root itself, or a tree member that exited while taskkill ran; only
    // a root that was running before and is gone now was stopped by this call.
    if (!result.error && result.status === 128) {
      const delivered = aliveBefore && !isProcessAlive(pid, killImpl);
      return { attempted: true, delivered, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    // taskkill /T lists the tree once and then stops each member. A member that exits in
    // between, such as a short git probe, makes taskkill exit non-zero; the kill still
    // succeeded when the root process is gone.
    if (!result.error && !isProcessAlive(pid, killImpl)) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  // A process that is not a group leader has no group of its own, so a failed group kill,
  // ESRCH included, falls back to signalling the process alone.
  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch {
    try {
      killImpl(pid, "SIGTERM");
      return { attempted: true, delivered: true, method: "process" };
    } catch (innerError) {
      if (innerError?.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "process" };
      }
      throw innerError;
    }
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}

// ---------------------------------------------------------------------------------------------
// Exact process identities and verified stops. A start token identifies one process for its
// lifetime: on Windows the creation time in ticks (UTC), on Linux `<boot id>:<start ticks>`.

// AGENT_PLUGIN_TEST_PROCESS: { stopFails, queryDelayMs, lookup: "unknown", stopCommandFails,
// unknownPidsOnce: [pid], heldProbeDelayMs }. `stopCommandFails` replaces the Windows stop
// command by a stop of the root alone that reports failure, standing for a failed command while
// the root exits by itself; `unknownPidsOnce` makes the first query of this process that includes
// those pids answer unknown for them; `heldProbeDelayMs` slows a held stop's probe (heldProbe);
// `windowsQuery: "powershell"` makes the Windows identity query skip the script host;
// `unknownPids: [pid]` makes every query answer unknown for those pids.
function processSeam() {
  try {
    return JSON.parse(process.env.AGENT_PLUGIN_TEST_PROCESS ?? "null") ?? {};
  } catch {
    return {};
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

function remainingUntil(deadline) {
  return deadline === undefined || deadline === null ? Infinity : deadline - performance.now();
}

let bootId = null;
const unknownPidsAnswered = new Set();

function readBootId() {
  if (bootId === null) {
    try {
      bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {
      bootId = "";
    }
  }
  return bootId;
}

// Fields of /proc/<pid>/stat after the command name: index 0 is field 3 (state).
function readLinuxStat(pid) {
  const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  return { state: fields[0], groupId: Number(fields[2]), startTicks: fields[19] };
}

function readLinuxIdentity(pid) {
  try {
    const stat = readLinuxStat(pid);
    if (stat.state === "Z" || stat.state === "X") {
      return { state: "absent" };
    }
    return { state: "present", startToken: `${readBootId()}:${stat.startTicks}`, groupId: stat.groupId };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") {
      return { state: "absent" };
    }
    return { state: "unknown", reason: error?.code === "EACCES" ? "denied" : String(error?.message ?? error) };
  }
}

// Runs a command asynchronously, stopping it (by the pid of the child this call started) when
// `timeoutMs` passes. With `deadline` (a `performance.now()` value) the time left is checked as the
// last step before the spawn: once it has passed nothing starts and the result is `late`, and the
// command never runs past it.
function runBounded(file, args, timeoutMs, deadline = undefined) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    testDelay("command");
    const limitMs = Math.min(timeoutMs, remainingUntil(deadline));
    if (!(limitMs > 0)) {
      resolve({ ok: false, reason: "late", stdout: "" });
      return;
    }
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const finish = (value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ...value, stderr });
      }
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The child may have exited between the timeout and the stop.
      }
      finish({ ok: false, reason: "timed out", stdout });
    }, Math.max(1, Math.floor(limitMs)));
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => finish({ ok: false, reason: String(error?.message ?? error), stdout }));
    child.on("close", (code) => finish(code === 0 ? { ok: true, stdout } : { ok: false, reason: `exit ${code}`, stdout }));
  });
}

/**
 * Whether a failed `taskkill /PID <rootPid> /T /F` still stopped the root's tree. A root that is
 * a batch-file wrapper (`cmd.exe` running one program) exits by itself the moment the command
 * stops its child, and the command then fails on the root, which it reports as not found. That
 * is a tree stop made by this command when both hold: its standard output reports a process
 * stopped as a child of the root, which proves the root was in the command's own listing, and
 * every line of its error output is about the root, so nothing else was left running. Only the
 * numbers are read, because the text around them is localised: on a success line the stopped
 * process comes first and its parent second, and an error line names the process it is about
 * first. A root that had exited before the command ran gives no success line, so it is never
 * credited.
 */
export function failedStopStoppedTree(rootPid, { stdout = "", stderr = "" } = {}) {
  const numbers = (line) => [...line.matchAll(/\d+/g)].map((match) => Number(match[0]));
  const lines = (text) =>
    String(text ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  const childStopped = lines(stdout).some((line) => {
    const [stopped, ...rest] = numbers(line);
    return stopped !== undefined && stopped !== rootPid && rest.includes(rootPid);
  });
  const onlyRootFailed = lines(stderr).every((line) => numbers(line)[0] === rootPid);
  return childStopped && onlyRootFailed;
}

// The Windows Script Host query of process-identity.jscript, beside this file.
const SCRIPT_HOST_QUERY = fileURLToPath(new URL("./process-identity.jscript", import.meta.url));
// True once the script host failed for a reason other than time (disabled by policy, missing):
// this process then asks PowerShell only.
let scriptHostFailed = false;

// The creation times of `ids` as lines "<pid> <ticks>", by the Windows Script Host: it answers in
// tens of milliseconds, where starting PowerShell alone takes about half a second of processor
// time. `ok` is false when the host did not run the query to its end.
async function queryScriptHost(ids, timeoutMs) {
  const result = await runBounded(windowsSystemTool("cscript.exe"), ["//nologo", "//E:JScript", SCRIPT_HOST_QUERY, ...ids.map(String)], timeoutMs);
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim());
  if (result.ok && lines.includes("done")) {
    return { ok: true, stdout: lines.filter((line) => line !== "done").join("\n") };
  }
  return { ok: false, reason: result.ok ? "the script host query did not finish" : result.reason, stdout: "" };
}

function queryPowerShell(ids, timeoutMs) {
  const filter = ids.map((pid) => `ProcessId=${pid}`).join(" OR ");
  const script =
    `Get-CimInstance Win32_Process -Filter '${filter}' | ` +
    'ForEach-Object { if ($_.CreationDate) { "$($_.ProcessId) $($_.CreationDate.ToUniversalTime().Ticks)" } else { "$($_.ProcessId) -" } }';
  return runBounded(windowsSystemTool("powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], timeoutMs);
}

// Both routes give the same token for one process (the creation time in UTC ticks), so a token
// recorded by one is confirmed by the other. `windowsQuery: "powershell"` in the test seam skips
// the script host.
async function readWindowsIdentities(ids, timeoutMs) {
  const started = performance.now();
  let result = null;
  if (!scriptHostFailed && processSeam().windowsQuery !== "powershell") {
    result = await queryScriptHost(ids, timeoutMs);
    if (!result.ok && result.reason !== "timed out" && result.reason !== "late") {
      scriptHostFailed = true;
      result = null;
    }
  }
  if (result === null) {
    const left = timeoutMs - (performance.now() - started);
    result = left > 0 ? await queryPowerShell(ids, left) : { ok: false, reason: "timed out", stdout: "" };
  }
  const identities = new Map();
  if (!result.ok) {
    for (const pid of ids) {
      identities.set(pid, { state: "unknown", reason: result.reason });
    }
    return identities;
  }
  const listed = new Map();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (match) {
      listed.set(Number(match[1]), match[2]);
    }
  }
  for (const pid of ids) {
    const token = listed.get(pid);
    if (token === undefined) {
      identities.set(pid, { state: "absent" });
    } else if (token === "-") {
      identities.set(pid, { state: "unknown", reason: "no creation time" });
    } else {
      identities.set(pid, { state: "present", startToken: token, groupId: null });
    }
  }
  return identities;
}

async function readPsIdentities(ids, timeoutMs) {
  const result = await runBounded("ps", ["-o", "pid=,pgid=,lstart=", "-p", ids.join(",")], timeoutMs);
  const identities = new Map();
  const listed = new Map();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) {
      listed.set(Number(match[1]), { groupId: Number(match[2]), startToken: match[3].replace(/\s+/g, " ") });
    }
  }
  const psFoundNone = !result.ok && result.reason === "exit 1" && listed.size === 0;
  for (const pid of ids) {
    const entry = listed.get(pid);
    if (entry) {
      identities.set(pid, { state: "present", ...entry });
    } else if (result.ok || psFoundNone) {
      identities.set(pid, { state: "absent" });
    } else {
      identities.set(pid, { state: "unknown", reason: result.reason });
    }
  }
  return identities;
}

/**
 * Reads the identities of `pids` in one batched query bounded by `deadline` (a
 * `performance.now()` value): `{ state: "present", startToken, groupId }`, `{ state: "absent" }`
 * or `{ state: "unknown", reason }`. A failed, denied or timed-out query makes every pid unknown.
 */
export async function readProcessIdentities(pids, { deadline = undefined } = {}) {
  const ids = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  const identities = new Map();
  if (ids.length === 0) {
    return identities;
  }
  boundary("process-query");
  const allUnknown = (reason) => {
    for (const pid of ids) {
      identities.set(pid, { state: "unknown", reason });
    }
    return identities;
  };
  const seam = processSeam();
  if (seam.lookup === "unknown") {
    return allUnknown("lookup unknown (AGENT_PLUGIN_TEST_PROCESS)");
  }
  const unknownOnce = (seam.unknownPidsOnce ?? []).filter((pid) => ids.includes(pid) && !unknownPidsAnswered.has(pid));
  unknownOnce.forEach((pid) => unknownPidsAnswered.add(pid));
  if (seam.queryDelayMs) {
    if (remainingUntil(deadline) <= seam.queryDelayMs) {
      await delay(remainingUntil(deadline));
      return allUnknown("timed out");
    }
    await delay(seam.queryDelayMs);
  }
  const remaining = remainingUntil(deadline);
  if (remaining <= 0) {
    return allUnknown("timed out");
  }
  let answered;
  if (process.platform === "linux") {
    answered = new Map(ids.map((pid) => [pid, readLinuxIdentity(pid)]));
  } else {
    const timeoutMs = Math.min(remaining, 30000);
    answered = await (process.platform === "win32" ? readWindowsIdentities(ids, timeoutMs) : readPsIdentities(ids, timeoutMs));
  }
  for (const pid of unknownOnce) {
    answered.set(pid, { state: "unknown", reason: "unknown once (AGENT_PLUGIN_TEST_PROCESS)" });
  }  for (const pid of (seam.unknownPids ?? []).filter((pid) => ids.includes(pid))) {
    answered.set(pid, { state: "unknown", reason: "unknown (AGENT_PLUGIN_TEST_PROCESS)" });
  }
  return answered;
}

/** The identity of one process; see readProcessIdentities. */
export async function readProcessIdentity(pid, options = {}) {
  const identities = await readProcessIdentities([pid], options);
  return identities.get(pid) ?? { state: "unknown", reason: "not a process id" };
}

/**
 * Compares a recorded identity with an observed one: `present` when the observed process has the
 * same start token, `absent` when it is gone or has another token, `unknown` otherwise, including
 * a recorded token that is null.
 */
export function confirmIdentity(recorded, observed) {
  if (!recorded || recorded.startToken === null || recorded.startToken === undefined) {
    return "unknown";
  }
  if (!observed || observed.state === "unknown") {
    return "unknown";
  }
  if (observed.state === "absent") {
    return "absent";
  }
  return String(observed.startToken) === String(recorded.startToken) ? "present" : "absent";
}

function ownGroupId() {
  if (process.platform !== "linux") {
    return null;
  }
  try {
    return readLinuxStat(process.pid).groupId;
  } catch {
    return null;
  }
}

/**
 * Stops a worker's or provider root's whole tree after verifying its exact identity: Windows
 * `taskkill /PID <pid> /T /F`; POSIX SIGKILL to its process group, only when the live group is
 * `expectedGroupId` and not the caller's own. Resolves to `stopped` only after the stop
 * succeeded; `absent`, `mismatch` and `unknown` stop nothing (a failed stop is `unknown`). With
 * `rootAlone` and no `expectedGroupId`, POSIX stops the verified root alone and resolves to
 * `root-stopped`, which is no tree stop. Nothing is signalled or started once `deadline` has
 * passed (`unknown`).
 */
export async function stopTree(identity, { deadline = undefined, expectedGroupId = null, rootAlone = false } = {}) {
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0 || identity.pid === process.pid) {
    return "unknown";
  }
  const observed = await readProcessIdentity(identity.pid, { deadline });
  const verdict = confirmIdentity(identity, observed);
  if (verdict !== "present") {
    return verdict === "absent" ? (observed.state === "present" ? "mismatch" : "absent") : "unknown";
  }
  if (processSeam().stopFails) {
    return "unknown";
  }
  // The identity read may have outlasted the deadline; no signal or command starts then.
  if (remainingUntil(deadline) <= 0) {
    return "unknown";
  }
  if (process.platform !== "win32") {
    if ((expectedGroupId === null || expectedGroupId === undefined) && rootAlone) {
      testDelay("tree-signal");
      if (remainingUntil(deadline) <= 0) {
        return "unknown";
      }
      try {
        process.kill(identity.pid, "SIGKILL");
        return "root-stopped";
      } catch (error) {
        return error?.code === "ESRCH" ? "absent" : "unknown";
      }
    }
    if (expectedGroupId === null || expectedGroupId === undefined || observed.groupId !== expectedGroupId || observed.groupId === ownGroupId()) {
      return "mismatch";
    }
    // The caller's own group was just read from /proc; the deadline is checked after it.
    testDelay("tree-signal");
    if (remainingUntil(deadline) <= 0) {
      return "unknown";
    }
    try {
      process.kill(-observed.groupId, "SIGKILL");
      return "stopped";
    } catch (error) {
      return error?.code === "ESRCH" ? "absent" : "unknown";
    }
  }
  const remaining = remainingUntil(deadline);
  if (remaining <= 0) {
    return "unknown";
  }
  const result = processSeam().stopCommandFails
    ? stopRootAloneForTest(identity.pid)
    : await runBounded(windowsSystemTool("taskkill"), ["/PID", String(identity.pid), "/T", "/F"], Math.min(remaining, 30000), deadline);
  if (result.ok) {
    return "stopped";
  }
  if (result.reason === "late") {
    return "unknown";
  }
  // The stop command failed. A root that is gone now exited by itself or was stopped by someone
  // else; that proves its exit only, never a tree stop, unless the command's own output shows it
  // stopped the root's child and failed on nothing but the root (failedStopStoppedTree).
  const after = await readProcessIdentity(identity.pid, { deadline: performance.now() + Math.max(500, remainingUntil(deadline)) });
  if (confirmIdentity(identity, after) !== "absent") {
    return "unknown";
  }
  return failedStopStoppedTree(identity.pid, result) ? "stopped" : "absent";
}

function stopRootAloneForTest(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  return { ok: false, reason: "exit 1", stdout: "" };
}

// ---------------------------------------------------------------------------------------------
// Verified tree stops of several processes from one batched identity query.

function stoppableTarget(identity) {
  return Boolean(identity) && Number.isInteger(identity.pid) && identity.pid > 0 && identity.pid !== process.pid;
}

// The POSIX stop of one verified target, as stopTree stops it after its identity read.
function stopVerifiedPosix(identity, observed, { deadline, expectedGroupId, rootAlone }) {
  if ((expectedGroupId === null || expectedGroupId === undefined) && rootAlone) {
    testDelay("tree-signal");
    if (remainingUntil(deadline) <= 0) {
      return "unknown";
    }
    try {
      process.kill(identity.pid, "SIGKILL");
      return "root-stopped";
    } catch (error) {
      return error?.code === "ESRCH" ? "absent" : "unknown";
    }
  }
  if (expectedGroupId === null || expectedGroupId === undefined || observed.groupId !== expectedGroupId || observed.groupId === ownGroupId()) {
    return "mismatch";
  }
  testDelay("tree-signal");
  if (remainingUntil(deadline) <= 0) {
    return "unknown";
  }
  try {
    process.kill(-observed.groupId, "SIGKILL");
    return "stopped";
  } catch (error) {
    return error?.code === "ESRCH" ? "absent" : "unknown";
  }
}

// The process ids a taskkill run reports as stopped: the first number on each line of its
// standard output, which carries only its successes (errors go to standard error). The text
// around the numbers is localised, so only the numbers are read. When any line of its error output
// does not name one of `rootPids` first, another process (a descendant) failed and may still run,
// so no pid is reported.
export function pidsReportedStopped({ stdout = "", stderr = "" } = {}, rootPids = []) {
  const pids = new Set();
  const errorLines = String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!errorLines.every((line) => rootPids.includes(Number(/\d+/.exec(line)?.[0])))) {
    return pids;
  }
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const match = /\d+/.exec(line);
    if (match) {
      pids.add(Number(match[0]));
    }
  }
  return pids;
}

/**
 * Stops several processes' trees, each only when its exact identity was verified in one batched
 * identity query, with stopTree's results (`stopped`, `root-stopped`, `absent`, `mismatch`,
 * `unknown`) in the order of `identities`. `expectedGroupIds[i]` is the POSIX group of
 * `identities[i]` (null for none); `rootAlone` applies to every target. On Windows one
 * `taskkill /PID <pid> ... /T /F` stops every verified target: exit 0 means all of them stopped;
 * otherwise a target stopped only when its pid is reported on the command's standard output and
 * its error output names no process but requested roots, and the rest are checked again in one batched query (absent or unknown, never a tree stop). The
 * deadline is checked as the last step before each signal or command start; past it nothing is
 * sent and the target is `unknown`.
 */
export async function stopTrees(identities, { deadline = undefined, expectedGroupIds = [], rootAlone = false } = {}) {
  const results = identities.map(() => "unknown");
  const candidates = identities.map((identity, index) => ({ identity, index })).filter(({ identity }) => stoppableTarget(identity));
  if (candidates.length === 0) {
    return results;
  }
  const observed = await readProcessIdentities(
    candidates.map(({ identity }) => identity.pid),
    { deadline }
  );
  const verified = [];
  for (const { identity, index } of candidates) {
    const seen = observed.get(identity.pid);
    const verdict = confirmIdentity(identity, seen);
    if (verdict === "absent") {
      results[index] = seen?.state === "present" ? "mismatch" : "absent";
    } else if (verdict === "present" && !processSeam().stopFails) {
      verified.push({ identity, index, observed: seen });
    }
  }
  if (verified.length === 0) {
    return results;
  }
  if (process.platform !== "win32") {
    for (const { identity, index, observed: seen } of verified) {
      results[index] = remainingUntil(deadline) <= 0 ? "unknown" : stopVerifiedPosix(identity, seen, { deadline, expectedGroupId: expectedGroupIds[index] ?? null, rootAlone });
    }
    return results;
  }
  const remaining = remainingUntil(deadline);
  if (remaining <= 0) {
    return results;
  }
  const command = await runBounded(
    windowsSystemTool("taskkill"),
    [...verified.flatMap(({ identity }) => ["/PID", String(identity.pid)]), "/T", "/F"],
    Math.min(remaining, 30000),
    deadline
  );
  if (command.ok) {
    for (const { index } of verified) {
      results[index] = "stopped";
    }
    return results;
  }
  if (command.reason === "late") {
    return results;
  }
  const reported = pidsReportedStopped(command, verified.map(({ identity }) => identity.pid));
  const unreported = verified.filter(({ identity, index }) => {
    if (reported.has(identity.pid)) {
      results[index] = "stopped";
      return false;
    }
    return true;
  });
  if (unreported.length > 0) {
    // A target the command did not report as stopped may have exited by itself; that proves its
    // exit only, never a tree stop.
    const after = await readProcessIdentities(
      unreported.map(({ identity }) => identity.pid),
      { deadline: performance.now() + Math.max(500, remainingUntil(deadline)) }
    );
    for (const { identity, index } of unreported) {
      results[index] = confirmIdentity(identity, after.get(identity.pid)) === "absent" ? "absent" : "unknown";
    }
  }
  return results;
}

// Signal 0 to the whole group: ESRCH means it has no member at all. The kernel answers for the
// group at one moment, so a member that forks and exits cannot hide from it.
function groupSignalAnswer(groupId) {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    return error?.code === "EPERM" ? true : "unknown";
  }
}

const GROUP_REAP_INTERVAL_MS = 50;
const GROUP_REAP_LIMIT_MS = 500;

/**
 * Whether a Linux process group has any member: true, false, or "unknown" when it cannot be told
 * or the platform is not Linux. The answer is the kernel's, for the whole group at one moment. A
 * member that just died counts until it is reaped, so an occupied group is asked again every
 * 50 ms for up to half a second, never past `deadline` (a `performance.now()` value).
 */
export async function groupHasMembers(groupId, { deadline = undefined } = {}) {
  if (process.platform !== "linux" || !Number.isInteger(groupId) || groupId <= 0) {
    return "unknown";
  }
  const until = Math.min(performance.now() + GROUP_REAP_LIMIT_MS, deadline ?? Infinity);
  let signal = groupSignalAnswer(groupId);
  while (signal === true && performance.now() + GROUP_REAP_INTERVAL_MS <= until) {
    await delay(GROUP_REAP_INTERVAL_MS);
    signal = groupSignalAnswer(groupId);
  }
  return signal;
}

function heldAndRunning(child) {
  return Boolean(child) && Number.isInteger(child.pid) && child.exitCode === null && child.signalCode === null;
}

/**
 * Whether a held, running ChildProcess leads a Linux process group of its own id. A group id is
 * the pid of the process that created the group, and a held child's pid cannot pass to another
 * process, so a group with that id is the child's; no identity query is needed. False off Linux.
 */
export function leadsOwnGroup(child) {
  if (process.platform !== "linux" || !heldAndRunning(child) || child.pid === process.pid) {
    return false;
  }
  return groupSignalAnswer(child.pid) === true;
}

// Resolves once a held child's exit event has been processed, or when `deadline` passes.
function heldExit(child, deadline) {
  if (!heldAndRunning(child)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve();
    }, Math.max(0, remainingUntil(deadline)));
    child.once("exit", onExit);
  });
}

// The liveness probe or identity read a held stop makes before its signal or command;
// `heldProbeDelayMs` in AGENT_PLUGIN_TEST_PROCESS makes it take that long, blocking, as a slow
// operating system answer would.
function heldProbe(read) {
  const delayMs = Number(processSeam().heldProbeDelayMs) || 0;
  if (delayMs > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  }
  return read();
}

// How long a POSIX held stop off Linux waits for the root's exit event to tell how it ended.
const HELD_EXIT_WAIT_MS = 1000;

/**
 * Stops a provider's tree through the ChildProcess its caller spawned and still holds, with no
 * identity query: the open handle keeps the pid from passing to another process. Windows runs
 * `taskkill /PID <pid> /T /F`; POSIX sends SIGKILL to the process group the child leads
 * (`groupId`, which must equal the child's pid). Resolves to `stopped` only when the stop
 * succeeded on a root that was running; `absent` when the root had already exited (its exit, not
 * a tree stop); `late` when no time was left before `deadline`, checked before any signal or
 * command on every platform, so nothing was sent; `unknown` when no tree stop could be made. A
 * POSIX child that does not lead its own group is stopped alone and the result is `unknown`.
 */
export async function stopHeldTree(child, { groupId = null, deadline = undefined } = {}) {
  if (!heldAndRunning(child) || child.pid === process.pid) {
    return heldAndRunning(child) ? "unknown" : "absent";
  }
  if (processSeam().stopFails) {
    return "unknown";
  }
  if (remainingUntil(deadline) <= 0) {
    return "late";
  }
  if (process.platform !== "win32") {
    if (groupId !== child.pid) {
      child.kill("SIGKILL");
      return "unknown";
    }
    // A root that exited and is not reaped yet still holds its group id, so the group signal is
    // safe and reaches what it left behind; it is the root's own exit, not a tree stop.
    const rootGone = process.platform === "linux" && heldProbe(() => readLinuxIdentity(child.pid).state === "absent");
    if (remainingUntil(deadline) <= 0) {
      return "late";
    }
    try {
      process.kill(-groupId, "SIGKILL");
    } catch (error) {
      return error?.code === "ESRCH" ? "absent" : "unknown";
    }
    if (process.platform === "linux") {
      return rootGone ? "absent" : "stopped";
    }
    // Elsewhere the held handle's exit tells it: a root killed by this signal was running at it,
    // and a root that ended any other way had already exited.
    await heldExit(child, Math.min(performance.now() + HELD_EXIT_WAIT_MS, deadline ?? Infinity));
    if (child.signalCode === "SIGKILL") {
      return "stopped";
    }
    return child.exitCode !== null || child.signalCode !== null ? "absent" : "unknown";
  }
  if (!heldProbe(() => isProcessAlive(child.pid))) {
    return "absent";
  }
  // The liveness probe may have outlasted the deadline; no command starts then.
  const remaining = remainingUntil(deadline);
  if (remaining <= 0) {
    return "late";
  }
  const result = processSeam().stopCommandFails
    ? stopRootAloneForTest(child.pid)
    : await runBounded(windowsSystemTool("taskkill"), ["/PID", String(child.pid), "/T", "/F"], Math.min(remaining, 30000), deadline);
  if (result.reason === "late") {
    return "late";
  }
  if (result.ok) {
    return "stopped";
  }
  // A failed command on a root that is gone now proves its exit only, never a tree stop, unless
  // the command's own output shows it stopped the root's child and failed on nothing but the root.
  if (isProcessAlive(child.pid)) {
    return "unknown";
  }
  return failedStopStoppedTree(child.pid, result) ? "stopped" : "absent";
}

/** The Linux process group of this process, or null elsewhere. */
export function currentGroupId() {
  return ownGroupId();
}
