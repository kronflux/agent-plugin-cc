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
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { resolveCommand, terminateProcessTree } from "../../lib/process.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

const NON_INTERACTIVE_DENIAL_REASON = "Non-interactive Codex runner: no operator to approve.";
const DECLINED_ELICITATION_MODES = new Set(["form", "openai/form", "openaiForm", "url"]);
// After the app server exits, its stdout can still hold lines it wrote before exiting. The client
// settles once stdout has closed, or after this long when a descendant keeps the pipe open.
const STDOUT_DRAIN_GRACE_MS = 2000;
// How long close() waits for the app server to exit after it was asked to stop.
const STOP_EXIT_WAIT_MS = 5000;

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
      this.failStream(createProtocolError(`Failed to parse codex app-server JSONL: ${error.message}`, { line }));
      return;
    }
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      this.failStream(createProtocolError("codex app-server sent a line that is not a JSON-RPC message.", { line }));
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
  // A stream that is not JSONL cannot be resynchronised, so the transport is ended too.
  failStream(error) {
    this.handleExit(error);
    this.close().catch(() => {});
  }

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
      // operator's consent through an elicitation, and this runner answers on the user's
      // behalf. A request in a form mode (`form`, `openai/form`, `openaiForm`) expects
      // structured content back, and a `url` request expects someone to open the URL;
      // this runner can do neither, so those are declined. A request with no `mode` or an
      // unknown one is accepted with `content: null`, because declining it blocks the MCP
      // tool call that raised it, and a delegated run has no operator who could answer.
      case "mcpServer/elicitation/request": {
        const mode = message.params?.mode;
        if (DECLINED_ELICITATION_MODES.has(mode)) {
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
    // Why close() could not stop the app server, or null.
    this.stopError = null;
    this.processExitPromise = new Promise((resolve) => {
      this.resolveProcessExit = resolve;
    });
  }

  async initialize() {
    const env = this.options.env ?? process.env;
    const spawnPlan = resolveCommand("codex", ["app-server"], env);
    this.attachProcess(
      spawn(spawnPlan.file, spawnPlan.args, {
        cwd: this.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        ...spawnPlan.options,
        windowsHide: true
      })
    );

    this.serverInfo = await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  /** Takes ownership of an app-server child process: reads its output and follows its exit. */
  attachProcess(proc) {
    this.proc = proc;
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
      this.resolveProcessExit();
      this.exitDrainTimer = setTimeout(() => this.handleProcessExit(code, signal), STDOUT_DRAIN_GRACE_MS);
      this.exitDrainTimer.unref?.();
    });

    // "close" follows the end of stdout, so every line written before the exit has been read.
    this.proc.on("close", (code, signal) => {
      this.handleProcessExit(code, signal);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });
  }

  // An exit that follows close() is the one close() asked for, so it carries no error.
  handleProcessExit(code, signal) {
    clearTimeout(this.exitDrainTimer);
    this.resolveProcessExit();
    const stderr = this.stderr.trim();
    const detail =
      code === 0 || this.closeStarted
        ? null
        : createProtocolError(
            `codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
          );
    this.handleExit(detail);
  }

  // Resolves true once the app server has exited, or false after `milliseconds`.
  waitForProcessExit(milliseconds) {
    let timer;
    return Promise.race([
      this.processExitPromise.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
        timer.unref?.();
      })
    ]).finally(() => clearTimeout(timer));
  }

  /**
   * Ends the app server: closes its input, and stops it when it is still running 50 ms later.
   * Returns once it has exited, or once a stop that failed has been recorded in `stopError`
   * and on stderr. A client that a stdin error already settled still stops its process.
   */
  async close() {
    if (!this.closePromise) {
      this.closeStarted = true;
      this.closed = true;
      this.closePromise = this.stopProcess();
    }
    await this.closePromise;
  }

  async stopProcess() {
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
      try {
        proc.stdin.end();
      } catch {
        // A stdin that already failed cannot be ended; the process is stopped below.
      }
      if (!(await this.waitForProcessExit(50)) && isRunning() && !(await this.forceStop(proc, isRunning))) {
        this.handleExit(null);
        return;
      }
    }

    await this.exitPromise;
  }

  recordStopFailure(proc, error) {
    this.stopError = error;
    process.stderr.write(`codex app-server process ${proc.pid} could not be stopped: ${error.message}\n`);
  }

  // Returns true once the process has exited, false when it could not be stopped.
  async forceStop(proc, isRunning) {
    if (process.platform === "win32") {
      // When codex is a batch file the direct child is cmd.exe, so the whole tree is stopped to
      // reach the process it started.
      const terminate = this.options.terminateProcessTree ?? terminateProcessTree;
      try {
        terminate(proc.pid);
      } catch (error) {
        this.recordStopFailure(proc, error instanceof Error ? error : new Error(String(error)));
        return false;
      }
    } else {
      proc.kill("SIGTERM");
      // A process that ignores SIGTERM is killed 2 s later.
      if (!(await this.waitForProcessExit(2000)) && isRunning()) {
        proc.kill("SIGKILL");
      }
    }
    if (await this.waitForProcessExit(STOP_EXIT_WAIT_MS)) {
      return true;
    }
    this.recordStopFailure(proc, new Error(`it was still running ${STOP_EXIT_WAIT_MS / 1000} s after it was stopped`));
    return false;
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

export class CodexAppServerClient {
  static async connect(cwd, options = {}) {
    const client = new SpawnedCodexAppServerClient(cwd, options);
    try {
      await client.initialize();
    } catch (error) {
      // A client whose handshake failed is never returned, so it is closed here to end the
      // app-server process it started.
      await client.close().catch(() => {});
      throw error;
    }
    return client;
  }
}
