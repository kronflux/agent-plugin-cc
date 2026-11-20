import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  binaryAvailable,
  readProcessCommandLines,
  resolveCommand,
  runCommand,
  runCommandChecked,
  terminateProcessTree
} from "../plugins/agent/scripts/lib/process.mjs";

const windowsOnly = { skip: process.platform !== "win32" && "Windows command resolution" };

function missingProcessKill() {
  throw Object.assign(new Error("no such process"), { code: "ESRCH" });
}

function writeArgvBatch(dir, name) {
  const script = path.join(dir, "print-argv.cjs");
  fs.writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  fs.writeFileSync(path.join(dir, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0print-argv.cjs" %*\r\n`);
}

test("resolveCommand leaves commands unchanged off Windows", () => {
  assert.deepEqual(resolveCommand("codex", ["app-server"], {}, "linux"), {
    file: "codex",
    args: ["app-server"],
    options: {}
  });
});

test("resolveCommand runs a Windows executable directly", windowsOnly, () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "codex.exe"), "");
  const plan = resolveCommand("codex", ["app-server"], { PATH: dir, PATHEXT: ".EXE;.CMD" });
  assert.equal(plan.file.toLowerCase(), path.join(dir, "codex.exe").toLowerCase());
  assert.deepEqual(plan.args, ["app-server"]);
  assert.deepEqual(plan.options, {});
});

test("resolveCommand reads the PATH spelling a child process receives", windowsOnly, () => {
  const inherited = makeTempDir();
  const added = makeTempDir();
  fs.writeFileSync(path.join(inherited, "codex.exe"), "");
  fs.writeFileSync(path.join(added, "codex.exe"), "");
  const plan = resolveCommand("codex", [], { Path: inherited, PATH: added, PATHEXT: ".EXE" });
  assert.equal(path.dirname(plan.file).toLowerCase(), added.toLowerCase());
});

test("resolveCommand ignores SHELL", windowsOnly, () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "codex.exe"), "");
  const env = { PATH: dir, PATHEXT: ".EXE" };
  assert.deepEqual(resolveCommand("codex", ["x"], { ...env, SHELL: "C:\\missing\\bash.exe" }), resolveCommand("codex", ["x"], env));
});

test("runCommand passes arguments to a batch file unchanged", windowsOnly, () => {
  const dir = makeTempDir();
  writeArgvBatch(dir, "echo-args");
  const result = runCommand("echo-args", ["a b", "x&y", "plain"], {
    env: { ...process.env, PATH: `${dir};${process.env.PATH}`, SHELL: "C:\\missing\\bash.exe" }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["a b", "x&y", "plain"]);
});

test("runCommand refuses batch-file arguments cmd.exe would alter", windowsOnly, () => {
  const dir = makeTempDir();
  writeArgvBatch(dir, "echo-args");
  assert.throws(
    () => runCommand("echo-args", ["%PATH%"], { env: { ...process.env, PATH: `${dir};${process.env.PATH}` } }),
    /Cannot pass an argument containing %/
  );
});

test("terminateProcessTree refuses process-group and own PIDs", () => {
  assert.throws(() => terminateProcessTree(0), RangeError);
  assert.throws(() => terminateProcessTree(-5), RangeError);
  assert.throws(() => terminateProcessTree(process.pid), RangeError);
  assert.deepEqual(terminateProcessTree(null), { attempted: false, delivered: false, method: null });
});

test("terminateProcessTree reports delivery when taskkill fails after the root exited", () => {
  let probes = 0;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "",
        stderr: "ERROR: The process with PID 4321 (child process of PID 1234) could not be terminated.",
        error: null
      };
    },
    // The root is running when taskkill starts and gone once it returns.
    killImpl(pid, signal) {
      assert.equal(signal, 0);
      probes += 1;
      if (probes > 1) {
        missingProcessKill();
      }
    }
  });

  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree reports a taskkill failure while the root is alive", () => {
  assert.throws(
    () =>
      terminateProcessTree(1234, {
        platform: "win32",
        runCommandImpl(command, args) {
          return { command, args, status: 1, signal: null, stdout: "", stderr: "ERROR: Access is denied.", error: null };
        },
        killImpl() {}
      }),
    /Access is denied/
  );
});

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    },
    killImpl: missingProcessKill
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("a localized taskkill message for a missing process is not delivered", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "",
        stderr: "FEHLER: Der Prozess wurde nicht gefunden.",
        error: null
      };
    },
    killImpl() {}
  });

  assert.equal(outcome.delivered, false);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree signals the process when its group is gone", () => {
  const calls = [];
  const outcome = terminateProcessTree(1234, {
    platform: "linux",
    killImpl(pid, signal) {
      calls.push([pid, signal]);
      if (pid < 0) {
        missingProcessKill();
      }
    }
  });

  assert.deepEqual(calls, [
    [-1234, "SIGTERM"],
    [1234, "SIGTERM"]
  ]);
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "process");
});

test("a child ended by a signal is a failure", () => {
  const spawnSyncImpl = () => ({ status: null, signal: "SIGTERM", stdout: "", stderr: "" });
  const result = runCommand(process.execPath, ["-e", "0"], { shell: false, spawnSyncImpl });
  assert.equal(result.status, null);
  assert.equal(result.signal, "SIGTERM");
  assert.throws(() => runCommandChecked(process.execPath, ["-e", "0"], { shell: false, spawnSyncImpl }), /signal=SIGTERM/);
  assert.equal(binaryAvailable(process.execPath, ["--version"], { shell: false, spawnSyncImpl }).available, false);
});

test("readProcessCommandLines counts a vanished Linux process as not running", () => {
  const reads = {
    "/proc/11/cmdline": () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    "/proc/12/cmdline": () => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    },
    "/proc/13/cmdline": () => "",
    "/proc/14/cmdline": () => "node\0worker.mjs\0"
  };
  const found = readProcessCommandLines([11, 12, 13, 14], {
    platform: "linux",
    readFileImpl: (file) => reads[file]()
  });
  assert.deepEqual([...found], [[14, "node worker.mjs"]]);
});

test("resolveCommand turns off delayed expansion for batch files", windowsOnly, () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "codex.cmd"), "");
  const plan = resolveCommand("codex", ["a!b"], { PATH: dir, PATHEXT: ".EXE;.CMD" }, "win32");
  assert.deepEqual(plan.args.slice(0, 4), ["/d", "/v:off", "/s", "/c"]);
});

test("a batch-file argument with a space and a trailing backslash reaches the batch file unchanged", windowsOnly, () => {
  const dir = makeTempDir();
  writeArgvBatch(dir, "echo-args");
  const input = ["C:\\dir with space\\", "a!b!c", "C:\\plain\\", "last"];
  const result = runCommand("echo-args", input, {
    env: { ...process.env, PATH: `${dir};${process.env.PATH}` }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), input);
});
