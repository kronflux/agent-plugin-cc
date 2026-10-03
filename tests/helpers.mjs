import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { loadBrokerSession, sendBrokerShutdown } from "../plugins/agent/scripts/providers/codex/broker-lifecycle.mjs";

const gitRepos = new Set();

export function makeTempDir(prefix = "codex-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

// Brokers are detached and outlive the test that started them. A test file that starts
// them registers this as its `after` hook: each repository's broker gets the broker's own
// shutdown request on its endpoint, so a stale PID can never reach an unrelated process.
export async function stopTestBrokers() {
  const endpoints = [...gitRepos].map((repo) => loadBrokerSession(repo)?.endpoint).filter(Boolean);
  gitRepos.clear();
  await Promise.all(
    endpoints.map((endpoint) =>
      Promise.race([
        sendBrokerShutdown(endpoint),
        new Promise((resolve) => setTimeout(resolve, 2000).unref())
      ])
    )
  );
}

export function initGitRepo(cwd) {
  gitRepos.add(cwd);
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
