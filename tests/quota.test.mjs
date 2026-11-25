import test from "node:test";
import assert from "node:assert/strict";

import { mayBeQuotaFailure, quotaNoteFor, quotaNoteForView, quotaReached, quotaSentence } from "../plugins/agent/scripts/lib/quota.mjs";

const bucket = (remainingFraction, resetTime = null) => ({ id: null, name: "limit", window: null, remainingFraction, resetTime });
const agyUsage = (groups) => ({ schema: 1, provider: "agy", groups });

test("an Antigravity model id finds its usage group by its base name", () => {
  const usage = agyUsage([
    { name: "Gemini Models", description: "Models within this group: Gemini 4 Neon, Gemini 3.8 Flash", defaultDelegation: false, buckets: [bucket(0, "2026-12-01T09:00:00Z"), bucket(0.4)] },
    { name: "Claude Models", description: "Models within this group: Claude Opus 5.5", defaultDelegation: false, buckets: [bucket(1)] }
  ]);
  assert.deepEqual(quotaReached("agy", usage, { model: "gemini-4-neon-medium" }), { reached: true, resetsAt: "2026-12-01T09:00:00Z" });
  // Another group's model is not affected by that empty bucket.
  assert.deepEqual(quotaReached("agy", usage, { model: "claude-opus-5.5" }), { reached: false, resetsAt: null });
  // The most exact name decides: a group that only shares the base name is not counted when the
  // id itself names a group.
  const exact = agyUsage([
    { name: "fake-model-high", description: "", defaultDelegation: false, buckets: [bucket(0.5)] },
    { name: "Fake Model Pro", description: "Models within this group: Fake Model Pro", defaultDelegation: false, buckets: [bucket(0)] }
  ]);
  assert.equal(quotaReached("agy", exact, { model: "fake-model-high" }).reached, false);
  // A model the report does not name gives no evidence.
  assert.equal(quotaReached("agy", usage, { model: "something-else" }).reached, false);
});

test("a job on the default model uses the default delegation group, and the earliest reset is named", () => {
  const usage = agyUsage([
    { name: "A", description: "", defaultDelegation: true, buckets: [bucket(0, "2026-12-03T00:00:00Z"), bucket(0, "2026-12-02T00:00:00Z")] },
    { name: "B", description: "", defaultDelegation: false, buckets: [bucket(1)] }
  ]);
  assert.deepEqual(quotaReached("agy", { raw: usage, normalized: usage }, {}), { reached: true, resetsAt: "2026-12-02T00:00:00Z" });
});

test("a Codex rate-limit reply counts when a limit is reached, raw or normalised", () => {
  assert.equal(quotaReached("codex", { raw: { rateLimits: { rateLimitReachedType: "primary" } }, normalized: null }).reached, true);
  assert.equal(quotaReached("codex", { raw: { rateLimits: { rateLimitReachedType: null } }, normalized: { groups: [{ buckets: [bucket(0.5)] }] } }).reached, false);
  assert.deepEqual(quotaReached("codex", { raw: {}, normalized: { groups: [{ buckets: [bucket(0, "2026-12-05T10:00:00Z")] }] } }), { reached: true, resetsAt: "2026-12-05T10:00:00Z" });
  // The normalised object alone is read the same way.
  assert.equal(quotaReached("codex", { groups: [{ buckets: [bucket(0)] }] }).reached, true);
});

test("no usage read, or a failed one, is no evidence", () => {
  assert.deepEqual(quotaReached("agy", null, { model: "m" }), { reached: false, resetsAt: null });
  assert.deepEqual(quotaReached("codex", { error: "agy printed no quota report" }), { reached: false, resetsAt: null });
});

test("the sentence names the provider and the reset time when there is one", () => {
  assert.equal(quotaSentence("Antigravity", { resetsAt: "2026-12-01T09:00:00Z" }), "Antigravity reports that its quota is used up. It resets at 2026-12-01T09:00:00Z.");
  assert.equal(quotaSentence("Codex", {}), "Codex reports that its quota is used up.");
});

test("only a failure the provider may have caused leads to a usage read", () => {
  for (const error of ["agy ended the turn with status ERROR.", "agy exited with code 1 before the turn finished.\nRESOURCE_EXHAUSTED (code 429)", "You've hit your usage limit. Try again later.", "insufficient_quota"]) {
    assert.equal(mayBeQuotaFailure(error, "agy"), true, error);
  }
  for (const error of [
    "Antigravity was denied permission for command (Bash).",
    // A refusal quotes a path or a command; such text is never searched for quota words.
    "Antigravity was denied permission for read_file on reports/rate limit 429.txt.",
    "exit status 429 in step 3",
    "Antigravity ended the turn without an answer.",
    "the turn failed",
    ""
  ]) {
    assert.equal(mayBeQuotaFailure(error, "agy"), false, error);
  }
});

test("the note is the sentence when the usage read shows a reached limit, and nothing otherwise", async () => {
  const empty = agyUsage([{ name: "Fake Group", description: "Models within this group: Fake Model", defaultDelegation: false, buckets: [bucket(0, "2026-12-01T09:00:00Z")] }]);
  const full = agyUsage([{ name: "Fake Group", description: "Models within this group: Fake Model", defaultDelegation: false, buckets: [bucket(0.3)] }]);
  const job = { provider: "agy", model: "fake-model-high", error: "agy ended the turn with status ERROR.", cwd: "." };
  const calls = [];
  const reading = (usage) => async (provider, options) => {
    calls.push([provider, options.timeoutMs]);
    return usage;
  };

  assert.equal(await quotaNoteFor({ ...job, readUsage: reading({ raw: empty, normalized: empty }) }), "Antigravity reports that its quota is used up. It resets at 2026-12-01T09:00:00Z.");
  assert.equal(await quotaNoteFor({ ...job, readUsage: reading({ raw: full, normalized: full }) }), null);
  assert.equal(await quotaNoteFor({ ...job, readUsage: reading(null) }), null);
  assert.deepEqual(calls, [["agy", 10000], ["agy", 10000], ["agy", 10000]]);

  // A failure of the plugin's own making reads nothing.
  calls.length = 0;
  assert.equal(await quotaNoteFor({ ...job, error: "Antigravity was denied permission for command (Bash).", readUsage: reading({ raw: empty, normalized: empty }) }), null);
  assert.deepEqual(calls, []);
});

test("a usage read that throws or never answers leaves the error as it is, within the time limit", async () => {
  const job = { provider: "agy", model: "fake-model-high", error: "agy ended the turn with status ERROR.", cwd: "." };
  assert.equal(
    await quotaNoteFor({
      ...job,
      readUsage: async () => {
        throw new Error("spawn failed");
      }
    }),
    null
  );
  const started = Date.now();
  assert.equal(await quotaNoteFor({ ...job, timeoutMs: 200, readUsage: () => new Promise(() => {}) }), null);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});

test("only a failed job is asked about when a command shows it", async () => {
  const empty = agyUsage([{ name: "Fake Group", description: "Models within this group: Fake Model", defaultDelegation: false, buckets: [bucket(0)] }]);
  let reads = 0;
  const readUsage = async () => {
    reads += 1;
    return { raw: empty, normalized: empty };
  };
  const row = { model: "fake-model-high", error: "agy ended the turn with status ERROR.", cwd: "." };
  assert.equal(await quotaNoteForView({ state: "failed", provider: "agy", row }, { readUsage }), "Antigravity reports that its quota is used up.");
  assert.equal(await quotaNoteForView({ state: "completed", provider: "agy", row }, { readUsage }), null);
  assert.equal(await quotaNoteForView(null, { readUsage }), null);
  assert.equal(reads, 1);
});
