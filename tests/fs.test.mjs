import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { readHookInputJson, readStdinIfPiped } from "../plugins/agent/scripts/lib/fs.mjs";

// A stdin stand-in that is not a terminal: what the test writes arrives as data, and end() closes it.
function pipedStdin() {
  return new PassThrough();
}

test("a writer that sends part of the input and stalls ends at the total timeout", { timeout: 5000 }, async () => {
  const stdin = pipedStdin();
  stdin.write("0123456789");

  const result = await readStdinIfPiped({ stdin, firstByteTimeoutMs: 50, totalTimeoutMs: 200 });

  assert.equal(result, "0123456789");
  assert.equal(stdin.destroyed, true, "stdin stays open after the deadline");
});

test("a payload read in several chunks arrives intact", async () => {
  const stdin = pipedStdin();
  const reading = readStdinIfPiped({ stdin });
  for (const chunk of ["abcde", "fghij", "klmno"]) {
    stdin.write(chunk);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  stdin.end();

  assert.equal(await reading, "abcdefghijklmno");
});

test("a stream destroyed after part of the input returns that part at once", { timeout: 5000 }, async () => {
  const stdin = pipedStdin();
  const started = Date.now();
  const reading = readStdinIfPiped({ stdin, firstByteTimeoutMs: 2000, totalTimeoutMs: 3000 });
  stdin.write("partial");
  await new Promise((resolve) => setTimeout(resolve, 20));
  stdin.destroy();

  assert.equal(await reading, "partial");
  assert.ok(Date.now() - started < 1000, `the read waited ${Date.now() - started} ms after the stream closed`);
});

test("a stream already destroyed reads as empty at once", { timeout: 5000 }, async () => {
  const stdin = pipedStdin();
  stdin.destroy();
  await new Promise((resolve) => setImmediate(resolve));
  const started = Date.now();

  assert.equal(await readStdinIfPiped({ stdin, firstByteTimeoutMs: 2000, totalTimeoutMs: 3000 }), "");
  assert.ok(Date.now() - started < 1000, `the read waited ${Date.now() - started} ms on a closed stream`);
});

test("a terminal stdin reads as empty at once", async () => {
  assert.equal(await readStdinIfPiped({ stdin: { isTTY: true } }), "");
});

test("bad hook JSON names the problem", async () => {
  const stdin = pipedStdin();
  stdin.end("{bad");
  await assert.rejects(() => readHookInputJson({ stdin }), /Hook input is not valid JSON/);
});

test("hook JSON cut short by the deadline names the problem", { timeout: 5000 }, async () => {
  const stdin = pipedStdin();
  stdin.write('{"hook_event_name":');
  await assert.rejects(() => readHookInputJson({ stdin, firstByteTimeoutMs: 50, totalTimeoutMs: 100 }), /Hook input is not valid JSON/);
});

// A real pipe whose writer never closes. The reader runs in a child process that reports how long
// the read took, so a read that blocks shows as a child that does not exit.
async function readInChild({ firstByteTimeoutMs, totalTimeoutMs, feed }) {
  const { spawn } = await import("node:child_process");
  const fsModule = new URL("../plugins/agent/scripts/lib/fs.mjs", import.meta.url).href;
  const source = [
    `import { readStdinIfPiped } from ${JSON.stringify(fsModule)};`,
    "const startedAt = Date.now();",
    `const text = await readStdinIfPiped({ firstByteTimeoutMs: ${firstByteTimeoutMs}, totalTimeoutMs: ${totalTimeoutMs} });`,
    "process.stdout.write(JSON.stringify({ text, elapsedMs: Date.now() - startedAt }));"
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.on("error", () => {});
  const stopFeeding = feed(child.stdin);
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("still reading after 10 s");
    }, 10000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  stopFeeding?.();
  child.stdin.destroy();
  assert.equal(outcome, 0, stderr);
  return JSON.parse(stdout);
}

// Node needs a moment to start; the margin covers a slow machine.
const DEADLINE_MARGIN_MS = 1000;

test("a child reading a stalled pipe returns what arrived at the total deadline", { timeout: 20000 }, async () => {
  const result = await readInChild({
    firstByteTimeoutMs: 1000,
    totalTimeoutMs: 1500,
    feed(stdin) {
      stdin.write("partial input");
    }
  });

  assert.equal(result.text, "partial input");
  assert.ok(result.elapsedMs < 1500 + DEADLINE_MARGIN_MS, `the read took ${result.elapsedMs} ms`);
});

test("a child reading a silent pipe returns empty at the first-byte deadline", { timeout: 20000 }, async () => {
  const result = await readInChild({ firstByteTimeoutMs: 500, totalTimeoutMs: 5000, feed() {} });

  assert.equal(result.text, "");
  assert.ok(result.elapsedMs < 500 + DEADLINE_MARGIN_MS, `the read took ${result.elapsedMs} ms`);
});

test("a child reading a pipe that never stops returns at the total deadline", { timeout: 20000 }, async () => {
  const result = await readInChild({
    firstByteTimeoutMs: 500,
    totalTimeoutMs: 1500,
    feed(stdin) {
      stdin.write("x");
      const timer = setInterval(() => stdin.write("x"), 50);
      return () => clearInterval(timer);
    }
  });

  assert.match(result.text, /^x+$/);
  assert.ok(result.elapsedMs < 1500 + DEADLINE_MARGIN_MS, `the read took ${result.elapsedMs} ms`);
});
