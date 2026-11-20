import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { findWindowsExecutable, gitExecutable, windowsSystemTool } from "../plugins/agent/scripts/lib/system-tools.mjs";
import { runCommand } from "../plugins/agent/scripts/lib/process.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(ROOT, "plugins", "agent", "scripts");

// A file check that answers true only for the listed paths, compared without case as Windows does.
function filesAt(...paths) {
  const known = new Set(paths.map((entry) => entry.toLowerCase()));
  return (candidate) => known.has(candidate.toLowerCase());
}

const win32 = { platform: "win32" };

test("system tools resolve under SystemRoot, any spelling, then windir", () => {
  const fileExists = filesAt(
    "D:\\WinNT\\System32\\taskkill.exe",
    "D:\\WinNT\\System32\\cscript.exe",
    "D:\\WinNT\\System32\\cmd.exe",
    "D:\\WinNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "E:\\Win\\System32\\taskkill.exe"
  );
  const env = { SystemRoot: "D:\\WinNT" };
  assert.equal(windowsSystemTool("taskkill.exe", { ...win32, env, fileExists }), "D:\\WinNT\\System32\\taskkill.exe");
  assert.equal(windowsSystemTool("taskkill", { ...win32, env, fileExists }), "D:\\WinNT\\System32\\taskkill.exe");
  assert.equal(windowsSystemTool("cscript.exe", { ...win32, env, fileExists }), "D:\\WinNT\\System32\\cscript.exe");
  assert.equal(windowsSystemTool("cmd.exe", { ...win32, env, fileExists }), "D:\\WinNT\\System32\\cmd.exe");
  assert.equal(
    windowsSystemTool("powershell.exe", { ...win32, env, fileExists }),
    "D:\\WinNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  );
  assert.equal(windowsSystemTool("taskkill.exe", { ...win32, env: { systemroot: "D:\\WinNT" }, fileExists }), "D:\\WinNT\\System32\\taskkill.exe");
  assert.equal(windowsSystemTool("taskkill.exe", { ...win32, env: { windir: "E:\\Win" }, fileExists }), "E:\\Win\\System32\\taskkill.exe");
});

test("cmd takes an absolute COMSPEC that exists first and ignores a relative or missing one", () => {
  const fileExists = filesAt("D:\\WinNT\\System32\\cmd.exe", "F:\\Shells\\cmd.exe");
  assert.equal(
    windowsSystemTool("cmd.exe", { ...win32, env: { COMSPEC: "G:\\Gone\\cmd.exe", SystemRoot: "D:\\WinNT" }, fileExists }),
    "D:\\WinNT\\System32\\cmd.exe"
  );
  assert.equal(
    windowsSystemTool("cmd.exe", { ...win32, env: { ComSpec: "F:\\Shells\\cmd.exe", SystemRoot: "D:\\WinNT" }, fileExists }),
    "F:\\Shells\\cmd.exe"
  );
  assert.equal(windowsSystemTool("cmd.exe", { ...win32, env: { COMSPEC: "cmd.exe", SystemRoot: "D:\\WinNT" }, fileExists }), "D:\\WinNT\\System32\\cmd.exe");
  assert.equal(windowsSystemTool("cmd.exe", { ...win32, env: { COMSPEC: "tools\\cmd.exe" }, fileExists }), "cmd.exe");
});

test("an unusable SystemRoot or a missing tool file gives the bare name", () => {
  const fileExists = filesAt("D:\\WinNT\\System32\\taskkill.exe", "WinNT\\System32\\taskkill.exe", "\\WinNT\\System32\\taskkill.exe");
  for (const env of [{}, { SystemRoot: "" }, { SystemRoot: "WinNT" }, { SystemRoot: "\\WinNT" }, { SystemRoot: "D:WinNT" }, { SystemRoot: ".\\WinNT" }]) {
    assert.equal(windowsSystemTool("taskkill.exe", { ...win32, env, fileExists }), "taskkill.exe", JSON.stringify(env));
    assert.equal(windowsSystemTool("taskkill", { ...win32, env, fileExists }), "taskkill", JSON.stringify(env));
  }
  assert.equal(windowsSystemTool("cscript.exe", { ...win32, env: { SystemRoot: "D:\\WinNT" }, fileExists }), "cscript.exe");
  assert.equal(windowsSystemTool("powershell.exe", { ...win32, env: { SystemRoot: "D:\\WinNT" }, fileExists }), "powershell.exe");
  assert.equal(
    windowsSystemTool("taskkill.exe", {
      ...win32,
      env: { SystemRoot: "D:\\WinNT" },
      fileExists() {
        throw new Error("file check failed");
      }
    }),
    "taskkill.exe"
  );
});

test("gitExecutable skips PATH entries that depend on the working folder", () => {
  const cwd = "D:\\repo";
  const fileExists = filesAt(
    ".\\git.exe",
    "git.exe",
    "tools\\git.exe",
    "D:\\repo\\git.exe",
    "D:\\Repo\\git.exe",
    "E:\\Program Files\\Git\\cmd\\git.exe",
    "F:\\later\\git.exe"
  );
  const env = { PATH: ".;;tools;D:\\Repo\\;E:\\empty;E:\\Program Files\\Git\\cmd;F:\\later", PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  assert.equal(gitExecutable({ ...win32, env, cwd, fileExists }), "E:\\Program Files\\Git\\cmd\\git.EXE");
  assert.equal(gitExecutable({ ...win32, env: { PATH: ".;;tools;D:\\repo", PATHEXT: ".EXE" }, cwd, fileExists }), "git");
  assert.equal(gitExecutable({ ...win32, env: {}, cwd, fileExists }), "git");
});

test("gitExecutable passes over a git.cmd shim, which cannot start without a shell", () => {
  const fileExists = filesAt("E:\\shim\\git.cmd", "F:\\Git\\bin\\git.exe");
  const env = { Path: "E:\\shim;F:\\Git\\bin", PATHEXT: ".CMD;.EXE" };
  assert.equal(gitExecutable({ ...win32, env, cwd: "D:\\repo", fileExists }), "F:\\Git\\bin\\git.EXE");
  assert.equal(gitExecutable({ ...win32, env: { PATH: "E:\\shim", PATHEXT: ".CMD;.EXE" }, cwd: "D:\\repo", fileExists }), "git");
  assert.equal(findWindowsExecutable("git", { PATH: "E:\\shim", PATHEXT: ".CMD;.EXE" }, { cwd: "D:\\repo", fileExists }), "E:\\shim\\git.CMD");
});

test("off Windows every function returns the bare name", () => {
  const env = { SystemRoot: "D:\\WinNT", PATH: "E:\\Git", COMSPEC: "F:\\cmd.exe" };
  const fileExists = () => true;
  for (const name of ["taskkill", "taskkill.exe", "cscript.exe", "cmd.exe", "powershell.exe"]) {
    assert.equal(windowsSystemTool(name, { platform: "linux", env, fileExists }), name);
  }
  assert.equal(gitExecutable({ platform: "linux", env, cwd: "/repo", fileExists }), "git");
  if (process.platform !== "win32") {
    assert.equal(windowsSystemTool("taskkill"), "taskkill");
    assert.equal(gitExecutable(), "git");
  }
});

function sourceFiles(folder) {
  const files = [];
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const absolute = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "dist") {
        files.push(...sourceFiles(absolute));
      }
    } else if (entry.isFile() && /\.(mjs|cjs|js)$/.test(entry.name)) {
      files.push(absolute);
    }
  }
  return files;
}

test("no script starts git or a Windows system tool by its bare name", () => {
  const start = /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|runCommand|runCommandChecked|runCommandImpl|runBounded|binaryAvailable|resolveCommand)\(\s*(["'`])(git|taskkill|cscript\.exe|powershell\.exe)\1/g;
  const offenders = [];
  for (const file of sourceFiles(SCRIPTS)) {
    if (path.basename(file) === "system-tools.mjs") {
      continue;
    }
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(start)) {
      const line = source.slice(0, match.index).split("\n").length;
      offenders.push(`${path.relative(SCRIPTS, file)}:${line} ${match[2]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("git still runs through lib/git.mjs on this machine", { timeout: 60000 }, () => {
  if (process.platform === "win32") {
    assert.ok(path.win32.isAbsolute(gitExecutable()), gitExecutable());
  }
  const version = runCommand(gitExecutable(), ["--version"], { shell: false, timeout: 30000 });
  assert.equal(version.status, 0, version.stderr || String(version.error));
  assert.match(version.stdout, /^git version /);

  const gitModule = pathToFileURL(path.join(SCRIPTS, "lib", "git.mjs")).href;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `const m = await import(${JSON.stringify(gitModule)}); process.stdout.write(m.getRepoRoot(process.argv[1]));`, ROOT],
    { encoding: "utf8", timeout: 30000, windowsHide: true }
  );
  assert.equal(child.status, 0, child.stderr || String(child.error));
  assert.equal(path.resolve(child.stdout.trim()).toLowerCase(), ROOT.toLowerCase());
});
