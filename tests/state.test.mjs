import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import * as state from "../plugins/agent/scripts/lib/state.mjs";

const { listJobs, queueJobMessage, readJobFile, resolveJobFile, resolveJobsDir, resolveStateDir, takeJobMessages, takeJobRequest, writeJobFile } =
  state;

test("resolveStateDir uses a temp-backed per-workspace directory", (t) => {
  const workspace = makeTempDir(t);
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;
  let stateDir;
  try {
    stateDir = resolveStateDir(workspace);
  } finally {
    if (previousPluginDataDir !== undefined) {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", (t) => {
  const workspace = makeTempDir(t);
  const pluginDataDir = makeTempDir(t);
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

// Writes a record in the format used before prompts had their own request file.
function writeLegacyRecord(workspace, id, fields = {}) {
  const jobFile = resolveJobFile(workspace, id);
  fs.writeFileSync(
    jobFile,
    JSON.stringify({
      id,
      status: "queued",
      updatedAt: "2020-01-01T00:00:00.000Z",
      request: { prompt: "old prompt" },
      ...fields
    })
  );
  return jobFile;
}

test("listing jobs does not write legacy records", (t) => {
  const workspace = makeTempDir(t);
  const jobFile = writeLegacyRecord(workspace, "task-legacy-list", { status: "completed" });
  const before = fs.readFileSync(jobFile, "utf8");

  const jobs = listJobs(workspace);

  assert.equal(jobs.length, 1);
  assert.equal("request" in jobs[0], false);
  assert.equal(fs.readFileSync(jobFile, "utf8"), before);
  assert.equal(fs.existsSync(jobFile.replace(/\.json$/, ".request.json")), false);
});

test("a legacy prompt reaches the worker and leaves the record", (t) => {
  const workspace = makeTempDir(t);
  const jobFile = writeLegacyRecord(workspace, "task-legacy-take");

  assert.deepEqual(takeJobRequest(workspace, "task-legacy-take"), { prompt: "old prompt" });

  assert.equal(fs.readFileSync(jobFile, "utf8").includes("old prompt"), false);
  assert.equal(readJobFile(jobFile).status, "queued");
  assert.equal(takeJobRequest(workspace, "task-legacy-take"), null);
});

test("a newer write during the legacy prompt hand-over is kept", (t) => {
  const workspace = makeTempDir(t);
  const jobFile = writeLegacyRecord(workspace, "task-legacy-race");

  const request = takeJobRequest(workspace, "task-legacy-race", {
    beforeReplace() {
      writeJobFile(workspace, "task-legacy-race", { id: "task-legacy-race", status: "queued", summary: "newer" });
    }
  });

  assert.deepEqual(request, { prompt: "old prompt" });
  assert.equal(readJobFile(jobFile).summary, "newer");
});

test("a corrupt legacy state file is kept and warned about", (t) => {
  const workspace = makeTempDir(t);
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  const legacyFile = path.join(stateDir, "state.json");
  fs.writeFileSync(legacyFile, "{bad");
  const warnings = [];
  t.mock.method(process.stderr, "write", (chunk) => {
    warnings.push(String(chunk));
    return true;
  });

  listJobs(workspace);

  t.mock.restoreAll();
  assert.equal(fs.existsSync(legacyFile), true);
  assert.equal(fs.existsSync(`${legacyFile}.migrated`), false);
  const warning = warnings.join("");
  assert.ok(warning.includes(`warning: could not read ${legacyFile}: `), warning);
  assert.match(warning, /; it was left in place\n/);
});

test("the state root must be a private folder of the caller", () => {
  const { assertPrivateStateRoot } = state;
  assert.equal(typeof assertPrivateStateRoot, "function", "assertPrivateStateRoot is exported");
  const dir = "/tmp/agent-plugin-1000";
  const stat = (overrides) => () => ({ isSymbolicLink: () => false, isDirectory: () => true, uid: 1000, ...overrides });
  const message = `The plugin state folder ${dir} is not a private folder owned by you; set CLAUDE_PLUGIN_DATA.`;

  assert.throws(() => assertPrivateStateRoot(dir, { lstat: stat({ isSymbolicLink: () => true }), getuid: () => 1000 }), {
    message
  });
  assert.throws(() => assertPrivateStateRoot(dir, { lstat: stat({ isDirectory: () => false }), getuid: () => 1000 }), {
    message
  });
  assert.throws(() => assertPrivateStateRoot(dir, { lstat: stat({ uid: 0 }), getuid: () => 1000 }), { message });
  assert.doesNotThrow(() => assertPrivateStateRoot(dir, { lstat: stat({}), getuid: () => 1000 }));
});

test("a bad message file does not lose messages claimed with it", async (t) => {
  const workspace = makeTempDir(t);
  writeJobFile(workspace, "task-msg", { id: "task-msg", status: "running" });
  const ids = [];
  for (const text of ["first", "broken", "third"]) {
    ids.push(queueJobMessage(workspace, "task-msg", text));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const dir = path.join(resolveJobsDir(workspace), "task-msg.messages");
  fs.writeFileSync(path.join(dir, `${ids[1]}.pending.json`), "{bad");

  const messages = takeJobMessages(workspace, "task-msg");

  assert.deepEqual(
    messages.map((message) => message.text),
    ["first", "third"]
  );
  assert.deepEqual(takeJobMessages(workspace, "task-msg"), []);
});

test("reads skip a shared fallback state root that is not private to the caller", (t) => {
  const { candidateStateDirs } = state;
  assert.equal(typeof candidateStateDirs, "function", "candidateStateDirs is exported");
  const workspace = makeTempDir(t);
  const pluginDataDir = makeTempDir(t);
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  const warnings = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    warnings.push(String(chunk));
    return true;
  };
  const stat = (uid) => () => ({ isSymbolicLink: () => false, isDirectory: () => true, uid });
  const missing = () => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  };
  try {
    const primary = resolveStateDir(workspace);
    const foreign = { platform: "linux", lstat: stat(0), getuid: () => 1000 };
    assert.deepEqual(candidateStateDirs(workspace, foreign), [primary]);
    assert.deepEqual(candidateStateDirs(workspace, foreign), [primary]);
    assert.equal(candidateStateDirs(workspace, { platform: "linux", lstat: stat(1000), getuid: () => 1000 }).length, 2);
    assert.equal(candidateStateDirs(workspace, { platform: "linux", lstat: missing, getuid: () => 1000 }).length, 2);
  } finally {
    process.stderr.write = originalWrite;
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
  assert.equal(warnings.length, 1, warnings.join(""));
  assert.match(warnings[0], /^warning: .*not a private folder owned by you.*; its jobs are not read\n$/);
});
