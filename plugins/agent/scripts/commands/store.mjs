import path from "node:path";

import { outputCommandResult, parseCommandInput, resolveCommandCwd } from "../lib/companion-cli.mjs";
import { reconcileStore } from "../lib/job-control.mjs";
import { pruneChains, resolveActionableTip, resolveExactJob, resolveStateDir } from "../lib/state.mjs";
import { RETRY_BUDGETS, StoreError, openStore, pruneArtifacts, recoverStore, wallNow, withRetry } from "../lib/store.mjs";

// The job store access every neutral command shares, and the offline `store recover` subcommand.

export const usage = "store recover [--force]";

/** The workspace state folder of a command's working folder (`--cwd` or the process's). */
export function commandStateDir(options = {}) {
  return resolveStateDir(resolveCommandCwd(options));
}

/** Runs `fn({ deadline, attemptMs })` under the command retry budget (busy and locked only). */
export function retrying(fn) {
  return withRetry(fn, "command");
}

/** Opens the workspace's store with the command busy budget, retrying a busy open. */
export function openCommandStore(stateDir) {
  return retrying((opts) => openStore(stateDir, { busyTimeoutMs: opts.attemptMs, deadline: opts.deadline }));
}

/** Opens the store, runs `fn(store)`, and closes the store. */
export async function withCommandStore(stateDir, fn) {
  const store = await openCommandStore(stateDir);
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

/**
 * The maintenance a reading command runs first: one reconciliation scan (which also launches the
 * workers of committed successors), then the hourly chain prune and, after a prune this process
 * ran, the removal of the pruned jobs' logs.
 */
export async function reconcileAndPrune(stateDir) {
  await reconcileStore(stateDir, { deadline: performance.now() + RETRY_BUDGETS.command.totalMs, budget: "command" });
  const pruned = await withCommandStore(stateDir, async (store) => {
    const now = wallNow();
    const { prunedJobIds } = await retrying((opts) => pruneChains(store, { now }, opts));
    const ran = store.read((db) => db.prepare("SELECT value FROM meta WHERE key = 'last_prune_at'").get()?.value) === String(now);
    return ran ? prunedJobIds : null;
  });
  if (pruned) {
    await pruneArtifacts(stateDir, pruned);
  }
}

/** The log file of a job in the store folder. */
export function jobLogFile(stateDir, jobId) {
  return path.join(stateDir, "store", "artifacts", `${jobId}.log`);
}

/**
 * The view a reading command shows for `ref`: an exact job id names that job, ancestors included;
 * otherwise a label names its chain's tip. Null when nothing matches.
 */
export function resolveReadView(store, ref) {
  return resolveExactJob(store, ref) ?? resolveActionableTip(store, ref);
}

/** The one line a command prints for a store error before it exits with code 1. */
export function storeErrorMessage(error) {
  if (!(error instanceof StoreError)) {
    return null;
  }
  if (error.class === "availability") {
    return `The job store is busy or unavailable (${error.code ?? "unknown"}).`;
  }
  return error.message;
}

// The identity files a refused recovery lists, one line each.
function liveFileLines(liveFiles = []) {
  if (liveFiles.length === 0) {
    return ["No identity file could be read in the store's live folder."];
  }
  return [
    "Identity files found in the store's live folder (informational; a listed process may already have ended):",
    ...liveFiles.map((file) => `- ${file.file}: ${file.role ?? "unknown role"}, process ${file.pid ?? "unknown"}${file.jobId ? `, job ${file.jobId}` : ""}`)
  ];
}

/**
 * `store recover [--force]`: an offline repair. It checks the store's integrity and, only when the
 * check fails, the file is not SQLite, or --force is given, moves the whole store folder aside to
 * an archive folder with one rename. The next command creates a fresh store.
 */
export async function run(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["force", "json"] });
  if (positionals[0] !== "recover" || positionals.length > 1) {
    throw new Error(`Usage: node scripts/agent-companion.mjs ${usage}`);
  }
  const stateDir = commandStateDir(options);
  let outcome;
  try {
    outcome = recoverStore(stateDir, { force: Boolean(options.force) });
  } catch (error) {
    if (error instanceof StoreError && error.class === "in-use") {
      throw new Error([error.message, ...liveFileLines(error.liveFiles)].join("\n"));
    }
    throw error;
  }
  const text = outcome.renamedTo
    ? `Moved the job store to ${outcome.renamedTo}. The next command creates a fresh store; the archive is kept and never deleted by the plugin.\n`
    : `The job store at ${path.join(stateDir, "store")} is healthy; nothing was moved.\n`;
  outputCommandResult({ healthy: Boolean(outcome.healthy), renamedTo: outcome.renamedTo ?? null }, text, options.json);
}
