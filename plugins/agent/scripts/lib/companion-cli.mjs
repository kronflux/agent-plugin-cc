import path from "node:path";
import process from "node:process";

import { parseArgs, splitRawArgumentString } from "./args.mjs";
import { sanitizeAgentValue } from "./untrusted.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

// Command-line plumbing shared by the provider companions: argument parsing and output.

// Thrown by parseCommandInput when --help is given, so no command work starts.
export class HelpRequested extends Error {}

export function outputResult(value, asJson) {
  if (asJson) {
    // A JSON result can carry another agent's text (a result, a question, an error): its strings
    // are sanitised, and it gets no fence, because programs parse it.
    console.log(JSON.stringify(sanitizeAgentValue(value), null, 2));
  } else {
    process.stdout.write(value);
  }
}

export function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

export function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

// With `config.split === false`, `argv` is taken as already split into tokens, so a single
// remaining token is not split again.
export function parseCommandInput(argv, config = {}) {
  const parsed = parseArgs(config.split === false ? argv : normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
  if (parsed.options.help) {
    throw new HelpRequested();
  }
  return parsed;
}

export function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

export function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}
