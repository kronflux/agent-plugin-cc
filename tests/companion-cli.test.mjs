import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTempDir, spawnJson } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION_CLI = path.join(ROOT, "plugins", "agent", "scripts", "lib", "companion-cli.mjs");

test("a worker that cannot start is reported once and does not crash", async (t) => {
  const dir = makeTempDir(t);
  const workspaceRoot = path.join(dir, "workspace");
  fs.mkdirSync(workspaceRoot);
  const script = path.join(dir, "enqueue.mjs");
  fs.writeFileSync(
    script,
    [
      `import { enqueueBackgroundTask } from ${JSON.stringify(pathToFileURL(COMPANION_CLI).href)};`,
      `const workspaceRoot = ${JSON.stringify(workspaceRoot)};`,
      `const missing = ${JSON.stringify(path.join(dir, "missing-folder"))};`,
      `const job = { id: "task-nostart", kind: "task", jobClass: "task", title: "Task", workspaceRoot };`,
      "let caught = null;",
      "try {",
      `  enqueueBackgroundTask(missing, job, { prompt: "p" }, { workerScript: ${JSON.stringify(script)} });`,
      "} catch (error) {",
      "  caught = error.message;",
      "}",
      "await new Promise((resolve) => setTimeout(resolve, 300));",
      "process.stdout.write(JSON.stringify({ caught }));",
      ""
    ].join("\n")
  );

  const result = await spawnJson(process.execPath, [script]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(String(result.json?.caught), /could not be started/);
  assert.doesNotMatch(result.stderr, /Unhandled 'error' event/);
});
