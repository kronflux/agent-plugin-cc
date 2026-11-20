// Chooses the model and reasoning effort a job runs with. Each provider's model catalog
// resolves and checks the values; this module only decides which catalog call applies.

function isGiven(value) {
  return value != null && String(value).trim() !== "";
}

/**
 * Resolves `options.model` and `options.effort` through `catalog`. A given model goes through
 * `catalog.resolveExplicit`; without one, `catalog.resolveDefault` names the provider's default.
 * A given effort goes through `catalog.checkEffort`, which throws when it is not supported;
 * without one, the provider picks the effort. Returns the values to send, where each came from,
 * and any warnings to show.
 */
export async function resolveModelSelection(provider, options, catalog = provider.modelCatalog) {
  const cwd = options?.cwd;
  const warnings = [];
  const resolved = isGiven(options?.model)
    ? await catalog.resolveExplicit(options.model, { cwd })
    : await catalog.resolveDefault({ cwd });
  if (resolved.warning) {
    warnings.push(resolved.warning);
  }

  let effort = null;
  let effortSource = "provider-default";
  if (isGiven(options?.effort)) {
    effort = catalog.checkEffort(options.effort, resolved.efforts ?? null, { cwd });
    effortSource = "explicit";
  }

  return {
    model: resolved.model ?? null,
    effort,
    modelSource: resolved.source,
    effortSource,
    warnings
  };
}
