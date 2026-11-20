import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const BATCH_FILE = /\.(cmd|bat)$/i;

// Windows variable names are case-insensitive, and one env object can hold several
// spellings of a name (an inherited `Path` next to an added `PATH`). Node hands a child
// the spelling that sorts first, so lookups here read that same spelling.
function readWindowsEnv(env, name) {
  const keys = Object.keys(env)
    .filter((key) => key.toUpperCase() === name)
    .sort();
  return keys.length > 0 ? env[keys[0]] : undefined;
}

function findWindowsExecutable(command, env) {
  const extensions = path.win32.extname(command)
    ? [""]
    : (readWindowsEnv(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const directories = /[\\/]/.test(command)
    ? [""]
    : (readWindowsEnv(env, "PATH") || "").split(";").filter(Boolean);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.win32.join(directory, command) + extension;
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // A missing candidate is skipped; the search continues with the next one.
      }
    }
  }
  return null;
}

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
    file: readWindowsEnv(env, "COMSPEC") || "cmd.exe",
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

/**
 * Returns a Map from PID to command line for the listed processes that are running, or null
 * when the lookup itself failed. A PID missing from the Map is not running.
 */
export function readProcessCommandLines(pids, options = {}) {
  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const readFileImpl = options.readFileImpl ?? fs.readFileSync;
  const ids = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  const found = new Map();
  if (ids.length === 0) {
    return found;
  }

  // A process that exits while its /proc entry is read gives ENOENT or ESRCH, and a zombie has
  // an empty command line; each counts as not running.
  if (platform === "linux") {
    for (const pid of ids) {
      let commandLine;
      try {
        commandLine = String(readFileImpl(`/proc/${pid}/cmdline`, "utf8")).split("\0").join(" ").trim();
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ESRCH") {
          continue;
        }
        return null;
      }
      if (commandLine) {
        found.set(pid, commandLine);
      }
    }
    return found;
  }

  const lookup =
    platform === "win32"
      ? runCommandImpl("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Get-CimInstance Win32_Process -Filter '${ids.map((pid) => `ProcessId=${pid}`).join(" OR ")}' | ` +
            'ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }'
        ])
      : runCommandImpl("ps", ["-o", "pid=,command=", "-p", ids.join(",")]);
  // ps exits 1 when none of the processes exist, which is a valid answer.
  const psFoundNone = platform !== "win32" && lookup.status === 1 && !lookup.stdout.trim();
  if (lookup.error || (lookup.status !== 0 && !psFoundNone)) {
    return null;
  }
  for (const line of lookup.stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s?(.*)$/.exec(line);
    if (match) {
      found.set(Number(match[1]), match[2].trim());
    }
  }
  return found;
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
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
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
