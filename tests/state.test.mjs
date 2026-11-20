import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, stopOwnedProcess } from "./helpers.mjs";
import * as state from "../plugins/agent/scripts/lib/state.mjs";

const { getConfig, resolveStateDir } = state;

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

test("a legacy state.json index becomes a config file", (t) => {
  const workspace = makeTempDir(t);
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    JSON.stringify({
      version: 1,
      config: { stopReviewGate: true },
      jobs: [{ id: "legacy-1", status: "completed", summary: "one" }]
    })
  );

  assert.equal(getConfig(workspace).stopReviewGate, true);
  assert.equal(fs.existsSync(path.join(stateDir, "state.json")), false);
  assert.equal(fs.existsSync(path.join(stateDir, "state.json.migrated")), true);
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

  getConfig(workspace);

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

test("the job store is opened only in folders the caller owns", async () => {
  const { assertPrivateStoreFolders } = await import("../plugins/agent/scripts/lib/store.mjs");
  const dirs = ["/tmp/agent-plugin-1000", "/tmp/agent-plugin-1000/repo-0123", "/tmp/agent-plugin-1000/repo-0123/store"];
  const lstat = (foreign, overrides = {}) => (dir) => ({
    isSymbolicLink: () => false,
    isDirectory: () => true,
    uid: 1000,
    ...(dir === foreign ? overrides : {})
  });
  const posix = { platform: "linux", getuid: () => 1000 };
  const refused = (dir) => ({ message: `The job store folder ${dir} is not a private folder owned by you; set CLAUDE_PLUGIN_DATA to a folder of your own.` });

  assert.doesNotThrow(() => assertPrivateStoreFolders(dirs, { ...posix, lstat: lstat(null) }));
  for (const dir of dirs) {
    assert.throws(() => assertPrivateStoreFolders(dirs, { ...posix, lstat: lstat(dir, { uid: 2000 }) }), refused(dir));
  }
  assert.throws(() => assertPrivateStoreFolders(dirs, { ...posix, lstat: lstat(dirs[1], { isSymbolicLink: () => true }) }), refused(dirs[1]));
  // Windows has a temp directory per user: nothing is checked there.
  assert.doesNotThrow(() => assertPrivateStoreFolders(dirs, { platform: "win32", getuid: () => 1000, lstat: lstat(dirs[0], { uid: 2000 }) }));
});

test("a command's store open waits out a store another process holds locked", async (t) => {
  const { openStore, openStoreRetrying, StoreError } = await import("../plugins/agent/scripts/lib/store.mjs");
  const stateDir = makeTempDir(t);
  openStore(stateDir).close();
  // A child takes the write lock of the store for 3 s, longer than one 2 s open attempt.
  const holder = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "-e",
      'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE"); console.log("locked"); setTimeout(() => { db.exec("COMMIT"); db.close(); }, 3000);',
      path.join(stateDir, "store", "state.db")
    ],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  t.after(() => stopOwnedProcess(holder));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the lock holder did not report its lock within 10 s")), 10000);
    holder.stdout.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  assert.throws(
    () => openStore(stateDir, { busyTimeoutMs: 200 }),
    (error) => error instanceof StoreError && (error.code === "busy" || error.code === "locked")
  );
  const store = openStoreRetrying(stateDir);
  assert.equal(typeof store.instanceId, "string");
  store.close();
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

test("resolveStateDir returns the plugin-data root and nothing reads the temp root through it", async (t) => {
  const workspace = makeTempDir(t);
  const pluginDataDir = makeTempDir(t);
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  t.after(() => {
    process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
  });
  const stateDir = resolveStateDir(workspace);
  assert.equal(path.dirname(stateDir), path.join(pluginDataDir, "state"));
  const { openStore } = await import("../plugins/agent/scripts/lib/store.mjs");
  openStore(stateDir).close();
  assert.equal(fs.existsSync(path.join(stateDir, "store", "state.db")), true);
  const tempRoot = path.join(os.tmpdir(), typeof process.getuid === "function" ? `agent-plugin-${process.getuid()}` : "agent-plugin");
  assert.equal(fs.existsSync(path.join(tempRoot, path.basename(stateDir), "store")), false);
  const storeSource = fs.readFileSync(new URL("../plugins/agent/scripts/lib/store.mjs", import.meta.url), "utf8");
  assert.equal(storeSource.includes("candidateStateDirs"), false);
});
