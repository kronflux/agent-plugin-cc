import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AppServerClientBase,
  CodexAppServerClient,
  SpawnedCodexAppServerClient
} from "../plugins/agent/scripts/providers/codex/app-server.mjs";
import { isProcessAlive } from "../plugins/agent/scripts/lib/process.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir, stopOwnedProcesses, waitUntil } from "./helpers.mjs";

/** Minimal client that records the JSON-RPC messages it would send. */
class CapturingClient extends AppServerClientBase {
  constructor() {
    super(process.cwd());
    this.sent = [];
  }
  sendMessage(message) {
    this.sent.push(message);
  }
}

test("an elicitation request with no mode is accepted with empty content", () => {
  const client = new CapturingClient();
  client.handleServerRequest({
    id: 7,
    method: "mcpServer/elicitation/request",
    params: { threadId: "t1" }
  });
  assert.deepEqual(client.sent, [
    { id: 7, result: { action: "accept", content: null, _meta: null } }
  ]);
});

test("handleServerRequest still rejects unknown server requests with -32601", () => {
  const client = new CapturingClient();
  client.handleServerRequest({ id: 8, method: "some/unknown/request", params: {} });
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].id, 8);
  assert.equal(client.sent[0].result, undefined);
  assert.equal(client.sent[0].error.code, -32601);
});

for (const mode of ["form", "openai/form", "openaiForm", "url"]) {
  test(`an elicitation request in ${mode} mode is declined`, () => {
    const client = new CapturingClient();
    client.handleServerRequest({
      id: 9,
      method: "mcpServer/elicitation/request",
      params: { threadId: "t1", mode }
    });
    assert.deepEqual(client.sent, [{ id: 9, result: { action: "decline" } }]);
  });
}

test("an elicitation request with an unknown mode is accepted with empty content", () => {
  const client = new CapturingClient();
  client.handleServerRequest({
    id: 10,
    method: "mcpServer/elicitation/request",
    params: { threadId: "t1", mode: "some-future-mode" }
  });
  assert.deepEqual(client.sent, [{ id: 10, result: { action: "accept", content: null, _meta: null } }]);
});

// The non-interactive runner has no operator, so every approval request must be
// answered with that request type's own refusal variant. The generated types
// disagree on shape: the v1 approvals take a `ReviewDecision` whose refusal is
// `{ denied: { rejection } }`, the v2 item approvals take a plain `"decline"`
// enum with no room for a reason, and `PermissionsRequestApprovalResponse` has
// no refusal variant at all — granting nothing is its fail-closed answer.
const DENIAL_REASON = "Non-interactive Codex runner: no operator to approve.";

test("v1 approval requests are answered with the ReviewDecision denied variant", () => {
  for (const [id, method] of [
    [21, "execCommandApproval"],
    [22, "applyPatchApproval"]
  ]) {
    const client = new CapturingClient();
    client.handleServerRequest({ id, method, params: { threadId: "t1" } });
    assert.deepEqual(client.sent, [
      { id, result: { decision: { denied: { rejection: DENIAL_REASON } } } }
    ]);
  }
});

test("v2 item approval requests are answered with the decline decision", () => {
  for (const [id, method] of [
    [23, "item/commandExecution/requestApproval"],
    [24, "item/fileChange/requestApproval"]
  ]) {
    const client = new CapturingClient();
    client.handleServerRequest({ id, method, params: { threadId: "t1" } });
    assert.deepEqual(client.sent, [{ id, result: { decision: "decline" } }]);
  }
});

test("permission approval requests grant nothing for the turn", () => {
  const client = new CapturingClient();
  client.handleServerRequest({
    id: 25,
    method: "item/permissions/requestApproval",
    params: { threadId: "t1", permissions: { network: { enabled: true } } }
  });
  assert.deepEqual(client.sent, [{ id: 25, result: { permissions: {}, scope: "turn" } }]);
});

function readFakeState(binDir) {
  return JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
}

test("a request after the connection exited rejects instead of hanging", { timeout: 2000 }, async () => {
  const client = new CapturingClient();
  client.handleExit(new Error("gone"));
  const outcome = await Promise.race([
    client.request("thread/list", {}).then(
      () => "resolved",
      (error) => error
    ),
    new Promise((resolve) => setTimeout(() => resolve("still pending"), 1000))
  ]);
  assert.ok(outcome instanceof Error, `expected a rejection, got ${String(outcome)}`);
  assert.match(outcome.message, /gone|closed/);
  assert.equal(client.pending.size, 0);
});

test("request on a closed client returns a rejected promise and never throws", async () => {
  const client = new CapturingClient();
  client.closed = true;
  let promise;
  assert.doesNotThrow(() => {
    promise = client.request("thread/list", {});
  });
  assert.ok(promise instanceof Promise);
  await assert.rejects(promise, /closed/);
});

test("a line that is not JSON closes the client", async () => {
  const client = new CapturingClient();
  client.handleLine("not json");
  assert.equal(client.closed, true);
  await assert.rejects(client.request("thread/list", {}), /closed|parse/i);
});

test("a failed initialize closes the app server it started", async (t) => {
  const binDir = makeTempDir(t);
  const cwd = makeTempDir(t);
  installFakeCodex(binDir, "initialize-fails");
  await assert.rejects(
    CodexAppServerClient.connect(cwd, { env: buildEnv(binDir) }),
    /initialize failed/
  );
  const pids = readFakeState(binDir).appServerPids;
  assert.equal(pids.length, 1);
  await waitUntil(() => !isProcessAlive(pids[0]), { timeoutMs: 5000, describe: "fake app server exit" });
});

// On POSIX the write after the fake closed its stdin fails with EPIPE. On Windows the fake runs
// behind a cmd.exe shim that keeps the pipe open, so both requests reject through the exit path.
test("a write while a request is pending and the app server's stdin is gone rejects instead of crashing", { timeout: 20000 }, async (t) => {
  const uncaught = [];
  const spy = (error) => uncaught.push(error);
  process.on("uncaughtException", spy);
  t.after(() => process.off("uncaughtException", spy));

  const binDir = makeTempDir(t);
  const cwd = makeTempDir(t);
  installFakeCodex(binDir, "close-stdin-on-turn");
  const client = await CodexAppServerClient.connect(cwd, { env: buildEnv(binDir) });
  t.after(() => client.close());
  let stdinClosed = null;
  client.setNotificationHandler((notification) => {
    if (notification.method === "fake/stdinClosed") {
      stdinClosed = notification.params;
    }
  });

  const { thread } = await client.request("thread/start", { cwd });
  const turnOutcome = client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "hello" }] }).then(
    () => null,
    (error) => error
  );
  const closed = await waitUntil(() => stdinClosed, { timeoutMs: 5000, describe: "fake/stdinClosed notification" });
  const interruptOutcome = await client
    .request("turn/interrupt", { threadId: thread.id, turnId: closed.turnId })
    .then(
      () => null,
      (error) => error
    );

  assert.ok(interruptOutcome instanceof Error, "turn/interrupt should reject");
  assert.match(interruptOutcome.message, /stdin failed|exited/);
  const turnError = await turnOutcome;
  assert.ok(turnError instanceof Error, "turn/start should reject");
  assert.match(turnError.message, /stdin failed|exited/);
  assert.deepEqual(uncaught, []);
});

test("a throwing notification handler does not stop later responses", async () => {
  const client = new CapturingClient();
  const handlerError = new Error("handler broke");
  client.setNotificationHandler(() => {
    throw handlerError;
  });
  const response = client.request("thread/list", {});
  const id = client.sent[0].id;
  const lines = [{ method: "turn/started", params: {} }, { id, result: { data: [] } }];
  assert.doesNotThrow(() => {
    client.handleChunk(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  });
  assert.deepEqual(await response, { data: [] });
  assert.equal(client.lastHandlerError, handlerError);
  assert.equal(client.closed, false);
});

/** A child-process stand-in whose kill() calls are recorded instead of delivered. */
function makeStubProcess({ onEnd, onKill } = {}) {
  const stub = {
    pid: 999999,
    exitCode: null,
    signalCode: null,
    killed: false,
    kills: [],
    stdin: {
      end() {
        onEnd?.(stub);
      }
    },
    kill(signal) {
      stub.kills.push(signal);
      stub.killed = true;
      onKill?.(stub, signal);
      return true;
    }
  };
  return stub;
}

test("close does not label its own exit as unexpected", async () => {
  const client = new SpawnedCodexAppServerClient(process.cwd());
  // The stub exits with a non-zero code as soon as its stdin ends, before any timer fires.
  client.proc = makeStubProcess({
    onEnd(stub) {
      stub.exitCode = 1;
      setImmediate(() => client.handleProcessExit(1, null));
    }
  });
  await client.close();
  assert.equal(client.exitError, null);
  assert.deepEqual(client.proc.kills, []);
});

test(
  "close escalates to SIGKILL when SIGTERM is ignored",
  {
    timeout: 10000,
    skip: process.platform === "win32" ? "Windows stops the process tree with taskkill /F instead of signals" : false
  },
  async (t) => {
    const client = new SpawnedCodexAppServerClient(process.cwd());
    client.proc = makeStubProcess({
      onKill(stub, signal) {
        if (signal === "SIGKILL") {
          stub.signalCode = "SIGKILL";
          setImmediate(() => client.handleProcessExit(null, "SIGKILL"));
        }
      }
    });
    // close() uses unref'd timers; this keeps the event loop alive while the test waits, and
    // the after-hook clears it even when the test times out.
    const keepAlive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(keepAlive));
    await client.close();
    assert.deepEqual(client.proc.kills, ["SIGTERM", "SIGKILL"]);
  }
);

for (const line of ["null", "42", '"text"', "[]"]) {
  test(`a line that parses to ${line} is a protocol error that closes the client`, async () => {
    const client = new CapturingClient();
    const pending = client.request("thread/list", {});
    assert.doesNotThrow(() => client.handleLine(line));
    assert.equal(client.closed, true);
    await assert.rejects(pending, /codex app-server sent a line that is not a JSON-RPC message/);
  });
}

/**
 * A child-process stand-in with real stdout and stderr streams, for attachProcess. Messages the
 * client writes to stdin are recorded in `written`.
 */
function makeStreamProcess() {
  const proc = new EventEmitter();
  proc.pid = 999998;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.written = [];
  proc.stdin = new EventEmitter();
  proc.stdin.write = (line) => {
    proc.written.push(JSON.parse(line));
    return true;
  };
  proc.stdin.end = () => {};
  proc.kill = () => true;
  return proc;
}

test("a stdin error rejects pending requests instead of crashing", async () => {
  const client = new SpawnedCodexAppServerClient(process.cwd());
  const proc = makeStreamProcess();
  client.attachProcess(proc);
  const pending = client.request("thread/list", {});

  assert.doesNotThrow(() => proc.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));

  await assert.rejects(pending, /codex app-server stdin failed: write EPIPE/);
  assert.equal(client.closed, true);
});

test("a response written just before the app server exits is still delivered", async () => {
  const client = new SpawnedCodexAppServerClient(process.cwd());
  const proc = makeStreamProcess();
  client.attachProcess(proc);
  const pending = client.request("thread/list", {});
  const id = proc.written[0].id;

  // The exit event can arrive before stdout has been read to its end.
  proc.exitCode = 0;
  proc.emit("exit", 0, null);
  proc.stdout.end(`${JSON.stringify({ id, result: { data: ["last"] } })}\n`);
  await new Promise((resolve) => proc.stdout.once("end", resolve));
  await new Promise((resolve) => setImmediate(resolve));
  proc.emit("close", 0, null);

  assert.deepEqual(await pending, { data: ["last"] });
});

test("close after a stdin error still waits for the app server to exit", { timeout: 15000 }, async (t) => {
  const client = new SpawnedCodexAppServerClient(process.cwd(), { terminateProcessTree: () => ({ delivered: true }) });
  const proc = makeStreamProcess();
  let ended = false;
  proc.stdin.end = () => {
    ended = true;
    // The app server exits a little later, once it sees its input end.
    setTimeout(() => {
      proc.exitCode = 0;
      proc.emit("exit", 0, null);
      proc.stdout.end();
      proc.stderr.end();
      setImmediate(() => proc.emit("close", 0, null));
    }, 200);
  };
  client.attachProcess(proc);
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  proc.stdin.emit("error", new Error("write EPIPE"));
  assert.equal(client.closed, true);

  await client.close();

  assert.equal(ended, true);
  assert.equal(proc.exitCode, 0, "close returned before the app server exited");
});

test("a failed tree stop on close is reported, not swallowed", { timeout: 15000, skip: process.platform !== "win32" && "Windows stops the tree with taskkill" }, async (t) => {
  const client = new SpawnedCodexAppServerClient(process.cwd(), {
    terminateProcessTree: () => {
      throw new Error("taskkill refused");
    }
  });
  const proc = makeStreamProcess();
  client.attachProcess(proc);
  const warnings = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    warnings.push(String(chunk));
    return true;
  };
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => {
    clearInterval(keepAlive);
    process.stderr.write = originalWrite;
  });

  await client.close();
  process.stderr.write = originalWrite;

  assert.match(client.stopError?.message ?? "", /taskkill refused/);
  assert.match(warnings.join(""), /codex app-server process 999998 could not be stopped: taskkill refused/);
});

test("an auth check ends its app-server and stops it by identity when it lingers", { timeout: 30000 }, async (t) => {
  // The fake records each app server's identity; whatever the check leaves running is stopped
  // through those identities when the test ends, before its folders are removed.
  let binDir = null;
  t.after(async () => {
    const identities = binDir && fs.existsSync(path.join(binDir, "fake-codex-state.json")) ? (readFakeState(binDir).processIdentities ?? []) : [];
    await stopOwnedProcesses(identities.map(({ pid, startToken }) => ({ pid, startToken })), { tree: true });
  });
  binDir = makeTempDir(t);
  const cwd = makeTempDir(t);
  installFakeCodex(binDir, "ignore-eof", { recordIdentities: true });
  const { getCodexAuthStatus } = await import("../plugins/agent/scripts/providers/codex/runtime.mjs");
  await getCodexAuthStatus(cwd, { env: buildEnv(binDir) });
  const returnedAt = Date.now();
  const state = readFakeState(binDir);
  assert.equal(state.appServerPids.length, 1);
  assert.ok(state.stdinEndedAt, "the auth check did not end the app server's input");
  // The app server gets 2 seconds to exit by itself after its input ended, then it is stopped.
  const lingered = returnedAt - state.stdinEndedAt;
  t.diagnostic(`the app server was stopped ${lingered} ms after its input ended`);
  assert.ok(lingered >= 1900, `the app server was stopped ${lingered} ms after its input ended`);
  assert.ok(lingered <= 2500 + 1000, `the app server lingered ${lingered} ms`);
  const { readProcessIdentity } = await import("../plugins/agent/scripts/lib/process.mjs");
  const after = await readProcessIdentity(state.appServerPids[0], { deadline: performance.now() + 15000 });
  assert.equal(after.state, "absent", "the lingering app server still runs after the auth check");
});
