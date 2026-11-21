import { parseCommandInput, resolveCommandCwd, resolveCommandWorkspace } from "../../../lib/companion-cli.mjs";
import { describeDelegation } from "../../../lib/model-selection.mjs";
import { delegationSetting } from "../../../lib/settings.mjs";
import { agyProvider } from "../index.mjs";
import { readAgyEfforts, resolveAgyDelegationModel } from "../runtime.mjs";
import {
  markDefaultGroup,
  normalizeAgyUsage,
  parseAgyUsage,
  readAgyUsage,
  renderAgyUsageReport,
  stripEffortSuffix,
  UNKNOWN_DELEGATION_MODEL_LINE
} from "../usage.mjs";

export const usage = "usage [--json]";

/**
 * Prints the Antigravity quota groups and their buckets, as text or as the normalised object
 * with --json, with the group of the model a delegation would use marked. A failed read exits 1
 * with the reason and the start of agy's output.
 */
export async function handleUsage(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  const read = readAgyUsage(cwd);
  const parsed = read.ok ? parseAgyUsage(read.raw) : { error: read.reason };
  if (parsed.error) {
    const output = read.ok ? "" : String(read.output ?? "").trim().slice(0, 200);
    process.stderr.write(`Antigravity usage could not be read: ${parsed.error}.\n${output ? `${output}\n` : ""}`);
    process.exitCode = 1;
    return;
  }
  const workspaceRoot = resolveCommandWorkspace(options);
  // The stored setting may name a base name and an effort; the delegation resolves them into
  // the model id (through resolveAgyModel) before the id is looked up in agy models. A setting
  // that does not resolve is looked up as stored.
  const described = await describeDelegation(agyProvider, workspaceRoot, cwd);
  const stored = delegationSetting(agyProvider, workspaceRoot).setting?.model ?? null;
  const delegation = resolveAgyDelegationModel(cwd, { setting: described.error ? stored : described.model ?? null });
  const name = delegation.displayName ? stripEffortSuffix(delegation.displayName, readAgyEfforts(cwd)) : null;
  const normalized = normalizeAgyUsage({ groups: markDefaultGroup(parsed.groups, name) });
  const notes = name ? [] : [UNKNOWN_DELEGATION_MODEL_LINE];
  process.stdout.write(options.json ? `${JSON.stringify(normalized, null, 2)}\n` : renderAgyUsageReport(normalized, { notes }));
}

export const run = handleUsage;
