import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { fileURLToPath, pathToFileURL } from "node:url";

import { installFakeAgy } from "./fake-agy-fixture.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run as runCommand, stopOwnedProcesses, waitUntil, writeExecutable } from "./helpers.mjs";
import { listProviders } from "../plugins/agent/scripts/lib/providers.mjs";
import {
  ManifestError,
  checkProviders,
  newRunId,
  readFleetManifest,
  readRunRecord,
  startMember,
  writeRunRecord
} from "../plugins/agent/scripts/lib/runs.mjs";
import { createJob, resolveStateDir } from "../plugins/agent/scripts/lib/state.mjs";
import { openStore } from "../plugins/agent/scripts/lib/store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_COMPANION = path.join(ROOT, "plugins", "agent", "scripts", "agent-companion.mjs");
const CODEX_COMPANION = path.join(ROOT, "plugins", "agent", "scripts", "codex-companion.mjs");
const PATH_SEP = process.platform === "win32" ? ";" : ":";

// Every command a test here runs ends within 60 s.
function run(command, args, options = {}) {
  return runCommand(command, args, { timeout: 60000, shell: false, ...options });
}

// A fake bin folder with Codex (`codexBehavior`) and Antigravity (`agyBehavior`), and its env.
// The folder is removed when the file ends, after every job's processes were stopped.
function makeFakes({ codexBehavior = "review-ok", agyBehavior = "ok" } = {}) {
  const binDir = makeTempDir();
  installFakeCodex(binDir, codexBehavior);
  installFakeAgy(binDir, agyBehavior);
  return { binDir, env: buildEnv(binDir) };
}

// A committed git repository that is removed when the file ends, after every job's processes
// were stopped, since a running job keeps it as its working folder.
function makeRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "-A"], { cwd: repo, check: true });
  run("git", ["commit", "-m", "init"], { cwd: repo, check: true });
  return repo;
}

function fleet(args, { cwd, env }) {
  return run(process.execPath, [AGENT_COMPANION, "fleet", ...args], { cwd, env });
}

// Every job row of the workspace of `cwd`, oldest first; none when the store does not exist.
function jobRows(cwd) {
  const stateDir = resolveStateDir(cwd);
  if (!fs.existsSync(path.join(stateDir, "store", "state.db"))) {
    return [];
  }
  const store = openStore(stateDir);
  try {
    return store.read((db) => db.prepare("SELECT * FROM jobs ORDER BY created_at, id").all());
  } finally {
    store.close();
  }
}

function runRecordFiles(cwd) {
  const dir = path.join(resolveStateDir(cwd), "runs");
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

const ENDED = new Set(["completed", "failed", "cancelled"]);

// True when every job of the workspace has ended and released its execution.
function allSettled(cwd) {
  return jobRows(cwd).every((row) => ENDED.has(row.end_state) && (row.claimed_at === null || row.exec_released_at !== null));
}

// After the test: lets every job of the workspace end by itself for up to 20 s, cancels the jobs
// that have not ended, waits for each execution to be released, and stops any worker or provider
// still recorded by its own id.
function settleJobs(t, cwd, env) {
  t.after(async () => {
    try {
      await waitUntil(() => allSettled(cwd), { timeoutMs: 20000, describe: "every job to end by itself" });
    } catch {
      // The jobs still running are cancelled below.
    }
    for (const row of jobRows(cwd)) {
      if (!ENDED.has(row.end_state)) {
        run(process.execPath, [AGENT_COMPANION, "cancel", row.id], { cwd, env });
      }
    }
    try {
      await waitUntil(() => allSettled(cwd), { timeoutMs: 20000, describe: "every job to end and release its execution" });
    } catch (error) {
      const rows = jobRows(cwd).map((row) => ({
        id: row.id,
        end_state: row.end_state,
        error: row.error,
        claimed_at: row.claimed_at,
        exec_released_at: row.exec_released_at,
        stop_requested_at: row.stop_requested_at
      }));
      throw new Error(`${error.message}\n${JSON.stringify(rows, null, 1)}`);
    } finally {
      const targets = jobRows(cwd).flatMap((row) => [
        { pid: row.worker_pid, startToken: row.worker_start_token },
        { pid: row.provider_pid, startToken: row.provider_start_token }
      ]);
      await stopOwnedProcesses(targets.filter((target) => target.pid), { tree: true });
    }
  });
}

// The manifest of a mixed fleet: two Codex tasks and one Antigravity project review.
function mixedManifest(t, extraMember = {}) {
  return writeManifest(t, {
    manifestVersion: 1,
    name: "mixed",
    members: [
      { label: "mix-one", provider: CODEX_ID, prompt: "first task", ...extraMember },
      { label: "mix-two", provider: CODEX_ID, prompt: "second task" },
      { label: "mix-docs", provider: AGY_ID, kind: "review", prompt: "check the README", review: { target: "project" } }
    ]
  });
}
const [CODEX_ID, AGY_ID] = ["codex", "agy"].map((id) => {
  const provider = listProviders().find((entry) => entry.id === id);
  assert.ok(provider, `provider ${id} is not registered`);
  return provider.id;
});

// A PATH of the folder of this Node and every PATH folder that holds none of `names`.
function pathWithout(names) {
  const kept = String(process.env.PATH ?? "")
    .split(PATH_SEP)
    .filter(Boolean)
    .filter((dir) => !names.some((name) => fs.existsSync(path.join(dir, name))));
  return [path.dirname(process.execPath), ...kept].join(PATH_SEP);
}

// An environment whose PATH holds the fake bin folder and no Antigravity CLI.
function envWithoutAgy(binDir) {
  return { ...buildEnv(binDir), PATH: `${binDir}${PATH_SEP}${pathWithout(["agy", "agy.exe", "agy.cmd"])}` };
}

const TOP_LEVEL_MESSAGE =
  'The manifest must be a JSON object with "manifestVersion": 1 and "members"; "name" and "defaults" are optional.';

// Writes `value` as JSON to a new manifest file in `dir`, a fresh folder by default, and returns
// its path.
function writeManifest(t, value, name = "fleet.json", dir = makeTempDir(t)) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

// The ManifestError message `readFleetManifest` throws for `value`, written as a manifest in `dir`
// (a fresh folder by default).
function refusal(t, value, { inGitRepo = true, dir } = {}) {
  const file = writeManifest(t, value, "fleet.json", dir);
  try {
    readFleetManifest(file, { cwd: path.dirname(file), inGitRepo });
  } catch (error) {
    assert.ok(error instanceof ManifestError, `not a ManifestError: ${error?.stack ?? error}`);
    return error.message;
  }
  assert.fail(`the manifest was accepted: ${JSON.stringify(value)}`);
}

function manifestOf(members, extra = {}) {
  return { manifestVersion: 1, name: "audit", ...extra, members };
}

test("a manifest without manifestVersion 1 or as a bare array is refused with the top-level keys", (t) => {
  assert.equal(refusal(t, []), TOP_LEVEL_MESSAGE);
  assert.equal(refusal(t, { members: [] }), TOP_LEVEL_MESSAGE);
});

test("unknown keys, wrong types, a duplicate label, both prompt and promptFile, and nine members are refused", (t) => {
  const unknown = refusal(t, manifestOf([{ label: "audit-x", promt: "typo" }]));
  assert.match(unknown, /audit-x/);
  assert.match(unknown, /unknown key "promt"/);

  const wrongType = refusal(t, manifestOf([{ label: "audit-x", prompt: "p", write: "yes" }]));
  assert.match(wrongType, /audit-x/);
  assert.match(wrongType, /write must be boolean/);

  const duplicate = refusal(t, manifestOf([{ label: "audit-x", prompt: "one" }, { label: "audit-x", prompt: "two" }]));
  assert.match(duplicate, /audit-x/);
  assert.match(duplicate, /repeats the label/);

  const promptFile = path.join(makeTempDir(t), "prompt.md");
  fs.writeFileSync(promptFile, "do it\n");
  const both = refusal(t, manifestOf([{ label: "audit-x", prompt: "one", promptFile }]));
  assert.match(both, /audit-x/);
  assert.match(both, /exactly one of prompt and promptFile/);

  const nine = Array.from({ length: 8 }, (_, index) => ({ label: `audit-${index + 1}`, prompt: "p" }));
  nine.push({ label: "audit-x", prompt: "p" });
  const tooMany = refusal(t, manifestOf(nine));
  assert.match(tooMany, /audit-x/);
  assert.match(tooMany, /at most 8 members/);
});

test("a blank prompt file and an output schema that is not a JSON object are refused before anything starts", (t) => {
  const dir = makeTempDir(t);
  const blank = path.join(dir, "blank.md");
  fs.writeFileSync(blank, " \n");
  const blankPrompt = refusal(t, manifestOf([{ label: "audit-x", promptFile: blank }]), { dir });
  assert.match(blankPrompt, /audit-x/);
  assert.match(blankPrompt, /promptFile .* is blank/);

  const broken = path.join(dir, "broken.json");
  fs.writeFileSync(broken, "{");
  const brokenSchema = refusal(t, manifestOf([{ label: "audit-x", prompt: "p", outputSchema: broken }]), { dir });
  assert.match(brokenSchema, /audit-x/);
  assert.match(brokenSchema, /outputSchema .* is not a JSON object/);
});

const OUTSIDE_SECRET = "outside-file-secret-7f3a";
const OUTSIDE_RULE = /is outside the manifest's folder and the workspace; pass --allow-outside-files to fleet start to read it\./;

// A file in a fresh folder outside every manifest folder and workspace of these tests.
function outsideFile(t, name, text) {
  const file = path.join(makeTempDir(t), name);
  fs.writeFileSync(file, text);
  return file;
}

for (const [key, member] of [
  ["promptFile", (file) => ({ label: "outside-x", promptFile: file })],
  ["outputSchema", (file) => ({ label: "outside-x", prompt: "p", outputSchema: file })]
]) {
  test(`fleet start refuses ${key} outside the manifest's folder and the workspace and starts nothing`, (t) => {
    const repo = makeRepo();
    const { env } = makeFakes();
    const file = outsideFile(t, key === "promptFile" ? "p.md" : "s.json", JSON.stringify({ secret: OUTSIDE_SECRET }));
    const manifest = writeManifest(t, manifestOf([{ label: "inside-ok", prompt: "p" }, member(file)]));

    const started = fleet(["start", manifest, "--json"], { cwd: repo, env });

    assert.equal(started.status, 1, started.stdout);
    assert.match(started.stderr, /outside-x/);
    assert.ok(started.stderr.includes(`${key} ${file}`), started.stderr);
    assert.match(started.stderr, OUTSIDE_RULE);
    assert.ok(!`${started.stdout}${started.stderr}`.includes(OUTSIDE_SECRET), "the outside file's content was printed");
    assert.deepEqual(jobRows(repo), []);
    assert.deepEqual(runRecordFiles(repo), []);
  });
}

test("fleet start --allow-outside-files reads a prompt file outside both roots", (t) => {
  const repo = makeRepo();
  const { env } = makeFakes();
  settleJobs(t, repo, env);
  const file = outsideFile(t, "p.md", "do the outside task\n");
  const manifest = writeManifest(t, manifestOf([{ label: "outside-ok", promptFile: file }]));

  const started = fleet(["start", manifest, "--allow-outside-files", "--json"], { cwd: repo, env });

  assert.equal(started.status, 0, started.stderr);
  const [member] = JSON.parse(started.stdout).run.members;
  assert.ok(member.jobId, started.stdout);
  assert.equal(jobRows(repo).length, 1);
});

test("a prompt file in the workspace but outside the manifest's folder is accepted", (t) => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, "fleets"));
  fs.mkdirSync(path.join(repo, "shared"));
  fs.writeFileSync(path.join(repo, "shared", "p.md"), "shared prompt\n");
  const manifest = writeManifest(t, manifestOf([{ label: "shared-ok", promptFile: path.join("..", "shared", "p.md") }]), "fleet.json", path.join(repo, "fleets"));

  const { members } = readFleetManifest(manifest, { cwd: path.join(repo, "fleets"), inGitRepo: true });

  assert.equal(members[0].promptFile, path.join(repo, "shared", "p.md"));
});

test("a link in the manifest's folder that points outside both roots is refused", (t) => {
  const outsideDir = makeTempDir(t);
  const target = path.join(outsideDir, "p.md");
  fs.writeFileSync(target, `${OUTSIDE_SECRET}\n`);
  const dir = makeTempDir(t);
  let promptFile;
  try {
    fs.symlinkSync(target, path.join(dir, "link.md"));
    promptFile = "link.md";
  } catch {
    try {
      fs.symlinkSync(outsideDir, path.join(dir, "linked"), "junction");
      promptFile = path.join("linked", "p.md");
    } catch (error) {
      t.skip(`neither a symbolic link nor a junction can be created: ${error.code ?? error.message}`);
      return;
    }
  }

  const message = refusal(t, manifestOf([{ label: "linked-x", promptFile }]), { dir });

  assert.match(message, /linked-x/);
  assert.match(message, OUTSIDE_RULE);
  assert.ok(message.includes(path.join(dir, promptFile)), message);
  assert.ok(!message.includes(OUTSIDE_SECRET), message);
});

test("the example manifest with null keys is accepted and defaults fill the rest", (t) => {
  const example = {
    manifestVersion: 1,
    name: "audit",
    defaults: { provider: "codex", write: false, worktree: false, model: null, effort: null },
    members: [
      {
        label: "audit-auth",
        provider: "codex",
        kind: "task",
        prompt: "check the auth module",
        promptFile: null,
        write: false,
        worktree: false,
        model: null,
        effort: null,
        outputSchema: null,
        allowQuestions: false,
        review: null
      },
      {
        label: "audit-docs",
        provider: "agy",
        kind: "review",
        prompt: "check the README against the code",
        review: { target: "project", paths: ["README.md", "src"], stance: "peer" }
      }
    ]
  };
  const file = writeManifest(t, example);
  const manifest = readFleetManifest(file, { cwd: path.dirname(file), inGitRepo: false });
  assert.equal(manifest.name, "audit");
  assert.deepEqual(
    manifest.members.map((member) => [member.label, member.provider, member.kind]),
    [
      ["audit-auth", "codex", "task"],
      ["audit-docs", "agy", "review"]
    ]
  );
  assert.deepEqual(manifest.members[1].review, { target: "project", paths: ["README.md", "src"], stance: "peer" });
  assert.equal(manifest.members[1].prompt, "check the README against the code");

  const defaulted = writeManifest(t, { manifestVersion: 1, defaults: { provider: "agy", write: true }, members: [{ label: "solo", prompt: "go" }] });
  const [member] = readFleetManifest(defaulted, { cwd: path.dirname(defaulted), inGitRepo: false }).members;
  assert.equal(member.provider, "agy");
  assert.equal(member.kind, "task");
  assert.equal(member.write, true);
  assert.equal(member.worktree, false);
  assert.equal(member.model, null);
  assert.equal(member.effort, null);
  assert.equal(member.outputSchema, null);
  assert.equal(member.allowQuestions, false);
  assert.equal(member.review, null);
});

test("a review member refuses task-only settings and blank instructions", (t) => {
  const review = { target: "project" };
  const base = { label: "audit-rev", kind: "review", prompt: "look", review };
  for (const [key, value] of [
    ["outputSchema", "s.json"],
    ["allowQuestions", true],
    ["write", true],
    ["worktree", true]
  ]) {
    const message = refusal(t, manifestOf([{ ...base, [key]: value }]));
    assert.match(message, /audit-rev/);
    assert.match(message, new RegExp(`${key} is not available on a review member`));
  }
  const blank = refusal(t, manifestOf([{ ...base, prompt: "  " }]));
  assert.match(blank, /audit-rev/);
  assert.match(blank, /prompt/);

  const file = writeManifest(t, manifestOf([{ ...base, outputSchema: null, allowQuestions: false, write: null }]));
  const [member] = readFleetManifest(file, { cwd: path.dirname(file), inGitRepo: true }).members;
  assert.equal(member.kind, "review");
  assert.equal(member.write, false);
  assert.equal(member.allowQuestions, false);
  assert.equal(member.outputSchema, null);
  assert.deepEqual(member.review, { target: "project", paths: [], stance: null });
});

test("checkProviders runs one check per distinct provider and reports a missing CLI", async (t) => {
  const binDir = makeTempDir(t);
  installFakeCodex(binDir);
  const cwd = makeTempDir(t);

  const results = await checkProviders([CODEX_ID, CODEX_ID, AGY_ID], { cwd, env: envWithoutAgy(binDir) });

  assert.equal(results.length, 2, JSON.stringify(results));
  const codex = results.find((entry) => entry.id === CODEX_ID);
  const agy = results.find((entry) => entry.id === AGY_ID);
  assert.equal(codex.ok, true, JSON.stringify(codex));
  assert.equal(agy.ok, false, JSON.stringify(agy));
  assert.equal(typeof agy.reason, "string");
  assert.ok(agy.reason.trim(), JSON.stringify(agy));
});

test("a mixed fleet starts as one run", async (t) => {
  const repo = makeRepo();
  const { env } = makeFakes();
  settleJobs(t, repo, env);

  const started = fleet(["start", mixedManifest(t), "--json"], { cwd: repo, env });

  assert.equal(started.status, 0, started.stderr);
  const { run: record } = JSON.parse(started.stdout);
  assert.match(record.id, /^run-\d+-[0-9a-f]{8}$/);
  assert.ok(record.finalizedAt, "the record was not finalised");
  assert.deepEqual(record.members.map((member) => member.startError), [null, null, null], started.stdout);
  const jobIds = record.members.map((member) => member.jobId);
  assert.equal(new Set(jobIds).size, 3);
  const rows = jobRows(repo);
  assert.equal(rows.length, 3);
  for (const member of record.members) {
    const row = rows.find((entry) => entry.id === member.jobId);
    assert.ok(row, `no job row for ${member.label}`);
    assert.equal(row.run_id, record.id);
    assert.equal(row.label, member.label);
    assert.equal(row.provider, member.provider);
    assert.equal(JSON.parse(row.request_json).write, false);
    // Each member is one store job whose worker the companion launched through launchWorker.
    assert.ok(row.last_launch_at !== null, `${member.label} was never launched`);
  }
  assert.deepEqual(readRunRecord(resolveStateDir(repo), record.id), record);

  const text = fleet(["start", writeManifest(t, { manifestVersion: 1, members: [{ label: "mix-text", prompt: "p" }] })], { cwd: repo, env });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^Fleet run-\d+-[0-9a-f]{8}: 1 members\n- mix-text: codex task-/);
});

test("a codex changes review with instructions takes the schema-bound route", async (t) => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
  const { env } = makeFakes();
  settleJobs(t, repo, env);
  const manifest = writeManifest(t, {
    manifestVersion: 1,
    members: [{ label: "rev-changes", provider: CODEX_ID, kind: "review", prompt: "focus on the README", review: { target: "changes", stance: "peer" } }]
  });

  const started = fleet(["start", manifest, "--json"], { cwd: repo, env });

  assert.equal(started.status, 0, started.stderr);
  const [member] = JSON.parse(started.stdout).run.members;
  assert.ok(member.jobId, started.stdout);
  const row = jobRows(repo).find((entry) => entry.id === member.jobId);
  assert.equal(row.kind, "review");
  assert.equal(JSON.parse(row.request_json).review.native, false);
  assert.equal(row.ephemeral, 0);
});

test("a missing provider starts nothing", (t) => {
  const repo = makeRepo();
  const binDir = makeTempDir(t);
  installFakeCodex(binDir);

  const started = fleet(["start", mixedManifest(t)], { cwd: repo, env: envWithoutAgy(binDir) });

  assert.equal(started.status, 1, started.stdout);
  assert.match(started.stderr, /Provider agy/);
  assert.match(started.stderr, /Nothing was started\./);
  assert.deepEqual(jobRows(repo), []);
  assert.deepEqual(runRecordFiles(repo), []);
});

test("a duplicated label starts nothing", (t) => {
  const repo = makeRepo();
  const { env } = makeFakes();
  const manifest = writeManifest(t, {
    manifestVersion: 1,
    members: [
      { label: "dup", prompt: "one" },
      { label: "dup", prompt: "two" }
    ]
  });

  const started = fleet(["start", manifest], { cwd: repo, env });

  assert.equal(started.status, 1, started.stdout);
  assert.match(started.stderr, /repeats the label/);
  assert.deepEqual(jobRows(repo), []);
  assert.deepEqual(runRecordFiles(repo), []);
});

test("a fleet runs outside git and refuses a worktree there", async (t) => {
  const folder = makeTempDir();
  const { env } = makeFakes();
  settleJobs(t, folder, env);
  const plain = writeManifest(t, { manifestVersion: 1, members: [{ label: "plain-one", prompt: "p" }] });
  const withWorktree = writeManifest(t, {
    manifestVersion: 1,
    members: [
      { label: "plain-two", prompt: "p" },
      { label: "needs-tree", prompt: "p", worktree: true }
    ]
  });

  const first = fleet(["start", plain, "--json"], { cwd: folder, env });
  assert.equal(first.status, 0, first.stderr);
  assert.ok(JSON.parse(first.stdout).run.members[0].jobId, first.stdout);

  const second = fleet(["start", withWorktree], { cwd: folder, env });
  assert.equal(second.status, 1, second.stdout);
  assert.match(second.stderr, /needs-tree/);
  assert.match(second.stderr, /git repository/);
  assert.equal(jobRows(folder).length, 1);
  assert.equal(fs.existsSync(path.join(folder, ".git")), false);
});

test("a member that fails to start is recorded and the others run", async (t) => {
  const repo = makeRepo();
  const { env } = makeFakes({ codexBehavior: "interruptible-slow-task" });
  settleJobs(t, repo, env);
  const holderManifest = writeManifest(t, { manifestVersion: 1, members: [{ label: "held", prompt: "slow work" }] });
  const first = fleet(["start", holderManifest, "--json"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  assert.ok(JSON.parse(first.stdout).run.members[0].jobId, first.stdout);

  const clashManifest = writeManifest(t, {
    manifestVersion: 1,
    members: [
      { label: "held", prompt: "again" },
      { label: "free", prompt: "other work" }
    ]
  });
  const second = fleet(["start", clashManifest, "--json"], { cwd: repo, env });

  assert.equal(second.status, 0, second.stderr);
  const [clash, free] = JSON.parse(second.stdout).run.members;
  assert.equal(clash.jobId, null);
  assert.match(clash.startError, /label/);
  assert.ok(free.jobId, second.stdout);
  assert.equal(free.startError, null);
});

test("the fleet command's single argument string keeps a native manifest path", async (t) => {
  const repo = makeRepo();
  const { env } = makeFakes();
  settleJobs(t, repo, env);
  const manifest = writeManifest(t, { manifestVersion: 1, members: [{ label: "only", prompt: "do one thing" }] }, "cmd.json");

  // process.execPath avoids a shell, so the string reaches the companion as the command passes it.
  const result = run(process.execPath, [AGENT_COMPANION, "fleet", `start ${manifest} --json`], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).run.members.map((member) => member.label), ["only"]);
});

test("startMember returns a concrete error for an unreadable reply", async (t) => {
  const script = path.join(makeTempDir(t), "stand-in.mjs");
  writeExecutable(script, 'process.stdout.write("not json\\n");\n');
  const member = {
    label: "odd",
    provider: CODEX_ID,
    kind: "task",
    prompt: "p",
    promptFile: null,
    write: false,
    worktree: false,
    model: null,
    effort: null,
    outputSchema: null,
    allowQuestions: false,
    review: null
  };

  const outcome = await startMember(member, { cwd: makeTempDir(t), env: process.env, runId: "run-1-00000000", companionScript: script });

  assert.deepEqual(outcome, { startError: `${CODEX_ID} companion gave no job id: not json` });
});

test("the Codex task no longer accepts --manifest", (t) => {
  const repo = makeRepo();
  const { env } = makeFakes();
  const manifest = writeManifest(t, [{ label: "old", prompt: "old form" }], "m.json");

  const result = run(process.execPath, [CODEX_COMPANION, "task", "--manifest", manifest], { cwd: repo, env });

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /--manifest/);
  assert.match(result.stderr, /unknown/i);
  assert.deepEqual(jobRows(repo), []);
});

// Starts the fleet of `manifest` in `cwd` and returns its finalised run record.
function startFleet(manifest, { cwd, env }) {
  const started = fleet(["start", manifest, "--json"], { cwd, env });
  assert.equal(started.status, 0, started.stderr);
  const record = JSON.parse(started.stdout).run;
  assert.ok(
    record.members.every((member) => member.jobId),
    started.stdout
  );
  return record;
}

function fleetStatus(runId, { cwd, env }) {
  const status = fleet(["status", runId, "--json"], { cwd, env });
  assert.equal(status.status, 0, status.stderr);
  return JSON.parse(status.stdout);
}

// The row of one job, or null.
function jobRow(cwd, jobId) {
  return jobRows(cwd).find((row) => row.id === jobId) ?? null;
}

test("fleet wait and results report every member under its label", async (t) => {
  const repo = makeRepo();
  const { env } = makeFakes();
  settleJobs(t, repo, env);
  const record = startFleet(mixedManifest(t), { cwd: repo, env });

  const waited = fleet(["wait", record.id, "--timeout-ms", "60000"], { cwd: repo, env });
  assert.equal(waited.status, 0, waited.stderr);
  for (const member of record.members) {
    assert.match(waited.stdout, new RegExp(`\\| ${member.label} \\|`));
  }

  const results = fleet(["results", record.id], { cwd: repo, env });
  assert.equal(results.status, 0, results.stderr);
  for (const member of record.members) {
    assert.match(results.stdout, new RegExp(`^## ${member.label} \\(${member.provider}, ${member.jobId}, completed\\)$`, "m"));
  }
  assert.equal((results.stdout.match(/^## /gm) ?? []).length, 3);

  const outDir = path.join(makeTempDir(t), "results");
  const written = fleet(["results", record.id, "--out", outDir, "--json"], { cwd: repo, env });
  assert.equal(written.status, 0, written.stderr);
  assert.deepEqual(fs.readdirSync(outDir).sort(), ["mix-docs.md", "mix-one.md", "mix-two.md"]);
  assert.match(fs.readFileSync(path.join(outDir, "mix-one.md"), "utf8"), /^## mix-one \(codex, /);
  const resultJson = JSON.parse(written.stdout);
  assert.deepEqual(
    resultJson.members.map((member) => Object.keys(member)),
    record.members.map(() => ["label", "provider", "jobId", "status", "resultText", "resultJson", "startError"])
  );

  const status = fleetStatus(record.id, { cwd: repo, env });
  const jobKeys = Object.keys(JSON.parse(run(process.execPath, [AGENT_COMPANION, "status", "--all", "--json"], { cwd: repo, env }).stdout).jobs[0]);
  for (const member of status.members) {
    assert.deepEqual(Object.keys(member), [...jobKeys, "startError"]);
    assert.equal(member.status, "completed");
  }
  assert.deepEqual(status.run, record);
});

test("fleet wait times out with exit 75 and fleet cancel ends every member", async (t) => {
  const repo = makeRepo();
  const { env } = makeFakes({ codexBehavior: "interruptible-slow-task" });
  settleJobs(t, repo, env);
  const manifest = writeManifest(t, {
    manifestVersion: 1,
    members: [
      { label: "slow-a", prompt: "slow work" },
      { label: "slow-b", prompt: "slow work" }
    ]
  });
  const record = startFleet(manifest, { cwd: repo, env });

  const waited = fleet(["wait", record.id, "--timeout-ms", "500"], { cwd: repo, env });
  assert.equal(waited.status, 75, waited.stdout + waited.stderr);
  assert.match(waited.stderr, new RegExp(`Fleet ${record.id} still has 2 members running after 500 ms\\.`));

  const cancelled = fleet(["cancel", record.id, "--json"], { cwd: repo, env });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  const report = JSON.parse(cancelled.stdout);
  assert.equal(report.run, record.id);
  assert.deepEqual(
    report.members.map((member) => member.label),
    ["slow-a", "slow-b"]
  );
  for (const member of report.members) {
    assert.ok(["cancelled", "already-ended"].includes(member.outcome), JSON.stringify(member));
  }
  await waitUntil(() => record.members.every((member) => ENDED.has(jobRow(repo, member.jobId)?.end_state)), {
    timeoutMs: 15000,
    describe: "every member to end"
  });
});

test("a member beyond the parallel limit stays queued until a place frees", async (t) => {
  const repo = makeRepo();
  const { env } = makeFakes({ codexBehavior: "interruptible-slow-task" });
  settleJobs(t, repo, env);
  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ maxParallel: { [CODEX_ID]: 1 } }));
  const manifest = writeManifest(t, {
    manifestVersion: 1,
    members: [
      { label: "queue-a", prompt: "slow work" },
      { label: "queue-b", prompt: "slow work" }
    ]
  });
  const record = startFleet(manifest, { cwd: repo, env });

  const states = await waitUntil(
    () => {
      const members = fleetStatus(record.id, { cwd: repo, env }).members.map((member) => member.status).sort();
      return members.includes("running") ? members : null;
    },
    { timeoutMs: 20000, describe: "one member to run" }
  );
  assert.deepEqual(states, ["queued", "running"]);

  const waited = fleet(["wait", record.id, "--timeout-ms", "60000", "--json"], { cwd: repo, env });
  assert.equal(waited.status, 0, waited.stderr);
  assert.deepEqual(
    JSON.parse(waited.stdout).members.map((member) => member.status),
    ["completed", "completed"]
  );
  const [first, second] = record.members
    .map((member) => jobRow(repo, member.jobId))
    .sort((a, b) => a.claimed_at - b.claimed_at);
  assert.ok(second.claimed_at >= first.exec_released_at, `${second.claimed_at} < ${first.exec_released_at}`);
});

test("a fleet member answers to send, resume, result and cancel by its label", async (t) => {
  const repo = makeRepo();
  const { env } = makeFakes({ codexBehavior: "interruptible-slow-task" });
  settleJobs(t, repo, env);
  const manifest = writeManifest(t, {
    manifestVersion: 1,
    members: [
      { label: "lab-talk", prompt: "slow work" },
      { label: "lab-stop", prompt: "slow work" }
    ]
  });
  const record = startFleet(manifest, { cwd: repo, env });
  const [talk, stop] = record.members;
  const neutral = (args) => run(process.execPath, [AGENT_COMPANION, ...args], { cwd: repo, env });
  await waitUntil(() => record.members.every((member) => jobRow(repo, member.jobId)?.turn_id), {
    timeoutMs: 20000,
    describe: "both members to start their turns"
  });

  const cancelled = neutral(["cancel", "lab-stop"]);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  await waitUntil(() => jobRow(repo, stop.jobId)?.end_state === "cancelled", { timeoutMs: 15000, describe: "lab-stop to be cancelled" });

  const sent = neutral(["send", "lab-talk", "--json", "also check the tests"]);
  assert.equal(sent.status, 0, sent.stderr);
  assert.ok(["received", "continued"].includes(JSON.parse(sent.stdout).status), sent.stdout);

  await waitUntil(() => ENDED.has(resolveTip(repo, talk.jobId)?.end_state), { timeoutMs: 30000, describe: "lab-talk to end" });
  const resumed = neutral(["resume", "lab-talk", "--json", "more"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const successorId = JSON.parse(resumed.stdout).jobId;
  assert.ok(successorId && successorId !== talk.jobId, resumed.stdout);

  const status = fleetStatus(record.id, { cwd: repo, env });
  assert.equal(status.members[0].id, successorId);
  assert.equal(status.members[1].status, "cancelled");

  await waitUntil(() => ENDED.has(jobRow(repo, successorId)?.end_state), { timeoutMs: 30000, describe: "the continuation to end" });
  const byLabel = neutral(["result", "lab-talk"]);
  assert.equal(byLabel.status, 0, byLabel.stderr);
  assert.equal(byLabel.stdout, neutral(["result", successorId]).stdout);
});

// The row of the tip of the chain that holds `jobId`.
function resolveTip(cwd, jobId) {
  const row = jobRow(cwd, jobId);
  if (!row) {
    return null;
  }
  const store = openStore(resolveStateDir(cwd));
  try {
    return store.read((db) => db.prepare("SELECT jobs.* FROM chains JOIN jobs ON jobs.id = chains.tip_job_id WHERE chains.id = ?").get(row.chain_id));
  } finally {
    store.close();
  }
}

test("status reconciles an unfinalised record and a pruned chain without restarting", (t) => {
  const repo = makeRepo();
  const { env } = makeFakes();
  const stateDir = resolveStateDir(repo);
  const unfinished = newRunId();
  writeRunRecord(stateDir, {
    schema: 1,
    id: unfinished,
    kind: "fleet",
    name: "broken",
    createdAt: new Date().toISOString(),
    sessionId: null,
    finalizedAt: null,
    members: ["rec-a", "rec-b", "rec-c"].map((label) => ({ label, provider: CODEX_ID, jobId: null, startError: null }))
  });
  const store = openStore(stateDir);
  let foundId;
  let prunedId;
  try {
    const fields = (runId) => ({
      provider: CODEX_ID,
      kind: "task",
      title: "Codex Task",
      prompt: "p",
      request: { cwd: repo },
      cwd: repo,
      runId,
      requester: { sessionId: null, leaderPid: null, leaderStartToken: null }
    });
    foundId = createJob(store, fields(unfinished), { label: "rec-a" }).jobId;
    const finished = newRunId();
    prunedId = createJob(store, fields(finished), { label: "rec-gone" }).jobId;
    store.transact((db) => db.prepare("DELETE FROM chains WHERE id = ?").run(prunedId));
    writeRunRecord(stateDir, {
      schema: 1,
      id: finished,
      kind: "fleet",
      name: null,
      createdAt: new Date().toISOString(),
      sessionId: null,
      finalizedAt: new Date().toISOString(),
      members: [{ label: "rec-gone", provider: CODEX_ID, jobId: prunedId, startError: null }]
    });
    t.prunedRun = finished;
  } finally {
    store.close();
  }
  const rowsBefore = jobRows(repo).length;

  const first = fleetStatus(unfinished, { cwd: repo, env });
  assert.deepEqual(
    first.members.map((member) => [member.label, member.id, member.status]),
    [
      ["rec-a", foundId, "queued"],
      ["rec-b", null, "start-unknown"],
      ["rec-c", null, "start-unknown"]
    ]
  );
  for (const member of first.members.slice(1)) {
    assert.equal(member.startError, "the fleet stopped before this member's start was recorded");
  }
  const second = fleetStatus(t.prunedRun, { cwd: repo, env });
  assert.deepEqual(
    second.members.map((member) => [member.label, member.id, member.status]),
    [["rec-gone", null, "pruned"]]
  );
  assert.equal(jobRows(repo).length, rowsBefore);

  const unknown = fleet(["status", "run-1-deadbeef"], { cwd: repo, env });
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stderr.trim(), "No fleet run run-1-deadbeef in this workspace.");
});

// Loaded with NODE_OPTIONS=--import, so every detached worker spawn fails with an error event:
// a member's job commits and its worker launch then fails.
const WORKER_SPAWN_FAILS_PRELOAD = [
  'import childProcess from "node:child_process";',
  'import { syncBuiltinESMExports } from "node:module";',
  "const spawn = childProcess.spawn;",
  "childProcess.spawn = function (command, args, ...rest) {",
  '  if (Array.isArray(args) && args.includes("worker")) {',
  "    return {",
  "      pid: undefined,",
  "      once(event, listener) {",
  '        if (event === "error") setImmediate(() => listener(new Error("spawn failed")));',
  "        return this;",
  "      },",
  "      unref() {}",
  "    };",
  "  }",
  "  return spawn.call(this, command, args, ...rest);",
  "};",
  "syncBuiltinESMExports();"
].join("\n");

test("a fleet member keeps its worktree once its job committed, and one that never committed leaves none", (t) => {
  const repo = makeRepo();
  const { env } = makeFakes();
  const preload = path.join(makeTempDir(t), "worker-spawn-fails.mjs");
  fs.writeFileSync(preload, WORKER_SPAWN_FAILS_PRELOAD);
  // A live chain holds the label "wt-clash", so that member's job never commits.
  const store = openStore(resolveStateDir(repo));
  try {
    createJob(
      store,
      {
        provider: CODEX_ID,
        kind: "task",
        title: "Codex Task",
        prompt: "holder",
        request: { cwd: repo },
        cwd: repo,
        requester: { sessionId: null, leaderPid: null, leaderStartToken: null }
      },
      { label: "wt-clash" }
    );
  } finally {
    store.close();
  }
  const manifest = writeManifest(t, {
    manifestVersion: 1,
    members: [
      { label: "wt-kept", prompt: "edit in a worktree", worktree: true },
      { label: "wt-clash", prompt: "edit in a worktree", worktree: true }
    ]
  });

  const started = fleet(["start", manifest, "--json"], { cwd: repo, env: { ...env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } });

  assert.equal(started.status, 0, started.stderr);
  const [kept, clash] = JSON.parse(started.stdout).run.members;
  assert.ok(kept.jobId, started.stdout);
  const row = jobRow(repo, kept.jobId);
  assert.equal(row.claimed_at, null);
  assert.equal(row.end_state, null);
  assert.ok(row.last_launch_at !== null, "the committed job's worker launch was not attempted");
  const worktree = JSON.parse(row.request_json).worktree;
  assert.equal(worktree.branch, `agent/${kept.jobId}`);
  assert.ok(fs.existsSync(worktree.path), "the committed member's worktree was removed");
  assert.equal(clash.jobId, null);
  assert.match(clash.startError, /label/);
  const branches = run("git", ["branch", "--list", "--format=%(refname:short)", "agent/*"], { cwd: repo }).stdout.trim();
  assert.equal(branches, `agent/${kept.jobId}`);
  const worktrees = run("git", ["worktree", "list", "--porcelain"], { cwd: repo })
    .stdout.split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "));
  assert.equal(worktrees.length, 2);
});

test("each fleet member gets its own model and effort from one read of the manifest", async (t) => {
  const repo = makeRepo();
  const { env } = makeFakes();
  settleJobs(t, repo, env);
  const manifest = writeManifest(t, {
    manifestVersion: 1,
    defaults: { model: "m-default", effort: "low" },
    members: [
      { label: "sel-default", prompt: "first" },
      { label: "sel-own", prompt: "second", model: "gpt-5.6-luna", effort: "high" },
      { label: "sel-effort", prompt: "third", effort: "medium" }
    ]
  });

  const reads = [];
  const readFileSync = fs.readFileSync;
  fs.readFileSync = function (file, ...rest) {
    if (path.resolve(String(file)) === manifest) {
      reads.push(file);
    }
    return readFileSync.call(this, file, ...rest);
  };
  let members;
  try {
    members = readFleetManifest(manifest, { cwd: repo, inGitRepo: true }).members;
  } finally {
    fs.readFileSync = readFileSync;
  }
  assert.equal(reads.length, 1);
  assert.deepEqual(
    members.map((member) => [member.label, member.model, member.effort]),
    [
      ["sel-default", "m-default", "low"],
      ["sel-own", "gpt-5.6-luna", "high"],
      ["sel-effort", "m-default", "medium"]
    ]
  );

  const record = startFleet(manifest, { cwd: repo, env });
  const selections = record.members.map((member) => {
    const row = jobRow(repo, member.jobId);
    return [member.label, row.model, JSON.parse(row.request_json).effort];
  });
  assert.deepEqual(selections, [
    ["sel-default", "m-default", "low"],
    ["sel-own", "gpt-5.6-luna", "high"],
    ["sel-effort", "m-default", "medium"]
  ]);
});
