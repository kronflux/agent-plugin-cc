import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { run } from "./helpers.mjs";
import { DEFAULT_PROVIDER_ID, getProvider, listProviders, providerForJob } from "../plugins/agent/scripts/lib/providers.mjs";

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "agent", "scripts");
const CODEX_COMPANION = path.join(SCRIPTS, "codex-companion.mjs");
const SHARED_FOLDERS = ["lib", "commands"];
// Folders under lib/ or commands/ whose files may name a provider, each with the reason.
const EXEMPT_FOLDERS = [
  { folder: "lib/transfer/sources/", reason: "a source reader names the client whose files it reads" },
  { folder: "lib/council/", reason: "family names are data in the council" }
];
const CAPABILITIES = [
  "authCheck",
  "effort",
  "fork",
  "history",
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
  "sessionRuntimeStatus"
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
    .filter((file) => file !== "lib/providers.mjs" && file !== "lib/store.mjs" && !exempt(file)) // The job store schema lists the provider ids in a CHECK constraint.
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

test("the removed codex-companion forwards fail as unknown subcommands", () => {
  for (const name of ["status", "result", "send", "cancel", "adversarial-review"]) {
    const result = run("node", [CODEX_COMPANION, name], { cwd: SCRIPTS });
    assert.equal(result.status, 1, `${name}: ${result.stdout}`);
    assert.ok(result.stderr.includes(`Unknown subcommand: ${name}`), `${name}: ${result.stderr}`);
  }
});

test("the legacy-name allowance covers only the two session variables", () => {
  const host = readScript("lib/host.mjs");
  assert.equal(PROVIDER_NAME.test(withoutLegacyNames("lib/host.mjs", host)), false);
  assert.equal(PROVIDER_NAME.test(withoutLegacyNames("lib/host.mjs", host + " // codex")), true);
  assert.equal(PROVIDER_NAME.test(withoutLegacyNames("lib/host.mjs", host + " CODEX_COMPANION_OTHER")), true);
  assert.equal(PROVIDER_NAME.test(withoutLegacyNames("lib/job-control.mjs", "CODEX_COMPANION_SESSION_ID")), true);
});
