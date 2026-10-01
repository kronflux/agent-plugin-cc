import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import { parseBrokerEndpoint } from "../plugins/agent/scripts/lib/broker-endpoint.mjs";
import {
  ensureBrokerSession,
  requestBrokerShutdownIfIdle,
  sendBrokerShutdown
} from "../plugins/agent/scripts/lib/broker-lifecycle.mjs";
import { isProcessAlive } from "../plugins/agent/scripts/lib/process.mjs";

const LIFECYCLE_MODULE = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "agent", "scripts", "lib", "broker-lifecycle.mjs")
).href;

async function waitUntil(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

// Starts a broker for a fresh workspace with the fake Codex on PATH.
async function startBroker(t, extraEnv = {}) {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = { ...buildEnv(binDir), ...extraEnv };
  const session = await ensureBrokerSession(workspace, { env });
  assert.ok(session, "the broker did not start");
  t.after(() => sendBrokerShutdown(session.endpoint));
  return { session, binDir, env, workspace };
}

function connect(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: parseBrokerEndpoint(endpoint).path });
    socket.setEncoding("utf8");
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

// Sends JSON-RPC requests on one connection and resolves with each result in order.
async function rpc(socket, requests) {
  const results = [];
  let buffer = "";
  for (const [index, { method, params }] of requests.entries()) {
    socket.write(`${JSON.stringify({ id: index + 1, method, params })}\n`);
    results.push(
      await new Promise((resolve) => {
        const onData = (chunk) => {
          buffer += chunk;
          for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
            const message = JSON.parse(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            if (message.id === index + 1) {
              socket.off("data", onData);
              resolve(message.result ?? message.error);
              return;
            }
          }
        };
        socket.on("data", onData);
      })
    );
  }
  return results;
}

test("the broker exits after its idle timeout and removes its PID file", async (t) => {
  const { session } = await startBroker(t, { CODEX_BROKER_IDLE_MS: "500" });
  assert.equal(isProcessAlive(session.pid), true);

  assert.equal(await waitUntil(() => !isProcessAlive(session.pid)), true, "the broker kept running");
  assert.equal(fs.existsSync(session.pidFile), false);
});

test("a connected client keeps the broker running past the idle timeout", async (t) => {
  const { session } = await startBroker(t, { CODEX_BROKER_IDLE_MS: "500" });
  const socket = await connect(session.endpoint);

  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(isProcessAlive(session.pid), true);

  socket.destroy();
  assert.equal(await waitUntil(() => !isProcessAlive(session.pid)), true, "the broker kept running");
});

test("a broker with another client refuses to stop when asked to stop if idle", async (t) => {
  const { session } = await startBroker(t);
  const other = await connect(session.endpoint);

  assert.equal(await requestBrokerShutdownIfIdle(session.endpoint), "busy");
  assert.equal(isProcessAlive(session.pid), true);

  other.destroy();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await requestBrokerShutdownIfIdle(session.endpoint), "stopped");
  assert.equal(await waitUntil(() => !isProcessAlive(session.pid)), true);
});

test("a shutdown request to an endpoint that never answers returns", async () => {
  const dir = makeTempDir();
  const endpoint =
    process.platform === "win32" ? `pipe:\\\\.\\pipe\\${path.basename(dir)}-silent` : `unix:${path.join(dir, "silent.sock")}`;
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(parseBrokerEndpoint(endpoint).path, resolve));
  try {
    const started = Date.now();
    assert.equal(await requestBrokerShutdownIfIdle(endpoint), "unreachable");
    assert.ok(Date.now() - started < 8000);
  } finally {
    server.close();
  }
});

test("threads a client loaded are unloaded when it disconnects", async (t) => {
  const { session, binDir } = await startBroker(t);
  const socket = await connect(session.endpoint);
  const [started] = await rpc(socket, [{ method: "thread/start", params: { cwd: makeTempDir() } }]);
  socket.destroy();

  const statePath = path.join(binDir, "fake-codex-state.json");
  const unloaded = await waitUntil(() =>
    (JSON.parse(fs.readFileSync(statePath, "utf8")).unsubscribedThreads ?? []).includes(started.thread.id)
  );
  assert.equal(unloaded, true, "the thread stayed loaded");
});

test("a live broker that misses the quick probe is reused", async (t) => {
  const { session, workspace, env } = await startBroker(t);
  const probes = [];
  let spawned = 0;

  const reused = await ensureBrokerSession(workspace, {
    env,
    async probeEndpoint(_endpoint, timeoutMs) {
      probes.push(timeoutMs);
      return probes.length > 1;
    },
    scriptPath: path.join(makeTempDir(), "never-started.mjs"),
    createBrokerEndpoint() {
      spawned += 1;
      return session.endpoint;
    }
  });

  assert.equal(reused.pid, session.pid);
  assert.equal(spawned, 0);
  assert.equal(probes.length, 2);
  assert.ok(probes[1] > probes[0]);
});

test(
  "stopping a job process tree leaves the shared broker running",
  { skip: process.platform !== "win32" && "Windows process trees" },
  async (t) => {
    const workspace = makeTempDir();
    const binDir = makeTempDir();
    installFakeCodex(binDir);
    // Stands in for a task worker: it starts the broker, prints its PID, and keeps running.
    const source =
      `import { ensureBrokerSession } from ${JSON.stringify(LIFECYCLE_MODULE)};\n` +
      `const session = await ensureBrokerSession(${JSON.stringify(workspace)});\n` +
      "process.stdout.write(JSON.stringify(session) + '\\n');\n" +
      "setInterval(() => {}, 1000);\n";
    const worker = spawn(process.execPath, ["--input-type=module", "-e", source], {
      env: buildEnv(binDir),
      stdio: ["ignore", "pipe", "inherit"]
    });
    const session = await new Promise((resolve) => {
      let output = "";
      worker.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("\n")) {
          resolve(JSON.parse(output));
        }
      });
    });
    t.after(() => sendBrokerShutdown(session.endpoint));
    assert.ok(session.pid);

    spawnSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"]);

    assert.equal(await waitUntil(() => !isProcessAlive(worker.pid), 5000), true);
    assert.equal(isProcessAlive(session.pid), true, "the broker was stopped with the worker");
  }
);
