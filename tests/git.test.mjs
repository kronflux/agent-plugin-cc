import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { collectReviewContext, resolveReviewTarget } from "../plugins/agent/scripts/lib/git.mjs";
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
