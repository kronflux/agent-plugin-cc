import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";
import { fenceFor } from "./render.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;
const MAX_INLINE_UNTRACKED_FILES = 20;

// Git is directly executable on Windows. Repository-derived arguments must never pass through a shell.
function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options, shell: false });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options, shell: false });
}

// A file name as one line of a summary: a name with a control character is written as a JSON string.
function formatFileName(name) {
  const hasControl = [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  return hasControl ? JSON.stringify(name) : name;
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeMaxInlineFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILES;
  }
  return Math.floor(parsed);
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function measureGitOutputBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}

function measureCombinedGitOutputBytes(cwd, argSets, maxBytes) {
  let totalBytes = 0;
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) {
      return maxBytes + 1;
    }
    totalBytes += measureGitOutputBytes(cwd, args, remainingBytes);
    if (totalBytes > maxBytes) {
      return totalBytes;
    }
  }
  return totalBytes;
}

function buildBranchComparison(cwd, baseRef) {
  if (String(baseRef).startsWith("-")) {
    throw new Error(`--base must name a branch or commit, not an option: ${baseRef}`);
  }
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

function branchExists(repoRoot, branch) {
  return git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
}

// A path in a form two spellings of one folder share: resolved, through symlinks and short names
// where the folder or its parent exists, and in lower case on Windows.
export function comparablePath(target) {
  const resolved = path.resolve(target);
  let real = resolved;
  try {
    real = fs.realpathSync.native(resolved);
  } catch {
    try {
      real = path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved));
    } catch {
      // The path is compared as resolved.
    }
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

function isRegisteredWorktree(repoRoot, worktreePath) {
  const wanted = comparablePath(worktreePath);
  return gitChecked(repoRoot, ["worktree", "list", "--porcelain"])
    .stdout.split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .some((line) => comparablePath(line.slice("worktree ".length)) === wanted);
}

/**
 * Creates a worktree at `worktreePath` on the new branch `branch`, starting from HEAD. When
 * `git worktree add` fails after it created the branch, the folder or the registration, for
 * example because a checkout hook failed, it removes what it created before it rethrows. A
 * branch, folder or registration that existed before the call is left alone, an existing empty
 * folder is left empty with its mode, and other worktrees' registrations are never touched.
 */
export function createWorktree(repoRoot, worktreePath, branch) {
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  const branchExisted = branchExists(repoRoot, branch);
  const folderExisted = fs.existsSync(worktreePath);
  const folderMode = folderExisted ? fs.statSync(worktreePath).mode & 0o7777 : null;
  const registeredBefore = isRegisteredWorktree(repoRoot, worktreePath);
  try {
    gitChecked(repoRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
  } catch (error) {
    try {
      discardFailedWorktree(repoRoot, worktreePath, branch, { branchExisted, folderExisted, folderMode, registeredBefore });
    } catch (cleanupError) {
      throw new Error(
        `${error.message} The worktree ${worktreePath} (branch ${branch}) could not be removed: ${cleanupError.message}`,
        { cause: error }
      );
    }
    throw error;
  }
}

function discardFailedWorktree(repoRoot, worktreePath, branch, { branchExisted, folderExisted, folderMode, registeredBefore }) {
  if (!registeredBefore && isRegisteredWorktree(repoRoot, worktreePath)) {
    // A second --force also removes a worktree git still holds locked from the failed add.
    const removed = git(repoRoot, ["worktree", "remove", "--force", "--force", worktreePath]);
    if (removed.status !== 0 && isRegisteredWorktree(repoRoot, worktreePath)) {
      throw new Error(formatCommandFailure(removed));
    }
  }
  if (!folderExisted) {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  } else {
    if (!fs.existsSync(worktreePath)) {
      // git accepts an existing folder only when it is empty, so the folder is restored empty.
      fs.mkdirSync(worktreePath);
    }
    try {
      fs.chmodSync(worktreePath, folderMode);
    } catch {
      // A mode that cannot be restored does not hide the git error or stop the branch cleanup.
    }
  }
  if (!branchExisted && branchExists(repoRoot, branch)) {
    gitChecked(repoRoot, ["branch", "-D", branch]);
  }
}

// Deletes the administrative folder of the worktree registered at `worktreePath`, which is what
// `git worktree prune` does for each missing worktree, for this one path only.
function forgetWorktreeRegistration(repoRoot, worktreePath) {
  const commonDir = path.resolve(repoRoot, gitChecked(repoRoot, ["rev-parse", "--git-common-dir"]).stdout.trim());
  const adminRoot = path.join(commonDir, "worktrees");
  let names;
  try {
    names = fs.readdirSync(adminRoot);
  } catch {
    return;
  }
  const wanted = comparablePath(worktreePath);
  for (const name of names) {
    let gitdir;
    try {
      gitdir = fs.readFileSync(path.join(adminRoot, name, "gitdir"), "utf8").trim();
    } catch {
      continue;
    }
    if (comparablePath(path.dirname(path.resolve(adminRoot, name, gitdir))) === wanted) {
      fs.rmSync(path.join(adminRoot, name), { recursive: true, force: true });
    }
  }
}

/**
 * Removes the worktree at `worktreePath` and deletes its branch `branch`. A failed step is
 * ignored only when its worktree folder or branch is already gone; otherwise it throws.
 */
export function removeWorktree(repoRoot, worktreePath, branch) {
  const removed = git(repoRoot, ["worktree", "remove", "--force", worktreePath]);
  if (removed.status !== 0) {
    if (fs.existsSync(worktreePath)) {
      throw new Error(formatCommandFailure(removed));
    }
    // A folder deleted without git can leave its registration, which keeps the branch checked
    // out; only that one registration is removed, never another worktree's.
    forgetWorktreeRegistration(repoRoot, worktreePath);
  }
  const deleted = git(repoRoot, ["branch", "-D", branch]);
  if (deleted.status !== 0) {
    const exists = git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (exists.status === 0) {
      throw new Error(formatCommandFailure(deleted));
    }
  }
}

/**
 * The worktrees of the repository at `repoRoot` from `git worktree list --porcelain`, the main
 * checkout first: `{ path, branch, head }`, `branch` the full ref name or null when detached.
 */
export function listGitWorktrees(repoRoot) {
  const entries = [];
  let current = null;
  for (const line of gitChecked(repoRoot, ["worktree", "list", "--porcelain"]).stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: path.resolve(line.slice("worktree ".length)), branch: null, head: null };
      entries.push(current);
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    }
  }
  return entries;
}

/** True when the worktree at `worktreePath` has staged, unstaged or untracked changes. */
export function worktreeIsDirty(worktreePath) {
  return gitChecked(worktreePath, ["status", "--porcelain"]).stdout.trim() !== "";
}

/** The number of commits on the local branch `branch` that the checkout's HEAD does not have. */
export function commitsAhead(repoRoot, branch) {
  return Number.parseInt(gitChecked(repoRoot, ["rev-list", "--count", `HEAD..refs/heads/${branch}`]).stdout.trim(), 10) || 0;
}

// The first non-empty line of a failed git command's error output.
function firstErrorLine(result) {
  const text = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? (result.error ? result.error.message : `git exited ${result.status}`)
  );
}

/**
 * Removes a clean worktree and then its branch, only while the branch still points at
 * `expectedSha`: `git worktree remove <path>` (never forced), then `git update-ref -d
 * refs/heads/<branch> <expectedSha>`. Returns `{ worktreeRemoved, branchDeleted, error }`, with
 * git's first error line when a step failed.
 */
export function removeGitWorktree(repoRoot, worktreePath, branch, expectedSha) {
  const removed = git(repoRoot, ["worktree", "remove", worktreePath]);
  if (removed.error || removed.status !== 0) {
    return { worktreeRemoved: false, branchDeleted: false, error: firstErrorLine(removed) };
  }
  const deleted = git(repoRoot, ["update-ref", "-d", `refs/heads/${branch}`, expectedSha]);
  if (deleted.error || deleted.status !== 0) {
    return { worktreeRemoved: true, branchDeleted: false, error: firstErrorLine(deleted) };
  }
  return { worktreeRemoved: true, branchDeleted: true, error: null };
}

/** The commit a local branch points at, or null when it does not exist. */
export function branchCommit(repoRoot, branch) {
  const result = git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
  return result.status === 0 ? result.stdout.trim() : null;
}

/** True when `commit` is an ancestor of, or equal to, the checkout's HEAD. */
export function isAncestorOfHead(repoRoot, commit) {
  return git(repoRoot, ["merge-base", "--is-ancestor", commit, "HEAD"]).status === 0;
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      const name = remoteHead.slice("refs/remotes/origin/".length);
      const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
      return local.status === 0 ? name : `origin/${name}`;
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

// The pathspec arguments that limit a git command to `paths`, relative to the repository root and
// taken literally; none when no path is given or one of them is the root itself.
function pathspec(paths) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.includes(".")) {
    return [];
  }
  return ["--", ...paths.map((entry) => `:(literal)${entry}`)];
}

// The NUL-separated path list git prints with -z, whose names git leaves unquoted.
function splitNulList(output) {
  return output.split("\0").filter(Boolean);
}

/**
 * The staged, unstaged and untracked files of the working tree, limited to `paths` when given.
 * Paths are relative to the repository root and cover the whole repository, whatever folder of
 * it `cwd` is.
 */
export function getWorkingTreeState(cwd, paths = []) {
  const spec = pathspec(paths);
  const repoRoot = getRepoRoot(cwd);
  const staged = splitNulList(gitChecked(repoRoot, ["diff", "--cached", "--name-only", "-z", ...spec]).stdout);
  const unstaged = splitNulList(gitChecked(repoRoot, ["diff", "--name-only", "-z", ...spec]).stdout);
  const untracked = splitNulList(gitChecked(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z", ...spec]).stdout);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

/** True when `cwd` is inside a git working tree; false otherwise, also when git is missing. */
export function isGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return !result.error && result.status === 0 && result.stdout.trim() === "true";
}

/** The number of commits on HEAD that `baseRef` does not contain. */
export function countCommitsAhead(cwd, baseRef) {
  if (String(baseRef).startsWith("-")) {
    throw new Error(`--base must name a branch or commit, not an option: ${baseRef}`);
  }
  return Number.parseInt(gitChecked(cwd, ["rev-list", "--count", `${baseRef}..HEAD`]).stdout.trim(), 10) || 0;
}

/**
 * The paths, relative to the repository root and with forward slashes, that the changes target
 * `target` (a `resolveChangesTarget` result) covers: staged, unstaged and untracked files for the
 * working tree, and the files changed since the merge base for a branch. Deleted files are listed,
 * and a renamed file is listed under its old and its new path.
 */
export function listChangedPaths(cwd, target) {
  const repoRoot = getRepoRoot(cwd);
  const names = (args) => splitNulList(gitChecked(repoRoot, ["diff", "--name-only", "--no-renames", "-z", ...args]).stdout);
  if (target.mode === "working-tree") {
    const untracked = splitNulList(gitChecked(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]).stdout);
    return listUniqueFiles(names(["--cached"]), names([]), untracked);
  }
  return listUniqueFiles(names([buildBranchComparison(repoRoot, target.baseRef).commitRange]));
}

// Throws unless `baseRef` names a commit that shares history with HEAD.
function assertUsableBase(repoRoot, baseRef) {
  if (String(baseRef).startsWith("-")) {
    throw new Error(`--base must name a branch or commit, not an option: ${baseRef}`);
  }
  if (git(repoRoot, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]).status !== 0) {
    throw new Error(`--base ${baseRef} does not name a commit in this repository.`);
  }
  if (git(repoRoot, ["merge-base", "HEAD", baseRef]).status !== 0) {
    throw new Error(`--base ${baseRef} shares no history with HEAD.`);
  }
}

/**
 * Chooses the git comparison a changes review covers: an explicit `base` compares the branch
 * with it, `scope` picks the working tree or the branch, and `auto` takes the working tree when
 * the repository has changes and otherwise the branch against the detected default branch. The
 * scope must be a known one, an explicit base must name a commit that shares history with HEAD,
 * and a base cannot be combined with the working-tree scope.
 * Returns `{ mode, label, baseRef, explicit }`.
 */
export function resolveChangesTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const repoRoot = getRepoRoot(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (baseRef) {
    if (requestedScope === "working-tree") {
      throw new Error("--base compares the branch with a commit and cannot be combined with --scope working-tree.");
    }
    assertUsableBase(repoRoot, baseRef);
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (getWorkingTreeState(repoRoot).isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

// Where the platform defines it, O_NOFOLLOW makes the open itself fail on a symlink.
const UNTRACKED_OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);

// Reads at most `limit` bytes from an open file.
function readAtMost(fd, limit) {
  const buffer = Buffer.alloc(limit);
  let length = 0;
  while (length < limit) {
    const bytesRead = fs.readSync(fd, buffer, length, limit - length, null);
    if (bytesRead === 0) {
      break;
    }
    length += bytesRead;
  }
  return buffer.subarray(0, length);
}

// True when `absolutePath` resolves to a real path inside the real path of `root` and the file
// there is the one `opened` describes. Paths compare case-insensitively on Windows.
function isOpenedFileInside(root, absolutePath, opened) {
  const comparable = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  let realRoot;
  let realFile;
  let atReal;
  try {
    realRoot = comparable(fs.realpathSync(root));
    realFile = fs.realpathSync(absolutePath);
    atReal = fs.statSync(realFile);
  } catch {
    return false;
  }
  const relative = path.relative(realRoot, comparable(realFile));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false;
  }
  return atReal.dev === opened.dev && atReal.ino === opened.ino;
}

// A symlink is never followed, so a link to a file outside the repository cannot leak its text.
// The checks and the read use one file descriptor, so a file replaced by a symlink or grown past
// the size limit after the check cannot change what is read.
function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: unreadable file)`;
  }
  if (stat.isSymbolicLink()) {
    return `### ${relativePath}\n(skipped: symlink)`;
  }
  if (stat.isDirectory()) {
    return `### ${relativePath}\n(skipped: directory)`;
  }

  let fd;
  try {
    fd = fs.openSync(absolutePath, UNTRACKED_OPEN_FLAGS);
  } catch (error) {
    return `### ${relativePath}\n(skipped: ${error?.code === "ELOOP" ? "symlink" : "unreadable file"})`;
  }
  let buffer;
  try {
    const opened = fs.fstatSync(fd);
    // Where O_NOFOLLOW is missing, as on Windows, a file replaced between the lstat and the open
    // shows as a descriptor for another file.
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.isFile() !== stat.isFile()) {
      return `### ${relativePath}\n(skipped: unreadable file)`;
    }
    // A folder on the path replaced by a link reaches a file outside the repository through a
    // path that looks inside it, so the opened file must be the one at a real path inside.
    if (!isOpenedFileInside(cwd, absolutePath, opened)) {
      return `### ${relativePath}\n(skipped: unreadable file)`;
    }
    if (!opened.isFile()) {
      return `### ${relativePath}\n(skipped: not a regular file)`;
    }
    if (opened.size > MAX_UNTRACKED_BYTES) {
      return `### ${relativePath}\n(skipped: ${opened.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
    }
    // One byte past the limit shows a file that grew after the size check.
    buffer = readAtMost(fd, MAX_UNTRACKED_BYTES + 1);
  } catch {
    return `### ${relativePath}\n(skipped: unreadable file)`;
  } finally {
    fs.closeSync(fd);
  }
  if (buffer.length > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: more than ${MAX_UNTRACKED_BYTES} bytes)`;
  }
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  const body = buffer.toString("utf8").trimEnd();
  const fence = fenceFor(body);
  return [`### ${relativePath}`, fence, body, fence].join("\n");
}

function formatUntrackedEntries(cwd, untracked) {
  return untracked.slice(0, MAX_INLINE_UNTRACKED_FILES).map((file) => {
    const text = formatUntrackedFile(cwd, file);
    return { file, text, bytes: Buffer.byteLength(text, "utf8") };
  });
}

// Inlines untracked entries in order while they fit in `budgetBytes`. The rest, and every file past
// the first MAX_INLINE_UNTRACKED_FILES, are listed by name only.
function formatUntrackedSections(untracked, entries, budgetBytes) {
  const inlined = [];
  const notInlined = [];
  let usedBytes = 0;
  for (const entry of entries) {
    if (usedBytes + entry.bytes <= budgetBytes) {
      inlined.push(entry.text);
      usedBytes += entry.bytes;
    } else {
      notInlined.push(entry.file);
    }
  }
  notInlined.push(...untracked.slice(entries.length));
  const sections = [formatSection("Untracked Files", inlined.join("\n\n"))];
  if (notInlined.length > 0) {
    sections.push(formatSection("Untracked files not inlined", notInlined.join("\n")));
  }
  return sections;
}

function collectWorkingTreeContext(cwd, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const spec = options.spec ?? [];
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all", ...spec]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);
  const untrackedEntries = options.untrackedEntries ?? formatUntrackedEntries(cwd, state.untracked);
  const maxInlineDiffBytes = options.maxInlineDiffBytes ?? DEFAULT_INLINE_DIFF_MAX_BYTES;
  const trackedDiffBytes = options.trackedDiffBytes ?? 0;

  let parts;
  if (includeDiff) {
    const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff", ...spec]).stdout;
    const unstagedDiff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", ...spec]).stdout;
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      ...formatUntrackedSections(state.untracked, untrackedEntries, maxInlineDiffBytes - trackedDiffBytes)
    ];
  } else {
    const stagedStat = gitChecked(cwd, ["diff", "--shortstat", "--cached", ...spec]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--shortstat", ...spec]).stdout.trim();
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("Changed Files", changedFiles.map(formatFileName).join("\n")),
      ...formatUntrackedSections(state.untracked, untrackedEntries, maxInlineDiffBytes)
    ];
  }

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles
  };
}

function listBranchChangedFiles(cwd, comparison, spec = []) {
  return splitNulList(gitChecked(cwd, ["diff", "--name-only", "-z", comparison.commitRange, ...spec]).stdout);
}

function collectBranchContext(cwd, baseRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const spec = options.spec ?? [];
  const comparison = options.comparison ?? buildBranchComparison(cwd, baseRef);
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = options.changedFiles ?? listBranchChangedFiles(cwd, comparison, spec);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", comparison.commitRange, ...spec]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange, ...spec]).stdout.trim();

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: includeDiff
      ? [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Branch Diff",
            gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange, ...spec]).stdout
          )
        ].join("\n")
      : [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.map(formatFileName).join("\n"))
        ].join("\n"),
    changedFiles,
    comparison
  };
}

function buildAdversarialCollectionGuidance(options = {}) {
  if (options.includeDiff !== false) {
    return "Use the repository context below as primary evidence.";
  }

  return "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings.";
}

/**
 * Collects the git context of the changes target `target`. `options.paths`, relative to the
 * repository root, limit every part of it alike: the status, the diffs, the stats, the changed
 * files and the untracked files.
 */
export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const spec = pathspec(options.paths);
  const currentBranch = getCurrentBranch(repoRoot);
  const maxInlineFiles = normalizeMaxInlineFiles(options.maxInlineFiles);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  let details;
  let includeDiff;
  let diffBytes;

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot, options.paths);
    const trackedDiffBytes = measureCombinedGitOutputBytes(
      repoRoot,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff", ...spec],
        ["diff", "--binary", "--no-ext-diff", "--submodule=diff", ...spec]
      ],
      maxInlineDiffBytes
    );
    const untrackedEntries = formatUntrackedEntries(repoRoot, state.untracked);
    diffBytes = trackedDiffBytes + untrackedEntries.reduce((total, entry) => total + entry.bytes, 0);
    includeDiff =
      options.includeDiff ??
      (listUniqueFiles(state.staged, state.unstaged, state.untracked).length <= maxInlineFiles &&
        diffBytes <= maxInlineDiffBytes);
    details = collectWorkingTreeContext(repoRoot, state, {
      includeDiff,
      spec,
      untrackedEntries,
      maxInlineDiffBytes,
      trackedDiffBytes
    });
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    const changedFiles = listBranchChangedFiles(repoRoot, comparison, spec);
    const fileCount = changedFiles.length;
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange, ...spec],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectBranchContext(repoRoot, target.baseRef, { includeDiff, comparison, changedFiles, spec });
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    collectionGuidance: buildAdversarialCollectionGuidance({ includeDiff }),
    ...details
  };
}
