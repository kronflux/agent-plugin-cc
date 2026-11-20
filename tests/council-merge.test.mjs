import test from "node:test";
import assert from "node:assert/strict";

import { mergeCouncil, serializeMerge, sortedTally } from "../plugins/agent/scripts/lib/council/merge.mjs";
import { validateSchemaFile } from "../plugins/agent/scripts/lib/council/validate.mjs";

const SKIP = { response: "skip", disputes: null, sameAs: null, reason: null, evidence: null };

function finding(seat, id, severity, path, line) {
  return { id, severity, claim: `${seat}-${id} claim`, path, line, evidence: `${seat}-${id} evidence` };
}

function round1(findings, stance = null) {
  return {
    schema: 1,
    stance,
    confidence: "high",
    dealbreaker: null,
    findings,
    assumptions: [],
    wouldChangeMind: "a failing test"
  };
}

function round2(responses, stance = null, added = []) {
  return { schema: 1, stance, responses, added };
}

// One response per bundle ref, `skip` unless an override names the ref.
function respond(bundleRefs, overrides = {}) {
  return bundleRefs.map((ref) => ({ finding: ref, ...SKIP, ...(overrides[ref] ?? {}) }));
}

// The refs of a recipient's bundle: by letter, then by the author's finding order.
function bundleRefs(mapping, recipient, answers) {
  return Object.keys(mapping[recipient])
    .sort()
    .flatMap((letter) => answers[mapping[recipient][letter]].findings.map((item) => `${letter}-${item.id}`));
}

function acFixture() {
  const seats = [
    { seat: "s1", family: "claude" },
    { seat: "s2", family: "codex" },
    { seat: "s3", family: "codex" },
    { seat: "s4", family: "agy" }
  ];
  const r1 = {
    s1: round1([finding("s1", "f8", "P3", "src/avg.mjs", 4)]),
    s2: round1([
      finding("s2", "f1", "P2", "src/a.mjs", 1),
      finding("s2", "f2", "P2", "src/a.mjs", 2),
      finding("s2", "f3", "P3", "src/a.mjs", 3),
      finding("s2", "f4", "P2", "src/a.mjs", 4),
      finding("s2", "f5", "P1", "src/a.mjs", 5),
      finding("s2", "f6", "P3", "src/x.mjs", 10),
      finding("s2", "f7", "P3", null, null),
      finding("s2", "f8", "P2", "src/avg.mjs", 4),
      finding("s2", "f9", "P3", "src/a.mjs", 9)
    ]),
    s3: round1([]),
    s4: round1([
      finding("s4", "f1", "P1", "src/a.mjs", 1),
      finding("s4", "f5", "P2", "src/a.mjs", 5),
      finding("s4", "f6", "P3", "src/x.mjs", 10),
      finding("s4", "f7", "P3", null, null),
      finding("s4", "f8", "P2", "src/avg.mjs", 5)
    ])
  };
  const anonymisation = {
    s1: { A: "s2", B: "s3", C: "s4" },
    s2: { A: "s3", B: "s4", C: "s1" },
    s3: { A: "s4", B: "s1", C: "s2" },
    s4: { A: "s1", B: "s2", C: "s3" }
  };
  const refs = (seat) => bundleRefs(anonymisation, seat, r1);
  const r2 = {
    s1: round2(
      respond(refs("s1"), {
        "A-f4": { response: "challenge", disputes: "claim", reason: "f4 cannot be reached", evidence: "src/a.mjs:4 guard" },
        "A-f5": { response: "challenge", disputes: "severity", reason: "only the log is wrong", evidence: "src/a.mjs:5" },
        "C-f8": { response: "validate", sameAs: "f8" }
      })
    ),
    s2: round2(respond(refs("s2"))),
    s3: round2(respond(refs("s3"), { "C-f3": { response: "validate" } })),
    s4: round2(
      respond(refs("s4"), {
        "B-f1": { response: "validate", sameAs: "f1" },
        "B-f2": { response: "validate" },
        "B-f5": { response: "validate", sameAs: "f5" },
        "B-f7": { response: "validate", sameAs: "f7" },
        "B-f8": { response: "validate", sameAs: "f8" }
      })
    )
  };
  return {
    runId: "run-1-00000000",
    kind: "review",
    options: [],
    seats,
    round1: r1,
    round2: r2,
    anonymisation,
    turns: { used: 8, cap: 14, repairs: 0, retries: 0 }
  };
}

function cluster(id, severity, severityRange, label, path, line, claim, findings, reportedBy, validatedBy, challenges = []) {
  return { id, severity, severityRange, label, path, line, claim, findings, reportedBy, validatedBy, challenges };
}

const EXPECTED = {
  schema: 1,
  runId: "run-1-00000000",
  quorum: { validSeats: 4, families: ["claude", "codex", "agy"] },
  decision: null,
  clusters: [
    cluster("c1", "P2", ["P2", "P3"], "consensus", "src/avg.mjs", 4, "s2-f8 claim", ["s1-f8", "s2-f8", "s4-f8"], ["claude", "codex", "agy"], ["claude", "agy"]),
    cluster("c2", "P2", ["P1", "P2"], "consensus", "src/a.mjs", 1, "s2-f1 claim", ["s2-f1", "s4-f1"], ["codex", "agy"], ["agy"]),
    cluster("c3", "P2", ["P1", "P2"], "consensus", "src/a.mjs", 5, "s4-f5 claim", ["s2-f5", "s4-f5"], ["codex", "agy"], ["agy"], [
      { by: "claude", disputes: "severity", reason: "only the log is wrong" }
    ]),
    cluster("c4", "P2", ["P2", "P2"], "cross-validated", "src/a.mjs", 2, "s2-f2 claim", ["s2-f2"], ["codex"], ["agy"]),
    cluster("c5", "P2", ["P2", "P2"], "disputed", "src/a.mjs", 4, "s2-f4 claim", ["s2-f4"], ["codex"], [], [
      { by: "claude", disputes: "claim", reason: "f4 cannot be reached" }
    ]),
    cluster("c6", "P3", ["P3", "P3"], "consensus", null, null, "s2-f7 claim", ["s2-f7", "s4-f7"], ["codex", "agy"], ["agy"]),
    cluster("c7", "P3", ["P3", "P3"], "solo", "src/a.mjs", 3, "s2-f3 claim", ["s2-f3"], ["codex"], []),
    cluster("c8", "P3", ["P3", "P3"], "solo", "src/x.mjs", 10, "s2-f6 claim", ["s2-f6"], ["codex"], []),
    cluster("c9", "P3", ["P3", "P3"], "solo", "src/a.mjs", 9, "s2-f9 claim", ["s2-f9"], ["codex"], []),
    cluster("c10", "P3", ["P3", "P3"], "solo", "src/x.mjs", 10, "s4-f6 claim", ["s4-f6"], ["agy"], [])
  ],
  memberTurns: { used: 8, cap: 14, repairs: 0, retries: 0 }
};

test("the merge applies the cluster and label rules to the nine cases", () => {
  const fixture = acFixture();
  for (const seat of Object.keys(fixture.round1)) {
    assert.deepEqual(validateSchemaFile("council-round1", fixture.round1[seat]), { ok: true, errors: [] }, seat);
    assert.deepEqual(validateSchemaFile("council-round2", fixture.round2[seat]), { ok: true, errors: [] }, seat);
  }
  assert.equal(serializeMerge(mergeCouncil(fixture)), serializeMerge(EXPECTED));
  assert.deepEqual(validateSchemaFile("council-merge", EXPECTED), { ok: true, errors: [] });
});

test("two merges of the same inputs are byte-identical", () => {
  const first = serializeMerge(mergeCouncil(acFixture()));
  assert.equal(serializeMerge(mergeCouncil(acFixture())), first);
  const reversed = acFixture();
  reversed.round2 = Object.fromEntries(Object.entries(reversed.round2).reverse());
  assert.equal(serializeMerge(mergeCouncil(reversed)), first);
  assert.ok(first.endsWith("}\n"));
});

test("a same-family link joins but never makes consensus", () => {
  const merge = mergeCouncil({
    runId: "run-2",
    kind: "review",
    options: [],
    seats: [
      { seat: "s2", family: "codex" },
      { seat: "s3", family: "codex" }
    ],
    round1: {
      s2: round1([finding("s2", "f1", "P3", "src/a.mjs", 1)]),
      s3: round1([finding("s3", "f1", "P1", "src/a.mjs", 1)])
    },
    round2: {
      s2: round2(respond(["A-f1"])),
      s3: round2(respond(["A-f1"], { "A-f1": { response: "validate", sameAs: "f1" } }))
    },
    anonymisation: { s2: { A: "s3" }, s3: { A: "s2" } },
    turns: { used: 4, repairs: 0, retries: 0 }
  });
  assert.equal(merge.clusters.length, 1);
  const [only] = merge.clusters;
  assert.equal(only.label, "solo");
  assert.equal(only.severity, "P1");
  assert.deepEqual(only.severityRange, ["P1", "P3"]);
  assert.deepEqual(only.validatedBy, []);
  assert.deepEqual(only.findings, ["s2-f1", "s3-f1"]);
  assert.equal(merge.memberTurns.cap, 10);
});

test("severity is the level two families reached", () => {
  const merge = mergeCouncil({
    runId: "run-3",
    kind: "review",
    options: [],
    seats: [
      { seat: "s1", family: "claude" },
      { seat: "s2", family: "codex" },
      { seat: "s3", family: "agy" }
    ],
    round1: {
      s1: round1([finding("s1", "f1", "P1", "src/a.mjs", 1)]),
      s2: round1([finding("s2", "f1", "P3", "src/a.mjs", 1)]),
      s3: round1([finding("s3", "f1", "P3", "src/a.mjs", 1)])
    },
    round2: {
      s1: round2(respond(["A-f1", "B-f1"])),
      s2: round2(respond(["A-f1", "B-f1"], { "A-f1": { response: "validate", sameAs: "f1" } })),
      s3: round2(respond(["A-f1", "B-f1"], { "A-f1": { response: "validate", sameAs: "f1" } }))
    },
    anonymisation: { s1: { A: "s2", B: "s3" }, s2: { A: "s1", B: "s3" }, s3: { A: "s1", B: "s2" } },
    turns: { used: 6, repairs: 0, retries: 0 }
  });
  assert.equal(merge.clusters.length, 1);
  assert.equal(merge.clusters[0].severity, "P3");
  assert.deepEqual(merge.clusters[0].severityRange, ["P1", "P3"]);
  assert.equal(merge.clusters[0].label, "consensus");
});

function decisionMerge(stances, { options = ["a", "b", "c"], roundOneOnly = [] } = {}) {
  const families = ["claude", "codex", "agy", "codex", "agy"];
  const seats = [];
  const r1 = {};
  const r2 = {};
  [...stances, ...roundOneOnly].forEach((stance, index) => {
    const seat = `s${index + 1}`;
    seats.push({ seat, family: families[index] });
    r1[seat] = round1([], stance);
    if (index < stances.length) {
      r2[seat] = round2([], stance);
    }
  });
  return mergeCouncil({
    runId: "run-4",
    kind: "decision",
    options,
    seats,
    round1: r1,
    round2: r2,
    anonymisation: {},
    turns: { used: seats.length * 2, repairs: 0, retries: 0 }
  });
}

test("an option named like an object member is counted", () => {
  const merge = decisionMerge(["__proto__", "__proto__", "__proto__"], { options: ["__proto__", "keep"] });
  assert.equal(merge.decision.choice, "__proto__");
  assert.equal(merge.decision.confidence, "HIGH");
  assert.deepEqual(Object.entries(merge.decision.tally), [["__proto__", 3]]);
});

test("the decision counts only final eligible seats and named options", () => {
  let merge = decisionMerge(["a", "a", "a"]);
  assert.deepEqual(merge.decision, { choice: "a", tally: { a: 3 }, threshold: "2/3", confidence: "HIGH" });

  merge = decisionMerge(["a", "a", "b"]);
  assert.equal(merge.decision.choice, "a");
  assert.equal(merge.decision.confidence, "MEDIUM");

  merge = decisionMerge(["a", "b", "c"]);
  assert.equal(merge.decision.choice, null);
  assert.equal(merge.decision.confidence, "no consensus");
  assert.equal(JSON.stringify(merge.decision.tally), '{"a":1,"b":1,"c":1}');

  merge = decisionMerge(["a", "a"], { roundOneOnly: ["b"] });
  assert.equal(merge.quorum.validSeats, 2);
  assert.equal(merge.decision.choice, "a");
  assert.equal(merge.decision.confidence, "HIGH");

  merge = decisionMerge(["a", "a", "d"]);
  assert.equal(merge.decision.choice, "a");
  assert.equal(merge.decision.confidence, "MEDIUM");
  assert.deepEqual(merge.decision.tally, { a: 2 });

  merge = decisionMerge(["10", "10", "2"], { options: ["10", "2"] });
  assert.equal(merge.decision.choice, "10");
  assert.deepEqual(sortedTally(merge.decision.tally), [["10", 2], ["2", 1]]);
  assert.equal(JSON.stringify(merge.decision.tally), '{"2":1,"10":2}');

  merge = decisionMerge([]);
  assert.deepEqual(merge.decision, { choice: null, tally: {}, threshold: "2/3", confidence: "no consensus" });
  assert.equal(merge.quorum.validSeats, 0);
});
