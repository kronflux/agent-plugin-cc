import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, stopOwnedProcesses } from "./helpers.mjs";
import { startHelperProcess } from "./store-fixtures.mjs";
import {
  binaryAvailable,
  readProcessIdentities,
  readProcessIdentity,
  resolveCommand,
  runCommand,
  runCommandChecked,
  stopTree,
  terminateProcessTree
} from "../plugins/agent/scripts/lib/process.mjs";
import { leaderState } from "../plugins/agent/scripts/lib/state.mjs";
import * as processLib from "../plugins/agent/scripts/lib/process.mjs";

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

// Copies an environment without NoDefaultCurrentDirectoryInExePath in any spelling.
function envWithoutCurrentDirectoryGuard(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== "NODEFAULTCURRENTDIRECTORYINEXEPATH"));
}

test("a batch file that calls bare node does not run a node.cmd from the working folder", windowsOnly, () => {
  const shimDir = makeTempDir();
  const plantDir = makeTempDir();
  fs.writeFileSync(path.join(shimDir, "real.cjs"), 'process.stdout.write("real node");\n');
  fs.writeFileSync(path.join(shimDir, "node-shim.cmd"), '@echo off\r\nnode "%~dp0real.cjs" %*\r\n');
  const marker = path.join(plantDir, "planted-ran.txt");
  fs.writeFileSync(path.join(plantDir, "node.cmd"), `@echo off\r\necho planted> "${marker}"\r\n`);
  const env = envWithoutCurrentDirectoryGuard(process.env);
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = `${shimDir};${path.dirname(process.execPath)};${env[pathKey] ?? ""}`;

  const result = runCommand("node-shim", [], { cwd: plantDir, env });

  assert.equal(fs.existsSync(marker), false, "the planted node.cmd ran");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "real node");
});

test("a batch-file plan sets NoDefaultCurrentDirectoryInExePath and keeps the rest of the environment", windowsOnly, () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "codex.cmd"), "");
  const plan = resolveCommand("codex", [], { PATH: dir, PATHEXT: ".EXE;.CMD", nodefaultcurrentdirectoryinexepath: "", KEEP: "yes" }, "win32");
  assert.equal(plan.options.env.NoDefaultCurrentDirectoryInExePath, "1");
  assert.equal(plan.options.env.nodefaultcurrentdirectoryinexepath, undefined);
  assert.equal(plan.options.env.KEEP, "yes");
  assert.equal(plan.options.env.PATH, dir);
});

// ---------------------------------------------------------------------------------------------
// Exact identities and verified stops

function bumpToken(token) {
  const match = /^(.*?)(\d+)$/.exec(token);
  return `${match[1]}${(BigInt(match[2]) + 1n).toString()}`;
}

async function waitAbsent(pids, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const identities = await readProcessIdentities(pids, { deadline: performance.now() + 5000 });
    if (pids.every((pid) => identities.get(pid)?.state === "absent")) {
      return true;
    }
    if (Date.now() > until) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Stops the helper's child through its recorded identity and the helper through its handle.
function stopHelper(helper) {
  const child = helper.childPid ? [{ pid: helper.childPid, startToken: helper.childStartToken }] : [];
  return stopOwnedProcesses([...child, helper.process]);
}

test("stopTree stops nothing when the token differs by one unit", async (t) => {
  const helper = await startHelperProcess();
  t.after(() => stopHelper(helper));
  const observed = await readProcessIdentity(helper.pid, { deadline: performance.now() + 5000 });
  assert.equal(observed.state, "present");
  const reused = { pid: helper.pid, startToken: bumpToken(observed.startToken) };
  assert.equal(await stopTree(reused, { deadline: performance.now() + 5000, expectedGroupId: observed.groupId }), "mismatch");
  assert.equal((await readProcessIdentity(helper.pid, { deadline: performance.now() + 5000 })).state, "present");
});

test("stopTree stops a verified helper process and its child", async (t) => {
  const helper = await startHelperProcess({ child: true });
  t.after(() => stopHelper(helper));
  assert.ok(helper.childPid, "the helper did not report its child");
  const observed = await readProcessIdentity(helper.pid, { deadline: performance.now() + 5000 });
  const identity = { pid: helper.pid, startToken: observed.startToken };
  const result = await stopTree(identity, { deadline: performance.now() + 10000, expectedGroupId: observed.groupId });
  assert.equal(result, "stopped");
  assert.equal(await waitAbsent([helper.pid, helper.childPid]), true);
  assert.equal(await stopTree(identity, { deadline: performance.now() + 5000, expectedGroupId: observed.groupId }), "absent");
});

test("a batched identity query of 20 processes finishes within 1,500 ms on Windows", { timeout: 120000 }, async (t) => {
  const helpers = [];
  t.after(() => Promise.all(helpers.map(stopHelper)));
  for (let index = 0; index < 20; index += 1) {
    helpers.push(await startHelperProcess());
  }
  const started = performance.now();
  const identities = await readProcessIdentities(
    helpers.map((helper) => helper.pid),
    { deadline: performance.now() + 10000 }
  );
  const elapsed = performance.now() - started;
  t.diagnostic(`batched identity query of 20 processes on ${process.platform}: ${Math.round(elapsed)} ms`);
  assert.ok(helpers.every((helper) => identities.get(helper.pid)?.state === "present"));
  if (process.platform === "win32") {
    assert.ok(elapsed <= 1500, `the query took ${Math.round(elapsed)} ms`);
  }
});

test("leaderState answers none, unknown, gone and alive", async (t) => {
  const helper = await startHelperProcess();
  t.after(() => stopHelper(helper));
  const observed = await readProcessIdentity(helper.pid, { deadline: performance.now() + 5000 });
  const row = (fields) => ({ row: { leader_pid: helper.pid, leader_start_token: observed.startToken, ...fields } });
  assert.equal(leaderState(row({ leader_pid: null }), observed), "none");
  assert.equal(leaderState(row({ leader_start_token: null }), observed), "unknown");
  assert.equal(leaderState(row({}), { state: "unknown", reason: "timed out" }), "unknown");
  assert.equal(leaderState(row({}), observed), "alive");
  assert.equal(leaderState(row({ leader_start_token: bumpToken(observed.startToken) }), observed), "gone");
  assert.equal(leaderState(row({}), { state: "absent" }), "gone");
});

// The identities of helpers read in one query: `{ pid, startToken }` and the group id of each.
async function verifiedIdentities(helpers) {
  const observed = await readProcessIdentities(
    helpers.map((helper) => helper.pid),
    { deadline: performance.now() + 10000 }
  );
  return helpers.map((helper) => {
    const identity = observed.get(helper.pid);
    assert.equal(identity?.state, "present");
    return { identity: { pid: helper.pid, startToken: identity.startToken }, groupId: identity.groupId };
  });
}

test("stopTrees stops the verified targets and leaves a mismatched one alone", { timeout: 60000 }, async (t) => {
  const helpers = [await startHelperProcess({ child: true }), await startHelperProcess({ child: true }), await startHelperProcess()];
  t.after(() => Promise.all(helpers.map(stopHelper)));
  assert.ok(helpers[0].childPid && helpers[1].childPid, "the helpers did not report their children");
  const verified = await verifiedIdentities(helpers);
  const targets = verified.map(({ identity }) => identity);
  targets[2] = { ...targets[2], startToken: bumpToken(targets[2].startToken) };

  const results = await processLib.stopTrees(targets, {
    deadline: performance.now() + 10000,
    expectedGroupIds: verified.map(({ groupId }) => groupId)
  });

  assert.deepEqual(results, ["stopped", "stopped", "mismatch"]);
  assert.equal(await waitAbsent([helpers[0].pid, helpers[0].childPid, helpers[1].pid, helpers[1].childPid]), true);
  assert.equal((await readProcessIdentity(helpers[2].pid, { deadline: performance.now() + 5000 })).state, "present");
});

test("stopTrees starts nothing once its deadline has passed", { timeout: 60000 }, async (t) => {
  const helpers = [await startHelperProcess(), await startHelperProcess()];
  t.after(() => Promise.all(helpers.map(stopHelper)));
  const verified = await verifiedIdentities(helpers);
  const targets = verified.map(({ identity }) => identity);
  const expectedGroupIds = verified.map(({ groupId }) => groupId);

  // A deadline already spent: nothing is read or stopped.
  assert.deepEqual(await processLib.stopTrees(targets, { deadline: performance.now() - 1, expectedGroupIds }), ["unknown", "unknown"]);

  // A deadline that passes after the identities were verified and before the stop starts: the
  // check right before each signal or command start refuses it.
  const previous = process.env.AGENT_PLUGIN_TEST_DELAYS;
  process.env.AGENT_PLUGIN_TEST_DELAYS = JSON.stringify({ command: 3500, "tree-signal": 3500 });
  try {
    assert.deepEqual(await processLib.stopTrees(targets, { deadline: performance.now() + 3000, expectedGroupIds }), ["unknown", "unknown"]);
  } finally {
    if (previous === undefined) {
      delete process.env.AGENT_PLUGIN_TEST_DELAYS;
    } else {
      process.env.AGENT_PLUGIN_TEST_DELAYS = previous;
    }
  }
  const after = await readProcessIdentities(
    helpers.map((helper) => helper.pid),
    { deadline: performance.now() + 10000 }
  );
  assert.ok(helpers.every((helper) => after.get(helper.pid)?.state === "present"), "a helper was stopped after the deadline");
});

test("both Windows identity routes give one token for one process", { ...windowsOnly, timeout: 60000 }, async (t) => {
  const helper = await startHelperProcess();
  t.after(() => stopHelper(helper));
  const saved = process.env.AGENT_PLUGIN_TEST_PROCESS;
  t.after(() => {
    if (saved === undefined) {
      delete process.env.AGENT_PLUGIN_TEST_PROCESS;
    } else {
      process.env.AGENT_PLUGIN_TEST_PROCESS = saved;
    }
  });
  const pids = [helper.pid, process.pid, 4000000];
  const read = async () => {
    const started = performance.now();
    const identities = await readProcessIdentities(pids, { deadline: performance.now() + 20000 });
    return { identities, elapsed: Math.round(performance.now() - started) };
  };
  delete process.env.AGENT_PLUGIN_TEST_PROCESS;
  const fast = await read();
  process.env.AGENT_PLUGIN_TEST_PROCESS = JSON.stringify({ windowsQuery: "powershell" });
  const slow = await read();
  t.diagnostic(`script host ${fast.elapsed} ms, PowerShell ${slow.elapsed} ms`);
  for (const pid of [helper.pid, process.pid]) {
    assert.equal(fast.identities.get(pid).state, "present");
    assert.match(fast.identities.get(pid).startToken, /^\d{18}$/);
    assert.equal(fast.identities.get(pid).startToken, slow.identities.get(pid).startToken, `pid ${pid}`);
  }
  assert.deepEqual(fast.identities.get(4000000), { state: "absent" });
  assert.deepEqual(slow.identities.get(4000000), { state: "absent" });
});

test("a failed stop command is a tree stop only when it stopped the root's child and failed on the root alone", () => {
  const { failedStopStoppedTree } = processLib;
  // The two lines the command printed for a wrapper root's children when the whole stop succeeded.
  const children =
    "SUCCESS: The process with PID 4340 (child process of PID 37808) has been terminated.\r\n" +
    "SUCCESS: The process with PID 32348 (child process of PID 37808) has been terminated.";
  // What it printed for a root that had already exited before it ran.
  const rootNotFound = 'ERROR: The process "37808" not found.';
  assert.equal(failedStopStoppedTree(37808, { stdout: children, stderr: rootNotFound }), true);
  assert.equal(failedStopStoppedTree(37808, { stdout: children, stderr: "" }), true);
  // A root that exited before the command ran: no child was stopped by this command.
  assert.equal(failedStopStoppedTree(37808, { stdout: "", stderr: rootNotFound }), false);
  // Another process could not be stopped, so something may still run.
  assert.equal(
    failedStopStoppedTree(37808, {
      stdout: children,
      stderr: `${rootNotFound}\r\nERROR: The process with PID 5000 (child process of PID 4340) could not be terminated.`
    }),
    false
  );
  // Only the root's own success line: nothing shows a child of the root.
  assert.equal(
    failedStopStoppedTree(37808, { stdout: "SUCCESS: The process with PID 37808 (child process of PID 25964) has been terminated.", stderr: "" }),
    false
  );
  // The same lines in another language keep their numbers and their order.
  assert.equal(
    failedStopStoppedTree(37808, {
      stdout: "ERFOLGREICH: Der Prozess mit PID 4340 (untergeordneter Prozess von PID 37808) wurde beendet.",
      stderr: 'FEHLER: Der Prozess "37808" wurde nicht gefunden.'
    }),
    true
  );
  assert.equal(failedStopStoppedTree(37808, {}), false);
});

test("a failed batched stop credits a root only when its error output names requested roots alone", () => {
  const { pidsReportedStopped } = processLib;
  assert.equal(typeof pidsReportedStopped, "function");
  const rootStopped = "SUCCESS: The process with PID 37808 (child process of PID 25964) has been terminated.";
  // A descendant of the reported root survived: nothing is credited from the output.
  const childFailed = "ERROR: The process with PID 5000 (child process of PID 37808) could not be terminated.";
  assert.deepEqual([...pidsReportedStopped({ stdout: rootStopped, stderr: childFailed }, [37808, 41000])], []);
  // The error output is about another requested root only: the reported root is credited.
  const otherRootMissing = 'FEHLER: Der Prozess "41000" wurde nicht gefunden.';
  assert.deepEqual([...pidsReportedStopped({ stdout: rootStopped, stderr: otherRootMissing }, [37808, 41000])], [37808]);
  assert.deepEqual([...pidsReportedStopped({ stdout: rootStopped, stderr: "" }, [37808, 41000])], [37808]);
  // An error line with no number cannot be read as about a requested root.
  assert.deepEqual([...pidsReportedStopped({ stdout: rootStopped, stderr: "ERROR: Access denied." }, [37808])], []);
});
