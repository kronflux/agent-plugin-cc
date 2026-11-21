import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { installFakeAgy, readFakeAgyState } from "./fake-agy-fixture.mjs";
import { installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeCommittedRepo, makeTempDir } from "./helpers.mjs";
import * as state from "../plugins/agent/scripts/lib/state.mjs";
import { delegationSetting, resolveSetting, writeSandboxFor } from "../plugins/agent/scripts/lib/settings.mjs";
import { storeUserSetup } from "../plugins/agent/scripts/lib/model-selection.mjs";

// Gives the test its own plugin data folder, so the user config of one test never reaches another.
function usePluginData(t) {
  const dir = makeTempDir(t);
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  t.after(() => {
    process.env.CLAUDE_PLUGIN_DATA = previous;
  });
  return dir;
}

// Collects what `fn` writes to stderr.
function captureStderr(fn) {
  const original = process.stderr.write;
  let text = "";
  process.stderr.write = (chunk, ...rest) => {
    text += String(chunk);
    return typeof rest.at(-1) === "function" ? (rest.at(-1)(), true) : true;
  };
  try {
    return { value: fn(), stderr: text };
  } finally {
    process.stderr.write = original;
  }
}

test("a user config write then read round-trips", (t) => {
  const dir = usePluginData(t);
  assert.equal(state.userConfigFile(), path.join(dir, "user-config.json"));
  state.setUserConfig("models", { agy: { model: "x-medium", effort: null } });
  state.setUserConfig("writeSandbox", "danger-full-access");
  assert.deepEqual(state.getUserConfig(), {
    version: 1,
    models: { agy: { model: "x-medium", effort: null } },
    writeSandbox: "danger-full-access"
  });
});

test("a missing user config reads as the defaults", (t) => {
  usePluginData(t);
  assert.deepEqual(state.getUserConfig(), { version: 1, models: {} });
});

test("an unreadable user config reads as the defaults with one warning", (t) => {
  const dir = usePluginData(t);
  fs.writeFileSync(path.join(dir, "user-config.json"), "{ not json");
  const first = captureStderr(() => state.getUserConfig());
  const second = captureStderr(() => state.getUserConfig());
  assert.deepEqual(first.value, { version: 1, models: {} });
  assert.deepEqual(second.value, { version: 1, models: {} });
  assert.equal(first.stderr.split("\n").filter((line) => line.includes("user-config.json")).length, 1, first.stderr);
  assert.equal(second.stderr, "");
});

test("two overlapping user config writers of different keys both land", { timeout: 60000 }, async (t) => {
  const dir = usePluginData(t);
  const stateUrl = new URL("../plugins/agent/scripts/lib/state.mjs", import.meta.url).href;
  // Each writer sets its own key many times, so the two read-modify-write cycles overlap.
  const writer = (key) =>
    `const { setUserConfig } = await import(${JSON.stringify(stateUrl)});\n` +
    `for (let i = 0; i < 40; i += 1) setUserConfig(${JSON.stringify(key)}, i);\n`;
  const runWriter = (key) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", writer(key)], {
        env: { ...process.env, CLAUDE_PLUGIN_DATA: dir },
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 50000,
        windowsHide: true
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${key} exited ${code}: ${stderr}`))));
    });
  await Promise.all([runWriter("first"), runWriter("second")]);
  const config = state.getUserConfig();
  assert.equal(config.first, 39);
  assert.equal(config.second, 39);
  assert.equal(fs.existsSync(path.join(dir, "user-config.json.lock")), false);
});

test("an unreadable or future-version user config is never overwritten", (t) => {
  const dir = usePluginData(t);
  const file = path.join(dir, "user-config.json");
  for (const content of ["{ not json", `${JSON.stringify({ version: 2, models: {} })}\n`]) {
    fs.writeFileSync(file, content);
    captureStderr(() => {
      assert.throws(() => state.setUserConfig("writeSandbox", "danger-full-access"), (error) => error.message.includes(file));
    });
    assert.equal(fs.readFileSync(file, "utf8"), content);
  }
});

test("each setting resolves from the flag, the project, the user, then the default", (t) => {
  usePluginData(t);
  const workspaceRoot = makeTempDir(t);
  const provider = { id: "agy" };
  const resolve = (key, flag) => resolveSetting(key, { provider, workspaceRoot, flag });
  assert.deepEqual(resolve("writeSandbox"), { value: "workspace-write", source: "provider-default" });
  assert.deepEqual(resolve("model"), { value: null, source: "provider-default" });
  state.setUserConfig("writeSandbox", "danger-full-access");
  state.setUserConfig("models", { agy: { model: "a", effort: "low" } });
  assert.deepEqual(resolve("writeSandbox"), { value: "danger-full-access", source: "user" });
  assert.deepEqual(resolve("model"), { value: "a", source: "user" });
  assert.deepEqual(resolve("effort"), { value: "low", source: "user" });
  state.setConfig(workspaceRoot, "writeSandbox", "workspace-write");
  state.setConfig(workspaceRoot, "models", { agy: { model: "b", effort: null } });
  assert.deepEqual(resolve("writeSandbox"), { value: "workspace-write", source: "project" });
  assert.deepEqual(resolve("model"), { value: "b", source: "project" });
  assert.deepEqual(resolve("model", "c"), { value: "c", source: "flag" });
  // A project entry cleared by --model default stops at the provider default.
  state.setConfig(workspaceRoot, "models", { agy: null });
  assert.deepEqual(delegationSetting(provider, workspaceRoot), { setting: null, source: "provider-default" });
  assert.deepEqual(resolve("model"), { value: null, source: "provider-default" });
});

test("a read-only job never takes the write sandbox setting", (t) => {
  usePluginData(t);
  const workspaceRoot = makeTempDir(t);
  state.setUserConfig("writeSandbox", "danger-full-access");
  assert.equal(writeSandboxFor(workspaceRoot, false), "read-only");
  assert.equal(writeSandboxFor(workspaceRoot, true), "danger-full-access");
});

// ---------------------------------------------------------------------------------------------
// Setup commands, against the fake agy and the fake Codex.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGY = path.join(ROOT, "plugins", "agent", "scripts", "agy-companion.mjs");
const CODEX = path.join(ROOT, "plugins", "agent", "scripts", "codex-companion.mjs");
const SANDBOX_HINT = "Use --write-sandbox workspace-write or --write-sandbox danger-full-access.";

// A git workspace with a fake agy and a fake Codex on PATH, and a home folder without agy
// settings. `binDir` reuses the fakes of another workspace.
function makeWorkspace(t, binDir = null) {
  const repo = makeCommittedRepo(t);
  const bin = binDir ?? makeTempDir(t);
  if (!binDir) {
    installFakeAgy(bin, "ok");
    installFakeCodex(bin, "catalog-default");
  }
  const home = makeTempDir(t);
  const sep = process.platform === "win32" ? ";" : ":";
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}${sep}${process.env.PATH}`, AGENT_PLUGIN_TEST_AGY_ENTRY: path.join(bin, "agy") };
  return { repo, binDir: bin, env };
}

function companion(script, ctx, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: ctx.repo, env: ctx.env, encoding: "utf8", timeout: 60000, windowsHide: true });
}

function configBytes(repo) {
  const file = path.join(state.resolveStateDir(repo), "config.json");
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

for (const [name, script] of [["agy", AGY], ["codex", CODEX]]) {
  test(`${name} setup refuses an unknown option or a positional and changes nothing`, (t) => {
    usePluginData(t);
    const ctx = makeWorkspace(t);
    assert.equal(companion(script, ctx, ["setup", "--write-sandbox", "workspace-write"]).status, 0);
    const before = configBytes(ctx.repo);
    for (const word of ["--danger-full-access", "danger-full-access"]) {
      const result = companion(script, ctx, ["setup", "--model", "default", word]);
      assert.equal(result.status, 1, result.stderr);
      assert.ok(result.stderr.startsWith(`Unknown argument "${word}" for setup. Usage: setup [--scope project|user]`), result.stderr);
      assert.deepEqual(configBytes(ctx.repo), before);
    }
    assert.equal(fs.existsSync(state.userConfigFile()), false);
  });

  test(`${name} setup refuses a missing --write-sandbox value with the sandbox hint`, (t) => {
    usePluginData(t);
    const ctx = makeWorkspace(t);
    for (const args of [["--write-sandbox"], ["--write-sandbox", "--json"]]) {
      const result = companion(script, ctx, ["setup", ...args]);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stderr, `Missing value for --write-sandbox\n${SANDBOX_HINT}\n`);
      assert.equal(configBytes(ctx.repo), null);
    }
  });
}

test("agy setup --scope user applies in every workspace without a project setting", (t) => {
  usePluginData(t);
  const first = makeWorkspace(t);
  const second = makeWorkspace(t, first.binDir);
  const stored = companion(AGY, first, ["setup", "--scope", "user", "--model", "fake-model", "--effort", "low", "--write-sandbox", "danger-full-access"]);
  assert.equal(stored.status, 0, stored.stderr);
  assert.match(stored.stdout, /Delegations now use model fake-model with effort low in every workspace without its own setting\./);
  assert.deepEqual(state.getUserConfig(), { version: 1, models: { agy: { model: "fake-model", effort: "low" } }, writeSandbox: "danger-full-access" });
  for (const ctx of [first, second]) {
    const before = configBytes(ctx.repo);
    const result = companion(AGY, ctx, ["setup"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^- delegation model: fake-model-low \(user setting\)$/m);
    assert.match(result.stdout, /^- write sandbox: danger-full-access \(user setting\)$/m);
    assert.deepEqual(configBytes(ctx.repo), before);
    assert.equal(Object.hasOwn(state.getConfig(ctx.repo), "models"), false);
    const report = JSON.parse(companion(AGY, ctx, ["setup", "--json"]).stdout);
    assert.deepEqual(report.sources, { model: "user", effort: "user", writeSandbox: "user" });
  }
});

test("a user write sandbox never reaches a read-only agy task", (t) => {
  usePluginData(t);
  const ctx = makeWorkspace(t);
  assert.equal(companion(AGY, ctx, ["setup", "--scope", "user", "--write-sandbox", "danger-full-access"]).status, 0);
  const readOnly = companion(AGY, ctx, ["task", "look"]);
  assert.equal(readOnly.status, 0, readOnly.stderr);
  const write = companion(AGY, ctx, ["task", "--write", "edit"]);
  assert.equal(write.status, 0, write.stderr);
  const [readRun, writeRun] = readFakeAgyState(ctx.binDir).runs;
  assert.match(readRun.args.join(" "), /--sandbox --settings \S+read-only-settings\.json/);
  assert.equal(writeRun.args.includes("--sandbox"), false, writeRun.args.join(" "));
});

test("setup --scope user --model default clears the user model, and workspace-write is stored explicitly", (t) => {
  usePluginData(t);
  const ctx = makeWorkspace(t);
  assert.equal(companion(AGY, ctx, ["setup", "--scope", "user", "--model", "fake-model-low"]).status, 0);
  const cleared = companion(AGY, ctx, ["setup", "--scope", "user", "--model", "default", "--write-sandbox", "workspace-write"]);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.deepEqual(state.getUserConfig(), { version: 1, models: { agy: null }, writeSandbox: "workspace-write" });
  assert.match(cleared.stdout, /^- write sandbox: workspace-write \(user setting\)$/m);
  assert.match(cleared.stdout, /^- delegation model: .* \(provider-default\)$/m);
  assert.equal(configBytes(ctx.repo), null);
});

test("codex setup --scope user stores the delegation model for every workspace", (t) => {
  usePluginData(t);
  const ctx = makeWorkspace(t);
  const stored = companion(CODEX, ctx, ["setup", "--scope", "user", "--model", "luna", "--effort", "high", "--write-sandbox", "danger-full-access"]);
  assert.equal(stored.status, 0, stored.stderr);
  const other = makeWorkspace(t, ctx.binDir);
  const report = JSON.parse(companion(CODEX, other, ["setup", "--json"]).stdout);
  assert.equal(report.writeSandbox, "danger-full-access");
  assert.deepEqual(report.sources, { model: "user", effort: "user", writeSandbox: "user" });
  const text = companion(CODEX, other, ["setup"]);
  assert.match(text.stdout, /^- delegation model: gpt-5\.6-luna \(user setting\)$/m);
  assert.match(text.stdout, /^- delegation effort: high \(user setting\)$/m);
  assert.match(text.stdout, /^- write sandbox: danger-full-access \(user setting\)$/m);
  assert.equal(configBytes(other.repo), null);
});

test("without a plugin data folder the user config sits in the fallback state root", (t) => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;
  t.after(() => {
    process.env.CLAUDE_PLUGIN_DATA = previous;
  });
  const workspace = makeTempDir(t);
  assert.equal(path.dirname(state.userConfigFile()), path.dirname(state.resolveStateDir(workspace)));
  assert.equal(path.basename(state.userConfigFile()), "user-config.json");
});

test("two writers racing on a stale user config lock never both hold it", (t) => {
  const dir = usePluginData(t);
  const lockFile = path.join(dir, "user-config.json.lock");
  fs.writeFileSync(lockFile, "old-token\n");
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(lockFile, old, old);
  let second = null;
  // Writer A judges the lock stale; before it moves the lock, writer B recovers the same stale
  // lock and takes a fresh one. A must leave B's lock in place and give up within its deadline.
  const hooks = {
    beforeStaleRename() {
      if (second === null) {
        second = state.acquireUserConfigLock(lockFile);
      }
    }
  };
  assert.throws(() => state.acquireUserConfigLock(lockFile, { retryMs: 300, hooks }), (error) => error.message.includes(lockFile));
  assert.ok(second);
  assert.equal(state.holdsUserConfigLock(lockFile, second), true);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes(".stale-")), []);
  // A release removes the lock only for its holder.
  state.releaseUserConfigLock(lockFile, "someone-else");
  assert.equal(fs.existsSync(lockFile), true);
  state.releaseUserConfigLock(lockFile, second);
  assert.equal(fs.existsSync(lockFile), false);
});

// A provider whose catalog accepts every model and effort, for in-process setup tests.
const PLAIN_PROVIDER = {
  id: "plain",
  label: "Plain",
  modelCatalog: {
    async resolveExplicit(value) {
      return { model: value, efforts: null, defaultEffort: null };
    },
    async resolveDefault() {
      return { model: null, source: "provider-default", efforts: null, defaultEffort: null };
    },
    checkEffort(effort) {
      return effort;
    }
  }
};

test("an effort-only user setup never restores a model another setup replaced meanwhile", async (t) => {
  usePluginData(t);
  const workspaceRoot = makeTempDir(t);
  state.setUserConfig("models", { plain: { model: "a", effort: "low" } });
  const attempts = [];
  // Between the plan (which keeps model a) and its write, another setup stores model b.
  const hooks = {
    beforeStore(attempt) {
      attempts.push(attempt);
      if (attempt === 1) {
        state.setUserConfig("models", { plain: { model: "b", effort: null } });
      }
    }
  };
  await storeUserSetup(PLAIN_PROVIDER, workspaceRoot, workspaceRoot, { effort: "high" }, { hooks });
  assert.deepEqual(state.getUserConfig().models, { plain: { model: "b", effort: "high" } });
  assert.deepEqual(attempts, [1, 2]);
});

for (const [name, script] of [["agy", AGY], ["codex", CODEX]]) {
  test(`${name} setup refuses an option-shaped value and a repeated option before storing anything`, (t) => {
    usePluginData(t);
    const ctx = makeWorkspace(t);
    const typo = companion(script, ctx, ["setup", "--write-sandbox", "--typo", "--write-sandbox", "danger-full-access"]);
    assert.equal(typo.status, 1, typo.stderr);
    assert.equal(typo.stderr, `Missing value for --write-sandbox\n${SANDBOX_HINT}\n`);
    for (const args of [["--model", "default", "--model", "default"], ["--json", "--json"], ["--scope", "user", "--write-sandbox=danger-full-access", "--write-sandbox", "workspace-write"]]) {
      const repeated = companion(script, ctx, ["setup", ...args]);
      assert.equal(repeated.status, 1, repeated.stderr);
      assert.match(repeated.stderr, /^Option --[a-z-]+ is given more than once for setup\. Usage: setup \[--scope project\|user\]/);
    }
    assert.equal(configBytes(ctx.repo), null);
    assert.equal(fs.existsSync(state.userConfigFile()), false);
  });
}

test("user settings of a plugin data folder inside a Claude Code profile live in the profile and outlive that folder", async () => {
  const state = await import("../plugins/agent/scripts/lib/state.mjs");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "agent-profile-"));
  const dataDir = path.join(profile, "plugins", "data", "agent-agent-plugin-cc");
  fs.mkdirSync(dataDir, { recursive: true });
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    const file = path.join(profile, "agent-plugin", "user-config.json");
    assert.equal(state.userConfigFile(), file);

    // A file an earlier version wrote into the data folder is read where it is; a read moves nothing.
    const earlier = path.join(dataDir, "user-config.json");
    fs.writeFileSync(earlier, JSON.stringify({ version: 1, models: { codex: { model: "m", effort: null } }, writeSandbox: "danger-full-access" }));
    assert.equal(state.getUserConfig().writeSandbox, "danger-full-access");
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(earlier), true);

    // The first update writes the profile file from it, keeps its other keys, then removes it.
    state.setUserConfig("writeSandbox", "workspace-write");
    assert.equal(fs.existsSync(earlier), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1, models: { codex: { model: "m", effort: null } }, writeSandbox: "workspace-write" });
    fs.rmSync(dataDir, { recursive: true, force: true });
    assert.equal(state.getUserConfig().writeSandbox, "workspace-write");
  } finally {
    process.env.CLAUDE_PLUGIN_DATA = previous;
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
