// Chooses the model and reasoning effort a job runs with. Each provider's model catalog
// resolves and checks the values; this module only decides which choice applies, in this order:
// the command line, the job a follow-up continues, the workspace setting, the provider default.

import { DEFAULT_PROVIDER_ID } from "./providers.mjs";
import { getConfig, listJobs, setConfig } from "./state.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

// Sources whose catalog entry also names the effort used when none is given.
const CATALOG_SOURCES = new Set(["catalog-default", "family-fallback"]);

function isGiven(value) {
  return value != null && String(value).trim() !== "";
}

/** The delegation setting stored for `provider` in the workspace of `cwd`, or null. */
export function readModelSetting(provider, cwd) {
  try {
    return getConfig(resolveWorkspaceRoot(cwd)).models?.[provider.id] ?? null;
  } catch {
    return null;
  }
}

/**
 * The newest job record of `providerId` on `threadId`, which a follow-up turn on that thread
 * continues; null when none is recorded. A record without a provider belongs to the default
 * provider.
 */
export function newestJobOnThread(workspaceRoot, providerId, threadId) {
  if (!threadId) {
    return null;
  }
  const jobs = listJobs(workspaceRoot).filter(
    (job) => (job.provider ?? DEFAULT_PROVIDER_ID) === providerId && job.threadId === threadId
  );
  jobs.sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
  return jobs[0] ?? null;
}

/**
 * What a continued job recorded about its model and effort: for each of `model` and `effort`,
 * `{ value, source }` when the record has the field, including a null value, and null when a
 * record written before the field existed lacks it.
 */
export function storedSelection(job) {
  if (!job) {
    return null;
  }
  const field = (key, sourceKey) =>
    Object.hasOwn(job, key) ? { value: job[key] ?? null, source: job[sourceKey] ?? null } : null;
  return { model: field("model", "modelSource"), effort: field("effort", "effortSource") };
}

// Resolves one model choice: "default" names the provider's default, "configured" sends no model,
// and any other value is checked by the catalog.
async function resolveChoice(catalog, value, source, context) {
  const word = String(value).trim();
  const keyword = word.toLowerCase();
  if (keyword === "default") {
    return catalog.resolveDefault(context);
  }
  if (keyword === "configured") {
    return { model: null, source: source === "explicit" ? "provider-default" : source, efforts: null, defaultEffort: null };
  }
  return { ...(await catalog.resolveExplicit(word, context)), source };
}

// The efforts the catalog lists for a model a follow-up keeps, or null when the catalog has no
// entry with exactly that id, so a new effort is checked as for a model without an entry. A
// family word that matches another id is no entry: the kept id is sent as it is.
async function keptModelEfforts(catalog, model, context) {
  try {
    const entry = await catalog.resolveExplicit(model, context);
    return entry.model === model ? entry.efforts ?? null : null;
  } catch {
    return null;
  }
}

/**
 * Resolves `options.model` and `options.effort` through `catalog`.
 *
 * `options.setting` is the stored delegation setting `{ model, effort }`; when it is undefined it
 * is read from the workspace. `options.stored` is what `storedSelection` returned for the job a
 * follow-up continues: its values are used as they are, with their sources, unless the command
 * gives its own; a stored effort is dropped, with a warning, when the command gives a new model
 * that does not accept it. A given effort goes through `catalog.checkEffort`, which throws when
 * the model does not support it; with a stored model it is checked against that model's efforts.
 *
 * Returns `{ model, effort, modelSource, effortSource, warnings }`; a source is one of
 * `explicit`, `setting`, `catalog-default`, `family-fallback`, `provider-default`, or the stored
 * source of a continued job.
 */
export async function resolveModelSelection(provider, options = {}, catalog = provider.modelCatalog) {
  const cwd = options?.cwd;
  const context = { cwd, cache: {} };
  const stored = options?.stored ?? null;
  const warnings = [];
  const requestedModel = isGiven(options?.model) ? String(options.model).trim() : null;
  const usesStoredModel = !requestedModel && Boolean(stored?.model);
  let setting = null;
  if (!usesStoredModel || !(isGiven(options?.effort) || stored?.effort)) {
    setting = options?.setting === undefined ? readModelSetting(provider, cwd) : options.setting;
  }
  // --model default chooses the provider default and leaves the stored setting aside entirely.
  const forcedDefault = requestedModel?.toLowerCase() === "default";

  let resolved;
  if (requestedModel) {
    resolved = await resolveChoice(catalog, requestedModel, "explicit", context);
  } else if (usesStoredModel) {
    resolved = { model: stored.model.value, source: stored.model.source, efforts: null, defaultEffort: null };
    // A new effort is checked against the model the follow-up keeps.
    if (isGiven(options?.effort) && resolved.model) {
      resolved.efforts = await keptModelEfforts(catalog, resolved.model, context);
    }
  } else if (isGiven(setting?.model)) {
    resolved = await resolveChoice(catalog, setting.model, "setting", context);
  } else {
    resolved = await catalog.resolveDefault(context);
  }
  if (resolved.warning) {
    warnings.push(resolved.warning);
  }

  const effortContext = { ...context, model: resolved.model ?? null };
  let effort = null;
  let effortSource = "provider-default";
  // A follow-up that names a new model keeps the continued job's effort only when that model
  // accepts it, for example when the model's id does not set another effort. Otherwise the new
  // model's own default effort applies, and one warning says so. A model without a catalog entry
  // keeps it, because the catalog says nothing about that model's efforts.
  let inherited = isGiven(options?.effort) ? null : stored?.effort ?? null;
  if (inherited && requestedModel && isGiven(inherited.value)) {
    try {
      await catalog.checkEffort(inherited.value, resolved.efforts ?? null, { ...effortContext, inherited: true });
    } catch {
      warnings.push(
        `Effort ${inherited.value} of the continued job does not apply to model ${resolved.model ?? requestedModel}, so it was not used.`
      );
      inherited = null;
    }
  }
  if (isGiven(options?.effort)) {
    effort = await catalog.checkEffort(options.effort, resolved.efforts ?? null, effortContext);
    effortSource = "explicit";
  } else if (inherited) {
    effort = inherited.value;
    effortSource = inherited.source;
  } else if (!stored?.effort && !forcedDefault && isGiven(setting?.effort)) {
    effort = await catalog.checkEffort(setting.effort, resolved.efforts ?? null, effortContext);
    effortSource = "setting";
  } else if (resolved.defaultEffort) {
    effort = resolved.defaultEffort;
    effortSource = CATALOG_SOURCES.has(resolved.source) ? resolved.source : "catalog-default";
  }

  return {
    model: resolved.model ?? null,
    effort: effort ?? null,
    modelSource: resolved.source,
    effortSource,
    warnings
  };
}

/**
 * Stores the delegation default of `provider` from `--model` and `--effort` in the workspace
 * config, after checking that a delegation could use it. `--model default` clears the setting to
 * null, so the provider default and its own effort apply; an `--effort` given with it is not
 * stored. `--effort` alone keeps the stored model, or applies to the default model when none is
 * stored. `--model` alone clears the stored effort, so the model's own default effort applies.
 *
 * Returns `{ action, warnings }`, or null when neither option was given. `warnings` are the
 * resolution's warning lines, such as the one for a model no catalog could check; the action then
 * says the model was stored without a check.
 */
export async function storeDelegationSetting(provider, workspaceRoot, cwd, options) {
  const hasModel = options.model !== undefined && String(options.model).trim() !== "";
  const hasEffort = options.effort !== undefined && String(options.effort).trim() !== "";
  if (!hasModel && !hasEffort) {
    return null;
  }
  const models = getConfig(workspaceRoot).models ?? {};
  const current = models[provider.id] ?? null;
  if (hasModel && String(options.model).trim().toLowerCase() === "default") {
    setConfig(workspaceRoot, "models", { ...models, [provider.id]: null });
    const ignored = hasEffort ? " --effort was not stored, because --model default clears the setting." : "";
    return { action: `Delegations now use the default model in ${workspaceRoot}.${ignored}`, warnings: [] };
  }
  const model = hasModel ? String(options.model).trim() : current?.model ?? null;
  const effort = hasEffort ? String(options.effort).trim() : hasModel ? null : current?.effort ?? null;
  // The values are resolved as a delegation would resolve them, so a bad choice is never stored.
  const checked = await resolveModelSelection(provider, { model, effort, setting: null, cwd });
  const stored = model || effort ? { model, effort: effort ? checked.effort : null } : null;
  setConfig(workspaceRoot, "models", { ...models, [provider.id]: stored });
  const withEffort = stored?.effort ? ` with effort ${stored.effort}` : "";
  let action;
  if (!stored) {
    action = `Delegations now use the default model in ${workspaceRoot}.`;
  } else if (stored.model && checked.warnings.length > 0) {
    action = `Stored model ${stored.model}${withEffort} for delegations in ${workspaceRoot} without checking it.`;
  } else {
    const modelText = !stored.model
      ? "the default model"
      : stored.model.toLowerCase() === "configured"
        ? `the model set in the ${provider.label} configuration`
        : `model ${stored.model}`;
    action = `Delegations now use ${modelText}${withEffort} in ${workspaceRoot}.`;
  }
  return { action, warnings: checked.warnings };
}

/**
 * The model and effort a delegation of `provider` would use now, and how each is chosen. A
 * stored setting that no longer resolves is reported with its error.
 */
export async function describeDelegation(provider, workspaceRoot, cwd) {
  try {
    const selection = await resolveModelSelection(provider, {
      setting: getConfig(workspaceRoot).models?.[provider.id] ?? null,
      cwd
    });
    return {
      model: selection.model,
      effort: selection.effort,
      modelSource: selection.modelSource,
      effortSource: selection.effortSource
    };
  } catch (error) {
    return { model: null, effort: null, modelSource: null, effortSource: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The check lines that name the delegation model and effort. */
export function delegationLines(delegation, { chosenBy, modelName = null }) {
  if (delegation.error) {
    return [`- delegation model: unavailable (${delegation.error})`];
  }
  const model = delegation.model ?? modelName ?? `chosen by ${chosenBy}`;
  return [
    `- delegation model: ${model} (${delegation.modelSource})`,
    `- delegation effort: ${delegation.effort ?? "default"} (${delegation.effortSource})`
  ];
}
