import { runCommand } from "../../lib/process.mjs";
import { agyEnv } from "./runtime.mjs";

// The Antigravity quota report: `agy --print /usage --output-format json` prints one object whose
// `command.data.groups` holds the quota groups and their buckets, and whose `response` holds the
// same buckets as tab-separated lines.

const USAGE_ARGS = ["--print", "/usage", "--output-format", "json"];

/**
 * Runs agy's /usage command (no stdin line, no job) and resolves to `{ ok: true, raw }` with the
 * parsed object, or `{ ok: false, reason, output }`.
 */
export function readAgyUsage(cwd, { env = process.env, timeoutMs = 30000 } = {}) {
  const result = runCommand("agy", USAGE_ARGS, { cwd, env: agyEnv(env), timeout: timeoutMs, input: "" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) {
    const reason = result.error.code === "ETIMEDOUT" ? `agy did not answer within ${Math.round(timeoutMs / 1000)} s` : `agy could not be run: ${result.error.message}`;
    return { ok: false, reason, output };
  }
  const line = String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("{"))
    .at(-1);
  try {
    return { ok: true, raw: JSON.parse(line) };
  } catch {
    const ending = result.status === null ? `was ended by ${result.signal}` : `exited with code ${result.status}`;
    return { ok: false, reason: `agy ${ending} without a quota report`, output };
  }
}

function fractionOf(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}

// An ISO 8601 UTC time for a time agy printed, or null when it cannot be read.
function utcTimeOf(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(value.trim())) {
    return value.trim();
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

// The groups of the tab-separated lines: group, bucket, percentage and reset time per line.
function groupsFromText(response) {
  const groups = [];
  for (const line of String(response ?? "").split(/\r?\n/)) {
    const columns = line.split("\t");
    if (columns.length !== 4 || !columns[0].trim() || !columns[1].trim()) {
      continue;
    }
    const [groupName, bucketName, percentage, time] = columns.map((column) => column.trim());
    const percent = /^(\d+(?:\.\d+)?)%$/.exec(percentage);
    let group = groups.find((entry) => entry.name === groupName);
    if (!group) {
      group = { name: groupName, description: null, buckets: [] };
      groups.push(group);
    }
    group.buckets.push({ id: null, name: bucketName, window: null, remainingFraction: percent ? fractionOf(Number(percent[1]) / 100) : null, resetTime: utcTimeOf(time) });
  }
  return groups;
}

/**
 * The quota groups of a /usage object: from `command.data.groups` when present, else from the
 * tab-separated lines of `response` (whose buckets have no id, window or description). A status
 * other than SUCCESS, or no group in either source, gives `{ error }`.
 */
export function parseAgyUsage(raw) {
  if (!raw || typeof raw !== "object") {
    return { error: "agy printed no quota report" };
  }
  if (String(raw.status ?? "") !== "SUCCESS") {
    const detail = typeof raw.response === "string" && raw.response.trim() ? `: ${raw.response.trim()}` : "";
    return { error: `agy reported ${raw.status ?? "no status"}${detail}` };
  }
  const structured = raw.command?.data?.groups;
  const groups = Array.isArray(structured)
    ? structured.map((group) => ({
        name: String(group?.name ?? ""),
        description: typeof group?.description === "string" ? group.description : null,
        buckets: (Array.isArray(group?.buckets) ? group.buckets : []).map((bucket) => ({
          id: typeof bucket?.id === "string" ? bucket.id : null,
          name: String(bucket?.name ?? bucket?.id ?? ""),
          window: typeof bucket?.window === "string" ? bucket.window : null,
          remainingFraction: fractionOf(bucket?.remaining_fraction),
          resetTime: utcTimeOf(bucket?.reset_time)
        }))
      }))
    : groupsFromText(raw.response);
  if (groups.length === 0) {
    return { error: "agy reported no quota groups" };
  }
  return { groups };
}

/** The normalised usage object (schema 1) of parsed Antigravity quota groups. */
export function normalizeAgyUsage(parsed, { now = new Date() } = {}) {
  return {
    schema: 1,
    provider: "agy",
    fetchedAt: new Date(now).toISOString(),
    groups: parsed.groups.map((group) => ({
      name: group.name,
      description: group.description ?? null,
      defaultDelegation: Boolean(group.defaultDelegation),
      buckets: group.buckets.map((bucket) => ({
        id: bucket.id ?? null,
        name: bucket.name,
        window: bucket.window ?? null,
        remainingFraction: bucket.remainingFraction ?? null,
        resetTime: bucket.resetTime ?? null
      }))
    }))
  };
}

// "YYYY-MM-DD HH:mm <short zone name>" for an ISO time in `timeZone`.
function formatReset(iso, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" })
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

/**
 * The text report of a normalised usage object: one block per group (its name, marked when the
 * default delegation uses it, its description, then one line per bucket with the percentage left
 * and the reset time in `timeZone`). `notes` are lines printed under the heading.
 */
export function renderAgyUsageReport(normalized, { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, notes = [] } = {}) {
  const lines = ["# Antigravity Usage", ""];
  if (notes.length > 0) {
    lines.push(...notes, "");
  }
  normalized.groups.forEach((group, index) => {
    if (index > 0) {
      lines.push("");
    }
    lines.push(group.defaultDelegation ? `${group.name} (used by default delegation)` : group.name);
    if (group.description) {
      lines.push(group.description);
    }
    for (const bucket of group.buckets) {
      const left = bucket.remainingFraction === null ? "unknown left" : `${Math.round(bucket.remainingFraction * 100)}% left`;
      const reset = bucket.resetTime ? `, resets ${formatReset(bucket.resetTime, timeZone)}` : "";
      lines.push(`- ${bucket.name}: ${left}${reset}`);
    }
  });
  return `${lines.join("\n")}\n`;
}

/**
 * A display name without one trailing " (<word>)" when the word, lower-cased, is an effort agy
 * lists in `efforts` or one of low, medium and high; any other qualifier stays.
 */
export function stripEffortSuffix(displayName, efforts = []) {
  const known = new Set([...efforts.map((effort) => String(effort).toLowerCase()), "low", "medium", "high"]);
  const match = /^(.*\S)\s+\(([^()]+)\)$/.exec(String(displayName ?? ""));
  return match && known.has(match[2].trim().toLowerCase()) ? match[1] : String(displayName ?? "");
}

/**
 * Marks at most one group as the one a default delegation uses: the first whose name equals
 * `name` (case-insensitive), else the first, in group order, whose name or description contains
 * it; without a match none is marked. Returns new group objects.
 */
export function markDefaultGroup(groups, name) {
  const wanted = String(name ?? "").trim().toLowerCase();
  let index = -1;
  if (wanted) {
    index = groups.findIndex((group) => String(group.name ?? "").toLowerCase() === wanted);
    if (index === -1) {
      index = groups.findIndex((group) => `${group.name ?? ""}\n${group.description ?? ""}`.toLowerCase().includes(wanted));
    }
  }
  return groups.map((group, position) => ({ ...group, defaultDelegation: position === index }));
}

/** The line a report prints when no delegation model is known. */
export const UNKNOWN_DELEGATION_MODEL_LINE = "Default delegation model: unknown (no model key in the Antigravity settings).";
