// The job of a council seat, built as each provider's own task command builds a read-only
// background task with an output schema, a label and a run id; and the seat's usage reading.
import process from "node:process";

import { delegationOptions, resolveModelSelection } from "../model-selection.mjs";
import { getProvider } from "../providers.mjs";
import { readProviderUsage } from "../quota.mjs";
import { readTaskInputFiles } from "../task-launch.mjs";
import { resolveWorkspaceRoot } from "../workspace.mjs";
import { familyProvider } from "./prompts.mjs";

// A provider's task and runtime modules load only when a seat job is built, so the other
// subcommands and the hooks never load them.
function loadProviderModules(provider) {
  return Promise.all([import(`../../providers/${provider}/commands/task.mjs`), import(`../../providers/${provider}/runtime.mjs`)]);
}

/**
 * The `createJob` arguments of a seat's job: what `<provider>-companion.mjs task --background
 * --json --output-schema <schemaPath> --label <label> --run-id <runId> [--model <model>]` builds
 * for the same prompt in `cwd`. Resolves to `{ fields, label, warnings }`; throws for a family
 * with no provider.
 */
export async function buildSeatJob({ family, model = null, prompt, schemaPath, label, runId, cwd, requester }) {
  const provider = familyProvider(family);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  if (provider === "codex") {
    const [{ buildTaskJobFields: buildCodexJobFields, buildTaskRunMetadata, resolveTaskSelection }, { readOutputSchema }] = await loadProviderModules(provider);
    const outputSchema = readOutputSchema(schemaPath);
    const selection = await resolveTaskSelection(workspaceRoot, cwd, { model: model ?? undefined });
    const { title } = buildTaskRunMetadata({ prompt, resumeLast: false });
    const built = buildCodexJobFields(
      {
        prompt,
        title,
        write: false,
        sandbox: "read-only",
        worktree: null,
        model: selection.model,
        effort: selection.effort,
        modelSource: selection.modelSource,
        effortSource: selection.effortSource,
        outputSchema,
        allowQuestions: false,
        background: true,
        fresh: false,
        label,
        runId,
        threadId: null,
        force: false
      },
      { cwd, requester }
    );
    return { ...built, warnings: selection.warnings ?? [] };
  }
  if (provider === "agy") {
    const [{ buildTaskJobFields: buildAgyJobFields, writeSandboxMode }, { readAgySavedModel }] = await loadProviderModules(provider);
    const agyProvider = getProvider(provider);
    const { schema } = readTaskInputFiles(cwd, { outputSchema: schemaPath });
    const selection = await resolveModelSelection(agyProvider, {
      model: model ?? undefined,
      effort: undefined,
      ...delegationOptions(agyProvider, workspaceRoot),
      stored: null,
      cwd
    });
    const built = buildAgyJobFields(
      {
        prompt: String(prompt).trim(),
        write: false,
        sandbox: writeSandboxMode(workspaceRoot, false),
        model: selection.model,
        effort: selection.effort,
        modelSource: selection.modelSource,
        effortSource: selection.effortSource,
        providerModel: selection.model ? null : readAgySavedModel(),
        savedModelChange: null,
        outputSchema: schema,
        allowQuestions: false,
        background: true,
        fresh: false,
        label,
        runId,
        threadId: null,
        force: false
      },
      { cwd, workspaceRoot, requester }
    );
    return { ...built, warnings: selection.warnings ?? [] };
  }
  throw new Error(`The council family "${family}" has no provider.`);
}

/**
 * Reads a seat's usage through its provider's `usage --json`, stopped after `timeoutMs`.
 * Resolves to `{ raw, normalized }` (Codex prints its rate-limit reply with the normalised object
 * under `normalized`; others print the normalised object), or null when the read failed, timed
 * out or printed nothing readable: a failed read is no quota evidence.
 */
export async function readSeatUsage(family, { cwd, env = process.env, timeoutMs }) {
  return readProviderUsage(familyProvider(family), { cwd, env, timeoutMs });
}
