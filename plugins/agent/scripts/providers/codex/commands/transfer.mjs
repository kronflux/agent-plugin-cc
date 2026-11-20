import path from "node:path";

import { outputCommandResult, parseCommandInput, resolveCommandCwd } from "../../../lib/companion-cli.mjs";
import { resolveClaudeSessionPath, stageClaudeSessionForImport } from "../claude-session-transfer.mjs";
import { importExternalAgentSession } from "../runtime.mjs";

export const usage = "transfer [--source <claude-jsonl>] [--json]";

export function renderTransferResult(payload) {
  const lines = [
    "Transferred the Claude session into a Codex thread with visible turn history.",
    `Codex session ID: ${payload.threadId}`,
    `Resume in Codex: ${payload.resumeCommand}`
  ];
  return `${lines.join("\n")}\n`;
}

export async function executeTransfer(cwd, options = {}) {
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  let importSource = null;
  let result;
  try {
    importSource = stageClaudeSessionForImport(sourcePath);
    result = await importExternalAgentSession(cwd, { sourcePath: importSource.path });
  } finally {
    importSource?.cleanup();
  }
  const payload = {
    threadId: result.threadId,
    resumeCommand: `codex resume ${result.threadId}`,
    sourcePath,
    sessionId: path.basename(sourcePath, ".jsonl")
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
  };
}

export async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source
  });
  outputCommandResult(payload, rendered, options.json);
}

export const run = handleTransfer;
