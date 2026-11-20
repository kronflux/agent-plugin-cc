// Checks a requested model and reasoning effort against the models the Codex app-server
// lists, before a thread is created, so an unsupported combination fails with a clear
// message instead of an error partway through a turn.

export const KNOWN_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

// The most model list pages read; a server that keeps naming new pages is not followed further.
const MAX_MODEL_LIST_PAGES = 50;

// Reads every page of the model list. Paging stops at a cursor already seen and after
// MAX_MODEL_LIST_PAGES pages. A page without a data array adds no models.
async function listModels(client) {
  const models = [];
  const seenCursors = new Set();
  let cursor = null;
  for (let pages = 0; pages < MAX_MODEL_LIST_PAGES; pages += 1) {
    const page = await client.request("model/list", cursor ? { cursor } : {});
    models.push(...(Array.isArray(page?.data) ? page.data : []));
    cursor = page?.nextCursor ?? null;
    if (!cursor || seenCursors.has(cursor)) {
      break;
    }
    seenCursors.add(cursor);
  }
  return models;
}

// A model whose effort list is not an array lists no efforts, so its effort check is skipped.
function supportedEfforts(model) {
  const efforts = model?.supportedReasoningEfforts;
  return (Array.isArray(efforts) ? efforts : [])
    .map((entry) => (typeof entry === "string" ? entry : entry?.reasoningEffort))
    .filter(Boolean);
}

/**
 * Throws when `effort` is not supported by the requested model, or by the default model when
 * none is requested. A model the catalog does not list, such as one from a custom provider, is
 * accepted unchecked. When the app-server cannot list models, the effort is checked against
 * the efforts Codex knows.
 */
export async function validateModelSelection(client, { model = null, effort = null } = {}) {
  if (!effort) {
    return;
  }
  let models;
  try {
    models = await listModels(client);
  } catch {
    models = null;
  }
  if (!models || models.length === 0) {
    if (!KNOWN_REASONING_EFFORTS.includes(effort)) {
      throw new Error(`Unsupported reasoning effort "${effort}". Use one of: ${KNOWN_REASONING_EFFORTS.join(", ")}.`);
    }
    return;
  }
  const selected = model
    ? models.find((entry) => entry.id === model || entry.model === model)
    : models.find((entry) => entry.isDefault);
  if (!selected) {
    return;
  }
  const efforts = supportedEfforts(selected);
  if (efforts.length > 0 && !efforts.includes(effort)) {
    throw new Error(
      `Model ${selected.id ?? selected.model} does not support reasoning effort "${effort}". Use one of: ${efforts.join(", ")}.`
    );
  }
}
