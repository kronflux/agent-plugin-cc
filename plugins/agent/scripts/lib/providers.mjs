import { agyProvider } from "../providers/agy/index.mjs";
import { codexProvider } from "../providers/codex/index.mjs";

// The registry of agent CLI providers. Jobs record the id of the provider that runs them; a
// record without one was written by the Codex-only plugin.
const PROVIDERS = new Map([
  [codexProvider.id, codexProvider],
  [agyProvider.id, agyProvider]
]);

export const DEFAULT_PROVIDER_ID = codexProvider.id;

export function getProvider(id = DEFAULT_PROVIDER_ID) {
  const provider = PROVIDERS.get(id);
  if (!provider) {
    throw new Error(`Unknown agent provider "${id}". Known providers: ${[...PROVIDERS.keys()].join(", ")}.`);
  }
  return provider;
}

export function providerForJob(job) {
  return getProvider(job?.provider ?? DEFAULT_PROVIDER_ID);
}

export function listProviders() {
  return [...PROVIDERS.values()];
}
