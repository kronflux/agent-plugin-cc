import { fileURLToPath } from "node:url";

import { codexModelCatalog } from "./model-catalog.mjs";
import { readTurnResultFromRollout } from "./rollout.mjs";
import { getSessionRuntimeStatus } from "./runtime.mjs";

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

  // A dead worker's turn ran in an app server owned by the worker and ended with it.
  async interruptOrphanedTurn() {},

  sessionRuntimeStatus(env, workspaceRoot) {
    return getSessionRuntimeStatus(env, workspaceRoot);
  },

  // Native reviews store the reviewer's text under result.codex.stdout.
  storedOutputText(storedJob) {
    const text = storedJob?.result?.codex?.stdout;
    return typeof text === "string" ? text : "";
  },

  recoverTurnResult({ threadId, turnId }) {
    return readTurnResultFromRollout(threadId, turnId);
  },

  // Starts a new background turn on the thread of a finished job. The task command module is
  // loaded here, when it is needed, because it imports this module.
  async startFollowUpTurn(cwd, workspaceRoot, job, text) {
    const { startCodexFollowUpTurn } = await import("./commands/task.mjs");
    return startCodexFollowUpTurn(cwd, workspaceRoot, job, text);
  }
});
