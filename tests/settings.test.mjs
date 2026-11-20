import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { makeTempDir } from "./helpers.mjs";
import * as state from "../plugins/agent/scripts/lib/state.mjs";

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
