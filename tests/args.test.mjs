import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import process from "node:process";
import { spawnSync } from "node:child_process";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { parseArgs, splitRawArgumentString } from "../plugins/agent/scripts/lib/args.mjs";
import { setConfig } from "../plugins/agent/scripts/lib/state.mjs";

test("the raw argument splitter keeps Windows path separators", () => {
  assert.deepEqual(splitRawArgumentString(String.raw`--source C:\work\notes.json`), ["--source", String.raw`C:\work\notes.json`]);
  assert.deepEqual(splitRawArgumentString(String.raw`"C:\work dir\m.json" --x`), [String.raw`C:\work dir\m.json`, "--x"]);
  assert.deepEqual(splitRawArgumentString(String.raw`\\server\share`), [String.raw`\\server\share`]);
});

test("the raw argument splitter still escapes quotes and spaces", () => {
  assert.deepEqual(splitRawArgumentString(String.raw`say \"hi\" a\ b`), ["say", `"hi"`, "a b"]);
  assert.deepEqual(splitRawArgumentString(String.raw`it\'s`), ["it's"]);
  assert.deepEqual(splitRawArgumentString("end\\\\"), ["end\\"]);
});

test("an inline value keeps text after a second equals sign", () => {
  const parsed = parseArgs(["--base=a=b"], { valueOptions: ["base"] });
  assert.deepEqual(parsed.options, { base: "a=b" });
});

test("an empty quoted argument is kept", () => {
  assert.deepEqual(splitRawArgumentString(`--model "" foo`), ["--model", "", "foo"]);
  assert.deepEqual(splitRawArgumentString(`--model '' foo`), ["--model", "", "foo"]);
});

test("a UNC path keeps both leading backslashes", () => {
  assert.deepEqual(splitRawArgumentString(String.raw`\\server\share\x`), [String.raw`\\server\share\x`]);
  assert.deepEqual(
    splitRawArgumentString(String.raw`--cwd "\\server\share dir\x"`),
    ["--cwd", String.raw`\\server\share dir\x`]
  );
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "agent", "scripts", "codex-companion.mjs");

function makeRepo(behavior) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return { repo, binDir, env: buildEnv(binDir) };
}

function companion({ repo, env }, args) {
  return run("node", [SCRIPT, ...args], { cwd: repo, env });
}

function fakeState({ binDir }) {
  const file = path.join(binDir, "fake-codex-state.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

test("--help before the first positional is an option, after it is text", () => {
  assert.equal(parseArgs(["--help"]).options.help, true);
  assert.equal(parseArgs(["-h"]).options.help, true);
  const later = parseArgs(["focus", "on", "--help"]);
  assert.equal(later.options.help, undefined);
  assert.deepEqual(later.positionals, ["focus", "on", "--help"]);
});

test("stopAtFirstPositional keeps option-like words in the prompt", () => {
  const parsed = parseArgs(["--write", "fix", "the", "--model", "flag"], {
    valueOptions: ["model"],
    booleanOptions: ["write"],
    stopAtFirstPositional: true
  });
  assert.deepEqual(parsed.options, { write: true });
  assert.deepEqual(parsed.positionals, ["fix", "the", "--model", "flag"]);
});

test("task --help prints task usage without starting Codex", () => {
  const ctx = makeRepo();
  const result = companion(ctx, ["task", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /codex-companion\.mjs task \[--background\]/);
  assert.doesNotMatch(result.stdout, /codex-companion\.mjs review/);
  assert.equal(fakeState(ctx).lastTurnStart, undefined);
});

test("a prompt containing --help and option names is sent as written", () => {
  const ctx = makeRepo();
  const result = companion(ctx, ["task", "explain why --help and --model matter"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fakeState(ctx).lastTurnStart.prompt, "explain why --help and --model matter");
});

test("native review sends the requested effort on its thread", () => {
  const ctx = makeRepo();
  fs.writeFileSync(path.join(ctx.repo, "src", "app.js"), "export const value = 2;\n");
  const result = companion(ctx, ["review", "--effort", "high"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fakeState(ctx).lastThreadStart.config, { model_reasoning_effort: "high" });
});

test("an effort the model does not list fails before a thread starts", () => {
  const ctx = makeRepo();
  const result = companion(ctx, ["task", "--model", "gpt-5.6-luna", "--effort", "ultra", "do it"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Model gpt-5\.6-luna does not support reasoning effort "ultra"\. Use one of: low, medium, high\./);
  assert.equal(fakeState(ctx).lastThreadStart, undefined);
});

test("the default model's efforts apply when no model is requested", () => {
  const ctx = makeRepo();
  const rejected = companion(ctx, ["task", "--effort", "max", "do it"]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Model m-default does not support reasoning effort "max"\. Use one of: low, medium, high\./);
  assert.equal(fakeState(ctx).lastThreadStart, undefined);
  const accepted = companion(ctx, ["task", "--effort", "high", "do it"]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(fakeState(ctx).lastTurnStart.model, "m-default");
  assert.equal(fakeState(ctx).lastTurnStart.effort, "high");
});

test("without a model list, any effort Codex knows is accepted", () => {
  const ctx = makeRepo("no-catalog");
  const result = companion(ctx, ["task", "--effort", "ultra", "do it"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fakeState(ctx).lastTurnStart.model, null);
  assert.equal(fakeState(ctx).lastTurnStart.effort, "ultra");
  const rejected = companion(ctx, ["task", "--effort", "extreme", "do it"]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Unsupported reasoning effort "extreme"\. Use one of: none, minimal, low, medium, high, xhigh, max, ultra\./);
});

function changeSource(ctx) {
  fs.writeFileSync(path.join(ctx.repo, "src", "app.js"), "export const value = 2;\n");
}

test("a review with no model runs on the catalog default", () => {
  const ctx = makeRepo("catalog-default");
  changeSource(ctx);
  const result = companion(ctx, ["review"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fakeState(ctx).lastThreadStart.model, "m-default");
  assert.deepEqual(fakeState(ctx).lastThreadStart.config, { model_reasoning_effort: "low" });
});

test("a review still rejects an effort its model does not list", () => {
  const ctx = makeRepo();
  changeSource(ctx);
  const result = companion(ctx, ["review", "--model", "gpt-5.6-luna", "--effort", "ultra"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Model gpt-5\.6-luna does not support reasoning effort "ultra"/);
  assert.equal(fakeState(ctx).lastThreadStart, undefined);
});

test("a review uses the stored delegation setting", () => {
  const ctx = makeRepo();
  changeSource(ctx);
  setConfig(ctx.repo, "models", { codex: { model: "gpt-5.6-luna", effort: "high" } });
  const result = companion(ctx, ["review"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fakeState(ctx).lastThreadStart.model, "gpt-5.6-luna");
  assert.deepEqual(fakeState(ctx).lastThreadStart.config, { model_reasoning_effort: "high" });
});

test("a review against a model/list that does not answer finishes within the catalog timeouts", { timeout: 60000 }, () => {
  const ctx = makeRepo("model-list-hangs");
  changeSource(ctx);
  const started = Date.now();
  const result = spawnSync(process.execPath, [SCRIPT, "review"], {
    cwd: ctx.repo,
    env: ctx.env,
    encoding: "utf8",
    timeout: 45000,
    windowsHide: true
  });
  const elapsed = Date.now() - started;
  assert.equal(result.error?.code ?? null, null, "the review did not finish");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(elapsed < 30000, `took ${elapsed} ms`);
  assert.equal(fakeState(ctx).lastThreadStart.model, "gpt-6.1-sol");
});

test("the write sandbox setting applies to write-capable tasks", () => {
  const ctx = makeRepo();
  assert.equal(companion(ctx, ["task", "--write", "edit it"]).status, 0);
  assert.equal(fakeState(ctx).lastThreadStart.sandbox, "workspace-write");

  const setup = companion(ctx, ["setup", "--write-sandbox", "danger-full-access", "--json"]);
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).writeSandbox, "danger-full-access");
  assert.equal(companion(ctx, ["task", "--write", "edit it"]).status, 0);
  assert.equal(fakeState(ctx).lastThreadStart.sandbox, "danger-full-access");

  assert.notEqual(companion(ctx, ["setup", "--write-sandbox", "anything"]).status, 0);
});

test("task --resume-thread continues the named thread", () => {
  const ctx = makeRepo();
  assert.equal(companion(ctx, ["task", "first run"]).status, 0);
  const threadId = fakeState(ctx).lastTurnStart.threadId;

  const result = companion(ctx, ["task", "--resume-thread", threadId, "follow up"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fakeState(ctx).lastTurnStart.threadId, threadId);

  const conflict = companion(ctx, ["task", "--resume-thread", threadId, "--fresh", "x"]);
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /Choose only one of/);
});
