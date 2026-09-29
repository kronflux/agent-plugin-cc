import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { resolveCommand, runCommand, terminateProcessTree } from "../plugins/agent/scripts/lib/process.mjs";

const windowsOnly = { skip: process.platform !== "win32" && "Windows command resolution" };

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
    killImpl(pid, signal) {
      assert.equal(signal, 0);
      const error = new Error("no such process");
      error.code = "ESRCH";
      throw error;
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
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});
