import process from "node:process";

import { outputResult, parseCommandInput, resolveCommandCwd, resolveCommandWorkspace } from "../../../lib/companion-cli.mjs";
import { binaryAvailable } from "../../../lib/process.mjs";
import { getConfig, setConfig } from "../../../lib/state.mjs";
import { resolveWorkspaceRoot } from "../../../lib/workspace.mjs";
import { renderSetupReport } from "../render.mjs";
import { getCodexAuthStatus, getCodexAvailability, getSessionRuntimeStatus } from "../runtime.mjs";

export const WRITE_SANDBOXES = ["workspace-write", "danger-full-access"];

export const usage = `setup [--enable-review-gate|--disable-review-gate] [--write-sandbox <${WRITE_SANDBOXES.join("|")}>] [--json]`;

export async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

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
    writeSandbox: config.writeSandbox ?? "workspace-write",
    actionsTaken,
    nextSteps
  };
}

export async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "write-sandbox"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  if (options["write-sandbox"] !== undefined) {
    const sandbox = String(options["write-sandbox"]).trim();
    if (!WRITE_SANDBOXES.includes(sandbox)) {
      throw new Error(`Unsupported write sandbox "${sandbox}". Use one of: ${WRITE_SANDBOXES.join(", ")}.`);
    }
    setConfig(workspaceRoot, "writeSandbox", sandbox);
    actionsTaken.push(`Write-capable tasks now run with the ${sandbox} sandbox in ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

export const run = handleSetup;
