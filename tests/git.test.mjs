import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  collectReviewContext,
  createWorktree,
  getCurrentBranch,
  removeWorktree,
  resolveReviewTarget
} from "../plugins/agent/scripts/lib/git.mjs";
import { makeCommittedRepo, makeTempDir, run } from "./helpers.mjs";

const SYMLINK_SKIP_REASON = "symlinks need Developer Mode or admin on Windows";

function git(cwd, args) {
  return run("git", args, { cwd, check: true, shell: false });
}

function commitAll(cwd, message) {
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", message]);
}

// Creates a symlink, or skips the test when the account may not create one.
function symlinkOrSkip(t, target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath);
    return true;
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip(SYMLINK_SKIP_REASON);
      return false;
    }
    throw error;
  }
}

function makeRepoWithApp(t, content = "console.log('v1');\n") {
  return makeCommittedRepo(t, { files: { "app.js": content } });
}

function makeFeatureBranch(cwd) {
  git(cwd, ["checkout", "-b", "feature/test"]);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  commitAll(cwd, "change");
}

test("resolveReviewTarget prefers working tree when repo is dirty", (t) => {
  const cwd = makeRepoWithApp(t);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");

  const target = resolveReviewTarget(cwd, {});

  assert.equal(target.mode, "working-tree");
});

test("resolveReviewTarget falls back to branch diff when repo is clean", (t) => {
  const cwd = makeRepoWithApp(t);
  makeFeatureBranch(cwd);

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.match(target.label, /main/);
  assert.match(context.content, /Branch Diff/);
});

function makeRepoWithDefaultBranch(t, branchName, extraFiles = {}) {
  const cwd = makeCommittedRepo(t, { files: { "app.js": "console.log('base');\n", ...extraFiles } });
  git(cwd, ["branch", "-m", branchName]);
  git(cwd, ["update-ref", `refs/remotes/origin/${branchName}`, branchName]);
  git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branchName}`]);
  git(cwd, ["checkout", "-b", "feature/test"]);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('feature');\n");
  commitAll(cwd, "feature");
  return cwd;
}

test("default branch names with special characters are passed to git literally", (t) => {
  // cmd.exe payload: a shell would run branch-helper.cmd and create its output file.
  const cmdBranch = "main&branch-helper&x";
  const cmdRepo = makeRepoWithDefaultBranch(t, cmdBranch, {
    "branch-helper.cmd": "@echo branch-helper>branch-helper-output\r\n"
  });
  const cmdTarget = resolveReviewTarget(cmdRepo, {});
  const cmdContext = collectReviewContext(cmdRepo, cmdTarget);
  assert.equal(cmdTarget.mode, "branch");
  assert.equal(cmdTarget.baseRef, cmdBranch);
  assert.match(cmdContext.content, /Branch Diff/);
  assert.equal(fs.existsSync(path.join(cmdRepo, "branch-helper-output")), false);

  // POSIX shell payload: a shell would split at ";" and run touch, creating "pwned".
  const shBranch = "main;touch${IFS}pwned";
  run("git", ["check-ref-format", "--branch", shBranch], { check: true, shell: false });
  const shRepo = makeRepoWithDefaultBranch(t, shBranch);
  const shTarget = resolveReviewTarget(shRepo, {});
  const shContext = collectReviewContext(shRepo, shTarget);
  assert.equal(shTarget.mode, "branch");
  assert.equal(shTarget.baseRef, shBranch);
  assert.match(shContext.content, /Branch Diff/);
  assert.equal(fs.existsSync(path.join(shRepo, "pwned")), false);
});

test("resolveReviewTarget honors explicit base overrides", (t) => {
  const cwd = makeRepoWithApp(t);
  makeFeatureBranch(cwd);

  const target = resolveReviewTarget(cwd, { base: "main" });

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
});

test("resolveReviewTarget requires an explicit base when no default branch can be inferred", (t) => {
  const cwd = makeRepoWithApp(t);
  git(cwd, ["branch", "-m", "feature-only"]);

  assert.throws(
    () => resolveReviewTarget(cwd, {}),
    /Unable to detect the repository default branch\. Pass --base <ref> or use --scope working-tree\./
  );
});

test("the default branch is origin/<name> when no local branch exists", (t) => {
  const cwd = makeRepoWithApp(t);
  git(cwd, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  git(cwd, ["branch", "-m", "feature-only"]);

  const target = resolveReviewTarget(cwd, { scope: "branch" });

  assert.equal(target.baseRef, "origin/main");
  const context = collectReviewContext(cwd, target);
  assert.equal(context.comparison.reviewRange, "origin/main...HEAD");
});

test("a base that starts with a dash is rejected", (t) => {
  const cwd = makeRepoWithApp(t);
  makeFeatureBranch(cwd);

  assert.throws(
    () => collectReviewContext(cwd, { mode: "branch", baseRef: "--output=leak.txt", explicit: true }),
    /--base must name a branch or commit, not an option: --output=leak\.txt/
  );
  assert.equal(fs.existsSync(path.join(cwd, "leak.txt")), false);
});

test("collectReviewContext keeps inline diffs for tiny adversarial reviews", (t) => {
  const cwd = makeRepoWithApp(t);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('INLINE_MARKER');\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "inline-diff");
  assert.equal(context.fileCount, 1);
  assert.match(context.collectionGuidance, /primary evidence/i);
  assert.match(context.content, /INLINE_MARKER/);
});

test("collectReviewContext skips untracked directories in working tree review", (t) => {
  const cwd = makeRepoWithApp(t);
  const nestedRepoDir = path.join(cwd, ".claude", "worktrees", "agent-test");
  fs.mkdirSync(nestedRepoDir, { recursive: true });
  git(nestedRepoDir, ["init", "-b", "main"]);

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const context = collectReviewContext(cwd, target);

  assert.match(context.content, /### \.claude\/worktrees\/agent-test\/\n\(skipped: directory\)/);
});

test("collectReviewContext skips broken untracked symlinks instead of crashing", (t) => {
  const cwd = makeRepoWithApp(t);
  if (!symlinkOrSkip(t, "missing-target", path.join(cwd, "broken-link"))) {
    return;
  }

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "working-tree");
  assert.match(context.content, /### broken-link\n\(skipped: symlink\)/);
});

test("collectReviewContext names an untracked symlink to an outside file as skipped", (t) => {
  const cwd = makeRepoWithApp(t);
  const outside = makeTempDir(t);
  const secretPath = path.join(outside, "secret.txt");
  fs.writeFileSync(secretPath, "OUTSIDE_SECRET_MARKER\n");
  if (!symlinkOrSkip(t, secretPath, path.join(cwd, "leak.txt"))) {
    return;
  }

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, { scope: "working-tree" }));

  assert.match(context.content, /### leak\.txt\n\(skipped: symlink\)/);
  assert.doesNotMatch(context.content, /OUTSIDE_SECRET_MARKER/);
});

test("untracked names with non-ASCII letters are read", (t) => {
  const cwd = makeRepoWithApp(t);
  fs.writeFileSync(path.join(cwd, "café.txt"), "NON_ASCII_BODY_MARKER\n");

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, { scope: "working-tree" }));

  assert.match(context.content, /### café\.txt\n```\nNON_ASCII_BODY_MARKER\n```/);
});

test("only 20 untracked files are inlined", (t) => {
  const cwd = makeRepoWithApp(t);
  for (let index = 0; index < 25; index += 1) {
    const name = `extra-${String(index).padStart(2, "0")}.txt`;
    fs.writeFileSync(path.join(cwd, name), `UNTRACKED_BODY_${index}\n`);
  }

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, { scope: "working-tree" }));

  const bodies = context.content.match(/UNTRACKED_BODY_\d+/g) ?? [];
  assert.equal(bodies.length, 20);
  const notInlined = context.content.split("## Untracked files not inlined")[1];
  assert.ok(notInlined, "the not-inlined section exists");
  for (let index = 20; index < 25; index += 1) {
    assert.match(notInlined, new RegExp(`extra-${index}\\.txt`));
  }
});

test("untracked bodies count toward the inline budget", (t) => {
  const cwd = makeRepoWithApp(t);
  fs.writeFileSync(path.join(cwd, "big-untracked.txt"), `UNTRACKED_BUDGET_MARKER ${"y".repeat(2000)}\n`);

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, { scope: "working-tree" }), {
    maxInlineDiffBytes: 256
  });

  assert.ok(context.diffBytes > 256, `diffBytes ${context.diffBytes} counts the untracked body`);
  assert.equal(context.inputMode, "self-collect");
  assert.doesNotMatch(context.content, /UNTRACKED_BUDGET_MARKER/);
  assert.match(context.content, /## Untracked files not inlined\n\nbig-untracked\.txt/);
});

test("collectReviewContext falls back to lightweight context for larger adversarial reviews", (t) => {
  const files = {};
  for (const name of ["a.js", "b.js", "c.js"]) {
    files[name] = `export const value = "${name}-v1";\n`;
  }
  const cwd = makeCommittedRepo(t, { files });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "SELF_COLLECT_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "SELF_COLLECT_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "c.js"), 'export const value = "SELF_COLLECT_MARKER_C";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fileCount, 3);
  assert.match(context.collectionGuidance, /lightweight summary/i);
  assert.match(context.collectionGuidance, /read-only git commands/i);
  assert.doesNotMatch(context.content, /SELF_COLLECT_MARKER_[ABC]/);
  assert.match(context.content, /## Changed Files/);
});

test("collectReviewContext falls back to lightweight context for oversized single-file diffs", (t) => {
  const cwd = makeRepoWithApp(t, "export const value = 'v1';\n");
  fs.writeFileSync(path.join(cwd, "app.js"), `export const value = '${"x".repeat(512)}';\n`);

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target, { maxInlineDiffBytes: 128 });

  assert.equal(context.fileCount, 1);
  assert.equal(context.inputMode, "self-collect");
  assert.ok(context.diffBytes > 128);
  assert.doesNotMatch(context.content, /xxx/);
  assert.match(context.content, /## Changed Files/);
});

test("collectReviewContext keeps untracked file content in lightweight working tree context", (t) => {
  const cwd = makeCommittedRepo(t, {
    files: { "a.js": 'export const value = "a.js-v1";\n', "b.js": 'export const value = "b.js-v1";\n' }
  });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "TRACKED_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "TRACKED_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "new-risk.js"), 'export const value = "UNTRACKED_RISK_MARKER";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fileCount, 3);
  assert.doesNotMatch(context.content, /TRACKED_MARKER_[AB]/);
  assert.match(context.content, /## Untracked Files/);
  assert.match(context.content, /UNTRACKED_RISK_MARKER/);
});

test("git runs git.exe directly, not a git.cmd found earlier on PATH", { skip: process.platform !== "win32" && "Windows command resolution" }, (t) => {
  const cwd = makeRepoWithApp(t);
  const fakeDir = makeTempDir(t);
  const marker = path.join(fakeDir, "fake-git-ran.txt");
  fs.writeFileSync(path.join(fakeDir, "git.cmd"), `@echo off\r\necho fake> "${marker}"\r\necho fake-branch\r\n`);
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const savedPath = process.env[pathKey];
  process.env[pathKey] = `${fakeDir};${savedPath}`;
  let branch;
  try {
    branch = getCurrentBranch(cwd);
  } finally {
    process.env[pathKey] = savedPath;
  }

  assert.equal(fs.existsSync(marker), false, "git ran through cmd.exe and a git.cmd");
  assert.equal(branch, "main");
});

test("a worktree whose checkout hook fails leaves no folder or branch behind", (t) => {
  const cwd = makeRepoWithApp(t);
  const hook = path.join(cwd, ".git", "hooks", "post-checkout");
  fs.writeFileSync(hook, "#!/bin/sh\necho checkout refused >&2\nexit 1\n", { mode: 0o755 });
  const worktreePath = path.join(makeTempDir(t), "worktrees", "task-hook");

  assert.throws(() => createWorktree(cwd, worktreePath, "agent/task-hook"), /checkout refused/);

  assert.equal(fs.existsSync(worktreePath), false, "the worktree folder remains");
  assert.equal(git(cwd, ["branch", "--list", "agent/task-hook"]).stdout.trim(), "", "the branch remains");
  const worktrees = git(cwd, ["worktree", "list", "--porcelain"]).stdout.split(/\r?\n/).filter((line) => line.startsWith("worktree "));
  assert.equal(worktrees.length, 1);
});

function registeredWorktrees(cwd) {
  return git(cwd, ["worktree", "list", "--porcelain"])
    .stdout.split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function failPostCheckout(cwd) {
  fs.writeFileSync(path.join(cwd, ".git", "hooks", "post-checkout"), "#!/bin/sh\necho checkout refused >&2\nexit 1\n", {
    mode: 0o755
  });
}

test("a failed worktree keeps the registration of another worktree whose folder is away", (t) => {
  const cwd = makeRepoWithApp(t);
  const parent = makeTempDir(t);
  const other = path.join(parent, "other");
  git(cwd, ["worktree", "add", "-b", "agent/other", other, "HEAD"]);
  failPostCheckout(cwd);
  const away = path.join(parent, "other-away");
  fs.renameSync(other, away);

  try {
    assert.throws(() => createWorktree(cwd, path.join(parent, "task-hook"), "agent/task-hook"), /checkout refused/);
    assert.equal(registeredWorktrees(cwd).length, 2, "the other worktree's registration was pruned");
  } finally {
    fs.renameSync(away, other);
  }
  assert.equal(git(cwd, ["branch", "--list", "agent/task-hook"]).stdout.trim(), "");
});

test("a worktree whose checkout hook fails in an existing empty folder leaves the folder empty and unregistered", (t) => {
  const cwd = makeRepoWithApp(t);
  failPostCheckout(cwd);
  const worktreePath = path.join(makeTempDir(t), "task-empty");
  fs.mkdirSync(worktreePath);

  assert.throws(() => createWorktree(cwd, worktreePath, "agent/task-empty"), /checkout refused/);

  assert.equal(registeredWorktrees(cwd).length, 1, "the failed checkout is still registered");
  assert.equal(git(cwd, ["branch", "--list", "agent/task-empty"]).stdout.trim(), "", "the branch remains");
  assert.deepEqual(fs.readdirSync(worktreePath), [], "the existing folder was not left empty");
});

test("a failed worktree in an existing private folder keeps the folder's mode", { skip: process.platform === "win32" && "POSIX modes" }, (t) => {
  const cwd = makeRepoWithApp(t);
  failPostCheckout(cwd);
  const worktreePath = path.join(makeTempDir(t), "task-private");
  fs.mkdirSync(worktreePath);
  fs.chmodSync(worktreePath, 0o700);
  const previousUmask = process.umask(0o022);
  t.after(() => process.umask(previousUmask));

  assert.throws(() => createWorktree(cwd, worktreePath, "agent/task-private"), /checkout refused/);

  assert.deepEqual(fs.readdirSync(worktreePath), []);
  assert.equal((fs.statSync(worktreePath).mode & 0o7777).toString(8), "700");
});

test("a failed worktree whose folder mode cannot be restored reports the git error and removes the branch", (t) => {
  const cwd = makeRepoWithApp(t);
  failPostCheckout(cwd);
  const worktreePath = path.join(makeTempDir(t), "task-chmod");
  fs.mkdirSync(worktreePath);
  const chmodSync = fs.chmodSync;
  fs.chmodSync = (target, ...rest) => {
    if (path.resolve(String(target)) === path.resolve(worktreePath)) {
      throw Object.assign(new Error("injected chmod failure"), { code: "EPERM" });
    }
    return chmodSync(target, ...rest);
  };
  let thrown = null;
  try {
    createWorktree(cwd, worktreePath, "agent/task-chmod");
  } catch (error) {
    thrown = error;
  } finally {
    fs.chmodSync = chmodSync;
  }

  assert.ok(thrown instanceof Error, "the failed checkout did not throw");
  assert.match(thrown.message, /checkout refused/);
  assert.doesNotMatch(thrown.message, /injected chmod failure|could not be removed/);
  assert.equal(git(cwd, ["branch", "--list", "agent/task-chmod"]).stdout.trim(), "", "the branch remains");
  assert.equal(registeredWorktrees(cwd).length, 1, "the failed checkout is still registered");
});

test("a worktree target that is another registered worktree is left alone", (t) => {
  const cwd = makeRepoWithApp(t);
  const other = path.join(makeTempDir(t), "other");
  git(cwd, ["worktree", "add", "-b", "agent/other", other, "HEAD"]);

  assert.throws(() => createWorktree(cwd, other, "agent/task-taken"), /already exists/);

  assert.equal(registeredWorktrees(cwd).length, 2);
  assert.equal(fs.existsSync(path.join(other, "app.js")), true);
});

test("removing a worktree that is already gone keeps another worktree whose folder is away", (t) => {
  const cwd = makeRepoWithApp(t);
  const parent = makeTempDir(t);
  const other = path.join(parent, "other");
  const gone = path.join(parent, "gone");
  git(cwd, ["worktree", "add", "-b", "agent/other", other, "HEAD"]);
  git(cwd, ["worktree", "add", "-b", "agent/gone", gone, "HEAD"]);
  git(cwd, ["worktree", "remove", "--force", gone]);
  const away = path.join(parent, "other-away");
  fs.renameSync(other, away);

  try {
    removeWorktree(cwd, gone, "agent/gone");
    assert.equal(registeredWorktrees(cwd).length, 2, "the other worktree's registration was pruned");
  } finally {
    fs.renameSync(away, other);
  }
  assert.equal(git(cwd, ["branch", "--list", "agent/gone"]).stdout.trim(), "");
});

test("removing a locked worktree whose folder is gone drops only its registration and branch", (t) => {
  const cwd = makeRepoWithApp(t);
  const parent = makeTempDir(t);
  const target = path.join(parent, "locked");
  git(cwd, ["worktree", "add", "-b", "agent/locked", target, "HEAD"]);
  git(cwd, ["worktree", "lock", target]);
  fs.rmSync(target, { recursive: true, force: true });

  removeWorktree(cwd, target, "agent/locked");

  assert.equal(registeredWorktrees(cwd).length, 1, "the locked worktree is still registered");
  assert.equal(git(cwd, ["branch", "--list", "agent/locked"]).stdout.trim(), "");
});

test("a worktree that cannot be created keeps a branch that existed before", (t) => {
  const cwd = makeRepoWithApp(t);
  git(cwd, ["branch", "agent/task-taken"]);
  const worktreePath = path.join(makeTempDir(t), "worktrees", "task-taken");

  assert.throws(() => createWorktree(cwd, worktreePath, "agent/task-taken"), /already exists/);

  assert.equal(git(cwd, ["branch", "--list", "agent/task-taken"]).stdout.trim(), "agent/task-taken");
  assert.equal(fs.existsSync(worktreePath), false);
});

test("an untracked file that holds a code fence stays inside its block", (t) => {
  const cwd = makeRepoWithApp(t);
  fs.writeFileSync(path.join(cwd, "notes.md"), "before\n```\nUNTRACKED_FENCE_MARKER\n```\nafter\n");

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, {}));

  assert.match(context.content, /### notes\.md\n````\nbefore\n```\nUNTRACKED_FENCE_MARKER\n```\nafter\n````/);
});

// The file is swapped between the check and the open: lstat reports a different file than the
// one the descriptor opens, as when a regular file is replaced by a link to an outside file.
test("an untracked file replaced between the check and the open is skipped", (t) => {
  const cwd = makeRepoWithApp(t);
  const outside = path.join(makeTempDir(t), "secret.txt");
  fs.writeFileSync(outside, "decoy\n");
  const swapped = path.join(cwd, "swapped.txt");
  fs.writeFileSync(swapped, "SWAPPED_SECRET_MARKER\n");
  const lstatSync = fs.lstatSync;
  fs.lstatSync = (target, ...rest) =>
    path.resolve(String(target)) === swapped ? lstatSync(outside, ...rest) : lstatSync(target, ...rest);
  let context;
  try {
    context = collectReviewContext(cwd, resolveReviewTarget(cwd, {}));
  } finally {
    fs.lstatSync = lstatSync;
  }

  assert.doesNotMatch(context.content, /SWAPPED_SECRET_MARKER/);
  assert.match(context.content, /### swapped\.txt\n\(skipped: unreadable file\)/);
});

// After git lists sub/secret.txt, the folder sub is replaced by a junction (a symlink on POSIX)
// to an outside folder that holds a file of the same name. The path, the lstat and the open then
// all reach the outside file, so only its real path shows that it lies outside the repository.
test("an untracked file reached through an ancestor link to an outside folder is skipped", (t) => {
  const cwd = makeRepoWithApp(t);
  const outside = makeTempDir(t);
  fs.writeFileSync(path.join(outside, "secret.txt"), "ANCESTOR_SECRET_MARKER\n");
  const sub = path.join(cwd, "sub");
  fs.mkdirSync(sub);
  const listed = path.join(sub, "secret.txt");
  fs.writeFileSync(listed, "inside\n");
  const away = path.join(cwd, "sub-away");
  const lstatSync = fs.lstatSync;
  let swapped = false;
  fs.lstatSync = (target, ...rest) => {
    if (!swapped && path.resolve(String(target)) === listed) {
      swapped = true;
      fs.renameSync(sub, away);
      fs.symlinkSync(outside, sub, "junction");
    }
    return lstatSync(target, ...rest);
  };
  let context;
  try {
    context = collectReviewContext(cwd, resolveReviewTarget(cwd, { scope: "working-tree" }));
  } finally {
    fs.lstatSync = lstatSync;
    if (swapped) {
      fs.rmSync(sub, { force: true });
    }
  }

  assert.equal(swapped, true, "the untracked file was never checked");
  assert.doesNotMatch(context.content, /ANCESTOR_SECRET_MARKER/);
  assert.match(context.content, /### sub\/secret\.txt\n\(skipped: unreadable file\)/);
});
