// The transfer manifest, version 1: a description of one agent session and the thread it was
// transferred to, built from a source summary and a target result. It names the two agents only
// through the values it is given, and holds paths, names, counts, sizes, hashes, line numbers and
// the four redacted excerpt kinds the source summary carries.

export const MANIFEST_VERSION = 1;
const TOOL_NAME = "agent-plugin-cc";

function valueOrNull(value) {
  return value === undefined ? null : value;
}

function listOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function pick(object, keys) {
  return Object.fromEntries(keys.map((key) => [key, valueOrNull(object?.[key])]));
}

const SOURCE_KEYS = [
  "agent",
  "agentDisplayName",
  "agentVersion",
  "sessionId",
  "title",
  "cwd",
  "gitBranch",
  "gitCommit",
  "startedAt",
  "endedAt",
  "model",
  "effort",
  "permissionMode",
  "transcriptPath",
  "snapshotSha256",
  "snapshotBytes",
  "snapshotAt",
  "recordCount",
  "unparseableLines",
  "lastRequest"
];
const TARGET_KEYS = [
  "agent",
  "agentDisplayName",
  "agentVersion",
  "threadId",
  "method",
  "resumeCommand",
  "importId",
  "staged",
  "stagedCopyRemoved",
  "pointerInjected"
];
const COUNT_KEYS = ["userTurns", "assistantMessages", "toolErrors", "thinkingBlocks", "compactions", "attachments", "images"];

function excerptKinds(summary) {
  const kinds = [];
  if (summary.lastRequest) {
    kinds.push("last-request");
  }
  if (listOrEmpty(summary.commands).length > 0) {
    kinds.push("commands");
  }
  if (listOrEmpty(summary.subagents).some((agent) => agent.name || agent.type || agent.description)) {
    kinds.push("subagent-descriptions");
  }
  if (listOrEmpty(summary.openItems).length > 0) {
    kinds.push("open-items");
  }
  return kinds;
}

/**
 * Builds the manifest. `targetResult` carries the target fields plus `imported`, `dropped` and
 * `warnings` for the fidelity section; `options.toolVersion` is this plugin's version and
 * `options.now` the clock.
 */
export function buildManifest(sourceSummary, targetResult, { toolVersion = null, now = () => new Date() } = {}) {
  const summary = sourceSummary ?? {};
  const target = targetResult ?? {};
  const counts = summary.counts ?? {};
  return {
    manifestVersion: MANIFEST_VERSION,
    createdAt: now().toISOString(),
    resourcesObservedAt: valueOrNull(summary.resourcesObservedAt),
    createdBy: { tool: TOOL_NAME, version: valueOrNull(toolVersion) },
    source: {
      ...pick(summary, SOURCE_KEYS),
      profileNotes: listOrEmpty(summary.profileNotes).map((note) => ({ name: note.name, note: note.note }))
    },
    target: pick(target, TARGET_KEYS),
    counts: {
      ...Object.fromEntries(COUNT_KEYS.map((key) => [key, Number.isFinite(counts[key]) ? counts[key] : 0])),
      toolCalls: { ...(counts.toolCalls ?? {}) }
    },
    commands: listOrEmpty(summary.commands).map((command) => pick(command, ["text", "line"])),
    resources: listOrEmpty(summary.resources).map((resource) => pick(resource, ["kind", "path", "bytes", "sha256", "relatesTo", "readHint"])),
    subagents: listOrEmpty(summary.subagents).map((agent) => pick(agent, ["id", "name", "type", "description", "status", "transcriptPath"])),
    filesTouched: listOrEmpty(summary.filesTouched).map((file) => pick(file, ["path", "changes", "hasHistory"])),
    todoState: summary.todoState ? pick(summary.todoState, ["line", "completed", "open"]) : null,
    openItems: listOrEmpty(summary.openItems).map((item) => pick(item, ["kind", "text"])),
    fidelity: {
      imported: [...listOrEmpty(target.imported)],
      dropped: [...listOrEmpty(target.dropped)],
      warnings: [...listOrEmpty(summary.warnings), ...listOrEmpty(target.warnings)]
    },
    privacy: { excerpts: excerptKinds(summary), redaction: "secret-patterns" }
  };
}
