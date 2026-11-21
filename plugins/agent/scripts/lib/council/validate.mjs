import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { selfLabel, standInAnswerMap } from "./anonymise.mjs";
import { readObject as readStoredObject } from "./objects.mjs";

// Checks council answers against the round schemas and the rules a schema cannot express.
// The schema checker covers the keywords the council schemas use: type (with nullable type
// lists), enum, const, required, properties, additionalProperties (false or a schema), items,
// minLength, maxLength, minimum and pattern.

const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "schemas");
const ROUND_SCHEMAS = { 1: "council-round1", 2: "council-round2" };
// The round schemas of the kinds whose seats answer the question in their own words: Round 1 adds
// the answer, Round 2 adds the answer labels a seat links (`question`) or agrees with (`open`).
const KIND_SCHEMAS = {
  question: { 1: "council-round1-question", 2: "council-round2-question" },
  open: { 1: "council-round1-question", 2: "council-round2-open" }
};
const schemaCache = new Map();

/** The schema name of a council round's answer for a run of `kind`. */
export function roundSchemaName(round, kind = "review") {
  const name = (Object.hasOwn(KIND_SCHEMAS, kind ?? "") ? KIND_SCHEMAS[kind] : ROUND_SCHEMAS)[round];
  if (!name) {
    throw new TypeError(`Unknown council round "${round}".`);
  }
  return name;
}

/** Whether seats of a run of `kind` answer in their own words (a `question` or `open` run). */
export function answersInOwnWords(kind) {
  return Object.hasOwn(KIND_SCHEMAS, kind ?? "");
}

export function loadCouncilSchema(name) {
  if (!schemaCache.has(name)) {
    const text = fs.readFileSync(path.join(SCHEMA_DIR, `${name}.schema.json`), "utf8");
    schemaCache.set(name, JSON.parse(text));
  }
  return schemaCache.get(name);
}

function typeOf(value) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function matchesType(value, type) {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return typeOf(value) === "object";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
    case "boolean":
      return typeof value === type;
    default:
      return false;
  }
}

function describe(value) {
  return value === null ? "null" : JSON.stringify(value);
}

function childPath(base, key) {
  return base ? `${base}.${key}` : key;
}

function label(where) {
  return where || "answer";
}

function checkSchema(schema, value, where, errors) {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${label(where)}: must be of type ${types.join(" or ")}, got ${typeOf(value)}`);
      return;
    }
  }
  if (Object.prototype.hasOwnProperty.call(schema, "const") && value !== schema.const) {
    errors.push(`${label(where)}: must be ${describe(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${label(where)}: must be one of ${schema.enum.map(describe).join(", ")}, got ${describe(value)}`);
  }
  if (value === null) {
    return;
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) {
      errors.push(`${label(where)}: must have at least ${schema.minLength} character(s)`);
    }
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) {
      errors.push(`${label(where)}: must have at most ${schema.maxLength} characters, got ${[...value].length}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${label(where)}: ${describe(value)} does not match ${schema.pattern}`);
    }
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${label(where)}: must be at least ${schema.minimum}`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => checkSchema(schema.items, item, `${label(where)}[${index}]`, errors));
  }
  if (typeOf(value) === "object") {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${childPath(where, key)}: required property is missing`);
      }
    }
    for (const [key, item] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        checkSchema(properties[key], item, childPath(where, key), errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${childPath(where, key)}: unexpected property`);
      } else if (typeOf(schema.additionalProperties) === "object") {
        checkSchema(schema.additionalProperties, item, childPath(where, key), errors);
      }
    }
  }
}

function result(errors) {
  return { ok: errors.length === 0, errors };
}

export function validateSchemaFile(name, value) {
  const errors = [];
  checkSchema(loadCouncilSchema(name), value, "", errors);
  return result(errors);
}

function checkDecisionStance(answer, context, errors) {
  if (context?.kind !== "decision") {
    return;
  }
  const options = context.options ?? [];
  if (answer.stance === null || !options.includes(answer.stance)) {
    errors.push(`stance: must be one of ${options.map(describe).join(", ")}, got ${describe(answer.stance)}`);
  }
}

function checkUniqueIds(findings, where, errors, taken = new Set()) {
  const seen = new Set();
  findings.forEach((finding, index) => {
    if (seen.has(finding.id)) {
      errors.push(`${where}[${index}].id: ${finding.id} is used twice`);
    } else if (taken.has(finding.id)) {
      errors.push(`${where}[${index}].id: ${finding.id} is already one of your round 1 finding ids`);
    }
    seen.add(finding.id);
  });
}

// A question or open seat answers in `answer`; its stance belongs to Round 2.
function checkNullStance(answer, context, errors) {
  if (answersInOwnWords(context?.kind) && answer.stance !== null) {
    errors.push(`stance: must be null in the first round of a ${context.kind} council, got ${describe(answer.stance)}`);
  }
}

function checkRound1(answer, context, errors) {
  checkUniqueIds(answer.findings, "findings", errors);
  checkDecisionStance(answer, context, errors);
  checkNullStance(answer, context, errors);
}

function labelsText(labels) {
  return labels.length > 0 ? labels.join(", ") : "(none)";
}

// The answer labels of a question or open seat's Round 2: `sameAs` pairs of two different known
// labels and a `stance` naming one (question), or `agreesWith` known labels, each once, a null
// stance and one `answerResponses` entry per other member's answer (open; `ownAnswerLabel` is the
// seat's own label, or null). Every message names the labels the seat was given.
function checkAnswerLabels(answer, context, errors) {
  const labels = context?.answerLabels ?? [];
  const known = new Set(labels);
  const named = labelsText(labels);
  if (context.kind === "question") {
    answer.sameAs.forEach((pair, index) => {
      const where = `sameAs[${index}]`;
      if (pair.length !== 2) {
        errors.push(`${where}: must hold exactly two answer labels, got ${pair.length}`);
        return;
      }
      for (const item of pair) {
        if (!known.has(item)) {
          errors.push(`${where}: ${describe(item)} is not an answer label; the labels are ${named}`);
        }
      }
      if (pair[0] === pair[1]) {
        errors.push(`${where}: must name two different answers, got ${describe(pair[0])} twice`);
      }
    });
    if (!known.has(answer.stance)) {
      errors.push(`stance: ${describe(answer.stance)} is not an answer label; the labels are ${named}`);
    }
    return;
  }
  const seen = new Set();
  answer.agreesWith.forEach((item, index) => {
    if (!known.has(item)) {
      errors.push(`agreesWith[${index}]: ${describe(item)} is not an answer label; the labels are ${named}`);
    } else if (seen.has(item)) {
      errors.push(`agreesWith[${index}]: ${item} is listed twice`);
    }
    seen.add(item);
  });
  if (answer.stance !== null) {
    errors.push(`stance: must be null in an open council, got ${describe(answer.stance)}`);
  }
  // One response to every other member's answer: validate, challenge (with a reason) or skip.
  const others = labels.filter((item) => item !== context.ownAnswerLabel);
  const expected = new Set(others);
  const responded = new Set();
  answer.answerResponses.forEach((entry, index) => {
    const where = `answerResponses[${index}]`;
    if (!expected.has(entry.answer)) {
      errors.push(`${where}.answer: ${describe(entry.answer)} is not another member's answer label; respond to ${labelsText(others)}`);
    } else if (responded.has(entry.answer)) {
      errors.push(`${where}.answer: ${entry.answer} has more than one response`);
    }
    responded.add(entry.answer);
    if (entry.response === "challenge" && (entry.reason === null || !entry.reason.trim())) {
      errors.push(`${where}.reason: required for a challenge`);
    }
  });
  for (const item of others) {
    if (!responded.has(item)) {
      errors.push(`answerResponses: no response to answer ${item}`);
    }
  }
}

const DISPUTES = ["claim", "severity", "fix"];

function checkRound2(answer, context, errors) {
  const bundleRefs = context?.bundleRefs ?? [];
  const ownIds = new Set(context?.ownFindingIds ?? []);
  const expected = new Set(bundleRefs);
  const answered = new Set();
  answer.responses.forEach((entry, index) => {
    const where = `responses[${index}]`;
    if (!expected.has(entry.finding)) {
      errors.push(`${where}.finding: ${entry.finding} is not in the bundle`);
    } else if (answered.has(entry.finding)) {
      errors.push(`${where}.finding: ${entry.finding} has more than one response`);
    }
    answered.add(entry.finding);
    const challenge = entry.response === "challenge";
    // The schema lists no values for `disputes`, because one provider refuses an enum that holds
    // null; the values are checked here. A reason or evidence beside a validate or a skip is
    // accepted and not used.
    for (const field of ["disputes", "reason", "evidence"]) {
      if (challenge && entry[field] === null) {
        errors.push(`${where}.${field}: required for a challenge`);
      }
    }
    if (challenge && entry.disputes !== null && !DISPUTES.includes(entry.disputes)) {
      errors.push(`${where}.disputes: must be one of ${DISPUTES.join(", ")}`);
    } else if (!challenge && entry.disputes !== null) {
      errors.push(`${where}.disputes: must be null unless the response is challenge`);
    }
    if (entry.sameAs !== null) {
      if (entry.response === "skip") {
        errors.push(`${where}.sameAs: must be null on skip`);
      } else if (!ownIds.has(entry.sameAs)) {
        errors.push(`${where}.sameAs: ${entry.sameAs} is not one of your round 1 finding ids`);
      }
    }
  });
  for (const ref of bundleRefs) {
    if (!answered.has(ref)) {
      errors.push(`responses: no response to ${ref}`);
    }
  }
  checkUniqueIds(answer.added, "added", errors, ownIds);
  checkDecisionStance(answer, context, errors);
  if (answersInOwnWords(context?.kind)) {
    checkAnswerLabels(answer, context, errors);
  }
}

/**
 * Checks a follow-up answer, the canonical `{ answer, stance? }` with no other key: `answer` a
 * nonblank string, `stance` absent, null or a string; a non-null stance must name one of
 * `options` on a decision and is refused on a review. Null normalizes to omission. Returns
 * `{ ok: true, errors: [], answer }` with the normalized answer, or `{ ok: false, errors }`.
 */
export function validateFollowupAnswer(answer, { kind, options = [] } = {}) {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    return { ok: false, errors: [`answer: expected an object, got ${describe(answer)}`] };
  }
  const errors = [];
  for (const key of Object.keys(answer)) {
    if (key !== "answer" && key !== "stance") {
      errors.push(`${key}: is not an allowed property`);
    }
  }
  if (typeof answer.answer !== "string" || !answer.answer.trim()) {
    errors.push(`answer: must be a nonblank string, got ${describe(answer.answer)}`);
  }
  const stance = answer.stance ?? null;
  if (stance !== null && typeof stance !== "string") {
    errors.push(`stance: must be a string or null, got ${describe(stance)}`);
  } else if (stance !== null && kind !== "decision") {
    errors.push("stance: must be null on a review");
  } else if (stance !== null && !options.includes(stance)) {
    errors.push(`stance: must be one of ${options.map(describe).join(", ")}, got ${describe(stance)}`);
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, errors: [], answer: stance === null ? { answer: answer.answer } : { answer: answer.answer, stance } };
}

// ---------------------------------------------------------------------------------------------
// Classification of an exact provider job, and the validation context of a seat's answer.

const TRANSIENT_PATTERN = /worker-dead|launch-failed|stale-worker|stopped responding|timed out|ETIMEDOUT|ECONNRESET|EPIPE|socket hang up|\b5\d\d\b/i;
const MISSING_OUTPUT_PATTERN = /returned no structured output|no structured output/i;

/**
 * The deposit class of an exact bound job at the per-run limit `T`, or null while the job has no
 * end decision. A timely answer was claimed strictly before `created_at + T` and ended strictly
 * before `claimed_at + T`; timing is tested before any validation. Returns `{ kind, eventAt,
 * reason, timely, lateReason }`: `kind` is `missing` (no row; `job pruned or missing`),
 * `cancelled` (`job cancelled`), `waiting` (`provider waiting`), `late` (a completed job past its
 * limit, with the late reason), `completed` (timely) or `failed` (a failed or interrupted end,
 * classified further by classifyFailure). `eventAt` is the job's `end_at`, null when missing.
 */
export function classifyJob({ row, T }) {
  if (!row) {
    return { kind: "missing", eventAt: null, reason: "job pruned or missing", timely: false, lateReason: null };
  }
  if (row.end_state === null || row.end_state === undefined) {
    return null;
  }
  const eventAt = row.end_at;
  const queueBy = row.created_at + T;
  let lateReason = null;
  if (row.claimed_at === null || row.claimed_at === undefined || row.claimed_at >= queueBy) {
    lateReason = "queue deadline expired";
  } else if (row.end_at >= row.claimed_at + T) {
    lateReason = "execution deadline expired";
  }
  const timely = lateReason === null;
  if (row.end_state === "cancelled") {
    return { kind: "cancelled", eventAt, reason: "job cancelled", timely, lateReason };
  }
  if (row.end_state === "waiting") {
    return { kind: "waiting", eventAt, reason: "provider waiting", timely, lateReason };
  }
  if (row.end_state === "completed") {
    return timely
      ? { kind: "completed", eventAt, reason: null, timely, lateReason }
      : { kind: "late", eventAt, reason: lateReason, timely, lateReason };
  }
  return { kind: "failed", eventAt, reason: null, timely, lateReason };
}

function lower(value) {
  return String(value ?? "").trim().toLowerCase();
}

// Whether a normalised usage object `{ groups: [{ name, description, defaultDelegation, buckets:
// [{ remainingFraction }] }] }` holds an empty bucket in the group the job's model draws on: the
// group named after the model, or the default delegation group when the job ran on the default.
function applicableZeroBucket(normalized, { model, defaultModel }) {
  const groups = Array.isArray(normalized?.groups) ? normalized.groups : [];
  const wanted = lower(model ?? defaultModel);
  const usesDefault = !model || (defaultModel && lower(model) === lower(defaultModel));
  const applicable = groups.filter((group) => {
    if (usesDefault && group.defaultDelegation) {
      return true;
    }
    if (!wanted) {
      return false;
    }
    const name = lower(group.name);
    return name === wanted || `${name}\n${lower(group.description)}`.includes(wanted);
  });
  return applicable.some((group) => (group.buckets ?? []).some((bucket) => bucket.remainingFraction === 0));
}

// Whether a Codex rate-limit reply reports a reached limit: a raw bucket with a non-null
// `rateLimitReachedType`, or a normalised bucket with nothing left.
function codexLimitReached(usage) {
  const raw = usage?.raw ?? usage;
  const buckets = [raw?.rateLimits, ...Object.values(raw?.rateLimitsByLimitId ?? {})].filter(Boolean);
  if (buckets.some((bucket) => bucket.rateLimitReachedType !== null && bucket.rateLimitReachedType !== undefined)) {
    return true;
  }
  const normalized = usage?.normalized ?? null;
  return Boolean(normalized && (normalized.groups ?? []).some((group) => (group.buckets ?? []).some((bucket) => bucket.remainingFraction === 0)));
}

/**
 * The class of a failed or interrupted provider turn, in the contract's order: `quota` when the
 * usage read (`usage`, null when it failed or was not made) shows an applicable empty bucket
 * (Codex: a reached limit; others: an empty bucket of the model's group); `missing-output` for a
 * known missing structured output; `transient` for an interrupted end or a transient error text;
 * otherwise `final`. A failed usage read supplies no quota evidence.
 */
export function classifyFailure({ family, model = null, defaultModel = null, usage = null, row }) {
  if (usage && !usage.error) {
    const quota = family === "codex" ? codexLimitReached(usage) : applicableZeroBucket(usage.normalized ?? usage, { model, defaultModel });
    if (quota) {
      return "quota";
    }
  }
  const text = `${row?.error ?? ""}\n${row?.end_reason ?? ""}`;
  if (MISSING_OUTPUT_PATTERN.test(text)) {
    return "missing-output";
  }
  if (row?.end_state === "interrupted" || TRANSIENT_PATTERN.test(text)) {
    return "transient";
  }
  return "final";
}

function readJsonObject(readObject, runDir, sha256) {
  return JSON.parse(readObject(runDir, sha256, "json").toString("utf8"));
}

/**
 * The context validateAnswer needs for `seat`'s answer in `round`, from the committed rows of the
 * snapshot `view` (readCouncil) and their verified objects only: `{ schema, kind, options,
 * bundleRefs, ownFindingIds, answerLabels, ownAnswerLabel }`. `answerLabels` (Round 2 of a question or open run)
 * are the letters of the actor's letter map, then its own answer's label (selfLabel); a fresh Round
 * 2 stand-in, which has no answer of its own, uses the letters of its answer map (standInAnswerMap). Round 2 reads the seat's accepted Round 1 answer, the committed
 * map and the other lettered seats' Round 1 answers, each through the digest-checked reader.
 * `actor` names the answering actor when it is not the seat's original: a carried Round 1
 * stand-in (`<seat>~r1`) owns its Round 1 findings and its primary map entry; a fresh Round 2
 * stand-in (`<seat>~r2`) owns no findings and answers the bundle of its `$alternates` entry. A
 * map value with `~` names a stand-in author, whose answer is `view.actorAnswers[actor]`.
 */
export function validationContext(runDir, view, seat, round, { readObject = readStoredObject, actor = seat } = {}) {
  const kind = view.run.kind;
  const options = JSON.parse(view.run.options_json ?? "[]");
  if (round === 1) {
    return { schema: roundSchemaName(1, kind), kind, options, bundleRefs: [], ownFindingIds: [], answerLabels: [] };
  }
  const round1 = new Map(view.seatRounds.filter((row) => row.round === 1).map((row) => [row.seat, row]));
  const answerOf = (name) => {
    if (name.includes("~")) {
      const digest = view.actorAnswers?.[name];
      return digest ? readJsonObject(readObject, runDir, digest) : null;
    }
    const row = round1.get(name);
    return row?.state === "valid" && row.answer_sha256 ? readJsonObject(readObject, runDir, row.answer_sha256) : null;
  };
  const fresh = actor !== seat && actor.endsWith("~r2");
  const own = fresh ? null : answerOf(actor);
  const ownFindingIds = (own?.findings ?? []).map((finding) => finding.id);
  const round2 = view.rounds.find((row) => row.round === 2);
  const mapping = round2?.map_sha256 ? readJsonObject(readObject, runDir, round2.map_sha256) : {};
  const letterMap = (fresh ? mapping.$alternates?.[actor] : mapping[actor]) ?? {};
  const letters = Object.keys(letterMap).sort();
  const bundleRefs = [];
  for (const letter of letters) {
    const author = answerOf(letterMap[letter]);
    for (const finding of author?.findings ?? []) {
      bundleRefs.push(`${letter}-${finding.id}`);
    }
  }
  // A fresh stand-in names the answers by its own answer map, which covers every Round 1 answer.
  const answerLetters = fresh ? Object.keys(standInAnswerMap(mapping, actor) ?? {}).sort() : letters;
  const answerLabels = answersInOwnWords(kind) ? [...answerLetters, ...(own ? [selfLabel(letterMap)] : [])] : [];
  const ownAnswerLabel = answersInOwnWords(kind) && own ? selfLabel(letterMap) : null;
  return { schema: roundSchemaName(2, kind), kind, options, bundleRefs, ownFindingIds, answerLabels, ownAnswerLabel };
}

// round: 1 or 2. context: { kind, options, bundleRefs, ownFindingIds, answerLabels }; bundleRefs,
// ownFindingIds and answerLabels are used in round 2. The kind picks the round's schema. The
// round rules run only on a schema-valid answer.
// Fills what a careless but well-meant answer leaves out: a required property that the schema
// allows to be null and the answer omits becomes null, at every depth. Nothing else is changed.
function fillNullable(schema, value) {
  if (!schema || typeof schema !== "object" || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return schema.items ? value.map((item) => fillNullable(schema.items, item)) : value;
  }
  const properties = schema.properties ?? {};
  const filled = { ...value };
  for (const key of schema.required ?? []) {
    const types = [].concat(properties[key]?.type ?? []);
    if (!(key in filled) && types.includes("null")) {
      filled[key] = null;
    }
  }
  for (const [key, child] of Object.entries(properties)) {
    if (key in filled) {
      filled[key] = fillNullable(child, filled[key]);
    }
  }
  return filled;
}

// The JSON object in a reply: the reply itself, or the text between its first "{" and its last
// "}" when the reply wraps the object in a code fence or a sentence. Undefined when there is none.
function parseReplyObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) {
      return undefined;
    }
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

/**
 * The bytes of a reply in the form the council stores and validates: the JSON object of the reply
 * with omitted nullable required properties set to null. A reply that holds no JSON object is
 * returned unchanged, so its validation reports it.
 */
export function normalizeAnswerBytes(schemaName, bytes) {
  const parsed = parseReplyObject(Buffer.from(bytes).toString("utf8"));
  if (parsed === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return Buffer.from(bytes);
  }
  return Buffer.from(JSON.stringify(fillNullable(loadCouncilSchema(schemaName), parsed)), "utf8");
}

export function validateAnswer(round, answer, context = {}) {
  const schemaName = roundSchemaName(round, context?.kind);
  const schemaCheck = validateSchemaFile(schemaName, answer);
  if (!schemaCheck.ok) {
    return schemaCheck;
  }
  const errors = [];
  if (round === 1) {
    checkRound1(answer, context, errors);
  } else {
    checkRound2(answer, context, errors);
  }
  return result(errors);
}
