// The question and open council modes: their answer schemas and label rules, the answer
// bundles, the merge of answers into options and the vote, and whole runs in a folder that is not
// a git repository, on real store transactions with the test wall clock and fake provider jobs.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { handleCouncil } from "../plugins/agent/scripts/commands/council.mjs";
import { answerBundle, selfLabel } from "../plugins/agent/scripts/lib/council/anonymise.mjs";
import { readObject } from "../plugins/agent/scripts/lib/council/objects.mjs";
import { readCouncil, recordAgreement } from "../plugins/agent/scripts/lib/council/state.mjs";
import { roundSchemaName, validateAnswer, validateSchemaFile } from "../plugins/agent/scripts/lib/council/validate.mjs";
import { ensureGitRepository } from "../plugins/agent/scripts/lib/git.mjs";
import { readJobView, resolveStateDir } from "../plugins/agent/scripts/lib/state.mjs";
import { openStore } from "../plugins/agent/scripts/lib/store.mjs";
import { makeTempDir } from "./helpers.mjs";
import { EPOCH, seatJobFields, setJob, useTestClock } from "./council-helpers.mjs";

const finding = (id, claim = id) => ({ id, severity: "P2", claim, path: null, line: null, evidence: "seen in the code" });

function round1(answer, { stance = null, findings = [finding("f1")] } = {}) {
  return { schema: 1, answer, stance, confidence: "high", dealbreaker: null, findings, assumptions: [], wouldChangeMind: "a counterexample" };
}

const validation = (ref) => ({ finding: ref, response: "validate", disputes: null, sameAs: null, reason: null, evidence: null });

function round2Question({ stance = "A", sameAs = [], responses = [validation("A-f1"), validation("B-f1")], added = [] } = {}) {
  return { schema: 1, stance, sameAs, responses, added };
}

const answerValidation = (label) => ({ answer: label, response: "validate", reason: null });

function round2Open({ agreesWith = ["A"], stance = null, answerResponses = [answerValidation("A"), answerValidation("B")], responses = [validation("A-f1"), validation("B-f1")], added = [] } = {}) {
  return { schema: 1, stance, agreesWith, answerResponses, responses, added };
}

// The Round 2 context of a seat that sees two other seats as A and B and its own answer as C.
const QUESTION_CONTEXT = { kind: "question", options: [], bundleRefs: ["A-f1", "B-f1"], ownFindingIds: ["f1"], answerLabels: ["A", "B", "C"] };
const OPEN_CONTEXT = { ...QUESTION_CONTEXT, kind: "open", ownAnswerLabel: "C" };

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
  assert.deepEqual(validateAnswer(2, round2Question(), OPEN_CONTEXT).errors, [
    "agreesWith: required property is missing",
    "answerResponses: required property is missing",
    "sameAs: unexpected property"
  ]);
});

test("an open Round 2 validates, challenges with a reason or skips every other answer once, and not its own", () => {
  const challenge = (label, reason) => ({ answer: label, response: "challenge", reason });
  assert.deepEqual(validateAnswer(2, round2Open({ answerResponses: [challenge("A", "it ignores readers"), { answer: "B", response: "skip", reason: null }] }), OPEN_CONTEXT), {
    ok: true,
    errors: []
  });
  assert.deepEqual(validateAnswer(2, round2Open({ answerResponses: [answerValidation("A")] }), OPEN_CONTEXT), { ok: false, errors: ["answerResponses: no response to answer B"] });
  assert.deepEqual(
    validateAnswer(2, round2Open({ answerResponses: [answerValidation("A"), answerValidation("A"), answerValidation("C"), challenge("B", " ")] }), OPEN_CONTEXT),
    {
      ok: false,
      errors: [
        "answerResponses[1].answer: A has more than one response",
        `answerResponses[2].answer: "C" is not another member's answer label; respond to A, B`,
        "answerResponses[3].reason: required for a challenge"
      ]
    }
  );
  assert.deepEqual(validateAnswer(2, round2Open({ answerResponses: [answerValidation("A"), { answer: "B", response: "agree", reason: null }] }), OPEN_CONTEXT).errors, [
    'answerResponses[1].response: must be one of "validate", "challenge", "skip", got "agree"'
  ]);
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

// ---------------------------------------------------------------------------------------------
// Whole question and open runs through the council commands, in a folder that is not a git
// repository.

const T_LONG = 1000000;

// A fake monotonic clock and wait clock: `sleep(ms)` moves `now` on; the wall clock stays.
function fakeTime(start = Math.round(performance.now())) {
  const state = { now: start };
  return {
    now: () => state.now,
    sleep: (ms) => {
      state.now += ms;
      return new Promise((resolve) => setImmediate(resolve));
    }
  };
}

// Runs one council subcommand in this process at layer 2 with the shipped extensions, fake
// provider checks and a job builder that records each job's prompt and schema file.
async function council(argv, { cwd, built = [] }) {
  const out = [];
  const err = [];
  const time = fakeTime();
  const code = await handleCouncil([argv[0], "--cwd", cwd, ...argv.slice(1)], {
    layer: 2,
    io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
    readRequester: async () => ({ sessionId: "session-1", leaderPid: null, leaderStartToken: null }),
    checkProviders: async (ids) => ids.map((id) => ({ id, ok: true })),
    advance: {
      reconcile: async () => {},
      launch: async () => null,
      readUsage: async () => null,
      buildJob: async ({ family, label, prompt, schemaPath }) => {
        built.push({ family, schemaPath });
        return { fields: seatJobFields(family === "codex" ? "codex" : "agy", { prompt }), label };
      },
      now: time.now,
      sleep: time.sleep
    }
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

const snap = (fx) => readCouncil(fx.store, fx.runId);
const seatRow = (fx, seat, round = 1) => snap(fx).seatRounds.find((row) => row.round === round && row.seat === seat);
const roundRow = (fx, round = 1) => snap(fx).rounds.find((row) => row.round === round);
const currentOf = (fx, seat, round = 1) => snap(fx).attempts.find((row) => row.id === seatRow(fx, seat, round).current_id);
const mapOf = (fx) => JSON.parse(readObject(fx.dir, roundRow(fx, 2).map_sha256, "json").toString("utf8"));
const promptOf = (fx, attempt) => readObject(fx.dir, attempt.prompt_sha256, "md").toString("utf8");
// The schema id a provider seat's Round 2 job was continued with.
const round2Schema = (fx, seat) => JSON.parse(readJobView(fx.store, currentOf(fx, seat, 2).job_id).row.request_json).outputSchema.$id;

function endJob(fx, jobId, at, columns) {
  setJob(fx.store, jobId, { claimed_at: EPOCH + at - 5, started_at: EPOCH + at - 5, end_at: EPOCH + at, exec_released_at: EPOCH + at, release_kind: "confirmed", thread_id: `thread-${jobId}`, ...columns });
}
const completeJob = (fx, jobId, at, resultJson) => endJob(fx, jobId, at, { end_state: "completed", result_json: resultJson });
const failJob = (fx, jobId, at) => endJob(fx, jobId, at, { end_state: "failed", error: "permission denied" });

async function submit(fx, seat, intentId, text) {
  const file = path.join(fx.cwd, `reply-${intentId}.json`);
  fs.writeFileSync(file, text);
  return council(["submit", fx.runId, seat, "--intent", intentId, "--file", file, "--json"], { cwd: fx.cwd });
}

function collect(fx, { round = 2, extra = [] } = {}) {
  return council(["collect", fx.runId, "--round", String(round), "--budget-ms", "120000", ...extra, "--json"], { cwd: fx.cwd, built: fx.built });
}

// A council of `kind` started at wall 0 through `council start` in a fresh temporary folder that
// is not a git repository: s1 Claude, s2 Codex, s3 Antigravity with the kind's default lenses.
async function started(t, clock, kind) {
  clock.set(0);
  const cwd = makeTempDir(t);
  assert.throws(() => ensureGitRepository(cwd));
  const stateDir = resolveStateDir(cwd);
  const store = openStore(stateDir);
  t.after(() => store.close());
  const brief = path.join(cwd, "brief.json");
  fs.writeFileSync(brief, JSON.stringify({ question: "How should the cache be made safe under concurrent writes?", kind }));
  const built = [];
  const result = await council(["start", "--brief", brief, "--timeout-ms", String(T_LONG), "--json"], { cwd, built });
  assert.equal(result.code, 0, result.stderr);
  return { cwd, store, kind, built, runId: result.json.runId, dir: path.join(stateDir, "council", result.json.runId), started: result.json };
}

function answer1(text, claim) {
  return JSON.stringify(round1(text, { findings: [finding("f1", claim)] }));
}

// Round 1 answered at 100 (each seat's answer text by `texts`, one supporting point each) and
// closed with quorum.
async function round1Closed(t, clock, kind, texts = { s1: "Use a lock.", s2: "Use a lock.", s3: "Use a queue." }) {
  const fx = await started(t, clock, kind);
  clock.set(100);
  completeJob(fx, currentOf(fx, "s2").job_id, 100, answer1(texts.s2, "bravo"));
  completeJob(fx, currentOf(fx, "s3").job_id, 100, answer1(texts.s3, "charlie"));
  assert.equal((await submit(fx, "s1", currentOf(fx, "s1").id, answer1(texts.s1, "alpha"))).code, 0);
  const closed = await collect(fx, { round: 1 });
  assert.equal(closed.json.quorum, true, closed.stdout);
  return fx;
}

// The label `seat` sees for the answer of `author` in Round 2: a letter of its map, or its own
// label after them.
function labelFor(map, seat, author) {
  if (seat === author) {
    return selfLabel(map[seat]);
  }
  return Object.keys(map[seat]).find((letter) => map[seat][letter] === author);
}

// A Round 2 answer that validates every finding of `seat`'s bundle (one finding f1 per author).
function answer2(map, seat, { kind, stance = null, sameAs = [], agreesWith = [], answerResponses = null, response = "validate", added = [] }) {
  const responses = Object.keys(map[seat])
    .sort()
    .map((letter) =>
      response === "challenge"
        ? { finding: `${letter}-f1`, response, disputes: "claim", sameAs: null, reason: "not so", evidence: "see the code" }
        : { finding: `${letter}-f1`, response, disputes: null, sameAs: null, reason: null, evidence: null }
    );
  if (kind === "question") {
    return JSON.stringify({ schema: 1, stance, sameAs, responses, added });
  }
  // By default an open seat validates every other answer, each under its letter.
  const marks = answerResponses ?? Object.keys(map[seat]).sort().map((letter) => ({ answer: letter, response: "validate", reason: null }));
  return JSON.stringify({ schema: 1, stance, agreesWith, answerResponses: marks, responses, added });
}

// Round 2 sent at 1000 and answered at 1100 by `answers2(seat, map)` (null leaves a seat's job
// to the test), then collected.
async function round2Answered(fx, clock, answers2, { collectExtra = [] } = {}) {
  clock.set(1000);
  const sent = await council(["crossexam", fx.runId, "--json"], { cwd: fx.cwd, built: fx.built });
  assert.equal(sent.code, 0, sent.stderr);
  const map = mapOf(fx);
  clock.set(1100);
  const s1 = answers2("s1", map);
  assert.equal((await submit(fx, "s1", sent.json.deliveries.find((entry) => entry.seat === "s1").intentId, s1)).json.state, "valid");
  for (const seat of ["s2", "s3"]) {
    const text = answers2(seat, map);
    if (text !== null) {
      completeJob(fx, currentOf(fx, seat, 2).job_id, 1100, text);
    }
  }
  return { map, collected: await collect(fx, { extra: collectExtra }) };
}

async function mergeRun(fx) {
  const merged = await council(["merge", fx.runId, "--json"], { cwd: fx.cwd });
  assert.equal(merged.code, 0, merged.stdout);
  return merged.json;
}

test("a question council in a folder without git: answers linked as the same become one option, and three votes are unanimous", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await round1Closed(t, clock, "question");
  assert.deepEqual(fx.started.seats.map((seat) => seat.lens), ["evidence", "first principles", "counterexamples"]);
  assert.equal(snap(fx).run.kind, "question");
  assert.equal(snap(fx).run.stored_kind, "decision");
  // Every seat links s1's answer with s2's and with s3's, and endorses s1's answer.
  const { map, collected } = await round2Answered(fx, clock, (seat, letters) =>
    answer2(letters, seat, {
      kind: "question",
      stance: labelFor(letters, seat, "s1"),
      sameAs: [
        [labelFor(letters, seat, "s1"), labelFor(letters, seat, "s2")],
        [labelFor(letters, seat, "s1"), labelFor(letters, seat, "s3")]
      ]
    })
  );
  assert.deepEqual([collected.code, collected.json.quorum], [0, true], collected.stdout);
  const merged = await mergeRun(fx);
  assert.deepEqual(merged.merge.answers, [
    { label: "A", seat: "s1", text: "Use a lock." },
    { label: "B", seat: "s2", text: "Use a lock." },
    { label: "C", seat: "s3", text: "Use a queue." }
  ]);
  assert.deepEqual(merged.merge.options, [{ id: "A", labels: ["A", "B", "C"], text: "Use a lock." }]);
  assert.deepEqual(merged.merge.decision, { choice: "A", tally: { A: 3 }, threshold: "2/3", confidence: "HIGH" });
  assert.equal(merged.unanimous, true);
  assert.equal((await council(["status", fx.runId, "--json"], { cwd: fx.cwd })).json.unanimous, true);
  // The provider seats ran on the question schemas, and every Round 2 prompt shows the answers.
  assert.deepEqual(
    fx.built.map((job) => path.basename(job.schemaPath)),
    ["council-round1-question.schema.json", "council-round1-question.schema.json"]
  );
  assert.deepEqual(
    ["s2", "s3"].map((seat) => round2Schema(fx, seat)),
    ["urn:agent-plugin:schema:council-round2-question:1", "urn:agent-plugin:schema:council-round2-question:1"]
  );
  const round2Prompt = promptOf(fx, currentOf(fx, "s2", 2));
  assert.match(round2Prompt, /The members' answers to the question, each under a label/);
  assert.match(round2Prompt, new RegExp(`Your own answer is labelled ${selfLabel(map.s2)}\\.`));
  assert.match(round2Prompt, /"answer": "Use a queue\."/);
  for (const attempt of snap(fx).attempts) {
    assert.doesNotMatch(promptOf(fx, attempt), /review council/);
  }
});

test("a question council without the link and with votes A, A, B has two options and chooses A by two of three", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await round1Closed(t, clock, "question");
  // s1 and s2 link their own two answers; nobody links them with s3's. s3 votes for its own.
  await round2Answered(fx, clock, (seat, letters) =>
    answer2(letters, seat, {
      kind: "question",
      stance: labelFor(letters, seat, seat === "s3" ? "s3" : "s1"),
      sameAs: seat === "s3" ? [] : [[labelFor(letters, seat, "s1"), labelFor(letters, seat, "s2")]]
    })
  );
  const merged = await mergeRun(fx);
  assert.deepEqual(merged.merge.options, [
    { id: "A", labels: ["A", "B"], text: "Use a lock." },
    { id: "C", labels: ["C"], text: "Use a queue." }
  ]);
  assert.deepEqual(merged.merge.decision, { choice: "A", tally: { A: 2, C: 1 }, threshold: "2/3", confidence: "MEDIUM" });
  assert.equal(merged.unanimous, false);
  for (const cluster of (await council(["status", fx.runId, "--json"], { cwd: fx.cwd })).json.clusters) {
    assert.equal((await council(["verdict", fx.runId, cluster, "not-checked"], { cwd: fx.cwd })).code, 0);
  }
  const report = await council(["report", fx.runId], { cwd: fx.cwd });
  assert.equal(report.code, 0, report.stderr);
  assert.match(report.stdout, /## Verdict\n\nChoice: A \(A 2, C 1\), confidence MEDIUM\n/);
  assert.match(report.stdout, /## Answers\n\n- A \(s1\): Use a lock\.\n- B \(s2\): Use a lock\.\n- C \(s3\): Use a queue\.\n/);
  assert.match(report.stdout, /## Options\n\n- A \(answers A, B; 2 votes\): Use a lock\.\n- C \(answers C; 1 vote\): Use a queue\.\n/);
  assert.match(report.stdout, /## Minority positions\n\n- s3: option C\n/);
  assert.doesNotMatch(report.stdout, /Unanimous panel/);
});

test("a question vote with no two-thirds option, a missing Round 2 seat, a challenge or an added finding is not unanimous", async (t) => {
  const clock = useTestClock(t, 0);
  // 1-1-1: every seat votes for its own answer and links nothing.
  const split = await round1Closed(t, clock, "question", { s1: "Use a lock.", s2: "Use a queue.", s3: "Use copy-on-write." });
  await round2Answered(split, clock, (seat, letters) => answer2(letters, seat, { kind: "question", stance: labelFor(letters, seat, seat) }));
  const none = await mergeRun(split);
  assert.deepEqual(none.merge.decision, { choice: null, tally: { A: 1, B: 1, C: 1 }, threshold: "2/3", confidence: "no consensus" });
  assert.equal(none.unanimous, false);
  // s3 gives no Round 2 answer: it casts no vote, still counts in the denominator, and the panel is not unanimous.
  const missing = await round1Closed(t, clock, "question");
  const { collected } = await round2Answered(
    missing,
    clock,
    (seat, letters) => (seat === "s3" ? null : answer2(letters, seat, { kind: "question", stance: labelFor(letters, seat, "s1") })),
    { collectExtra: ["--disallow-substitute"] }
  );
  assert.equal(collected.json.wake, "budget", collected.stdout);
  failJob(missing, currentOf(missing, "s3", 2).job_id, 1100);
  clock.set(1200);
  assert.equal((await collect(missing, { extra: ["--disallow-substitute"] })).json.quorum, true);
  assert.equal(seatRow(missing, "s3", 2).state, "error");
  const twoOfThree = await mergeRun(missing);
  assert.deepEqual(twoOfThree.merge.decision, { choice: "A", tally: { A: 2 }, threshold: "2/3", confidence: "MEDIUM" });
  assert.equal(twoOfThree.unanimous, false);
  // One option for every vote, but one seat challenges a finding or adds one.
  for (const change of [{ response: "challenge" }, { added: [finding("f2")] }]) {
    const fx = await round1Closed(t, clock, "question");
    await round2Answered(fx, clock, (seat, letters) =>
      answer2(letters, seat, { kind: "question", stance: labelFor(letters, seat, "s1"), ...(seat === "s2" ? change : {}) })
    );
    const merged = await mergeRun(fx);
    assert.equal(merged.merge.decision.choice, "A");
    assert.equal(merged.unanimous, false, JSON.stringify(change));
  }
});

test("a question Round 2 stance naming a label that does not exist is invalid and the seat is asked again", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await round1Closed(t, clock, "question");
  const { map, collected } = await round2Answered(fx, clock, (seat, letters) =>
    answer2(letters, seat, { kind: "question", stance: seat === "s2" ? "Z" : labelFor(letters, seat, "s1") })
  );
  assert.notEqual(collected.json.wake, "closed", collected.stdout);
  const repair = currentOf(fx, "s2", 2);
  assert.equal(repair.charge, "repair");
  const prompt = promptOf(fx, repair);
  assert.match(prompt, /stance: "Z" is not an answer label; the labels are A, B, C/);
  assert.match(prompt, /"\$id": "urn:agent-plugin:schema:council-round2-question:1"/);
  // The repaired answer is valid and the round closes.
  clock.set(1200);
  const issued = await collect(fx);
  assert.equal(issued.code, 0, issued.stdout);
  completeJob(fx, currentOf(fx, "s2", 2).job_id, 1300, answer2(map, "s2", { kind: "question", stance: labelFor(map, "s2", "s1") }));
  clock.set(1400);
  const closed = await collect(fx);
  assert.deepEqual([closed.json.wake, closed.json.quorum], ["closed", true], closed.stdout);
  assert.equal(seatRow(fx, "s2", 2).state, "valid");
  assert.deepEqual((await mergeRun(fx)).merge.decision.tally, { A: 3 });
});

test("an open council lists every answer, waits for the leader's agreement verdict, and reports it", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await round1Closed(t, clock, "open", { s1: "Use a lock.", s2: "A lock or a queue.", s3: "Use a queue." });
  assert.deepEqual([snap(fx).run.kind, snap(fx).run.stored_kind], ["open", "review"]);
  // s1 and s2 agree with each other; s3 agrees with s2 only and challenges s1's answer.
  const s3Responses = (letters) =>
    Object.keys(letters.s3)
      .sort()
      .map((letter) => (letters.s3[letter] === "s1" ? { answer: letter, response: "challenge", reason: "readers wait on the lock" } : { answer: letter, response: "validate", reason: null }));
  await round2Answered(fx, clock, (seat, letters) =>
    answer2(letters, seat, {
      kind: "open",
      agreesWith: seat === "s3" ? [labelFor(letters, seat, "s2")] : [labelFor(letters, seat, seat === "s1" ? "s2" : "s1")],
      answerResponses: seat === "s3" ? s3Responses(letters) : null
    })
  );
  assert.deepEqual(
    ["s2", "s3"].map((seat) => round2Schema(fx, seat)),
    ["urn:agent-plugin:schema:council-round2-open:1", "urn:agent-plugin:schema:council-round2-open:1"]
  );
  const merged = await mergeRun(fx);
  assert.equal(merged.merge.decision, null);
  assert.equal(merged.merge.options, undefined);
  assert.deepEqual(merged.merge.answers.map((entry) => entry.text), ["Use a lock.", "A lock or a queue.", "Use a queue."]);
  // The merge carries each seat's marks under the canonical labels, before any verdict.
  const validated = (label) => ({ answer: label, response: "validate", reason: null });
  assert.deepEqual(merged.merge.marks, [
    { seat: "s1", agreesWith: ["B"], answerResponses: [validated("B"), validated("C")] },
    { seat: "s2", agreesWith: ["A"], answerResponses: [validated("A"), validated("C")] },
    { seat: "s3", agreesWith: ["B"], answerResponses: [{ answer: "A", response: "challenge", reason: "readers wait on the lock" }, validated("B")] }
  ]);
  assert.deepEqual(validateSchemaFile("council-merge", merged.merge), { ok: true, errors: [] });
  assert.equal(merged.unanimous, false);
  const status = await council(["status", fx.runId, "--json"], { cwd: fx.cwd });
  for (const cluster of status.json.clusters) {
    assert.equal((await council(["verdict", fx.runId, cluster, "not-checked"], { cwd: fx.cwd })).code, 0);
  }
  const waiting = await council(["status", fx.runId], { cwd: fx.cwd });
  assert.match(waiting.stdout, new RegExp(`Next: judge how far the answers agree and record council verdict ${fx.runId} agreement agreed\\|partly\\|disagreed -- <reason>\\.`));
  const early = await council(["report", fx.runId, "--json"], { cwd: fx.cwd });
  assert.deepEqual([early.code, early.json.error], [1, "verdict-required"]);
  // Bad agreement verdicts are refused.
  assert.equal((await council(["verdict", fx.runId, "agreement", "mostly", "--", "why"], { cwd: fx.cwd })).code, 1);
  const unreasoned = await council(["verdict", fx.runId, "agreement", "agreed", "--json"], { cwd: fx.cwd });
  assert.deepEqual([unreasoned.code, unreasoned.json.error], [1, "invalid-arguments"]);
  const recorded = await council(["verdict", fx.runId, "agreement", "agreed", "--", "every", "answer", "uses", "mutual", "exclusion"], { cwd: fx.cwd });
  assert.equal(recorded.code, 0, recorded.stderr);
  assert.equal((await council(["status", fx.runId, "--json"], { cwd: fx.cwd })).json.action, "report");
  const report = await council(["report", fx.runId], { cwd: fx.cwd });
  assert.equal(report.code, 0, report.stderr);
  assert.match(report.stdout, /## Verdict\n\nAgreement \(leader judgement\): agreed\nReason: every answer uses mutual exclusion\n/);
  assert.match(
    report.stdout,
    /- A \(s1\): Use a lock\.\n {2}Agreed with by: s2\.\n {2}Challenged by: s3 \(readers wait on the lock\)\.\n- B \(s2\): A lock or a queue\.\n {2}Agreed with by: s1, s3\.\n {2}Challenged by: none\.\n- C \(s3\): Use a queue\.\n {2}Agreed with by: none\.\n {2}Challenged by: none\.\n/
  );
  assert.doesNotMatch(report.stdout, /## Options/);
});

test("an agreement verdict is refused on a review or question council, on a stale merge and without a reason", async (t) => {
  const clock = useTestClock(t, 0);
  for (const kind of ["review", "question"]) {
    const fx = await started(t, clock, kind);
    const refused = await council(["verdict", fx.runId, "agreement", "agreed", "--json", "--", "looks", "fine"], { cwd: fx.cwd });
    assert.deepEqual([refused.code, refused.json.error], [1, "not-open"], refused.stdout);
    assert.deepEqual(await recordAgreement(fx.store, { runId: fx.runId, value: "agreed", reason: "fine", mergeSha256: "a".repeat(64), inputRev: 0 }), { ok: false, reason: "not-open" });
  }
  // An open council before its merge, then each of the three values on the current merge.
  const fx = await round1Closed(t, clock, "open");
  const premature = await council(["verdict", fx.runId, "agreement", "partly", "--json", "--", "too", "early"], { cwd: fx.cwd });
  assert.deepEqual([premature.code, premature.json.error], [1, "stale-merge"]);
  await round2Answered(fx, clock, (seat, letters) => answer2(letters, seat, { kind: "open" }));
  await mergeRun(fx);
  const run = snap(fx).run;
  const fence = { runId: fx.runId, mergeSha256: run.merge_sha256, inputRev: run.input_rev };
  assert.deepEqual(await recordAgreement(fx.store, { ...fence, value: "agreed", reason: "  " }), { ok: false, reason: "invalid-agreement" });
  assert.deepEqual(await recordAgreement(fx.store, { ...fence, value: "agreed", reason: "old", mergeSha256: "b".repeat(64) }), { ok: false, reason: "stale-merge" });
  assert.deepEqual(await recordAgreement(fx.store, { ...fence, value: "agreed", reason: "old", inputRev: run.input_rev + 1 }), { ok: false, reason: "stale-merge" });
  for (const value of ["agreed", "partly", "disagreed"]) {
    const before = snap(fx).run.verdict_rev;
    assert.deepEqual(await recordAgreement(fx.store, { ...fence, value, reason: `judged ${value}` }), { ok: true });
    assert.deepEqual([snap(fx).agreement.value, snap(fx).agreement.reason, snap(fx).run.verdict_rev], [value, `judged ${value}`, before + 1]);
  }
});

test("a fresh Round 2 stand-in on a question council sees every answer, the replaced seat's included, and its vote counts", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await round1Closed(t, clock, "question");
  clock.set(1000);
  const sent = await council(["crossexam", fx.runId, "--json"], { cwd: fx.cwd, built: fx.built });
  assert.equal(sent.code, 0, sent.stderr);
  const map = mapOf(fx);
  clock.set(1100);
  const vote = (seat) => answer2(map, seat, { kind: "question", stance: labelFor(map, seat, "s1") });
  assert.equal((await submit(fx, "s1", sent.json.deliveries.find((entry) => entry.seat === "s1").intentId, vote("s1"))).json.state, "valid");
  completeJob(fx, currentOf(fx, "s2", 2).job_id, 1100, vote("s2"));
  failJob(fx, currentOf(fx, "s3", 2).job_id, 1100);
  const woke = await collect(fx);
  const standIn = woke.json.deliveries.find((delivery) => delivery.actor === "s3~r2");
  assert.ok(standIn, woke.stdout);
  // Its answer labels cover all three Round 1 answers, none marked as its own.
  const labels = mapOf(fx).$answerAlternates["s3~r2"];
  assert.deepEqual(Object.values(labels).sort(), ["s1", "s2", "s3"]);
  const prompt = fs.readFileSync(standIn.promptFile, "utf8");
  assert.match(prompt, /"answer": "Use a queue\."/);
  assert.doesNotMatch(prompt, /"yours": true/);
  assert.doesNotMatch(prompt, /Your own answer is labelled/);
  // It votes for the replaced seat's answer, still on the ballot; its findings bundle leaves s3's findings out.
  const own = Object.keys(labels).find((letter) => labels[letter] === "s3");
  const findings = mapOf(fx).$alternates["s3~r2"];
  assert.ok(!Object.values(findings).includes("s3"));
  const responses = Object.keys(findings)
    .sort()
    .map((letter) => ({ finding: `${letter}-f1`, response: "validate", disputes: null, sameAs: null, reason: null, evidence: null }));
  clock.set(1200);
  const submitted = await submit(fx, "s3", standIn.intentId, JSON.stringify({ schema: 1, stance: own, sameAs: [], responses, added: [] }));
  assert.equal(submitted.json.state, "valid", submitted.stdout);
  const closed = await collect(fx);
  assert.deepEqual([closed.json.wake, closed.json.quorum], ["closed", true], closed.stdout);
  const merged = await mergeRun(fx);
  assert.deepEqual(merged.merge.decision.tally, { A: 2, C: 1 });
});

test("an open seat that leaves an answer without a response is asked again with the error", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await round1Closed(t, clock, "open");
  const { map, collected } = await round2Answered(fx, clock, (seat, letters) => answer2(letters, seat, { kind: "open", answerResponses: seat === "s2" ? [] : null }));
  assert.notEqual(collected.json.wake, "closed", collected.stdout);
  const repair = currentOf(fx, "s2", 2);
  assert.equal(repair.charge, "repair");
  const prompt = promptOf(fx, repair);
  assert.match(prompt, /answerResponses: no response to answer A/);
  assert.match(prompt, /"\$id": "urn:agent-plugin:schema:council-round2-open:1"/);
  completeJob(fx, currentOf(fx, "s2", 2).job_id, 1300, answer2(map, "s2", { kind: "open" }));
  clock.set(1400);
  const closed = await collect(fx);
  assert.deepEqual([closed.json.wake, closed.json.quorum], ["closed", true], closed.stdout);
  assert.equal((await mergeRun(fx)).merge.marks.find((mark) => mark.seat === "s2").answerResponses.length, 2);
});

test("an agreement verdict with --merge binds to the merge the leader read and refuses another", async (t) => {
  const clock = useTestClock(t, 0);
  const fx = await round1Closed(t, clock, "open");
  await round2Answered(fx, clock, (seat, letters) => answer2(letters, seat, { kind: "open" }));
  const merged = await council(["merge", fx.runId, "--json"], { cwd: fx.cwd });
  const read = merged.json.mergeSha256;
  assert.match(read, /^[0-9a-f]{64}$/);
  const other = read === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64);
  const stale = await council(["verdict", fx.runId, "agreement", "agreed", "--merge", other, "--json", "--", "same", "answers"], { cwd: fx.cwd });
  assert.deepEqual([stale.code, stale.json?.error], [1, "stale-merge"], stale.stdout);
  assert.equal(snap(fx).agreement, null);
  const malformed = await council(["verdict", fx.runId, "agreement", "agreed", "--merge", "abc", "--json", "--", "same"], { cwd: fx.cwd });
  assert.deepEqual([malformed.code, malformed.json?.error], [1, "invalid-arguments"], malformed.stdout);
  const onCluster = await council(["verdict", fx.runId, "c1", "not-checked", "--merge", read, "--json"], { cwd: fx.cwd });
  assert.deepEqual([onCluster.code, onCluster.json?.error], [1, "invalid-arguments"], onCluster.stdout);
  const bound = await council(["verdict", fx.runId, "agreement", "partly", "--merge", read, "--json", "--", "two", "answers", "differ"], { cwd: fx.cwd });
  assert.equal(bound.code, 0, bound.stdout);
  assert.deepEqual([snap(fx).agreement.value, snap(fx).agreement.reason, snap(fx).agreement.merge_sha256], ["partly", "two answers differ", read]);
});

// ---------------------------------------------------------------------------------------------
// The documents.

test("the skill, the seat agent, the prompts and the README describe the four modes and call the panel a council", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
  const skill = read("plugins", "agent", "skills", "council", "SKILL.md");
  for (const text of ["`review`", "`decision`", "`question`", "`open`", "`agree`", "council verdict <run-id> agreement agreed|partly|disagreed", "Agreement (leader judgement)", "a vote would mislead"]) {
    assert.ok(skill.includes(text), `the council skill names ${text}`);
  }
  const readme = read("README.md");
  const section = readme.slice(readme.indexOf("## Council"), readme.indexOf("## Job store"));
  for (const text of ["**Four modes.**", "`question`", "`open`", "`sameAs`", "`agreesWith`", "council verdict <run-id> agreement agreed|partly|disagreed", "evidence, first principles and counterexamples", "`agree`"]) {
    assert.ok(section.includes(text), `the README council section names ${text}`);
  }
  for (const file of [
    ["plugins", "agent", "prompts", "council-round1.md"],
    ["plugins", "agent", "prompts", "council-round2.md"],
    ["plugins", "agent", "prompts", "council-followup.md"],
    ["plugins", "agent", "prompts", "council-substitute.md"],
    ["plugins", "agent", "agents", "council-member.md"]
  ]) {
    assert.doesNotMatch(read(...file), /review council/, file.join("/"));
  }
});
