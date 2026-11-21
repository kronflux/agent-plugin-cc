import { outputCommandResult, parseCommandInput, resolveCommandCwd, resolveCommandWorkspace } from "../../../lib/companion-cli.mjs";
import { delegationLines, describeDelegation, planDelegationSetting } from "../../../lib/model-selection.mjs";
import { binaryAvailable } from "../../../lib/process.mjs";
import {
  checkWriteSandbox,
  parseSetupArguments,
  resolveSetting,
  settingSources,
  sourceLabel,
  WRITE_SANDBOXES
} from "../../../lib/settings.mjs";
import { getConfig, setConfig, updateUserConfig } from "../../../lib/state.mjs";
import { agyProvider } from "../index.mjs";
import {
  agyModelEfforts,
  getAgyAvailability,
  readAgyEfforts,
  readAgyModels,
  readAgySavedModel,
  resolveAgyDelegationModel,
  splitAgyModel
} from "../runtime.mjs";

export const usage = `setup [--scope project|user] [--model <id|family|default|configured>] [--effort <level>] [--write-sandbox <${WRITE_SANDBOXES.join("|")}>] [--json]`;

export async function handleSetup(argv) {
  const options = parseSetupArguments(argv, {
    parse: parseCommandInput,
    usage,
    valueOptions: ["cwd", "model", "effort", "write-sandbox"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  const sandbox = options["write-sandbox"] !== undefined ? checkWriteSandbox(options["write-sandbox"]) : null;
  const planned = await planDelegationSetting(agyProvider, workspaceRoot, cwd, options, { scope: options.scope });
  for (const warning of planned?.warnings ?? []) {
    process.stderr.write(`${warning}\n`);
  }
  // The write sandbox setting is shared with the Codex provider. At user scope every change of
  // this call is written in one update of the user config.
  const where = options.scope === "user" ? "in every workspace without its own setting" : `in ${workspaceRoot}`;
  if (options.scope === "user" && (planned || sandbox)) {
    updateUserConfig((config) => ({
      ...config,
      ...(planned ? { models: { ...config.models, [agyProvider.id]: planned.value } } : {}),
      ...(sandbox ? { writeSandbox: sandbox } : {})
    }));
  } else if (options.scope !== "user") {
    if (planned) {
      setConfig(workspaceRoot, "models", { ...(getConfig(workspaceRoot).models ?? {}), [agyProvider.id]: planned.value });
    }
    if (sandbox) {
      setConfig(workspaceRoot, "writeSandbox", sandbox);
    }
  }
  if (planned) {
    actionsTaken.push(planned.action);
  }
  if (sandbox) {
    actionsTaken.push(`Write-capable tasks now run with the ${sandbox} sandbox ${where}.`);
  }

  const writeSandbox = resolveSetting("writeSandbox", { workspaceRoot });
  const node = binaryAvailable("node", ["--version"], { cwd });
  const agy = getAgyAvailability(cwd);
  const login = agy.available ? readAgyModels(cwd) : { ok: false, models: [], detail: "skipped: agy is not installed" };
  const described = await describeDelegation(agyProvider, workspaceRoot, cwd);
  // Without a model agy uses the model saved in its settings.
  const delegation = { ...described, providerModel: described.model || described.error ? null : readAgySavedModel() };
  // The efforts of the delegation model's base name, read from the ids `agy models` lists.
  const efforts = agy.available ? readAgyEfforts(cwd) : [];
  const modelIds = login.models.map((entry) => entry.id);
  const split = delegation.model && login.ok ? splitAgyModel(delegation.model, { models: modelIds, efforts }) : null;
  const delegationEfforts = delegation.model && login.ok
    ? { base: split?.base ?? delegation.model, efforts: split ? agyModelEfforts(split.base, modelIds, efforts) : [] }
    : null;
  const nextSteps = [];
  if (!agy.available) {
    nextSteps.push("Install the Antigravity CLI (agy), then rerun /agent:agy-setup.");
  } else if (!login.ok) {
    nextSteps.push("Run `!agy` once and sign in, then rerun /agent:agy-setup.");
  }
  const report = {
    ready: node.available && agy.available && login.ok,
    node,
    agy,
    login: { ok: login.ok, detail: login.detail },
    models: login.models,
    writeSandbox: writeSandbox.value,
    sources: settingSources(delegation, writeSandbox.source),
    delegation,
    contracts: agyProvider.contractSummary(agy.available ? installedVersion(agy.detail) : null),
    version: agy.available ? installedVersion(agy.detail) : null,
    modelCount: login.models.length,
    // The model a delegation uses, by agy's display name (the saved default is one already).
    delegationModel: resolveAgyDelegationModel(cwd, { setting: delegation.model ?? null }),
    efforts,
    delegationEfforts,
    actionsTaken,
    nextSteps
  };
  const lines = [
    "# Antigravity Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${node.detail}`,
    `- agy: ${agy.detail}`,
    `- sign-in: ${login.ok ? `signed in (${login.detail})` : login.detail}`,
    `- write sandbox: ${report.writeSandbox} (${sourceLabel(writeSandbox.source)})`,
    ...delegationLines(delegation, {
      chosenBy: agyProvider.label,
      modelName: delegation.providerModel ? `${delegation.providerModel} from the Antigravity settings` : null
    })
  ];
  const delegationSource = { explicit: "given on the command", setting: "from the plugin setting", "agy-settings": "from the Antigravity settings `model` key" }[report.delegationModel.source];
  lines.push(
    `- version: ${report.version ?? "unknown"}`,
    `- models: ${report.modelCount}`,
    `- delegation model by display name: ${report.delegationModel.displayName ? `${report.delegationModel.displayName}, ${delegationSource}` : "unknown"}`,
    delegationEfforts
      ? `- efforts of ${delegationEfforts.base}: ${delegationEfforts.efforts.length > 0 ? delegationEfforts.efforts.join(", ") : "none"}`
      : `- efforts: ${report.efforts.length > 0 ? report.efforts.join(", ") : "unknown"}`
  );
  lines.push("", "Cleanup:", ...report.contracts.map((line) => `- ${line}`));
  if (actionsTaken.length > 0) {
    lines.push("", "Actions taken:", ...actionsTaken.map((action) => `- ${action}`));
  }
  if (nextSteps.length > 0) {
    lines.push("", "Next steps:", ...nextSteps.map((step) => `- ${step}`));
  }
  outputCommandResult(report, `${lines.join("\n")}\n`, options.json);
}

// The version number in the text `agy --version` printed, or null.
function installedVersion(detail) {
  return /\d+\.\d+\.\d+\S*/.exec(String(detail ?? ""))?.[0] ?? null;
}

export const run = handleSetup;
