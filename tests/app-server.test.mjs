import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AppServerClientBase,
  CodexAppServerClient,
  SpawnedCodexAppServerClient
} from "../plugins/agent/scripts/providers/codex/app-server.mjs";
import { isProcessAlive } from "../plugins/agent/scripts/lib/process.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir, waitUntil } from "./helpers.mjs";

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

test("handleServerRequest accepts MCP elicitation requests instead of rejecting them", () => {
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

test("form-mode elicitation requests are declined instead of accepted with empty content", () => {
  for (const mode of ["form", "openai/form"]) {
    const client = new CapturingClient();
    client.handleServerRequest({
      id: 9,
      method: "mcpServer/elicitation/request",
      params: { threadId: "t1", mode }
    });
    assert.deepEqual(client.sent, [{ id: 9, result: { action: "decline" } }]);
  }

  const urlClient = new CapturingClient();
  urlClient.handleServerRequest({
    id: 10,
    method: "mcpServer/elicitation/request",
    params: { threadId: "t1", mode: "url" }
  });
  assert.deepEqual(urlClient.sent, [{ id: 10, result: { action: "accept", content: null, _meta: null } }]);
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
