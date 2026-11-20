import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { readHookInputJson } from "./fs.mjs";

// Everything the plugin assumes about Claude Code, its host: the variables Claude Code sets, the
// session variables the SessionStart hook exports, the profile folder that holds transcripts,
// the plugin manifest folder, hook input, and a hook's block decision. Every function reads the
// environment when it is called.

export const SESSION_ID_ENV = "AGENT_PLUGIN_SESSION_ID";
export const TRANSCRIPT_PATH_ENV = "AGENT_PLUGIN_TRANSCRIPT_PATH";
// Sessions started under the previous plugin name export these; they are read when the matching
// variable above is unset or empty.
const FALLBACK_ENV = {
  [SESSION_ID_ENV]: "CODEX_COMPANION_SESSION_ID",
  [TRANSCRIPT_PATH_ENV]: "CODEX_COMPANION_TRANSCRIPT_PATH"
};
// The folder Claude Code gives the plugin for its data.
export const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
// The id of the Claude Code process that runs the session.
const HOST_PID_ENV = "CLAUDE_PID";
const PROJECT_DIR_ENV = "CLAUDE_PROJECT_DIR";
// Claude Code keeps its profile here instead of <home>/.claude when the variable is set.
const CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";
// The file whose export lines Claude Code applies to the session's later commands.
const ENV_FILE_ENV = "CLAUDE_ENV_FILE";

function readSessionVar(env, name) {
  const value = env[name];
  if (value) {
    return value;
  }
  const fallback = FALLBACK_ENV[name];
  return (fallback && env[fallback]) || value || null;
}

/** The session id the SessionStart hook exported, read from `name` in `env`; null when unset. */
export function getSessionId(env = process.env, name = SESSION_ID_ENV) {
  return readSessionVar(env, name);
}

/** The transcript path of the session; null when unset. */
export function getTranscriptPath(env = process.env) {
  return readSessionVar(env, TRANSCRIPT_PATH_ENV);
}

/** The plugin data folder; null when unset. */
export function getPluginDataDir(env = process.env) {
  return env[PLUGIN_DATA_ENV] ?? null;
}

export function setPluginDataDir(dir, env = process.env) {
  env[PLUGIN_DATA_ENV] = dir;
}

/** The id of the Claude Code process, when it is set and holds only digits; otherwise null. */
export function getHostPid(env = process.env) {
  return /^\d+$/.test(env[HOST_PID_ENV] ?? "") ? env[HOST_PID_ENV] : null;
}

/** The project folder Claude Code runs in; null when unset. */
export function getProjectDir(env = process.env) {
  return env[PROJECT_DIR_ENV] ?? null;
}

/** <home>/.claude/projects, where Claude Code writes transcripts by default. */
export function homeProfileProjectsDir() {
  return path.join(os.homedir(), ".claude", "projects");
}

/** The folders that hold Claude Code transcripts: the home profile, then the configured profile. */
export function listHostTranscriptRoots(env = process.env) {
  const dirs = [homeProfileProjectsDir()];
  const configDir = env[CONFIG_DIR_ENV];
  if (configDir) {
    dirs.push(path.join(path.resolve(configDir), "projects"));
  }
  return dirs;
}

/** The path of the plugin manifest Claude Code reads. */
export function pluginManifestPath() {
  return fileURLToPath(new URL("../../.claude-plugin/plugin.json", import.meta.url));
}

/** Resolves to the hook's JSON input from stdin; see readHookInputJson. */
export function readHookInput(options = {}) {
  return readHookInputJson(options);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

// SessionStart runs again on resume, clear, and compaction. A line is appended only when the
// variable's last export in the file has a different value, so repeated runs add nothing.
// The file is only appended to, because other hooks may be appending at the same time.
function appendEnvVar(envFile, name, value) {
  if (!envFile || value == null || value === "") {
    return;
  }
  const line = `export ${name}=${shellEscape(value)}`;
  let existing = "";
  try {
    existing = fs.readFileSync(envFile, "utf8");
  } catch {
    // A missing file is created by the append below.
  }
  const lastExport = existing
    .split(/\r?\n/)
    .filter((candidate) => candidate.startsWith(`export ${name}=`))
    .at(-1);
  if (lastExport === line) {
    return;
  }
  const separator = existing && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(envFile, `${separator}${line}\n`, "utf8");
}

/**
 * Exports the session id, transcript path, and plugin data folder to the session's env file, in
 * that order. A missing or empty value, or a missing env file, exports nothing.
 */
export function writeSessionEnv({ sessionId, transcriptPath, pluginDataDir }, env = process.env) {
  const envFile = env[ENV_FILE_ENV];
  appendEnvVar(envFile, SESSION_ID_ENV, sessionId);
  appendEnvVar(envFile, TRANSCRIPT_PATH_ENV, transcriptPath);
  appendEnvVar(envFile, PLUGIN_DATA_ENV, pluginDataDir);
}

/** The text a Stop hook prints to keep the session from ending. */
export function formatBlockDecision(reason) {
  return JSON.stringify({ decision: "block", reason });
}
