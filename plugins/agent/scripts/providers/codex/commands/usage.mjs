import { outputCommandResult, parseCommandInput, resolveCommandCwd } from "../../../lib/companion-cli.mjs";
import { normalizeCodexUsage, renderUsageReport } from "../render.mjs";
import { readCodexRateLimits } from "../runtime.mjs";

export const usage = "usage [--json]";

export async function handleUsage(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const response = await readCodexRateLimits(cwd);
  // The JSON form keeps the response Codex returned and adds the normalised quota object.
  outputCommandResult(options.json ? { ...response, normalized: normalizeCodexUsage(response) } : response, renderUsageReport(response), options.json);
}

export const run = handleUsage;
