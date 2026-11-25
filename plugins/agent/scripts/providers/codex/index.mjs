import process from "node:process";
import { fileURLToPath } from "node:url";

import { codexModelCatalog } from "./model-catalog.mjs";
import { codexQuotaBuckets } from "./render.mjs";
import { getSessionRuntimeStatus } from "./runtime.mjs";

// The Codex version the cleanup contracts below were measured on.
const VALIDATED_VERSION = "0.169.0";

// What ends a Codex app server and everything it started, measured on Windows with Codex
// 0.169.0: the death of the process that holds its input, and a successful tree stop of a running
// app server, each within one second. The end of its input is not a release trigger. Linux decides
// closure by the app server's own process group, so it needs no contract.
const CLEANUP_CONTRACTS = Object.freeze([
  Object.freeze({ provider: "codex", platform: "win32", trigger: "owner-death", version: VALIDATED_VERSION, windowMs: 1000 }),
  Object.freeze({ provider: "codex", platform: "win32", trigger: "tree-stop", version: VALIDATED_VERSION, windowMs: 1000 })
]);

// How long an execution whose closure is not proved stays fenced before it is released unobserved.
const GRACE_WINDOW_MS = Object.freeze({ win32: 60000, linux: 60000, darwin: 60000 });

// Each Codex command runs in its own app server, started and stopped by that command. The
// capabilities name what this plugin's Codex driver supports.
export const codexProvider = Object.freeze({
  id: "codex",
  label: "Codex",
  // The script whose command line identifies a foreground Codex job's process.
  processMarker: "codex-companion.mjs",
  progressLabel: "codex",
  // The companion that starts and runs this provider's jobs.
  companionScript: fileURLToPath(new URL("../../codex-companion.mjs", import.meta.url)),
  capabilities: Object.freeze({
    structuredOutput: true,
    resume: true,
    fork: false,
    steer: true,
    interrupt: true,
    history: true,
    modelFlag: true,
    effort: true,
    sandboxModes: Object.freeze(["read-only", "workspace-write", "danger-full-access"]),
    nativeReview: true,
    authCheck: true
  }),
  reviewCommands: Object.freeze({
    review: "/agent:codex-review",
    adversarialReview: "/agent:codex-review --stance critical"
  }),
  modelCatalog: codexModelCatalog,
  // How a usage report shows a reached limit.
  quotaBuckets: codexQuotaBuckets,

  cleanupContracts: CLEANUP_CONTRACTS,
  validatedVersion: VALIDATED_VERSION,

  graceWindowMs(platform = process.platform) {
    return GRACE_WINDOW_MS[platform] ?? 60000;
  },

  // The lines the setup report prints about how Codex jobs are stopped and released.
  contractSummary(installedVersion) {
    return [
      `Cleanup contracts validated on Codex ${VALIDATED_VERSION}, installed ${installedVersion || "unknown"}.`,
      ...CLEANUP_CONTRACTS.map((contract) => `${contract.platform} ${contract.trigger}: every Codex process ends within ${contract.windowMs} ms.`),
      `Without a contract or an empty process group, a job is released after ${GRACE_WINDOW_MS[process.platform] ?? 60000} ms unobserved.`
    ];
  },

  resumeCommand(threadId) {
    return `codex resume ${threadId}`;
  },

  // A running turn lives in the worker's own app server, which ends when the worker is stopped.
  interruptTurn() {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "The turn runs in the worker's own app server; cancel stops the worker instead."
    };
  },

  sessionRuntimeStatus(env, workspaceRoot) {
    return getSessionRuntimeStatus(env, workspaceRoot);
  }
});
