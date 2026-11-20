import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// Absolute paths for the programs the plugin starts on Windows. A program started by its bare name
// may be looked up in the working folder before PATH on some Node versions, so a repository could
// plant `git.exe` or `taskkill.exe` for the plugin to run. The system tools live under the Windows
// folder, read from the environment because the system drive is not always the same, and git is
// searched on PATH with every entry that depends on the working folder skipped. When nothing
// resolves, the bare name is returned as given, so a working installation never breaks. Off Windows
// every function returns the bare name unchanged.

export const BATCH_FILE = /\.(cmd|bat)$/i;

// The folders under the Windows folder that hold each system tool, by its name without `.exe`.
const SYSTEM_TOOL_FOLDERS = {
  cmd: ["System32"],
  cscript: ["System32"],
  powershell: ["System32", "WindowsPowerShell", "v1.0"],
  taskkill: ["System32"]
};

const defaultCache = new Map();

// Windows variable names are case-insensitive, and one env object can hold several
// spellings of a name (an inherited `Path` next to an added `PATH`). Node hands a child
// the spelling that sorts first, so lookups here read that same spelling.
export function readWindowsEnv(env, name) {
  const keys = Object.keys(env)
    .filter((key) => key.toUpperCase() === name)
    .sort();
  return keys.length > 0 ? env[keys[0]] : undefined;
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

// A path that names one place whatever the current folder and drive: a drive letter followed by a
// separator, or a UNC path. `\Windows` (the current drive) and `C:Windows` (the current folder of
// drive C) do not qualify.
function isFullWindowsPath(value) {
  return typeof value === "string" && /^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/])/.test(value);
}

function sameWindowsFolder(left, right) {
  const normalize = (value) => path.win32.normalize(value).replace(/[\\/]+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}

/**
 * The file `command` runs on Windows, looked up through PATH and PATHEXT, or null. A command with
 * a folder in it is checked as given. A PATH entry that is empty, relative or the working folder
 * `cwd` is skipped, because a lookup there finds what the working folder holds. With
 * `acceptBatch: false` a `.cmd` or `.bat` file is passed over, for callers that start the result
 * without a shell.
 */
export function findWindowsExecutable(command, env, { cwd = process.cwd(), fileExists = isFile, acceptBatch = true } = {}) {
  const extensions = path.win32.extname(command)
    ? [""]
    : (readWindowsEnv(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const directories = /[\\/]/.test(command)
    ? [""]
    : (readWindowsEnv(env, "PATH") || "")
        .split(";")
        .filter((directory) => isFullWindowsPath(directory) && !(cwd && sameWindowsFolder(directory, cwd)));
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.win32.join(directory, command) + extension;
      if (!acceptBatch && BATCH_FILE.test(candidate)) {
        continue;
      }
      // A missing candidate is skipped; the search continues with the next one.
      if (fileExists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function usesDefaults({ env, platform, cwd, fileExists }) {
  return (env === undefined || env === process.env) && (platform === undefined || platform === process.platform) && cwd === undefined && fileExists === undefined;
}

function cached(key, options, resolve) {
  if (!usesDefaults(options)) {
    return resolve();
  }
  if (!defaultCache.has(key)) {
    defaultCache.set(key, resolve());
  }
  return defaultCache.get(key);
}

/**
 * The absolute path of a Windows system tool (`taskkill`, `cscript`, `cmd` or `powershell`, with or
 * without `.exe`) under `SystemRoot`, or `windir` when that does not hold it. For `cmd` an absolute
 * `COMSPEC` that exists comes first. A value is used only when it is a full path and the tool file exists there;
 * otherwise `name` comes back as given. Never throws.
 */
export function windowsSystemTool(name, options = {}) {
  const { env = process.env, platform = process.platform, fileExists = isFile } = options;
  if (platform !== "win32") {
    return name;
  }
  return cached(`tool:${name}`, options, () => {
    try {
      const base = String(name).toLowerCase().replace(/\.exe$/, "");
      const folders = SYSTEM_TOOL_FOLDERS[base];
      if (!folders) {
        return name;
      }
      if (base === "cmd") {
        const comspec = readWindowsEnv(env, "COMSPEC");
        if (isFullWindowsPath(comspec) && fileExists(comspec)) {
          return comspec;
        }
      }
      for (const variable of ["SYSTEMROOT", "WINDIR"]) {
        const root = readWindowsEnv(env, variable);
        if (isFullWindowsPath(root)) {
          const candidate = path.win32.join(root, ...folders, `${base}.exe`);
          if (fileExists(candidate)) {
            return candidate;
          }
        }
      }
    } catch {
      // An unreadable environment or file check leaves the bare name.
    }
    return name;
  });
}

/**
 * The absolute path of the git executable on Windows: the first `git` with a PATHEXT extension in a
 * full-path PATH entry that is not the working folder `cwd`. A `git.cmd` shim is passed over,
 * because git is started without a shell. Bare `git` when none is found, and off Windows. Never
 * throws.
 */
export function gitExecutable(options = {}) {
  const { env = process.env, platform = process.platform, cwd = process.cwd(), fileExists = isFile } = options;
  if (platform !== "win32") {
    return "git";
  }
  return cached("git", options, () => {
    try {
      return findWindowsExecutable("git", env, { cwd, fileExists, acceptBatch: false }) ?? "git";
    } catch {
      return "git";
    }
  });
}
