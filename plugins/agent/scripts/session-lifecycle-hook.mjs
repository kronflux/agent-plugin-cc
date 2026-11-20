#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { getPluginDataDir, getSessionId, readHookInput, readHookReason, writeSessionEnv } from "./lib/host.mjs";
import { noteJobs } from "./lib/mailbox.mjs";
import { confirmIdentity, readProcessIdentities, stopTrees } from "./lib/process.mjs";
import { getProvider } from "./lib/providers.mjs";
import { redactSecrets } from "./lib/redact.mjs";
import {
  commitSessionEnd,
  decideRelease,
  jobState,
  leaderState,
  observeClosure,
  readSessionSelection,
  requestStop,
  resolveStateDir,
  startGrace
} from "./lib/state.mjs";
import { checkRuntime, openStore, runtimeGateMessage, StoreError, wallNow, withRetry } from "./lib/store.mjs";

// SessionEnd works to one deadline of 8.0 s after this process started (performance.now() counts
// from the process's time origin), in phases that each end at a fixed time.
const END_PHASES = Object.freeze({
  open: 1500,
  stop: 2500,
  wait: 5500,
  treeStop: 6500,
  commit: 7500
});
// The stop request's stored deadline is this long after its commit.
const STOP_AFTER_MS = 4000;
// The tree stops of one worker end at most this long after its wait ended.
const TREE_STOP_MS = 1000;
// Batched identity queries of the waiting workers start at least this far apart.
const QUERY_SPACING_MS = 100;
// A write that anchors a grace window may wait this long for the store.
const GRACE_ATTEMPT_MS = 250;
// After a tree stop, the stopped root is checked this often until it left the process table.
const ROOT_GONE_POLL_MS = 50;
// How often due stops are started.
const DUE_CHECK_MS = 20;
// A stop of several targets is tried again only while at least this much time is left.
const RETRY_STOP_MIN_MS = 150;
// AGENT_PLUGIN_TEST_POLL_QUERY_DELAY_MS slows each identity query of the wait by that much, as a
// slow first query followed by fast ones; tests only.
const POLL_QUERY_DELAY_MS = Number.parseInt(process.env.AGENT_PLUGIN_TEST_POLL_QUERY_DELAY_MS ?? "", 10) || 0;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function writeLine(text) {
  process.stderr.write(`${text}\n`);
}

function storeExists(stateDir) {
  return fs.existsSync(path.join(stateDir, "store", "state.db"));
}

// ---------------------------------------------------------------------------------------------
// SessionStart

// SessionStart ends by 2.0 s after this process started; its last store step must commit by
// START_DEADLINE_MS, which leaves time to print.
const START_DEADLINE_MS = 1850;
const START_NOTE_LIMIT = 10;
const PROMPT_PREVIEW_CHARS = 80;
const PROMPT_REDACTION_CHARS = 4096;
const NOTED_STATES = new Set(["interrupted", "waiting", "stopping"]);

function writeContextNote(text) {
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } })}\n`);
}

function withoutControlCharacters(text) {
  return String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
}

function ageText(milliseconds) {
  const minutes = Math.max(0, Math.floor(milliseconds / 60000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function providerName(providerId) {
  try {
    return getProvider(providerId).label;
  } catch {
    return providerId;
  }
}

// The chain tips that are interrupted, waiting or stopping and were not noted to `sessionId`,
// most recently active first, from one read.
function readUnnotedTips(store, sessionId, deadline) {
  const rows = store.read(
    (db) =>
      db
        .prepare(
          `SELECT jobs.* FROM chains JOIN jobs ON jobs.id = chains.tip_job_id
           WHERE jobs.cancelled_at IS NULL
             AND (jobs.end_state IN ('interrupted', 'waiting') OR (jobs.end_state IS NULL AND jobs.stopping_since IS NOT NULL))
             AND NOT EXISTS (SELECT 1 FROM job_notes WHERE job_notes.job_id = jobs.id AND job_notes.session_id = ?)
           ORDER BY COALESCE(jobs.end_at, jobs.stopping_since, jobs.updated_at) DESC, jobs.id`
        )
        .all(sessionId),
    { deadline }
  );
  return rows.filter((row) => NOTED_STATES.has(jobState(row)));
}

function noteLine(row, now) {
  const label = row.label ? ` (${row.label})` : "";
  const since = row.end_at ?? row.stopping_since ?? row.updated_at;
  // The preview goes into the session's context, so credentials in it are redacted. A longer
  // prefix is redacted first, so a credential that crosses the cut is not shown in part.
  const prompt = redactSecrets(withoutControlCharacters(String(row.prompt ?? "").slice(0, PROMPT_REDACTION_CHARS))).slice(0, PROMPT_PREVIEW_CHARS);
  return `- ${row.id}${label}: ${providerName(row.provider)}, ${jobState(row)}, ${ageText(now - since)} ago: ${prompt}`;
}

// Bounded discovery: the tips whose leader is gone or was never recorded are noted to this session
// in one transaction, at most ten per start, and listed in the context note. A tip whose leader
// check is unknown or did not fit in the deadline waits for a later start.
async function discoverInterruptedJobs(stateDir, sessionId) {
  let store;
  try {
    store = openStore(stateDir, { deadline: START_DEADLINE_MS });
  } catch {
    return;
  }
  try {
    const tips = readUnnotedTips(store, sessionId, START_DEADLINE_MS);
    if (tips.length === 0) {
      return;
    }
    const leaderPids = tips.map((row) => row.leader_pid).filter((pid) => Number.isInteger(pid));
    const identities = await readProcessIdentities(leaderPids, { deadline: START_DEADLINE_MS });
    const orphans = tips
      .filter((row) => {
        const state = leaderState(row, identities.get(row.leader_pid) ?? { state: "unknown", reason: "not queried" });
        return state === "gone" || state === "none";
      })
      .slice(0, START_NOTE_LIMIT);
    if (orphans.length === 0) {
      return;
    }
    const noted = new Set(noteJobs(store, orphans.map((row) => row.id), sessionId, { deadline: START_DEADLINE_MS }));
    const listed = orphans.filter((row) => noted.has(row.id));
    if (listed.length === 0) {
      return;
    }
    const now = wallNow();
    writeContextNote(
      [
        "Agent jobs from an earlier session were interrupted, are stopping, or wait for an answer:",
        ...listed.map((row) => noteLine(row, now)),
        "Continue one with /agent:resume <id>, or stop it with /agent:cancel <id>."
      ].join("\n")
    );
  } catch {
    // A start that cannot read or note in time says nothing; a later start lists the jobs.
  } finally {
    store.close();
  }
}

async function handleSessionStart(input) {
  writeSessionEnv({
    sessionId: input.session_id,
    transcriptPath: input.transcript_path,
    pluginDataDir: getPluginDataDir()
  });
  const gate = checkRuntime();
  if (!gate.ok) {
    const message = runtimeGateMessage(gate);
    writeLine(message);
    writeContextNote(message);
    return;
  }
  const sessionId = input.session_id || getSessionId();
  const stateDir = resolveStateDir(input.cwd || process.cwd());
  if (!sessionId || !storeExists(stateDir)) {
    return;
  }
  await discoverInterruptedJobs(stateDir, sessionId);
}

// ---------------------------------------------------------------------------------------------
// SessionEnd

// One selected execution with a worker, as the hook tracks it through the wait and stop phases.
function candidateOf(entry, waitEnd) {
  return {
    entry,
    waitEnd,
    stopDeadline: Math.min(waitEnd + TREE_STOP_MS, END_PHASES.treeStop),
    begun: false,
    workerGone: false,
    rootAbsent: false,
    stopResult: null,
    stoppedAt: null,
    graceStartedAt: null,
    error: null
  };
}

// Records the first confirmed absence of a candidate's worker as the start of its grace window
// and keeps the stored value, which is the one that counts; a busy store leaves it to a later
// confirmation.
function anchorGrace(store, candidate, deadline = Math.min(candidate.waitEnd, END_PHASES.wait)) {
  if (!store || candidate.graceStartedAt !== null) {
    return;
  }
  try {
    candidate.graceStartedAt = startGrace(store, candidate.entry.jobId, candidate.entry.execGen, { cause: "owner-death" }, { deadline, attemptMs: GRACE_ATTEMPT_MS });
  } catch {
    // The grace start is recorded by the next confirmation or by a scan.
  }
}

// Resolves to the set of `roots` confirmed absent before `deadline`, asking for all of them in one
// batched identity query at a time.
async function waitRootsGone(roots, deadline) {
  const gone = new Set();
  while (gone.size < roots.length && performance.now() < deadline) {
    const open = roots.filter((root) => !gone.has(root));
    const identities = await readProcessIdentities(
      open.map((root) => root.pid),
      { deadline }
    );
    for (const root of open) {
      if (confirmIdentity(root, identities.get(root.pid)) === "absent") {
        gone.add(root);
      }
    }
    if (gone.size < roots.length) {
      await sleep(ROOT_GONE_POLL_MS);
    }
  }
  return gone;
}

// Tree stops of several processes due together, through lib/process.mjs stopTrees (one batched
// identity query, then the stop of each verified target). A target that is still `unknown` (an
// identity read that timed out, a failed command) is tried again while time is left.
async function stopTargets(targets, deadline) {
  const results = targets.map(() => "unknown");
  let open = targets.map((_, index) => index);
  while (open.length > 0 && deadline - performance.now() > RETRY_STOP_MIN_MS) {
    const answered = await stopTrees(
      open.map((index) => targets[index].identity),
      { deadline, expectedGroupIds: open.map((index) => targets[index].expectedGroupId), rootAlone: targets[open[0]].rootAlone }
    );
    open.forEach((index, position) => {
      results[index] = answered[position];
    });
    open = open.filter((index) => results[index] === "unknown");
  }
  return results;
}

// Stops a group of candidates whose stops are due together: the tree stop of each worker while
// present (even with an advancing heartbeat), then of each recorded provider root while present
// once its worker is gone. Only a stop that succeeded on a running process counts as a tree stop.
async function stopCandidates(store, group) {
  const deadline = Math.min(...group.map((candidate) => candidate.stopDeadline));
  try {
    const workers = group.filter((candidate) => !candidate.workerGone);
    const workerResults = await stopTargets(
      workers.map((candidate) => ({ identity: candidate.entry.worker, expectedGroupId: candidate.entry.worker.groupId ?? null, rootAlone: false })),
      deadline
    );
    workers.forEach((candidate, index) => {
      const result = workerResults[index];
      if (result === "stopped") {
        candidate.workerGone = true;
        candidate.stopResult = "stopped";
        candidate.stoppedAt = wallNow();
      } else if (result === "absent" || result === "mismatch") {
        candidate.workerGone = true;
        anchorGrace(store, candidate);
      }
    });
    const withRoots = group.filter((candidate) => candidate.workerGone && candidate.entry.provider && !candidate.rootAbsent);
    const rootResults = await stopTargets(
      withRoots.map((candidate) => ({ identity: candidate.entry.provider, expectedGroupId: candidate.entry.provider.groupId ?? null, rootAlone: true })),
      deadline
    );
    const stoppedRoots = [];
    withRoots.forEach((candidate, index) => {
      const result = rootResults[index];
      if (result === "stopped") {
        candidate.stopResult = "stopped";
        candidate.stoppedAt = wallNow();
      }
      if (result === "absent" || result === "mismatch") {
        candidate.rootAbsent = true;
      } else if (result === "stopped" || result === "root-stopped") {
        stoppedRoots.push(candidate);
      }
    });
    const gone = await waitRootsGone(
      stoppedRoots.map((candidate) => candidate.entry.provider),
      deadline
    );
    for (const candidate of stoppedRoots) {
      candidate.rootAbsent = gone.has(candidate.entry.provider);
    }
  } catch (error) {
    for (const candidate of group) {
      candidate.error = error;
    }
  }
}

// Waits for each candidate's worker until its own wait end, with one batched identity query of
// the workers and their recorded roots in flight at a time, and starts each candidate's tree
// stops once its worker was confirmed absent or its wait ends. A verified stop reads the process's
// identity first and signals right after, so it starts at the wait end, not before.
async function waitAndStop(store, candidates) {
  const stops = [];
  let queryMs = 0;
  // Candidates whose stops become due in one turn of the event loop are stopped as one group.
  let due = [];
  const begin = (candidate) => {
    if (candidate.begun) {
      return;
    }
    candidate.begun = true;
    if (due.length === 0) {
      setImmediate(() => {
        const group = due;
        due = [];
        stops.push(stopCandidates(store, group));
      });
    }
    due.push(candidate);
  };
  // A stop sends its signal as soon as its own identity query returns, which can be faster than
  // the last query of the wait, so it starts at the wait end and never before the deadline.
  const startDue = () => {
    for (const candidate of candidates) {
      if (!candidate.begun && performance.now() >= candidate.waitEnd) {
        begin(candidate);
      }
    }
  };
  const ticker = setInterval(startDue, DUE_CHECK_MS);
  let lastStart = -Infinity;
  try {
    for (;;) {
      startDue();
      const open = candidates.filter((candidate) => !candidate.begun);
      if (open.length === 0) {
        break;
      }
      const until = Math.max(...open.map((candidate) => candidate.waitEnd));
      const pause = Math.max(lastStart + QUERY_SPACING_MS - performance.now(), 0);
      if (pause > 0 || until - performance.now() <= queryMs) {
        await sleep(Math.max(pause, DUE_CHECK_MS));
        continue;
      }
      lastStart = performance.now();
      const identities = await readProcessIdentities(
        open.flatMap((candidate) => [candidate.entry.worker.pid, candidate.entry.provider?.pid]),
        { deadline: until }
      );
      if (POLL_QUERY_DELAY_MS > 0) {
        await sleep(POLL_QUERY_DELAY_MS);
      }
      queryMs = performance.now() - lastStart;
      for (const candidate of open) {
        if (!candidate.begun && confirmIdentity(candidate.entry.worker, identities.get(candidate.entry.worker.pid)) === "absent") {
          candidate.workerGone = true;
          const root = candidate.entry.provider;
          candidate.rootAbsent = Boolean(root) && confirmIdentity(root, identities.get(root.pid)) === "absent";
          anchorGrace(store, candidate);
          begin(candidate);
        }
      }
    }
  } finally {
    clearInterval(ticker);
  }
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.all(stops);
}

// The release decision of each candidate from fresh evidence. A worker that is not confirmed gone
// and a provider root verified present are never released. The roots are read in one batched
// identity query with any worker whose stop was not verified (roots this hook already confirmed
// absent are not asked again), and
// observeClosure gathers the rest of the evidence without a lookup of its own per job: the
// batched verdict is the root's state in the evidence.
async function decideReleases(store, sessionId, candidates) {
  const deadline = END_PHASES.commit;
  const fresh = new Map();
  for (const entry of await withRetry((opts) => readSessionSelection(store, sessionId, opts), "hook", { deadline })) {
    fresh.set(entry.jobId, entry);
  }
  const current = candidates
    .filter((candidate) => fresh.get(candidate.entry.jobId)?.execGen === candidate.entry.execGen)
    .map((candidate) => ({ candidate, input: fresh.get(candidate.entry.jobId).evidence }));
  const knownAbsent = ({ candidate, input }) => candidate.rootAbsent && input.root?.pid === candidate.entry.provider?.pid;
  // A worker whose stop could not be verified in time is asked again in the same query.
  const unsure = current.filter(({ candidate }) => !candidate.workerGone);
  const asked = current.filter((item) => item.input.rootRecorded && item.input.root && !knownAbsent(item));
  const rootIdentities = await readProcessIdentities(
    [...unsure.map(({ candidate }) => candidate.entry.worker.pid), ...asked.map(({ input }) => input.root.pid)],
    { deadline }
  );
  for (const { candidate } of unsure) {
    if (confirmIdentity(candidate.entry.worker, rootIdentities.get(candidate.entry.worker.pid)) === "absent") {
      candidate.workerGone = true;
      anchorGrace(store, candidate, deadline);
    }
  }
  const live = current
    .filter(({ candidate }) => candidate.workerGone)
    .map(({ candidate, input }) => ({ candidate, input: { ...input, graceStartedAt: input.graceStartedAt ?? candidate.graceStartedAt } }));
  const decided = await Promise.all(
    live.map(async (item) => {
      const { candidate, input } = item;
      const outcome = { candidate, input, evidence: null, decision: null };
      try {
        const evidence = await observeClosure(
          { ...input, rootRecorded: false, root: null },
          { deadline, rootExitSeenAt: null, stopResult: candidate.stopResult, stoppedAt: candidate.stoppedAt }
        );
        if (input.rootRecorded) {
          evidence.rootRecorded = true;
          if (evidence.root !== "absent") {
            evidence.root = knownAbsent(item) ? "absent" : confirmIdentity(input.root, rootIdentities.get(input.root?.pid));
          }
        }
        outcome.evidence = evidence;
        if (evidence.root !== "present") {
          outcome.decision = decideRelease(evidence);
        }
      } catch (error) {
        candidate.error = error;
      }
      return outcome;
    })
  );
  // A contract window that ends before the commit deadline is waited out once.
  const margin = 300;
  const waitUntil = Math.max(
    0,
    ...decided
      .filter((outcome) => outcome.decision?.kind === "wait" && Number.isFinite(outcome.decision.until))
      .map((outcome) => outcome.decision.until)
      .filter((until) => until - wallNow() < deadline - margin - performance.now())
  );
  if (waitUntil > 0) {
    await sleep(waitUntil - wallNow());
    for (const outcome of decided) {
      if (outcome.decision?.kind === "wait" && outcome.evidence) {
        outcome.decision = decideRelease(outcome.evidence);
      }
    }
  }
  const decisionOf = new Map(decided.map((outcome) => [outcome.candidate, outcome.decision]));
  return current.map(({ candidate, input }) => {
    const decision = decisionOf.get(candidate);
    return {
      jobId: candidate.entry.jobId,
      execGen: candidate.entry.execGen,
      release:
        decision && (decision.kind === "confirmed" || decision.kind === "unobserved")
          ? { kind: decision.kind, expectedExitSeenAt: input.providerExitSeenAt ?? null }
          : null
    };
  });
}

function reportUnreleased(result) {
  const lines = [
    ...result.stopping.map((jobId) => `${jobId} (stopping: its provider could not be confirmed stopped)`),
    ...result.unreleased.map((jobId) => `${jobId} (ended; its process cleanup is not confirmed yet)`)
  ];
  if (lines.length > 0) {
    writeLine(`Session end left ${lines.length} job(s) for the next scan to release: ${lines.join(", ")}.`);
  }
}

// The stop transaction did not commit by its phase end: the workers are waited for and then
// stopped by verified identity from a read of the selection, and nothing is recorded.
async function busyFallback(store, sessionId) {
  let selection;
  try {
    selection = readSessionSelection(store, sessionId, { deadline: END_PHASES.wait });
  } catch (error) {
    writeLine(`The job store was busy; stop requests were not recorded, and the session's jobs could not be read: ${messageOf(error)}`);
    return;
  }
  const candidates = selection.filter((entry) => entry.worker).map((entry) => candidateOf(entry, END_PHASES.wait));
  await waitAndStop(null, candidates);
  const unconfirmed = candidates.filter((candidate) => !candidate.workerGone).map((candidate) => candidate.entry.jobId);
  writeLine(
    `The job store was busy; stop requests were not recorded. ${candidates.length - unconfirmed.length} of ${candidates.length} ` +
      `worker(s) are gone${unconfirmed.length > 0 ? `; not confirmed stopped: ${unconfirmed.join(", ")}` : ""}. ` +
      "The next scan and each worker's leader check finish the rest."
  );
}

async function handleSessionEnd(input) {
  if (readHookReason(input) === "clear") {
    return;
  }
  const sessionId = input.session_id || getSessionId();
  if (!sessionId) {
    return;
  }
  const gate = checkRuntime();
  if (!gate.ok) {
    writeLine(runtimeGateMessage(gate));
    return;
  }
  const stateDir = resolveStateDir(input.cwd || process.cwd());
  if (!storeExists(stateDir)) {
    return;
  }
  let store;
  try {
    store = openStore(stateDir, { deadline: END_PHASES.open });
  } catch (error) {
    writeLine(`Session end could not open the job store; no stop was requested: ${messageOf(error)}`);
    return;
  }
  try {
    let stop;
    try {
      stop = await withRetry(
        (opts) =>
          requestStop(store, { sessionId }, { reason: "session-end", sessionId, afterMs: STOP_AFTER_MS, maxLocalDeadline: END_PHASES.wait }, opts),
        "hook",
        { deadline: END_PHASES.stop }
      );
    } catch (error) {
      if (error instanceof StoreError && error.class === "availability") {
        await busyFallback(store, sessionId);
        return;
      }
      throw error;
    }
    const candidates = stop.selection
      .filter((entry) => entry.worker)
      .map((entry) => candidateOf(entry, Math.min(stop.localDeadline, entry.localDeadline ?? stop.localDeadline)));
    await waitAndStop(store, candidates);
    let result;
    try {
      const decisions = await decideReleases(store, sessionId, candidates);
      result = await withRetry((opts) => commitSessionEnd(store, decisions, opts), "hook", { deadline: END_PHASES.commit });
    } catch (error) {
      writeLine(`Session end could not record the releases: ${messageOf(error)}`);
      result = { released: [], stopping: candidates.map((candidate) => candidate.entry.jobId), unreleased: [], skipped: [] };
    }
    reportUnreleased(result);
  } catch (error) {
    writeLine(`Session end stopped early: ${messageOf(error)}`);
  } finally {
    store.close();
  }
}

async function main() {
  const input = await readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    await handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${messageOf(error)}\n`);
  process.exit(0);
});
