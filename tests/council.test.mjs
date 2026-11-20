import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildBundles, resolveRef, scrubIdentity } from "../plugins/agent/scripts/lib/council/anonymise.mjs";
import {
  DEFAULT_LENSES,
  FAMILIES,
  familyProvider,
  planSeats,
  renderRepairPrompt,
  renderRetryPrompt,
  renderRound1Prompt,
  renderRound2Prompt
} from "../plugins/agent/scripts/lib/council/prompts.mjs";
import { classifyFailure, classifyJob, validateAnswer } from "../plugins/agent/scripts/lib/council/validate.mjs";
import { installObject, publishExport } from "../plugins/agent/scripts/lib/council/objects.mjs";
import { CouncilFenceError, createCouncilRun, readCouncil, recordMerge, recordReport } from "../plugins/agent/scripts/lib/council/state.mjs";
import { createJob, resolveStateDir } from "../plugins/agent/scripts/lib/state.mjs";
import { openStore } from "../plugins/agent/scripts/lib/store.mjs";
import { buildSeatJob } from "../plugins/agent/scripts/lib/council/jobs.mjs";
import {
  advance,
  confidenceLine,
  dispatchAttempt,
  handleCouncil,
  mergeInput,
  nextAction,
  roundSchemaPath,
  unknownRunMessage
} from "../plugins/agent/scripts/commands/council.mjs";
import { installFakeAgy } from "./fake-agy-fixture.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir, run as runCommand, stopOwnedProcess, waitUntil } from "./helpers.mjs";
import {
  EPOCH,
  bindAttempt,
  closeRound1ByReduce,
  councilSnapshot,
  observe,
  openCouncilStore,
  receive,
  reduce,
  seatDefinitions,
  seatJobFields,
  seedRound2,
  seedRun,
  setJob,
  sql,
  useTestClock
} from "./council-helpers.mjs";

const SCHEMA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "agent", "schemas");
const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "agent", "scripts");

function finding(id, overrides = {}) {
  return {
    id,
    severity: "P2",
    claim: `${id} claim`,
    path: "src/a.mjs",
    line: 1,
    evidence: `${id} evidence`,
    ...overrides
  };
}

function round1Answer(overrides = {}) {
  return {
    schema: 1,
    stance: null,
    confidence: "high",
    dealbreaker: null,
    findings: [finding("f1")],
    assumptions: [],
    wouldChangeMind: "a failing test",
    ...overrides
  };
}

function response(ref, overrides = {}) {
  return { finding: ref, response: "skip", disputes: null, sameAs: null, reason: null, evidence: null, ...overrides };
}

function round2Answer(responses, overrides = {}) {
  return { schema: 1, stance: null, responses, added: [], ...overrides };
}

const ROUND1_CONTEXT = { kind: "review", options: [] };
const ROUND2_CONTEXT = { kind: "review", options: [], bundleRefs: ["A-f1", "B-f2"], ownFindingIds: ["f1", "f2"] };

function assertRefused(result, field) {
  assert.equal(result.ok, false, `expected a refusal naming ${field}`);
  assert.ok(
    result.errors.some((error) => error.includes(field)),
    `no error names ${field}: ${JSON.stringify(result.errors)}`
  );
}

test("a validate with a reason is accepted, a challenge needs a known dispute, and no seat schema has a null enum value", () => {
  assert.deepEqual(
    validateAnswer(
      2,
      round2Answer([
        response("A-f1", { response: "validate", sameAs: "f1", reason: "matches my f1", evidence: "src/a.mjs:1" }),
        response("B-f2", { reason: "outside my lens" })
      ]),
      ROUND2_CONTEXT
    ),
    { ok: true, errors: [] }
  );
  const challenge = (disputes) => response("A-f1", { response: "challenge", disputes, reason: "r", evidence: "e" });
  assert.equal(validateAnswer(2, round2Answer([challenge("severity"), response("B-f2")]), ROUND2_CONTEXT).ok, true);
  assertRefused(validateAnswer(2, round2Answer([challenge("wording"), response("B-f2")]), ROUND2_CONTEXT), "disputes");
  assertRefused(
    validateAnswer(2, round2Answer([response("A-f1", { response: "validate", disputes: "claim" }), response("B-f2")]), ROUND2_CONTEXT),
    "disputes"
  );

  // Antigravity ends the turn with an error for an output schema whose enum holds null.
  const enums = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      if (Array.isArray(node.enum)) {
        enums.push(node.enum);
      }
      Object.values(node).forEach(walk);
    }
  };
  for (const name of ["council-round1.schema.json", "council-round2.schema.json"]) {
    walk(JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), "utf8")));
  }
  assert.ok(enums.length > 0);
  assert.deepEqual(enums.filter((values) => values.includes(null)), []);
});

test("council answers are checked against the round schema and the round 2 rules", () => {
  assert.deepEqual(validateAnswer(1, round1Answer(), ROUND1_CONTEXT), { ok: true, errors: [] });
  assert.deepEqual(
    validateAnswer(2, round2Answer([response("A-f1"), response("B-f2")]), ROUND2_CONTEXT),
    { ok: true, errors: [] }
  );

  assertRefused(validateAnswer(1, round1Answer({ findings: [finding("f1", { severity: "P0" })] }), ROUND1_CONTEXT), "severity");
  assertRefused(validateAnswer(1, round1Answer({ extra: true }), ROUND1_CONTEXT), "extra");
  const noEvidence = finding("f1");
  delete noEvidence.evidence;
  assertRefused(validateAnswer(1, round1Answer({ findings: [noEvidence] }), ROUND1_CONTEXT), "evidence");
  assertRefused(validateAnswer(1, round1Answer({ findings: [finding("codex-1")] }), ROUND1_CONTEXT), "id");
  assertRefused(validateAnswer(1, round1Answer({ findings: [finding("f1"), finding("f1")] }), ROUND1_CONTEXT), "id");

  assertRefused(
    validateAnswer(
      2,
      round2Answer([
        response("A-f1", { response: "challenge", disputes: "claim", evidence: "src/a.mjs:1" }),
        response("B-f2")
      ]),
      ROUND2_CONTEXT
    ),
    "reason"
  );
  assertRefused(
    validateAnswer(2, round2Answer([response("A-f1", { sameAs: "f1" }), response("B-f2")]), ROUND2_CONTEXT),
    "sameAs"
  );
  assertRefused(
    validateAnswer(
      2,
      round2Answer([response("A-f1", { response: "validate", sameAs: "f9" }), response("B-f2")]),
      ROUND2_CONTEXT
    ),
    "sameAs"
  );
  assertRefused(validateAnswer(2, round2Answer([response("A-f1")]), ROUND2_CONTEXT), "B-f2");
  assertRefused(
    validateAnswer(2, round2Answer([response("A-f1"), response("B-f2"), response("C-f1")]), ROUND2_CONTEXT),
    "C-f1"
  );
  assertRefused(
    validateAnswer(2, round2Answer([response("A-f1"), response("B-f2")], { added: [finding("f2")] }), ROUND2_CONTEXT),
    "added"
  );

  const decision = { kind: "decision", options: ["option-a", "option-b"] };
  assert.equal(validateAnswer(1, round1Answer({ stance: "option-a" }), decision).ok, true);
  assertRefused(validateAnswer(1, round1Answer({ stance: "option-c" }), decision), "stance");
  assertRefused(validateAnswer(1, round1Answer({ stance: null }), decision), "stance");
});

const FAMILY_CYCLE = ["claude", "codex", "agy", "codex", "agy"];

function bundleFixture(count) {
  const seats = [];
  const answers = {};
  for (let index = 0; index < count; index += 1) {
    const seat = `s${index + 1}`;
    seats.push({ seat, family: FAMILY_CYCLE[index] });
    answers[seat] = round1Answer({
      findings: [finding("f1", { claim: `claim one of ${index}` }), finding("f2", { claim: `claim two of ${index}` })]
    });
  }
  return { seats, answers };
}

const RANDOM_SEQUENCES = {
  zero: () => () => 0,
  highest: () => (max) => max - 1,
  lcg: () => {
    let state = 12345;
    return (max) => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state % max;
    };
  },
  alternating: () => {
    let flip = 0;
    return (max) => {
      flip = 1 - flip;
      return flip === 1 ? 0 : max - 1;
    };
  }
};

function mapsDiffer(mapping) {
  const recipients = Object.keys(mapping);
  const letterOf = (recipient, author) =>
    Object.keys(mapping[recipient]).find((letter) => mapping[recipient][letter] === author);
  for (const x of recipients) {
    for (const y of recipients) {
      if (x >= y) {
        continue;
      }
      for (const author of recipients) {
        if (author !== x && author !== y && letterOf(x, author) !== letterOf(y, author)) {
          return true;
        }
      }
    }
  }
  return false;
}

test("bundles hide authors, differ per seat and map back", () => {
  for (const count of [3, 4, 5]) {
    for (const [name, makeRandom] of Object.entries(RANDOM_SEQUENCES)) {
      const { seats, answers } = bundleFixture(count);
      const { bundles, mapping } = buildBundles(seats, answers, { random: makeRandom() });
      assert.deepEqual(Object.keys(bundles).sort(), seats.map(({ seat }) => seat).sort());
      for (const { seat } of seats) {
        const entries = bundles[seat];
        assert.equal(entries.length, (count - 1) * 2, `${count} seats, ${name}, ${seat}`);
        const letters = Object.keys(mapping[seat]);
        assert.deepEqual(letters, ["A", "B", "C", "D"].slice(0, count - 1));
        assert.ok(!Object.values(mapping[seat]).includes(seat), "a seat is lettered in its own map");
        assert.deepEqual(
          entries.map((entry) => entry.ref),
          letters.flatMap((letter) => [`${letter}-f1`, `${letter}-f2`])
        );
        for (const entry of entries) {
          assert.deepEqual(Object.keys(entry), ["ref", "severity", "claim", "path", "line", "evidence"]);
          const resolved = resolveRef(mapping, seat, entry.ref);
          assert.match(resolved, /^s[1-5]-f[12]$/);
          const [author, id] = resolved.split("-");
          assert.notEqual(author, seat, "a bundle holds its own seat's finding");
          assert.equal(entry.claim, answers[author].findings.find((item) => item.id === id).claim);
        }
      }
      assert.ok(mapsDiffer(mapping), `${count} seats, ${name}: no pair of recipients differs`);
    }
  }
  const { seats, answers } = bundleFixture(3);
  const { bundles } = buildBundles(seats, answers);
  assert.equal(bundles.s1.length, 4);
  assert.equal(resolveRef({ s1: { A: "s2" } }, "s1", "B-f1"), null);
  assert.equal(resolveRef({ s1: { A: "s2" } }, "s1", "nonsense"), null);
  assert.equal(resolveRef({ s1: { A: "s2" } }, "s1", "A-f7"), "s2-f7");

  const missing = buildBundles(seats, { s1: answers.s1, s2: answers.s2 }, { random: () => 0 });
  assert.deepEqual(Object.keys(missing.bundles).sort(), ["s1", "s2"]);
  assert.deepEqual(missing.mapping, { s1: { A: "s2" }, s2: { A: "s1" } });
});

test("self-identifying text is scrubbed", () => {
  const seats = [
    { seat: "s1", family: "claude", label: "run-1-s1", model: "opus" },
    { seat: "s2", family: "codex", label: "run-1-s2", model: "gpt-6.1-sol" },
    { seat: "s3", family: "agy", label: "run-1-s3", model: "gemini-3-pro" }
  ];
  const answers = {
    s1: round1Answer({ findings: [finding("f1")] }),
    s2: round1Answer({
      findings: [
        finding("f1", {
          claim: "As Codex (gpt-6.1-sol, seat s2, label run-1-s2) I found it",
          evidence: "CODEX says so in run run-1",
          path: "src/codex/s2.mjs"
        })
      ]
    }),
    s3: round1Answer({ findings: [finding("f1", { claim: "Antigravity here" })] })
  };
  const { bundles } = buildBundles(seats, answers, { random: () => 0, runId: "run-1" });
  for (const recipient of ["s1", "s3"]) {
    const text = JSON.stringify(bundles[recipient]);
    for (const word of ["codex", "gpt-6.1-sol", "s2", "run-1-s2", "run-1"]) {
      assert.doesNotMatch(text, new RegExp(`(?<![A-Za-z0-9_])${word.replace(/[.-]/g, "\\$&")}(?![A-Za-z0-9_])`, "i"), `${recipient}: ${word}`);
    }
    assert.match(text, /\[member\]/);
  }
  assert.doesNotMatch(JSON.stringify(bundles.s1), /antigravity/i);
  assert.equal(answers.s2.findings[0].claim, "As Codex (gpt-6.1-sol, seat s2, label run-1-s2) I found it");
  assert.equal(scrubIdentity("Codex and codexes, s2 and s21", ["codex", "s2"]), "[member] and codexes, [member] and s21");
  assert.equal(scrubIdentity(null, ["codex"]), null);
});

const IDENTITY_WORDS = /\b(s[1-5]|claude|codex|agy|antigravity|gpt-|gemini|opus|sonnet)\b/i;
const SECOND_CLAUDE = "A fourth or fifth seat goes to Codex or Antigravity before a second Claude seat.";

test("default seats, lens rules and prompt texts", () => {
  assert.deepEqual(FAMILIES, ["claude", "codex", "agy"]);
  assert.equal(familyProvider("claude"), null);
  assert.equal(familyProvider("codex"), "codex");
  assert.equal(familyProvider("agy"), "agy");
  assert.equal(familyProvider("other"), null);

  assert.deepEqual(planSeats({ kind: "review" }), [
    { seat: "s1", family: "claude", lens: "correctness" },
    { seat: "s2", family: "codex", lens: "security" },
    { seat: "s3", family: "agy", lens: "maintainability" }
  ]);
  assert.deepEqual(planSeats({ kind: "decision", seatSpecs: [] }), [
    { seat: "s1", family: "claude", lens: DEFAULT_LENSES.decision[0] },
    { seat: "s2", family: "codex", lens: DEFAULT_LENSES.decision[1] },
    { seat: "s3", family: "agy", lens: DEFAULT_LENSES.decision[2] }
  ]);
  assert.deepEqual(DEFAULT_LENSES.decision, ["what could fail", "first principles", "cost of carrying it out"]);

  assert.throws(
    () => planSeats({ kind: "review", seatSpecs: ["claude:a", "codex:b", "agy:c", "codex:d", "agy:e", "codex:f"] }),
    { message: "A council has at most 5 seats." }
  );
  assert.throws(() => planSeats({ kind: "review", seatSpecs: ["codex:x", "codex:x"] }), {
    message: "Seat codex:x is given twice."
  });
  assert.throws(() => planSeats({ kind: "review", seatSpecs: ["claude:a", "codex:b", "claude:c"] }), {
    message: SECOND_CLAUDE
  });
  assert.throws(() => planSeats({ kind: "review", seatSpecs: ["mystery:a"] }), {
    message: 'Unknown seat family "mystery". Families: claude, codex, agy.'
  });
  assert.throws(() => planSeats({ kind: "review", seatSpecs: ["codex"] }), {
    message: 'Seat "codex" must be <family>:<lens>.'
  });
  assert.deepEqual(planSeats({ kind: "review", seatSpecs: ["claude:a", "codex:b", "agy:c", "codex:d", "agy:e"] }), [
    { seat: "s1", family: "claude", lens: "a" },
    { seat: "s2", family: "codex", lens: "b" },
    { seat: "s3", family: "agy", lens: "c" },
    { seat: "s4", family: "codex", lens: "d" },
    { seat: "s5", family: "agy", lens: "e" }
  ]);

  const brief = "Question: is the cache safe?\nTargets: src/cache.mjs\nClaims:\n- observed: the cache has no lock";
  const round1Schema = fs.readFileSync(path.join(SCHEMA_DIR, "council-round1.schema.json"), "utf8");
  const round2Schema = fs.readFileSync(path.join(SCHEMA_DIR, "council-round2.schema.json"), "utf8");
  const round1 = renderRound1Prompt({ brief, lens: "correctness", kind: "review", schemaText: round1Schema });
  assert.ok(round1.includes(brief));
  assert.ok(round1.includes("correctness"));
  assert.ok(round1.includes("Work read-only: do not create, edit or delete any file, and do not run commands that change anything."));
  assert.ok(round1.includes("Answer with one JSON object that matches this schema:"));
  assert.ok(round1.includes(round1Schema.trim()));

  const ownFindings = [finding("f1", { claim: "the cache has no lock" })];
  const bundle = [{ ref: "A-f1", severity: "P1", claim: "a race in the cache", path: "src/cache.mjs", line: 3, evidence: "line 3" }];
  const round2 = renderRound2Prompt({ brief, lens: "security", ownFindings, bundle, schemaText: round2Schema });
  assert.ok(round2.includes("Agreement is not required. If you agree with everything, say what all of the answers missed."));
  assert.ok(round2.includes("A-f1"));
  assert.ok(round2.includes("a race in the cache"));
  assert.ok(round2.includes("the cache has no lock"));
  assert.ok(round2.includes("Work read-only: do not create, edit or delete any file, and do not run commands that change anything."));
  for (const word of ["validate", "challenge", "skip", "sameAs", "claim", "severity", "fix"]) {
    assert.ok(round2.includes(word), word);
  }

  const repair = renderRepairPrompt({ basePrompt: round2, errors: ["responses: no response to A-f1"], schemaText: round2Schema });
  assert.ok(repair.startsWith(round2.trimEnd()));
  assert.ok(repair.includes("responses: no response to A-f1"));
  assert.ok(repair.includes('null means "not given"'));
  assert.ok(repair.includes(round2Schema.trim()));

  const issuedAt = Date.UTC(2026, 10, 19, 12, 0, 0);
  const retry = renderRetryPrompt({ round: 1, issuedAt, basePrompt: round1, reason: "the worker stopped responding" });
  const retryLines = retry.split("\n");
  assert.equal(retryLines[0], "Reissued at 2026-11-19T12:00:00.000Z; answer this prompt, not an earlier one.");
  assert.equal(retryLines[1], "Previous attempt: the worker stopped responding.");
  assert.ok(retry.includes(round1.trimEnd()));
  const plainRetry = renderRetryPrompt({ round: 2, issuedAt, basePrompt: round2 });
  assert.equal(plainRetry.split("\n")[0], "Reissued at 2026-11-19T12:00:00.000Z; answer this prompt, not an earlier one.");
  assert.ok(!plainRetry.includes("Previous attempt"));

  for (const [name, text] of Object.entries({ round1, round2, repair, retry, plainRetry })) {
    assert.doesNotMatch(text, IDENTITY_WORDS, name);
  }
});

// ---------------------------------------------------------------------------------------------
// The executor: classification, observation, dispatch and advance, on library fixtures.

const T_LONG = 100000;

function answerText(answer = round1Answer()) {
  return JSON.stringify(answer);
}

// A fake monotonic clock and wait clock: `sleep(ms)` records the delay and moves `now` on.
function fakeTime(start = Math.round(performance.now())) {
  const state = { now: start, sleeps: [] };
  return {
    state,
    now: () => state.now,
    sleep: (ms) => {
      state.sleeps.push(ms);
      state.now += ms;
      return new Promise((resolve) => setImmediate(resolve));
    }
  };
}

function advanceOptions(store, time, overrides = {}) {
  return {
    runId: "run-1",
    round: 1,
    layer: 0,
    deadline: time.now() + 120000,
    openStore: () => store,
    now: time.now,
    sleep: time.sleep,
    reconcile: async () => {},
    launch: async () => null,
    readRequester: async () => ({ sessionId: "session-1", leaderPid: null, leaderStartToken: null }),
    readUsage: async () => null,
    ...overrides
  };
}

function seatState(store, seat, round = 1) {
  const row = readCouncil(store, "run-1").seatRounds.find((entry) => entry.round === round && entry.seat === seat);
  return [row.state, row.reason];
}

// Seeds a three-seat run and binds s2 and s3 to jobs claimed at `at`.
async function boundRun(t, clock, { timeoutMs = T_LONG, at = 0 } = {}) {
  clock.set(at);
  const fixture = openCouncilStore(t);
  const { seats } = await seedRun(fixture.store, fixture.runDir, { timeoutMs });
  const ids = Object.fromEntries(seats.map((seat) => [seat.seat, seat.attemptId]));
  const job2 = bindAttempt(fixture.store, ids.s2, { provider: "codex" }).jobId;
  const job3 = bindAttempt(fixture.store, ids.s3, { provider: "agy" }).jobId;
  for (const jobId of [job2, job3]) {
    setJob(fixture.store, jobId, { claimed_at: EPOCH + at, started_at: EPOCH + at });
  }
  return { ...fixture, ids, job2, job3 };
}

function endJob(store, jobId, at, columns) {
  setJob(store, jobId, { end_at: EPOCH + at, exec_released_at: EPOCH + at, release_kind: "confirmed", ...columns });
}

// Closes Round 1 of "run-1" with quorum at 10, as closeRound1ByReduce does, with extra columns on
// s2's ended job.
async function closeRound1With(store, clock, job2Columns) {
  clock.set(10);
  const current = (seat) => readCouncil(store, "run-1").seatRounds.find((row) => row.round === 1 && row.seat === seat).current_id;
  const job2 = bindAttempt(store, current("s2"), { provider: "codex" }).jobId;
  const job3 = bindAttempt(store, current("s3"), { provider: "agy" }).jobId;
  const ended = { claimed_at: EPOCH + 10, started_at: EPOCH + 10, end_state: "completed", end_at: EPOCH + 10, exec_released_at: EPOCH + 10, release_kind: "confirmed" };
  setJob(store, job2, { ...ended, ...job2Columns });
  setJob(store, job3, ended);
  await receive(store, "run-1", "s1", current("s1"), { outcome: "valid", answerSha256: "1".repeat(64) });
  await observe(store, current("s2"), job2, { outcome: "valid", eventAt: EPOCH + 10, answerSha256: "2".repeat(64) });
  await observe(store, current("s3"), job3, { outcome: "valid", eventAt: EPOCH + 10, answerSha256: "3".repeat(64) });
  await reduce(store);
  return { job2, job3 };
}

function pick(cls) {
  return [cls.kind, cls.eventAt, cls.reason];
}

function dispatchDeps(snapshot, seat, overrides = {}) {
  return {
    run: snapshot.run,
    seat: snapshot.seats.find((row) => row.seat === seat),
    layer: 0,
    deadline: performance.now() + 10000,
    launch: async () => null,
    readRequester: async () => ({ sessionId: "session-1", leaderPid: null, leaderStartToken: null }),
    ...overrides
  };
}

test("the council's job fields equal the task command's", async (t) => {
  const binDir = makeTempDir(t);
  installFakeCodex(binDir);
  installFakeAgy(binDir);
  const home = makeTempDir(t);
  fs.mkdirSync(path.join(home, ".gemini", "antigravity-cli"), { recursive: true });
  fs.writeFileSync(path.join(home, ".gemini", "antigravity-cli", "settings.json"), JSON.stringify({ model: "Fake Model (High)" }));
  const cwd = makeTempDir(t);
  const noop = path.join(makeTempDir(t), "noop-worker.mjs");
  fs.writeFileSync(noop, "process.exit(0);\n");
  const env = { ...buildEnv(binDir), HOME: home, USERPROFILE: home, AGENT_PLUGIN_TEST_WORKER_ENTRY: noop };
  // The in-process build sees the same fakes, home folder and PATH as the task command.
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH, Path: process.env.Path };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PATH = env.PATH ?? env.Path;
  if (process.env.Path !== undefined) {
    process.env.Path = process.env.PATH;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });
  const runId = "run-1-00000000";
  const prompt = "Review the brief.\n";
  const store = openStore(resolveStateDir(cwd));
  t.after(() => store.close());
  const comparable = (row) => ({
    provider: row.provider,
    kind: row.kind,
    title: row.title,
    run_id: row.run_id,
    prompt: row.prompt,
    request: JSON.parse(row.request_json),
    cwd: row.cwd,
    model: row.model,
    allow_questions: row.allow_questions,
    foreground: row.foreground,
    session_id: row.session_id,
    thread_id: row.thread_id
  });
  for (const [family, script] of [
    ["codex", "codex-companion.mjs"],
    ["agy", "agy-companion.mjs"]
  ]) {
    const launched = runCommand(
      process.execPath,
      [path.join(SCRIPTS, script), "task", "--background", "--json", "--output-schema", roundSchemaPath(1), "--label", `task-${family}`, "--run-id", runId, prompt],
      { cwd, env, timeout: 60000 }
    );
    assert.equal(launched.status, 0, launched.stderr);
    const taskRow = store.read((db) => db.prepare("SELECT * FROM jobs WHERE id = ?").get(JSON.parse(launched.stdout).jobId));
    const built = await buildSeatJob({ family, prompt, schemaPath: roundSchemaPath(1), label: `seat-${family}`, runId, cwd, requester: { sessionId: null, leaderPid: null, leaderStartToken: null } });
    const { jobId } = createJob(store, built.fields, { label: built.label });
    const seatRow = store.read((db) => db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId));
    assert.deepEqual(comparable(seatRow), comparable(taskRow), family);
    assert.deepEqual([taskRow.label, seatRow.label], [`task-${family}`, `seat-${family}`]);
    assert.equal(comparable(seatRow).request.write, false);
    assert.equal(comparable(seatRow).request.sandbox, "read-only");
  }
});

test("classification follows the deposit timing and the reason table", () => {
  const T = 1000;
  const base = { created_at: 0, claimed_at: 10, end_at: 500, end_state: "completed", error: null, end_reason: null };
  assert.equal(classifyJob({ row: { ...base, end_state: null }, T }), null);
  assert.deepEqual(classifyJob({ row: null, T }), { kind: "missing", eventAt: null, reason: "job pruned or missing", timely: false, lateReason: null });
  assert.equal(classifyJob({ row: base, T }).kind, "completed");
  // A claim at Q = created_at + T is late; an end at P = claimed_at + T is late.
  assert.deepEqual(pick(classifyJob({ row: { ...base, claimed_at: 1000, end_at: 1001 }, T })), ["late", 1001, "queue deadline expired"]);
  assert.deepEqual(pick(classifyJob({ row: { ...base, end_at: 1010 }, T })), ["late", 1010, "execution deadline expired"]);
  assert.deepEqual(pick(classifyJob({ row: { ...base, end_at: 1009 }, T })), ["completed", 1009, null]);
  assert.deepEqual(pick(classifyJob({ row: { ...base, end_state: "waiting" }, T })), ["waiting", 500, "provider waiting"]);
  assert.deepEqual(pick(classifyJob({ row: { ...base, end_state: "cancelled" }, T })), ["cancelled", 500, "job cancelled"]);
  assert.equal(classifyJob({ row: { ...base, end_state: "failed" }, T }).kind, "failed");

  const missing = { ...base, end_state: "failed", error: "Antigravity returned no structured output." };
  const reached = { raw: { rateLimits: { limitId: "codex", rateLimitReachedType: "primary" } }, normalized: { groups: [] } };
  const emptyDefault = { normalized: { groups: [{ name: "Gemini 3 Pro", defaultDelegation: true, buckets: [{ remainingFraction: 0 }] }] } };
  const otherEmpty = { normalized: { groups: [{ name: "Claude Opus", defaultDelegation: false, buckets: [{ remainingFraction: 0 }] }] } };
  // Quota takes priority over the missing output; a failed read gives no quota evidence.
  assert.equal(classifyFailure({ family: "codex", usage: reached, row: missing }), "quota");
  assert.equal(classifyFailure({ family: "agy", usage: emptyDefault, row: missing }), "quota");
  assert.equal(classifyFailure({ family: "agy", model: "Gemini 3 Pro", usage: emptyDefault, row: missing }), "quota");
  assert.equal(classifyFailure({ family: "agy", usage: otherEmpty, row: missing }), "missing-output");
  assert.equal(classifyFailure({ family: "agy", usage: null, row: missing }), "missing-output");
  assert.equal(classifyFailure({ family: "codex", usage: null, row: { ...base, end_state: "interrupted", end_reason: "worker-dead" } }), "transient");
  assert.equal(classifyFailure({ family: "codex", usage: null, row: { ...base, end_state: "failed", error: "socket hang up" } }), "transient");
  assert.equal(classifyFailure({ family: "codex", usage: null, row: { ...base, end_state: "failed", error: "HTTP 503 from the API" } }), "transient");
  assert.equal(classifyFailure({ family: "codex", usage: null, row: { ...base, end_state: "failed", error: "permission denied" } }), "final");
});

test("usage is read for every failed provider turn", async (t) => {
  const clock = useTestClock(t, 0);
  const reached = { raw: { rateLimits: { limitId: "codex", rateLimitReachedType: "primary" } }, normalized: { groups: [] } };
  const notReached = { raw: { rateLimits: { limitId: "codex", rateLimitReachedType: null } }, normalized: { groups: [] } };
  const cases = [
    { name: "missing output with an applicable empty bucket", error: "codex returned no structured output", usage: reached, expect: ["quota-exhausted", "quota exhausted"] },
    { name: "transient failure with no reached limit", error: "socket hang up", usage: notReached, expect: ["error", "transient provider failure"] },
    { name: "denied permission", error: "permission denied", usage: notReached, expect: ["error", "provider failure"] },
    { name: "unreadable usage", error: "codex returned no structured output", usage: "throw", expect: ["invalid", "missing structured output"] },
    { name: "timed-out usage", error: "codex returned no structured output", usage: "hang", expect: ["invalid", "missing structured output"] }
  ];
  for (const entry of cases) {
    const { store, runDir, ids, job2, job3 } = await boundRun(t, clock);
    endJob(store, job2, 50, { end_state: "failed", error: entry.error });
    endJob(store, job3, 60, { end_state: "completed", result_json: answerText() });
    await receive(store, "run-1", "s1", ids.s1, { outcome: "valid", answerSha256: installObject(runDir("run-1"), answerText(), "json") });
    const calls = [];
    const readUsage = async (family, { timeoutMs }) => {
      calls.push([family, timeoutMs]);
      if (entry.usage === "throw") {
        throw new Error("usage could not be read");
      }
      if (entry.usage === "hang") {
        return new Promise(() => {});
      }
      return entry.usage;
    };
    const outcome = await advance(runDir("run-1"), advanceOptions(store, fakeTime(), { readUsage }));
    assert.equal(outcome.wake, "closed", entry.name);
    assert.deepEqual(seatState(store, "s2"), entry.expect, entry.name);
    assert.deepEqual(calls, [["codex", 30000]], entry.name);
    // With one seat lost to quota or failure the round still reaches quorum (s1 and s3).
    assert.equal(readCouncil(store, "run-1").rounds[0].quorum, 1, entry.name);
  }
});

test("pruned job rows through the real poll", async (t) => {
  const clock = useTestClock(t, 0);
  const { store, runDir, ids, job2, job3 } = await boundRun(t, clock);
  endJob(store, job3, 40, { end_state: "completed", result_json: answerText() });
  const firstPass = fakeTime();
  await advance(runDir("run-1"), advanceOptions(store, firstPass, { deadline: firstPass.now() + 1500 }));
  assert.deepEqual(seatState(store, "s3"), ["valid", null]);
  // The running seat's chain is deleted; the valid seat's chain is pruned afterwards.
  sql(store, ["DELETE FROM chains WHERE id = ?", job2], ["DELETE FROM chains WHERE id = ?", job3]);
  await receive(store, "run-1", "s1", ids.s1, { outcome: "valid", answerSha256: installObject(runDir("run-1"), answerText(), "json") });
  const outcome = await advance(runDir("run-1"), advanceOptions(store, fakeTime()));
  assert.equal(outcome.wake, "closed");
  assert.deepEqual(seatState(store, "s2"), ["error", "job pruned or missing"]);
  assert.deepEqual(seatState(store, "s3"), ["valid", null]);

  // An issuing continuation whose predecessor was pruned is refused and creates no chain.
  const second = openCouncilStore(t);
  clock.set(0);
  await seedRun(second.store, second.runDir, { runId: "run-1" });
  const { job2: pred2 } = await closeRound1ByReduce(second.store, "run-1", clock, { at: 10 });
  const answers = { s1: round1Answer(), s2: round1Answer(), s3: round1Answer() };
  await seedRound2(second.store, second.runDir, { answers });
  sql(second.store, ["DELETE FROM chains WHERE id = ?", pred2]);
  const chainsBefore = second.store.read((db) => db.prepare("SELECT count(*) AS n FROM chains").get().n);
  const snapshot = readCouncil(second.store, "run-1");
  const attempt = snapshot.attempts.find((row) => row.round === 2 && row.seat === "s2");
  const result = await dispatchAttempt(second.store, second.stateDir, second.runDir("run-1"), attempt, dispatchDeps(snapshot, "s2"));
  assert.equal(result.dispatched, false);
  assert.equal(readCouncil(second.store, "run-1").attempts.find((row) => row.id === attempt.id).refusal, "predecessor missing");
  assert.equal(second.store.read((db) => db.prepare("SELECT count(*) AS n FROM chains").get().n), chainsBefore);
});

test("advance wakes at the nearest remaining delay on each deadline's own clock", async (t) => {
  const clock = useTestClock(t, 0);
  const { store, runDir, job2, job3 } = await boundRun(t, clock, { timeoutMs: 1000, at: 10 });
  // s3's job is past its execution limit at wall 1010 (claim 10 + T); s2's job was claimed at 900.
  setJob(store, job2, { claimed_at: EPOCH + 900, started_at: EPOCH + 900 });
  clock.set(1010);
  await reduce(store);
  assert.equal(readCouncil(store, "run-1").stops.find((row) => row.job_id === job3).cause, "deadline");
  // The stop's last E18 attempt completed at monotonic stamp M; at M+4,999 it is not due.
  const M = Math.round(performance.now()) + 50000;
  const stamps = new Map([[job3, M]]);
  const time = fakeTime(M + 4999);
  const requests = [];
  const requestStopFake = (_store, selector) => {
    requests.push([time.now(), selector.jobIds]);
    return { selection: [] };
  };
  const outcome = await advance(runDir("run-1"), advanceOptions(store, time, { stamps, requestStop: requestStopFake, deadline: M + 4999 + 2 }));
  assert.deepEqual(time.state.sleeps, [1]);
  assert.deepEqual(requests, [[M + 5000, [job3]]]);
  // The reducer's tagged delay is passed through unchanged: s2's execution limit on the wall axis.
  assert.deepEqual(outcome.nextDue, { delayMs: 890, axis: "wall", source: "s2:execution" });
  assert.equal(outcome.wake, "budget");
  // The empty selection of an eligible live job is a store error, and the stop stays pending.
  assert.deepEqual(outcome.errors.map((error) => error.error), ["store-error"]);
  assert.equal(readCouncil(store, "run-1").stops.find((row) => row.job_id === job3).acknowledged_at, null);
});

test("a usage read in flight does not delay another seat's deadline or stop", async (t) => {
  const clock = useTestClock(t, 0);
  // (1) One collector: s2 failed and its usage read is held; s3 passes its execution limit.
  {
    const { store, runDir, ids, job2, job3 } = await boundRun(t, clock, { timeoutMs: 1000, at: 10 });
    await receive(store, "run-1", "s1", ids.s1, { outcome: "valid", answerSha256: installObject(runDir("run-1"), answerText(), "json") });
    endJob(store, job2, 20, { end_state: "failed", error: "codex returned no structured output" });
    clock.set(1010);
    const requests = [];
    const requestStopFake = (_store, selector) => {
      requests.push(selector.jobIds[0]);
      return { selection: [{ jobId: selector.jobIds[0] }] };
    };
    const heldTime = fakeTime();
    const held = await advance(
      runDir("run-1"),
      advanceOptions(store, heldTime, { readUsage: () => new Promise(() => {}), requestStop: requestStopFake, deadline: heldTime.now() + 5000 })
    );
    assert.equal(held.wake, "budget");
    assert.deepEqual(seatState(store, "s2"), ["running", null]);
    assert.deepEqual(requests, [job3]);
    assert.notEqual(readCouncil(store, "run-1").stops.find((row) => row.job_id === job3).dispatched_at, null);
    // After the 30,000 ms cap the read ends with no quota evidence and the job is classified.
    const cappedTime = fakeTime();
    await advance(
      runDir("run-1"),
      advanceOptions(store, cappedTime, { readUsage: () => new Promise(() => {}), requestStop: requestStopFake, deadline: cappedTime.now() + 40000 })
    );
    assert.deepEqual(seatState(store, "s2"), ["invalid", "missing structured output"]);
  }
  // (2) Two collectors: A holds its read of J; B answers its own, deposits, and the round closes.
  {
    const { store, runDir, ids, job2, job3 } = await boundRun(t, clock, { at: 0 });
    clock.set(30);
    await receive(store, "run-1", "s1", ids.s1, { outcome: "valid", answerSha256: installObject(runDir("run-1"), answerText(), "json") });
    endJob(store, job2, 20, { end_state: "failed", error: "codex returned no structured output" });
    endJob(store, job3, 25, { end_state: "completed", result_json: answerText() });
    let releaseA;
    let startedA;
    const startedAPromise = new Promise((resolve) => {
      startedA = resolve;
    });
    const quota = { raw: { rateLimits: { limitId: "codex", rateLimitReachedType: "primary" } }, normalized: { groups: [] } };
    const readA = () => {
      startedA();
      return new Promise((resolve) => {
        releaseA = () => resolve(quota);
      });
    };
    const collectorA = advance(runDir("run-1"), advanceOptions(store, fakeTime(), { readUsage: readA }));
    await startedAPromise;
    const collectorB = await advance(runDir("run-1"), advanceOptions(store, fakeTime(), { readUsage: async () => null }));
    assert.equal(collectorB.wake, "closed");
    assert.equal((await collectorA).wake, "closed");
    const before = councilSnapshot(store);
    releaseA();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(councilSnapshot(store), before);
    assert.deepEqual(seatState(store, "s2"), ["invalid", "missing structured output"]);
  }
});

test("dispatchAttempt maps typed errors and reports a dropped label", async (t) => {
  const clock = useTestClock(t, 0);
  const answers = { s1: round1Answer(), s2: round1Answer(), s3: round1Answer() };
  async function round2(columns = {}) {
    const fixture = openCouncilStore(t);
    clock.set(0);
    await seedRun(fixture.store, fixture.runDir, { runId: "run-1", timeoutMs: T_LONG });
    const { job2 } = await closeRound1With(fixture.store, clock, { submit_intent_at: EPOCH + 10, ...columns });
    await seedRound2(fixture.store, fixture.runDir, { answers });
    const snapshot = readCouncil(fixture.store, "run-1");
    const attempt = snapshot.attempts.find((row) => row.round === 2 && row.seat === "s2");
    const refusal = () => readCouncil(fixture.store, "run-1").attempts.find((row) => row.id === attempt.id).refusal;
    return { ...fixture, job2, snapshot, attempt, refusal };
  }
  // A terminal predecessor with no thread is refused before E17, whatever E17 would say.
  {
    const { store, stateDir, runDir, snapshot, attempt, refusal } = await round2({ thread_id: null });
    const result = await dispatchAttempt(store, stateDir, runDir("run-1"), attempt, dispatchDeps(snapshot, "s2"));
    assert.equal(result.dispatched, false);
    assert.equal(refusal(), "predecessor has no thread");
  }
  // A threaded predecessor that E17 finds not resumable.
  {
    const { store, stateDir, runDir, snapshot, attempt, refusal } = await round2({ thread_id: "thread-2", ephemeral: 1 });
    await dispatchAttempt(store, stateDir, runDir("run-1"), attempt, dispatchDeps(snapshot, "s2"));
    assert.equal(refusal(), "predecessor not resumable");
  }
  // A failed predecessor needs force: one forced call wins and stores its ordered reasons.
  {
    const { store, stateDir, runDir, snapshot, attempt, job2 } = await round2({ thread_id: "thread-2", end_state: "failed" });
    const result = await dispatchAttempt(store, stateDir, runDir("run-1"), attempt, dispatchDeps(snapshot, "s2"));
    assert.equal(result.dispatched, true);
    const stored = readCouncil(store, "run-1").attempts.find((row) => row.id === attempt.id);
    assert.equal(stored.force_reason, JSON.stringify({ predecessorId: job2, reasons: ["failed-predecessor"] }));
  }
  // A forced call that still needs force is refused with the forced refusal of its first reason.
  {
    const { store, stateDir, runDir, snapshot, attempt, refusal } = await round2({ thread_id: "thread-2" });
    const calls = [];
    const decide = (_store, _target, options) => {
      calls.push(options.force);
      throw new CouncilFenceError("force-required", { reasons: ["provider-exit-unobserved", "failed-predecessor"] });
    };
    await dispatchAttempt(store, stateDir, runDir("run-1"), attempt, dispatchDeps(snapshot, "s2", { decideNext: decide }));
    assert.deepEqual(calls, [false, true]);
    assert.equal(refusal(), "thread barrier");
  }
  // A continuation whose label is held by another live chain drops it and reports it.
  {
    const { store, stateDir, runDir, snapshot, attempt } = await round2({ thread_id: "thread-2", label: "run-1-s2" });
    createJob(store, seatJobFields("codex"), { label: "run-1-s2" });
    const result = await dispatchAttempt(store, stateDir, runDir("run-1"), attempt, dispatchDeps(snapshot, "s2"));
    assert.equal(result.dispatched, true);
    assert.deepEqual(result.diagnostics, [{ seat: "s2", jobId: result.jobId, label: "run-1-s2" }]);
  }
});

// ---------------------------------------------------------------------------------------------
// The council subcommands: start, collect and submit.

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "council-child.mjs");
const PATH_SEP = process.platform === "win32" ? ";" : ":";

// A workspace folder whose state folder holds a migrated store, closed when the test ends.
function commandFixture(t) {
  const cwd = makeTempDir(t);
  const stateDir = resolveStateDir(cwd);
  const store = openStore(stateDir);
  t.after(() => store.close());
  return { cwd, stateDir, store, runDir: (runId) => path.join(stateDir, "council", runId) };
}

// Runs one council subcommand in this process; resolves to `{ code, stdout, stderr, json }`.
async function council(argv, { cwd, layer = 0, advance: advanceOverrides = {}, ...services }) {
  const out = [];
  const err = [];
  const io = { stdout: (text) => out.push(text), stderr: (text) => err.push(text) };
  const code = await handleCouncil([argv[0], "--cwd", cwd, ...argv.slice(1)], {
    layer,
    io,
    readRequester: async () => ({ sessionId: "session-1", leaderPid: null, leaderStartToken: null }),
    // No in-process command builds a real provider job: the default builder makes a plain job row.
    advance: {
      reconcile: async () => {},
      launch: async () => null,
      readUsage: async () => null,
      buildJob: async ({ family, label }) => ({ fields: seatJobFields(family === "codex" ? "codex" : "agy"), label }),
      ...advanceOverrides
    },
    ...services
  });
  const stdout = out.join("");
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = null;
  }
  return { code, stdout, stderr: err.join(""), json };
}

// A PATH of the folder of this Node and every PATH folder that holds none of `names`.
function pathWithout(names) {
  const kept = String(process.env.PATH ?? "")
    .split(PATH_SEP)
    .filter(Boolean)
    .filter((dir) => !names.some((name) => fs.existsSync(path.join(dir, name))));
  return [path.dirname(process.execPath), ...kept].join(PATH_SEP);
}

// Fake Codex and Antigravity, a worker entry that exits at once, and an env without the other CLI.
function fakeProviders(t, { codex = true, agy = true } = {}) {
  const binDir = makeTempDir(t);
  if (codex) {
    installFakeCodex(binDir);
  }
  if (agy) {
    installFakeAgy(binDir);
  }
  const home = makeTempDir(t);
  const noop = path.join(makeTempDir(t), "noop-worker.mjs");
  fs.writeFileSync(noop, "process.exit(0);\n");
  const hidden = [...(codex ? [] : ["codex", "codex.exe", "codex.cmd"]), ...(agy ? [] : ["agy", "agy.exe", "agy.cmd"])];
  return {
    ...buildEnv(binDir),
    HOME: home,
    USERPROFILE: home,
    PATH: `${binDir}${PATH_SEP}${pathWithout(hidden)}`,
    AGENT_PLUGIN_TEST_WORKER_ENTRY: noop
  };
}

function writeBrief(dir, brief = { question: "Is the cache correct?", targets: ["src"], kind: "review", claims: [{ text: "The cache is read-only.", status: "assumed" }] }) {
  const file = path.join(dir, "brief.json");
  fs.writeFileSync(file, JSON.stringify(brief));
  return file;
}

function childRun(args, { cwd, env, layer = 0 }) {
  return runCommand(process.execPath, [CHILD, String(layer), ...args], { cwd, env, timeout: 90000 });
}

function storeRows(cwd, sqlText) {
  const stateDir = resolveStateDir(cwd);
  if (!fs.existsSync(path.join(stateDir, "store"))) {
    return [];
  }
  const store = openStore(stateDir);
  try {
    return store.read((db) => db.prepare(sqlText).all());
  } finally {
    store.close();
  }
}

test("council start creates read-only seat jobs through attempts", async (t) => {
  const cwd = makeTempDir(t);
  const env = fakeProviders(t);
  const started = childRun(["start", "--brief", writeBrief(cwd), "--json"], { cwd, env });
  assert.equal(started.status, 0, started.stderr);
  const { runId } = JSON.parse(started.stdout);
  const jobs = storeRows(cwd, "SELECT * FROM jobs ORDER BY label");
  assert.deepEqual(jobs.map((row) => row.label), [`${runId}-s2`, `${runId}-s3`]);
  for (const row of jobs) {
    const request = JSON.parse(row.request_json);
    assert.equal(row.run_id, runId);
    assert.equal(request.write, false);
    assert.deepEqual(request.outputSchema, JSON.parse(fs.readFileSync(roundSchemaPath(1), "utf8")));
  }
  const seatRounds = storeRows(cwd, "SELECT * FROM council_seat_rounds ORDER BY seat");
  const attempts = storeRows(cwd, "SELECT * FROM council_attempts ORDER BY seat");
  assert.deepEqual(seatRounds.map((row) => row.state), ["running", "running", "running"]);
  assert.deepEqual(attempts.map((row) => [row.seat, row.kind, row.charge]), [["s1", "prompt", "turn"], ["s2", "create", "turn"], ["s3", "create", "turn"]]);
  assert.deepEqual(attempts.slice(1).map((row) => row.job_id).sort(), jobs.map((row) => row.id).sort());
  assert.equal(attempts[0].issued_at, attempts[0].created_at);
  assert.ok(attempts.slice(1).every((row) => row.issued_at !== null));
  assert.equal(fs.existsSync(path.join(cwd, ".git")), false);
  assert.equal(fs.existsSync(path.join(resolveStateDir(cwd), "runs")), false);
});

test("missing families", async (t) => {
  const cwd = makeTempDir(t);
  const started = childRun(["start", "--brief", writeBrief(cwd), "--json"], { cwd, env: fakeProviders(t, { agy: false }) });
  assert.equal(started.status, 0, started.stderr);
  const seatRounds = storeRows(cwd, "SELECT * FROM council_seat_rounds ORDER BY seat");
  assert.deepEqual(seatRounds[2].state, "missing-cli");
  assert.deepEqual(seatRounds[2].reason, "missing CLI");
  assert.equal(storeRows(cwd, "SELECT * FROM jobs").length, 1);

  const bare = makeTempDir(t);
  const refused = childRun(["start", "--brief", writeBrief(bare)], { cwd: bare, env: fakeProviders(t, { codex: false, agy: false }) });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /No quorum possible/);
  assert.deepEqual(storeRows(bare, "SELECT * FROM council_runs"), []);
  assert.equal(fs.existsSync(path.join(resolveStateDir(bare), "council")), false);

  const single = childRun(["start", "--brief", writeBrief(bare), "--seat", "codex:correctness"], { cwd: bare, env: fakeProviders(t) });
  assert.equal(single.status, 1);
  assert.match(single.stderr, /one seat can never reach a quorum/);
});

test("collect returns the stored close or a named wake", async (t) => {
  const clock = useTestClock(t, 0);
  // An unstarted round, and a closed round with quorum.
  {
    const { cwd, store, runDir } = commandFixture(t);
    await seedRun(store, runDir, { timeoutMs: T_LONG });
    const unstarted = await council(["collect", "run-1", "--round", "2"], { cwd });
    assert.deepEqual([unstarted.code, unstarted.stderr], [1, "Round 2 has not started.\n"]);
    const unknown = await council(["collect", "run-9", "--round", "1", "--json"], { cwd });
    assert.deepEqual([unknown.code, unknown.json.error], [1, "unknown-run"]);
    assert.equal(unknown.json.message, unknownRunMessage("run-9"));
    await closeRound1ByReduce(store, "run-1", clock, { at: 10 });
    const closed = await council(["collect", "run-1", "--round", "1"], { cwd });
    assert.deepEqual([closed.code, closed.stdout], [0, "Round 1 closed with quorum.\n"]);
    const closedJson = await council(["collect", "run-1", "--round", "1", "--json"], { cwd });
    assert.deepEqual(Object.keys(closedJson.json), [
      "runId", "round", "closedAt", "quorum", "validSeats", "validFamilies", "cleanupPending", "memberTurns", "repairs", "retries", "seats", "wake"
    ]);
    assert.deepEqual([closedJson.json.wake, closedJson.json.quorum, closedJson.json.validSeats, closedJson.json.memberTurns], ["closed", true, 3, 3]);
  }
  // A closed round without quorum, and a cleanup pass bounded by a 50 ms command budget.
  {
    clock.set(0);
    const { cwd, store, runDir, stateDir } = commandFixture(t);
    const { seats } = await seedRun(store, runDir, { timeoutMs: 1000 });
    const job2 = bindAttempt(store, seats[1].attemptId, { provider: "codex" }).jobId;
    setJob(store, job2, { claimed_at: EPOCH + 10, started_at: EPOCH + 10 });
    void stateDir;
    clock.set(1010);
    await reduce(store);
    // B6 recorded a stop for s2's job; the job then ends late with its execution unreleased, so the
    // stop stays selectable, and a fake E18 that never selects it keeps the stop pending.
    setJob(store, job2, { end_state: "completed", end_at: EPOCH + 1011, result_json: answerText() });
    const time = fakeTime();
    const closed = await council(["collect", "run-1", "--round", "1", "--budget-ms", "50", "--json"], {
      cwd,
      advance: { now: time.now, sleep: time.sleep, requestStop: () => ({ selection: [] }) }
    });
    assert.equal(closed.code, 1);
    assert.equal(closed.json.wake, "closed");
    assert.equal(closed.json.cleanupPending, true);
    assert.equal(closed.json.quorum, false);
    // The cleanup ended at the 50 ms command deadline, not after a fresh 30 seconds.
    assert.ok(time.state.sleeps.reduce((a, b) => a + b, 0) <= 50);
    const text = await council(["collect", "run-1", "--round", "1", "--budget-ms", "50"], {
      cwd,
      advance: { now: time.now, sleep: time.sleep, requestStop: () => ({ selection: [] }) }
    });
    assert.equal(text.stdout, "No quorum: 0 valid seats from 0 families. A council needs two valid seats from two families.\n");
  }
  // An open round wakes on its budget.
  {
    clock.set(0);
    const { cwd, store, runDir } = commandFixture(t);
    await seedRun(store, runDir, { timeoutMs: T_LONG });
    const time = fakeTime();
    const open = await council(["collect", "run-1", "--round", "1", "--budget-ms", "3000"], {
      cwd,
      advance: { now: time.now, sleep: time.sleep, buildJob: async () => ({ fields: seatJobFields("codex"), label: null }) }
    });
    assert.deepEqual([open.code, open.stdout], [0, "Wake: budget. Run council collect again.\n"]);
  }
});

test("collect returns the closed round with a usage read still held", async (t) => {
  const { cwd, store, runDir } = commandFixture(t);
  const { seats } = await seedRun(store, runDir, { timeoutMs: T_LONG });
  const job2 = bindAttempt(store, seats[1].attemptId, { provider: "codex" }).jobId;
  const job3 = bindAttempt(store, seats[2].attemptId, { provider: "agy" }).jobId;
  const now = Date.now();
  setJob(store, job2, { claimed_at: now, started_at: now });
  setJob(store, job3, { claimed_at: now, started_at: now });
  endJob(store, job2, now - EPOCH + 1, { end_state: "failed", error: "codex returned no structured output" });
  endJob(store, job3, now - EPOCH + 1, { end_state: "completed", result_json: answerText() });
  await receive(store, "run-1", "s1", seats[0].attemptId, { outcome: "valid", answerSha256: installObject(runDir("run-1"), answerText(), "json") });
  const files = makeTempDir(t);
  const [started, release, ack] = ["started", "release", "ack"].map((name) => path.join(files, name));
  const env = { ...process.env, COUNCIL_CHILD_USAGE: "hold", COUNCIL_CHILD_STARTED_FILE: started, COUNCIL_CHILD_RELEASE_FILE: release, COUNCIL_CHILD_ACK_FILE: ack };
  const collectorA = spawn(process.execPath, [CHILD, "0", "collect", "run-1", "--round", "1", "--json", "--cwd", cwd], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  t.after(() => stopOwnedProcess(collectorA));
  let outputA = "";
  collectorA.stdout.setEncoding("utf8").on("data", (chunk) => {
    outputA += chunk;
  });
  await waitUntil(() => fs.existsSync(started), { timeoutMs: 30000, describe: "collector A started its usage read" });
  const collectorB = childRun(["collect", "run-1", "--round", "1", "--json", "--cwd", cwd], { cwd, env: { ...process.env, COUNCIL_CHILD_USAGE: "answer" } });
  assert.equal(collectorB.status, 0, collectorB.stderr);
  assert.equal(JSON.parse(collectorB.stdout).wake, "closed");
  // A prints the closed result while its read is still held.
  await waitUntil(() => outputA.includes("\"wake\": \"closed\""), { timeoutMs: 30000, describe: "collector A printed the closed result" });
  const before = councilSnapshot(store);
  fs.writeFileSync(release, "go\n");
  await waitUntil(() => fs.existsSync(ack), { timeoutMs: 30000, describe: "collector A drained its read" });
  assert.deepEqual(councilSnapshot(store), before);
  assert.deepEqual(seatState(store, "s2"), ["invalid", "missing structured output"]);
  await stopOwnedProcess(collectorA);
});

test("submit decides the receipt and then reduces", async (t) => {
  const clock = useTestClock(t, 0);
  const { cwd, store, runDir } = commandFixture(t);
  const { seats } = await seedRun(store, runDir, { timeoutMs: 1000 });
  const reply = path.join(cwd, "reply.json");
  fs.writeFileSync(reply, answerText());
  const s1 = seats[0].attemptId;
  // At 500 with T=1000 a successful submit with no collector reaches B4 before printing.
  clock.set(500);
  const accepted = await council(["submit", "run-1", "s1", "--intent", s1, "--file", reply, "--json"], {
    cwd,
    advance: { buildJob: async () => ({ fields: seatJobFields("codex"), label: null }) }
  });
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.deepEqual(Object.keys(accepted.json), ["runId", "round", "seat", "intentId", "state", "deliveries"]);
  assert.deepEqual([accepted.json.round, accepted.json.state], [1, "valid"]);
  const duplicate = await council(["submit", "run-1", "s1", "--intent", s1, "--file", reply], { cwd });
  assert.deepEqual([duplicate.code, duplicate.stderr], [1, `A reply for intent ${s1} was already recorded.\n`]);
  const mismatched = await council(["submit", "run-1", "s2", "--intent", s1, "--file", reply], { cwd });
  assert.deepEqual([mismatched.code, mismatched.stderr], [1, `Intent ${s1} is not open for s2; nothing was recorded.\n`]);

  // An expired prompt writes no receipt, and the mandatory reduce expires the seat once.
  clock.set(0);
  const second = commandFixture(t);
  const { seats: seats2 } = await seedRun(second.store, second.runDir, { timeoutMs: 1000 });
  clock.set(1000);
  const expired = await council(["submit", "run-1", "s1", "--intent", seats2[0].attemptId, "--file", reply, "--json"], { cwd: second.cwd });
  assert.deepEqual([expired.code, expired.json.error], [1, "intent-not-open"]);
  assert.equal(readCouncil(second.store, "run-1").observations.length, 0);
  assert.deepEqual(seatState(second.store, "s1"), ["timed-out", "reply deadline expired"]);
  // Invalid input that was recorded is an accepted receipt.
  clock.set(0);
  const third = commandFixture(t);
  const { seats: seats3 } = await seedRun(third.store, third.runDir, { timeoutMs: 1000 });
  fs.writeFileSync(reply, JSON.stringify({ schema: 1 }));
  clock.set(100);
  const invalid = await council(["submit", "run-1", "s1", "--intent", seats3[0].attemptId, "--file", reply, "--json"], {
    cwd: third.cwd,
    advance: { buildJob: async () => ({ fields: seatJobFields("codex"), label: null }) }
  });
  assert.deepEqual([invalid.code, invalid.json.state], [0, "invalid"]);
  assert.deepEqual(seatState(third.store, "s1"), ["invalid", "schema validation failed"]);
});

test("a silent Claude seat with provider deadlines", async (t) => {
  const clock = useTestClock(t, 0);
  const { cwd, store, runDir } = commandFixture(t);
  await seedRun(store, runDir, { timeoutMs: 1000 });
  // The executor creates both provider jobs; each answers at once with a valid answer.
  const buildJob = async ({ family }) => ({ fields: seatJobFields(family === "codex" ? "codex" : "agy"), label: null });
  const launch = async (launchStore, _stateDir, jobId) => {
    setJob(launchStore, jobId, { claimed_at: EPOCH + 5, started_at: EPOCH + 5 });
    setJob(launchStore, jobId, { end_state: "completed", end_at: EPOCH + 6, exec_released_at: EPOCH + 6, release_kind: "confirmed", result_json: answerText() });
    return null;
  };
  const time = fakeTime();
  let passes = 0;
  const sleep = (ms) => {
    passes += 1;
    clock.set(Math.min(clock.now() + ms, 5000));
    return time.sleep(ms);
  };
  const result = await council(["collect", "run-1", "--round", "1", "--json"], { cwd, advance: { buildJob, launch, now: time.now, sleep } });
  assert.equal(result.json.wake, "closed");
  assert.deepEqual(seatState(store, "s1"), ["timed-out", "reply deadline expired"]);
  assert.deepEqual(seatState(store, "s2"), ["valid", null]);
  assert.deepEqual(seatState(store, "s3"), ["valid", null]);
  assert.equal(readCouncil(store, "run-1").seatRounds.find((row) => row.seat === "s1").final_at - EPOCH, 1000);
  assert.ok(passes > 0);
});

test("contention: unchanged passes make no write transaction", async (t) => {
  useTestClock(t, 0);
  const { stateDir, store, runDir } = commandFixture(t);
  const { seats } = await seedRun(store, runDir, { timeoutMs: T_LONG });
  const job2 = bindAttempt(store, seats[1].attemptId, { provider: "codex" }).jobId;
  const job3 = bindAttempt(store, seats[2].attemptId, { provider: "agy" }).jobId;
  for (const jobId of [job2, job3]) {
    setJob(store, jobId, { claimed_at: EPOCH, started_at: EPOCH });
  }
  await reduce(store);
  const other = openStore(stateDir);
  t.after(() => other.close());
  const version = () => other.read((db) => db.prepare("PRAGMA data_version").get().data_version);
  const before = version();
  const transact = t.mock.method(store, "transact");
  const time = fakeTime();
  const loops = await advance(runDir("run-1"), advanceOptions(store, time, { deadline: time.now() + 50 * 2000 }));
  assert.equal(loops.wake, "budget");
  assert.ok(time.state.sleeps.length >= 49);
  assert.equal(transact.mock.callCount(), 0);
  assert.equal(version(), before);
});

test("crash boundaries recover through the commands", async (t) => {
  const { cwd, store, runDir, stateDir } = commandFixture(t);
  const { seats } = await seedRun(store, runDir, { timeoutMs: 600000 });
  const reply = path.join(cwd, "reply.json");
  fs.writeFileSync(reply, answerText());
  const s1 = seats[0].attemptId;
  const pointsDir = makeTempDir(t);
  void stateDir;
  async function pausedSubmit(point) {
    const child = spawn(process.execPath, [CHILD, "0", "submit", "run-1", "s1", "--intent", s1, "--file", reply, "--cwd", cwd], {
      env: { ...process.env, AGENT_PLUGIN_TEST_POINTS: point, AGENT_PLUGIN_TEST_POINTS_DIR: pointsDir },
      stdio: "ignore",
      windowsHide: true
    });
    t.after(() => stopOwnedProcess(child));
    await waitUntil(() => fs.existsSync(path.join(pointsDir, `${point}-${child.pid}.reached`)), { timeoutMs: 30000, describe: `${point} reached` });
    await stopOwnedProcess(child);
  }
  // Stopped after validation and before the receipt: no receipt, and a replay is a first receipt.
  await pausedSubmit("council-after-reply-validation");
  assert.equal(readCouncil(store, "run-1").observations.length, 0);
  // Stopped after the deposit and before the reduce: the receipt is kept, the next command reduces
  // it, and a replay is a duplicate.
  await pausedSubmit("council-after-deposit");
  assert.equal(readCouncil(store, "run-1").observations.length, 1);
  assert.equal(seatState(store, "s1")[0], "running");
  const replay = await council(["submit", "run-1", "s1", "--intent", s1, "--file", reply], { cwd });
  assert.deepEqual([replay.code, replay.stderr], [1, `A reply for intent ${s1} was already recorded.\n`]);
  assert.deepEqual(seatState(store, "s1"), ["valid", null]);
});

// ---------------------------------------------------------------------------------------------
// Cross-examination.

const MODELS = { s1: "opus-x", s2: "gpt-x", s3: "gemini-x" };

function selfNamingAnswers() {
  const own = {
    s1: "As Claude (opus-x, seat s1) I found it",
    s2: "As Codex (gpt-x, seat s2, label run-1-s2) I found it",
    s3: "As Antigravity (gemini-x, seat s3, label run-1-s3) I found it"
  };
  return Object.fromEntries(
    Object.entries(own).map(([seat, claim]) => [seat, round1Answer({ findings: [finding("f1", { claim, evidence: `${claim} in src/a.mjs` }), finding("f2", { severity: "P1" })] })])
  );
}

/**
 * A command workspace with run "run-1" whose Round 1 closed at 10 with quorum: each seat's answer
 * from `answers` is installed and accepted, provider jobs completed with a thread (unless
 * `thread` is false) and released. Resolves to the fixture with `seats` and the provider `jobs`.
 */
async function quorateRound1(t, clock, { answers = selfNamingAnswers(), thread = true, jobColumns = {} } = {}) {
  const fixture = commandFixture(t);
  const { store, cwd } = fixture;
  const runDir = fixture.runDir("run-1");
  clock.set(0);
  const seats = seatDefinitions(runDir, { runId: "run-1" }).map((seat) => ({ ...seat, model: MODELS[seat.seat] }));
  const briefSha256 = installObject(runDir, "# Council brief\n\nQuestion:\nIs the cache correct?\n", "md");
  const created = await createCouncilRun(store, {
    runId: "run-1",
    kind: "review",
    sessionId: "session-1",
    cwd,
    briefSha256,
    options: [],
    timeoutMs: T_LONG,
    seats,
    layer: 0,
    deadline: performance.now() + 10000
  });
  assert.deepEqual(created, { ok: true });
  clock.set(10);
  const jobs = {};
  for (const seat of seats) {
    const answerSha256 = installObject(runDir, JSON.stringify(answers[seat.seat]), "json");
    if (seat.family === "claude") {
      await receive(store, "run-1", seat.seat, seat.attemptId, { outcome: "valid", answerSha256 });
      continue;
    }
    const jobId = bindAttempt(store, seat.attemptId, { provider: seat.provider }).jobId;
    setJob(store, jobId, {
      claimed_at: EPOCH + 10,
      started_at: EPOCH + 10,
      end_state: "completed",
      end_at: EPOCH + 10,
      exec_released_at: EPOCH + 10,
      release_kind: "confirmed",
      thread_id: thread === true || thread === seat.seat ? `thread-${seat.seat}` : null,
      ...(jobColumns[seat.seat] ?? {})
    });
    await observe(store, seat.attemptId, jobId, { outcome: "valid", eventAt: EPOCH + 10, answerSha256 });
    jobs[seat.seat] = jobId;
  }
  await reduce(store);
  return { ...fixture, seats, jobs };
}

const CROSSEXAM_SERVICES = { advance: { launch: async () => null } };

test("council crossexam hides authors and differs per seat", async (t) => {
  const clock = useTestClock(t, 0);
  const { cwd, store, runDir, jobs } = await quorateRound1(t, clock);
  const result = await council(["crossexam", "run-1", "--json"], { cwd, ...CROSSEXAM_SERVICES });
  assert.equal(result.code, 0, result.stderr);
  const snapshot = readCouncil(store, "run-1");
  const round2 = snapshot.rounds.find((row) => row.round === 2);
  const exported = fs.readFileSync(path.join(runDir("run-1"), "private", "anonymisation.json"));
  assert.equal(createHash("sha256").update(exported).digest("hex"), round2.map_sha256);
  const mapping = JSON.parse(exported);
  const identities = {
    s1: ["s1", "claude", "opus-x"],
    s2: ["s2", "run-1-s2", "codex", "Codex", "gpt-x"],
    s3: ["s3", "run-1-s3", "agy", "Antigravity", "gemini-x"]
  };
  const attempts = snapshot.attempts.filter((row) => row.round === 2);
  for (const attempt of attempts) {
    const prompt = fs.readFileSync(path.join(runDir("run-1"), "objects", `${attempt.prompt_sha256}.md`), "utf8");
    const bundleText = prompt.slice(prompt.indexOf("The other members' findings"));
    for (const [seat, words] of Object.entries(identities)) {
      if (seat === attempt.seat) {
        continue;
      }
      for (const word of words) {
        assert.doesNotMatch(bundleText, new RegExp(`(?<![A-Za-z0-9_-])${word}(?![A-Za-z0-9_])`, "i"), `${attempt.seat} prompt names ${word}`);
      }
    }
    // Every letter maps back to another seat; no bundle holds its own seat's findings.
    assert.deepEqual(Object.values(mapping[attempt.seat]).sort(), ["s1", "s2", "s3"].filter((seat) => seat !== attempt.seat));
  }
  const shared = ["s1", "s2", "s3"].some((author) => {
    const recipients = ["s1", "s2", "s3"].filter((seat) => seat !== author);
    const letterOf = (recipient) => Object.entries(mapping[recipient]).find(([, seat]) => seat === author)?.[0];
    return letterOf(recipients[0]) !== letterOf(recipients[1]);
  });
  assert.ok(shared, "at least two recipients differ on a shared author");
  // Each provider seat continues its accepted Round 1 job with the Round 2 schema, issued once.
  const round2Schema = JSON.parse(fs.readFileSync(roundSchemaPath(2), "utf8"));
  for (const seat of ["s2", "s3"]) {
    const attempt = attempts.find((row) => row.seat === seat);
    assert.equal(attempt.kind, "continue");
    assert.equal(attempt.predecessor_id, jobs[seat]);
    assert.notEqual(attempt.issued_at, null);
    const successor = store.read((db) => db.prepare("SELECT * FROM jobs WHERE continues = ?").all(jobs[seat]));
    assert.equal(successor.length, 1);
    assert.equal(successor[0].id, attempt.job_id);
    assert.deepEqual(JSON.parse(successor[0].request_json).outputSchema, round2Schema);
  }
  assert.equal(snapshot.charges.rounds[2].turn, 3);
  assert.deepEqual(result.json.deliveries.map((delivery) => delivery.seat), ["s1"]);
});

test("crossexam needs a closed round 1 with a quorum, and runs once", async (t) => {
  const clock = useTestClock(t, 0);
  {
    const { cwd, store, runDir } = commandFixture(t);
    await seedRun(store, runDir, { timeoutMs: T_LONG });
    const open = await council(["crossexam", "run-1", "--json"], { cwd });
    assert.deepEqual([open.code, open.json.error], [1, "round-1-not-closed"]);
  }
  {
    clock.set(0);
    const { cwd, store, runDir } = commandFixture(t);
    await seedRun(store, runDir, { timeoutMs: 1000 });
    clock.set(1000);
    await reduce(store);
    const failed = await council(["crossexam", "run-1", "--json"], { cwd });
    assert.deepEqual([failed.code, failed.json.error], [1, "no-quorum"]);
  }
  {
    const { cwd, store, runDir } = await quorateRound1(t, clock);
    // Two crossexams at once: exactly one commits its map; the loser installed only unreferenced objects.
    const [first, second] = await Promise.all([
      council(["crossexam", "run-1", "--json"], { cwd, ...CROSSEXAM_SERVICES }),
      council(["crossexam", "run-1", "--json"], { cwd, ...CROSSEXAM_SERVICES })
    ]);
    assert.deepEqual([first.code, second.code].sort(), [0, 1]);
    const loser = first.code === 1 ? first : second;
    assert.deepEqual(loser.json, { error: "round-2-already-started", message: "round 2 already sent" });
    const round2 = readCouncil(store, "run-1").rounds.find((row) => row.round === 2);
    const exported = fs.readFileSync(path.join(runDir("run-1"), "private", "anonymisation.json"));
    assert.equal(createHash("sha256").update(exported).digest("hex"), round2.map_sha256);
    const again = await council(["crossexam", "run-1"], { cwd });
    assert.deepEqual([again.code, again.stderr], [1, "round 2 already sent\n"]);
  }
});

test("a threadless accepted round 1 answer cannot supply a round 2 continuation", async (t) => {
  const clock = useTestClock(t, 0);
  const { cwd, store } = await quorateRound1(t, clock, { thread: "s3" });
  assert.deepEqual(seatState(store, "s2"), ["valid", null]);
  assert.equal(readCouncil(store, "run-1").rounds[0].quorum, 1);
  const result = await council(["crossexam", "run-1", "--json"], { cwd, ...CROSSEXAM_SERVICES });
  assert.equal(result.code, 0, result.stderr);
  const attempt = readCouncil(store, "run-1").attempts.find((row) => row.round === 2 && row.seat === "s2");
  assert.equal(attempt.refusal, "predecessor has no thread");
});

test("a continuation that drops its label reports it", async (t) => {
  const clock = useTestClock(t, 0);
  const { cwd, store, jobs } = await quorateRound1(t, clock, { jobColumns: { s2: { label: "run-1-s2" } } });
  createJob(store, seatJobFields("codex"), { label: "run-1-s2" });
  const result = await council(["crossexam", "run-1", "--json"], { cwd, ...CROSSEXAM_SERVICES });
  assert.equal(result.code, 0, result.stderr);
  const successor = store.read((db) => db.prepare("SELECT id FROM jobs WHERE continues = ?").get(jobs.s2)).id;
  assert.equal(result.stderr, `Seat s2: label run-1-s2 was not carried to job ${successor}.\n`);
  assert.deepEqual(result.json.diagnostics, [{ seat: "s2", jobId: successor, label: "run-1-s2" }]);
});

// ---------------------------------------------------------------------------------------------
// Merge, verdicts and export.

// Each seat's Round 2 answer: one response per bundle ref of the committed map, `skip` unless
// `respond(seat, ref)` returns another response.
function round2Answers(runDir, snapshot, respond = () => null) {
  const mapping = JSON.parse(fs.readFileSync(path.join(runDir, "objects", `${snapshot.rounds.find((row) => row.round === 2).map_sha256}.json`), "utf8"));
  const answerOf = (seat) => {
    const row = snapshot.seatRounds.find((entry) => entry.round === 1 && entry.seat === seat);
    return JSON.parse(fs.readFileSync(path.join(runDir, "objects", `${row.answer_sha256}.json`), "utf8"));
  };
  const answers = {};
  for (const seat of Object.keys(mapping)) {
    const responses = [];
    for (const letter of Object.keys(mapping[seat]).sort()) {
      for (const own of answerOf(mapping[seat][letter]).findings) {
        const ref = `${letter}-${own.id}`;
        responses.push(response(ref, respond(seat, `${mapping[seat][letter]}-${own.id}`) ?? {}));
      }
    }
    answers[seat] = round2Answer(responses);
  }
  return answers;
}

/**
 * A run whose Round 2 closed with quorum: Round 1 as quorateRound1, crossexam, then each seat's
 * Round 2 answer from round2Answers (`respond`) delivered (s1 by submit, the provider seats by
 * their successor jobs) and collected.
 */
async function closedRound2(t, clock, { respond, answers1 } = {}) {
  const fixture = await quorateRound1(t, clock, answers1 ? { answers: answers1 } : {});
  const { cwd, store, runDir } = fixture;
  const crossed = await council(["crossexam", "run-1", "--json"], { cwd, ...CROSSEXAM_SERVICES });
  assert.equal(crossed.code, 0, crossed.stderr);
  const snapshot = readCouncil(store, "run-1");
  const answers = round2Answers(runDir("run-1"), snapshot, respond);
  for (const attempt of snapshot.attempts.filter((row) => row.round === 2)) {
    if (attempt.kind === "prompt") {
      const reply = path.join(cwd, `reply-${attempt.seat}.json`);
      fs.writeFileSync(reply, JSON.stringify(answers[attempt.seat]));
      const submitted = await council(["submit", "run-1", attempt.seat, "--intent", attempt.id, "--file", reply], { cwd, ...CROSSEXAM_SERVICES });
      assert.equal(submitted.code, 0, submitted.stderr);
      continue;
    }
    setJob(store, attempt.job_id, { claimed_at: EPOCH + 20, started_at: EPOCH + 20 });
    endJob(store, attempt.job_id, 30, { end_state: "completed", result_json: JSON.stringify(answers[attempt.seat]) });
  }
  const collected = await council(["collect", "run-1", "--round", "2", "--json"], { cwd, ...CROSSEXAM_SERVICES });
  assert.equal(collected.code, 0, collected.stdout + collected.stderr);
  assert.equal(collected.json.quorum, true);
  return fixture;
}

// s1 and s3 both challenge the claim of s2's f1, so its cluster is disputed with two challenges.
const TWO_CHALLENGES = (seat, target) =>
  target === "s2-f1" && (seat === "s1" || seat === "s3")
    ? { response: "challenge", disputes: "claim", reason: `${seat} cannot reach it`, evidence: "src/a.mjs:1" }
    : null;

test("a stale merge writer is refused and the export follows the row", async (t) => {
  const clock = useTestClock(t, 0);
  const { cwd, store, runDir } = await closedRound2(t, clock);
  const snapshot = readCouncil(store, "run-1");
  const stale = await recordMerge(store, { runId: "run-1", mergeSha256: "e".repeat(64), inputRev: snapshot.run.input_rev - 1, deadline: performance.now() + 10000 });
  assert.deepEqual(stale, { ok: false, reason: "stale-input" });
  const merged = await council(["merge", "run-1", "--json"], { cwd });
  assert.equal(merged.code, 0, merged.stderr);
  const file = path.join(runDir("run-1"), "merge.json");
  const committed = readCouncil(store, "run-1").run.merge_sha256;
  assert.equal(createHash("sha256").update(fs.readFileSync(file)).digest("hex"), committed);
  // A delayed stale publisher does not overwrite merge.json.
  const older = installObject(runDir("run-1"), "{}\n", "json");
  assert.equal(publishExport(runDir("run-1"), "merge.json", older, () => readCouncil(store, "run-1").run.merge_sha256), false);
  assert.equal(createHash("sha256").update(fs.readFileSync(file)).digest("hex"), committed);
  // A crash after the commit and before the publish is repaired by council export.
  fs.rmSync(file);
  const exported = await council(["export", "run-1", "merge"], { cwd });
  assert.deepEqual([exported.code, exported.stdout], [0, `${file}\n`]);
  assert.equal(createHash("sha256").update(fs.readFileSync(file)).digest("hex"), committed);
  assert.match(merged.stdout, /"clusters"/);
});

test("verdicts: shape, reason, strongest bounds, revision", async (t) => {
  const clock = useTestClock(t, 0);
  const answers1 = Object.fromEntries(["s1", "s2", "s3"].map((seat) => [seat, round1Answer({ findings: [finding("f1", { claim: `${seat} claim`, line: seat === "s2" ? 7 : 1 })] })]));
  const { cwd, store } = await closedRound2(t, clock, { respond: TWO_CHALLENGES, answers1 });
  assert.equal((await council(["merge", "run-1"], { cwd })).code, 0);
  const merge = JSON.parse(fs.readFileSync(path.join(resolveStateDir(cwd), "council", "run-1", "merge.json"), "utf8"));
  const disputed = merge.clusters.find((cluster) => cluster.label === "disputed");
  assert.equal(disputed.challenges.length, 2);
  const before = () => readCouncil(store, "run-1").verdicts;
  const refusedWithoutChange = async (args, pattern) => {
    const prior = before();
    const result = await council(["verdict", "run-1", ...args], { cwd });
    assert.equal(result.code, 1, args.join(" "));
    assert.match(result.stderr, pattern, args.join(" "));
    assert.deepEqual(before(), prior);
  };
  await refusedWithoutChange([disputed.id, "rejected"], /needs a reason/);
  await refusedWithoutChange(["--strongest", "0", disputed.id, "verified"], /positive whole number/);
  await refusedWithoutChange(["--strongest", "3", disputed.id, "verified"], /from 1 to its 2 challenges/);
  await refusedWithoutChange(["--strongest", "x", disputed.id, "verified"], /positive whole number/);
  await refusedWithoutChange(["--strongest", "1", disputed.id, "not-checked"], /needs a verified verdict/);
  await refusedWithoutChange(["a9", "verified"], /no claim a9/);
  const strongest = await council(["verdict", "run-1", "--strongest", "2", disputed.id, "verified"], { cwd });
  assert.equal(strongest.code, 0, strongest.stderr);
  const row = before().find((entry) => entry.cluster_id === disputed.id);
  assert.equal(row.strongest, 2);
  assert.equal(row.strongest_sha256, createHash("sha256").update(JSON.stringify(disputed.challenges[1])).digest("hex"));
  assert.equal(row.target, [...disputed.findings].sort().join(","));
  const rejected = await council(["verdict", "run-1", disputed.id, "rejected", "--", "the guard", "--makes it unreachable"], { cwd });
  assert.equal(rejected.code, 0, rejected.stderr);
  assert.equal(before().find((entry) => entry.cluster_id === disputed.id).reason, "the guard --makes it unreachable");
  // A verdict against an older merge revision is refused.
  sql(store, ["UPDATE council_runs SET input_rev = input_rev + 1 WHERE id = ?", "run-1"]);
  await refusedWithoutChange([disputed.id, "verified"], /Run council merge first/);
});

test("council export rebuilds the map after a crash between seed and publish", async (t) => {
  const clock = useTestClock(t, 0);
  const { cwd, store, runDir } = await quorateRound1(t, clock);
  const early = await council(["export", "run-1", "map"], { cwd });
  assert.deepEqual([early.code, early.stderr], [1, "Nothing to export: map is not committed.\n"]);
  t.mock.restoreAll();
  const pointsDir = makeTempDir(t);
  const child = spawn(process.execPath, [CHILD, "0", "crossexam", "run-1", "--cwd", cwd], {
    env: { ...process.env, AGENT_PLUGIN_TEST_POINTS: "council-before-export", AGENT_PLUGIN_TEST_POINTS_DIR: pointsDir },
    stdio: "ignore",
    windowsHide: true
  });
  t.after(() => stopOwnedProcess(child));
  await waitUntil(() => fs.existsSync(path.join(pointsDir, `council-before-export-${child.pid}.reached`)), { timeoutMs: 30000, describe: "council-before-export reached" });
  await stopOwnedProcess(child);
  const committed = readCouncil(store, "run-1").rounds.find((row) => row.round === 2).map_sha256;
  const file = path.join(runDir("run-1"), "private", "anonymisation.json");
  assert.equal(fs.existsSync(file), false);
  assert.ok(fs.existsSync(path.join(runDir("run-1"), "objects", `${committed}.json`)));
  const exported = await council(["export", "run-1", "map"], { cwd });
  assert.equal(exported.code, 0, exported.stderr);
  assert.equal(createHash("sha256").update(fs.readFileSync(file)).digest("hex"), committed);
});

test("merge reads final valid seat rounds and survives a pruned job", async (t) => {
  const clock = useTestClock(t, 0);
  const { cwd, store, runDir } = await closedRound2(t, clock);
  const snapshot = readCouncil(store, "run-1");
  const input = mergeInput(runDir("run-1"), snapshot);
  for (const round of [1, 2]) {
    const stored = Object.fromEntries(
      snapshot.seatRounds
        .filter((row) => row.round === round && row.state === "valid")
        .map((row) => [row.seat, JSON.parse(fs.readFileSync(path.join(runDir("run-1"), "objects", `${row.answer_sha256}.json`), "utf8"))])
    );
    assert.deepEqual(input[`round${round}`], stored);
  }
  assert.equal((await council(["merge", "run-1"], { cwd })).code, 0);
  const first = fs.readFileSync(path.join(runDir("run-1"), "merge.json"), "utf8");
  for (const attempt of snapshot.attempts.filter((row) => row.job_id)) {
    sql(store, ["DELETE FROM chains WHERE id = (SELECT chain_id FROM jobs WHERE id = ?)", attempt.job_id]);
  }
  assert.equal((await council(["merge", "run-1"], { cwd })).code, 0);
  assert.equal(fs.readFileSync(path.join(runDir("run-1"), "merge.json"), "utf8"), first);
});

// ---------------------------------------------------------------------------------------------
// Status, the next action and the report.

// A synthetic snapshot for nextAction: `rounds` are `[round, closedAt, quorum]` triples.
function actionSnapshot({ rounds = [[1, null, null]], run = {}, stops = [], verdicts = [], attempts = [] } = {}) {
  return {
    run: {
      id: "run-1",
      clock: 0,
      failed_at: null,
      input_rev: 4,
      verdict_rev: 0,
      merge_sha256: null,
      merge_rev: null,
      report_sha256: null,
      report_outcome: null,
      report_input_rev: null,
      report_verdict_rev: null,
      ...run
    },
    rounds: rounds.map(([round, closedAt, quorum]) => ({ round, closed_at: closedAt, quorum, map_sha256: null })),
    seats: [],
    seatRounds: [],
    attempts,
    observations: [],
    stops,
    verdicts,
    charges: { total: { turn: 0, repair: 0, retry: 0 }, rounds: {} }
  };
}

const P1_MERGE = { clusters: [{ id: "c1", severity: "P1", label: "solo", findings: ["s2-f1"], challenges: [] }, { id: "c2", severity: "P3", label: "solo", findings: ["s3-f1"], challenges: [] }] };
const OBJECTS_OK = { damaged: null, merge: P1_MERGE, mergeExport: true, reportExport: true };

test("status computes one next action", () => {
  const closedBoth = [[1, 10, 1], [2, 20, 1]];
  const merged = { merge_sha256: "m".repeat(64), merge_rev: 4 };
  const verdict = { target_kind: "cluster", target: "s2-f1", input_rev: 4, verdict: "verified" };
  const reported = { ...merged, verdict_rev: 1, report_sha256: "r".repeat(64), report_outcome: "council", report_input_rev: 4, report_verdict_rev: 1 };
  const pendingStop = { stops: [{ job_id: "job-2", acknowledged_at: null }], attempts: [{ id: "a", round: 1, job_id: "job-2" }] };
  const rows = [
    ["damaged object", actionSnapshot({ rounds: closedBoth, run: reported, verdicts: [verdict] }), { ...OBJECTS_OK, damaged: "d".repeat(64) }, "damaged", null],
    ["pending stop in a closed round", actionSnapshot({ rounds: closedBoth, run: reported, verdicts: [verdict], ...pendingStop }), OBJECTS_OK, "collect", 1],
    ["failed without a report", actionSnapshot({ rounds: [[1, 10, 0]], run: { failed_at: 10 } }), OBJECTS_OK, "report-failure", null],
    ["failed with its report", actionSnapshot({ rounds: [[1, 10, 0]], run: { failed_at: 10, report_sha256: "r".repeat(64), report_outcome: "failed", report_input_rev: 4, report_verdict_rev: 0 } }), OBJECTS_OK, "done", null],
    ["round 2 failure", actionSnapshot({ rounds: [[1, 10, 1], [2, 20, 0]], run: { failed_at: 20 } }), OBJECTS_OK, "report-failure", null],
    ["open round", actionSnapshot({ rounds: [[1, null, null]] }), OBJECTS_OK, "collect", 1],
    ["open round 2", actionSnapshot({ rounds: [[1, 10, 1], [2, null, null]] }), OBJECTS_OK, "collect", 2],
    ["crossexam", actionSnapshot({ rounds: [[1, 10, 1]] }), OBJECTS_OK, "crossexam", 2],
    ["stale merge", actionSnapshot({ rounds: closedBoth, run: { merge_sha256: "m".repeat(64), merge_rev: 3 } }), OBJECTS_OK, "merge", 2],
    ["merge export missing", actionSnapshot({ rounds: closedBoth, run: merged }), { ...OBJECTS_OK, mergeExport: false }, "merge", 2],
    ["verify", actionSnapshot({ rounds: closedBoth, run: merged }), OBJECTS_OK, "verify", 2],
    ["report", actionSnapshot({ rounds: closedBoth, run: { ...merged, verdict_rev: 1 }, verdicts: [verdict] }), OBJECTS_OK, "report", 2],
    ["verdict after the report", actionSnapshot({ rounds: closedBoth, run: { ...reported, verdict_rev: 2 }, verdicts: [verdict] }), OBJECTS_OK, "report", 2],
    ["report export missing", actionSnapshot({ rounds: closedBoth, run: reported, verdicts: [verdict] }), { ...OBJECTS_OK, reportExport: false }, "report", 2],
    ["done", actionSnapshot({ rounds: closedBoth, run: reported, verdicts: [verdict] }), OBJECTS_OK, "done", null]
  ];
  for (const [name, snapshot, objects, action, round] of rows) {
    const next = nextAction(snapshot, { t: 0, objects });
    assert.deepEqual([next.action, next.round], [action, round], name);
  }
  assert.deepEqual(nextAction(rows[10][1], { t: 0, objects: OBJECTS_OK }).clusters, ["c1"]);
  assert.equal(nextAction(rows[0][1], { t: 0, objects: rows[0][2] }).damaged, "d".repeat(64));
});

test("a decision with a dissenting seat is never HIGH, and review confidence covers the empty case", () => {
  assert.equal(confidenceLine({ decision: { choice: "a", tally: { a: 2, b: 1 }, confidence: "MEDIUM" }, clusters: [] }), "Choice: a (a 2, b 1), confidence MEDIUM");
  assert.equal(confidenceLine({ decision: { choice: null, tally: { a: 1, b: 1, c: 1 }, confidence: "no consensus" }, clusters: [] }), "No consensus (a 1, b 1, c 1)");
  const cluster = (severity, label) => ({ severity, label });
  assert.equal(confidenceLine({ decision: null, clusters: [] }), "Confidence: HIGH");
  assert.equal(confidenceLine({ decision: null, clusters: [cluster("P3", "disputed")] }), "Confidence: MEDIUM");
  assert.equal(confidenceLine({ decision: null, clusters: [cluster("P1", "consensus"), cluster("P2", "cross-validated")] }), "Confidence: HIGH");
  assert.equal(confidenceLine({ decision: null, clusters: [cluster("P1", "consensus"), cluster("P2", "consensus"), cluster("P2", "solo")] }), "Confidence: MEDIUM");
  assert.equal(confidenceLine({ decision: null, clusters: [cluster("P1", "consensus"), cluster("P2", "solo")] }), "Confidence: LOW");
});

test("report requires the verification decision, and renders the sections in order", async (t) => {
  const clock = useTestClock(t, 0);
  const { cwd, store, runDir } = await closedRound2(t, clock, { respond: TWO_CHALLENGES });
  const early = await council(["report", "run-1"], { cwd });
  assert.deepEqual([early.code, early.stderr], [1, "Run council merge first.\n"]);
  assert.equal((await council(["merge", "run-1"], { cwd })).code, 0);
  const merge = JSON.parse(fs.readFileSync(path.join(runDir("run-1"), "merge.json"), "utf8"));
  const needed = merge.clusters.filter((cluster) => cluster.severity === "P1" || cluster.label === "consensus" || cluster.label === "cross-validated").map((cluster) => cluster.id);
  assert.ok(needed.length > 0);
  const refused = await council(["report", "run-1"], { cwd });
  assert.deepEqual([refused.code, refused.stderr], [1, `Record a verdict (verified, rejected or not-checked) for ${needed.join(", ")} first.\n`]);
  const status = await council(["status", "run-1", "--json"], { cwd });
  assert.deepEqual([status.json.action, status.json.clusters], ["verify", needed]);
  for (const id of needed) {
    assert.equal((await council(["verdict", "run-1", id, "not-checked"], { cwd })).code, 0);
  }
  const report = await council(["report", "run-1"], { cwd });
  assert.equal(report.code, 0, report.stderr);
  const text = report.stdout;
  assert.match(text, /Unresolved P1 findings: c\d+ \(not-checked\)/);
  const order = [
    "# Council report",
    "Run run-1 · review · 2 rounds · member turns 6 of 12 (repairs 0, retries 0)",
    "| Seat | Family | Model | Lens | Round 1 | Round 2 | Notes |",
    "Seats not valid: none",
    "## Late deposits",
    "## Verdict",
    "## Findings",
    "| Cluster | Severity | Label | Location | Claim | Reported by | Validated by | Challenged by | Leader verdict |",
    "## Disputes",
    "## Minority positions",
    "## Untested premises"
  ];
  let at = -1;
  for (const heading of order) {
    const next = text.indexOf(heading);
    assert.ok(next > at, `${heading} comes after the previous section`);
    at = next;
  }
  assert.equal(fs.readFileSync(path.join(runDir("run-1"), "report.md"), "utf8"), text);
  assert.equal((await council(["status", "run-1", "--json"], { cwd })).json.action, "done");
  // A stale report writer is refused.
  const run = readCouncil(store, "run-1").run;
  const stale = await recordReport(store, {
    runId: "run-1",
    reportSha256: "f".repeat(64),
    outcome: "council",
    inputRev: run.input_rev,
    verdictRev: run.verdict_rev - 1,
    deadline: performance.now() + 10000
  });
  assert.deepEqual(stale, { ok: false, reason: "stale" });
});

test("a council without quorum renders Failed council from stored answers", async (t) => {
  const clock = useTestClock(t, 0);
  const { cwd, store, runDir } = commandFixture(t);
  const { seats } = await seedRun(store, runDir, { timeoutMs: 1000 });
  const answer = round1Answer({ findings: [finding("f1", { claim: "the only answer" })] });
  const reply = path.join(cwd, "reply.json");
  fs.writeFileSync(reply, JSON.stringify(answer));
  clock.set(100);
  await receive(store, "run-1", "s1", seats[0].attemptId, { outcome: "valid", answerSha256: installObject(runDir("run-1"), JSON.stringify(answer), "json") });
  clock.set(1000);
  const closed = await council(["collect", "run-1", "--round", "1"], { cwd });
  assert.deepEqual([closed.code, closed.stdout], [1, "No quorum: 1 valid seats from 1 families. A council needs two valid seats from two families.\n"]);
  assert.equal((await council(["status", "run-1", "--json"], { cwd })).json.action, "report-failure");
  const report = await council(["report", "run-1"], { cwd });
  assert.equal(report.code, 0, report.stderr);
  assert.ok(report.stdout.startsWith("# Failed council\n"));
  assert.match(report.stdout, /Seats not valid: s2 \(round 1: error, issuance deadline expired\); s3 \(round 1: error, issuance deadline expired\)/);
  assert.ok(report.stdout.includes(`\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``));
  assert.equal((await council(["status", "run-1", "--json"], { cwd })).json.action, "done");
});

test("the council loop from start to done", async (t) => {
  async function loop({ failRound2 }) {
    const cwd = makeTempDir(t);
    const stateDir = resolveStateDir(cwd);
    const runDirOfRun = (runId) => path.join(stateDir, "council", runId);
    const buildJob = async ({ family, prompt, label, runId }) => ({
      fields: { ...seatJobFields(family === "codex" ? "codex" : "agy"), prompt, runId },
      label
    });
    // A launched job answers at once: Round 1 with one finding, Round 2 from the committed map.
    const launch = async (launchStore, _stateDir, jobId) => {
      const attempt = launchStore.read((db) => db.prepare("SELECT * FROM council_attempts WHERE job_id = ?").get(jobId));
      const snapshot = readCouncil(launchStore, attempt.run_id);
      const now = Date.now();
      setJob(launchStore, jobId, { claimed_at: now, started_at: now, thread_id: `thread-${jobId}` });
      if (attempt.round === 2 && failRound2 && attempt.seat === "s3") {
        setJob(launchStore, jobId, { end_state: "failed", end_at: now + 1, exec_released_at: now + 1, release_kind: "confirmed", error: "permission denied" });
        return null;
      }
      const answer = attempt.round === 1 ? round1Answer({ findings: [finding("f1", { severity: "P1", claim: `${attempt.seat} claim` })] }) : round2Answers(runDirOfRun(attempt.run_id), snapshot)[attempt.seat];
      setJob(launchStore, jobId, { end_state: "completed", end_at: now + 1, exec_released_at: now + 1, release_kind: "confirmed", result_json: JSON.stringify(answer) });
      return null;
    };
    const services = {
      checkProviders: async (ids) => ids.map((id) => ({ id, ok: true, reason: null })),
      advance: { buildJob, launch, readUsage: async () => null, reconcile: async () => {} }
    };
    const started = await council(["start", "--brief", writeBrief(cwd), "--json"], { cwd, ...services });
    assert.equal(started.code, 0, started.stderr);
    const { runId } = started.json;
    const store = openStore(stateDir);
    t.after(() => store.close());
    const delivered = new Set();
    const actions = [];
    for (let iteration = 0; iteration < 25; iteration += 1) {
      const status = await council(["status", runId, "--json"], { cwd });
      assert.equal(status.code, 0, status.stderr);
      for (const delivery of status.json.deliveries.filter((entry) => !delivered.has(entry.intentId))) {
        delivered.add(delivery.intentId);
        const snapshot = readCouncil(store, runId);
        const round = snapshot.attempts.find((row) => row.id === delivery.intentId).round;
        const answer = round === 1 ? round1Answer() : failRound2 ? { schema: 1 } : round2Answers(runDirOfRun(runId), snapshot)[delivery.seat];
        const reply = path.join(cwd, `reply-${delivery.intentId}.json`);
        fs.writeFileSync(reply, JSON.stringify(answer));
        assert.equal((await council(["submit", runId, delivery.seat, "--intent", delivery.intentId, "--file", reply], { cwd, ...services })).code, 0);
      }
      const { action, round, clusters } = status.json;
      actions.push(action);
      if (action === "done") {
        return actions;
      }
      if (action === "collect") {
        await council(["collect", runId, "--round", String(round), "--json"], { cwd, ...services });
      } else if (action === "crossexam" || action === "merge") {
        assert.equal((await council([action, runId], { cwd, ...services })).code, 0, action);
      } else if (action === "verify") {
        for (const cluster of clusters) {
          assert.equal((await council(["verdict", runId, cluster, "verified"], { cwd })).code, 0);
        }
      } else if (action === "report" || action === "report-failure") {
        assert.equal((await council(["report", runId], { cwd })).code, 0, action);
      } else {
        assert.fail(`unexpected action ${action}`);
      }
    }
    assert.fail(`the loop did not reach done: ${actions.join(", ")}`);
  }
  const passing = await loop({ failRound2: false });
  assert.deepEqual(passing, ["collect", "crossexam", "collect", "merge", "verify", "report", "done"]);
  const failing = await loop({ failRound2: true });
  assert.deepEqual(failing, ["collect", "crossexam", "collect", "report-failure", "done"]);
});
