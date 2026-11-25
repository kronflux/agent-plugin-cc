import { fileURLToPath } from "node:url";

import { agyModelCatalog } from "./runtime.mjs";
import { agyEndedTurn, agyQuotaBuckets } from "./usage.mjs";

// Antigravity (agy) runs one CLI process per turn. It has no protocol to interrupt a turn, so
// cancel stops the job's processes. A message sent during a turn is not written to the running
// process; when the turn ends, the message starts a new turn on the same conversation.

// The agy version on which the cleanup contracts below were observed (Windows): its own exit
// after a normal turn, the death of its owner and a forced tree stop each left no agy process
// within one second. The owner-death run was repeated on 1.5.11.
const VALIDATED_VERSION = "1.5.10";
const CLEANUP_CONTRACTS = Object.freeze(
  ["own-exit", "owner-death", "tree-stop"].map((trigger) => Object.freeze({ provider: "agy", platform: "win32", trigger, version: VALIDATED_VERSION, windowMs: 1000 }))
);
// No closure observation exists for agy on Linux or macOS, so every platform waits the default
// grace window before an unobserved release.
const GRACE_WINDOW_MS = 60000;
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
    steer: false,
    interrupt: false,
    // agy offers no way to read a conversation's history, so a message that may have been
    // delivered is sent again with a note that says so.
    history: false,
    modelFlag: true,
    effort: true,
    sandboxModes: Object.freeze(["read-only", "workspace-write", "danger-full-access"]),
    nativeReview: false,
    authCheck: false
  }),
  reviewCommands: Object.freeze({
    review: "/agent:agy-review",
    adversarialReview: "/agent:agy-review --stance critical"
  }),
  modelCatalog: agyModelCatalog,
  // How a usage report shows a reached limit for a job, and which failures agy ended itself.
  quotaBuckets: agyQuotaBuckets,
  endedByProvider: agyEndedTurn,
  validatedVersion: VALIDATED_VERSION,
  cleanupContracts: CLEANUP_CONTRACTS,

  graceWindowMs() {
    return GRACE_WINDOW_MS;
  },

  /**
   * The lines that describe how closure of an agy job is established: the version the cleanup
   * contracts were validated on, the installed version (`installed`, null when unknown) and the
   * assumption the contracts rest on.
   */
  contractSummary(installed) {
    return [
      `cleanup contracts validated on agy ${VALIDATED_VERSION} (Windows: own exit, owner death, tree stop; owner death also on 1.5.11)`,
      `installed agy: ${installed ?? "unknown"}`,
      "the contracts assume no MCP server is configured for agy; an MCP server process may outlive agy, so its exit would not be observed"
    ];
  },

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

  sessionRuntimeStatus() {
    return {
      mode: "direct",
      label: "direct startup",
      detail: "Each agy job runs its own agy process.",
      endpoint: null
    };
  }
});
