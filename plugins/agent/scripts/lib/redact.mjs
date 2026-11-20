// Credential shapes that job summaries and error messages must not keep. Each match is
// replaced with "[redacted]"; for name=value assignments and JSON pairs only the value is
// replaced, and a quoted value keeps its quotes.
//
// Every pattern takes time linear in the text length: each unbounded quantifier either starts
// where the pattern cannot start again inside the span it scans (a lookbehind on the
// complement of its class, or a literal the class cannot hold), or always succeeds after a long
// scan. tests/redact.test.mjs times each pattern in REDACTION_PATTERNS against that rule.
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g
];
// A JWT is "eyJ" after the text start or a character outside [A-Za-z0-9_], then three
// dot-separated parts of [A-Za-z0-9_-], each at least eight characters long after "eyJ". This
// pattern finds the runs of JWT characters and dots; redactJwts finds the JWTs inside each run in
// code, because a single pattern that may start after a hyphen restarts inside every run it
// scans.
const JWT_RUN_PATTERN = /(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]+/g;
const JWT_PART_MIN_LENGTH = 8;
const BEARER_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const BASIC_AUTH_PATTERN = /\b(Authorization\s*[:=]\s*Basic\s+)[A-Za-z0-9._~+/=-]+/gi;
// The password in the user information of a URL: scheme://user:password@host. The match starts
// at the literal "://", which neither the user nor the password can hold.
const URL_PASSWORD_PATTERN = /(:\/\/[^\s:@/]+:)([^\s@/]+)(@)/g;
// A name and its separator; the value that follows is read by VALUE_PATTERN only when the name is
// a credential name, so a plain assignment never hides a credential later in the same word.
const ASSIGNMENT_NAME_PATTERN = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)(\s*[:=]\s*)/g;
// An unquoted value runs to the next whitespace, so a comma or semicolon inside it is redacted too.
const VALUE_PATTERN = /"[^"]*"|'[^']*'|[^\s"']\S*/y;
// The value scan ends at the next unescaped quote, which a later match would need to start.
const JSON_PAIR_PATTERN = /("([A-Za-z0-9_.-]+)"\s*:\s*")((?:[^"\\]|\\.)*)(")/g;
// A credential name contains one of these words anywhere, so AWS_SECRET_ACCESS_KEY,
// client_secret and DB_PASSWORD all count, whatever the name's length.
const CREDENTIAL_WORD = /secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential/i;
// Names such as input_tokens and prompt_token_count hold counts, not credentials.
const COUNT_NAME = /_tokens$|_token_count$/i;

export const REDACTED = "[redacted]";

export const REDACTION_PATTERNS = Object.freeze([
  ...SECRET_PATTERNS,
  JWT_RUN_PATTERN,
  BEARER_PATTERN,
  BASIC_AUTH_PATTERN,
  URL_PASSWORD_PATTERN,
  ASSIGNMENT_NAME_PATTERN,
  VALUE_PATTERN,
  JSON_PAIR_PATTERN
]);

function isCredentialName(name) {
  return CREDENTIAL_WORD.test(name) && !COUNT_NAME.test(name);
}

function redactJsonValue(match, head, name, _value, close) {
  return isCredentialName(name) ? `${head}${REDACTED}${close}` : match;
}

function redactAssignments(text) {
  const names = new RegExp(ASSIGNMENT_NAME_PATTERN.source, ASSIGNMENT_NAME_PATTERN.flags);
  const values = new RegExp(VALUE_PATTERN.source, VALUE_PATTERN.flags);
  let result = "";
  let copied = 0;
  for (let match = names.exec(text); match; match = names.exec(text)) {
    if (!isCredentialName(match[1])) {
      continue;
    }
    values.lastIndex = names.lastIndex;
    const value = values.exec(text);
    if (!value) {
      continue;
    }
    const quote = value[0][0] === "\"" || value[0][0] === "'" ? value[0][0] : "";
    result += `${text.slice(copied, names.lastIndex)}${quote}${REDACTED}${quote}`;
    copied = values.lastIndex;
    names.lastIndex = values.lastIndex;
  }
  return result + text.slice(copied);
}

// Returns the offset in `part` where a JWT can start, or -1: the first "eyJ" at the part's start
// or after a hyphen. A later start in the same part leaves a shorter first part, so the first one
// is the only candidate.
function jwtStartIn(part) {
  for (let index = part.indexOf("eyJ"); index !== -1; index = part.indexOf("eyJ", index + 1)) {
    if (index === 0 || part[index - 1] === "-") {
      return index;
    }
  }
  return -1;
}

// Redacts every JWT in a run of [A-Za-z0-9_.-]. A JWT ends at the end of its third part, so the
// scan resumes at the part after it.
function redactJwtsInRun(run) {
  const parts = run.split(".");
  const output = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const start = index + 2 < parts.length ? jwtStartIn(part) : -1;
    if (
      start !== -1 &&
      part.length - start - 3 >= JWT_PART_MIN_LENGTH &&
      parts[index + 1].length >= JWT_PART_MIN_LENGTH &&
      parts[index + 2].length >= JWT_PART_MIN_LENGTH
    ) {
      output.push(`${part.slice(0, start)}${REDACTED}`);
      index += 2;
    } else {
      output.push(part);
    }
  }
  return output.join(".");
}

function redactJwts(text) {
  return text.replace(JWT_RUN_PATTERN, (run) => (run.includes("eyJ") ? redactJwtsInRun(run) : run));
}

export function redactSecrets(text) {
  if (typeof text !== "string" || text === "") {
    return text;
  }
  let result = text
    .replace(BEARER_PATTERN, `$1${REDACTED}`)
    .replace(BASIC_AUTH_PATTERN, `$1${REDACTED}`)
    .replace(URL_PASSWORD_PATTERN, `$1${REDACTED}$3`)
    .replace(JSON_PAIR_PATTERN, redactJsonValue);
  result = redactAssignments(result);
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return redactJwts(result);
}
