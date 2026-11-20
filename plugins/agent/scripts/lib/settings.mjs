// Resolves one plugin setting from the places that can hold it, in this order: the command's
// flag, the workspace (project) config, the user config, the provider default. A project value
// that is present but null, as `setup --model default` writes it, stops the chain at the
// provider default, so a repository can always choose the default over the user's setting.

import { getConfig, getUserConfig } from "./state.mjs";

const DEFAULT_WRITE_SANDBOX = "workspace-write";

function isGiven(value) {
  return value != null && String(value).trim() !== "";
}

/**
 * The delegation setting `{ model, effort }` of `provider` and where it comes from:
 * `{ setting, source }` with source `project`, `user` or `provider-default` (setting null).
 * The project entry wins whenever it is present, including a null entry.
 */
export function delegationSetting(provider, workspaceRoot) {
  const providerId = typeof provider === "string" ? provider : provider.id;
  let projectModels = null;
  try {
    projectModels = getConfig(workspaceRoot).models ?? null;
  } catch {
    projectModels = null;
  }
  if (projectModels && Object.hasOwn(projectModels, providerId)) {
    const setting = projectModels[providerId] ?? null;
    return setting ? { setting, source: "project" } : { setting: null, source: "provider-default" };
  }
  const userSetting = getUserConfig().models?.[providerId] ?? null;
  return userSetting ? { setting: userSetting, source: "user" } : { setting: null, source: "provider-default" };
}

/**
 * Resolves `key` (`model`, `effort` or `writeSandbox`) to `{ value, source }`, source one of
 * `flag`, `project`, `user` or `provider-default`. `model` and `effort` come from the delegation
 * setting of `provider`, as one entry; `writeSandbox` is shared by every provider and defaults to
 * workspace-write.
 */
export function resolveSetting(key, { provider = null, workspaceRoot, flag } = {}) {
  if (isGiven(flag)) {
    return { value: String(flag).trim(), source: "flag" };
  }
  if (key === "writeSandbox") {
    const project = getConfig(workspaceRoot).writeSandbox;
    if (isGiven(project)) {
      return { value: project, source: "project" };
    }
    const user = getUserConfig().writeSandbox;
    if (isGiven(user)) {
      return { value: user, source: "user" };
    }
    return { value: DEFAULT_WRITE_SANDBOX, source: "provider-default" };
  }
  if (key === "model" || key === "effort") {
    const { setting, source } = delegationSetting(provider, workspaceRoot);
    const value = setting?.[key] ?? null;
    return isGiven(value) ? { value, source } : { value: null, source: "provider-default" };
  }
  throw new Error(`Unknown setting "${key}".`);
}

/** The sandbox of a job: read-only unless it may write, else the resolved write sandbox. */
export function writeSandboxFor(workspaceRoot, write) {
  return write ? resolveSetting("writeSandbox", { workspaceRoot }).value : "read-only";
}
