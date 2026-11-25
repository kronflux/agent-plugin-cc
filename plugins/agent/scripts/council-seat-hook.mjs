#!/usr/bin/env node

// SubagentStop hook for the council's Claude seat. When a `council-member` agent stops, its final
// message is the seat's reply. The leader receives that reply only as notification text, in which
// the host shows `<`, `>` and `&` as HTML entities, and has no file of it. This hook writes the
// reply, exactly as the agent wrote it, to `<run folder>/replies/<prompt digest>.json`, and submits
// it for the delivery that prompt belongs to. The leader then finds the seat answered in the next
// `council status`, or submits the file itself when the submit here did not happen.
//
// The hook prints nothing and always exits 0: it must never keep an agent running or change what
// the leader sees. What it did is in `<run folder>/replies/hook.log`.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const COMPANION = fileURLToPath(new URL("./agent-companion.mjs", import.meta.url));
const NODE_FLAGS = ["--disable-warning=ExperimentalWarning"];
const STEP_TIMEOUT_MS = 20000;
// A council prompt file: <state dir>/council/<run id>/objects/<sha256>.md, with either separator,
// also as a JSON string shows it (doubled backslashes).
const PROMPT_FILE = /((?:[A-Za-z]:)?[^"'\s<>|*?\n]*?[\\/]+council[\\/]+(run-[A-Za-z0-9-]+))[\\/]+objects[\\/]+([0-9a-f]{64})\.md/g;

function readInput() {
  try {
    const text = fs.readFileSync(0, "utf8");
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

/** The last council prompt file a transcript names, as `{ runDir, runId, digest }`, or null. */
export function lastPromptOf(transcriptText) {
  let found = null;
  for (const match of String(transcriptText ?? "").matchAll(PROMPT_FILE)) {
    found = { runDir: path.normalize(match[1].replace(/\\\\/g, "\\")), runId: match[2], digest: match[3] };
  }
  return found;
}

function companion(args, cwd) {
  const result = spawnSync(process.execPath, [...NODE_FLAGS, COMPANION, ...args], { cwd, encoding: "utf8", timeout: STEP_TIMEOUT_MS, windowsHide: true });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error ?? null };
}

function main() {
  const input = readInput();
  if (!/(^|:)council-member$/.test(String(input.agent_type ?? ""))) {
    return;
  }
  const reply = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
  let transcript = "";
  try {
    transcript = fs.readFileSync(String(input.agent_transcript_path ?? ""), "utf8");
  } catch {
    return;
  }
  const prompt = lastPromptOf(transcript);
  if (!prompt || !reply.trim() || !fs.existsSync(prompt.runDir)) {
    return;
  }
  const repliesDir = path.join(prompt.runDir, "replies");
  const replyFile = path.join(repliesDir, `${prompt.digest}.json`);
  const log = (line) => {
    try {
      fs.appendFileSync(path.join(repliesDir, "hook.log"), `${new Date().toISOString()} ${line}\n`);
    } catch {
      // The log is a convenience.
    }
  };
  try {
    fs.mkdirSync(repliesDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(replyFile, reply);
  } catch (error) {
    log(`could not write ${replyFile}: ${error?.message ?? error}`);
    return;
  }
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const status = companion(["council", "status", prompt.runId, "--json", "--cwd", cwd], cwd);
  let deliveries = [];
  try {
    deliveries = JSON.parse(status.stdout).deliveries ?? [];
  } catch {
    log(`reply saved to ${replyFile}; council status gave no JSON (exit ${status.code}), nothing was submitted`);
    return;
  }
  const delivery = deliveries.find((entry) => typeof entry.promptFile === "string" && entry.promptFile.includes(prompt.digest) && entry.intentId);
  if (!delivery) {
    log(`reply saved to ${replyFile}; no open delivery has this prompt, nothing was submitted`);
    return;
  }
  const args = ["council", "submit", prompt.runId, delivery.seat, "--intent", delivery.intentId, "--file", replyFile, "--json", "--cwd", cwd];
  if (delivery.round !== undefined && delivery.round !== null) {
    args.push("--round", String(delivery.round));
  }
  const submitted = companion(args, cwd);
  let state = null;
  try {
    const parsed = JSON.parse(submitted.stdout);
    state = parsed.state ?? parsed.error ?? null;
  } catch {
    // Reported below by the exit code.
  }
  log(`reply saved to ${replyFile}; submit for ${delivery.seat} intent ${delivery.intentId}: ${state ?? `exit ${submitted.code}`}`);
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  try {
    main();
  } catch {
    // Never fail the agent's stop.
  }
  process.exit(0);
}
