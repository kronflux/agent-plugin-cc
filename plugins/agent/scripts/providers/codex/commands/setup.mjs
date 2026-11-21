import process from "node:process";

import { outputResult, parseCommandInput, resolveCommandCwd, resolveCommandWorkspace } from "../../../lib/companion-cli.mjs";
import { describeDelegation, planDelegationSetting, storeUserSetup } from "../../../lib/model-selection.mjs";
import { binaryAvailable } from "../../../lib/process.mjs";
import { checkWriteSandbox, parseSetupArguments, resolveSetting, settingSources, WRITE_SANDBOXES } from "../../../lib/settings.mjs";
import { getConfig, setConfig } from "../../../lib/state.mjs";
import { resolveWorkspaceRoot } from "../../../lib/workspace.mjs";
import { codexProvider } from "../index.mjs";
import { renderSetupReport } from "../render.mjs";
import { getCodexAuthStatus, getCodexAvailability, getSessionRuntimeStatus } from "../runtime.mjs";

export { checkWriteSandbox, WRITE_SANDBOXES };

export const usage = `setup [--scope project|user] [--model <id|family|default|configured>] [--effort <level>] [--write-sandbox <${WRITE_SANDBOXES.join("|")}>] [--enable-review-gate|--disable-review-gate] [--json]`;

export async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);
  const delegation = await describeDelegation(codexProvider, workspaceRoot, cwd);
  const writeSandbox = resolveSetting("writeSandbox", { workspaceRoot });

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/agent:codex-setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    appServer: authStatus.userAgent ?? null,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    writeSandbox: writeSandbox.value,
    sources: settingSources(delegation, writeSandbox.source),
    delegation,
    actionsTaken,
    nextSteps
  };
}

export async function handleSetup(argv) {
  const options = parseSetupArguments(argv, {
    parse: parseCommandInput,
    usage,
    valueOptions: ["cwd", "write-sandbox", "model", "effort"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];
  const sandbox = options["write-sandbox"] !== undefined ? checkWriteSandbox(options["write-sandbox"]) : null;

  // At user scope every change of this call is written in one locked update of the user config;
  // the review gate always belongs to the workspace.
  const userScope = options.scope === "user";
  const planned = userScope
    ? await storeUserSetup(codexProvider, workspaceRoot, cwd, options, { writeSandbox: sandbox })
    : await planDelegationSetting(codexProvider, workspaceRoot, cwd, options);
  for (const warning of planned?.warnings ?? []) {
    process.stderr.write(`${warning}\n`);
  }
  if (!userScope && planned) {
    setConfig(workspaceRoot, "models", { ...(getConfig(workspaceRoot).models ?? {}), [codexProvider.id]: planned.value });
  }
  if (planned) {
    actionsTaken.push(planned.action);
  }

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  if (sandbox) {
    if (!userScope) {
      setConfig(workspaceRoot, "writeSandbox", sandbox);
    }
    const where = userScope ? "in every workspace without its own setting" : `in ${workspaceRoot}`;
    actionsTaken.push(`Write-capable tasks now run with the ${sandbox} sandbox ${where}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

export const run = handleSetup;
