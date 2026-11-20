import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run, spawnJson } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "agent", "scripts", "codex-companion.mjs");
const TRANSFER_MODULE = path.join(ROOT, "plugins", "agent", "scripts", "providers", "codex", "claude-session-transfer.mjs");

// os.homedir() reads USERPROFILE on Windows and HOME elsewhere, so both point at the test home.
function setup(behavior, { claudeConfigDir = null } = {}) {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  fs.mkdirSync(repo, { recursive: true });
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  const claudeRoot = claudeConfigDir ? path.join(home, claudeConfigDir) : path.join(home, ".claude");
  const projectDir = path.join(claudeRoot, "projects", "-repo");
  fs.mkdirSync(projectDir, { recursive: true });
  const env = {
    ...buildEnv(binDir),
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(home, ".codex"),
    ...(claudeConfigDir ? { CLAUDE_CONFIG_DIR: claudeRoot } : {})
  };
  return { home, repo, binDir, projectDir, env };
}

function writeSession(file, entries) {
  fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function fakeState(binDir) {
  return JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
}

test("transfer delegates the current Claude session directly to native import", () => {
  const { repo, binDir, projectDir, env } = setup();
  const sessionId = "sess-native-transfer";
  const sourcePath = path.join(projectDir, `${sessionId}.jsonl`);
  writeSession(sourcePath, [
    { type: "custom-title", customTitle: "Native transfer" },
    { type: "user", cwd: repo, message: { role: "user", content: "Initial request" } },
    { type: "assistant", cwd: repo, message: { role: "assistant", content: "Initial answer" } },
    { type: "user", cwd: repo, message: { role: "user", content: "/agent:codex-transfer" } }
  ]);

  const result = run("node", [SCRIPT, "transfer", "--json"], {
    cwd: repo,
    env: { ...env, AGENT_PLUGIN_TRANSCRIPT_PATH: sourcePath }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const canonicalSourcePath = fs.realpathSync(sourcePath);
  assert.equal(payload.threadId, "thr_1");
  assert.equal(payload.resumeCommand, "codex resume thr_1");
  assert.equal(payload.sourcePath, canonicalSourcePath);
  assert.equal(payload.sessionId, sessionId);

  const state = fakeState(binDir);
  assert.equal(state.threads.length, 1);
  assert.equal(state.threads[0].ephemeral, false);
  assert.equal(state.threads[0].name, "Native transfer");
  assert.equal(state.lastExternalAgentImport.sourcePath, canonicalSourcePath);
  assert.deepEqual(
    state.threads[0].visibleMessages.map((message) => message.text),
    ["Initial request", "Initial answer", "/agent:codex-transfer"]
  );
});

test("transfer copies a session from a relocated Claude config directory and removes the copy", () => {
  const { home, repo, binDir, projectDir, env } = setup("review-ok", { claudeConfigDir: "claude-profile" });
  const sourcePath = path.join(projectDir, "sess-relocated.jsonl");
  writeSession(sourcePath, [{ type: "user", cwd: repo, message: { role: "user", content: "Relocated request" } }]);

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath, "--json"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.sourcePath, fs.realpathSync(sourcePath));
  const imported = fakeState(binDir).lastExternalAgentImport;
  assert.equal(path.basename(imported.sourcePath), "sess-relocated.jsonl");
  assert.ok(
    imported.sourcePath.startsWith(fs.realpathSync(home) + path.sep) && imported.sourcePath.includes(path.join(".claude", "projects")),
    imported.sourcePath
  );
  assert.deepEqual(imported.messages.map((message) => message.text), ["Relocated request"]);
  assert.equal(fs.existsSync(imported.sourcePath), false);
  assert.equal(fs.existsSync(path.join(home, ".claude")), false);
  assert.equal(fs.existsSync(sourcePath), true);
});

test("transfer accepts a ledger record written during the import when its hash differs", () => {
  const { repo, projectDir, env } = setup("external-import-ledger-only");
  const sourcePath = path.join(projectDir, "sess-ledger.jsonl");
  writeSession(sourcePath, [{ type: "user", cwd: repo, message: { role: "user", content: "Still growing." } }]);

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath, "--json"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).threadId, "thr_1");
});

test("transfer rejects an older ledger record with another hash and prints Codex's failures", () => {
  const { repo, projectDir, env } = setup("external-import-stale-ledger");
  const sourcePath = path.join(projectDir, "sess-stale.jsonl");
  writeSession(sourcePath, [{ type: "user", cwd: repo, message: { role: "user", content: "Changed since." } }]);

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], { cwd: repo, env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Codex could not import the Claude session:\n- external agent session was not detected for import/);
});

test("transfer reports an actionable upgrade error when native import is unsupported", () => {
  const { repo, projectDir, env } = setup("external-import-unsupported");
  const sourcePath = path.join(projectDir, "session.jsonl");
  writeSession(sourcePath, [{ type: "user", cwd: repo, message: { role: "user", content: "Continue this work." } }]);

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath, "--json"], { cwd: repo, env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not support Claude session transfer/);
  assert.match(result.stderr, /@openai\/codex@latest/);
});

test("transfer fails visibly when native import completes without a ledger record", () => {
  const { repo, projectDir, env } = setup("external-import-fails");
  const sourcePath = path.join(projectDir, "session.jsonl");
  writeSession(sourcePath, [{ type: "user", cwd: repo, message: { role: "user", content: "Do not lose this request." } }]);

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], { cwd: repo, env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not record an imported thread/);
});

test("transfer rejects sources outside the Claude projects directory", () => {
  const { home, repo, env } = setup();
  const sourcePath = path.join(home, "session.jsonl");
  writeSession(sourcePath, [{ type: "user", cwd: repo, message: { role: "user", content: "Outside source." } }]);

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], { cwd: repo, env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only from .*\.claude.*projects/);
});

// Lists every entry under a folder as paths relative to it, sorted.
function listTree(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir, { recursive: true }).map(String).sort();
}

test("a transfer that fails while staging leaves no staging folder", async (t) => {
  const home = makeTempDir(t);
  const scratch = makeTempDir(t);
  // A folder cannot be copied as a file, so the staging copy fails after its folder exists.
  const source = path.join(scratch, "session.jsonl");
  fs.mkdirSync(source);
  const script = path.join(scratch, "stage.mjs");
  fs.writeFileSync(
    script,
    [
      'import { pathToFileURL } from "node:url";',
      "const [modulePath, sourcePath] = process.argv.slice(2);",
      "const { stageClaudeSessionForImport } = await import(pathToFileURL(modulePath).href);",
      "let error = null;",
      "try {",
      "  stageClaudeSessionForImport(sourcePath);",
      "} catch (caught) {",
      "  error = caught.message;",
      "}",
      "console.log(JSON.stringify({ error }));"
    ].join("\n")
  );
  const before = listTree(home);

  const { code, json } = await spawnJson(process.execPath, [script, TRANSFER_MODULE, source], {
    env: { ...process.env, HOME: home, USERPROFILE: home }
  });

  assert.equal(code, 0);
  assert.ok(json.error, "staging a folder did not fail");
  assert.deepEqual(listTree(home), before);
});

test("a corrupt import ledger yields the clear message", () => {
  const { repo, projectDir, env } = setup("external-import-fails");
  const sourcePath = path.join(projectDir, "session.jsonl");
  writeSession(sourcePath, [{ type: "user", cwd: repo, message: { role: "user", content: "Keep this request." } }]);
  fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  fs.writeFileSync(path.join(env.CODEX_HOME, "external_agent_session_imports.json"), "{not json", "utf8");

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], { cwd: repo, env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not record an imported thread/);
});
