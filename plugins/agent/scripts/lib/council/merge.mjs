// The deterministic council merge: findings join only through explicit `sameAs` links, a
// validation counts only across families, and equal inputs give byte-identical output.
// Pure: no I/O, clock or randomness.

const FAMILY_ORDER = ["claude", "codex", "agy"];
const SEVERITIES = ["P1", "P2", "P3"];
const LABEL_ORDER = ["consensus", "cross-validated", "disputed", "solo"];
const REF_PATTERN = /^([A-Z])-(f[1-9][0-9]{0,2})$/;

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function familyRank(family) {
  const index = FAMILY_ORDER.indexOf(family);
  return index === -1 ? FAMILY_ORDER.length : index;
}

function sortFamilies(families) {
  return [...new Set(families)].sort((a, b) => familyRank(a) - familyRank(b) || compareText(a, b));
}

function severityRank(severity) {
  return SEVERITIES.indexOf(severity);
}

function comparePosition(a, b) {
  return a[0] - b[0] || a[1] - b[1];
}

// Tally entries by count, highest first, then by option name in code-unit order.
export function sortedTally(tally) {
  return Object.entries(tally).sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]));
}

// The family that authored a seat's answer in a round: a stand-in's family when one answered.
function authorFamily(entry, round) {
  return (round === 1 ? entry.round1Family : entry.round2Family) ?? entry.family;
}

function collectFindings(seats, round1, round2) {
  const findings = new Map();
  seats.forEach((entry, seatIndex) => {
    const { seat } = entry;
    const first = round1[seat];
    if (!first) {
      return;
    }
    const own = [
      ...first.findings.map((item) => ({ item, key: seat, family: authorFamily(entry, 1) })),
      ...(round2[seat]?.added ?? []).map((item) => ({ item, key: entry.round2Key ?? seat, family: authorFamily(entry, 2) }))
    ];
    own.forEach(({ item, key, family }, index) => {
      const id = `${key}-${item.id}`;
      if (!findings.has(id)) {
        findings.set(id, { id, seat, family, position: [seatIndex, index], ...pick(item) });
      }
    });
  });
  return findings;
}

function pick({ severity, claim, path, line }) {
  return { severity, claim, path, line };
}

function createUnion(ids) {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== root) {
      root = parent.get(root);
    }
    let node = id;
    while (parent.get(node) !== root) {
      const next = parent.get(node);
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent.set(rootB, rootA);
    }
  };
  return { find, union };
}

function resolveTarget(anonymisation, responder, ref, findings) {
  const match = REF_PATTERN.exec(ref ?? "");
  if (!match) {
    return null;
  }
  const author = anonymisation?.[responder]?.[match[1]];
  const id = author ? `${author}-${match[2]}` : null;
  return id && findings.has(id) ? id : null;
}

function clusterSeverity(members) {
  const byFamily = new Map();
  for (const member of members) {
    const current = byFamily.get(member.family);
    if (current === undefined || severityRank(member.severity) < severityRank(current)) {
      byFamily.set(member.family, member.severity);
    }
  }
  const levels = [...byFamily.values()].sort((a, b) => severityRank(a) - severityRank(b));
  return levels.length > 1 ? levels[1] : levels[0];
}

function decide(kind, options, eligible, round2) {
  if (kind !== "decision") {
    return null;
  }
  const counts = new Map();
  const stances = [];
  for (const { seat } of eligible) {
    const stance = round2[seat]?.stance;
    const counted = typeof stance === "string" && options.includes(stance) ? stance : null;
    stances.push(counted);
    if (counted !== null) {
      counts.set(counted, (counts.get(counted) ?? 0) + 1);
    }
  }
  const tally = {};
  for (const [option, count] of sortedTally(Object.fromEntries(counts))) {
    // An own property, also for an option named like an Object.prototype member.
    Object.defineProperty(tally, option, { value: count, enumerable: true, writable: true, configurable: true });
  }
  const leader = sortedTally(tally)[0];
  const choice = leader && 3 * leader[1] >= 2 * eligible.length ? leader[0] : null;
  let confidence = "no consensus";
  if (choice !== null) {
    confidence = stances.every((stance) => stance === choice) ? "HIGH" : "MEDIUM";
  }
  return { choice, tally, threshold: "2/3", confidence };
}

// Inputs: seats in seat order ({ seat, family }); round1 and round2 map a seat to its valid
// answer; anonymisation maps a responder to its letter map; turns is { used, repairs, retries }.
// A seat answered by a stand-in in a round adds `round1Family` / `round2Family` (the stand-in's
// family, which authors, validates and challenges for it), `quorumFamily` (null when its Round 2
// answer is a stand-in's) and `round2Key` (the actor key of a fresh Round 2 stand-in, which keys
// the findings it adds). A response never validates a finding of its own logical seat.
// `substitutions`, when not empty, is passed through to the output.
export function mergeCouncil({ runId, kind, options = [], seats, round1 = {}, round2 = {}, anonymisation = {}, turns = {}, substitutions = [] }) {
  const familyOf = new Map(seats.map((entry) => [entry.seat, authorFamily(entry, 2)]));
  const findings = collectFindings(seats, round1, round2);
  const eligible = seats.filter(({ seat }) => round1[seat] && round2[seat]);

  const responses = [];
  for (const { seat } of eligible) {
    for (const entry of round2[seat].responses ?? []) {
      if (entry.response === "skip") {
        continue;
      }
      const target = resolveTarget(anonymisation, seat, entry.finding, findings);
      if (target) {
        responses.push({ responder: seat, target, entry });
      }
    }
  }

  const { find, union } = createUnion([...findings.keys()]);
  for (const { responder, target, entry } of responses) {
    const own = entry.sameAs === null || entry.sameAs === undefined ? null : `${responder}-${entry.sameAs}`;
    if (own && findings.has(own)) {
      union(own, target);
    }
  }

  const groups = new Map();
  for (const item of findings.values()) {
    const root = find(item.id);
    if (!groups.has(root)) {
      groups.set(root, { members: [], validatedBy: [], challenges: [] });
    }
    groups.get(root).members.push(item);
  }
  for (const { responder, target, entry } of responses) {
    const group = groups.get(find(target));
    const responderFamily = familyOf.get(responder);
    const ownSeat = findings.get(target).seat === responder;
    if (entry.response === "validate" && !ownSeat && findings.get(target).family !== responderFamily) {
      group.validatedBy.push(responderFamily);
    } else if (entry.response === "challenge") {
      group.challenges.push({ by: responderFamily, disputes: entry.disputes, reason: entry.reason });
    }
  }

  const clusters = [...groups.values()].map(({ members, validatedBy, challenges }) => {
    members.sort((a, b) => comparePosition(a.position, b.position));
    const reportedBy = sortFamilies(members.map((member) => member.family));
    const validated = sortFamilies(validatedBy);
    let label = "solo";
    if (challenges.some((challenge) => challenge.disputes === "claim")) {
      label = "disputed";
    } else if (reportedBy.length >= 2) {
      label = "consensus";
    } else if (validated.length > 0) {
      label = "cross-validated";
    }
    const severity = clusterSeverity(members);
    const ranks = members.map((member) => severityRank(member.severity));
    const lead = members.find((member) => member.severity === severity);
    return {
      first: members[0].position,
      cluster: {
        id: "",
        severity,
        severityRange: [SEVERITIES[Math.min(...ranks)], SEVERITIES[Math.max(...ranks)]],
        label,
        path: lead.path,
        line: lead.line,
        claim: lead.claim,
        findings: members.map((member) => member.id),
        reportedBy,
        validatedBy: validated,
        challenges
      }
    };
  });
  clusters.sort(
    (a, b) =>
      severityRank(a.cluster.severity) - severityRank(b.cluster.severity) ||
      LABEL_ORDER.indexOf(a.cluster.label) - LABEL_ORDER.indexOf(b.cluster.label) ||
      comparePosition(a.first, b.first)
  );
  clusters.forEach((entry, index) => {
    entry.cluster.id = `c${index + 1}`;
  });

  return {
    schema: 1,
    runId,
    quorum: {
      validSeats: eligible.length,
      families: sortFamilies(eligible.map((entry) => (entry.quorumFamily === undefined ? entry.family : entry.quorumFamily)).filter((family) => family !== null))
    },
    decision: decide(kind, options, eligible, round2),
    clusters: clusters.map((entry) => entry.cluster),
    memberTurns: {
      used: turns.used ?? 0,
      cap: 2 * seats.length + 6,
      repairs: turns.repairs ?? 0,
      retries: turns.retries ?? 0
    },
    ...(substitutions.length > 0 ? { substitutions } : {})
  };
}

const KEY_ORDER = {
  merge: ["schema", "runId", "quorum", "decision", "clusters", "memberTurns", "substitutions"],
  quorum: ["validSeats", "families"],
  decision: ["choice", "tally", "threshold", "confidence"],
  cluster: ["id", "severity", "severityRange", "label", "path", "line", "claim", "findings", "reportedBy", "validatedBy", "challenges"],
  challenge: ["by", "disputes", "reason"],
  memberTurns: ["used", "cap", "repairs", "retries"]
};

function ordered(value, keys) {
  const out = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      out[key] = value[key];
    }
  }
  return out;
}

// JSON with two-space indent and a final newline, keys in the merge shape's order.
export function serializeMerge(merge) {
  const shaped = ordered(merge, KEY_ORDER.merge);
  if (merge.quorum) {
    shaped.quorum = ordered(merge.quorum, KEY_ORDER.quorum);
  }
  if (merge.decision) {
    shaped.decision = ordered(merge.decision, KEY_ORDER.decision);
  }
  if (Array.isArray(merge.clusters)) {
    shaped.clusters = merge.clusters.map((cluster) => ({
      ...ordered(cluster, KEY_ORDER.cluster),
      challenges: (cluster.challenges ?? []).map((challenge) => ordered(challenge, KEY_ORDER.challenge))
    }));
  }
  if (merge.memberTurns) {
    shaped.memberTurns = ordered(merge.memberTurns, KEY_ORDER.memberTurns);
  }
  return `${JSON.stringify(shaped, null, 2)}\n`;
}
