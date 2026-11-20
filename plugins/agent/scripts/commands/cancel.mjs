import process from "node:process";

import { outputCommandResult, parseCommandInput } from "../lib/companion-cli.mjs";
import { getSessionId, readRequesterIdentity } from "../lib/host.mjs";
import { reconcileStore } from "../lib/job-control.mjs";
import { getProvider } from "../lib/providers.mjs";
import {
  UnknownJobError,
  decideNext,
  listJobViews,
  readJobView,
  requestStop,
  resolveActionableTip
} from "../lib/state.mjs";
import { RETRY_BUDGETS, testPoint } from "../lib/store.mjs";
import { waitForJob } from "../lib/tracked-jobs.mjs";
import { commandStateDir, openCommandStore, retrying, withCommandStore } from "./store.mjs";

export const usage = "cancel [job-id|label] [--json]";

// How many times cancel follows a continuation that won against it to the chain's new tip.
const FOLLOW_LIMIT = 3;
const ACTIVE_STATES = new Set(["queued", "running", "stopping"]);
const FINAL_STATES = new Set(["completed", "failed", "cancelled"]);

// The job cancel acts on without a reference: the one queued, running or stopping chain tip of
// this session.
function soleActiveTip(store) {
  const active = listJobViews(store, { sessionId: getSessionId(process.env), limit: 200 }).filter(
    (view) => view.isTip && ACTIVE_STATES.has(view.state)
  );
  if (active.length === 1) {
    return active[0];
  }
  throw new Error(active.length === 0 ? "No active job to cancel. Pass a job id or label." : "Several jobs are active. Pass a job id or label to cancel.");
}

/** The report of a cancel, from the job's row as last read. */
export function renderStoreCancel(view, { stopRequested = false } = {}) {
  const row = view.row;
  const lines = [];
  if (view.state === "cancelled") {
    const provider = getProvider(view.provider);
    if (stopRequested && provider.capabilities?.interrupt === false && row.end_reason === "tree-stop") {
      lines.push(`${provider.label} cannot be interrupted; it was stopped by process id.`);
    }
    lines.push(`Job ${view.id} was cancelled.`);
    if (view.providerExitUnobserved) {
      lines.push("Its provider's exit was not observed; the provider may still run, so continuing its thread needs --force.");
    }
  } else if (ACTIVE_STATES.has(view.state)) {
    lines.push(
      `Job ${view.id} is ${view.state}: the cancel was recorded, but the job did not confirm it by its deadline. Check /agent:status ${view.id}.`
    );
  } else {
    lines.push(`Job ${view.id} already ended (${view.state}) before the cancel took effect. Read its output with /agent:result ${view.id}.`);
  }
  return `${lines.join("\n")}\n`;
}

// Records a stop request with a cancel for a queued, running or stopping tip, waits for its end
// until the stop deadline, and reconciles once when it is still undecided.
async function stopAndWait(stateDir, store, tip) {
  testPoint("cancel-before-stop");
  const stop = await retrying((opts) =>
    requestStop(store, { jobIds: [tip.id] }, { reason: "cancel", cancel: true, sessionId: getSessionId(process.env) }, opts)
  );
  store.close();
  const timeoutMs = Math.max(0, stop.localDeadline - performance.now());
  const waited = await waitForJob(stateDir, tip.id, { until: "end", timeoutMs });
  let view = waited.view;
  if (waited.timedOut || !view) {
    await reconcileStore(stateDir, { deadline: performance.now() + RETRY_BUDGETS.command.totalMs, budget: "command" });
    view = await withCommandStore(stateDir, (fresh) => retrying((opts) => readJobView(fresh, tip.id, opts)));
  }
  return view ?? tip;
}

export async function run(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const stateDir = commandStateDir(options);
  const reference = positionals[0] ?? "";
  const requester = await readRequesterIdentity();

  let store = await openCommandStore(stateDir);
  let outcome = null;
  try {
    let tip = await retrying((opts) => (reference ? resolveActionableTip(store, reference, opts) : soleActiveTip(store)));
    if (!tip) {
      throw new UnknownJobError({ ref: reference });
    }
    for (let attempt = 0; attempt < FOLLOW_LIMIT && !outcome; attempt += 1) {
      if (ACTIVE_STATES.has(tip.state)) {
        const view = await stopAndWait(stateDir, store, tip);
        store = await openCommandStore(stateDir);
        // A continuation that won before the stop request is the chain's new tip; it is cancelled next.
        const latest = await retrying((opts) => resolveActionableTip(store, tip.id, opts));
        if (latest && latest.id !== tip.id && !FINAL_STATES.has(latest.state)) {
          tip = latest;
          continue;
        }
        outcome = { view, stopRequested: true };
      } else if (tip.state === "waiting" || tip.state === "interrupted") {
        const decision = await retrying((opts) => decideNext(store, { ref: tip.id, observedTipId: tip.id }, { action: "cancel", requester }, opts));
        if (decision.won) {
          outcome = { view: await retrying((opts) => readJobView(store, tip.id, opts)), stopRequested: false };
        } else if (decision.successorId) {
          // A continuation won: the chain's new tip is cancelled instead.
          tip = await retrying((opts) => resolveActionableTip(store, tip.id, opts));
        } else {
          outcome = { view: decision.view ?? tip, stopRequested: false };
        }
      } else if (FINAL_STATES.has(tip.state)) {
        throw new Error(`Job ${tip.id} has already ${tip.state === "cancelled" ? "been cancelled" : tip.state}, so there is nothing to cancel.`);
      }
    }
    if (!outcome) {
      throw new Error(`Job ${tip.id} kept being continued while cancel ran; run cancel again.`);
    }
  } finally {
    store?.close();
  }
  const { view, stopRequested } = outcome;
  const payload = { jobId: view.id, status: view.state, title: view.row.title, endReason: view.row.end_reason ?? null };
  outputCommandResult(payload, renderStoreCancel(view, { stopRequested }), options.json);
}
