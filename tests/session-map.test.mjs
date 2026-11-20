import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import { readClaudeSession } from "../plugins/agent/scripts/lib/transfer/sources/claude-code.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "claude-session");
const SESSION_ID = "1b0c6f0e-0000-4000-8000-000000000001";
const FIXTURE_TRANSCRIPT = path.join(FIXTURE, "projects", "-repo", `${SESSION_ID}.jsonl`);
const SOURCE_FILE = path.join(ROOT, "plugins", "agent", "scripts", "lib", "transfer", "sources", "claude-code.mjs");
const FIXED_NOW = () => new Date("2026-11-02T08:00:00.000Z");

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// A snapshot record for a transcript file used in place.
function snapshotOf(file) {
  const content = fs.readFileSync(file);
  return { path: file, bytes: content.length, sha256: sha256(content), takenAt: "2026-11-02T07:59:00.000Z" };
}

function readFixture(options = {}) {
  return readClaudeSession(FIXTURE_TRANSCRIPT, {
    snapshot: snapshotOf(FIXTURE_TRANSCRIPT),
    profileDir: FIXTURE,
    now: FIXED_NOW,
    ...options
  });
}

test("the reader summarises the fixture session", async () => {
  const summary = await readFixture();
  const snapshot = snapshotOf(FIXTURE_TRANSCRIPT);

  assert.equal(summary.agent, "claude-code");
  assert.equal(summary.agentDisplayName, "Claude Code");
  assert.equal(summary.sessionId, SESSION_ID);
  assert.equal(summary.title, "Fixture session");
  assert.equal(summary.cwd, "/work/repo");
  assert.equal(summary.gitBranch, "main");
  assert.equal(summary.gitCommit, "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
  assert.equal(summary.agentVersion, "2.1.0");
  assert.equal(summary.model, "fixture-model-1");
  assert.equal(summary.effort, "high");
  assert.equal(summary.permissionMode, "default");
  assert.equal(summary.startedAt, "2026-11-01T10:00:00.000Z");
  assert.equal(summary.transcriptPath, FIXTURE_TRANSCRIPT);
  assert.equal(summary.snapshotSha256, snapshot.sha256);
  assert.equal(summary.snapshotBytes, snapshot.bytes);
  assert.equal(summary.snapshotAt, snapshot.takenAt);
  assert.equal(summary.recordCount, 26);
  assert.equal(summary.unparseableLines, 1);
  assert.deepEqual(summary.counts, {
    userTurns: 3,
    assistantMessages: 4,
    toolCalls: { Bash: 2, Edit: 1, TodoWrite: 2, Task: 1 },
    toolErrors: 1,
    thinkingBlocks: 1,
    compactions: 1,
    attachments: 1,
    images: 1
  });
  assert.deepEqual(summary.lastRequest, { text: "Thanks, continue with the docs.", line: 25 });
  assert.deepEqual(summary.commands, [
    { text: "npm test -- parse", line: 4 },
    { text: "npm test", line: 21 }
  ]);
  assert.deepEqual(summary.filesTouched, [{ path: "/work/repo/src/parse.js", changes: 1, hasHistory: true }]);
  assert.deepEqual(summary.todoState, { line: 11, completed: 1, open: 2 });
  assert.deepEqual(summary.openItems, [
    { kind: "todo", text: "Add a regression test" },
    { kind: "todo", text: "Update the parser docs" }
  ]);
  const agentBase = path.join(FIXTURE, "projects", "-repo", SESSION_ID, "subagents", "agent-explorer-0123456789abcdef");
  assert.deepEqual(summary.subagents, [
    {
      id: "explorer-0123456789abcdef",
      name: "explorer",
      type: "Explore",
      description: "Explore the parser",
      status: "returned",
      transcriptPath: `${agentBase}.jsonl`
    }
  ]);
  const transcript = summary.resources.find((resource) => resource.kind === "transcript");
  assert.equal(transcript.path, FIXTURE_TRANSCRIPT);
  assert.equal(transcript.sha256, snapshot.sha256);
  assert.equal(transcript.bytes, snapshot.bytes);
  assert.deepEqual(
    [...new Set(summary.resources.map((resource) => resource.kind))],
    ["transcript", "subagent-transcript", "subagent-meta", "tool-result", "file-history", "session-env", "prompt-history", "paste"]
  );
  const subagentTranscript = summary.resources.find((resource) => resource.kind === "subagent-transcript");
  assert.equal(subagentTranscript.sha256, sha256(fs.readFileSync(`${agentBase}.jsonl`)));
  assert.equal(subagentTranscript.relatesTo, "explorer-0123456789abcdef");
  for (const resource of summary.resources) {
    assert.ok(typeof resource.readHint === "string" && resource.readHint.length > 20, resource.kind);
  }
  assert.equal(summary.resourcesObservedAt, "2026-11-02T08:00:00.000Z");
  assert.deepEqual(
    summary.profileNotes.map((note) => note.name),
    ["state", "sessions"]
  );
  assert.ok(summary.warnings.some((warning) => warning.includes("1 line")), summary.warnings.join("\n"));
});

const LIST_ONLY = ["tool-results", "file-history", "session-env", "paste-cache", "shell-snapshots", "tasks", "teams", "session-data", "state", "sessions"];

function isListOnly(target) {
  if (typeof target !== "string") {
    return false;
  }
  const relative = path.relative(FIXTURE, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  return relative.split(path.sep).some((part) => LIST_ONLY.includes(part));
}

test("list-only resources are never opened", async (t) => {
  const opened = [];
  for (const method of ["openSync", "readFileSync", "createReadStream"]) {
    const original = fs[method];
    t.mock.method(fs, method, function guarded(target, ...rest) {
      if (isListOnly(target)) {
        opened.push(`${method} ${target}`);
        throw new Error(`a list-only resource was opened: ${target}`);
      }
      return original.call(fs, target, ...rest);
    });
  }

  const summary = await readFixture();

  assert.deepEqual(opened, []);
  for (const kind of ["tool-result", "file-history", "session-env", "paste", "prompt-history"]) {
    const entries = summary.resources.filter((resource) => resource.kind === kind);
    assert.ok(entries.length > 0, kind);
    for (const entry of entries) {
      assert.equal(entry.sha256, null, kind);
    }
  }
  assert.deepEqual(summary.filesTouched, [{ path: "/work/repo/src/parse.js", changes: 1, hasHistory: true }]);
});

test("a 40,000-record transcript is read as a stream in under 20 seconds", async (t) => {
  const profile = makeTempDir(t);
  const projectDir = path.join(profile, "projects", "-big");
  fs.mkdirSync(projectDir, { recursive: true });
  const transcript = path.join(projectDir, "2b0c6f0e-0000-4000-8000-000000000002.jsonl");
  const padding = "p".repeat(1900);
  const fd = fs.openSync(transcript, "w");
  try {
    let batch = "";
    for (let index = 0; index < 40000; index += 1) {
      const record =
        index % 2 === 0
          ? { type: "user", timestamp: "2026-11-01T10:00:00.000Z", message: { role: "user", content: `request ${index} ${padding}` } }
          : { type: "assistant", message: { role: "assistant", model: "m", content: [{ type: "text", text: `answer ${index} ${padding}` }] } };
      batch += `${JSON.stringify(record)}\n`;
      if (batch.length > 4 * 1024 * 1024) {
        fs.writeSync(fd, batch);
        batch = "";
      }
    }
    fs.writeSync(fd, batch);
  } finally {
    fs.closeSync(fd);
  }
  const bytes = fs.statSync(transcript).size;
  const snapshot = { path: transcript, bytes, sha256: "0".repeat(64), takenAt: "2026-11-02T07:59:00.000Z" };

  const started = performance.now();
  const summary = await readClaudeSession(transcript, { snapshot, profileDir: profile, now: FIXED_NOW });
  const elapsed = performance.now() - started;

  t.diagnostic(`read ${bytes} bytes and 40000 records in ${Math.round(elapsed)} ms`);
  assert.equal(summary.recordCount, 40000);
  assert.ok(elapsed < 20000, `${elapsed} ms`);
  const source = fs.readFileSync(SOURCE_FILE, "utf8");
  assert.match(source, /fs\.createReadStream\(/);
  assert.doesNotMatch(source, /readFileSync\((snapshot|transcriptPath|snapshotPath)/);
});

const TARGET = Object.freeze({
  agent: "codex",
  agentDisplayName: "Codex",
  agentVersion: "0.169.0",
  threadId: "thr_1",
  method: "native-import",
  resumeCommand: "codex resume thr_1",
  importId: "import_1",
  staged: true,
  stagedCopyRemoved: true,
  pointerInjected: false,
  imported: ["user text", "assistant text"],
  dropped: ["thinking"],
  warnings: []
});
const KINDS = [
  "transcript",
  "subagent-transcript",
  "subagent-meta",
  "tool-result",
  "file-history",
  "session-env",
  "prompt-history",
  "paste",
  "shell-snapshot",
  "task",
  "team",
  "notes"
];
const SECTIONS = [
  "What this is",
  "How to continue",
  "What the thread does not contain",
  "Files touched",
  "Commands run",
  "Sub-agents",
  "Open items",
  "Resource legend",
  "Fidelity and warnings"
];
const MANIFEST_FILE = path.join(ROOT, "plugins", "agent", "scripts", "lib", "transfer", "manifest.mjs");
const SESSION_MAP_FILE = path.join(ROOT, "plugins", "agent", "scripts", "lib", "transfer", "session-map.mjs");

async function loadNeutralModules() {
  const { buildManifest } = await import(pathToFileURL(MANIFEST_FILE).href);
  const { renderSessionMap } = await import(pathToFileURL(SESSION_MAP_FILE).href);
  return { buildManifest, renderSessionMap };
}

// The map's level-2 sections by heading, in order.
function mapSections(markdown) {
  const sections = new Map();
  const parts = markdown.split(/^## /m).slice(1);
  for (const part of parts) {
    const newline = part.indexOf("\n");
    sections.set(part.slice(0, newline).trim(), part.slice(newline + 1));
  }
  return sections;
}

test("the map has the nine sections with their contents", async () => {
  const { buildManifest, renderSessionMap } = await loadNeutralModules();
  const manifest = buildManifest(await readFixture(), TARGET, { toolVersion: "2.0.0", now: FIXED_NOW });
  const markdown = renderSessionMap(manifest);
  const sections = mapSections(markdown);

  assert.deepEqual([...sections.keys()], SECTIONS);
  const howTo = sections.get("How to continue");
  assert.match(howTo, /\/work\/repo/);
  assert.match(howTo, /main/);
  assert.match(howTo, /a1b2c3d4e5f60718293a4b5c6d7e8f9012345678/);
  assert.match(howTo, /fixture-model-1/);
  assert.match(howTo, /default/);
  assert.match(howTo, /line 25/);
  assert.match(howTo, /Thanks, continue with the docs\./);
  const missing = sections.get("What the thread does not contain");
  for (const pattern of [/Bash: 2/, /Edit: 1/, /TodoWrite: 2/, /Task: 1/, /6 tool calls/, /1 thinking block/, /1 attachment/, /1 compaction/, /1 sub-agent/, /1 unparseable line/]) {
    assert.match(missing, pattern);
  }
  assert.match(sections.get("Files touched"), /\/work\/repo\/src\/parse\.js.*1 change.*pre-edit copy: yes/);
  const commands = sections.get("Commands run");
  assert.match(commands, /line 4.*npm test -- parse/);
  assert.match(commands, /line 21.*npm test/);
  const subagents = sections.get("Sub-agents");
  assert.match(subagents, /explorer/);
  assert.match(subagents, /Explore/);
  assert.match(subagents, /Explore the parser/);
  assert.match(subagents, /returned/);
  assert.ok(subagents.includes(path.join(FIXTURE, "projects", "-repo", SESSION_ID, "subagents", "agent-explorer-0123456789abcdef.jsonl")));
  const openItems = sections.get("Open items");
  assert.match(openItems, /line 11/);
  assert.match(openItems, /1 completed, 2 open/);
  assert.match(openItems, /Add a regression test/);
  assert.match(openItems, /Update the parser docs/);

  const legend = sections.get("Resource legend");
  const present = new Set(manifest.resources.map((resource) => resource.kind));
  const entries = legend.split(/^- /m).slice(1);
  for (const kind of KINDS) {
    const entry = entries.find((candidate) => candidate.startsWith(`**${kind}**`));
    assert.ok(entry, `the legend has no entry for ${kind}`);
    if (present.has(kind)) {
      assert.ok(entry.includes(FIXTURE), `${kind} has no path under the fixture`);
      const hint = manifest.resources.find((resource) => resource.kind === kind).readHint;
      assert.ok(entry.includes(hint), `${kind} has no read instruction`);
      assert.doesNotMatch(entry, /none for this session/);
    } else {
      assert.match(entry, /none for this session/, kind);
    }
  }
  for (const kind of ["shell-snapshot", "task", "team", "notes"]) {
    assert.equal(present.has(kind), false, kind);
  }
  const stateNote = entries.find((candidate) => candidate.startsWith("**state**"));
  const sessionsNote = entries.find((candidate) => candidate.startsWith("**sessions**"));
  assert.match(stateNote, /nothing to read for this work/);
  assert.match(sessionsNote, /do not read it/);
  assert.ok(!stateNote.includes(FIXTURE) && !sessionsNote.includes(FIXTURE));

  const fidelity = sections.get("Fidelity and warnings");
  assert.match(fidelity, /2026-11-02T07:59:00\.000Z/);
  assert.match(fidelity, /2026-11-02T08:00:00\.000Z/);
  assert.match(fidelity, /user text/);
  assert.match(fidelity, /thinking/);
  assert.match(fidelity, /1 line of the transcript could not be parsed/);
});

test("the map and manifest copy no private text", async (t) => {
  const { buildManifest, renderSessionMap } = await loadNeutralModules();
  const profile = makeTempDir(t);
  const sessionId = "3b0c6f0e-0000-4000-8000-000000000003";
  const projectDir = path.join(profile, "projects", "-secret");
  const transcript = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(path.join(projectDir, sessionId, "tool-results"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, sessionId, "tool-results", "zzzzzzzzz.txt"), "TOOLFILE-MARKER-PETREL\n", "utf8");
  const records = [
    { type: "user", timestamp: "2026-11-01T10:00:00.000Z", message: { role: "user", content: "First request USERTEXT-MARKER-KESTREL" } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "THINKING-MARKER-PLOVER" },
          { type: "text", text: "ASSISTANT-MARKER-OSPREY" },
          { type: "tool_use", id: "toolu_e", name: "Edit", input: { file_path: "/work/a.js", old_string: "x", new_string: "TOOLINPUT-MARKER-AVOCET" } },
          { type: "tool_use", id: "toolu_b", name: "Bash", input: { command: "export AWS_SECRET_ACCESS_KEY=abcd1234efgh && deploy" } }
        ]
      }
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_e", content: "TOOLOUTPUT-MARKER-BITTERN" },
          { type: "tool_result", tool_use_id: "toolu_b", content: "deployed TOOLOUTPUT-MARKER-BITTERN" }
        ]
      }
    },
    { type: "user", timestamp: "2026-11-01T10:05:00.000Z", message: { role: "user", content: "Last request LASTREQUEST-MARKER-DUNLIN" } }
  ];
  fs.writeFileSync(transcript, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

  const summary = await readClaudeSession(transcript, { snapshot: snapshotOf(transcript), profileDir: profile, now: FIXED_NOW });
  const manifest = buildManifest(summary, TARGET, { toolVersion: "2.0.0", now: FIXED_NOW });
  const files = { manifest: JSON.stringify(manifest, null, 2), map: renderSessionMap(manifest) };

  for (const [name, text] of Object.entries(files)) {
    for (const marker of ["USERTEXT-MARKER", "THINKING-MARKER", "ASSISTANT-MARKER", "TOOLINPUT-MARKER", "TOOLOUTPUT-MARKER", "TOOLFILE-MARKER"]) {
      assert.equal(text.includes(marker), false, `${name} contains ${marker}`);
    }
    assert.ok(text.includes("LASTREQUEST-MARKER-DUNLIN"), name);
    assert.equal(text.includes("abcd1234efgh"), false, name);
    assert.ok(text.includes("AWS_SECRET_ACCESS_KEY=[redacted]"), name);
  }
});

const MANIFEST_KEYS = {
  top: [
    "manifestVersion",
    "createdAt",
    "resourcesObservedAt",
    "createdBy",
    "source",
    "target",
    "counts",
    "commands",
    "resources",
    "subagents",
    "filesTouched",
    "todoState",
    "openItems",
    "fidelity",
    "privacy"
  ],
  createdBy: ["tool", "version"],
  source: [
    "agent",
    "agentDisplayName",
    "agentVersion",
    "sessionId",
    "title",
    "cwd",
    "gitBranch",
    "gitCommit",
    "startedAt",
    "endedAt",
    "model",
    "effort",
    "permissionMode",
    "transcriptPath",
    "snapshotSha256",
    "snapshotBytes",
    "snapshotAt",
    "recordCount",
    "unparseableLines",
    "lastRequest",
    "profileNotes"
  ],
  target: ["agent", "agentDisplayName", "agentVersion", "threadId", "method", "resumeCommand", "importId", "staged", "stagedCopyRemoved", "pointerInjected"],
  counts: ["userTurns", "assistantMessages", "toolCalls", "toolErrors", "thinkingBlocks", "compactions", "attachments", "images"],
  resource: ["kind", "path", "bytes", "sha256", "relatesTo", "readHint"],
  subagent: ["id", "name", "type", "description", "status", "transcriptPath"],
  fidelity: ["imported", "dropped", "warnings"],
  privacy: ["excerpts", "redaction"]
};

test("the manifest has every v1 field", async () => {
  const { buildManifest } = await loadNeutralModules();
  const summary = await readFixture();
  const manifest = buildManifest(summary, TARGET, { toolVersion: "2.0.0", now: FIXED_NOW });
  const keys = (value) => Object.keys(value).sort();

  assert.deepEqual(keys(manifest), [...MANIFEST_KEYS.top].sort());
  assert.equal(manifest.manifestVersion, 1);
  assert.equal(manifest.createdAt, "2026-11-02T08:00:00.000Z");
  assert.equal(manifest.resourcesObservedAt, summary.resourcesObservedAt);
  assert.deepEqual(manifest.createdBy, { tool: "agent-plugin-cc", version: "2.0.0" });
  assert.deepEqual(keys(manifest.source), [...MANIFEST_KEYS.source].sort());
  assert.deepEqual(keys(manifest.target), [...MANIFEST_KEYS.target].sort());
  assert.deepEqual(keys(manifest.counts), [...MANIFEST_KEYS.counts].sort());
  assert.deepEqual(keys(manifest.resources[0]), [...MANIFEST_KEYS.resource].sort());
  assert.deepEqual(keys(manifest.subagents[0]), [...MANIFEST_KEYS.subagent].sort());
  assert.deepEqual(keys(manifest.filesTouched[0]), ["changes", "hasHistory", "path"]);
  assert.deepEqual(keys(manifest.todoState), ["completed", "line", "open"]);
  assert.deepEqual(keys(manifest.openItems[0]), ["kind", "text"]);
  assert.deepEqual(keys(manifest.commands[0]), ["line", "text"]);
  assert.deepEqual(keys(manifest.fidelity), [...MANIFEST_KEYS.fidelity].sort());
  assert.deepEqual(keys(manifest.privacy), [...MANIFEST_KEYS.privacy].sort());
  assert.deepEqual(manifest.privacy, { excerpts: ["last-request", "commands", "subagent-descriptions", "open-items"], redaction: "secret-patterns" });
  assert.deepEqual(manifest.fidelity.warnings, summary.warnings);
  assert.equal(manifest.source.agent, "claude-code");
  assert.equal(manifest.target.agent, "codex");

  const bare = buildManifest(
    { ...summary, lastRequest: null, commands: [], subagents: [], openItems: [], todoState: null, gitCommit: undefined },
    { ...TARGET, importId: undefined, warnings: ["target warning"] },
    { toolVersion: "2.0.0", now: FIXED_NOW }
  );
  assert.deepEqual(bare.privacy.excerpts, []);
  assert.equal(bare.source.gitCommit, null);
  assert.equal(bare.target.importId, null);
  assert.equal(bare.todoState, null);
  assert.deepEqual(bare.fidelity.warnings, [...summary.warnings, "target warning"]);
});

test("the neutral transfer modules name no client", () => {
  for (const file of [MANIFEST_FILE, SESSION_MAP_FILE]) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /claude|codex/i, file);
    const specifiers = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\1/g)].map((match) => match[2]);
    assert.deepEqual(
      specifiers.filter((specifier) => specifier.includes("sources/") || specifier.includes("providers/")),
      [],
      file
    );
  }
});
