import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { pathToFileURL } from "node:url";

import { initGitRepo, makeCommittedRepo, makeTempDir, run, spawnJson, stopWaiting, waitUntil } from "./helpers.mjs";

test("waitUntil treats a throwing predicate as not yet", async () => {
  let calls = 0;
  const value = await waitUntil(
    () => {
      calls += 1;
      if (calls <= 2) {
        throw new Error("not ready");
      }
      return 3;
    },
    { intervalMs: 10 }
  );
  assert.equal(value, 3);
});

test("waitUntil stops early on a terminal marker", async () => {
  const started = Date.now();
  await assert.rejects(
    waitUntil(() => stopWaiting("job failed"), { timeoutMs: 5000, intervalMs: 10 }),
    /job failed/
  );
  assert.ok(Date.now() - started < 500);
});

test("waitUntil reports the description and last value on timeout", async () => {
  await assert.rejects(
    waitUntil(() => 0, { timeoutMs: 200, intervalMs: 20, describe: "queued job" }),
    /queued job did not happen within 200 ms; last value: 0/
  );
});

test("spawnJson resolves on close with parsed stdout", async () => {
  const result = await spawnJson(process.execPath, ["-e", "console.log(JSON.stringify({a:1}))"]);
  assert.equal(result.json.a, 1);
  assert.equal(result.code, 0);
});

test("spawnJson rejects with stderr when stdout is not JSON", async () => {
  await assert.rejects(
    spawnJson(process.execPath, ["-e", "console.log('oops'); console.error('bad')"]),
    /bad/
  );
});

test("spawnJson rejects on timeout and stops the child", async (t) => {
  const dir = makeTempDir(t);
  const pidFile = path.join(dir, "pid.txt");
  const script = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000)`;
  await assert.rejects(spawnJson(process.execPath, ["-e", script], { timeoutMs: 1000 }), /timed out/);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("makeTempDir removes its folder when the test ends", async (t) => {
  let dir;
  await t.test("creates a folder", (sub) => {
    dir = makeTempDir(sub);
    fs.writeFileSync(path.join(dir, "file.txt"), "x");
    assert.ok(fs.existsSync(dir));
  });
  assert.equal(fs.existsSync(dir), false);
});

test("folders made without a test context are removed when the file ends", (t) => {
  const dir = makeTempDir(t);
  const helpersUrl = pathToFileURL(path.resolve(import.meta.dirname, "helpers.mjs")).href;
  const pathsFile = path.join(dir, "paths.json");
  const file = path.join(dir, "sweep.test.mjs");
  fs.writeFileSync(
    file,
    [
      'import fs from "node:fs";',
      'import test from "node:test";',
      `import { makeTempDir } from ${JSON.stringify(helpersUrl)};`,
      'test("makes folders", () => {',
      "  const paths = [makeTempDir(), makeTempDir(\"x-\")];",
      `  fs.writeFileSync(${JSON.stringify(pathsFile)}, JSON.stringify(paths));`,
      "  for (const p of paths) fs.writeFileSync(p + \"/f.txt\", \"x\");",
      "});",
      ""
    ].join("\n")
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  run(process.execPath, ["--test", file], { check: true, env });
  const paths = JSON.parse(fs.readFileSync(pathsFile, "utf8"));
  assert.equal(paths.length, 2);
  for (const p of paths) {
    assert.equal(fs.existsSync(p), false, p);
  }
});

test("run with check throws on a non-zero status", () => {
  assert.throws(() => run(process.execPath, ["-e", "process.exit(3)"], { check: true }), /status 3/);
});

test("initGitRepo throws when git fails", (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, "plain-file");
  fs.writeFileSync(filePath, "x");
  assert.throws(() => initGitRepo(filePath));
});

test("makeCommittedRepo returns a repository with one commit", (t) => {
  const repo = makeCommittedRepo(t);
  const result = run("git", ["rev-list", "--count", "HEAD"], { cwd: repo, check: true });
  assert.equal(result.stdout.trim(), "1");
});
