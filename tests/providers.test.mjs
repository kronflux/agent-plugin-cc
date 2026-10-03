import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { DEFAULT_PROVIDER_ID, getProvider, listProviders, providerForJob } from "../plugins/agent/scripts/lib/providers.mjs";

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "agent", "scripts", "lib");
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

test("every provider declares the full capability set and its hooks", () => {
  for (const provider of listProviders()) {
    assert.deepEqual(Object.keys(provider.capabilities).sort(), CAPABILITIES, provider.id);
    for (const hook of ["resumeCommand", "interruptTurn", "interruptOrphanedTurn", "sessionRuntimeStatus", "storedOutputText"]) {
      assert.equal(typeof provider[hook], "function", `${provider.id}.${hook}`);
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
  assert.throws(() => getProvider("nope"), /Unknown agent provider "nope"\. Known providers: codex\./);
});

test("the shared library names a provider only in the registry", () => {
  const offenders = fs
    .readdirSync(LIB)
    .filter((name) => name !== "providers.mjs")
    .filter((name) => /codex/.test(fs.readFileSync(path.join(LIB, name), "utf8")));
  assert.deepEqual(offenders, []);
});
