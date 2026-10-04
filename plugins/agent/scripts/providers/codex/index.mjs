import { fileURLToPath } from "node:url";

import { loadBrokerSession } from "./broker-lifecycle.mjs";
import { readTurnResultFromRollout } from "./rollout.mjs";
import { getSessionRuntimeStatus, interruptAppServerTurn } from "./runtime.mjs";

// Codex runs through its app server, shared per repository by a broker. The capabilities name
// what this plugin's Codex driver supports.
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
    adversarialReview: "/agent:codex-adversarial-review"
  }),

  resumeCommand(threadId) {
    return `codex resume ${threadId}`;
  },

  interruptTurn(cwd, { threadId, turnId }) {
    return interruptAppServerTurn(cwd, { threadId, turnId });
  },

  // A dead worker's turn keeps running in a shared broker, so it is interrupted there. Without
  // a broker the turn ran in an app server owned by the worker and ended with it.
  async interruptOrphanedTurn(workspaceRoot, job) {
    if (!loadBrokerSession(workspaceRoot)) {
      return;
    }
    await interruptAppServerTurn(workspaceRoot, { threadId: job.threadId, turnId: job.turnId });
  },

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
  }
});
