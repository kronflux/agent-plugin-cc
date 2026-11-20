import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { redactSecrets } from "../../redact.mjs";

// The only module that knows the layout of a Claude Code profile: where its transcripts are and
// which files beside them belong to a session. Callers pass the profile folder in. File functions
// are called through the `fs` object, so tests can replace them.

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function realpathOrNull(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function resolveUserPath(cwd, value) {
  const text = String(value);
  if (text === "~") {
    return os.homedir();
  }
  if (text.startsWith("~/") || text.startsWith("~\\")) {
    return path.join(os.homedir(), text.slice(2));
  }
  return path.resolve(cwd, text);
}

/**
 * The transcript a transfer reads: `source` resolved against `cwd`, else the recorded
 * `transcriptPath`. It must be an existing `.jsonl` file under `<profileDir>/projects`; the
 * returned path is its real path.
 */
export function resolveClaudeTranscript(cwd, { source = null, profileDir, transcriptPath = null } = {}) {
  const requested = source || transcriptPath;
  if (!requested) {
    throw new Error("No Claude Code transcript was recorded for this session; pass --source <path>.");
  }
  const candidate = resolveUserPath(cwd, requested);
  const projectsDir = path.join(profileDir, "projects");
  const reject = () => new Error(`${candidate} is not a Claude Code transcript under ${projectsDir}.`);
  if (path.extname(candidate) !== ".jsonl") {
    throw reject();
  }
  const real = realpathOrNull(candidate);
  const projectsReal = realpathOrNull(projectsDir);
  if (real === null || projectsReal === null || !isInside(projectsReal, real) || !fs.statSync(real).isFile()) {
    throw reject();
  }
  return real;
}

const AGENT = "claude-code";
const AGENT_DISPLAY_NAME = "Claude Code";
const HASH_LIMIT_BYTES = 50 * 1024 * 1024;
const LAST_REQUEST_CHARS = 200;
const COMMAND_CHARS = 160;
const COMMAND_LIMIT = 30;
const DESCRIPTION_CHARS = 200;
const OPEN_ITEM_CHARS = 200;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);
const THINKING_BLOCKS = new Set(["thinking", "redacted_thinking"]);

// For each resource kind: how it ties to the session, its format, and one way to read it.
const READ_HINTS = {
  transcript:
    "The session's own transcript; its file name is the session id. JSON Lines; each line is one record; `type` is `user` or `assistant`; a tool call is a content block with `type: tool_use`; its result is the next `user` record's `tool_result` block with the same `tool_use_id`. Line numbers in this map count lines of this file as of the snapshot.",
  "subagent-transcript":
    "A sub-agent the session started; it lies in the session's `subagents` folder and its records carry `isSidechain: true`. JSON Lines with the same record kinds as the main transcript; read it like the main transcript.",
  "subagent-meta":
    "Describes the sub-agent transcript with the same base name. JSON; read the keys `agentType`, `name` and `description`.",
  "tool-result":
    "Tool output too long for the transcript, in the session's `tool-results` folder; a `tool_result` block in the transcript names the file. Plain text or JSON, one file per tool result; open a file by the name a `tool_result` block gives.",
  "file-history":
    "Copies of files taken before the session edited them; the folder name is the session id. Raw file copies named `<hash>@v<n>`; the transcript's `file-history-snapshot` records map each edited path to its `backupFileName`.",
  "session-env":
    "Environment scripts that start hooks wrote for the session; the folder name is the session id. Shell `export` lines; they may hold secrets, so do not print them.",
  "prompt-history":
    "The profile's prompt history; lines whose `sessionId` is this session's id belong to it. JSON Lines with `display`, `pastedContents`, `timestamp`, `project` and `sessionId`; filter the lines by `sessionId`.",
  paste:
    "Text pasted into a prompt of this session; the file name is the `contentHash` that a prompt-history line of this session names. Plain text; open the file to see the pasted text.",
  "shell-snapshot":
    "Shell state captured for commands; tied only by time, because its name holds the epoch milliseconds when it was taken, which fall within the session. A shell script restoring aliases, functions and options; read it as text.",
  task: "Task list state; the folder name holds the first 8 hex digits of the session id. Mostly empty folders; a `.session-list` file holds one `session-<8 hex>` line.",
  team: "A team the session led; the folder name holds the first 8 hex digits of the session id. `config.json` lists the members and `inboxes/<agent-name>.json` holds each member's messages as a JSON array.",
  notes:
    "Session notes a hook wrote; the file name holds the date and the first 8 hex digits of the session id. Markdown with the sections Tasks, Files Modified, Tools Used, Stats, Notes for Next Session and Context to Load."
};

const PROFILE_NOTES = Object.freeze([
  Object.freeze({ name: "state", note: "not tied to a session; holds tool discovery results; nothing to read for this work" }),
  Object.freeze({ name: "sessions", note: "registry of running Claude Code processes; it holds key files; do not read it" })
]);

// Redacts, flattens whitespace and cuts session text to `limit` characters.
function excerpt(text, limit) {
  if (typeof text !== "string") {
    return null;
  }
  const flat = redactSecrets(text).replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit) : flat;
}

function statOrNull(target) {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function hashFile(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    for (let read = fs.readSync(fd, buffer, 0, buffer.length, null); read > 0; read = fs.readSync(fd, buffer, 0, buffer.length, null)) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

// The first line of a file parsed as JSON, read from its first 64 KiB; null when it is not JSON.
function readFirstRecord(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, read).toString("utf8");
    const end = text.indexOf("\n");
    return JSON.parse(end === -1 ? text : text.slice(0, end));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

function contentBlocks(record) {
  const content = record.message?.content;
  return Array.isArray(content) ? content.filter((block) => block && typeof block === "object") : [];
}

function messageText(record) {
  const content = record.message?.content;
  if (typeof content === "string") {
    return content;
  }
  return contentBlocks(record)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function editedPath(input) {
  const value = input?.file_path ?? input?.notebook_path ?? input?.path;
  return typeof value === "string" && value ? value : null;
}

// What the map needs from the transcript, collected one record at a time.
function createTranscriptCensus() {
  return {
    recordCount: 0,
    unparseableLines: 0,
    title: null,
    cwd: null,
    gitBranch: null,
    gitCommit: null,
    agentVersion: null,
    startedAt: null,
    endedAt: null,
    model: null,
    effort: null,
    permissionMode: null,
    counts: { userTurns: 0, assistantMessages: 0, toolCalls: {}, toolErrors: 0, thinkingBlocks: 0, compactions: 0, attachments: 0, images: 0 },
    lastRequest: null,
    commands: [],
    edits: new Map(),
    backups: new Map(),
    lastTodo: null,
    subagentCalls: [],
    resultIds: new Set(),
    agentResults: new Set()
  };
}

function noteBackup(census, filePath, backupFileName) {
  if (typeof filePath !== "string" || !filePath) {
    return;
  }
  if (typeof backupFileName === "string" && backupFileName) {
    census.backups.set(filePath, backupFileName);
  } else if (!census.backups.has(filePath)) {
    census.backups.set(filePath, null);
  }
}

function addRecord(census, record, line) {
  if (typeof record.timestamp === "string") {
    census.startedAt ??= record.timestamp;
    census.endedAt = record.timestamp;
  }
  for (const [field, key] of [
    ["cwd", "cwd"],
    ["gitBranch", "gitBranch"],
    ["version", "agentVersion"]
  ]) {
    if (typeof record[field] === "string" && record[field]) {
      census[key] = record[field];
    }
  }
  const commit = record.gitCommit ?? record.git?.commit;
  if (typeof commit === "string" && commit) {
    census.gitCommit = commit;
  }
  const title = record.customTitle ?? record.aiTitle;
  if (typeof title === "string" && title) {
    census.title = title;
  }
  if (record.type === "permission-mode" && typeof record.permissionMode === "string") {
    census.permissionMode = record.permissionMode;
  }

  switch (record.type) {
    case "user":
      addUserRecord(census, record, line);
      break;
    case "assistant":
      addAssistantRecord(census, record, line);
      break;
    case "system":
      if (record.subtype === "compact_boundary") {
        census.counts.compactions += 1;
      }
      break;
    case "attachment":
      census.counts.attachments += 1;
      break;
    case "file-history-snapshot": {
      const backups = record.snapshot?.trackedFileBackups;
      if (backups && typeof backups === "object") {
        for (const [filePath, backup] of Object.entries(backups)) {
          noteBackup(census, filePath, backup?.backupFileName);
        }
      }
      break;
    }
    case "file-history-delta":
      noteBackup(census, record.path ?? record.filePath ?? record.backup?.filePath, record.backup?.backupFileName);
      break;
    default:
      break;
  }
}

function addUserRecord(census, record, line) {
  if (typeof record.permissionMode === "string" && record.permissionMode) {
    census.permissionMode = record.permissionMode;
  }
  let hasToolResult = false;
  for (const block of contentBlocks(record)) {
    if (block.type === "tool_result") {
      hasToolResult = true;
      if (typeof block.tool_use_id === "string") {
        census.resultIds.add(block.tool_use_id);
      }
      if (block.is_error === true) {
        census.counts.toolErrors += 1;
      }
    } else if (block.type === "image") {
      census.counts.images += 1;
    }
  }
  const agentId = record.toolUseResult?.agentId;
  if (typeof agentId === "string" && agentId) {
    census.agentResults.add(agentId);
  }
  if (record.isMeta || record.isSidechain || record.isCompactSummary || hasToolResult) {
    return;
  }
  const text = messageText(record);
  if (text.trim()) {
    census.counts.userTurns += 1;
    census.lastRequest = { text: excerpt(text, LAST_REQUEST_CHARS), line };
  }
}

function addAssistantRecord(census, record, line) {
  if (record.isSidechain) {
    return;
  }
  if (typeof record.message?.model === "string" && record.message.model) {
    census.model = record.message.model;
  }
  if (typeof record.effort === "string" && record.effort) {
    census.effort = record.effort;
  }
  if (messageText(record).trim()) {
    census.counts.assistantMessages += 1;
  }
  for (const block of contentBlocks(record)) {
    if (THINKING_BLOCKS.has(block.type)) {
      census.counts.thinkingBlocks += 1;
    } else if (block.type === "image") {
      census.counts.images += 1;
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      addToolUse(census, block, line);
    }
  }
}

function addToolUse(census, block, line) {
  const { name } = block;
  const input = block.input && typeof block.input === "object" ? block.input : {};
  census.counts.toolCalls[name] = (census.counts.toolCalls[name] ?? 0) + 1;
  if (name === "Bash" && typeof input.command === "string") {
    census.commands.push({ text: excerpt(input.command, COMMAND_CHARS), line });
    if (census.commands.length > COMMAND_LIMIT) {
      census.commands.shift();
    }
  } else if (EDIT_TOOLS.has(name)) {
    const filePath = editedPath(input);
    if (filePath) {
      census.edits.set(filePath, (census.edits.get(filePath) ?? 0) + 1);
    }
  } else if (name === "TodoWrite" && Array.isArray(input.todos)) {
    census.lastTodo = { line, todos: input.todos.filter((todo) => todo && typeof todo === "object") };
  } else if (SUBAGENT_TOOLS.has(name)) {
    census.subagentCalls.push({ id: typeof block.id === "string" ? block.id : null, description: typeof input.description === "string" ? input.description : null });
  }
}

// Reads the snapshot one line at a time; a line that is not a JSON object is only counted.
async function readTranscript(snapshotPath) {
  const census = createTranscriptCensus();
  const lines = readline.createInterface({ input: fs.createReadStream(snapshotPath), crlfDelay: Infinity });
  let line = 0;
  for await (const text of lines) {
    line += 1;
    if (!text.trim()) {
      continue;
    }
    census.recordCount += 1;
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      census.unparseableLines += 1;
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      census.unparseableLines += 1;
      continue;
    }
    addRecord(census, record, line);
  }
  return census;
}

function fileResource(kind, file, { hash, relatesTo = null }) {
  const stat = statOrNull(file);
  const bytes = stat?.isFile() ? stat.size : null;
  return {
    kind,
    path: file,
    bytes,
    sha256: hash && bytes !== null && bytes <= HASH_LIMIT_BYTES ? hashFile(file) : null,
    relatesTo,
    readHint: READ_HINTS[kind]
  };
}

function folderResource(kind, dir) {
  return statOrNull(dir)?.isDirectory() ? { kind, path: dir, bytes: null, sha256: null, relatesTo: null, readHint: READ_HINTS[kind] } : null;
}

// "returned" when the transcript holds the sub-agent's result, "pending" when it holds only the
// call that started it, else "unknown".
function subagentStatus(census, ids, description) {
  if (ids.some((id) => census.agentResults.has(id))) {
    return "returned";
  }
  const call = census.subagentCalls.find((candidate) => candidate.description !== null && candidate.description === description);
  if (!call) {
    return "unknown";
  }
  return call.id !== null && census.resultIds.has(call.id) ? "returned" : "pending";
}

function readSubagents(census, sidecarDir, warnings) {
  const dir = path.join(sidecarDir, "subagents");
  const subagents = [];
  const resources = [];
  for (const name of listDir(dir).filter((entry) => entry.startsWith("agent-") && entry.endsWith(".jsonl"))) {
    const id = name.slice("agent-".length, -".jsonl".length);
    const transcriptPath = path.join(dir, name);
    const metaPath = path.join(dir, `agent-${id}.meta.json`);
    const hasMeta = Boolean(statOrNull(metaPath)?.isFile());
    let meta = {};
    if (hasMeta) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) ?? {};
      } catch {
        warnings.push(`The sub-agent metadata ${metaPath} could not be read.`);
      }
    }
    const hex = /([0-9a-f]{16})$/.exec(id)?.[1] ?? null;
    const ids = [readFirstRecord(transcriptPath)?.agentId, hex, id].filter((value) => typeof value === "string" && value);
    const description = typeof meta.description === "string" ? meta.description : null;
    const fallbackName = hex && id.length > hex.length + 1 ? id.slice(0, -hex.length - 1) : id;
    subagents.push({
      id,
      name: excerpt(typeof meta.name === "string" ? meta.name : fallbackName, DESCRIPTION_CHARS),
      type: excerpt(meta.agentType, DESCRIPTION_CHARS),
      description: excerpt(description, DESCRIPTION_CHARS),
      status: subagentStatus(census, ids, description),
      transcriptPath
    });
    resources.push(fileResource("subagent-transcript", transcriptPath, { hash: true, relatesTo: id }));
    if (hasMeta) {
      resources.push(fileResource("subagent-meta", metaPath, { hash: true, relatesTo: id }));
    }
  }
  return { subagents, resources };
}

// Reads history.jsonl as a stream and keeps, from the lines of this session only, the paste hashes.
async function readPromptHistory(historyPath, sessionId) {
  if (!statOrNull(historyPath)?.isFile()) {
    return { present: false, pasteHashes: [] };
  }
  const lines = readline.createInterface({ input: fs.createReadStream(historyPath), crlfDelay: Infinity });
  let present = false;
  const pasteHashes = new Set();
  for await (const text of lines) {
    let entry;
    try {
      entry = JSON.parse(text);
    } catch {
      continue;
    }
    if (entry?.sessionId !== sessionId) {
      continue;
    }
    present = true;
    const pasted = entry.pastedContents;
    const pastes = Array.isArray(pasted) ? pasted : pasted && typeof pasted === "object" ? Object.values(pasted) : [];
    for (const paste of pastes) {
      if (typeof paste?.contentHash === "string" && /^[0-9A-Za-z]+$/.test(paste.contentHash)) {
        pasteHashes.add(paste.contentHash);
      }
    }
  }
  return { present, pasteHashes: [...pasteHashes] };
}

function shellSnapshots(profileDir, startedAt, endedAt) {
  const start = Date.parse(startedAt ?? "");
  const end = Date.parse(endedAt ?? "");
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return [];
  }
  const dir = path.join(profileDir, "shell-snapshots");
  return listDir(dir)
    .filter((name) => {
      const epoch = Number(/-(\d{12,})-/.exec(name)?.[1]);
      return Number.isFinite(epoch) && epoch >= start && epoch <= end;
    })
    .map((name) => fileResource("shell-snapshot", path.join(dir, name), { hash: false }));
}

/**
 * Summarises a Claude Code session for a transfer. `transcriptPath` is the real transcript and
 * locates the session's other files; `snapshot` ({ path, bytes, sha256, takenAt }) is the one copy
 * of the transcript that is read, line by line. Sub-agent files are read and hashed, the prompt
 * history is read for this session's lines, and every other file is listed and never opened.
 * Text excerpts are redacted and cut.
 */
export async function readClaudeSession(transcriptPath, { snapshot, profileDir, now = () => new Date() }) {
  const census = await readTranscript(snapshot.path);
  const sessionId = path.basename(transcriptPath, ".jsonl");
  const shortId = sessionId.slice(0, 8);
  const sidecarDir = path.join(path.dirname(transcriptPath), sessionId);
  const warnings = [];
  if (census.unparseableLines === 1) {
    warnings.push("1 line of the transcript could not be parsed and is only counted.");
  } else if (census.unparseableLines > 1) {
    warnings.push(`${census.unparseableLines} lines of the transcript could not be parsed and are only counted.`);
  }

  const resourcesObservedAt = now().toISOString();
  const resources = [
    { kind: "transcript", path: transcriptPath, bytes: snapshot.bytes, sha256: snapshot.sha256, relatesTo: null, readHint: READ_HINTS.transcript }
  ];
  const { subagents, resources: subagentResources } = readSubagents(census, sidecarDir, warnings);
  resources.push(...subagentResources);
  resources.push(
    ...[
      folderResource("tool-result", path.join(sidecarDir, "tool-results")),
      folderResource("file-history", path.join(profileDir, "file-history", sessionId)),
      folderResource("session-env", path.join(profileDir, "session-env", sessionId))
    ].filter(Boolean)
  );
  const historyPath = path.join(profileDir, "history.jsonl");
  const history = await readPromptHistory(historyPath, sessionId);
  if (history.present) {
    resources.push({
      kind: "prompt-history",
      path: historyPath,
      bytes: statOrNull(historyPath)?.size ?? null,
      sha256: null,
      relatesTo: null,
      readHint: READ_HINTS["prompt-history"]
    });
  }
  for (const hash of history.pasteHashes) {
    const pastePath = path.join(profileDir, "paste-cache", `${hash}.txt`);
    if (statOrNull(pastePath)?.isFile()) {
      resources.push(fileResource("paste", pastePath, { hash: false }));
    }
  }
  resources.push(...shellSnapshots(profileDir, census.startedAt, census.endedAt));
  resources.push(
    ...[
      folderResource("task", path.join(profileDir, "tasks", `session-${shortId}`)),
      folderResource("team", path.join(profileDir, "teams", `session-${shortId}`))
    ].filter(Boolean)
  );
  const notesDir = path.join(profileDir, "session-data");
  resources.push(
    ...listDir(notesDir)
      .filter((name) => name.endsWith(`-${shortId}-session.tmp`))
      .map((name) => fileResource("notes", path.join(notesDir, name), { hash: false }))
  );

  const filesTouched = [...census.edits].map(([filePath, changes]) => {
    const backup = census.backups.get(filePath);
    const hasHistory = typeof backup === "string" && Boolean(statOrNull(path.join(profileDir, "file-history", sessionId, backup))?.isFile());
    return { path: filePath, changes, hasHistory };
  });
  const todos = census.lastTodo?.todos ?? [];
  const openTodos = todos.filter((todo) => todo.status !== "completed");

  return {
    agent: AGENT,
    agentDisplayName: AGENT_DISPLAY_NAME,
    agentVersion: census.agentVersion,
    sessionId,
    title: excerpt(census.title, DESCRIPTION_CHARS),
    cwd: census.cwd,
    gitBranch: census.gitBranch,
    gitCommit: census.gitCommit,
    startedAt: census.startedAt,
    endedAt: census.endedAt,
    model: census.model,
    effort: census.effort,
    permissionMode: census.permissionMode,
    transcriptPath,
    snapshotSha256: snapshot.sha256,
    snapshotBytes: snapshot.bytes,
    snapshotAt: snapshot.takenAt,
    recordCount: census.recordCount,
    unparseableLines: census.unparseableLines,
    counts: census.counts,
    lastRequest: census.lastRequest,
    commands: census.commands,
    filesTouched,
    subagents,
    todoState: census.lastTodo ? { line: census.lastTodo.line, completed: todos.length - openTodos.length, open: openTodos.length } : null,
    openItems: openTodos.map((todo) => ({ kind: "todo", text: excerpt(String(todo.content ?? ""), OPEN_ITEM_CHARS) })),
    resources,
    profileNotes: PROFILE_NOTES.map((note) => ({ ...note })),
    resourcesObservedAt,
    warnings
  };
}
