import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { homeProfileProjectsDir } from "../../lib/host.mjs";

// Codex imports Claude sessions only from <home>/.claude/projects and does not read
// CLAUDE_CONFIG_DIR. The transcript of a running session also keeps growing. Every transfer
// therefore copies the transcript once into a new folder under <home>/.claude/projects and uses
// that one copy for its hash, the import and the session map.
const STAGING_DIR_PREFIX = ".agent-plugin-transfer-";
const CHUNK_BYTES = 64 * 1024;

// The length of the file's content up to and including its last "\n"; 0 when it has none.
function wholeLineLength(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(CHUNK_BYTES);
    for (let end = size; end > 0; end -= CHUNK_BYTES) {
      const start = Math.max(0, end - CHUNK_BYTES);
      const read = fs.readSync(fd, buffer, 0, end - start, start);
      const index = buffer.subarray(0, read).lastIndexOf(0x0a);
      if (index !== -1) {
        return start + index + 1;
      }
    }
    return 0;
  } finally {
    fs.closeSync(fd);
  }
}

// The length to keep of a transcript copy: all of it when the text after its last "\n" is one
// complete JSON record, otherwise up to and including that newline, so a partial record is cut.
function recordsLength(file) {
  const whole = wholeLineLength(file);
  const size = fs.statSync(file).size;
  if (whole === size) {
    return size;
  }
  const tail = Buffer.alloc(size - whole);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, tail, 0, tail.length, whole);
  } finally {
    fs.closeSync(fd);
  }
  try {
    const record = JSON.parse(tail.toString("utf8"));
    return record !== null && typeof record === "object" ? size : whole;
  } catch {
    return whole;
  }
}

function fileSha256(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    for (let read = fs.readSync(fd, buffer, 0, CHUNK_BYTES, null); read > 0; read = fs.readSync(fd, buffer, 0, CHUNK_BYTES, null)) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * Copies the transcript at `sourcePath` to `<home>/.claude/projects/.agent-plugin-transfer-<hex>/`
 * and cuts the copy after its last newline unless the text after it is one complete JSON record,
 * so it holds whole records only. Returns the copy's
 * path, size, SHA-256 and the time it was taken, and `cleanup()`, which removes the copy's folder
 * and any parent folder the copy created and returns whether the copy is gone. Callers run
 * `cleanup()` in `finally`; a failure while staging cleans up before it throws.
 */
export function stageTranscriptSnapshot(sourcePath) {
  const projects = homeProfileProjectsDir();
  const claudeDir = path.dirname(projects);
  const createdDirs = [claudeDir, projects].filter((dir) => !fs.existsSync(dir));
  const stagingDir = path.join(projects, `${STAGING_DIR_PREFIX}${crypto.randomBytes(6).toString("hex")}`);
  const copyPath = path.join(stagingDir, path.basename(sourcePath));
  const cleanup = () => {
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // Another process holds the copy open; the check below reports it as not removed.
    }
    for (const dir of [...createdDirs].reverse()) {
      try {
        fs.rmdirSync(dir);
      } catch {
        // The folder is not empty or is already gone.
      }
    }
    return !fs.existsSync(copyPath);
  };
  try {
    fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(sourcePath, copyPath);
    fs.truncateSync(copyPath, recordsLength(copyPath));
    return {
      path: copyPath,
      bytes: fs.statSync(copyPath).size,
      sha256: fileSha256(copyPath),
      takenAt: new Date().toISOString(),
      cleanup
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

const RECORD_SCHEMA = 1;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function checkedSessionId(sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`Not a usable Claude session id: ${sessionId}`);
  }
  return sessionId;
}

/** The folder that holds the transfer records and session maps of a workspace state folder. */
export function transfersDir(stateDir) {
  return path.join(stateDir, "transfers");
}

/** The fixed folder of the session map and manifest of one Claude session. */
export function transferMapDir(stateDir, sessionId) {
  return path.join(transfersDir(stateDir), checkedSessionId(sessionId));
}

function transferRecordPath(stateDir, sessionId) {
  return path.join(transfersDir(stateDir), `${checkedSessionId(sessionId)}.json`);
}

/** Writes `text` to `file` through a temporary file in the same folder and a rename. */
export function writeFileReplacing(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, text, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/** The transfer record of a Claude session, or null when there is none or it cannot be read. */
export function readTransferRecord(stateDir, sessionId) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(transferRecordPath(stateDir, sessionId), "utf8"));
  } catch {
    return null;
  }
  return record && record.schema === RECORD_SCHEMA && typeof record.threadId === "string" ? record : null;
}

/**
 * Writes the transfer record, schema 1. `sourcePath` is the real transcript path; `pointer` is
 * "injected", "printed", "prompt-turn", "none" or null; `census` is the imported thread's message
 * count before any pointer, or null.
 */
export function writeTransferRecord(stateDir, record) {
  const value = {
    schema: RECORD_SCHEMA,
    sessionId: checkedSessionId(record.sessionId),
    sourcePath: record.sourcePath,
    sourceSha256: record.sourceSha256,
    threadId: record.threadId,
    previousThreadIds: Array.isArray(record.previousThreadIds) ? record.previousThreadIds : [],
    method: record.method,
    importedAt: record.importedAt,
    mapDir: record.mapDir ?? null,
    pointer: record.pointer ?? null,
    census: record.census ?? null
  };
  writeFileReplacing(transferRecordPath(stateDir, value.sessionId), `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

/** The message appended to an imported thread that names the session map. */
export function importedThreadPointer(mapPath) {
  return `Context for continuing this imported Claude Code session is in ${mapPath}. Read it before acting. The conversation above holds only text, with tool calls and results as tagged text; the full tool activity is described in that file.`;
}

/** The command that resumes `threadId` in Codex. */
export function bareResumeCommand(threadId) {
  return `codex resume ${threadId}`;
}

/** The command that resumes `threadId` with a first prompt naming the session map. */
export function pointerResumeCommand(threadId, mapPath) {
  return `codex resume ${threadId} "Read ${mapPath} before acting."`;
}
