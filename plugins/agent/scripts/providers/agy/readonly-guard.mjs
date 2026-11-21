import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { gitExecutable } from "../../lib/system-tools.mjs";

// The read-only guard of Antigravity jobs without --write. agy's deny settings refuse the file
// tools a read-only turn must not use, but other tools stay available, so the guard compares the
// working tree before and after the turn and watches the stream for write tools.

/**
 * Whether agy's flags alone enforce a read-only turn. On agy 1.5.10 the session deny rules refused
 * every edit tried, but `--sandbox` alone did not, and tools outside the deny rules stay available,
 * so the guard applies by default.
 */
export const READ_ONLY_ENFORCED_BY_FLAGS = false;

/** The tool names that only read; a turn that ran no other tool cannot have changed a file. */
export const AGY_READ_TOOL_NAMES = Object.freeze(["read_file", "read_url", "invoke_subagent"]);

/** The tool names whose call in a read-only turn counts as a write. */
export const AGY_WRITE_TOOL_NAMES = Object.freeze(["write_file", "edit_file", "run_command"]);

/**
 * "on" or "off": AGY_COMPANION_READONLY_GUARD when it is one of them, else "off" when flags enforce
 * read-only and "on" when they do not.
 */
export function readOnlyGuardMode(env = process.env) {
  const value = String(env.AGY_COMPANION_READONLY_GUARD ?? "").trim().toLowerCase();
  if (value === "on" || value === "off") {
    return value;
  }
  return READ_ONLY_ENFORCED_BY_FLAGS ? "off" : "on";
}

function git(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn(gitExecutable(), args, { cwd, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? Buffer.concat(chunks) : null));
  });
}

function hashOf(file) {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * The paths `git status --porcelain=v1 -z --untracked-files=all` lists in `cwd`, each mapped to the
 * SHA-256 of its content (null for a deleted path); both paths of a rename or copy are listed.
 * Null outside a git repository. Ignored files are not seen.
 */
export async function snapshotWorkingTree(cwd) {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top === null) {
    return null;
  }
  const root = top.toString("utf8").trim();
  const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status === null) {
    return null;
  }
  const entries = status.toString("utf8").split("\0");
  const snapshot = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 4) {
      continue;
    }
    const code = entry.slice(0, 2);
    const paths = [entry.slice(3)];
    // A rename or copy entry is followed by its source path.
    if (code.includes("R") || code.includes("C")) {
      paths.push(entries[index + 1]);
      index += 1;
    }
    for (const relative of paths.filter(Boolean)) {
      snapshot.set(relative, hashOf(path.join(root, relative)));
    }
  }
  return snapshot;
}

/** The paths added, removed or with a different hash between two snapshots, sorted. */
export function changedPaths(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((entry) => !before.has(entry) || !after.has(entry) || before.get(entry) !== after.get(entry)).sort();
}
