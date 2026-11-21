import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { outputCommandResult, parseCommandInput, resolveCommandCwd } from "../lib/companion-cli.mjs";
import {
  branchCommit,
  commitsAhead,
  comparablePath,
  getCurrentBranch,
  getRepoRoot,
  isAncestorOfHead,
  isGitRepository,
  listChangedPaths,
  listGitWorktrees,
  removeGitWorktree,
  removeWorktree,
  worktreeIsDirty
} from "../lib/git.mjs";
import { readProcessIdentity } from "../lib/process.mjs";
import { jobState, readJobView, resolveActionableTip, worktreeRemovalMarker } from "../lib/state.mjs";
import { worktreeBranchFor } from "../lib/task-launch.mjs";
import { commandStateDir, openCommandStore, retrying, withCommandStore } from "./store.mjs";

// `worktree`: the worktrees the plugin created for jobs in this workspace, listed and removed.

export const usage = "worktree list [--json] | worktree remove <job-id|label> [--force]";

const NO_REPOSITORY = "No git repository here, so the plugin has no worktrees.";
const FINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const FOLDER_NAME = /^[a-z0-9-]{1,80}$/;

function escapeCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

// The entries of `git worktree list` directly inside `<stateDir>/worktrees/` whose branch is
// `agent/<folder name>`: `{ jobId, branch, path }`.
function pluginWorktreeEntries(repoRoot, stateDir) {
  const root = comparablePath(path.join(stateDir, "worktrees"));
  const found = [];
  for (const entry of listGitWorktrees(repoRoot)) {
    if (path.dirname(comparablePath(entry.path)) !== root) {
      continue;
    }
    const jobId = path.basename(entry.path);
    const branch = worktreeBranchFor(jobId);
    if (entry.branch === `refs/heads/${branch}`) {
      found.push({ jobId, branch, path: entry.path });
    }
  }
  return found;
}

/**
 * The plugin's worktrees of the repository at `repoRoot`: the entries of `git worktree list`
 * directly inside `<stateDir>/worktrees/` whose branch is `agent/<folder name>`, each as `{ jobId,
 * label, branch, path, dirty, ahead, jobState }`. `jobId` is the folder name; `label` and
 * `jobState` come from the tip of that job's chain, or are null and `job pruned` when the job is
 * no longer in the store.
 */
export function listPluginWorktrees(repoRoot, stateDir, store, opts = {}) {
  return pluginWorktreeEntries(repoRoot, stateDir).map(({ jobId, branch, path: worktreePath }) => {
    const tip = resolveActionableTip(store, jobId, opts);
    let dirty = null;
    try {
      dirty = worktreeIsDirty(worktreePath);
    } catch {
      // A folder git cannot read reports no state.
    }
    return {
      jobId,
      label: tip ? (tip.label ?? null) : null,
      branch,
      path: worktreePath,
      dirty,
      ahead: commitsAhead(repoRoot, branch),
      jobState: tip ? tip.state : "job pruned"
    };
  });
}

function renderList(worktrees) {
  if (worktrees.length === 0) {
    return "The plugin has no worktrees in this repository.\n";
  }
  const lines = ["| Job | Label | Branch | Path | Uncommitted | Ahead | Job state |", "| --- | --- | --- | --- | --- | --- | --- |"];
  for (const entry of worktrees) {
    const uncommitted = entry.dirty === null ? "unknown" : entry.dirty ? "yes" : "no";
    lines.push(`| ${[entry.jobId, entry.label ?? "", entry.branch, entry.path, uncommitted, entry.ahead, entry.jobState].map(escapeCell).join(" | ")} |`);
  }
  return `${lines.join("\n")}\n`;
}

/** `worktree list`: every plugin worktree with its uncommitted and unmerged state. */
async function listWorktrees(options, positionals) {
  if (positionals.length > 0) {
    throw unexpectedArgument(positionals[0], "worktree list [--json]");
  }
  const cwd = resolveCommandCwd(options);
  if (!isGitRepository(cwd)) {
    outputCommandResult({ worktrees: [] }, `${NO_REPOSITORY}\n`, options.json);
    return;
  }
  const stateDir = commandStateDir(options);
  const repoRoot = getRepoRoot(cwd);
  const worktrees = await withCommandStore(stateDir, (store) => retrying((opts) => listPluginWorktrees(repoRoot, stateDir, store, opts)));
  outputCommandResult({ worktrees }, renderList(worktrees), options.json);
}

// ---------------------------------------------------------------------------------------------
// Removal

const refused = (message) => ({ ok: false, message });

// The chain's first job, whose id names the worktree folder, for a label or any job id of the
// chain; a reference that is no job of the store names the folder itself.
function resolveFirstJob(store, ref) {
  const tip = resolveActionableTip(store, ref);
  if (tip) {
    return { firstId: tip.chainId, firstJob: readJobView(store, tip.chainId) };
  }
  return { firstId: FOLDER_NAME.test(ref) ? ref : null, firstJob: null };
}

// A job that has just ended releases its provider process a moment later; remove waits for that.
const RELEASE_PENDING = "has not released its provider process yet.";
const RELEASE_WAIT_MS = 8000;
const RELEASE_POLL_MS = 400;

// One read of the chain: the reason it is not idle, or null. A chain that is gone is idle.
function chainBusyReason(store, chainId) {
  return store.read((db) => {
    const chain = db.prepare("SELECT tip_job_id FROM chains WHERE id = ?").get(chainId);
    if (!chain) {
      return null;
    }
    const tip = db.prepare("SELECT * FROM jobs WHERE id = ?").get(chain.tip_job_id);
    const state = tip ? jobState(tip) : null;
    if (tip && !FINAL_STATES.has(state)) {
      return `Job ${tip.id} is ${state}, not finished. Wait for it or cancel it first.`;
    }
    const held = db
      .prepare("SELECT id FROM jobs WHERE chain_id = ? AND claimed_at IS NOT NULL AND exec_released_at IS NULL ORDER BY created_at, id LIMIT 1")
      .get(chainId);
    return held ? `Job ${held.id} ${RELEASE_PENDING} Try again after it is released.` : null;
  });
}

/**
 * The first half of `worktree remove <ref>`: resolves the plugin worktree of `ref`, creates its
 * removal marker exclusively (an existing marker is refused and left as it is), and then reads
 * the chain once, which must be idle. Returns `{ ok: true, context }` for finishWorktreeRemoval,
 * or `{ ok: false, message }` with the marker, if created, deleted again. `identity` (`{ pid,
 * startToken }`) is written into the marker; `hooks.afterChainRead` runs after the chain read.
 * `force` goes into the context for finishWorktreeRemoval and changes nothing here.
 */
export function beginWorktreeRemoval(ref, { cwd, stateDir, store, identity, force = false, hooks = {} }) {
  if (!isGitRepository(cwd)) {
    return refused(NO_REPOSITORY);
  }
  const repoRoot = getRepoRoot(cwd);
  const { firstId, firstJob } = resolveFirstJob(store, ref);
  const entry = firstId ? pluginWorktreeEntries(repoRoot, stateDir).find((candidate) => candidate.jobId === firstId) : null;
  if (!entry) {
    return refused(`No plugin worktree for ${ref}.`);
  }
  const recordedPath = firstJob?.request?.worktree?.path ?? null;
  if (firstJob && (!recordedPath || comparablePath(recordedPath) !== comparablePath(entry.path))) {
    return refused(`Worktree ${entry.path} does not match job ${firstId} (branch ${entry.branch}).`);
  }
  const worktreePath = recordedPath ?? entry.path;
  const markerPath = worktreeRemovalMarker(worktreePath);
  let fd;
  try {
    fd = fs.openSync(markerPath, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") {
      return refused(
        `Another removal of ${worktreePath} is in progress. If no remover and no session uses this workspace, delete ${markerPath} and run the command again.`
      );
    }
    return refused(`The removal marker ${markerPath} could not be created: ${error.message}`);
  }
  const context = { repoRoot, worktreePath, branch: entry.branch, markerPath, force, hooks };
  try {
    fs.writeSync(fd, JSON.stringify({ pid: identity?.pid ?? process.pid, startToken: identity?.startToken ?? null }));
  } finally {
    fs.closeSync(fd);
  }
  try {
    const busy = chainBusyReason(store, firstId);
    if (busy) {
      fs.rmSync(markerPath, { force: true });
      return refused(busy);
    }
    hooks.afterChainRead?.();
  } catch (error) {
    fs.rmSync(markerPath, { force: true });
    throw error;
  }
  return { ok: true, context };
}

/**
 * The second half of `worktree remove`: the worktree must be clean and its branch's commit
 * contained in the checkout's HEAD; then the worktree is removed and the branch deleted only if
 * it still points at that commit. With `context.force` neither check applies: the worktree is
 * removed with `git worktree remove --force`, the branch is deleted, and the message names what
 * was discarded. The marker is deleted at the end, whatever the outcome, after `git worktree
 * remove` has finished or failed. `context.hooks.beforeRemove` runs after the checks. Returns
 * `{ ok, message }`.
 */
export function finishWorktreeRemoval(context) {
  const { repoRoot, worktreePath, branch, markerPath, force = false, hooks = {} } = context;
  try {
    if (force) {
      return forceRemoval(repoRoot, worktreePath, branch, hooks);
    }
    let dirty;
    try {
      dirty = worktreeIsDirty(worktreePath);
    } catch (error) {
      return refused(`Worktree ${worktreePath} cannot be read: ${error.message}`);
    }
    if (dirty) {
      return refused(
        `Worktree ${worktreePath} has uncommitted changes. See them with: git -C "${worktreePath}" status. ` +
          "To remove it and discard those changes, add --force."
      );
    }
    const sha = branchCommit(repoRoot, branch);
    if (!sha) {
      return refused(`Branch ${branch} does not exist.`);
    }
    if (!isAncestorOfHead(repoRoot, sha)) {
      const current = getCurrentBranch(repoRoot);
      return refused(
        `Branch ${branch} has ${commitsAhead(repoRoot, branch)} commit(s) that ${current} does not have. See them with: git log ${current}..${branch}`
      );
    }
    hooks.beforeRemove?.();
    const outcome = removeGitWorktree(repoRoot, worktreePath, branch, sha);
    if (outcome.worktreeRemoved && outcome.branchDeleted) {
      return { ok: true, message: `Removed worktree ${worktreePath} and branch ${branch}.` };
    }
    if (outcome.worktreeRemoved) {
      return refused(`Removed worktree ${worktreePath}, but kept branch ${branch}: ${outcome.error}.`);
    }
    return refused(outcome.error);
  } finally {
    fs.rmSync(markerPath, { force: true });
  }
}

// The forced removal of finishWorktreeRemoval, which runs inside its marker cleanup: counts the
// uncommitted paths and the commits the checkout lacks where git can read them, then removes the
// worktree with `git worktree remove --force` and deletes the branch. When the branch held commits
// the checkout lacks, or their count is unknown, the message names its commit to restore it from.
function forceRemoval(repoRoot, worktreePath, branch, hooks) {
  let changedPaths = null;
  try {
    changedPaths = listChangedPaths(worktreePath, { mode: "working-tree" }).length;
  } catch {
    // A worktree git cannot read is removed without a count.
  }
  const sha = branchCommit(repoRoot, branch);
  if (!sha) {
    return refused(`Branch ${branch} does not exist.`);
  }
  let commits = null;
  try {
    commits = commitsAhead(repoRoot, branch);
  } catch {
    // The count is only reported.
  }
  const current = getCurrentBranch(repoRoot);
  hooks.beforeRemove?.();
  try {
    removeWorktree(repoRoot, worktreePath, branch);
  } catch (error) {
    if (fs.existsSync(worktreePath)) {
      return refused(error.message);
    }
    return refused(`Removed worktree ${worktreePath}, but kept branch ${branch}: ${error.message}`);
  }
  const discarded = [];
  if (changedPaths === null) {
    discarded.push("uncommitted changes that could not be counted");
  } else if (changedPaths > 0) {
    discarded.push(`${changedPaths} uncommitted path(s)`);
  }
  if (commits === null) {
    discarded.push(`commits of ${branch} that could not be counted`);
  } else if (commits > 0) {
    discarded.push(`${commits} commit(s) that ${current} does not have`);
  }
  const lines = [`Removed worktree ${worktreePath} and branch ${branch}.`];
  if (discarded.length > 0) {
    lines.push(`Discarded ${discarded.join(" and ")}.`);
  }
  if (commits === null || commits > 0) {
    lines.push(`The branch pointed at ${sha}; restore it with: git branch ${branch} ${sha}`);
  }
  return { ok: true, message: lines.join("\n") };
}

/** `worktree remove` as one call: beginWorktreeRemoval, then finishWorktreeRemoval. */
export function removePluginWorktree(ref, options) {
  const begun = beginWorktreeRemoval(ref, options);
  return begun.ok ? finishWorktreeRemoval(begun.context) : begun;
}

function unexpectedArgument(token, form) {
  return new Error(
    token.startsWith("-")
      ? `Unknown option ${token}. Usage: node scripts/agent-companion.mjs ${form}`
      : `Unexpected argument ${token}. Usage: node scripts/agent-companion.mjs ${form}`
  );
}

/**
 * `worktree remove <job-id|label> [--force]`: removes a plugin worktree and its branch only when
 * the job is finished and released, the worktree is clean, and the branch has no commit the
 * checkout lacks. `--force` drops the last two conditions and discards the uncommitted changes and
 * the commits; the job must still be finished and released.
 */
async function removeWorktreeCommand(options, positionals) {
  const form = "worktree remove <job-id|label> [--force]";
  const force = options.force === true;
  const [ref, ...rest] = positionals;
  const extra = rest[0] ?? (ref?.startsWith("-") ? ref : undefined);
  if (extra !== undefined) {
    throw unexpectedArgument(extra, form);
  }
  if (!ref) {
    throw new Error(`Usage: node scripts/agent-companion.mjs ${form}`);
  }
  const cwd = resolveCommandCwd(options);
  if (!isGitRepository(cwd)) {
    throw new Error(NO_REPOSITORY);
  }
  const observed = await readProcessIdentity(process.pid);
  const identity = { pid: process.pid, startToken: observed?.state === "present" ? (observed.startToken ?? null) : null };
  const stateDir = commandStateDir(options);
  const store = await openCommandStore(stateDir);
  let outcome;
  try {
    const deadline = Date.now() + RELEASE_WAIT_MS;
    for (;;) {
      outcome = removePluginWorktree(ref, { cwd, stateDir, store, identity, force });
      if (outcome.ok || !String(outcome.message).includes(RELEASE_PENDING) || Date.now() >= deadline) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, RELEASE_POLL_MS));
    }
  } finally {
    store.close();
  }
  if (!outcome.ok) {
    throw new Error(outcome.message);
  }
  outputCommandResult({ removed: true, message: outcome.message }, `${outcome.message}\n`, options.json);
}

const ACTIONS = {
  list: listWorktrees,
  remove: removeWorktreeCommand
};

/** `worktree <action> ...`; a single argument string is split as the command file passes it. */
export async function run(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json", "force"] });
  const [action, ...rest] = positionals;
  const handler = action && Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
  if (!handler) {
    throw new Error(`Unknown worktree action${action ? ` "${action}"` : ""}. Usage: node scripts/agent-companion.mjs ${usage}`);
  }
  await handler(options, rest);
}
