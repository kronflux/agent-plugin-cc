import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildEnv, FAKE_DEBUG_SOL_MODELS, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeCommittedRepo, makeTempDir, stopOwnedProcesses, waitUntil } from "./helpers.mjs";
import { launchManifestTasks } from "../plugins/agent/scripts/codex-companion.mjs";
import { isProcessAlive } from "../plugins/agent/scripts/lib/process.mjs";
import { getConfig, listJobViews, resolveStateDir, setConfig } from "../plugins/agent/scripts/lib/state.mjs";
import { openStore } from "../plugins/agent/scripts/lib/store.mjs";
import {
  listCatalogModels,
  pickNewestSol,
  resolveFamily
} from "../plugins/agent/scripts/providers/codex/model-catalog.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "agent", "scripts", "codex-companion.mjs");
const MODEL_CATALOG = path.join(ROOT, "plugins", "agent", "scripts", "providers", "codex", "model-catalog.mjs");

// The debug catalog of the fake Codex behaviour list-fails-debug-sols, as CatalogModel entries.
function fakeDebugCatalog() {
  return FAKE_DEBUG_SOL_MODELS.map((entry) => ({
    id: entry.slug,
    hidden: entry.visibility !== "list",
    isDefault: false,
    efforts: entry.supported_reasoning_levels.map((level) => level.effort),
    defaultEffort: entry.default_reasoning_level,
    priority: entry.priority,
    visibility: entry.visibility
  }));
}

test("the newest visible Sol model wins by version number", () => {
  assert.equal(pickNewestSol(fakeDebugCatalog())?.id, "gpt-6.1-sol");
});

test("a family word resolves to the lowest-priority visible entry", () => {
  // The lowest priority number comes last, so only the priority order can pick it.
  const debugModels = fakeDebugCatalog().reverse();
  assert.notEqual(debugModels[0].id, "gpt-6.1-sol");
  assert.equal(resolveFamily("sol", { debugModels, listModels: [] })?.id, "gpt-6.1-sol");
});

test("a family word missing from a readable debug catalog does not fall back to the model list", () => {
  const debugModels = fakeDebugCatalog().filter((model) => !model.id.endsWith("-sol"));
  const listModels = [{ id: "gpt-6-sol", hidden: false, isDefault: false, efforts: [], defaultEffort: null, priority: null, visibility: null }];
  assert.equal(resolveFamily("sol", { debugModels, listModels }), null);
  assert.equal(resolveFamily("sol", { debugModels: null, listModels })?.id, "gpt-6-sol");
});

test("listCatalogModels gives up after the catalog timeout", async () => {
  const client = { request: () => new Promise(() => {}) };
  const started = Date.now();
  await assert.rejects(listCatalogModels(client, { timeoutMs: 200 }), /did not answer/);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

// Command-line tests: each runs the Codex companion against a fake Codex.

function makeRepo(t, behavior = "catalog-default", fakeOptions = {}) {
  const repo = makeCommittedRepo(t);
  const binDir = makeTempDir(t);
  installFakeCodex(binDir, behavior, fakeOptions);
  return { repo, binDir, env: buildEnv(binDir) };
}

function companion(ctx, args, options = {}) {
  return spawnSync(process.execPath, [options.script ?? SCRIPT, ...args], {
    cwd: ctx.repo,
    env: ctx.env,
    encoding: "utf8",
    timeout: options.timeout ?? 60000,
    windowsHide: true
  });
}

function fakeState(ctx) {
  const file = path.join(ctx.binDir, "fake-codex-state.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

// Runs `fn` on the job store of the repository and closes the store after.
function withStore(ctx, fn) {
  const store = openStore(resolveStateDir(ctx.repo));
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

// Every job of the repository's job store, newest first, as job views: `row` holds the columns
// (model, error, thread_id), `request` the stored request (model, effort, modelSource,
// effortSource) and `state` the job's state.
function allJobs(ctx) {
  return withStore(ctx, (store) => listJobViews(store, { all: true, limit: 200 }));
}

// The newest job of the repository's job store, or null.
function latestJob(ctx) {
  return allJobs(ctx)[0] ?? null;
}

// Changes the stored model and request fields of a job, as a job that ran with them would hold
// them: `model` sets the model column and the request's model; `request` merges into the request.
function updateStoredJob(ctx, jobId, { request = {}, ...columns }) {
  withStore(ctx, (store) =>
    store.transact((db) => {
      const row = db.prepare("SELECT model, request_json FROM jobs WHERE id = ?").get(jobId);
      const merged = { ...JSON.parse(row.request_json), ...request };
      const model = Object.hasOwn(columns, "model") ? columns.model : row.model;
      if (Object.hasOwn(columns, "model")) {
        merged.model = columns.model;
      }
      db.prepare("UPDATE jobs SET model = ?, request_json = ? WHERE id = ?").run(model, JSON.stringify(merged), jobId);
    })
  );
}

function warningLines(stderr, text) {
  return stderr.split(/\r?\n/).filter((line) => line.includes(text));
}

const CODEX_CHOSE = "Codex chose the model; a model set in the Codex configuration applies.";

test("with no model the catalog default model and effort are used", (t) => {
  const ctx = makeRepo(t);
  const result = companion(ctx, ["task", "x"]);
  assert.equal(result.status, 0, result.stderr);
  const state = fakeState(ctx);
  assert.equal(state.lastThreadStart.model, "m-default");
  assert.equal(state.lastTurnStart.model, "m-default");
  assert.equal(state.lastTurnStart.effort, "low");
  const job = latestJob(ctx);
  assert.equal(job.request.modelSource, "catalog-default");
  assert.equal(job.request.effortSource, "catalog-default");
});

test("--model configured sends no model and records provider-default", (t) => {
  const ctx = makeRepo(t);
  const result = companion(ctx, ["task", "--model", "configured", "x"]);
  assert.equal(result.status, 0, result.stderr);
  const state = fakeState(ctx);
  assert.equal(state.lastThreadStart.model, null);
  assert.equal(state.lastTurnStart.model, null);
  assert.equal(latestJob(ctx).request.modelSource, "provider-default");
});

test("a family word resolves from the catalog", (t) => {
  const ctx = makeRepo(t, "list-fails-debug-sols");
  const result = companion(ctx, ["task", "--model", "sol", "x"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fakeState(ctx).lastThreadStart.model, "gpt-6.1-sol");
  assert.equal(latestJob(ctx).request.modelSource, "explicit");
});

test("an unknown model exits 1 with the visible ids before any job or thread", (t) => {
  const ctx = makeRepo(t);
  const result = companion(ctx, ["task", "--model", "spark", "x"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Model "spark" is not in the Codex catalog\. Available: m-default, gpt-5\.6-luna\./);
  assert.deepEqual(allJobs(ctx), []);
  assert.equal(fakeState(ctx).lastThreadStart, undefined);
});

test("when model/list fails the newest visible Sol model is used", (t) => {
  const ctx = makeRepo(t, "list-fails-debug-sols");
  const result = companion(ctx, ["task", "x"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fakeState(ctx).lastThreadStart.model, "gpt-6.1-sol");
  assert.equal(fakeState(ctx).lastTurnStart.model, "gpt-6.1-sol");
  assert.equal(latestJob(ctx).request.modelSource, "family-fallback");
  assert.equal(latestJob(ctx).row.model, "gpt-6.1-sol");
});

test("when no entry is marked default the newest visible Sol model is used", (t) => {
  const ctx = makeRepo(t, "no-default-mark");
  const result = companion(ctx, ["task", "x"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fakeState(ctx).lastThreadStart.model, "gpt-6.1-sol");
  assert.equal(latestJob(ctx).request.modelSource, "family-fallback");
});

// A catalog timeout short enough that a test of the timeout path keeps a wide margin, and long
// enough that the fake app server exists when the timeout stops it. The fake starts through a
// batch-file wrapper; at 1,500 ms, with the whole suite running, the stop sometimes came while the
// wrapper was still starting its child, and that child then ran on ("an app server is still
// running", twice in four whole-suite runs).
const SHORT_CATALOG_TIMEOUT = { CODEX_COMPANION_CATALOG_TIMEOUT_MS: "4000" };

test("a model/list that does not answer falls back within the catalog timeout", { timeout: 60000 }, (t) => {
  const repo = makeRepo(t, "model-list-hangs");
  const ctx = { ...repo, env: { ...repo.env, ...SHORT_CATALOG_TIMEOUT } };
  const started = Date.now();
  const result = companion(ctx, ["task", "x"], { timeout: 40000 });
  const elapsed = Date.now() - started;
  assert.equal(result.error?.code ?? null, null, "the task did not finish");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(elapsed < 20000, `took ${elapsed} ms`);
  assert.equal(fakeState(ctx).lastThreadStart.model, "gpt-6.1-sol");
});

test("without any catalog no model is sent and one warning line is printed", (t) => {
  const ctx = makeRepo(t, "no-catalog");
  const result = companion(ctx, ["task", "x"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fakeState(ctx).lastThreadStart.model, null);
  assert.equal(warningLines(result.stderr, CODEX_CHOSE).length, 1, result.stderr);
  assert.equal(latestJob(ctx).request.modelSource, "provider-default");
});

test("an effort the resolved model does not list is rejected before a job", (t) => {
  const ctx = makeRepo(t);
  const result = companion(ctx, ["task", "--model", "gpt-5.6-luna", "--effort", "ultra", "x"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Model gpt-5\.6-luna does not support reasoning effort "ultra"\. Use one of: low, medium, high\./);
  assert.deepEqual(allJobs(ctx), []);
  assert.equal(fakeState(ctx).lastThreadStart, undefined);
});

test("--model default ignores the stored model and effort", (t) => {
  const ctx = makeRepo(t);
  setConfig(ctx.repo, "models", { codex: { model: "gpt-5.6-luna", effort: "high" } });
  const result = companion(ctx, ["task", "--model", "default", "x"]);
  assert.equal(result.status, 0, result.stderr);
  const state = fakeState(ctx);
  assert.equal(state.lastTurnStart.model, "m-default");
  assert.equal(state.lastTurnStart.effort, "low");
  assert.equal(latestJob(ctx).request.effortSource, "catalog-default");
});

test("a model Codex does not know fails the job with Codex's message when no catalog can check it", (t) => {
  const ctx = makeRepo(t, "unknown-model");
  const result = companion(ctx, ["task", "--model", "gpt-0-nonexistent", "x"]);
  assert.equal(result.status, 1);
  assert.equal(
    warningLines(result.stderr, 'The Codex model catalog is unavailable, so "gpt-0-nonexistent" was not checked.').length,
    1,
    result.stderr
  );
  const job = latestJob(ctx);
  assert.equal(job.state, "failed");
  assert.match(job.row.error, /The 'gpt-0-nonexistent' model is not supported/);
  assert.equal(fakeState(ctx).lastTurnStart.model, "gpt-0-nonexistent");
});

test("thread/start carries the catalog default effort in its config", (t) => {
  const ctx = makeRepo(t);
  const result = companion(ctx, ["task", "x"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fakeState(ctx).lastThreadStart.config?.model_reasoning_effort, "low");
});

test("a resumed thread gets the job's model and effort on thread/resume", (t) => {
  const ctx = makeRepo(t);
  const first = companion(ctx, ["task", "--json", "x"]);
  assert.equal(first.status, 0, first.stderr);
  const { threadId } = JSON.parse(first.stdout);
  const resumed = companion(ctx, ["task", "--resume-thread", threadId, "more"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const state = fakeState(ctx);
  assert.equal(state.lastThreadResume.threadId, threadId);
  assert.equal(state.lastThreadResume.model, "m-default");
  assert.equal(state.lastThreadResume.config?.model_reasoning_effort, "low");
  assert.equal(state.lastTurnStart.model, "m-default");
  assert.equal(state.lastTurnStart.effort, "low");
});

test("a thread that reports another model prints one warning naming both", (t) => {
  const ctx = makeRepo(t, "reports-other-model");
  const result = companion(ctx, ["task", "x"]);
  assert.equal(result.status, 0, result.stderr);
  const lines = warningLines(result.stderr, "Codex reported model");
  assert.deepEqual(lines, ["Codex reported model m-reported (effort high) for this thread; the plugin sent m-default (effort low)."]);
});

test("the reported-model warning of a background task reaches the job log and result", (t) => {
  const ctx = makeRepo(t, "reports-other-model");
  const launched = companion(ctx, ["task", "--background", "--json", "--", "x"]);
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);
  // A store job's log is the file <state dir>/store/artifacts/<job id>.log.
  const logFile = path.join(resolveStateDir(ctx.repo), "store", "artifacts", `${jobId}.log`);
  const neutral = path.join(ROOT, "plugins", "agent", "scripts", "agent-companion.mjs");
  const result = companion(ctx, ["result", jobId, "--wait", "--timeout-ms", "30000"], { script: neutral });
  assert.equal(result.status, 0, result.stderr);
  const warning = "Codex reported model m-reported (effort high) for this thread; the plugin sent m-default (effort low).";
  assert.ok(result.stdout.includes(warning), result.stdout);
  assert.ok(fs.readFileSync(logFile, "utf8").includes(warning), "the job log has no warning");
});

test("a partial report keeps the resolved effort", (t) => {
  const ctx = makeRepo(t, "partial-report");
  const result = companion(ctx, ["task", "x"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(warningLines(result.stderr, "Codex reported model"), []);
  const job = latestJob(ctx);
  assert.equal(job.row.model, "m-default");
  assert.equal(job.request.effort, "low");
});

// Runs a first task and returns its thread id.
function firstTask(ctx, args = []) {
  const result = companion(ctx, ["task", "--json", ...args, "x"]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).threadId;
}

test("--resume-last keeps the continued job's model and effort", (t) => {
  const ctx = makeRepo(t);
  const threadId = firstTask(ctx, ["--model", "luna", "--effort", "high"]);
  const resumed = companion(ctx, ["task", "--resume-last", "more"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const state = fakeState(ctx);
  assert.equal(state.lastThreadResume.threadId, threadId);
  assert.equal(state.lastThreadResume.model, "gpt-5.6-luna");
  assert.equal(state.lastTurnStart.model, "gpt-5.6-luna");
  assert.equal(state.lastTurnStart.effort, "high");
  const job = latestJob(ctx);
  assert.equal(job.request.modelSource, "explicit");
  assert.equal(job.request.effortSource, "explicit");
});

test("a follow-up keeps the stored model after the catalog and the setting change", (t) => {
  const ctx = makeRepo(t);
  const threadId = firstTask(ctx);
  installFakeCodex(ctx.binDir, "list-fails-debug-sols");
  setConfig(ctx.repo, "models", { codex: { model: "gpt-5.6-luna", effort: "medium" } });
  const resumed = companion(ctx, ["task", "--resume-thread", threadId, "more"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const state = fakeState(ctx);
  assert.equal(state.lastTurnStart.model, "m-default");
  assert.equal(state.lastTurnStart.effort, "low");
  assert.equal(latestJob(ctx).request.modelSource, "catalog-default");
});

test("a follow-up with its own --model uses it", (t) => {
  const ctx = makeRepo(t);
  firstTask(ctx);
  const resumed = companion(ctx, ["task", "--resume-last", "--model", "luna", "more"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const state = fakeState(ctx);
  assert.equal(state.lastTurnStart.model, "gpt-5.6-luna");
  assert.equal(state.lastTurnStart.effort, "low");
  const job = latestJob(ctx);
  assert.equal(job.request.modelSource, "explicit");
  assert.equal(job.request.effortSource, "catalog-default");
});

test("a recorded null model stays null on resume", (t) => {
  const ctx = makeRepo(t);
  firstTask(ctx, ["--model", "configured"]);
  // Codex reports the model a thread runs on, so a null model is written here as a record
  // without a report would hold it.
  updateStoredJob(ctx, latestJob(ctx).id, { model: null });
  const resumed = companion(ctx, ["task", "--resume-last", "more"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const state = fakeState(ctx);
  assert.equal(state.lastThreadResume.model, null);
  assert.equal(state.lastTurnStart.model, null);
  assert.equal(latestJob(ctx).request.modelSource, "provider-default");
});

test("a follow-up checks a new effort against the kept model only when the catalog lists that exact id", (t) => {
  const ctx = makeRepo(t, "list-fails-debug-sols");
  firstTask(ctx);
  // The kept id is a bare word that matches no catalog id; only gpt-5.6-luna ends in -luna.
  updateStoredJob(ctx, latestJob(ctx).id, { model: "luna" });
  const resumed = companion(ctx, ["task", "--resume-last", "--effort", "xhigh", "more"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const state = fakeState(ctx);
  assert.equal(state.lastTurnStart.model, "luna");
  assert.equal(state.lastTurnStart.effort, "xhigh");
});

test("a follow-up with --model configured keeps the inherited effort", (t) => {
  const ctx = makeRepo(t);
  firstTask(ctx);
  // The visible catalog says nothing about the model a Codex configuration sets.
  updateStoredJob(ctx, latestJob(ctx).id, { request: { effort: "ultra", effortSource: "explicit" } });
  const resumed = companion(ctx, ["task", "--resume-last", "--model", "configured", "more"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  // --model configured applies to the continuation: no model is sent, and the effort is kept.
  assert.equal(fakeState(ctx).lastTurnStart.model, null);
  assert.equal(fakeState(ctx).lastTurnStart.effort, "ultra");
  assert.deepEqual(warningLines(resumed.stderr, "of the continued job"), []);
});

test("a codex debug models run that floods its output is stopped and the catalog is unavailable", { timeout: 60000 }, async (t) => {
  const ctx = makeRepo(t, "debug-models-floods", { recordIdentities: true });
  const script = [
    `const { readDebugModels } = await import(${JSON.stringify(pathToFileURL(MODEL_CATALOG).href)});`,
    "const started = Date.now();",
    "const result = await readDebugModels(process.cwd(), { timeoutMs: 20000 });",
    "console.log(JSON.stringify({ elapsed: Date.now() - started, ok: result.ok, detail: result.detail }));"
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: ctx.repo,
    env: ctx.env,
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true
  });
  const running = await stopRecordedProcesses(ctx, "debugModelsPids");
  assert.equal(result.status, 0, result.stderr);
  assert.equal((fakeState(ctx).debugModelsPids ?? []).length, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.match(report.detail, /more than/);
  assert.ok(report.elapsed < 15000, `took ${report.elapsed} ms`);
  assert.deepEqual(running, [], "codex debug models is still running");
});

function setupJson(ctx, args) {
  const result = companion(ctx, ["setup", ...args, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("setup --model stores the delegation default and reports the model a delegation would use", (t) => {
  const ctx = makeRepo(t);
  const report = setupJson(ctx, ["--model", "luna", "--effort", "high"]);
  assert.deepEqual(getConfig(ctx.repo).models, { codex: { model: "luna", effort: "high" } });
  assert.deepEqual(report.delegation, { model: "gpt-5.6-luna", effort: "high", modelSource: "setting", effortSource: "setting" });

  const text = companion(ctx, ["setup"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^- delegation model: gpt-5\.6-luna \(setting\)$/m);
  assert.match(text.stdout, /^- delegation effort: high \(setting\)$/m);

  // --effort alone keeps the stored model.
  setupJson(ctx, ["--effort", "medium"]);
  assert.deepEqual(getConfig(ctx.repo).models, { codex: { model: "luna", effort: "medium" } });

  const rejected = companion(ctx, ["setup", "--model", "spark"]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Model "spark" is not in the Codex catalog\. Available: m-default, gpt-5\.6-luna\./);
  assert.deepEqual(getConfig(ctx.repo).models, { codex: { model: "luna", effort: "medium" } });
});

test("setup --model default clears the setting", (t) => {
  const ctx = makeRepo(t);
  setupJson(ctx, ["--model", "luna", "--effort", "high"]);
  const report = setupJson(ctx, ["--model", "default"]);
  assert.deepEqual(getConfig(ctx.repo).models, { codex: null });
  assert.deepEqual(report.delegation, { model: "m-default", effort: "low", modelSource: "catalog-default", effortSource: "catalog-default" });
  const text = companion(ctx, ["setup"]);
  assert.match(text.stdout, /^- delegation model: m-default \(catalog-default\)$/m);
  assert.match(text.stdout, /^- delegation effort: low \(catalog-default\)$/m);
});

test("setup reports a delegation that Codex chooses when no catalog can be read", (t) => {
  const ctx = makeRepo(t, "no-catalog");
  const report = setupJson(ctx, []);
  assert.deepEqual(report.delegation, { model: null, effort: null, modelSource: "provider-default", effortSource: "provider-default" });
  const text = companion(ctx, ["setup"]);
  assert.match(text.stdout, /^- delegation model: chosen by Codex \(provider-default\)$/m);
  assert.match(text.stdout, /^- delegation effort: default \(provider-default\)$/m);
});

test("setup --model keeps the review gate and write sandbox settings", (t) => {
  const ctx = makeRepo(t);
  setupJson(ctx, ["--enable-review-gate", "--write-sandbox", "danger-full-access"]);
  const report = setupJson(ctx, ["--model", "luna"]);
  const config = getConfig(ctx.repo);
  assert.equal(config.stopReviewGate, true);
  assert.equal(config.writeSandbox, "danger-full-access");
  assert.deepEqual(config.models, { codex: { model: "luna", effort: null } });
  assert.equal(report.reviewGateEnabled, true);
  assert.equal(report.writeSandbox, "danger-full-access");
});

test("a stored setting applies to the next task", (t) => {
  const ctx = makeRepo(t);
  setupJson(ctx, ["--model", "luna", "--effort", "high"]);
  const result = companion(ctx, ["task", "x"]);
  assert.equal(result.status, 0, result.stderr);
  const state = fakeState(ctx);
  assert.equal(state.lastTurnStart.model, "gpt-5.6-luna");
  assert.equal(state.lastTurnStart.effort, "high");
  const job = latestJob(ctx);
  assert.equal(job.request.modelSource, "setting");
  assert.equal(job.request.effortSource, "setting");
});

// Stops, through stopOwnedProcesses, each process the fake Codex of this test recorded under `key`
// with its start token, and returns the recorded ids a signal 0 probe found running after a short
// wait. A running process is given time to record its identity first.
async function stopRecordedProcesses(ctx, key) {
  // The job's worker ends its own app server a moment after the foreground command returns, so a
  // process still ending gets a short time to exit. A process that was left behind does not exit.
  await waitUntil(() => (fakeState(ctx)[key] ?? []).every((pid) => !isProcessAlive(pid)), {
    timeoutMs: 3000,
    describe: "the recorded processes to exit"
  }).catch(() => {});
  const running = (fakeState(ctx)[key] ?? []).filter((pid) => isProcessAlive(pid));
  const identities = () => (fakeState(ctx).processIdentities ?? []).filter((entry) => entry.key === key);
  await waitUntil(() => running.every((pid) => !isProcessAlive(pid) || identities().some((entry) => entry.pid === pid)), {
    timeoutMs: 15000,
    describe: "the running processes to record their identities"
  }).catch(() => {});
  await stopOwnedProcesses(identities());
  return running;
}

test("a catalog app server that never answers initialize is stopped and the task ends", { timeout: 60000 }, async (t) => {
  const repo = makeRepo(t, "catalog-initialize-hangs", { recordIdentities: true });
  const ctx = { ...repo, env: { ...repo.env, ...SHORT_CATALOG_TIMEOUT } };
  const started = Date.now();
  const result = companion(ctx, ["task", "x"], { timeout: 30000 });
  const elapsed = Date.now() - started;
  const running = await stopRecordedProcesses(ctx, "appServerPids");
  assert.equal(result.error?.code ?? null, null, "the task did not end");
  assert.deepEqual(running, [], "an app server is still running");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(elapsed < 20000, `took ${elapsed} ms`);
  assert.equal(fakeState(ctx).lastThreadStart.model, "gpt-6.1-sol");
});

test("a codex debug models run that ignores SIGTERM is stopped after a short grace", { timeout: 60000 }, async (t) => {
  const ctx = makeRepo(t, "debug-models-hangs", { recordIdentities: true });
  // The read runs in its own process, so a read that blocks cannot block the test runner.
  const script = [
    `const { readDebugModels } = await import(${JSON.stringify(pathToFileURL(MODEL_CATALOG).href)});`,
    "const started = Date.now();",
    "const result = await readDebugModels(process.cwd(), { timeoutMs: 500 });",
    "console.log(JSON.stringify({ elapsed: Date.now() - started, ok: result.ok, detail: result.detail }));"
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: ctx.repo,
    env: ctx.env,
    encoding: "utf8",
    timeout: 20000,
    windowsHide: true
  });
  const running = await stopRecordedProcesses(ctx, "debugModelsPids");
  assert.equal(result.error?.code ?? null, null, "the debug models read did not end");
  assert.equal((fakeState(ctx).debugModelsPids ?? []).length, 1);
  assert.deepEqual(running, [], "codex debug models is still running");
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.ok(report.elapsed < 5000, `took ${report.elapsed} ms`);
  assert.match(report.detail, /did not answer within/);
});

test("a manifest launch pairs each entry with its own selection from one read of the file", async (t) => {
  const ctx = makeRepo(t);
  const manifest = path.join(makeTempDir(t), "manifest.json");
  const first = { label: "first", prompt: "one", model: "luna" };
  const second = { label: "second", prompt: "two" };
  const selection = (model, effort) => ({ model, effort, modelSource: "explicit", effortSource: "catalog-default", warnings: [] });
  // The file changed after the selections were resolved: reordered, with an entry added.
  fs.writeFileSync(manifest, JSON.stringify([second, first, { label: "added", prompt: "three", model: "unchecked" }]));
  // Each entry's store job is created through the create seam, which records its fields; no
  // worker is launched.
  const created = [];
  const create = (_store, fields) => {
    created.push(fields);
    return { jobId: `task-entry-${created.length}` };
  };
  const launch = async () => null;
  // The launch checks Codex on PATH and prints its report to stdout; both are restored after. The
  // report is written as a string; the test runner's own binary messages pass through.
  const savedPath = process.env.PATH;
  const savedWrite = process.stdout.write;
  const savedExitCode = process.exitCode;
  process.env.PATH = ctx.env.PATH;
  process.stdout.write = (chunk, ...rest) => (typeof chunk === "string" ? true : savedWrite.call(process.stdout, chunk, ...rest));
  try {
    await launchManifestTasks(ctx.repo, ctx.repo, { manifest, json: true }, [], {
      model: null,
      effort: null,
      manifestEntries: [first, second],
      entries: [selection("gpt-5.6-luna", "medium"), selection("m-default", "low")]
    }, { create, launch });
  } finally {
    process.stdout.write = savedWrite;
    process.env.PATH = savedPath;
    process.exitCode = savedExitCode;
  }
  assert.deepEqual(
    created.map((fields) => [fields.prompt, fields.request.model, fields.request.effort]),
    [["one", "gpt-5.6-luna", "medium"], ["two", "m-default", "low"]]
  );
  assert.deepEqual(created.map((fields) => fields.model), ["gpt-5.6-luna", "m-default"]);
});

test("a follow-up's new effort is checked against the continued job's model", (t) => {
  const ctx = makeRepo(t, "list-fails-debug-sols");
  firstTask(ctx, ["--model", "gpt-6-sol"]);
  const resumed = companion(ctx, ["task", "--resume-last", "--effort", "xhigh", "more"]);
  assert.equal(resumed.status, 1, resumed.stderr);
  assert.match(resumed.stderr, /Model gpt-6-sol does not support reasoning effort "xhigh"\. Use one of: low, medium, high\./);
  assert.equal(fakeState(ctx).lastThreadResume, undefined);

  const accepted = companion(ctx, ["task", "--resume-last", "--effort", "high", "more"]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(fakeState(ctx).lastTurnStart.model, "gpt-6-sol");
  assert.equal(fakeState(ctx).lastTurnStart.effort, "high");
});

test("the job records the model and effort turn/start sends, and a follow-up inherits them", (t) => {
  const ctx = makeRepo(t, "reports-other-model");
  firstTask(ctx);
  const first = latestJob(ctx);
  assert.equal(fakeState(ctx).lastTurnStart.model, "m-default");
  assert.equal(first.row.model, "m-default");
  assert.equal(first.request.effort, "low");

  const resumed = companion(ctx, ["task", "--resume-last", "more"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const state = fakeState(ctx);
  assert.equal(state.lastTurnStart.model, "m-default");
  assert.equal(state.lastTurnStart.effort, "low");
});

test("setup --model default clears the setting whatever --effort says", (t) => {
  const ctx = makeRepo(t);
  setupJson(ctx, ["--model", "luna", "--effort", "high"]);
  const report = setupJson(ctx, ["--model", "default", "--effort", "high"]);
  assert.deepEqual(getConfig(ctx.repo).models, { codex: null });
  assert.deepEqual(report.delegation, { model: "m-default", effort: "low", modelSource: "catalog-default", effortSource: "catalog-default" });
});

test("setup --model configured says the Codex configuration chooses the model", (t) => {
  const ctx = makeRepo(t);
  const result = companion(ctx, ["setup", "--model", "configured"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Delegations now use the model set in the Codex configuration in /);
  assert.doesNotMatch(result.stdout, /model configured/);
});

test("setup warns that a model it could not check was stored unchecked", (t) => {
  const ctx = makeRepo(t, "no-catalog");
  const result = companion(ctx, ["setup", "--model", "gpt-0-custom"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    warningLines(result.stderr, 'The Codex model catalog is unavailable, so "gpt-0-custom" was not checked.').length,
    1,
    result.stderr
  );
  assert.doesNotMatch(result.stdout, /Delegations now use model gpt-0-custom/);
  assert.match(result.stdout, /Stored model gpt-0-custom for delegations in .* without checking it\./);
  assert.deepEqual(getConfig(ctx.repo).models, { codex: { model: "gpt-0-custom", effort: null } });
});
