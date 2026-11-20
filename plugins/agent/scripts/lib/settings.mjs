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

// ---------------------------------------------------------------------------------------------
// Setup arguments, shared by the setup command of every provider.

export const WRITE_SANDBOXES = Object.freeze(["workspace-write", "danger-full-access"]);
export const SETTING_SCOPES = Object.freeze(["project", "user"]);
const SANDBOX_HINT = `Use --write-sandbox ${WRITE_SANDBOXES[0]} or --write-sandbox ${WRITE_SANDBOXES[1]}.`;

/** Checks a `--write-sandbox` value and returns it trimmed. */
export function checkWriteSandbox(value) {
  const sandbox = String(value).trim();
  if (!WRITE_SANDBOXES.includes(sandbox)) {
    throw new Error(`Unsupported write sandbox "${sandbox}". Use one of: ${WRITE_SANDBOXES.join(", ")}.`);
  }
  return sandbox;
}

function missingValueError(option) {
  const hint = option === "write-sandbox" ? `\n${SANDBOX_HINT}` : "";
  return new Error(`Missing value for --${option}${hint}`);
}

/**
 * Parses the arguments of a setup command with `parse` (the command parser) and refuses what
 * setup does not know: a positional or an unknown option exits with
 * `Unknown argument "<word>" for setup. Usage: <usage>`. A value option without a value, or with
 * the next option taken as its value, is refused as missing. Returns the options, with `scope`
 * checked and defaulted to `project`.
 */
export function parseSetupArguments(argv, { parse, usage, valueOptions, booleanOptions }) {
  let parsed;
  try {
    parsed = parse(argv, { valueOptions: [...valueOptions, "scope"], booleanOptions });
  } catch (error) {
    const option = /^Missing value for --(\S+)$/.exec(error instanceof Error ? error.message : "")?.[1];
    throw option ? missingValueError(option) : error;
  }
  const { options, positionals } = parsed;
  if (positionals.length > 0) {
    throw new Error(`Unknown argument "${positionals[0]}" for setup. Usage: ${usage}`);
  }
  for (const option of [...valueOptions, "scope"]) {
    if (typeof options[option] === "string" && options[option].startsWith("--")) {
      throw missingValueError(option);
    }
  }
  const scope = options.scope === undefined ? "project" : String(options.scope).trim();
  if (!SETTING_SCOPES.includes(scope)) {
    throw new Error(`Unsupported scope "${scope}". Use --scope project or --scope user.`);
  }
  return { ...options, scope };
}

// The words a setup report uses for where a value comes from.
const SOURCE_LABELS = { flag: "flag", project: "project setting", user: "user setting", "provider-default": "provider-default" };

/** The report label of a `resolveSetting` source, such as `user setting`. */
export function sourceLabel(source) {
  return SOURCE_LABELS[source] ?? source;
}

// The `resolveSetting` source of a job's model or effort source.
const JOB_SOURCES = { explicit: "flag", setting: "project", "user-setting": "user" };

/** The `sources` field of a setup report: where the model, effort and write sandbox come from. */
export function settingSources(delegation, writeSandboxSource) {
  return {
    model: JOB_SOURCES[delegation.modelSource] ?? "provider-default",
    effort: JOB_SOURCES[delegation.effortSource] ?? "provider-default",
    writeSandbox: writeSandboxSource
  };
}
