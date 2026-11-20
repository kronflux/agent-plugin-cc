import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// Hermetic test environment: strip host-session variables that Claude Code /
// the plugin's own SessionStart hook export, so tests see a clean machine.
for (const name of [
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_ENV_FILE",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PID",
  "CLAUDE_CODE_SESSION_ID",
  "AGENT_PLUGIN_SESSION_ID",
  "AGENT_PLUGIN_TRANSCRIPT_PATH",
  "CODEX_COMPANION_SESSION_ID",
  "CODEX_COMPANION_TRANSCRIPT_PATH",
  "CODEX_PLUGIN_CC_ARGS"
]) {
  delete process.env[name];
}

// Each test process gets its own plugin data folder, so the state folders that the product and
// the commands a test starts create go there instead of the shared temp-directory root. The
// folder is removed when the process exits.
const pluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-test-data-"));
process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
process.on("exit", () => {
  try {
    fs.rmSync(pluginDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // reported below
  }
  if (fs.existsSync(pluginDataDir)) {
    process.stderr.write(`leftover temp folder: ${pluginDataDir}\n`);
  }
});
