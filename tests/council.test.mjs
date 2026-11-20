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
import { validateAnswer } from "../plugins/agent/scripts/lib/council/validate.mjs";

const SCHEMA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "agent", "schemas");

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
