// Credential shapes that job summaries and error messages must not keep. Each match is
// replaced with "[redacted]"; for name=value assignments only the value is replaced.
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
];
const BEARER_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const ASSIGNMENT_PATTERN =
  /\b((?:api[_-]?key|access[_-]?key|secret|token|password|passwd|credential)s?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s"',;]+)/gi;

export const REDACTED = "[redacted]";

export function redactSecrets(text) {
  if (typeof text !== "string" || text === "") {
    return text;
  }
  let result = text.replace(BEARER_PATTERN, `$1${REDACTED}`).replace(ASSIGNMENT_PATTERN, `$1${REDACTED}`);
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}
