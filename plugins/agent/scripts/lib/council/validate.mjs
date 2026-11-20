import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Checks council answers against the round schemas and the rules a schema cannot express.
// The schema checker covers the keywords the council schemas use: type (with nullable type
// lists), enum, const, required, properties, additionalProperties (false or a schema), items,
// minLength, minimum and pattern.

const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "schemas");
const ROUND_SCHEMAS = { 1: "council-round1", 2: "council-round2" };
const schemaCache = new Map();

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

function checkRound1(answer, context, errors) {
  checkUniqueIds(answer.findings, "findings", errors);
  checkDecisionStance(answer, context, errors);
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
}

// round: 1 or 2. context: { kind, options, bundleRefs, ownFindingIds }; bundleRefs and
// ownFindingIds are used in round 2. The round rules run only on a schema-valid answer.
export function validateAnswer(round, answer, context = {}) {
  const schemaName = ROUND_SCHEMAS[round];
  if (!schemaName) {
    throw new TypeError(`Unknown council round "${round}".`);
  }
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
