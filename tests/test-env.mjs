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

// On Windows the temp directory can be named by a short (8.3) path such as C:\Users\RUNNER~1,
// while git and the plugin report the long path of the same folder. The tests compare paths, so
// they and the commands they start get the long path.
if (process.platform === "win32") {
  try {
    const longTemp = fs.realpathSync.native(os.tmpdir());
    process.env.TEMP = longTemp;
    process.env.TMP = longTemp;
  } catch {
    // The temp directory is used as it is named.
  }
}

// Each test process gets its own plugin data folder, so the state folders that the product and
// the commands a test starts create go there instead of the shared temp-directory root. The
// folder is removed when the process exits.
const pluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-test-data-"));
process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

// On POSIX the shared temp directory belongs to root, and the job store refuses a state folder
// whose parent the caller does not own. The tests and the commands they start therefore get a
// temp directory of their own inside the data folder. Its name is short, because socket paths
// are limited in length.
if (process.platform !== "win32") {
  const tempDir = path.join(pluginDataDir, "t");
  fs.mkdirSync(tempDir, { mode: 0o700 });
  process.env.TMPDIR = tempDir;
}
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
