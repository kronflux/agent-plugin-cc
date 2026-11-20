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

// A pipe that has not received anything yet cannot be told apart from a writer that never
// writes, so input that has not started within this time is read as empty.
const STDIN_FIRST_BYTE_TIMEOUT_MS = 5000;
// A writer that stalls without closing the pipe, or that never stops writing, ends the read at
// this deadline, counted from the start of the read; what arrived until then is returned.
const STDIN_TOTAL_TIMEOUT_MS = 30000;

/**
 * Resolves to all of stdin, or to an empty string at once when stdin is a terminal or already
 * closed. A stream that closes or is destroyed without an end resolves to what arrived. The read is
 * asynchronous, so the first-byte and total deadlines end it on every platform, including a
 * Windows pipe whose writer stalls. A read ended by a deadline resolves to what arrived and
 * destroys stdin, so the open pipe does not keep the process alive.
 */
export function readStdinIfPiped(options = {}) {
  const stdin = options.stdin ?? process.stdin;
  const firstByteTimeoutMs = options.firstByteTimeoutMs ?? STDIN_FIRST_BYTE_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? STDIN_TOTAL_TIMEOUT_MS;
  if (stdin.isTTY || stdin.readableEnded || stdin.destroyed) {
    return Promise.resolve("");
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    let firstByteTimer = null;
    let totalTimer = null;

    const finish = ({ error = null, timedOut = false } = {}) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(firstByteTimer);
      clearTimeout(totalTimer);
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("close", onClose);
      stdin.off("error", onError);
      if (timedOut || error) {
        // An error the closing pipe reports after the read ended is not the read's error.
        stdin.on("error", () => {});
        stdin.destroy();
      }
      if (error) {
        reject(error);
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      clearTimeout(firstByteTimer);
    };
    const onEnd = () => finish();
    const onClose = () => finish();
    // A closed pipe can report end of input as an EOF error.
    const onError = (error) => finish(error?.code === "EOF" ? {} : { error });

    firstByteTimer = setTimeout(() => finish({ timedOut: true }), firstByteTimeoutMs);
    totalTimer = setTimeout(() => finish({ timedOut: true }), totalTimeoutMs);
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("close", onClose);
    stdin.on("error", onError);
    stdin.resume();
  });
}

/**
 * Resolves to a hook's JSON input from stdin. Empty input is an empty object; input that does
 * not parse, including input cut short by a deadline, rejects with an error that says the hook
 * input is not valid JSON.
 */
export async function readHookInputJson(options = {}) {
  const raw = (await readStdinIfPiped(options)).trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Hook input is not valid JSON: ${error.message}`);
  }
}
