// The question and open council modes: their answer schemas and label rules, the answer
// bundles, the merge of answers into options and the vote, and whole runs in a folder that is not
// a git repository, on real store transactions with the test wall clock and fake provider jobs.
import test from "node:test";
import assert from "node:assert/strict";

import { answerBundle, selfLabel } from "../plugins/agent/scripts/lib/council/anonymise.mjs";
import { roundSchemaName, validateAnswer, validateSchemaFile } from "../plugins/agent/scripts/lib/council/validate.mjs";

const finding = (id, claim = id) => ({ id, severity: "P2", claim, path: null, line: null, evidence: "seen in the code" });

function round1(answer, { stance = null, findings = [finding("f1")] } = {}) {
  return { schema: 1, answer, stance, confidence: "high", dealbreaker: null, findings, assumptions: [], wouldChangeMind: "a counterexample" };
}

const validation = (ref) => ({ finding: ref, response: "validate", disputes: null, sameAs: null, reason: null, evidence: null });

function round2Question({ stance = "A", sameAs = [], responses = [validation("A-f1"), validation("B-f1")], added = [] } = {}) {
  return { schema: 1, stance, sameAs, responses, added };
}

function round2Open({ agreesWith = ["A"], stance = null, responses = [validation("A-f1"), validation("B-f1")], added = [] } = {}) {
  return { schema: 1, stance, agreesWith, responses, added };
}

// The Round 2 context of a seat that sees two other seats as A and B and its own answer as C.
const QUESTION_CONTEXT = { kind: "question", options: [], bundleRefs: ["A-f1", "B-f1"], ownFindingIds: ["f1"], answerLabels: ["A", "B", "C"] };
const OPEN_CONTEXT = { ...QUESTION_CONTEXT, kind: "open" };

// ---------------------------------------------------------------------------------------------
// Schemas and the label rules.

test("each kind answers its rounds against its own schema", () => {
  assert.deepEqual(
    ["review", "decision", "question", "open"].map((kind) => [roundSchemaName(1, kind), roundSchemaName(2, kind)]),
    [
      ["council-round1", "council-round2"],
      ["council-round1", "council-round2"],
      ["council-round1-question", "council-round2-question"],
      ["council-round1-question", "council-round2-open"]
    ]
  );
  assert.throws(() => roundSchemaName(3, "question"), /Unknown council round "3"/);
});

test("a question or open Round 1 answer needs a statement of at most 500 characters and a null stance", () => {
  for (const kind of ["question", "open"]) {
    const context = { kind, options: [] };
    assert.deepEqual(validateAnswer(1, round1("The cache is correct."), context), { ok: true, errors: [] });
    assert.deepEqual(validateAnswer(1, round1("x".repeat(500)), context), { ok: true, errors: [] });
    assert.deepEqual(validateAnswer(1, round1("x".repeat(501)), context), { ok: false, errors: ["answer: must have at most 500 characters, got 501"] });
    assert.deepEqual(validateAnswer(1, round1(""), context), { ok: false, errors: ["answer: must have at least 1 character(s)"] });
    const { answer: _answer, ...withoutAnswer } = round1("unused");
    assert.deepEqual(validateAnswer(1, withoutAnswer, context), { ok: false, errors: ["answer: required property is missing"] });
    assert.deepEqual(validateAnswer(1, round1("Yes.", { stance: "A" }), context), {
      ok: false,
      errors: [`stance: must be null in the first round of a ${kind} council, got "A"`]
    });
  }
  // A review answer keeps its schema: an answer key is not part of it.
  assert.deepEqual(validateAnswer(1, round1("Yes."), { kind: "review", options: [] }).errors, ["answer: unexpected property"]);
});

test("a question Round 2 stance and sameAs pairs must name the answer labels the seat was given", () => {
  assert.deepEqual(validateAnswer(2, round2Question({ stance: "C", sameAs: [["A", "C"]] }), QUESTION_CONTEXT), { ok: true, errors: [] });
  // A stance naming a label that does not exist is invalid, and the message names the labels.
  assert.deepEqual(validateAnswer(2, round2Question({ stance: "D" }), QUESTION_CONTEXT), {
    ok: false,
    errors: ['stance: "D" is not an answer label; the labels are A, B, C']
  });
  assert.deepEqual(validateAnswer(2, round2Question({ sameAs: [["A", "Z"], ["B", "B"], ["A", "B", "C"]] }), QUESTION_CONTEXT), {
    ok: false,
    errors: [
      'sameAs[0]: "Z" is not an answer label; the labels are A, B, C',
      'sameAs[1]: must name two different answers, got "B" twice',
      "sameAs[2]: must hold exactly two answer labels, got 3"
    ]
  });
  // A null stance fails the schema: a question seat always endorses one answer.
  assert.deepEqual(validateAnswer(2, round2Question({ stance: null }), QUESTION_CONTEXT), { ok: false, errors: ["stance: must be of type string, got null"] });
  // The findings rules still hold beside the labels.
  assert.deepEqual(validateAnswer(2, round2Question({ responses: [validation("A-f1")] }), QUESTION_CONTEXT), { ok: false, errors: ["responses: no response to B-f1"] });
});

test("an open Round 2 agrees with known answer labels, each once, and gives no stance", () => {
  assert.deepEqual(validateAnswer(2, round2Open({ agreesWith: ["A", "C"] }), OPEN_CONTEXT), { ok: true, errors: [] });
  assert.deepEqual(validateAnswer(2, round2Open({ agreesWith: [] }), OPEN_CONTEXT), { ok: true, errors: [] });
  assert.deepEqual(validateAnswer(2, round2Open({ agreesWith: ["A", "E", "A"], stance: "A" }), OPEN_CONTEXT), {
    ok: false,
    errors: ['agreesWith[1]: "E" is not an answer label; the labels are A, B, C', "agreesWith[2]: A is listed twice", 'stance: must be null in an open council, got "A"']
  });
  const { agreesWith: _agrees, ...withoutAgreement } = round2Open();
  assert.deepEqual(validateAnswer(2, withoutAgreement, OPEN_CONTEXT), { ok: false, errors: ["agreesWith: required property is missing"] });
  // A question answer is not an open answer.
  assert.deepEqual(validateAnswer(2, round2Question(), OPEN_CONTEXT).errors, ["agreesWith: required property is missing", "sameAs: unexpected property"]);
});

test("the merge schema takes the answers and the options of a question council", () => {
  const merge = {
    schema: 1,
    runId: "run-1",
    quorum: { validSeats: 3, families: ["claude", "codex", "agy"] },
    decision: { choice: "A", tally: { A: 3 }, threshold: "2/3", confidence: "HIGH" },
    answers: [
      { label: "A", seat: "s1", text: "Yes." },
      { label: "B", seat: "s2", text: "Yes, it is." }
    ],
    options: [{ id: "A", labels: ["A", "B"], text: "Yes." }],
    clusters: [],
    memberTurns: { used: 6, cap: 12, repairs: 0, retries: 0 }
  };
  assert.deepEqual(validateSchemaFile("council-merge", merge), { ok: true, errors: [] });
  assert.equal(validateSchemaFile("council-merge", { ...merge, options: [{ id: "o1", labels: ["A"], text: "Yes." }] }).ok, false);
});

test("each recipient sees the other answers under its own letters, scrubbed, and its own answer after them", () => {
  assert.equal(selfLabel({ A: "s2", B: "s3" }), "C");
  assert.equal(selfLabel({}), "A");
  const seats = [
    { seat: "s2", family: "codex", label: "run-1-s2", model: "gpt-secret-9" },
    { seat: "s3", family: "agy", label: "run-1-s3", model: null }
  ];
  const answers = { s2: round1("As gpt-secret-9 I say yes."), s3: round1("No, says run-1-s3.") };
  assert.deepEqual(answerBundle(seats, answers, { A: "s3", B: "s2" }, "My own answer.", { runId: "run-1" }), [
    { label: "A", answer: "No, says [member]." },
    { label: "B", answer: "As [member] I say yes." },
    { label: "C", answer: "My own answer.", yours: true }
  ]);
  // A fresh stand-in has no answer of its own.
  assert.deepEqual(answerBundle(seats, answers, { A: "s2" }, null), [{ label: "A", answer: "As [member] I say yes." }]);
});
