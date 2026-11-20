import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { installFakeAgy, readFakeAgyState } from "./fake-agy-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";
import * as agyUsage from "../plugins/agent/scripts/providers/agy/usage.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGY = path.join(ROOT, "plugins", "agent", "scripts", "agy-companion.mjs");
const NEUTRAL = path.join(ROOT, "plugins", "agent", "scripts", "agent-companion.mjs");

// A fake agy on PATH, a home folder with optional Antigravity settings, and a working folder.
function usageEnv(t, behavior = "usage-json", { settings = null } = {}) {
  const binDir = makeTempDir(t);
  installFakeAgy(binDir, behavior);
  const home = makeTempDir(t);
  if (settings !== null) {
    const folder = path.join(home, ".gemini", "antigravity-cli");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  }
  const cwd = makeTempDir(t);
  const sep = process.platform === "win32" ? ";" : ":";
  return { binDir, home, cwd, env: { ...process.env, HOME: home, USERPROFILE: home, TZ: "America/Chicago", PATH: `${binDir}${sep}${process.env.PATH}` } };
}

const BUCKET_LINE = /^- .+: (\d+%|unknown) left(, resets \d{4}-\d\d-\d\d \d\d:\d\d \S+)?$/gm;

const GEMINI_BLOCK = [
  "Gemini Models",
  "Models within this group: Gemini 4 Hydrogen, Gemini 3.8 Flash",
  "- Weekly Limit Remaining: 100% left, resets 2026-11-24 03:01 CST",
  "- Five Hour Limit Remaining: 100% left, resets 2026-11-17 08:01 CST"
].join("\n");

test("renderAgyUsageReport prints the exact text form", () => {
  assert.equal(typeof agyUsage.renderAgyUsageReport, "function", "renderAgyUsageReport is not exported");
  const normalized = {
    schema: 1,
    provider: "agy",
    fetchedAt: "2026-11-17T12:00:00.000Z",
    groups: [
      {
        name: "Gemini Models",
        description: "Models within this group: Gemini 4 Hydrogen, Gemini 3.8 Flash",
        defaultDelegation: false,
        buckets: [
          { id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remainingFraction: 1, resetTime: "2026-11-24T09:01:29Z" },
          { id: "gemini-5h", name: "Five Hour Limit Remaining", window: "five_hour", remainingFraction: 1, resetTime: "2026-11-17T14:01:29Z" }
        ]
      }
    ]
  };
  const text = agyUsage.renderAgyUsageReport(normalized, { timeZone: "America/Chicago" });
  assert.ok(text.startsWith("# Antigravity Usage\n\n"), text);
  assert.ok(text.includes(`${GEMINI_BLOCK}\n`), text);
});

test("usage prints every group and bucket from the structured data", (t) => {
  const ctx = usageEnv(t);

  const result = run("node", [AGY, "usage"], { cwd: ctx.cwd, env: ctx.env });

  assert.equal(result.status, 0, result.stderr);
  for (const heading of ["Gemini Models", "Gemini 4 Argon", "Claude Models"]) {
    assert.match(result.stdout, new RegExp(`^${heading}( \\(used by default delegation\\))?$`, "m"));
  }
  assert.equal(result.stdout.match(BUCKET_LINE)?.length, 5, result.stdout);
  assert.ok(result.stdout.includes(GEMINI_BLOCK), result.stdout);
  const runs = readFakeAgyState(ctx.binDir).runs;
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].args, ["--print", "/usage", "--output-format", "json"]);
  assert.deepEqual(runs[0].inputs, []);
  const status = run("node", [NEUTRAL, "status", "--json"], { cwd: ctx.cwd, env: ctx.env });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).jobs, []);
});

test("usage parses the response text when the structured data is absent", (t) => {
  const structured = usageEnv(t);
  const textOnly = usageEnv(t, "usage-text-only");

  const fromData = run("node", [AGY, "usage"], { cwd: structured.cwd, env: structured.env });
  const fromText = run("node", [AGY, "usage"], { cwd: textOnly.cwd, env: textOnly.env });

  assert.equal(fromText.status, 0, fromText.stderr);
  assert.deepEqual(fromText.stdout.match(BUCKET_LINE), fromData.stdout.match(BUCKET_LINE));
});

test("usage fails with the reason when agy reports an error", (t) => {
  const ctx = usageEnv(t, "usage-error");

  const result = run("node", [AGY, "usage"], { cwd: ctx.cwd, env: ctx.env });

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /ERROR/);
  assert.match(result.stderr, /quota service unavailable/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /undefined|NaN/);
});

test("usage --json prints the normalised object", (t) => {
  const ctx = usageEnv(t);

  const result = run("node", [AGY, "usage", "--json"], { cwd: ctx.cwd, env: ctx.env });

  assert.equal(result.status, 0, result.stderr);
  const normalized = JSON.parse(result.stdout);
  assert.equal(normalized.schema, 1);
  assert.equal(normalized.provider, "agy");
  assert.ok(!Number.isNaN(Date.parse(normalized.fetchedAt)));
  assert.equal(normalized.groups.length, 3);
  const buckets = normalized.groups.flatMap((group) => group.buckets);
  assert.equal(buckets.length, 5);
  for (const bucket of buckets) {
    assert.deepEqual(Object.keys(bucket), ["id", "name", "window", "remainingFraction", "resetTime"]);
    assert.ok(typeof bucket.remainingFraction === "number" && bucket.remainingFraction >= 0 && bucket.remainingFraction <= 1, JSON.stringify(bucket));
    assert.match(bucket.resetTime, /Z$/);
  }
  for (const group of normalized.groups) {
    assert.deepEqual(Object.keys(group), ["name", "description", "defaultDelegation", "buckets"]);
  }
});

// ---------------------------------------------------------------------------------------------
// The quota group of the model a delegation would use

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("the group named after the saved default model is marked", (t) => {
  const ctx = usageEnv(t, "usage-json", { settings: { model: "Gemini 4 Argon (Medium)", trustedWorkspaces: ["C:/secret-path"] } });
  const settingsFile = path.join(ctx.home, ".gemini", "antigravity-cli", "settings.json");
  const before = sha256(settingsFile);

  const text = run("node", [AGY, "usage"], { cwd: ctx.cwd, env: ctx.env });
  const json = run("node", [AGY, "usage", "--json"], { cwd: ctx.cwd, env: ctx.env });

  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout.match(/\(used by default delegation\)/g)?.length, 1, text.stdout);
  assert.match(text.stdout, /^Gemini 4 Argon \(used by default delegation\)$/m);
  const marked = JSON.parse(json.stdout).groups.filter((group) => group.defaultDelegation);
  assert.deepEqual(marked.map((group) => group.name), ["Gemini 4 Argon"]);
  for (const output of [text.stdout, text.stderr, json.stdout, json.stderr]) {
    assert.doesNotMatch(output, /trustedWorkspaces|secret-path/);
  }
  assert.equal(sha256(settingsFile), before);
});

test("markDefaultGroup prefers an exact name, then the first name or description match", () => {
  const group = (name, description = null) => ({ name, description, defaultDelegation: false, buckets: [] });
  const marked = (groups) => groups.filter((entry) => entry.defaultDelegation).map((entry) => entry.name);

  assert.deepEqual(marked(agyUsage.markDefaultGroup([group("Mixed", "Models within this group: Gemini 4 Argon"), group("Gemini 4 Argon")], "Gemini 4 Argon")), ["Gemini 4 Argon"]);
  assert.deepEqual(marked(agyUsage.markDefaultGroup([group("Other"), group("Gemini 4 Argon Preview")], "Gemini 4 Argon")), ["Gemini 4 Argon Preview"]);
  assert.deepEqual(marked(agyUsage.markDefaultGroup([group("A", "has gemini 4 argon"), group("B", "also Gemini 4 Argon")], "Gemini 4 Argon")), ["A"]);
  assert.deepEqual(marked(agyUsage.markDefaultGroup([group("A"), group("B")], "Gemini 4 Argon")), []);
});

test("stripEffortSuffix keeps a qualifier that is not an effort", () => {
  assert.equal(agyUsage.stripEffortSuffix("Gemini 4 Argon (Medium)", ["low", "medium", "high"]), "Gemini 4 Argon");
  assert.equal(agyUsage.stripEffortSuffix("Claude Opus 5.5 (Thinking)", ["low", "medium", "high"]), "Claude Opus 5.5 (Thinking)");
});

test("a model from the plugin setting is resolved through agy models", (t) => {
  const ctx = usageEnv(t, "usage-fake-model", { settings: { model: "Gemini 4 Argon (Medium)" } });
  const setup = run("node", [AGY, "setup", "--model", "fake-model-high"], { cwd: ctx.cwd, env: ctx.env });
  assert.equal(setup.status, 0, setup.stderr);

  const result = run("node", [AGY, "usage", "--json"], { cwd: ctx.cwd, env: ctx.env });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout)
      .groups.filter((group) => group.defaultDelegation)
      .map((group) => group.name),
    ["Fake Group"]
  );
});

test("a missing or malformed settings file makes the default unknown", (t) => {
  for (const settings of [null, "not json", {}]) {
    const ctx = usageEnv(t, "usage-json", { settings });

    const result = run("node", [AGY, "usage"], { cwd: ctx.cwd, env: ctx.env });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Default delegation model: unknown \(no model key in the Antigravity settings\)\.$/m);
    assert.doesNotMatch(result.stdout, /used by default delegation/);
  }
});
