import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// Identity and heartbeat files of running workers and monitors: <stateDir>/store/live/<role>-<pid>.json.
// A file is rewritten whole by a rename, and its counter rises by one on every rewrite. The files
// help a monitor judge staleness and a user find holders; they prove nothing about which
// processes exist.

const PRIVATE_FILE_MODE = 0o600;
const RENAME_RETRY_MS = 200;
const counters = new Map();

function liveDir(stateDir) {
  return path.join(stateDir, "store", "live");
}

function liveFile(stateDir, role, pid) {
  return path.join(liveDir(stateDir), `${role}-${pid}.json`);
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function previousCounter(file) {
  try {
    const counter = JSON.parse(fs.readFileSync(file, "utf8")).counter;
    return Number.isSafeInteger(counter) ? counter : 0;
  } catch {
    return 0;
  }
}

/**
 * Rewrites this process's file for `role` with `fields` and a counter one above the previous one.
 * `fields.pid` names the process (default: this process). Throws when the file cannot be written.
 */
export function writeLiveFile(stateDir, role, fields = {}) {
  const pid = fields.pid ?? process.pid;
  const file = liveFile(stateDir, role, pid);
  const counter = (counters.get(file) ?? previousCounter(file)) + 1;
  if (!Number.isSafeInteger(counter)) {
    throw new RangeError("The heartbeat counter left the safe integer range.");
  }
  const temp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temp, `${JSON.stringify({ role, ...fields, pid, counter, writtenAt: Date.now() })}\n`, { mode: PRIVATE_FILE_MODE });
  const deadline = Date.now() + RENAME_RETRY_MS;
  for (;;) {
    try {
      fs.renameSync(temp, file);
      break;
    } catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error?.code) || Date.now() >= deadline) {
        fs.rmSync(temp, { force: true });
        throw error;
      }
      sleepSync(10);
    }
  }
  counters.set(file, counter);
  return counter;
}

/** Removes this process's file for `role`. */
export function removeLiveFile(stateDir, role, pid = process.pid) {
  const file = liveFile(stateDir, role, pid);
  counters.delete(file);
  fs.rmSync(file, { force: true });
}

/**
 * Reads the heartbeat of the worker named by `claim` (`{ pid, startToken, jobId, execGen }`): valid
 * only when the file parses, names that exact claim and holds a safe integer counter.
 */
export function readLiveSample(stateDir, claim) {
  let text;
  try {
    text = fs.readFileSync(liveFile(stateDir, "worker", claim.pid), "utf8");
  } catch (error) {
    return { valid: false, reason: error?.code === "ENOENT" ? "missing" : "unreadable" };
  }
  let sample;
  try {
    sample = JSON.parse(text);
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (!sample || typeof sample !== "object") {
    return { valid: false, reason: "malformed" };
  }
  if (sample.pid !== claim.pid || sample.startToken !== claim.startToken || sample.jobId !== claim.jobId || sample.execGen !== claim.execGen) {
    return { valid: false, reason: "mismatch" };
  }
  if (!Number.isSafeInteger(sample.counter)) {
    return { valid: false, reason: "malformed" };
  }
  return { valid: true, counter: sample.counter };
}

/** The identity files that parse, for telling a user which processes may hold the store. */
export function listLiveFiles(stateDir) {
  let names;
  try {
    names = fs.readdirSync(liveDir(stateDir));
  } catch {
    return [];
  }
  const files = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    try {
      const sample = JSON.parse(fs.readFileSync(path.join(liveDir(stateDir), name), "utf8"));
      files.push({ file: name, role: sample.role ?? null, pid: sample.pid ?? null, jobId: sample.jobId ?? null, writtenAt: sample.writtenAt ?? null });
    } catch {
      files.push({ file: name, role: null, pid: null, jobId: null, writtenAt: null });
    }
  }
  return files;
}

/**
 * Judges worker staleness by poll count, never by clock: `observeBatch(pollAt, samples)` takes
 * one poll's samples (`Map<execKey, { claim, sample }>`) and returns, per execution, `fresh`,
 * `counting` or `stale` with the claim and the last valid counter it judged against. Only a valid
 * sample with a counter above the last valid one resets a count; a gap between polls longer than
 * `gapMs` resets every count.
 */
export function createStaleTracker({ stalePolls = 8, gapMs = 4000 } = {}) {
  let entries = new Map();
  let lastPollAt = null;
  const sameClaim = (left, right) =>
    left.pid === right.pid && left.startToken === right.startToken && left.jobId === right.jobId && left.execGen === right.execGen;
  return {
    observeBatch(pollAt, samples) {
      if (lastPollAt !== null && pollAt - lastPollAt > gapMs) {
        for (const entry of entries.values()) {
          entry.count = 0;
        }
      }
      lastPollAt = pollAt;
      const next = new Map();
      const verdicts = new Map();
      for (const [key, { claim, sample }] of samples) {
        let entry = entries.get(key);
        if (!entry || !sameClaim(entry.claim, claim)) {
          entry = { claim, count: 0, lastValidCounter: null };
        }
        let verdict;
        if (sample?.valid && (entry.lastValidCounter === null || sample.counter > entry.lastValidCounter)) {
          entry.count = 0;
          entry.lastValidCounter = sample.counter;
          verdict = "fresh";
        } else {
          entry.count += 1;
          verdict = entry.count >= stalePolls ? "stale" : "counting";
        }
        next.set(key, entry);
        verdicts.set(key, { verdict, claim: entry.claim, lastValidCounter: entry.lastValidCounter, count: entry.count });
      }
      entries = next;
      return verdicts;
    },
    reset() {
      entries = new Map();
      lastPollAt = null;
    }
  };
}
