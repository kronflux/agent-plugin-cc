import { readProcessIdentities } from "./process.mjs";
import { leaderState, scanWorkspace } from "./state.mjs";
import { openStore, RETRY_BUDGETS } from "./store.mjs";
import { launchWorker } from "./task-launch.mjs";

// ---------------------------------------------------------------------------------------------
// Store reconciliation

/** The leader state of each view, from one batched identity query bounded by `deadline`. */
export async function readLeaderStates(views, { deadline } = {}) {
  const pids = views.map((view) => view.row.leader_pid).filter((pid) => Number.isInteger(pid));
  const identities = await readProcessIdentities(pids, { deadline: deadline ?? performance.now() + 5000 });
  return new Map(views.map((view) => [view.id, leaderState(view, identities.get(view.row.leader_pid) ?? { state: "unknown", reason: "not queried" })]));
}

/**
 * Opens the workspace's store, runs one scan whose launches go through `launchWorker`, and closes
 * the store. `budget` names the busy allowance per statement (RETRY_BUDGETS); `leaderCheck`
 * defaults to batched leader identities.
 */
export async function reconcileStore(stateDir, { deadline, budget = "command", leaderCheck = null } = {}) {
  const attemptMs = RETRY_BUDGETS[budget]?.attemptMs ?? RETRY_BUDGETS.command.attemptMs;
  const store = openStore(stateDir, { deadline, busyTimeoutMs: attemptMs });
  try {
    return await scanWorkspace(store, {
      deadline,
      stateDir,
      attemptMs,
      launch: (jobId) => launchWorker(store, stateDir, jobId),
      heartbeats: null,
      leaderCheck: leaderCheck ?? ((views) => readLeaderStates(views, { deadline }))
    });
  } finally {
    store.close();
  }
}
