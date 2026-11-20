import test from "node:test";
import assert from "node:assert/strict";

import { readHookInputJson, readStdinIfPiped } from "../plugins/agent/scripts/lib/fs.mjs";

function transientError() {
  return Object.assign(new Error("resource temporarily unavailable"), { code: "EAGAIN" });
}

// Returns a readSync stand-in that hands out the given byte chunks in order, then end of input.
function chunkedReadSync(chunks) {
  const queue = chunks.map((chunk) => Buffer.from(chunk));
  return (fd, buffer) => {
    const next = queue.shift();
    if (!next) {
      return 0;
    }
    next.copy(buffer, 0);
    return next.length;
  };
}

test("a writer that sends part of the input and stalls ends at the total timeout", () => {
  let clock = 0;
  let calls = 0;
  const result = readStdinIfPiped({
    stdin: { isTTY: false },
    readSync(fd, buffer) {
      calls += 1;
      if (calls >= 2000) {
        throw new Error("fuse: deadline ignored");
      }
      if (calls === 1) {
        return buffer.write("0123456789", 0, "utf8");
      }
      throw transientError();
    },
    wait() {
      clock += 50;
    },
    now: () => clock,
    totalTimeoutMs: 1000
  });

  assert.equal(result, "0123456789");
});

test("a payload read in several chunks arrives intact", () => {
  const result = readStdinIfPiped({
    stdin: { isTTY: false },
    readSync: chunkedReadSync(["abcde", "fghij", "klmno"])
  });

  assert.equal(result, "abcdefghijklmno");
});

test("bad hook JSON names the problem", () => {
  assert.throws(
    () => readHookInputJson({ stdin: { isTTY: false }, readSync: chunkedReadSync(["{bad"]) }),
    /Hook input is not valid JSON/
  );
});
