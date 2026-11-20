import crypto from "node:crypto";

import { listProviders } from "../providers.mjs";

// Anonymised round 2 bundles: each recipient sees the other seats' round 1 findings under
// letters of its own shuffled map, with every identity string of those seats scrubbed.

const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];
const REF_PATTERN = /^([A-Z])-(f[1-9][0-9]{0,2})$/;
const MASK = "[member]";

function seatId(seat) {
  return typeof seat === "string" ? seat : seat.seat;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Replaces each identity, case-insensitively and only where it is not part of a longer word,
// with "[member]". Longer identities are replaced first, so a label that holds a seat id goes
// as a whole.
export function scrubIdentity(text, identities) {
  if (typeof text !== "string") {
    return text;
  }
  const words = [...new Set((identities ?? []).filter((item) => typeof item === "string" && item.trim() !== ""))];
  words.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  let scrubbed = text;
  for (const word of words) {
    const pattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(word)}(?![A-Za-z0-9_])`, "gi");
    scrubbed = scrubbed.replace(pattern, MASK);
  }
  return scrubbed;
}

function providerLabel(family) {
  return listProviders().find((provider) => provider.id === family)?.label ?? null;
}

// The identity strings of one seat row: seat id, label, family, provider display name, model
// id and model name, plus any extra strings the row lists under `identities`.
function seatIdentities(seat) {
  if (typeof seat === "string") {
    return [seat];
  }
  return [
    seat.seat,
    seat.label,
    seat.family,
    seat.providerLabel ?? providerLabel(seat.family),
    seat.model,
    seat.modelName,
    ...(seat.identities ?? [])
  ];
}

function shuffle(items, random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = random(index + 1);
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

// seats: seat rows in seat order ({ seat, family, label?, model?, modelName?, providerLabel?,
// identities? }) or seat ids; round1 maps each seat valid in round 1 to its answer.
// random(max) returns an integer in [0, max).
export function buildBundles(seats, round1, { random = crypto.randomInt, runId = null } = {}) {
  const valid = seats.filter((seat) => round1[seatId(seat)]);
  const bundles = {};
  const mapping = {};
  for (const recipient of valid) {
    const recipientId = seatId(recipient);
    const others = valid.filter((seat) => seatId(seat) !== recipientId);
    const identities = [runId, ...others.flatMap(seatIdentities)];
    const lettered = shuffle(others, random);
    mapping[recipientId] = {};
    bundles[recipientId] = [];
    lettered.forEach((author, index) => {
      const letter = LETTERS[index];
      const authorId = seatId(author);
      mapping[recipientId][letter] = authorId;
      for (const item of round1[authorId].findings) {
        bundles[recipientId].push({
          ref: `${letter}-${item.id}`,
          severity: item.severity,
          claim: scrubIdentity(item.claim, identities),
          path: scrubIdentity(item.path, identities),
          line: item.line,
          evidence: scrubIdentity(item.evidence, identities)
        });
      }
    });
  }
  return { bundles, mapping };
}

/**
 * The bundle of one recipient under a fixed letter map (`{ letter: author key }`): each author's
 * Round 1 findings under its letter, in letter order, with every identity of the lettered authors
 * (and `runId`) scrubbed. `seats` are the author rows as for buildBundles; `round1` maps an author
 * key to its answer.
 */
export function bundleFromMap(seats, round1, letterMap, { runId = null } = {}) {
  const rows = new Map(seats.map((seat) => [seatId(seat), seat]));
  const letters = Object.keys(letterMap ?? {}).sort();
  const identities = [runId, ...letters.flatMap((letter) => seatIdentities(rows.get(letterMap[letter]) ?? letterMap[letter]))];
  const bundle = [];
  for (const letter of letters) {
    for (const item of round1[letterMap[letter]]?.findings ?? []) {
      bundle.push({
        ref: `${letter}-${item.id}`,
        severity: item.severity,
        claim: scrubIdentity(item.claim, identities),
        path: scrubIdentity(item.path, identities),
        line: item.line,
        evidence: scrubIdentity(item.evidence, identities)
      });
    }
  }
  return bundle;
}

/**
 * The label of a recipient's own answer in a question or open council: the first letter after
 * the letters of its letter map (`{ letter: author key }`), which buildBundles assigns from A on.
 */
export function selfLabel(letterMap) {
  return LETTERS[Object.keys(letterMap ?? {}).length];
}

/**
 * The answers one recipient of a question or open council sees in Round 2: each lettered author's
 * Round 1 `answer` under its letter, in letter order, with every identity of the lettered authors
 * (and `runId`) scrubbed as in the finding bundles, then the recipient's own answer (`ownAnswer`,
 * null for a fresh stand-in, which has none) under selfLabel with `yours: true`.
 */
export function answerBundle(seats, round1, letterMap, ownAnswer = null, { runId = null } = {}) {
  const rows = new Map(seats.map((seat) => [seatId(seat), seat]));
  const letters = Object.keys(letterMap ?? {}).sort();
  const identities = [runId, ...letters.flatMap((letter) => seatIdentities(rows.get(letterMap[letter]) ?? letterMap[letter]))];
  const answers = letters
    .filter((letter) => typeof round1[letterMap[letter]]?.answer === "string")
    .map((letter) => ({ label: letter, answer: scrubIdentity(round1[letterMap[letter]].answer, identities) }));
  if (typeof ownAnswer === "string") {
    answers.push({ label: selfLabel(letterMap), answer: ownAnswer, yours: true });
  }
  return answers;
}

export function resolveRef(mapping, responder, ref) {
  const match = REF_PATTERN.exec(typeof ref === "string" ? ref : "");
  if (!match) {
    return null;
  }
  const author = mapping?.[responder]?.[match[1]];
  return author ? `${author}-${match[2]}` : null;
}
