import { fileURLToPath } from "node:url";

// Antigravity (agy) runs one CLI process per job. It has no protocol to interrupt a turn, so
// cancel stops the job's processes; a message sent during a turn is written to the same process
// and runs as a turn of its own.
export const agyProvider = Object.freeze({
  id: "agy",
  label: "Antigravity",
  // The script whose command line identifies a foreground agy job's process.
  processMarker: "agy-companion.mjs",
  progressLabel: "agy",
  // The companion that starts and runs this provider's jobs.
  companionScript: fileURLToPath(new URL("../../agy-companion.mjs", import.meta.url)),
  capabilities: Object.freeze({
    structuredOutput: true,
    resume: true,
    fork: false,
    steer: true,
    interrupt: false,
    modelFlag: true,
    effort: true,
    sandboxModes: Object.freeze(["read-only", "workspace-write", "danger-full-access"]),
    nativeReview: false,
    authCheck: false
  }),
  reviewCommands: Object.freeze({
    review: "/agent:agy-review",
    adversarialReview: "/agent:agy-review"
  }),

  resumeCommand(conversationId) {
    return `agy --conversation ${conversationId}`;
  },

  async interruptTurn() {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "agy has no turn interrupt; the job's processes are stopped instead."
    };
  },

  // The agy process is a child of the worker and ends with it.
  async interruptOrphanedTurn() {},

  sessionRuntimeStatus() {
    return {
      mode: "direct",
      label: "direct startup",
      detail: "Each agy job runs its own agy process.",
      endpoint: null
    };
  },

  storedOutputText() {
    return "";
  },

  // agy keeps conversations in a private store that is not read here.
  recoverTurnResult() {
    return null;
  }
});
