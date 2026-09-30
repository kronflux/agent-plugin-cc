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
// altered.
function quoteForCmd(value) {
  const text = String(value);
  if (/[%"\r\n]/.test(text)) {
    throw new Error(`Cannot pass an argument containing %, ", or a line break to a batch file: ${text}`);
  }
  return text === "" || /[\s&|<>^(),;=!]/.test(text) ? `"${text}"` : text;
}

/**
 * Returns how to spawn `command` without a shell choosing the interpreter. On Windows the
 * command is looked up through PATH and PATHEXT: an executable runs directly with its
 * argument array, and a batch file (such as an npm-installed `codex.cmd`) runs through
 * `%ComSpec%`, because Node refuses to start batch files without one. `SHELL` is never read.
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
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    options: { windowsVerbatimArguments: true }
  };
}

// `shell: false` spawns `command` as given, never through cmd.exe, for callers whose
// arguments must not be interpreted by a shell.
export function runCommand(command, args = [], options = {}) {
  const spawnPlan =
    options.shell === false
      ? { file: command, args, options: {} }
      : resolveCommand(command, args, options.env ?? process.env);
  const result = spawnSync(spawnPlan.file, spawnPlan.args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    ...spawnPlan.options,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
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
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
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
  const ids = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  const found = new Map();
  if (ids.length === 0) {
    return found;
  }

  if (platform === "linux") {
    for (const pid of ids) {
      try {
        found.set(pid, fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim());
      } catch (error) {
        if (error?.code !== "ENOENT") {
          return null;
        }
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
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
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

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
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

    return { attempted: true, delivered: false, method: "process-group" };
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
