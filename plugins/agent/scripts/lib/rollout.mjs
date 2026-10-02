import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// Codex writes every thread to a transcript at
// $CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<threadId>.jsonl. When a job ends
// without a stored result, the answer can be read back from there. A thread holds every turn
// resumed on it, so only records carrying the job's own turn id are used.

function findRolloutFile(sessionsDir, threadId) {
  const suffix = `-${threadId}.jsonl`;
  const pending = [sessionsDir];
  while (pending.length > 0) {
    const dir = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.name.startsWith("rollout-") && entry.name.endsWith(suffix)) {
        return full;
      }
    }
  }
  return null;
}

function itemText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
}

/**
 * Returns the answer Codex recorded for `turnId` on `threadId`, or null when no transcript,
 * turn, or text is found. `complete` is true when the text is the turn's final message, and
 * false when the turn stopped early and the text is its last message before stopping.
 */
export function readTurnResultFromRollout(threadId, turnId, options = {}) {
  if (!threadId || !turnId) {
    return null;
  }
  const codexHome = options.codexHome ?? path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const file = findRolloutFile(path.join(codexHome, "sessions"), threadId);
  if (!file) {
    return null;
  }
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }

  let finalText = null;
  let lastText = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      // A transcript cut off mid-write ends with a partial line.
      continue;
    }
    const payload = record?.payload;
    if (payload?.turn_id !== turnId) {
      continue;
    }
    if (payload.type === "task_complete" && typeof payload.last_agent_message === "string" && payload.last_agent_message.trim()) {
      finalText = payload.last_agent_message;
    } else if (payload.type === "item_completed" && payload.item?.type === "AgentMessage") {
      const text = itemText(payload.item.content);
      if (text.trim()) {
        lastText = text;
      }
    }
  }
  if (finalText) {
    return { text: finalText, complete: true, file };
  }
  return lastText ? { text: lastText, complete: false, file } : null;
}
