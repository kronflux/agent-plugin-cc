import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { initGitRepo, makeCommittedRepo, makeTempDir, ownedStopCounts, run, spawnJson, stopOwnedProcess, stopWaiting, waitUntil } from "./helpers.mjs";

const PROCESS_LIB = pathToFileURL(path.resolve(import.meta.dirname, "..", "plugins", "agent", "scripts", "lib", "process.mjs")).href;

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

// True while a process with this id exists.
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// On a loaded machine the child can be stopped before it writes its pid file; the test then
// checks only that the call timed out.
test("spawnJson rejects on timeout and stops the child", { timeout: 60000 }, async (t) => {
  const dir = makeTempDir(t);
  const pidFile = path.join(dir, "pid.txt");
  const script = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000)`;
  await assert.rejects(spawnJson(process.execPath, ["-e", script], { timeoutMs: 3000 }), /timed out/);
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await waitUntil(() => !processExists(pid), { timeoutMs: 15000, describe: "the timed-out child to exit" });
  }
});

test("spawnJson stops a timed-out child's descendants that hold its output", { timeout: 60000 }, async (t) => {
  // Registered before the folder, so it runs before the folder is removed.
  let identityFile = null;
  t.after(() => (identityFile && fs.existsSync(identityFile) ? stopOwnedProcess(JSON.parse(fs.readFileSync(identityFile, "utf8"))) : null));
  const dir = makeTempDir(t);
  const pidFile = path.join(dir, "grandchild.txt");
  identityFile = path.join(dir, "grandchild-identity.json");
  // The grandchild inherits the child's stdout and stderr and would keep them open. The child,
  // which holds the grandchild, also records the grandchild's identity once it has read it.
  const script = [
    'const { spawn } = require("node:child_process");',
    'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });',
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));`,
    `import(${JSON.stringify(PROCESS_LIB)})`,
    "  .then((lib) => lib.readProcessIdentity(grandchild.pid, { deadline: performance.now() + 30000 }))",
    "  .then((identity) => {",
    "    if (identity.state === \"present\") {",
    `      require("node:fs").writeFileSync(${JSON.stringify(identityFile)}, JSON.stringify({ pid: grandchild.pid, startToken: identity.startToken }));`,
    "    }",
    "  });",
    "setInterval(() => {}, 1000);"
  ].join("\n");
  let grandchildPid = null;

  const outcome = await Promise.race([
    spawnJson(process.execPath, ["-e", script], { timeoutMs: 4000 }).then(
      () => "resolved",
      (error) => error
    ),
    new Promise((resolve) => setTimeout(() => resolve("still waiting 30 s later"), 30000).unref())
  ]);
  if (fs.existsSync(pidFile)) {
    grandchildPid = Number(fs.readFileSync(pidFile, "utf8"));
  }

  assert.ok(outcome instanceof Error, `spawnJson ${String(outcome)}`);
  assert.match(outcome.message, /timed out/);
  if (grandchildPid) {
    await waitUntil(() => !processExists(grandchildPid), { timeoutMs: 15000, describe: "the grandchild to exit" });
  }
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

// Lines that may signal or taskkill a process outside stopOwnedProcess, each with its reason.
// An entry matches a line of `file` that contains `text`.
const STOP_ALLOWLIST = [];

// The text between the parenthesis at `open` and its match, or null when it is not closed.
function callArguments(source, open) {
  let depth = 0;
  let quote = null;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "(" || char === "[" || char === "{") {
      depth += 1;
    } else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open + 1, index);
      }
    }
  }
  return null;
}

// Splits call arguments at their top-level commas.
function splitArguments(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if ("([{".includes(char)) {
      depth += 1;
    } else if (")]}".includes(char)) {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter((part) => part !== "");
}

// Every process.kill call with a signal other than 0, and every taskkill spawn, outside comments,
// in the test files other than tests/helpers.mjs and outside the allowlist: `{ file, line, text }`.
export function findUnownedStops(testsDir) {
  const found = [];
  for (const name of fs.readdirSync(testsDir).filter((entry) => entry.endsWith(".mjs")).sort()) {
    if (name === "helpers.mjs") {
      continue;
    }
    const source = fs.readFileSync(path.join(testsDir, name), "utf8");
    const lineOf = (index) => source.slice(0, index).split("\n").length;
    const lineText = (line) => source.split("\n")[line - 1].trim();
    const hits = [];
    for (const match of source.matchAll(/process\.kill\s*\(/g)) {
      const args = callArguments(source, match.index + match[0].length - 1);
      const parts = args === null ? [] : splitArguments(args);
      if (parts.length >= 2 && parts[1] === "0") {
        continue;
      }
      hits.push(lineOf(match.index));
    }
    for (const match of source.matchAll(/\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|runBounded)\s*\(\s*["'`]taskkill\b/g)) {
      hits.push(lineOf(match.index));
    }
    for (const line of hits) {
      const text = lineText(line);
      if (text.startsWith("//") || text.startsWith("*")) {
        continue;
      }
      if (!STOP_ALLOWLIST.some((entry) => entry.file === name && text.includes(entry.text))) {
        found.push({ file: name, line, text });
      }
    }
  }
  return found;
}

test("no test file signals or taskkills a process outside stopOwnedProcess", () => {
  const found = findUnownedStops(import.meta.dirname);
  assert.deepEqual(
    found.map((entry) => `${entry.file}:${entry.line}: ${entry.text}`),
    [],
    `${found.length} unowned stops`
  );
});

test("the stop guard flags signals and taskkill spawns and passes signal 0 probes and comments", (t) => {
  const dir = makeTempDir(t);
  // The calls are assembled, so this file itself holds none for the guard to find.
  const kill = ["process", "kill"].join(".");
  const spawnTaskkill = ["spawnSync(", '"task', 'kill"'].join("");
  fs.writeFileSync(
    path.join(dir, "sample.test.mjs"),
    [
      `${kill}(pid, 0);`,
      `${kill}(pid);`,
      `${kill}(child.pid, "SIGKILL");`,
      `// ${kill}(pid) in a comment`,
      `${spawnTaskkill}, ["/PID", String(pid), "/F"]);`,
      ""
    ].join("\n")
  );
  fs.writeFileSync(path.join(dir, "helpers.mjs"), `${kill}(pid, "SIGKILL");\n`);
  assert.deepEqual(
    findUnownedStops(dir).map((entry) => `${entry.file}:${entry.line}`),
    ["sample.test.mjs:2", "sample.test.mjs:3", "sample.test.mjs:5"]
  );
});

function spawnSleeper() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
}

test("stopOwnedProcess stops a held running child and skips one that has exited", { timeout: 30000 }, async (t) => {
  const child = spawnSleeper();
  t.after(() => stopOwnedProcess(child));
  await new Promise((resolve) => child.once("spawn", resolve));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  assert.equal(await stopOwnedProcess(child), "stopped");
  await exited;
  assert.equal(await stopOwnedProcess(child), "exited");
});

test("stopOwnedProcess stops a recorded identity only when its start token matches", { timeout: 60000 }, async (t) => {
  const child = spawnSleeper();
  t.after(() => stopOwnedProcess(child));
  await new Promise((resolve) => child.once("spawn", resolve));
  const { readProcessIdentity } = await import(PROCESS_LIB);
  const observed = await readProcessIdentity(child.pid, { deadline: performance.now() + 15000 });
  assert.equal(observed.state, "present");
  const before = { ...ownedStopCounts };
  const otherToken = String(observed.startToken).replace(/(\d+)$/, (digits) => String(BigInt(digits) + 1n));

  assert.equal(await stopOwnedProcess(child.pid), "unproved");
  assert.equal(await stopOwnedProcess({ pid: child.pid, startToken: null }), "unproved");
  assert.equal(await stopOwnedProcess({ pid: child.pid, startToken: otherToken }), "mismatch");
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  assert.equal(ownedStopCounts.unproved - before.unproved, 2);
  assert.equal(ownedStopCounts.mismatch - before.mismatch, 1);

  const exited = new Promise((resolve) => child.once("exit", resolve));
  assert.equal(await stopOwnedProcess({ pid: child.pid, startToken: observed.startToken }), "stopped");
  await exited;
});
