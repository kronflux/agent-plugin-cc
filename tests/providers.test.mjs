import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeCommittedRepo, makeTempDir, run } from "./helpers.mjs";
import { DEFAULT_PROVIDER_ID, getProvider, listProviders, providerForJob } from "../plugins/agent/scripts/lib/providers.mjs";
import { writeJobFile } from "../plugins/agent/scripts/lib/state.mjs";

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "agent", "scripts");
const NEUTRAL = path.join(SCRIPTS, "agent-companion.mjs");
const CODEX_COMPANION = path.join(SCRIPTS, "codex-companion.mjs");
const SHARED_FOLDERS = ["lib", "commands"];
// Folders under lib/ or commands/ whose files may name a provider, each with the reason.
const EXEMPT_FOLDERS = [];
const CAPABILITIES = [
  "authCheck",
  "effort",
  "fork",
  "interrupt",
  "modelFlag",
  "nativeReview",
  "resume",
  "sandboxModes",
  "steer",
  "structuredOutput"
];
const HOOKS = [
  "resumeCommand",
  "interruptTurn",
  "interruptOrphanedTurn",
  "sessionRuntimeStatus",
  "storedOutputText",
  "startFollowUpTurn"
];

// Every file under the shared folders, as paths relative to the scripts folder with "/" separators.
function sharedFiles() {
  const files = [];
  const walk = (relative) => {
    const absolute = path.join(SCRIPTS, relative);
    if (!fs.existsSync(absolute)) {
      return;
    }
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  };
  SHARED_FOLDERS.forEach(walk);
  return files.sort();
}

function readScript(relative) {
  return fs.readFileSync(path.join(SCRIPTS, relative), "utf8");
}

function importSpecifiers(source) {
  const specifiers = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\1/g;
  for (const match of source.matchAll(pattern)) {
    specifiers.push(match[2]);
  }
  return specifiers;
}

test("every provider declares the full capability set and its hooks", () => {
  for (const provider of listProviders()) {
    assert.deepEqual(Object.keys(provider.capabilities).sort(), CAPABILITIES, provider.id);
    for (const hook of HOOKS) {
      assert.equal(typeof provider[hook], "function", `${provider.id}.${hook}`);
    }
    for (const method of ["resolveExplicit", "resolveDefault", "checkEffort"]) {
      assert.equal(typeof provider.modelCatalog?.[method], "function", `${provider.id}.modelCatalog.${method}`);
    }
    assert.ok(provider.label && provider.processMarker && provider.reviewCommands.review, provider.id);
  }
});

test("a job without a provider field is a Codex job", () => {
  assert.equal(DEFAULT_PROVIDER_ID, "codex");
  assert.equal(providerForJob({ id: "task-old" }).id, "codex");
  assert.equal(providerForJob({ id: "task-new", provider: "codex" }).resumeCommand("thr_1"), "codex resume thr_1");
});

test("an unknown provider is an error that names the known ones", () => {
  assert.throws(() => getProvider("nope"), /Unknown agent provider "nope"\. Known providers: codex, agy\./);
});

test("only lib/host.mjs names CLAUDE_ variables in shared code", () => {
  const offenders = sharedFiles()
    .filter((file) => file !== "lib/host.mjs")
    .filter((file) => readScript(file).includes("CLAUDE_"));
  assert.deepEqual(offenders, []);
});

const PROVIDER_NAME = /codex|agy|antigravity/i;
// The host module reads two session variables that older sessions export; those two names are the
// only provider-named text allowed in shared code.
const LEGACY_NAMES = ["CODEX_COMPANION_SESSION_ID", "CODEX_COMPANION_TRANSCRIPT_PATH"];
function withoutLegacyNames(file, text) {
  return file === "lib/host.mjs" ? LEGACY_NAMES.reduce((rest, name) => rest.replaceAll(name, ""), text) : text;
}

test("shared code names no provider outside the registry", () => {
  const exempt = (file) => EXEMPT_FOLDERS.some(({ folder }) => file.startsWith(`${folder.replace(/\/+$/, "")}/`));
  const offenders = sharedFiles()
    .filter((file) => file !== "lib/providers.mjs" && !exempt(file))
    .filter((file) => PROVIDER_NAME.test(withoutLegacyNames(file, readScript(file))));
  assert.deepEqual(offenders, []);
});

test("the neutral entry and its commands import no provider module", () => {
  const files = [
    "agent-companion.mjs",
    ...fs
      .readdirSync(path.join(SCRIPTS, "commands"))
      .filter((name) => name.endsWith(".mjs"))
      .map((name) => `commands/${name}`)
  ];
  assert.ok(files.length > 1, "the neutral commands are missing");
  const offenders = files.flatMap((file) =>
    importSpecifiers(readScript(file))
      .filter((specifier) => specifier.includes("providers/"))
      .map((specifier) => `${file}: ${specifier}`)
  );
  assert.deepEqual(offenders, []);
});

test("the old codex-companion invocation of a neutral subcommand returns the same output", (t) => {
  const repo = makeCommittedRepo(t);
  const pluginData = makeTempDir(t);
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginData };
  const jobId = "task-forward-probe";
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    writeJobFile(repo, jobId, {
      id: jobId,
      provider: "codex",
      kind: "task",
      kindLabel: "rescue",
      title: "Codex Task",
      workspaceRoot: repo,
      jobClass: "task",
      summary: "Probe the forwards",
      status: "completed",
      phase: "done",
      threadId: "thr_forward",
      turnId: "turn_forward",
      pid: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: "2026-01-01T00:00:02.000Z",
      result: { status: 0, rawOutput: "Forward probe answer." },
      rendered: "Forward probe answer.\n"
    });
  } finally {
    process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  }

  for (const args of [["status", "--json"], ["status", jobId, "--json"], ["result", jobId, "--json"]]) {
    const old = run("node", [CODEX_COMPANION, ...args], { cwd: repo, env });
    const neutral = run("node", [NEUTRAL, ...args], { cwd: repo, env });
    assert.equal(old.status, 0, `${args.join(" ")}: ${old.stderr}`);
    assert.equal(neutral.status, old.status, args.join(" "));
    assert.equal(neutral.stdout, old.stdout, args.join(" "));
  }

  const oldCancel = run("node", [CODEX_COMPANION, "cancel", jobId, "--json"], { cwd: repo, env });
  const neutralCancel = run("node", [NEUTRAL, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.notEqual(oldCancel.status, 0, "cancel of a finished job succeeded");
  assert.equal(neutralCancel.status, oldCancel.status);
  assert.equal(neutralCancel.stderr, oldCancel.stderr);
});

test("the legacy-name allowance covers only the two session variables", () => {
  const host = readScript("lib/host.mjs");
  assert.equal(PROVIDER_NAME.test(withoutLegacyNames("lib/host.mjs", host)), false);
  assert.equal(PROVIDER_NAME.test(withoutLegacyNames("lib/host.mjs", host + " // codex")), true);
  assert.equal(PROVIDER_NAME.test(withoutLegacyNames("lib/host.mjs", host + " CODEX_COMPANION_OTHER")), true);
  assert.equal(PROVIDER_NAME.test(withoutLegacyNames("lib/job-control.mjs", "CODEX_COMPANION_SESSION_ID")), true);
});
