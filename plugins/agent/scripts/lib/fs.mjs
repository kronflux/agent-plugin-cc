import fs from "node:fs";
import path from "node:path";

export function ensureAbsolutePath(cwd, maybePath) {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

const STDIN_CHUNK_SIZE = 64 * 1024;
const STDIN_RETRY_MAX_DELAY_MS = 200;
// A non-blocking pipe that has not received anything yet cannot be told apart from a writer
// that never writes, so input that has not started within this time is read as empty.
const STDIN_FIRST_BYTE_TIMEOUT_MS = 5000;
// A writer that sends part of its input and then stalls without closing the pipe ends the read
// at this deadline, counted from the start of the read; what arrived until then is returned.
const STDIN_TOTAL_TIMEOUT_MS = 30000;
const TRANSIENT_READ_CODES = new Set(["EAGAIN", "EWOULDBLOCK"]);

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Reads all of stdin unless it is a terminal. When stdin is a non-blocking pipe, a read can
 * fail with EAGAIN before data is available; such reads are retried with backoff instead of
 * failing, until the first-byte or the total deadline passes.
 */
export function readStdinIfPiped(options = {}) {
  const stdin = options.stdin ?? process.stdin;
  const readSync = options.readSync ?? fs.readSync;
  const wait = options.wait ?? sleepSync;
  const now = options.now ?? Date.now;
  const firstByteTimeoutMs = options.firstByteTimeoutMs ?? STDIN_FIRST_BYTE_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? STDIN_TOTAL_TIMEOUT_MS;
  if (stdin.isTTY) {
    return "";
  }

  // One scratch buffer serves every read; each chunk is copied out before the next read.
  const buffer = Buffer.allocUnsafe(STDIN_CHUNK_SIZE);
  const chunks = [];
  const startedAt = now();
  let delay = 5;
  for (;;) {
    let bytesRead;
    try {
      bytesRead = readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error?.code === "EOF") {
        break;
      }
      if (!TRANSIENT_READ_CODES.has(error?.code)) {
        throw error;
      }
      const elapsed = now() - startedAt;
      if (elapsed >= totalTimeoutMs || (chunks.length === 0 && elapsed >= firstByteTimeoutMs)) {
        break;
      }
      wait(delay);
      delay = Math.min(delay * 2, STDIN_RETRY_MAX_DELAY_MS);
      continue;
    }
    if (bytesRead === 0) {
      break;
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    delay = 5;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Reads a hook's JSON input from stdin. Empty input is an empty object; input that does not
 * parse throws an error that says the hook input is not valid JSON.
 */
export function readHookInputJson(options = {}) {
  const raw = readStdinIfPiped(options).trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Hook input is not valid JSON: ${error.message}`);
  }
}
