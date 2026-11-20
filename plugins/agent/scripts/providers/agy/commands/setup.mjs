import { outputCommandResult, parseCommandInput, resolveCommandCwd, resolveCommandWorkspace } from "../../../lib/companion-cli.mjs";
import { delegationLines, describeDelegation, storeDelegationSetting } from "../../../lib/model-selection.mjs";
import { binaryAvailable } from "../../../lib/process.mjs";
import { getConfig, setConfig } from "../../../lib/state.mjs";
import { agyProvider } from "../index.mjs";
import { getAgyAvailability, readAgyEfforts, readAgyModels, readAgySavedModel, resolveAgyDelegationModel } from "../runtime.mjs";

const WRITE_SANDBOXES = ["workspace-write", "danger-full-access"];

export const usage = `setup [--model <id|family|default|configured>] [--effort <level>] [--write-sandbox <${WRITE_SANDBOXES.join("|")}>] [--json]`;

export async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd", "model", "effort", "write-sandbox"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  let sandbox = null;
  if (options["write-sandbox"] !== undefined) {
    sandbox = String(options["write-sandbox"]).trim();
    if (!WRITE_SANDBOXES.includes(sandbox)) {
      throw new Error(`Unsupported write sandbox "${sandbox}". Use one of: ${WRITE_SANDBOXES.join(", ")}.`);
    }
  }
  const delegationSetting = await storeDelegationSetting(agyProvider, workspaceRoot, cwd, options);
  if (delegationSetting) {
    for (const warning of delegationSetting.warnings) {
      process.stderr.write(`${warning}\n`);
    }
    actionsTaken.push(delegationSetting.action);
  }
  // The write sandbox setting is shared with the Codex provider.
  if (sandbox) {
    setConfig(workspaceRoot, "writeSandbox", sandbox);
    actionsTaken.push(`Write-capable tasks now run with the ${sandbox} sandbox in ${workspaceRoot}.`);
  }

  const node = binaryAvailable("node", ["--version"], { cwd });
  const agy = getAgyAvailability(cwd);
  const login = agy.available ? readAgyModels(cwd) : { ok: false, models: [], detail: "skipped: agy is not installed" };
  const described = await describeDelegation(agyProvider, workspaceRoot, cwd);
  // Without a model agy uses the model saved in its settings.
  const delegation = { ...described, providerModel: described.model || described.error ? null : readAgySavedModel() };
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
    writeSandbox: getConfig(workspaceRoot).writeSandbox ?? "workspace-write",
    delegation,
    contracts: agyProvider.contractSummary(agy.available ? installedVersion(agy.detail) : null),
    version: agy.available ? installedVersion(agy.detail) : null,
    modelCount: login.models.length,
    // The model a delegation uses, by agy's display name (the saved default is one already).
    delegationModel: resolveAgyDelegationModel(cwd, { setting: getConfig(workspaceRoot).models?.[agyProvider.id]?.model ?? null }),
    efforts: agy.available ? readAgyEfforts(cwd) : [],
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
    `- write sandbox: ${report.writeSandbox}`,
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
    `- efforts: ${report.efforts.length > 0 ? report.efforts.join(", ") : "unknown"}`
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
