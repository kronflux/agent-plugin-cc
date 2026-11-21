// Chooses the model and reasoning effort a job runs with. Each provider's model catalog
// resolves and checks the values; this module only decides which choice applies, in this order:
// the command line, the job a follow-up continues, the workspace setting, the user setting, the
// provider default.

import { delegationSetting } from "./settings.mjs";
import { getConfig, getUserConfig, setConfig, updateUserConfig } from "./state.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

// Sources whose catalog entry also names the effort used when none is given.
const CATALOG_SOURCES = new Set(["catalog-default", "family-fallback"]);

function isGiven(value) {
  return value != null && String(value).trim() !== "";
}

// The job source of a model or effort that a stored setting chose, by where the setting is kept.
const SETTING_SOURCES = { project: "setting", user: "user-setting" };

/**
 * The delegation setting of `provider` for the workspace of `cwd`: `{ setting, source }`, the
 * workspace setting first, then the user setting (see `delegationSetting`).
 */
export function readModelSetting(provider, cwd) {
  try {
    return delegationSetting(provider, resolveWorkspaceRoot(cwd));
  } catch {
    return { setting: null, source: "provider-default" };
  }
}

/** The `setting` and `settingSource` options of `resolveModelSelection` for `workspaceRoot`. */
export function delegationOptions(provider, workspaceRoot) {
  const { setting, source } = delegationSetting(provider, workspaceRoot);
  return { setting, settingSource: source };
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
 * `options.setting` is the stored delegation setting `{ model, effort }` and `options.settingSource`
 * where it is kept (`project` or `user`); when the setting is undefined both are read from the
 * workspace and user settings. `options.stored` is what `storedSelection` returned for the job a
 * follow-up continues: its values are used as they are, with their sources, unless the command
 * gives its own; a stored effort is dropped, with a warning, when the command gives a new model
 * that does not accept it. A given effort goes through `catalog.checkEffort`, which throws when
 * the model does not support it; with a stored model it is checked against that model's efforts.
 *
 * Returns `{ model, effort, modelSource, effortSource, warnings }`; a source is one of
 * `explicit`, `setting` (workspace), `user-setting`, `catalog-default`, `family-fallback`, `provider-default`, or the stored
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
  let settingSource = "setting";
  if (!usesStoredModel || !(isGiven(options?.effort) || stored?.effort)) {
    const read = options?.setting === undefined ? readModelSetting(provider, cwd) : { setting: options.setting, source: options.settingSource ?? "project" };
    setting = read.setting;
    settingSource = SETTING_SOURCES[read.source] ?? "setting";
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
    resolved = await resolveChoice(catalog, setting.model, settingSource, context);
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
  // Where the effort came from: the command, the continued job, a stored setting, the catalog.
  let effortOrigin = "none";
  if (isGiven(options?.effort)) {
    effort = await catalog.checkEffort(options.effort, resolved.efforts ?? null, effortContext);
    effortSource = "explicit";
    effortOrigin = "command";
  } else if (inherited) {
    effort = inherited.value;
    effortSource = inherited.source;
    effortOrigin = "inherited";
  } else if (!stored?.effort && !forcedDefault && isGiven(setting?.effort)) {
    effort = await catalog.checkEffort(setting.effort, resolved.efforts ?? null, effortContext);
    effortSource = settingSource;
    effortOrigin = "setting";
  } else if (resolved.defaultEffort) {
    effort = resolved.defaultEffort;
    effortSource = CATALOG_SOURCES.has(resolved.source) ? resolved.source : "catalog-default";
    effortOrigin = "catalog";
  }

  const selection = {
    model: resolved.model ?? null,
    effort: effort ?? null,
    modelSource: resolved.source,
    effortSource,
    warnings
  };
  // A catalog whose models carry their effort in the id joins the two here; it may refuse the pair.
  if (typeof catalog.finishSelection === "function") {
    const modelOrigin = requestedModel ? "command" : usesStoredModel ? "inherited" : isGiven(setting?.model) ? "setting" : "default";
    return catalog.finishSelection(selection, { ...context, effortOrigin, modelOrigin });
  }
  return selection;
}

/**
 * Works out the delegation default of `provider` from `--model` and `--effort`, after checking
 * that a delegation could use it, without writing it. `scope` is `project` (the workspace config)
 * or `user` (the user config); the current entry of that scope is the base. `--model default`
 * clears the setting to null, so the provider default and its own effort apply; an `--effort`
 * given with it is not stored. `--effort` alone keeps the stored model, or applies to the default
 * model when none is stored. `--model` alone clears the stored effort, so the model's own default
 * effort applies.
 *
 * Returns `{ value, action, warnings }`, or null when neither option was given. `value` is the new
 * entry for `models.<provider>`. `warnings` are the resolution's warning lines, such as the one
 * for a model no catalog could check; the action then says the model was stored without a check.
 */
export async function planDelegationSetting(provider, workspaceRoot, cwd, options, { scope = "project" } = {}) {
  const hasModel = options.model !== undefined && String(options.model).trim() !== "";
  const hasEffort = options.effort !== undefined && String(options.effort).trim() !== "";
  if (!hasModel && !hasEffort) {
    return null;
  }
  const models = (scope === "user" ? getUserConfig().models : getConfig(workspaceRoot).models) ?? {};
  const current = models[provider.id] ?? null;
  const where = scope === "user" ? "in every workspace without its own setting" : `in ${workspaceRoot}`;
  if (hasModel && String(options.model).trim().toLowerCase() === "default") {
    const ignored = hasEffort ? " --effort was not stored, because --model default clears the setting." : "";
    return { value: null, base: current, dependsOnCurrent: false, action: `Delegations now use the default model ${where}.${ignored}`, warnings: [] };
  }
  const model = hasModel ? String(options.model).trim() : current?.model ?? null;
  const effort = hasEffort ? String(options.effort).trim() : hasModel ? null : current?.effort ?? null;
  // The values are resolved as a delegation would resolve them, so a bad choice is never stored.
  const checked = await resolveModelSelection(provider, { model, effort, setting: null, cwd });
  const stored = model || effort ? { model, effort: effort ? checked.effort : null } : null;
  const withEffort = stored?.effort ? ` with effort ${stored.effort}` : "";
  let action;
  if (!stored) {
    action = `Delegations now use the default model ${where}.`;
  } else if (stored.model && checked.warnings.length > 0) {
    action = `Stored model ${stored.model}${withEffort} for delegations ${where} without checking it.`;
  } else {
    const modelText = !stored.model
      ? "the default model"
      : stored.model.toLowerCase() === "configured"
        ? `the model set in the ${provider.label} configuration`
        : `model ${stored.model}`;
    action = `Delegations now use ${modelText}${withEffort} ${where}.`;
  }
  // Without --model the stored model is kept, so the result holds only while that entry does.
  return { value: stored, base: current, dependsOnCurrent: !hasModel, action, warnings: checked.warnings };
}

class UserSettingChanged extends Error {}
const USER_SETUP_ATTEMPTS = 3;

/**
 * Plans the user-scope delegation default of `provider` and writes it, with `writeSandbox` when
 * given, in one locked update of the user config. A plan that keeps the stored model is written
 * only when the locked config still holds the entry it was planned from; otherwise it is planned
 * again, at most three times. `hooks.beforeStore` (tests) runs between a plan and its write.
 * Returns what `planDelegationSetting` returned, or null when nothing was given.
 */
export async function storeUserSetup(provider, workspaceRoot, cwd, options, { writeSandbox = null, hooks = null } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const planned = await planDelegationSetting(provider, workspaceRoot, cwd, options, { scope: "user" });
    if (!planned && !writeSandbox) {
      return null;
    }
    hooks?.beforeStore?.(attempt);
    try {
      updateUserConfig((config) => {
        const now = JSON.stringify(config.models?.[provider.id] ?? null);
        if (planned?.dependsOnCurrent && now !== JSON.stringify(planned.base ?? null)) {
          throw new UserSettingChanged();
        }
        return {
          ...config,
          ...(planned ? { models: { ...config.models, [provider.id]: planned.value } } : {}),
          ...(writeSandbox ? { writeSandbox } : {})
        };
      });
      return planned;
    } catch (error) {
      if (!(error instanceof UserSettingChanged)) {
        throw error;
      }
      if (attempt >= USER_SETUP_ATTEMPTS) {
        throw new Error("The user delegation setting kept changing during setup; nothing was written. Run setup again.");
      }
    }
  }
}

/**
 * Stores the delegation default of `provider` in the workspace config, as `planDelegationSetting`
 * works it out. Returns `{ action, warnings }`, or null when neither option was given.
 */
export async function storeDelegationSetting(provider, workspaceRoot, cwd, options) {
  const planned = await planDelegationSetting(provider, workspaceRoot, cwd, options);
  if (!planned) {
    return null;
  }
  const models = getConfig(workspaceRoot).models ?? {};
  setConfig(workspaceRoot, "models", { ...models, [provider.id]: planned.value });
  return { action: planned.action, warnings: planned.warnings };
}

/**
 * The model and effort a delegation of `provider` would use now, and how each is chosen. A
 * stored setting that no longer resolves is reported with its error.
 */
export async function describeDelegation(provider, workspaceRoot, cwd) {
  try {
    const delegation = delegationSetting(provider, workspaceRoot);
    const selection = await resolveModelSelection(provider, {
      setting: delegation.setting,
      settingSource: delegation.source,
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

// The report words for a job source that names where a setting came from.
const SOURCE_LABELS = { explicit: "flag", setting: "project setting", "user-setting": "user setting" };

/** The check lines that name the delegation model and effort. */
export function delegationLines(delegation, { chosenBy, modelName = null }) {
  if (delegation.error) {
    return [`- delegation model: unavailable (${delegation.error})`];
  }
  const model = delegation.model ?? modelName ?? `chosen by ${chosenBy}`;
  const label = (source) => SOURCE_LABELS[source] ?? source;
  return [
    `- delegation model: ${model} (${label(delegation.modelSource)})`,
    `- delegation effort: ${delegation.effort ?? "default"} (${label(delegation.effortSource)})`
  ];
}
