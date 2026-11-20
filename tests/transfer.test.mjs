import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run, spawnJson, waitUntil } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "agent", "scripts", "codex-companion.mjs");
const TRANSFER_MODULE = path.join(ROOT, "plugins", "agent", "scripts", "providers", "codex", "claude-session-transfer.mjs");
const RUNTIME_MODULE = path.join(ROOT, "plugins", "agent", "scripts", "providers", "codex", "runtime.mjs");
const SOURCE_MODULE = path.join(ROOT, "plugins", "agent", "scripts", "lib", "transfer", "sources", "claude-code.mjs");

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

test("transfer takes the source from the transcript path the session recorded", () => {
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
  assert.equal(payload.target.threadId, "thr_1");
  assert.equal(payload.target.resumeCommand, "codex resume thr_1");
  assert.equal(payload.source.transcriptPath, canonicalSourcePath);
  assert.equal(payload.source.sessionId, sessionId);

  const state = fakeState(binDir);
  assert.equal(state.threads.length, 1);
  assert.equal(state.threads[0].ephemeral, false);
  assert.equal(state.threads[0].name, "Native transfer");
  // A source already under <home>/.claude/projects is copied too, and the copy is removed.
  const imported = state.lastExternalAgentImport.sourcePath;
  assert.notEqual(imported, canonicalSourcePath);
  assert.equal(path.basename(imported), path.basename(canonicalSourcePath));
  assert.equal(fs.existsSync(imported), false);
  assert.deepEqual(fs.readdirSync(path.dirname(projectDir)), ["-repo"]);
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
  assert.equal(payload.source.transcriptPath, fs.realpathSync(sourcePath));
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
  assert.equal(JSON.parse(result.stdout).target.threadId, "thr_1");
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
  assert.match(result.stderr, /session\.jsonl is not a Claude Code transcript under .*\.claude.projects\./);
});

test("resolveClaudeTranscript accepts a profile transcript and rejects others", async (t) => {
  const { resolveClaudeTranscript } = await import(pathToFileURL(SOURCE_MODULE).href);
  const profileDir = makeTempDir(t);
  const outside = makeTempDir(t);
  const projectDir = path.join(profileDir, "projects", "-repo");
  fs.mkdirSync(projectDir, { recursive: true });
  const transcript = path.join(projectDir, "sess-1.jsonl");
  const textFile = path.join(projectDir, "notes.txt");
  const foreign = path.join(outside, "sess-2.jsonl");
  for (const file of [transcript, textFile, foreign]) {
    fs.writeFileSync(file, "{}\n", "utf8");
  }

  assert.equal(resolveClaudeTranscript(outside, { source: transcript, profileDir }), fs.realpathSync(transcript));
  assert.equal(resolveClaudeTranscript(projectDir, { source: "sess-1.jsonl", profileDir }), fs.realpathSync(transcript));
  assert.equal(resolveClaudeTranscript(outside, { transcriptPath: transcript, profileDir }), fs.realpathSync(transcript));
  assert.throws(
    () => resolveClaudeTranscript(outside, { source: foreign, profileDir }),
    (error) => error.message === `${foreign} is not a Claude Code transcript under ${path.join(profileDir, "projects")}.`
  );
  assert.throws(() => resolveClaudeTranscript(outside, { source: textFile, profileDir }), /notes\.txt is not a Claude Code transcript/);
  assert.throws(
    () => resolveClaudeTranscript(outside, { source: path.join(projectDir, "missing.jsonl"), profileDir }),
    /missing\.jsonl is not a Claude Code transcript/
  );
  assert.throws(
    () => resolveClaudeTranscript(outside, { profileDir }),
    /^Error: No Claude Code transcript was recorded for this session; pass --source <path>\.$/
  );
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
      "const { stageTranscriptSnapshot } = await import(pathToFileURL(modulePath).href);",
      "let error = null;",
      "try {",
      "  stageTranscriptSnapshot(sourcePath);",
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

// Runs `fn` with the given environment variables set in this process and restores them after.
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

// The environment for calling a transfer helper in-process: the fake Codex on PATH and the test
// home as the user's home folder.
function inProcessEnv({ home, binDir }) {
  const fakeEnv = buildEnv(binDir);
  return { PATH: fakeEnv.PATH, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex") };
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function loadTransferModule() {
  return import(pathToFileURL(TRANSFER_MODULE).href);
}

async function loadRuntimeModule() {
  return import(pathToFileURL(RUNTIME_MODULE).href);
}

test("the snapshot drops a partial final record", async (t) => {
  const { stageTranscriptSnapshot } = await loadTransferModule();
  const home = makeTempDir(t);
  const profile = makeTempDir(t);
  const projectDir = path.join(profile, "projects", "-repo");
  fs.mkdirSync(projectDir, { recursive: true });
  const source = path.join(projectDir, "sess-partial.jsonl");
  const whole = `${JSON.stringify({ type: "user", message: { content: "one" } })}\n${JSON.stringify({ type: "assistant", message: { content: "two" } })}\n`;
  // A long partial record makes the backwards scan cross a 64 KiB chunk boundary.
  const partial = `{"type":"user","message":{"content":"${"x".repeat(70 * 1024)}`;
  fs.writeFileSync(source, whole + partial, "utf8");

  const snapshot = await withEnv({ HOME: home, USERPROFILE: home }, () => stageTranscriptSnapshot(source));
  t.after(() => snapshot.cleanup());

  const copy = fs.readFileSync(snapshot.path, "utf8");
  assert.notEqual(snapshot.path, source);
  assert.equal(path.basename(snapshot.path), "sess-partial.jsonl");
  assert.equal(copy, whole);
  assert.ok(copy.endsWith("\n"));
  const sourceParts = fs.readFileSync(source, "utf8").split("\n").length;
  assert.equal(copy.split("\n").filter(Boolean).length, sourceParts - 1);
  assert.equal(snapshot.bytes, Buffer.byteLength(whole));
  assert.equal(snapshot.sha256, sha256(Buffer.from(whole)));
  assert.ok(!Number.isNaN(Date.parse(snapshot.takenAt)));
});

test("the snapshot copies a source already under the home projects folder", async (t) => {
  const { stageTranscriptSnapshot } = await loadTransferModule();
  const home = makeTempDir(t);
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  fs.mkdirSync(projectDir, { recursive: true });
  const source = path.join(projectDir, "sess-home.jsonl");
  fs.writeFileSync(source, `${JSON.stringify({ type: "user", message: { content: "home" } })}\n`, "utf8");

  const snapshot = await withEnv({ HOME: home, USERPROFILE: home }, () => stageTranscriptSnapshot(source));

  assert.notEqual(snapshot.path, source);
  assert.ok(snapshot.path.startsWith(path.join(home, ".claude", "projects", ".agent-plugin-transfer-")), snapshot.path);
  assert.equal(snapshot.cleanup(), true);
  assert.equal(fs.existsSync(source), true);
  assert.deepEqual(fs.readdirSync(path.join(home, ".claude", "projects")), ["-repo"]);
});

test("cleanup removes the copy and the folders it created", async (t) => {
  const { stageTranscriptSnapshot } = await loadTransferModule();
  const home = makeTempDir(t);
  const profile = makeTempDir(t);
  const projectDir = path.join(profile, "projects", "-repo");
  fs.mkdirSync(projectDir, { recursive: true });
  const source = path.join(projectDir, "sess-clean.jsonl");
  fs.writeFileSync(source, `${JSON.stringify({ type: "user", message: { content: "clean" } })}\n`, "utf8");

  const snapshot = await withEnv({ HOME: home, USERPROFILE: home }, () => stageTranscriptSnapshot(source));
  assert.equal(fs.existsSync(snapshot.path), true);

  assert.equal(snapshot.cleanup(), true);
  assert.equal(fs.existsSync(path.dirname(snapshot.path)), false);
  assert.equal(fs.existsSync(path.join(home, ".claude")), false);
  assert.equal(fs.existsSync(source), true);
});

test("the import uses the given hash", async (t) => {
  const { stageTranscriptSnapshot } = await loadTransferModule();
  const { importExternalAgentSession } = await loadRuntimeModule();
  const home = makeTempDir(t);
  const binDir = makeTempDir(t);
  const repo = path.join(home, "repo");
  fs.mkdirSync(repo, { recursive: true });
  installFakeCodex(binDir);
  const profile = makeTempDir(t);
  const projectDir = path.join(profile, "projects", "-repo");
  fs.mkdirSync(projectDir, { recursive: true });
  const source = path.join(projectDir, "sess-hash.jsonl");
  writeSession(source, [
    { type: "user", message: { role: "user", content: [{ type: "text", text: "Array request" }] } },
    { type: "user", isMeta: true, message: { role: "user", content: "Meta text" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "Array answer" }] } }
  ]);

  const result = await withEnv(inProcessEnv({ home, binDir }), async () => {
    const snapshot = stageTranscriptSnapshot(source);
    try {
      const imported = await importExternalAgentSession(repo, { sourcePath: snapshot.path, contentSha256: snapshot.sha256 });
      return { imported, snapshot };
    } finally {
      snapshot.cleanup();
    }
  });

  const state = fakeState(binDir);
  assert.equal(result.imported.threadId, "thr_1");
  assert.equal(result.imported.importId, "import_1");
  assert.deepEqual(state.imports.map(({ bytes, sha256: hash, lines }) => ({ bytes, sha256: hash, lines })), [
    { bytes: result.snapshot.bytes, sha256: result.snapshot.sha256, lines: 3 }
  ]);
  assert.deepEqual(state.threads[0].visibleMessages.map((message) => message.text), ["Array request", "Array answer"]);
});

test("the transfer record round-trips and keeps the real source path", async (t) => {
  const { readTransferRecord, writeTransferRecord } = await loadTransferModule();
  const stateDir = makeTempDir(t);
  const sourcePath = path.join(stateDir, "profile", "projects", "-repo", "sess-record.jsonl");
  const record = {
    schema: 1,
    sessionId: "sess-record",
    sourcePath,
    sourceSha256: "a".repeat(64),
    threadId: "thr_1",
    previousThreadIds: [],
    method: "native-import",
    importedAt: "2026-11-17T12:00:00.000Z",
    mapDir: path.join(stateDir, "transfers", "sess-record"),
    pointer: "injected",
    census: { userMessages: 2, assistantMessages: 3 }
  };

  assert.equal(readTransferRecord(stateDir, "sess-record"), null);
  writeTransferRecord(stateDir, record);

  assert.deepEqual(readTransferRecord(stateDir, "sess-record"), record);
  assert.equal(readTransferRecord(stateDir, "sess-record").sourcePath, sourcePath);
  assert.ok(fs.existsSync(path.join(stateDir, "transfers", "sess-record.json")));
  assert.deepEqual(fs.readdirSync(path.join(stateDir, "transfers")), ["sess-record.json"]);
  assert.throws(() => writeTransferRecord(stateDir, { ...record, sessionId: "../escape" }), /session id/);
});

test("threadExists answers for a known and an unknown thread", async (t) => {
  const { stageTranscriptSnapshot } = await loadTransferModule();
  const { importExternalAgentSession, threadExists } = await loadRuntimeModule();
  const home = makeTempDir(t);
  const binDir = makeTempDir(t);
  const repo = path.join(home, "repo");
  fs.mkdirSync(repo, { recursive: true });
  installFakeCodex(binDir);
  const profile = makeTempDir(t);
  const projectDir = path.join(profile, "projects", "-repo");
  fs.mkdirSync(projectDir, { recursive: true });
  const source = path.join(projectDir, "sess-exists.jsonl");
  writeSession(source, [{ type: "user", message: { role: "user", content: "Exists?" } }]);

  const answers = await withEnv(inProcessEnv({ home, binDir }), async () => {
    const snapshot = stageTranscriptSnapshot(source);
    let imported;
    try {
      imported = await importExternalAgentSession(repo, { sourcePath: snapshot.path, contentSha256: snapshot.sha256 });
    } finally {
      snapshot.cleanup();
    }
    return { known: await threadExists(repo, imported.threadId), unknown: await threadExists(repo, "missing-thread") };
  });

  assert.deepEqual(answers, { known: true, unknown: false });
});

// Imports one session into the fake in-process and returns the thread id.
async function importForTest({ home, binDir, repo, profile }, entries) {
  const { stageTranscriptSnapshot } = await loadTransferModule();
  const { importExternalAgentSession } = await loadRuntimeModule();
  const projectDir = path.join(profile, "projects", "-repo");
  fs.mkdirSync(projectDir, { recursive: true });
  const source = path.join(projectDir, `sess-${crypto.randomBytes(4).toString("hex")}.jsonl`);
  writeSession(source, entries);
  return withEnv(inProcessEnv({ home, binDir }), async () => {
    const snapshot = stageTranscriptSnapshot(source);
    try {
      return (await importExternalAgentSession(repo, { sourcePath: snapshot.path, contentSha256: snapshot.sha256 })).threadId;
    } finally {
      snapshot.cleanup();
    }
  });
}

function inProcessFixture(t, behavior) {
  const home = makeTempDir(t);
  const binDir = makeTempDir(t);
  const repo = path.join(home, "repo");
  fs.mkdirSync(repo, { recursive: true });
  installFakeCodex(binDir, behavior);
  return { home, binDir, repo, profile: makeTempDir(t) };
}

test("injectThreadPointer appends one item with the pointer text", async (t) => {
  const { injectThreadPointer } = await loadRuntimeModule();
  const { importedThreadPointer } = await loadTransferModule();
  const fixture = inProcessFixture(t);
  const threadId = await importForTest(fixture, [{ type: "user", message: { role: "user", content: "Point me." } }]);
  const mapPath = path.join(fixture.home, "SESSION-MAP.md");
  const text = importedThreadPointer(mapPath);

  await withEnv(inProcessEnv(fixture), () => injectThreadPointer(fixture.repo, threadId, text));

  assert.equal(
    text,
    `Context for continuing this imported Claude Code session is in ${mapPath}. Read it before acting. The conversation above holds only text, with tool calls and results as tagged text; the full tool activity is described in that file.`
  );
  const state = fakeState(fixture.binDir);
  assert.equal(state.lastThreadResume.threadId, threadId);
  assert.equal(state.injections.length, 1);
  assert.equal(state.injections[0].threadId, threadId);
  assert.equal(state.injections[0].resumedFirst, true);
  assert.deepEqual(state.injections[0].items, [{ type: "message", role: "user", content: [{ type: "input_text", text }] }]);

  const failing = inProcessFixture(t, "inject-fail");
  const failingThread = await importForTest(failing, [{ type: "user", message: { role: "user", content: "Fail me." } }]);
  await assert.rejects(
    withEnv(inProcessEnv(failing), () => injectThreadPointer(failing.repo, failingThread, text)),
    /inject_items failed/
  );
});

test("the resume command forms", async () => {
  const { bareResumeCommand, pointerResumeCommand } = await loadTransferModule();
  const mapPath = path.join(ROOT, "state", "transfers", "sess", "SESSION-MAP.md");

  assert.equal(bareResumeCommand("thr_7"), "codex resume thr_7");
  assert.equal(pointerResumeCommand("thr_7", mapPath), `codex resume thr_7 "Read ${mapPath} before acting."`);
});

const FIXTURE = path.join(ROOT, "tests", "fixtures", "claude-session");
const FIXTURE_SESSION_ID = "1b0c6f0e-0000-4000-8000-000000000001";
const FIXTURE_FIDELITY =
  "Codex thread contains 4 user and 4 assistant messages; tool calls and results appear in them only as tagged text. Not in the thread as structured records: 6 tool calls, 1 thinking blocks, 1 sub-agent transcripts. They are described in the session map.";

// The fixture profile copied under a temporary CLAUDE_CONFIG_DIR, with its own plugin data folder.
function setupFixtureTransfer(behavior) {
  const context = setup(behavior, { claudeConfigDir: "claude-profile" });
  const profile = path.dirname(path.dirname(context.projectDir));
  fs.cpSync(FIXTURE, profile, { recursive: true });
  const pluginData = path.join(context.home, "plugin-data");
  return {
    ...context,
    profile,
    pluginData,
    source: path.join(context.projectDir, `${FIXTURE_SESSION_ID}.jsonl`),
    env: { ...context.env, CLAUDE_PLUGIN_DATA: pluginData }
  };
}

function transfer(context, extra = []) {
  return run("node", [SCRIPT, "transfer", "--source", context.source, ...extra], { cwd: context.repo, env: context.env });
}

function outputValue(stdout, prefix) {
  const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
  return line === undefined ? undefined : line.slice(prefix.length);
}

function mapFiles(stdout) {
  const mapPath = outputValue(stdout, "Session map: ");
  const mapDir = path.dirname(mapPath);
  return {
    mapPath,
    mapDir,
    manifest: () => JSON.parse(fs.readFileSync(path.join(mapDir, "manifest.json"), "utf8")),
    map: () => fs.readFileSync(mapPath, "utf8"),
    record: () => JSON.parse(fs.readFileSync(`${mapDir}.json`, "utf8"))
  };
}

test("transfer creates a thread, a session map and a truthful fidelity line", () => {
  const context = setupFixtureTransfer();

  const result = transfer(context);

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trimEnd().split(/\r?\n/);
  assert.equal(lines[0], "Codex thread: thr_1");
  assert.equal(lines[1], "Resume in Codex: codex resume thr_1");
  assert.match(lines[2], /^Session map: /);
  assert.equal(lines[3], FIXTURE_FIDELITY);
  const files = mapFiles(result.stdout);
  assert.equal(path.basename(files.mapPath), "SESSION-MAP.md");
  assert.ok(files.mapPath.startsWith(path.join(context.pluginData, "state")), files.mapPath);
  assert.equal(path.basename(files.mapDir), FIXTURE_SESSION_ID);
  assert.ok(fs.existsSync(files.mapPath));
  const manifest = files.manifest();
  assert.equal(manifest.target.threadId, "thr_1");
  assert.equal(manifest.source.transcriptPath, fs.realpathSync(context.source));
  assert.match(files.map(), /^# Session map/);
  assert.equal(fs.existsSync(path.join(context.home, ".claude")), false);
  const record = files.record();
  assert.equal(record.sourcePath, fs.realpathSync(context.source));
  assert.deepEqual(record.census, { userMessages: 4, assistantMessages: 4 });
  assert.equal(record.pointer, "injected");
  assert.equal(record.mapDir, files.mapDir);
});

test("the snapshot is the file the importer received", async (t) => {
  const context = setupFixtureTransfer("hold-import");
  const before = fs.readFileSync(context.source);
  const extra = [1, 2, 3]
    .map((index) => `${JSON.stringify({ type: "user", timestamp: "2026-11-01T11:00:00.000Z", message: { role: "user", content: `appended ${index}` } })}\n`)
    .join("");

  const child = spawnJson(process.execPath, [SCRIPT, "transfer", "--source", context.source, "--json"], {
    cwd: context.repo,
    env: context.env,
    timeoutMs: 60000
  });
  const held = path.join(context.binDir, "import-held");
  await waitUntil(() => fs.existsSync(held), { timeoutMs: 30000, describe: "the fake import to hold" });
  // The deliberate append while the transfer runs.
  fs.appendFileSync(context.source, extra, "utf8");
  fs.writeFileSync(path.join(context.binDir, "import-release"), "", "utf8");
  const { code, json: manifest, stderr } = await child;

  assert.equal(code, 0, stderr);
  assert.equal(fs.readFileSync(context.source, "utf8"), before.toString("utf8") + extra);
  const [received] = fakeState(context.binDir).imports;
  assert.equal(received.bytes, before.length);
  assert.equal(received.sha256, sha256(before));
  assert.equal(manifest.source.snapshotBytes, before.length);
  assert.equal(manifest.source.snapshotSha256, sha256(before));
  const lineCount = before.toString("utf8").split("\n").filter(Boolean).length;
  assert.equal(manifest.source.recordCount, lineCount);
  assert.equal(received.lines, lineCount);
  t.diagnostic(`snapshot ${before.length} bytes, ${lineCount} lines`);
});

test("a repeat transfer of an unchanged session reuses the thread", () => {
  const context = setupFixtureTransfer();
  const first = transfer(context);
  assert.equal(first.status, 0, first.stderr);

  const second = transfer(context);

  assert.equal(second.status, 0, second.stderr);
  const lines = second.stdout.trimEnd().split(/\r?\n/);
  assert.equal(lines[0], "Codex thread: thr_1");
  assert.equal(lines[1], "This session was already transferred; the transcript has not changed.");
  assert.equal(fakeState(context.binDir).imports.length, 1);
  assert.equal(mapFiles(second.stdout).mapPath, mapFiles(first.stdout).mapPath);
});

test("a repeat transfer after the transcript grew imports again", () => {
  const context = setupFixtureTransfer();
  const first = transfer(context);
  assert.equal(first.status, 0, first.stderr);
  fs.appendFileSync(context.source, `${JSON.stringify({ type: "user", message: { role: "user", content: "One more thing." } })}\n`, "utf8");

  const second = transfer(context);

  assert.equal(second.status, 0, second.stderr);
  assert.equal(outputValue(second.stdout, "Codex thread: "), "thr_2");
  assert.equal(outputValue(second.stdout, "Earlier transfer of this session: "), "thr_1");
  assert.equal(second.stdout.includes("already transferred"), false);
  assert.deepEqual(mapFiles(second.stdout).record().previousThreadIds, ["thr_1"]);
  assert.equal(fakeState(context.binDir).imports.length, 2);
});

test("the pointer is injected once, after the map exists", () => {
  const context = setupFixtureTransfer();

  const first = transfer(context);

  assert.equal(first.status, 0, first.stderr);
  const files = mapFiles(first.stdout);
  const [injection] = fakeState(context.binDir).injections;
  assert.equal(fakeState(context.binDir).injections.length, 1);
  assert.equal(injection.threadId, "thr_1");
  assert.equal(injection.resumedFirst, true);
  assert.equal(injection.namedPath, files.mapPath);
  assert.equal(injection.namedPathExisted, true);
  assert.equal(files.manifest().target.pointerInjected, true);
  assert.equal(files.manifest().target.resumeCommand, "codex resume thr_1");
  assert.equal(outputValue(first.stdout, "Resume in Codex: "), "codex resume thr_1");

  const second = transfer(context);

  assert.equal(second.status, 0, second.stderr);
  assert.equal(fakeState(context.binDir).injections.length, 1);
  assert.equal(outputValue(second.stdout, "Resume in Codex: "), "codex resume thr_1");
  assert.equal(files.manifest().target.pointerInjected, true);
  assert.match(files.map(), /A message naming this file was added to the end of the thread\./);
  assert.ok(second.stdout.includes(FIXTURE_FIDELITY), second.stdout);
});

test("a failed injection prints the pointer and says so", () => {
  const context = setupFixtureTransfer("inject-fail");

  const result = transfer(context);

  assert.equal(result.status, 0, result.stderr);
  const files = mapFiles(result.stdout);
  const warning = `The pointer could not be added to the thread: ${outputValue(result.stdout, "Warning: The pointer could not be added to the thread: ")}`;
  assert.match(warning, /inject_items failed/);
  assert.ok(result.stdout.includes("Warning: 1 line of the transcript could not be parsed"), result.stdout);
  assert.equal(outputValue(result.stdout, "Resume in Codex: "), `codex resume thr_1 "Read ${files.mapPath} before acting."`);
  const manifest = files.manifest();
  assert.equal(manifest.target.pointerInjected, false);
  assert.ok(manifest.fidelity.warnings.includes(warning), manifest.fidelity.warnings.join("\n"));
  assert.match(files.map(), /The pointer could not be added to the thread/);
  assert.equal(files.record().pointer, "printed");
});

test("--no-map writes no map and points nowhere", () => {
  const context = setupFixtureTransfer();

  const result = transfer(context, ["--no-map"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(outputValue(result.stdout, "Session map: "), "not written (--no-map)");
  assert.equal(outputValue(result.stdout, "Resume in Codex: "), "codex resume thr_1");
  assert.ok(
    result.stdout.includes("Codex thread contains 4 user and 4 assistant messages; tool calls and results appear in them only as tagged text. Not in the thread as structured records: 6 tool calls, 1 thinking blocks, 1 sub-agent transcripts.\n"),
    result.stdout
  );
  assert.equal(result.stdout.includes("described in the session map"), false);
  assert.equal(fakeState(context.binDir).injections, undefined);
  const stateRoot = path.join(context.pluginData, "state");
  const transferEntries = fs.readdirSync(stateRoot).flatMap((workspace) => {
    const dir = path.join(stateRoot, workspace, "transfers");
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  });
  assert.deepEqual(transferEntries, [`${FIXTURE_SESSION_ID}.json`]);
});

test("a transfer records the native import method", () => {
  const context = setupFixtureTransfer();

  const result = transfer(context, ["--json"]);

  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(result.stdout);
  assert.equal(manifest.target.method, "native-import");
  assert.equal(manifest.target.importId, "import_1");
  const stateRoot = path.join(context.pluginData, "state");
  const [workspace] = fs.readdirSync(stateRoot);
  const record = JSON.parse(fs.readFileSync(path.join(stateRoot, workspace, "transfers", `${FIXTURE_SESSION_ID}.json`), "utf8"));
  assert.equal(record.method, "native-import");
});
