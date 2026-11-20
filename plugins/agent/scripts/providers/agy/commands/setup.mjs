import { outputCommandResult, parseCommandInput, resolveCommandCwd, resolveCommandWorkspace } from "../../../lib/companion-cli.mjs";
import { binaryAvailable } from "../../../lib/process.mjs";
import { getConfig } from "../../../lib/state.mjs";
import { getAgyAvailability, readAgyModels } from "../runtime.mjs";

export const usage = "setup [--json]";

export async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  const node = binaryAvailable("node", ["--version"], { cwd });
  const agy = getAgyAvailability(cwd);
  const login = agy.available ? readAgyModels(cwd) : { ok: false, models: [], detail: "skipped: agy is not installed" };
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
    writeSandbox: getConfig(resolveCommandWorkspace(options)).writeSandbox ?? "workspace-write",
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
    `- write sandbox: ${report.writeSandbox}`
  ];
  if (nextSteps.length > 0) {
    lines.push("", "Next steps:", ...nextSteps.map((step) => `- ${step}`));
  }
  outputCommandResult(report, `${lines.join("\n")}\n`, options.json);
}

export const run = handleSetup;
