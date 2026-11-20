import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "bump-version.mjs");

const MANIFESTS = [
  "package.json",
  "package-lock.json",
  path.join("plugins", "agent", ".claude-plugin", "plugin.json"),
  path.join(".claude-plugin", "marketplace.json")
];

function writeJson(filePath, json, eol = "\n") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`.replace(/\n/g, eol));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function makeVersionFixture(t, { eol = "\n", marketplacePlugins } = {}) {
  const root = makeTempDir(t);

  writeJson(path.join(root, "package.json"), { name: "agent-plugin-cc", version: "1.0.2" }, eol);
  writeJson(
    path.join(root, "package-lock.json"),
    {
      name: "agent-plugin-cc",
      version: "1.0.2",
      lockfileVersion: 3,
      packages: { "": { name: "agent-plugin-cc", version: "1.0.2" } }
    },
    eol
  );
  writeJson(path.join(root, "plugins", "agent", ".claude-plugin", "plugin.json"), { name: "agent", version: "1.0.2" }, eol);
  writeJson(
    path.join(root, ".claude-plugin", "marketplace.json"),
    {
      metadata: { version: "1.0.2" },
      plugins: marketplacePlugins ?? [{ name: "agent", version: "1.0.2" }]
    },
    eol
  );

  return root;
}

function snapshot(root) {
  return MANIFESTS.map((file) => fs.readFileSync(path.join(root, file), "utf8"));
}

test("bump-version updates every release manifest", (t) => {
  const root = makeVersionFixture(t);

  const result = run("node", [SCRIPT, "--root", root, "1.2.3"], {
    cwd: ROOT
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJson(path.join(root, "package.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, "package-lock.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, "package-lock.json")).packages[""].version, "1.2.3");
  assert.equal(readJson(path.join(root, "plugins", "agent", ".claude-plugin", "plugin.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, ".claude-plugin", "marketplace.json")).metadata.version, "1.2.3");
  assert.equal(readJson(path.join(root, ".claude-plugin", "marketplace.json")).plugins[0].version, "1.2.3");
});

test("check mode passes when all versions agree", (t) => {
  const root = makeVersionFixture(t);

  const result = run("node", [SCRIPT, "--root", root, "--check"], { cwd: ROOT });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /All version metadata matches 1\.0\.2\./);
});

test("an explicit version is applied to every manifest", (t) => {
  const root = makeVersionFixture(t);

  const result = run("node", [SCRIPT, "--root", root, "2.0.0-rc.1"], { cwd: ROOT });

  assert.equal(result.status, 0, result.stderr);
  const check = run("node", [SCRIPT, "--root", root, "--check", "2.0.0-rc.1"], { cwd: ROOT });
  assert.equal(check.status, 0, check.stderr);
});

test("an invalid version changes no file", (t) => {
  const root = makeVersionFixture(t);
  const before = snapshot(root);

  const result = run("node", [SCRIPT, "--root", root, "not-a-version"], { cwd: ROOT });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Expected a semver-like version/);
  assert.deepEqual(snapshot(root), before);
});

test("a manifest that cannot be bumped leaves the earlier ones untouched", (t) => {
  const root = makeVersionFixture(t, { marketplacePlugins: [{ name: "other", version: "1.0.2" }] });
  const before = snapshot(root);

  const result = run("node", [SCRIPT, "--root", root, "1.2.3"], { cwd: ROOT });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /plugins\[agent\]/);
  assert.deepEqual(snapshot(root), before);
  assert.equal(readJson(path.join(root, "package.json")).version, "1.0.2");
});

test("bumping keeps CRLF line endings", (t) => {
  const root = makeVersionFixture(t, { eol: "\r\n" });

  const result = run("node", [SCRIPT, "--root", root, "1.2.3"], { cwd: ROOT });

  assert.equal(result.status, 0, result.stderr);
  for (const text of snapshot(root)) {
    assert.match(text, /\r\n/);
    assert.doesNotMatch(text, /[^\r]\n/);
    assert.match(text, /1\.2\.3/);
  }
});

test("a file that is not JSON is reported by name", (t) => {
  const root = makeVersionFixture(t);
  fs.writeFileSync(path.join(root, "package-lock.json"), "{ not json");

  const result = run("node", [SCRIPT, "--root", root, "1.2.3"], { cwd: ROOT });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cannot parse package-lock\.json: /);
});

test("--root followed by an option is rejected", (t) => {
  const root = makeVersionFixture(t);

  const result = run("node", [SCRIPT, "--root", "--check"], { cwd: root });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--root requires a directory/);
});

test("bump-version check mode reports stale metadata", (t) => {
  const root = makeVersionFixture(t);

  const result = run("node", [SCRIPT, "--root", root, "--check", "1.0.3"], {
    cwd: ROOT
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /^package\.json version: /m);
  assert.match(result.stderr, /^package-lock\.json version: /m);
  assert.match(result.stderr, /plugins\/agent\/\.claude-plugin\/plugin\.json version/);
  assert.match(result.stderr, /\.claude-plugin\/marketplace\.json metadata\.version/);
});

test("check mode reports a marketplace without the agent plugin as stale", (t) => {
  const root = makeVersionFixture(t, { marketplacePlugins: [] });

  const result = run("node", [SCRIPT, "--root", root, "--check"], { cwd: ROOT });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /plugins\[agent\]\.version: expected 1\.0\.2, found <missing>/);
});

test("a manifest whose JSON is not an object fails the bump before any write", (t) => {
  const root = makeVersionFixture(t);
  fs.writeFileSync(path.join(root, "package.json"), "[]\n");
  const before = snapshot(root);

  const result = run("node", [SCRIPT, "--root", root, "1.2.3"], { cwd: ROOT });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package\.json/);
  assert.deepEqual(snapshot(root), before);
});

test("a manifest without its version field fails the bump before any write", (t) => {
  const root = makeVersionFixture(t);
  writeJson(path.join(root, "plugins", "agent", ".claude-plugin", "plugin.json"), { name: "agent" });
  const before = snapshot(root);

  const result = run("node", [SCRIPT, "--root", root, "1.2.3"], { cwd: ROOT });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /plugins\/agent\/\.claude-plugin\/plugin\.json has no version/);
  assert.deepEqual(snapshot(root), before);
});
