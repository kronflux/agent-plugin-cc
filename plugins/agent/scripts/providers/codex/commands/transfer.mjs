import fs from "node:fs";
import path from "node:path";

import { outputCommandResult, parseCommandInput, resolveCommandCwd } from "../../../lib/companion-cli.mjs";
import { claudeProfileDir, getTranscriptPath, pluginManifestPath } from "../../../lib/host.mjs";
import { ensureStateDir, resolveStateDir } from "../../../lib/state.mjs";
import { buildManifest } from "../../../lib/transfer/manifest.mjs";
import { renderSessionMap } from "../../../lib/transfer/session-map.mjs";
import { readClaudeSession, resolveClaudeTranscript } from "../../../lib/transfer/sources/claude-code.mjs";
import { resolveWorkspaceRoot } from "../../../lib/workspace.mjs";
import {
  bareResumeCommand,
  importedThreadPointer,
  pointerResumeCommand,
  readTransferRecord,
  stageTranscriptSnapshot,
  transferMapDir,
  writeFileReplacing,
  writeTransferRecord
} from "../claude-session-transfer.mjs";
import { censusImportedThread, importExternalAgentSession, injectThreadPointer, threadExists } from "../runtime.mjs";

export const usage = "transfer [--source <claude-jsonl>] [--json] [--no-map]";

const METHOD = "native-import";
const MAP_FILE = "SESSION-MAP.md";
const MANIFEST_FILE = "manifest.json";
// What Codex's session import keeps from a Claude Code transcript and what it leaves out.
const IMPORTED = [
  "user text",
  "assistant text",
  "compact summaries, as user text",
  "tool calls, as tagged text naming the tool and its file argument",
  "tool results, as tagged text"
];
const DROPPED = [
  "tool call inputs other than the file argument",
  "thinking",
  "meta records",
  "sidechain records",
  "attachments",
  "system records",
  "original timestamps"
];

function pluginVersion() {
  try {
    return JSON.parse(fs.readFileSync(pluginManifestPath(), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function fidelityLine(manifest, census, { withMap }) {
  const users = census ? census.userMessages : "unknown";
  const assistants = census ? census.assistantMessages : "unknown";
  const toolCalls = Object.values(manifest.counts.toolCalls).reduce((total, count) => total + count, 0);
  const subagentTranscripts = manifest.resources.filter((resource) => resource.kind === "subagent-transcript").length;
  const line = `Codex thread contains ${users} user and ${assistants} assistant messages; tool calls and results appear in them only as tagged text. Not in the thread as structured records: ${toolCalls} tool calls, ${manifest.counts.thinkingBlocks} thinking blocks, ${subagentTranscripts} sub-agent transcripts.`;
  return withMap ? `${line} They are described in the session map.` : line;
}

export function renderTransferResult(result) {
  const lines = [`Codex thread: ${result.threadId}`];
  if (result.reused) {
    lines.push("This session was already transferred; the transcript has not changed.");
  } else if (result.earlierThreadId) {
    lines.push(`Earlier transfer of this session: ${result.earlierThreadId}`);
  }
  lines.push(`Resume in Codex: ${result.resumeCommand}`);
  lines.push(result.mapPath ? `Session map: ${result.mapPath}` : "Session map: not written (--no-map)");
  lines.push(result.fidelity);
  for (const warning of result.warnings) {
    lines.push(`Warning: ${warning}`);
  }
  return `${lines.join("\n")}\n`;
}

function writeMapFiles(mapDir, manifest) {
  writeFileReplacing(path.join(mapDir, MAP_FILE), renderSessionMap(manifest));
  writeFileReplacing(path.join(mapDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Transfers the Claude Code session to a Codex thread. The transcript is copied once; that copy is
 * hashed, imported and described. An unchanged session whose thread still exists reuses the
 * thread. Unless `noMap` is set, the session map and manifest are written to their fixed folder
 * before a pointer to the map is appended to a newly imported thread.
 */
export async function executeTransfer(cwd, options = {}) {
  const writeMap = !options.noMap;
  const profileDir = claudeProfileDir();
  const sourcePath = resolveClaudeTranscript(cwd, {
    source: options.source,
    profileDir,
    transcriptPath: getTranscriptPath()
  });
  const sessionId = path.basename(sourcePath, ".jsonl");
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateDir = resolveStateDir(workspaceRoot);
  const mapDir = transferMapDir(stateDir, sessionId);
  const mapPath = path.join(mapDir, MAP_FILE);

  const snapshot = stageTranscriptSnapshot(sourcePath);
  let record = null;
  let reused = false;
  let imported = null;
  let census = null;
  let summary;
  let stagedCopyRemoved = false;
  try {
    record = readTransferRecord(stateDir, sessionId);
    reused = Boolean(record && record.sourceSha256 === snapshot.sha256 && (await threadExists(cwd, record.threadId)));
    if (!reused) {
      imported = await importExternalAgentSession(cwd, { sourcePath: snapshot.path, contentSha256: snapshot.sha256 });
      census = await censusImportedThread(cwd, imported.threadId);
    }
    summary = await readClaudeSession(sourcePath, { snapshot, profileDir });
  } finally {
    stagedCopyRemoved = snapshot.cleanup();
  }

  const threadId = reused ? record.threadId : imported.threadId;
  const warnings = [];
  if (!stagedCopyRemoved) {
    warnings.push(`The temporary copy of the transcript could not be removed: ${snapshot.path}`);
  }
  const target = {
    agent: "codex",
    agentDisplayName: "Codex",
    agentVersion: imported?.codexVersion ?? null,
    threadId,
    method: METHOD,
    resumeCommand: writeMap ? pointerResumeCommand(threadId, mapPath) : bareResumeCommand(threadId),
    importId: imported?.importId ?? null,
    staged: true,
    stagedCopyRemoved,
    pointerInjected: false,
    imported: IMPORTED,
    dropped: DROPPED,
    warnings
  };
  const build = () => buildManifest(summary, target, { toolVersion: pluginVersion() });

  if (writeMap) {
    ensureStateDir(workspaceRoot);
    writeMapFiles(mapDir, build());
  }

  let pointer;
  if (!writeMap) {
    target.resumeCommand = bareResumeCommand(threadId);
    pointer = reused ? (record.pointer ?? null) : "none";
  } else if (reused) {
    pointer = record.pointer ?? null;
    if (pointer === "injected") {
      target.pointerInjected = true;
      target.resumeCommand = bareResumeCommand(threadId);
    }
  } else {
    try {
      await injectThreadPointer(cwd, threadId, importedThreadPointer(mapPath));
      target.pointerInjected = true;
      target.resumeCommand = bareResumeCommand(threadId);
      pointer = "injected";
    } catch (error) {
      warnings.push(`The pointer could not be added to the thread: ${errorMessage(error)}`);
      pointer = "printed";
    }
  }

  const manifest = build();
  if (writeMap) {
    writeMapFiles(mapDir, manifest);
  }

  const earlierThreadId = !reused && record ? record.threadId : null;
  const recordCensus = reused ? (record.census ?? null) : census;
  ensureStateDir(workspaceRoot);
  writeTransferRecord(stateDir, {
    sessionId,
    sourcePath,
    sourceSha256: snapshot.sha256,
    threadId,
    previousThreadIds: reused
      ? record.previousThreadIds
      : record
        ? [...new Set([record.threadId, ...(record.previousThreadIds ?? [])])].filter((id) => id !== threadId)
        : [],
    method: METHOD,
    importedAt: reused ? record.importedAt : new Date().toISOString(),
    mapDir: writeMap ? mapDir : (record?.mapDir ?? null),
    pointer,
    census: recordCensus
  });

  const result = {
    threadId,
    reused,
    earlierThreadId,
    resumeCommand: target.resumeCommand,
    mapPath: writeMap ? mapPath : null,
    fidelity: fidelityLine(manifest, recordCensus, { withMap: writeMap }),
    warnings: manifest.fidelity.warnings
  };
  return { payload: manifest, rendered: renderTransferResult(result) };
}

export async function handleTransfer(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json", "no-map"]
  });
  if (positionals.length > 0) {
    throw new Error(`Unexpected argument: ${positionals[0]}. Usage: ${usage}`);
  }

  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source,
    noMap: Boolean(options["no-map"])
  });
  outputCommandResult(payload, rendered, options.json);
}

export const run = handleTransfer;
