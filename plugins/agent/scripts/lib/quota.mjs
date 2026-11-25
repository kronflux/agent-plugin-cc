import process from "node:process";

import { getProvider } from "./providers.mjs";
import { runCompanion } from "./runs.mjs";

// Quota evidence. A provider's own usage report (`<companion> usage --json`) says whether a limit
// is reached; the council uses it to class a failed seat, and a command that shows a failed job
// uses it to say why the job failed. Each provider says how its report is read (`quotaBuckets`)
// and which of its failures it ended itself (`endedByProvider`). A failed or late read is no
// evidence.

function providerOrNull(id) {
  try {
    return getProvider(id);
  } catch {
    return null;
  }
}

/**
 * Whether a usage read shows a reached limit for a job of the provider `providerId`. Returns
 * `{ reached, resetsAt }`, `resetsAt` being the earliest reset time the provider's empty buckets
 * give, or null. `usage` is `{ raw, normalized }` or the normalised object; null, or one with
 * `error`, is no evidence, and so is a provider that reads no usage report.
 */
export function quotaReached(providerId, usage, { model = null, defaultModel = null } = {}) {
  if (!usage || usage.error) {
    return { reached: false, resetsAt: null };
  }
  const buckets = providerOrNull(providerId)?.quotaBuckets?.(usage, { model, defaultModel }) ?? [];
  const times = buckets
    .map((bucket) => bucket.resetTime)
    .filter((time) => typeof time === "string" && !Number.isNaN(Date.parse(time)))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  return { reached: buckets.length > 0, resetsAt: times[0] ?? null };
}

/** The sentence a failed job is shown with when its provider's quota is used up. */
export function quotaSentence(label, { resetsAt = null } = {}) {
  return `${label} reports that its quota is used up.${resetsAt ? ` It resets at ${resetsAt}.` : ""}`;
}

/**
 * Reads a provider's usage through its companion's `usage --json`, stopped after `timeoutMs`.
 * Resolves to `{ raw, normalized }` (a report that carries its normalised form under `normalized`
 * keeps the whole reply as `raw`; another is the normalised object itself), or null when the read
 * failed, timed out or printed nothing readable.
 */
export async function readProviderUsage(providerId, { cwd, env = process.env, timeoutMs }) {
  const script = providerOrNull(providerId)?.companionScript;
  if (!script || !(timeoutMs > 0)) {
    return null;
  }
  const outcome = await runCompanion(script, ["usage", "--json"], { cwd, env, timeoutMs });
  if (outcome.timedOut || outcome.error || outcome.code !== 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(outcome.stdout);
    return parsed && typeof parsed === "object" ? { raw: parsed, normalized: parsed.normalized ?? parsed } : null;
  } catch {
    return null;
  }
}

// What a provider says when a limit is reached, in the words the CLIs and their services use.
const QUOTA_TEXT = /quota (?:exhausted|reached|exceeded|has been exhausted)|RESOURCE_EXHAUSTED|usage limit|hit your (?:usage )?limit|reached your [^\n]{0,40}limit|rate limit|insufficient[_ ]quota|insufficient balance/i;
// Failures the plugin words itself. Their text can quote a path or a command, so it is never
// searched for a provider's quota words.
const PLUGIN_FAILURE = /was denied permission|read-only (?:task|guard)|without an answer|did not answer within|unexpected review shape|structured (?:output|result)|was cancelled|was interrupted/i;

/**
 * True when a failed turn's error may come from a reached limit: the provider ended the turn
 * itself without saying why (`endedByProvider`), or the error uses a provider's words for a
 * limit. The plugin's own refusals (a denied permission, the read-only guard, a missing
 * structured answer, a time limit) are not.
 */
export function mayBeQuotaFailure(error, providerId = null) {
  const text = String(error ?? "");
  if (providerOrNull(providerId)?.endedByProvider?.(text)) {
    return true;
  }
  return !PLUGIN_FAILURE.test(text) && QUOTA_TEXT.test(text);
}

/** How long a command waits for the usage read of a failed job it shows. */
export const QUOTA_NOTE_TIMEOUT_MS = 10000;

/**
 * The sentence to show under the error of a failed job, or null: when the error may come from a
 * reached limit (mayBeQuotaFailure) and the provider's usage report, read within `timeoutMs`,
 * shows one for the job's model. Never throws; any failure of the read gives null.
 */
export async function quotaNoteFor({ provider, model = null, error, cwd, env = process.env, timeoutMs = QUOTA_NOTE_TIMEOUT_MS, readUsage = readProviderUsage }) {
  if (!mayBeQuotaFailure(error, provider)) {
    return null;
  }
  try {
    // The read has its own time limit; this one also bounds a read that never settles.
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs + 1000);
    });
    const usage = await Promise.race([readUsage(provider, { cwd, env, timeoutMs }), late]).finally(() => clearTimeout(timer));
    const found = quotaReached(provider, usage, { model });
    return found.reached ? quotaSentence(getProvider(provider).label, found) : null;
  } catch {
    return null;
  }
}

/**
 * The quota sentence for a job view a command is about to show, or null: only a failed job is
 * asked about. `cwd` is the folder the provider's usage command runs in.
 */
export async function quotaNoteForView(view, { cwd, env = process.env, readUsage = readProviderUsage } = {}) {
  if (view?.state !== "failed") {
    return null;
  }
  return quotaNoteFor({ provider: view.provider, model: view.row?.model ?? null, error: view.row?.error, cwd: cwd ?? view.row?.cwd, env, readUsage });
}
