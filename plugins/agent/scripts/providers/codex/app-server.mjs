/**
 * @typedef {Error & { data?: unknown, rpcCode?: number }} ProtocolError
 * @typedef {import("./app-server-protocol").AppServerMethod} AppServerMethod
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").AppServerNotificationHandler} AppServerNotificationHandler
 * @typedef {import("./app-server-protocol").ClientInfo} ClientInfo
 * @typedef {import("./app-server-protocol").CodexAppServerClientOptions} CodexAppServerClientOptions
 * @typedef {import("./app-server-protocol").InitializeCapabilities} InitializeCapabilities
 */
import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.mjs";
import { resolveCommand, terminateProcessTree } from "../../lib/process.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;

const NON_INTERACTIVE_DENIAL_REASON = "Non-interactive Codex runner: no operator to approve.";

/** @type {ClientInfo} */
const DEFAULT_CLIENT_INFO = {
  title: "Codex Plugin",
  name: "Claude Code",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

/** @type {InitializeCapabilities} */
const DEFAULT_CAPABILITIES = {
  experimentalApi: false,
  requestAttestation: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

export class AppServerClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    // The last error a notification handler threw; line processing continues after it.
    this.lastHandlerError = null;
    /** @type {AppServerNotificationHandler | null} */
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";
    // The server's `initialize` result: userAgent, codexHome, platformFamily, platformOs.
    this.serverInfo = null;

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  /**
   * @template {AppServerMethod} M
   * @param {M} method
   * @param {import("./app-server-protocol").AppServerRequestParams<M>} params
   * @returns {Promise<import("./app-server-protocol").AppServerResponse<M>>}
   */
  request(method, params) {
    if (this.closed) {
      return Promise.reject(this.createClosedError());
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this.sendMessage({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  createClosedError() {
    const cause = this.exitError;
    return new Error(
      cause ? `codex app-server client is closed: ${cause.message}` : "codex app-server client is closed.",
      cause ? { cause } : undefined
    );
  }

  // Overridden by transports that own a process or socket; the base only marks the client closed.
  async close() {
    this.closed = true;
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse codex app-server JSONL: ${error.message}`, { line }));
      // A stream that is not JSONL cannot be resynchronised, so the transport is ended too.
      this.close().catch(() => {});
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `codex app-server ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      // A throwing handler must not stop the lines after it, which may answer pending requests.
      try {
        this.notificationHandler(/** @type {AppServerNotification} */ (message));
      } catch (error) {
        this.lastHandlerError = error;
      }
    }
  }

  // Every thread and turn this plugin starts sends `approvalPolicy: "never"`, read-only and
  // `--write` runs alike, so app-server is not expected to ask for approval. An approval request
  // that still arrives is answered fail-closed rather than rejected with -32601, which would
  // make the turn error out or hang. This client runs Codex non-interactively, with no operator
  // to ask, so every approval is answered with that request type's own refusal variant. The
  // generated types disagree on shape: the v1 approvals take
  // a `ReviewDecision` (refusal `{ denied: { rejection } }`), the v2 item
  // approvals take a plain `"decline"` enum with no room for a reason, and
  // `PermissionsRequestApprovalResponse` has no refusal variant at all, so
  // granting nothing for the turn is its fail-closed answer.
  handleServerRequest(message) {
    switch (message.method) {
      case "execCommandApproval":
      case "applyPatchApproval":
        this.sendMessage({
          id: message.id,
          result: { decision: { denied: { rejection: NON_INTERACTIVE_DENIAL_REASON } } }
        });
        return;

      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        this.sendMessage({ id: message.id, result: { decision: "decline" } });
        return;

      case "item/permissions/requestApproval":
        this.sendMessage({ id: message.id, result: { permissions: {}, scope: "turn" } });
        return;

      // MCP servers (e.g. ChatGPT connectors surfaced as `codex_apps`) ask for the
      // operator's consent through an elicitation. A request whose `mode` is `form` or
      // `openai/form` expects structured content back, which this runner cannot supply,
      // so it is declined. Every other request is accepted with `content: null`: that
      // includes `url` mode, the `openaiForm` spelling, and a request with no `mode`.
      // They are accepted because declining them blocks the MCP tool call that raised
      // them, and a delegated run has no operator who could answer instead.
      case "mcpServer/elicitation/request": {
        const mode = message.params?.mode;
        if (mode === "form" || mode === "openai/form") {
          this.sendMessage({ id: message.id, result: { action: "decline" } });
          return;
        }
        this.sendMessage({
          id: message.id,
          result: { action: "accept", content: null, _meta: null }
        });
        return;
      }

      default:
        this.sendMessage({
          id: message.id,
          error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
        });
    }
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.closed = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

export class SpawnedCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    const env = this.options.env ?? process.env;
    const spawnPlan = resolveCommand("codex", ["app-server"], env);
    this.proc = spawn(spawnPlan.file, spawnPlan.args, {
      cwd: this.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      ...spawnPlan.options,
      windowsHide: true
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    // A write to an app server that stopped reading fails with EPIPE on this stream; without a
    // listener that error would crash the host process instead of failing the pending requests.
    // After close() the same error only reflects the shutdown close() asked for.
    this.proc.stdin.on("error", (error) => {
      this.handleExit(this.closeStarted ? null : createProtocolError(`codex app-server stdin failed: ${error.message}`));
    });

    this.proc.on("exit", (code, signal) => {
      this.handleProcessExit(code, signal);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    this.serverInfo = await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  // An exit that follows close() is the one close() asked for, so it carries no error.
  handleProcessExit(code, signal) {
    const stderr = this.stderr.trim();
    const detail =
      code === 0 || this.closeStarted
        ? null
        : createProtocolError(
            `codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
          );
    this.handleExit(detail);
  }

  async close() {
    if (this.closeStarted) {
      await this.exitPromise;
      return;
    }

    this.closeStarted = true;
    this.closed = true;

    if (this.readline) {
      this.readline.close();
    }

    const proc = this.proc;
    if (!proc) {
      // No process was started, so no exit event will ever settle the client.
      this.handleExit(null);
      return;
    }

    const isRunning = () => proc.pid !== undefined && proc.exitCode === null && proc.signalCode === null;
    if (isRunning()) {
      proc.stdin.end();
      setTimeout(() => {
        if (!isRunning()) {
          return;
        }
        if (process.platform === "win32") {
          // When codex is a batch file the direct child is cmd.exe, so stop the
          // whole tree to reach the process it started.
          try {
            terminateProcessTree(proc.pid);
          } catch {
            // Best-effort cleanup inside an unref'd timer: errors are swallowed
            // so they cannot crash the host process during shutdown.
          }
          return;
        }
        proc.kill("SIGTERM");
        // A process that ignores SIGTERM is killed 2 s later.
        setTimeout(() => {
          if (isRunning()) {
            proc.kill("SIGKILL");
          }
        }, 2000).unref?.();
      }, 50).unref?.();
    }

    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("codex app-server stdin is not available.");
    }
    stdin.write(line);
  }
}

class BrokerCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize() {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        this.handleExit(this.exitError);
      });
    });

    this.serverInfo = await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close() {
    if (this.closeStarted) {
      await this.exitPromise;
      return;
    }

    this.closeStarted = true;
    this.closed = true;
    if (!this.socket) {
      // No socket was opened, so no close event will ever settle the client.
      this.handleExit(null);
      return;
    }
    this.socket.end();
    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("codex app-server broker connection is not connected.");
    }
    socket.write(line);
  }
}

export class CodexAppServerClient {
  static async connect(cwd, options = {}) {
    let brokerEndpoint = null;
    if (!options.disableBroker) {
      brokerEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    const client = brokerEndpoint
      ? new BrokerCodexAppServerClient(cwd, { ...options, brokerEndpoint })
      : new SpawnedCodexAppServerClient(cwd, options);
    try {
      await client.initialize();
    } catch (error) {
      // A client whose handshake failed is never returned, so it is closed here to end the
      // app-server process or socket it opened.
      await client.close().catch(() => {});
      throw error;
    }
    return client;
  }
}
