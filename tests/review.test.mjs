import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { installFakeAgy, readFakeAgyState } from "./fake-agy-fixture.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { buildReviewPrompt, parseReviewArguments, resolveReviewTarget } from "../plugins/agent/scripts/lib/review-target.mjs";
import { readStoredJob } from "../plugins/agent/scripts/lib/job-control.mjs";
import { candidateStateDirs, listJobs, setConfig } from "../plugins/agent/scripts/lib/state.mjs";
import { makeCommittedRepo, makeTempDir, run, waitUntil } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "agent");
const CODEX = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const AGY = path.join(PLUGIN_ROOT, "scripts", "agy-companion.mjs");
const NEUTRAL = path.join(PLUGIN_ROOT, "scripts", "agent-companion.mjs");
const CRITICAL_MARKER = "Your job is to break confidence in the change, not to validate it.";
const PEER_MARKER = "Give an independent second opinion.";

const NO_GIT_MESSAGE = "No git repository here. Use --target project to review the current files.";

function git(cwd, args) {
  return run("git", args, { cwd, check: true, shell: false });
}

// A folder with three files and no .git.
function makePlainFolder(t) {
  const folder = makeTempDir(t);
  fs.writeFileSync(path.join(folder, "index.html"), "<h1>Hello</h1>\n");
  fs.writeFileSync(path.join(folder, "app.js"), "console.log('hello');\n");
  fs.writeFileSync(path.join(folder, "notes.md"), "# Notes\n");
  return folder;
}

// Creates a symlink, or skips the test when the account may not create one.
function symlinkOrSkip(t, target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath);
    return true;
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("symlinks need Developer Mode or admin on Windows");
      return false;
    }
    throw error;
  }
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = fs.realpathSync.native(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

test("outside git the auto target is the current folder as a project", (t) => {
  const folder = makePlainFolder(t);
  const target = resolveReviewTarget(folder, {});
  assert.equal(target.kind, "project");
  assert.ok(samePath(target.root, folder), `root ${target.root}`);
  assert.deepEqual(target.paths, []);
  assert.equal(target.changes, null);
  assert.equal(target.base, null);
});

test("--target changes outside git exits 1 with the S2-R9 message", (t) => {
  const folder = makePlainFolder(t);
  assert.throws(() => resolveReviewTarget(folder, { target: "changes" }), { message: NO_GIT_MESSAGE });
  assert.throws(() => resolveReviewTarget(folder, { base: "main" }), { message: NO_GIT_MESSAGE });
  assert.throws(() => resolveReviewTarget(folder, { scope: "working-tree" }), { message: NO_GIT_MESSAGE });
});

test("a clean repository reviews the project", (t) => {
  const repo = makeCommittedRepo(t);
  const target = resolveReviewTarget(repo, {});
  assert.equal(target.kind, "project");
  assert.ok(samePath(target.root, repo));
  assert.equal(target.changes, null);
});

test("a clean repository without a detectable base branch reviews the project", (t) => {
  const repo = makeCommittedRepo(t);
  git(repo, ["branch", "-m", "feature-only"]);
  const target = resolveReviewTarget(repo, {});
  assert.equal(target.kind, "project");
});

test("a dirty repository reviews the changes", (t) => {
  const repo = makeCommittedRepo(t);
  fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
  const target = resolveReviewTarget(repo, {});
  assert.equal(target.kind, "changes");
  assert.equal(target.changes.mode, "working-tree");
  assert.ok(samePath(target.root, repo));
});

test("a clean branch ahead of its base reviews the changes", (t) => {
  const repo = makeCommittedRepo(t);
  git(repo, ["checkout", "-b", "feature/ahead"]);
  fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
  git(repo, ["commit", "-am", "change"]);
  const target = resolveReviewTarget(repo, {});
  assert.equal(target.kind, "changes");
  assert.equal(target.changes.mode, "branch");
  assert.equal(target.base, "main");
});

test("--base or --scope with --target project is refused in a repository", (t) => {
  const repo = makeCommittedRepo(t);
  assert.throws(() => resolveReviewTarget(repo, { target: "project", base: "main" }), {
    message: "--base and --scope apply only to --target changes."
  });
  assert.throws(() => resolveReviewTarget(repo, { target: "project", scope: "branch" }), {
    message: "--base and --scope apply only to --target changes."
  });
});

test("repeated paths are deduplicated", (t) => {
  const folder = makePlainFolder(t);
  const target = resolveReviewTarget(folder, { paths: ["app.js", "./app.js", "notes.md", "app.js"] });
  assert.deepEqual(target.paths, ["app.js", "notes.md"]);
});

test("a deleted file is a valid changes path", (t) => {
  const repo = makeCommittedRepo(t, { files: { "README.md": "hello\n", "old.txt": "old\n" } });
  fs.rmSync(path.join(repo, "old.txt"));
  const target = resolveReviewTarget(repo, { target: "changes", paths: ["old.txt"] });
  assert.equal(target.kind, "changes");
  assert.deepEqual(target.paths, ["old.txt"]);
});

test("a path outside the root is refused", (t) => {
  const folder = makePlainFolder(t);
  assert.throws(() => resolveReviewTarget(folder, { paths: ["../elsewhere.txt"] }), {
    message: "--path ../elsewhere.txt cannot be resolved inside the review root."
  });
  const repo = makeCommittedRepo(t);
  fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
  assert.throws(() => resolveReviewTarget(repo, { paths: [path.join(folder, "app.js")] }), {
    message: `--path ${path.join(folder, "app.js")} cannot be resolved inside the review root.`
  });
});

test("a project path must exist", (t) => {
  const folder = makePlainFolder(t);
  assert.throws(() => resolveReviewTarget(folder, { paths: ["missing.js"] }), {
    message: "--path missing.js does not exist."
  });
});

test("a changes path with no changes is refused", (t) => {
  const repo = makeCommittedRepo(t, { files: { "README.md": "hello\n", "other.txt": "other\n" } });
  fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
  assert.throws(() => resolveReviewTarget(repo, { paths: ["other.txt"] }), {
    message: "No changes under the given --path. Use --target project to review those files."
  });
});

test("instruction text left after --path is not parsed again as flags", () => {
  const expected = { background: false, instructions: "--background is ignored on retry", paths: ["src"] };
  for (const argv of [["--path", "src", "--background is ignored on retry"], ['--path src "--background is ignored on retry"']]) {
    const parsed = parseReviewArguments(argv);
    assert.deepEqual(
      { background: parsed.background, instructions: parsed.instructions, paths: parsed.paths },
      expected,
      JSON.stringify(argv)
    );
  }
});

test("the old path of a renamed file is a valid changes path", (t) => {
  const repo = makeCommittedRepo(t, { files: { "README.md": "hello\n", "old.txt": "line one\nline two\nline three\n" } });
  git(repo, ["checkout", "-b", "feature/rename"]);
  git(repo, ["mv", "old.txt", "new.txt"]);
  // A staged rename in the working tree.
  const staged = resolveReviewTarget(repo, { target: "changes", paths: ["old.txt"] });
  assert.deepEqual(staged.paths, ["old.txt"]);
  // A committed rename on the branch.
  git(repo, ["commit", "-m", "rename"]);
  const branch = resolveReviewTarget(repo, { target: "changes", base: "main", paths: ["old.txt"] });
  assert.deepEqual(branch.paths, ["old.txt"]);
  assert.equal(branch.changes.mode, "branch");
});

test("--base or --scope with --target project outside git names the flag conflict", (t) => {
  const folder = makePlainFolder(t);
  for (const options of [{ base: "main" }, { scope: "branch" }]) {
    assert.throws(() => resolveReviewTarget(folder, { target: "project", ...options }), {
      message: "--base and --scope apply only to --target changes."
    });
  }
});

test("an explicit changes review with no changes says there is nothing to review", (t) => {
  const repo = makeCommittedRepo(t);
  assert.throws(() => resolveReviewTarget(repo, { target: "changes" }), {
    message: "No changes to review. Use --target project to review the current files."
  });
});

test("an unknown target kind is refused", (t) => {
  const folder = makePlainFolder(t);
  assert.throws(() => resolveReviewTarget(folder, { target: "everything" }), {
    message: 'Unsupported review target "everything". Use one of: auto, changes, project.'
  });
});

test("a blank --path is refused", (t) => {
  const folder = makePlainFolder(t);
  for (const blank of ["", "   "]) {
    assert.throws(() => resolveReviewTarget(folder, { paths: ["app.js", blank] }), {
      message: "--path needs a file or folder; an empty value is not allowed."
    });
  }
  const repo = makeCommittedRepo(t);
  fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
  assert.throws(() => resolveReviewTarget(repo, { target: "changes", paths: [""] }), {
    message: "--path needs a file or folder; an empty value is not allowed."
  });
});

test("a blank --target, --base, --scope or --stance is refused", (t) => {
  const repo = makeCommittedRepo(t);
  for (const name of ["target", "base", "scope"]) {
    for (const blank of ["", "  "]) {
      assert.throws(() => resolveReviewTarget(repo, { [name]: blank }), {
        message: `--${name} needs a value; an empty value is not allowed.`
      });
    }
  }
  assert.throws(() => parseReviewArguments(["--stance="]), {
    message: "--stance needs a value; an empty value is not allowed."
  });
  assert.equal(resolveReviewTarget(repo, { target: undefined, base: null, scope: undefined }).kind, "project");
  assert.equal(parseReviewArguments([]).stance, "peer");
});

test("auto run from a subfolder sees changes anywhere in the repository", (t) => {
  const repo = makeCommittedRepo(t, { files: { "README.md": "hello\n", "sub/inner.js": "inner\n" } });
  fs.writeFileSync(path.join(repo, "root-note.txt"), "new\n");
  const target = resolveReviewTarget(path.join(repo, "sub"), {});
  assert.equal(target.kind, "changes");
  assert.equal(target.changes.mode, "working-tree");
  assert.ok(samePath(target.root, repo));
});

test("a changed path with a non-ASCII name narrows a changes review", (t) => {
  const repo = makeCommittedRepo(t, { files: { "café.js": "v1\n", "other.js": "v1\n" } });
  fs.writeFileSync(path.join(repo, "café.js"), "v2\n");
  const target = resolveReviewTarget(repo, { target: "changes", paths: ["café.js"] });
  assert.deepEqual(target.paths, ["café.js"]);
});

test("a changed symlink to a target outside the root is refused, also when dangling", (t) => {
  const outside = makeTempDir(t);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
  const repo = makeCommittedRepo(t);
  if (!symlinkOrSkip(t, path.join(outside, "missing", "nowhere.txt"), path.join(repo, "dangling.txt"))) {
    return;
  }
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(repo, "existing.txt"));
  fs.symlinkSync("dangling.txt", path.join(repo, "chained.txt"));
  for (const name of ["dangling.txt", "existing.txt", "chained.txt"]) {
    assert.throws(() => resolveReviewTarget(repo, { target: "changes", paths: [name] }), {
      message: `--path ${name} cannot be resolved inside the review root.`
    });
  }
  fs.symlinkSync("README.md", path.join(repo, "inside.txt"));
  assert.deepEqual(resolveReviewTarget(repo, { target: "changes", paths: ["inside.txt"] }).paths, ["inside.txt"]);
});

// Creates a folder link; on Windows falls back to a junction. Returns false (test skipped) if neither works.
function folderLinkOrSkip(t, target, linkPath) {
  for (const type of [undefined, "junction"]) {
    try {
      fs.symlinkSync(target, linkPath, type);
      return true;
    } catch (error) {
      if (error.code !== "EPERM" || process.platform !== "win32") {
        throw error;
      }
    }
  }
  t.skip("neither a folder symlink nor a junction can be created on this account");
  return false;
}

test("a path through a link to a missing outside folder is refused", (t) => {
  const outside = makeTempDir(t);
  const folder = makePlainFolder(t);
  if (!folderLinkOrSkip(t, path.join(outside, "missing"), path.join(folder, "gone"))) {
    return;
  }
  assert.throws(() => resolveReviewTarget(folder, { paths: ["gone/file.txt"] }), {
    message: "--path gone/file.txt cannot be resolved inside the review root."
  });
  assert.throws(() => resolveReviewTarget(folder, { paths: ["gone"] }), {
    message: "--path gone cannot be resolved inside the review root."
  });
});

test("a valid in-root link reached through an aliased folder is accepted", (t) => {
  const folder = makePlainFolder(t);
  fs.mkdirSync(path.join(folder, "real", "deep"), { recursive: true });
  fs.writeFileSync(path.join(folder, "inside.txt"), "inside\n");
  if (!symlinkOrSkip(t, path.join("..", "..", "inside.txt"), path.join(folder, "real", "deep", "leaf"))) {
    return;
  }
  if (!folderLinkOrSkip(t, path.join(folder, "real", "deep"), path.join(folder, "alias"))) {
    return;
  }
  assert.deepEqual(resolveReviewTarget(folder, { paths: ["alias/leaf"] }).paths, ["alias/leaf"]);
});

test("a direct outside link and a dangling link are refused", (t) => {
  const outside = makeTempDir(t);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
  const folder = makePlainFolder(t);
  if (!symlinkOrSkip(t, path.join(outside, "secret.txt"), path.join(folder, "direct.txt"))) {
    return;
  }
  fs.symlinkSync("nowhere.txt", path.join(folder, "dangling.txt"));
  for (const name of ["direct.txt", "dangling.txt"]) {
    assert.throws(() => resolveReviewTarget(folder, { paths: [name] }), {
      message: `--path ${name} cannot be resolved inside the review root.`
    });
  }
});

// The 8.3 short name of an existing path, or null when the volume has none for it.
function shortNameOf(longPath) {
  const result = run("cmd", ["/d", "/c", `for %I in ("${longPath}") do @echo %~sI`]);
  const short = String(result.stdout ?? "").trim();
  return short && short.toLowerCase() !== longPath.toLowerCase() ? short : null;
}

test("a review root or --path written with an 8.3 short name is accepted", (t) => {
  if (process.platform !== "win32") {
    t.skip("8.3 short names exist only on Windows");
    return;
  }
  // Short names are created only when the volume has them enabled, so the test uses the
  // read-only system folders that were created while they were.
  const programFiles = process.env.ProgramFiles;
  const folder = programFiles && fs.existsSync(programFiles) ? programFiles : null;
  const shortFolder = folder && shortNameOf(folder);
  const common = folder && path.join(folder, "Common Files");
  const shortCommon = common && fs.existsSync(common) ? shortNameOf(common) : null;
  if (!shortFolder || !shortCommon) {
    t.skip("this volume has no 8.3 short name for the Program Files folders");
    return;
  }
  assert.deepEqual(resolveReviewTarget(shortFolder, { paths: ["Common Files"] }).paths, ["Common Files"]);
  assert.equal(resolveReviewTarget(shortFolder, { paths: [shortCommon] }).paths.length, 1);
  assert.equal(resolveReviewTarget(folder, { paths: [shortCommon] }).paths.length, 1);
});

test("a link whose text holds a folder link followed by .. is refused", (t) => {
  if (process.platform === "win32") {
    t.skip("the operating system resolves a link's .. differently only on POSIX");
    return;
  }
  const outside = makeTempDir(t);
  fs.mkdirSync(path.join(outside, "dir"));
  fs.mkdirSync(path.join(outside, "x"));
  fs.writeFileSync(path.join(outside, "x", "secret.txt"), "secret\n");
  const root = makePlainFolder(t);
  fs.mkdirSync(path.join(root, "x"));
  fs.symlinkSync(path.join(outside, "dir"), path.join(root, "inner-link"));
  fs.symlinkSync("inner-link/../x", path.join(root, "a"));
  assert.throws(() => resolveReviewTarget(root, { paths: ["a"] }), {
    message: "--path a cannot be resolved inside the review root."
  });
});

function readCodexState(binDir) {
  return JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
}

// A repository with one committed file and an uncommitted change to it, and a fake Codex.
function makeDirtyCodexRepo(t, behavior) {
  const repo = makeCommittedRepo(t, { files: { "src/app.js": "export const value = items[0];\n" } });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");
  const binDir = makeTempDir(t);
  installFakeCodex(binDir, behavior);
  return { repo, binDir, env: buildEnv(binDir) };
}

// Every file in the job folders of a workspace's state roots, whatever its job class.
function jobFolderEntries(workspace) {
  return candidateStateDirs(workspace).flatMap((dir) => {
    try {
      return fs.readdirSync(path.join(dir, "jobs"));
    } catch {
      return [];
    }
  });
}

// The review jobs of a workspace, newest first.
function reviewJobs(workspace) {
  return listJobs(workspace)
    .filter((job) => job.jobClass === "review")
    .sort((left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")));
}

const CHANGES_TARGET = {
  kind: "changes",
  root: "/repo",
  paths: [],
  base: null,
  label: "working tree diff",
  changes: { mode: "working-tree", label: "working tree diff", explicit: false }
};
const CHANGES_CONTEXT = {
  content: "## Git Status\n M app.js",
  collectionGuidance: "Use the repository context below as primary evidence."
};

test("the critical stance uses the critical prompt", () => {
  const prompt = buildReviewPrompt({
    rootDir: PLUGIN_ROOT,
    providerLabel: "Reviewer",
    target: CHANGES_TARGET,
    stance: "critical",
    instructions: "",
    context: CHANGES_CONTEXT
  });
  assert.ok(prompt.includes(CRITICAL_MARKER));
  assert.ok(!prompt.includes(PEER_MARKER));
  assert.match(prompt, /You are Reviewer performing a critical software review/);
  assert.match(prompt, /Set the top-level `target` field to `changes`/);
  assert.match(prompt, /## Git Status/);
  assert.doesNotMatch(prompt, /adversarial/i);
});

test("the peer stance uses the peer prompt", () => {
  const prompt = buildReviewPrompt({
    rootDir: PLUGIN_ROOT,
    providerLabel: "Reviewer",
    target: CHANGES_TARGET,
    stance: "peer",
    instructions: "look at the parser",
    context: CHANGES_CONTEXT
  });
  assert.ok(prompt.includes(PEER_MARKER));
  assert.ok(!prompt.includes(CRITICAL_MARKER));
  assert.match(prompt, /what is sound, what is wrong, and what is missing/i);
  assert.match(prompt, /User focus: look at the parser/);
  assert.match(prompt, /Set the top-level `target` field to `changes`/);
});

test("a project prompt names the root, the paths and the checklist and inlines no file", (t) => {
  const folder = makePlainFolder(t);
  fs.writeFileSync(path.join(folder, "secret.js"), "const MARKER_NOT_INLINED = 1;\n");
  const target = resolveReviewTarget(folder, { paths: ["app.js", "secret.js"] });
  const prompt = buildReviewPrompt({ rootDir: PLUGIN_ROOT, providerLabel: "Reviewer", target, stance: "peer" });
  assert.ok(prompt.includes(`Review root: ${target.root}`));
  assert.match(prompt, /^- app\.js$/m);
  assert.match(prompt, /^- secret\.js$/m);
  assert.match(prompt, /Set the top-level `target` field to `project`/);
  assert.match(prompt, /not inlined/);
  assert.doesNotMatch(prompt, /MARKER_NOT_INLINED/);
  const checklist = [
    "Defects",
    "Invalid syntax",
    "Structure",
    "Consistency",
    "Formatting",
    "confuse an end user",
    "Edge cases",
    "Recommendations"
  ].map((item) => prompt.indexOf(item));
  assert.ok(checklist.every((index) => index !== -1), `checklist positions ${checklist}`);
  assert.deepEqual([...checklist].sort((left, right) => left - right), checklist);
});

test("review --stance critical uses the critical prompt", (t) => {
  const ctx = makeDirtyCodexRepo(t);
  const result = run("node", [CODEX, "review", "--stance", "critical"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Missing empty-state guard/);
  const state = readCodexState(ctx.binDir);
  assert.ok(state.lastTurnStart.prompt.includes(CRITICAL_MARKER));
  assert.equal(state.lastReviewStart, undefined);
});

test("review with instructions runs a peer schema-bound turn", (t) => {
  const ctx = makeDirtyCodexRepo(t);
  const result = run("node", [CODEX, "review", "--", "focus on the index access"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 0, result.stderr);
  const state = readCodexState(ctx.binDir);
  assert.ok(state.lastTurnStart.prompt.includes(PEER_MARKER));
  assert.match(state.lastTurnStart.prompt, /User focus: focus on the index access/);
  assert.ok(state.lastTurnStart.outputSchema?.properties?.verdict, "the turn carried no review schema");
  assert.equal(state.lastReviewStart, undefined);
});

test("adversarial-review forwards to review with the critical stance", (t) => {
  const ctx = makeDirtyCodexRepo(t);
  const result = run("node", [CODEX, "adversarial-review"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Missing empty-state guard/);
  assert.ok(readCodexState(ctx.binDir).lastTurnStart.prompt.includes(CRITICAL_MARKER));
  // The command file passes its arguments as one quoted string.
  const quoted = run("node", [CODEX, "adversarial-review", "--base main"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(quoted.status, 0, quoted.stderr);
  assert.match(quoted.stdout, /against main/);
  assert.ok(readCodexState(ctx.binDir).lastTurnStart.prompt.includes(CRITICAL_MARKER));
});

test("a schema-bound review thread is persistent and a native one is ephemeral", (t) => {
  const ctx = makeDirtyCodexRepo(t);
  const bound = run("node", [CODEX, "review", "--stance", "critical"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(bound.status, 0, bound.stderr);
  assert.equal(readCodexState(ctx.binDir).lastThreadStart.ephemeral, false);
  assert.equal(reviewJobs(ctx.repo)[0].ephemeralThread, false);

  const native = run("node", [CODEX, "review"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(native.status, 0, native.stderr);
  const state = readCodexState(ctx.binDir);
  assert.equal(state.lastThreadStart.ephemeral, true);
  assert.ok(state.lastReviewStart, "the native review sent no review/start");
  const [job] = reviewJobs(ctx.repo);
  assert.equal(job.ephemeralThread, true);
  const result = run("node", [NEUTRAL, "result", job.id], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /codex resume/);
});

test("result of a schema-bound review prints its resume command", (t) => {
  const ctx = makeDirtyCodexRepo(t);
  const review = run("node", [CODEX, "review", "--stance", "critical"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(review.status, 0, review.stderr);
  const [job] = reviewJobs(ctx.repo);
  assert.ok(job.threadId, "the review recorded no thread");
  const result = run("node", [NEUTRAL, "result", job.id], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`codex resume ${job.threadId}`), result.stdout);
});

test("task --resume-thread continues a schema-bound review thread", (t) => {
  const ctx = makeDirtyCodexRepo(t);
  const review = run("node", [CODEX, "review", "--stance", "critical"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(review.status, 0, review.stderr);
  const [job] = reviewJobs(ctx.repo);
  assert.ok(job.threadId, "the review recorded no thread");
  const followUp = run("node", [CODEX, "task", "--resume-thread", job.threadId, "follow up on the first finding"], {
    cwd: ctx.repo,
    env: ctx.env
  });
  assert.equal(followUp.status, 0, followUp.stderr);
  assert.equal(readCodexState(ctx.binDir).lastThreadResume.threadId, job.threadId);
});

// A fake agy on PATH, with a home folder whose Antigravity settings name a saved model.
function fakeAgyEnv(t) {
  const binDir = makeTempDir(t);
  installFakeAgy(binDir);
  const home = makeTempDir(t);
  const settings = path.join(home, ".gemini", "antigravity-cli");
  fs.mkdirSync(settings, { recursive: true });
  fs.writeFileSync(path.join(settings, "settings.json"), JSON.stringify({ model: "Fake Model (High)" }));
  const sep = process.platform === "win32" ? ";" : ":";
  return { binDir, env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${binDir}${sep}${process.env.PATH}` } };
}

function agyPrompt(binDir) {
  const runs = readFakeAgyState(binDir).runs;
  return runs[runs.length - 1]?.inputs?.[0] ?? "";
}

function promptRoot(prompt) {
  return prompt.match(/^Review root: (.+)$/m)?.[1]?.trim() ?? null;
}

// The paths a project prompt lists under "Paths to review:".
function promptPaths(prompt) {
  const block = prompt.split("Paths to review:")[1] ?? "";
  const lines = [];
  for (const line of block.split(/\r?\n/).slice(1)) {
    if (!line.startsWith("- ")) {
      break;
    }
    lines.push(line.slice(2));
  }
  return lines;
}

test("codex review outside git reviews the folder as a project", (t) => {
  const folder = makePlainFolder(t);
  const binDir = makeTempDir(t);
  installFakeCodex(binDir);
  const result = run("node", [CODEX, "review"], { cwd: folder, env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /must run inside a Git repository/);
  const state = readCodexState(binDir);
  const prompt = state.lastTurnStart.prompt;
  assert.ok(samePath(promptRoot(prompt), folder), prompt);
  assert.match(prompt, /Set the top-level `target` field to `project`/);
  assert.ok(samePath(state.lastThreadStart.cwd, folder), "the review thread did not run in the folder");
  assert.equal(state.lastThreadStart.sandbox, "read-only");
  const [job] = reviewJobs(folder);
  assert.equal(job.review.target, "project");
  assert.equal(job.review.native, false);
  assert.equal(job.review.stance, "peer");
});

test("agy review outside git reviews the folder as a project", (t) => {
  const folder = makePlainFolder(t);
  const agy = fakeAgyEnv(t);
  const result = run("node", [AGY, "review"], { cwd: folder, env: agy.env });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /must run inside a Git repository/);
  const prompt = agyPrompt(agy.binDir);
  assert.ok(samePath(promptRoot(prompt), folder), prompt);
  assert.match(prompt, /Set the top-level `target` field to `project`/);
  assert.ok(prompt.includes(PEER_MARKER), "the agy review default is not the peer stance");
  const [job] = reviewJobs(folder);
  assert.equal(job.review.target, "project");
  assert.equal(job.review.stance, "peer");
});

test("review of a clean repository records target project", (t) => {
  const repo = makeCommittedRepo(t);
  const binDir = makeTempDir(t);
  installFakeCodex(binDir);
  const result = run("node", [CODEX, "review"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /nothing to review/i);
  assert.equal(reviewJobs(repo)[0].review.target, "project");
  assert.ok(samePath(promptRoot(readCodexState(binDir).lastTurnStart.prompt), repo));

  const agy = fakeAgyEnv(t);
  const agyResult = run("node", [AGY, "review"], { cwd: repo, env: agy.env });
  assert.equal(agyResult.status, 0, agyResult.stderr);
  assert.equal(reviewJobs(repo)[0].review.target, "project");
});

test("repeated --path narrows a changes review in both providers", (t) => {
  const repo = makeCommittedRepo(t, {
    files: { "a.js": "export const a = 1;\n", "b.js": "export const b = 1;\n", "c.js": "export const c = 1;\n" }
  });
  fs.writeFileSync(path.join(repo, "a.js"), "export const a = 'CHANGED_A';\n");
  fs.writeFileSync(path.join(repo, "b.js"), "export const b = 'CHANGED_B';\n");
  fs.writeFileSync(path.join(repo, "c.js"), "export const c = 'CHANGED_C';\n");
  const binDir = makeTempDir(t);
  installFakeCodex(binDir);
  const args = ["review", "--path", "a.js", "--path", "b.js", "--path", "a.js"];
  const result = run("node", [CODEX, ...args], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  const prompt = readCodexState(binDir).lastTurnStart.prompt;
  assert.match(prompt, /CHANGED_A/);
  assert.match(prompt, /CHANGED_B/);
  assert.doesNotMatch(prompt, /CHANGED_C/);
  assert.doesNotMatch(prompt, /c\.js/);
  const [job] = reviewJobs(repo);
  assert.equal(job.review.target, "changes");
  assert.deepEqual(job.review.paths, ["a.js", "b.js"]);
  assert.equal(job.review.native, false);

  const agy = fakeAgyEnv(t);
  const agyResult = run("node", [AGY, ...args], { cwd: repo, env: agy.env });
  assert.equal(agyResult.status, 0, agyResult.stderr);
  const agyText = agyPrompt(agy.binDir);
  assert.match(agyText, /CHANGED_A/);
  assert.match(agyText, /CHANGED_B/);
  assert.doesNotMatch(agyText, /CHANGED_C/);
});

test("repeated --path in a project review reaches the prompt in both providers", (t) => {
  const folder = makePlainFolder(t);
  const binDir = makeTempDir(t);
  installFakeCodex(binDir);
  const args = ["review", "--target", "project", "--path", "app.js", "--path", "notes.md", "--path", "app.js"];
  const result = run("node", [CODEX, ...args], { cwd: folder, env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  const prompt = readCodexState(binDir).lastTurnStart.prompt;
  assert.ok(samePath(promptRoot(prompt), folder));
  assert.deepEqual(promptPaths(prompt), ["app.js", "notes.md"]);

  const agy = fakeAgyEnv(t);
  const agyResult = run("node", [AGY, ...args], { cwd: folder, env: agy.env });
  assert.equal(agyResult.status, 0, agyResult.stderr);
  const agyText = agyPrompt(agy.binDir);
  assert.ok(samePath(promptRoot(agyText), folder));
  assert.deepEqual(promptPaths(agyText), ["app.js", "notes.md"]);
});

test("a review stores its model fields and honours the stored setting", (t) => {
  const ctx = makeDirtyCodexRepo(t);
  setConfig(ctx.repo, "models", { codex: { model: "gpt-5.6-luna", effort: "high" } });
  const result = run("node", [CODEX, "review", "--stance", "critical"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 0, result.stderr);
  const state = readCodexState(ctx.binDir);
  assert.equal(state.lastTurnStart.model, "gpt-5.6-luna");
  assert.equal(state.lastTurnStart.effort, "high");
  const [job] = reviewJobs(ctx.repo);
  assert.equal(job.model, "gpt-5.6-luna");
  assert.equal(job.effort, "high");
  assert.equal(job.modelSource, "setting");
  assert.equal(job.effortSource, "setting");

  const explicit = run("node", [CODEX, "review", "--model", "m-default"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(explicit.status, 0, explicit.stderr);
  const [native] = reviewJobs(ctx.repo);
  assert.equal(native.model, "m-default");
  assert.equal(native.modelSource, "explicit");
  assert.equal(native.review.native, true);
  assert.equal(readCodexState(ctx.binDir).lastThreadStart.model, "m-default");
});

test("an invalid model or effort on review is rejected before any job exists", (t) => {
  const ctx = makeDirtyCodexRepo(t);
  const model = run("node", [CODEX, "review", "--model", "no-such-model"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(model.status, 1, model.stdout);
  assert.match(model.stderr, /Model "no-such-model" is not in the Codex catalog/);
  const effort = run("node", [CODEX, "review", "--stance", "critical", "--effort", "max"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(effort.status, 1, effort.stdout);
  assert.match(effort.stderr, /does not support reasoning effort "max"/);
  assert.deepEqual(jobFolderEntries(ctx.repo), []);

  const agy = fakeAgyEnv(t);
  const agyModel = run("node", [AGY, "review", "--model", "no-such-model"], { cwd: ctx.repo, env: agy.env });
  assert.equal(agyModel.status, 1, agyModel.stdout);
  assert.match(agyModel.stderr, /Model "no-such-model" is not in the Antigravity model list/);
  const agyEffort = run("node", [AGY, "review", "--effort", "max"], { cwd: ctx.repo, env: agy.env });
  assert.equal(agyEffort.status, 1, agyEffort.stdout);
  assert.match(agyEffort.stderr, /agy does not support reasoning effort "max"/);
  assert.deepEqual(jobFolderEntries(ctx.repo), []);
  assert.equal(readFakeAgyState(agy.binDir).runs.length, 0);
});

test("review target errors exit 1 before any job exists", (t) => {
  const folder = makePlainFolder(t);
  const binDir = makeTempDir(t);
  installFakeCodex(binDir);
  const codex = run("node", [CODEX, "review", "--target", "changes"], { cwd: folder, env: buildEnv(binDir) });
  assert.equal(codex.status, 1);
  assert.equal(codex.stderr.trim(), NO_GIT_MESSAGE);
  const agy = fakeAgyEnv(t);
  const agyResult = run("node", [AGY, "review", "--target", "changes"], { cwd: folder, env: agy.env });
  assert.equal(agyResult.status, 1);
  assert.equal(agyResult.stderr.trim(), NO_GIT_MESSAGE);
  const outside = run("node", [CODEX, "review", "--path", ".."], { cwd: folder, env: buildEnv(binDir) });
  assert.equal(outside.status, 1);
  assert.equal(outside.stderr.trim(), "--path .. cannot be resolved inside the review root.");
  assert.deepEqual(jobFolderEntries(folder), []);
});

test("a blank --path exits 1 before any job exists in both providers", (t) => {
  const ctx = makeDirtyCodexRepo(t);
  const agy = fakeAgyEnv(t);
  for (const args of [["--path="], ["--path", ""], ["--path", "  "]]) {
    for (const [script, env] of [[CODEX, ctx.env], [AGY, agy.env]]) {
      // An absolute node path runs without a shell, which would drop an empty argument.
      const result = run(process.execPath, [script, "review", ...args], { cwd: ctx.repo, env });
      assert.equal(result.status, 1, `${path.basename(script)} ${JSON.stringify(args)}: ${result.stdout}`);
      assert.equal(result.stderr.trim(), "--path needs a file or folder; an empty value is not allowed.");
    }
  }
  assert.deepEqual(jobFolderEntries(ctx.repo), []);
  assert.equal(readFakeAgyState(agy.binDir).runs.length, 0);
});

test("a blank --target, --base, --scope or --stance exits 1 before any job exists in both providers", (t) => {
  const ctx = makeDirtyCodexRepo(t);
  const agy = fakeAgyEnv(t);
  for (const name of ["target", "base", "scope", "stance"]) {
    for (const args of [[`--${name}=`], [`--${name}`, ""], [`--${name}`, "  "]]) {
      for (const [script, env] of [[CODEX, ctx.env], [AGY, agy.env]]) {
        // An absolute node path runs without a shell, which would drop an empty argument.
        const result = run(process.execPath, [script, "review", ...args], { cwd: ctx.repo, env });
        assert.equal(result.status, 1, `${path.basename(script)} ${JSON.stringify(args)}: ${result.stdout}`);
        assert.equal(result.stderr.trim(), `--${name} needs a value; an empty value is not allowed.`);
      }
    }
  }
  assert.deepEqual(jobFolderEntries(ctx.repo), []);
  assert.equal(readFakeAgyState(agy.binDir).runs.length, 0);
});

test("an invalid --base or a scope conflict exits 1 before any job exists in both providers", (t) => {
  const ctx = makeDirtyCodexRepo(t);
  const agy = fakeAgyEnv(t);
  const cases = [
    { args: ["--base", "no-such-branch"], message: "--base no-such-branch does not name a commit in this repository." },
    {
      args: ["--base", "HEAD", "--scope", "staged"],
      message: 'Unsupported review scope "staged". Use one of: auto, working-tree, branch, or pass --base <ref>.'
    },
    {
      args: ["--base", "main", "--scope", "working-tree"],
      message: "--base compares the branch with a commit and cannot be combined with --scope working-tree."
    }
  ];
  for (const { args, message } of cases) {
    for (const [script, env] of [[CODEX, ctx.env], [AGY, agy.env]]) {
      for (const mode of [[], ["--background"]]) {
        const result = run("node", [script, "review", ...args, ...mode], { cwd: ctx.repo, env });
        assert.equal(result.status, 1, `${path.basename(script)} ${args.join(" ")} ${mode}: ${result.stdout}`);
        assert.equal(result.stderr.trim(), message);
      }
    }
  }
  assert.deepEqual(jobFolderEntries(ctx.repo), []);
  assert.equal(readFakeAgyState(agy.binDir).runs.length, 0);
});

// Waits until the job has ended and returns its stored record.
async function waitForEnd(workspace, jobId) {
  let record = null;
  const ended = await waitUntil(
    () => {
      record = readStoredJob(workspace, jobId);
      return record && ["completed", "failed", "cancelled"].includes(record.status);
    },
    { timeoutMs: 30000, describe: `job ${jobId} ending` }
  );
  assert.ok(ended, JSON.stringify(record));
  return record;
}

test("a background review is a tracked job with an id and finishes with its findings", async (t) => {
  const ctx = makeDirtyCodexRepo(t);
  const launched = run("node", [CODEX, "review", "--background", "--stance", "critical", "--json"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId, status } = JSON.parse(launched.stdout);
  assert.match(jobId, /^review-/);
  assert.equal(status, "queued");
  const record = await waitForEnd(ctx.repo, jobId);
  assert.equal(record.status, "completed", JSON.stringify(record));
  assert.equal(record.review.target, "changes");
  assert.equal(record.review.stance, "critical");
  const result = run("node", [NEUTRAL, "result", jobId], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Missing empty-state guard/);

  const agy = fakeAgyEnv(t);
  const agyLaunch = run("node", [AGY, "review", "--background", "--json"], { cwd: ctx.repo, env: agy.env });
  assert.equal(agyLaunch.status, 0, agyLaunch.stderr);
  const agyJob = JSON.parse(agyLaunch.stdout).jobId;
  assert.match(agyJob, /^review-/);
  const agyRecord = await waitForEnd(ctx.repo, agyJob);
  assert.equal(agyRecord.status, "completed", JSON.stringify(agyRecord));
  assert.equal(agyRecord.provider, "agy");
  const agyResult = run("node", [NEUTRAL, "result", agyJob], { cwd: ctx.repo, env: agy.env });
  assert.equal(agyResult.status, 0, agyResult.stderr);
  assert.match(agyResult.stdout, /No material issues found by the fake agy\./);
});

test("a background schema-bound review keeps its thread persistent", async (t) => {
  const ctx = makeDirtyCodexRepo(t);
  const launched = run("node", [CODEX, "review", "--background", "--", "check the index access"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = launched.stdout.match(/as (review-\S+)\./)?.[1];
  assert.ok(jobId, launched.stdout);
  const record = await waitForEnd(ctx.repo, jobId);
  assert.equal(record.status, "completed", JSON.stringify(record));
  assert.equal(record.ephemeralThread, false);
  assert.equal(record.review.native, false);
  const state = readCodexState(ctx.binDir);
  assert.equal(state.lastThreadStart.ephemeral, false);
  assert.equal(state.lastReviewStart, undefined);
  assert.ok(record.threadId);
});

test("every object in the review schema lists all its properties as required", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json"), "utf8"));
  const finding = schema.properties.findings.items;
  assert.deepEqual(finding.properties.file.type, ["string", "null"]);
  assert.deepEqual(finding.properties.line_start.type, ["integer", "null"]);
  assert.deepEqual(finding.properties.line_end.type, ["integer", "null"]);
  assert.equal(schema.$id, "urn:agent-plugin:schema:review-output:2");
  assert.deepEqual(schema.properties.target.enum, ["changes", "project"]);
  const objects = [];
  const walk = (node, at) => {
    if (!node || typeof node !== "object") {
      return;
    }
    if (node.properties) {
      objects.push({ node, at });
      for (const [key, value] of Object.entries(node.properties)) {
        walk(value, `${at}.${key}`);
      }
    }
    if (node.items) {
      walk(node.items, `${at}[]`);
    }
  };
  walk(schema, "$");
  assert.ok(objects.length >= 2);
  for (const { node, at } of objects) {
    assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), `required at ${at}`);
    assert.equal(node.additionalProperties, false, `additionalProperties at ${at}`);
  }
});

test("a project review with a finding without location renders it", (t) => {
  const folder = makePlainFolder(t);
  const binDir = makeTempDir(t);
  installFakeCodex(binDir);
  const result = run("node", [CODEX, "review", "--stance", "critical"], { cwd: folder, env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# Codex Critical Review \(project\)$/m);
  assert.match(result.stdout, /^- \[medium\] No usage instructions$/m);

  const agy = fakeAgyEnv(t);
  const agyResult = run("node", [AGY, "review"], { cwd: folder, env: agy.env });
  assert.equal(agyResult.status, 0, agyResult.stderr);
  assert.match(agyResult.stdout, /^# Antigravity Review \(project\)$/m);
  assert.match(agyResult.stdout, /^- \[medium\] No usage instructions$/m);
});

test("the scripts contain no model id and sol only in the catalog fallback", () => {
  const grep = (args) => run("git", ["grep", "-n", ...args, "--", "plugins/agent/scripts"], { cwd: ROOT, shell: false });
  const ids = grep(["-E", "gpt-[0-9]|spark|terra|luna|astra|gemini-[0-9]|claude-(opus|sonnet)"]);
  assert.equal(ids.status, 1, `git grep found model ids or failed:\n${ids.stdout}${ids.stderr}`);
  assert.equal(ids.stdout, "");
  const sol = grep(["-w", "sol"]);
  assert.ok(sol.status === 0 || sol.status === 1, sol.stderr);
  const lines = sol.stdout.split(/\r?\n/).filter(Boolean);
  const outside = lines.filter((line) => !line.startsWith("plugins/agent/scripts/providers/codex/model-catalog.mjs:"));
  assert.deepEqual(outside, []);
});

test("both review help texts list --wait and --background", () => {
  for (const script of [CODEX, AGY]) {
    const result = run("node", [script, "review", "--help"], { cwd: ROOT });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[--wait\|--background\]/, `${path.basename(script)}: ${result.stdout}`);
  }
});

test("a Codex review without valid JSON fails and is never handed off", (t) => {
  const ctx = makeDirtyCodexRepo(t, "invalid-json");
  const result = run("node", [CODEX, "review", "--", "check the index access"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /did not return valid structured JSON/);
  const [job] = reviewJobs(ctx.repo);
  assert.equal(job.status, "failed", JSON.stringify(job));
  const handoff = run("node", [CODEX, "task", "--from-last-review"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(handoff.status, 1, handoff.stdout);
  assert.match(handoff.stderr, /No finished review with output was found/);
});

test("an Antigravity review names the saved model it ran on, in the output and the record", async (t) => {
  const folder = makePlainFolder(t);
  const agy = fakeAgyEnv(t);
  const result = run("node", [AGY, "review"], { cwd: folder, env: agy.env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Model: Fake Model \(High\) \(from the Antigravity settings\)$/m);
  const [job] = reviewJobs(folder);
  assert.equal(job.model, null);
  assert.equal(job.modelSource, "provider-default");
  assert.equal(job.providerModel, "Fake Model (High)");

  const launched = run("node", [AGY, "review", "--background", "--json"], { cwd: folder, env: agy.env });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);
  const record = await waitForEnd(folder, jobId);
  assert.equal(record.providerModel, "Fake Model (High)");
  const stored = run("node", [NEUTRAL, "result", jobId], { cwd: folder, env: agy.env });
  assert.equal(stored.status, 0, stored.stderr);
  assert.match(stored.stdout, /^Model: Fake Model \(High\) \(from the Antigravity settings\)$/m);
});
