#!/usr/bin/env node

// Runs as the plugin's monitor for the whole Claude Code session. It is the session's guaranteed
// scanner of the workspace's job store: every poll it samples the heartbeat file of every active
// execution and judges staleness by its own poll count; every scan interval it finishes committed
// work (execution cleanup, stale workers, launches, automatic continuations); at most hourly it
// prunes, and at most daily one monitor of the workspace runs the integrity check. Each line it
// prints reaches Claude as a notification and costs a model turn, so it prints one line per job
// event (completed, failed, waiting, interrupted) of its own session, and none for an event whose
// outcome a waiting command already returned.

import fs from "node:fs";
import process from "node:process";

import { getHostPid, getSessionId, setPluginDataDir } from "./lib/host.mjs";
import { readLeaderStates } from "./lib/job-control.mjs";
import { createStaleTracker, readLiveSample, removeLiveFile, writeLiveFile } from "./lib/live.mjs";
import { listEvents, markEventPrinted } from "./lib/mailbox.mjs";
import { confirmIdentity, isProcessAlive, readProcessIdentity } from "./lib/process.mjs";
import { getProvider } from "./lib/providers.mjs";
import { pruneChains, resolveStateDir, scanWorkspace } from "./lib/state.mjs";
import {
  boundary,
  checkIntegrity,
  checkRuntime,
  openStore,
  pruneArtifacts,
  reserveIntegrityCheck,
  RETRY_BUDGETS,
  runtimeGateMessage,
  StoreError,
  testPoint,
  wallNow
} from "./lib/store.mjs";
import { launchWorker } from "./lib/task-launch.mjs";

function readPositiveInt(value, fallback) {
  return /^\d+$/.test(String(value ?? "")) && Number(value) > 0 ? Number(value) : fallback;
}

const POLL_MS = readPositiveInt(process.env.AGENT_PLUGIN_MONITOR_POLL_MS, 2000);
const SCAN_MS = readPositiveInt(process.env.AGENT_PLUGIN_SCAN_MS, 10000);
const STALE_POLLS = readPositiveInt(process.env.AGENT_PLUGIN_STALE_POLLS, 8);
// A gap between two polls longer than twice the interval (machine sleep, a stalled monitor)
// resets every staleness count.
const GAP_MS = 2 * POLL_MS;
const PAUSE_FILE = process.env.AGENT_PLUGIN_MONITOR_PAUSE_FILE || null;
// The wall time one scan may take, inside the 10 s scan interval. The monitor's retry budget
// (1,000 ms per attempt, at most 3 s of every 10) bounds the scan's waiting on a busy store: each
// store statement waits at most one 1,000 ms attempt. The rest of the 8 s is process work, where
// one identity query takes about a second on Windows and a stale worker needs several in
// sequence. Scans never overlap.
const SCAN_DEADLINE_MS = 8000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const INTEGRITY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LEADER_TIMEOUT_MS = 5000;
const LEADER_IDENTITY_SCANS = 30;
// A command that waits for a job, such as the delegate agent's result --wait, gets this long after
// the job's event to return the outcome before the monitor announces it.
const DELIVERY_GRACE_MS = 5000;
const DETAIL_CHARS = 120;

function providerName(providerId) {
  try {
    return getProvider(providerId).label;
  } catch {
    return providerId;
  }
}

// A question or error as one line: control characters removed, at most 120 characters, without
// the trailing period the line adds itself.
function detailOf(text) {
  return String(text ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DETAIL_CHARS)
    .replace(/\.+$/, "");
}

/** The one notification line of a job event. */
function eventLine(event) {
  const job = `[event ${event.id}] ${providerName(event.provider)} job ${event.jobId}${event.label ? ` (${event.label})` : ""}`;
  const detail = detailOf(event.text);
  switch (event.kind) {
    case "completed":
      return `${job} completed. Run /agent:result ${event.jobId} for the output.`;
    case "failed":
      return `${job} failed${detail ? `: ${detail}` : ""}. Run /agent:result ${event.jobId}.`;
    case "waiting":
      return `${job} is waiting for an answer: ${detail} Reply with /agent:send ${event.jobId} <answer>.`;
    default:
      return `${job} was interrupted. Continue it with /agent:resume ${event.jobId}.`;
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function isFatal(error) {
  return error instanceof StoreError && (error.class === "store-moved" || error.class === "corruption" || error.class === "future-version");
}

function paused() {
  return Boolean(PAUSE_FILE) && fs.existsSync(PAUSE_FILE);
}

async function main() {
  // Claude Code substitutes ${CLAUDE_PLUGIN_DATA} into the monitor command but does not export it,
  // while the session's commands get it from the SessionStart hook and keep their jobs there.
  if (process.argv[3]) {
    setPluginDataDir(process.argv[3]);
  }
  const gate = checkRuntime();
  if (!gate.ok) {
    process.stderr.write(`${runtimeGateMessage(gate)}\n`);
    process.exit(1);
  }
  const stateDir = resolveStateDir(process.argv[2] || process.cwd());
  let store;
  try {
    store = openStore(stateDir, { busyTimeoutMs: RETRY_BUDGETS.monitor.attemptMs });
  } catch (error) {
    process.stderr.write(`The job monitor could not open the job store: ${messageOf(error)}\n`);
    process.exit(1);
  }

  const hostPid = getHostPid() === null ? null : Number(getHostPid());
  const hostIdentity = hostPid === null ? null : await readProcessIdentity(hostPid, { deadline: performance.now() + LEADER_TIMEOUT_MS });
  const leader = hostIdentity?.state === "present" ? { pid: hostPid, startToken: hostIdentity.startToken } : null;

  let stopping = false;
  const stop = (code, message = null) => {
    if (stopping) {
      return;
    }
    stopping = true;
    if (message) {
      process.stderr.write(`${message}\n`);
    }
    try {
      removeLiveFile(stateDir, "monitor");
    } catch {
      // A file left behind names a process that no longer exists; it proves nothing.
    }
    try {
      store.close();
    } catch {
      // The connection may already be closed by a moved store.
    }
    process.exit(code);
  };
  // A lost or corrupt store ends the monitor; a busy store waits for the next poll or scan; any
  // other error is written to stderr and the monitor carries on.
  const failOn = (error) => {
    if (isFatal(error)) {
      stop(1, `The job monitor stops: ${messageOf(error)}`);
    } else if (!(error instanceof StoreError && error.class === "availability")) {
      process.stderr.write(`The job monitor skipped a step: ${error instanceof Error ? error.stack : String(error)}
`);
    }
  };

  try {
    writeLiveFile(stateDir, "monitor", { hostPid });
  } catch {
    // The identity file only helps a user find holders of the store.
  }

  const startedAt = wallNow();
  const envSession = getSessionId();

  // The sessions whose events this monitor announces: the one the session environment names, and
  // every session whose jobs record this monitor's Claude Code process as their leader. Without
  // either, the sessions of leaderless jobs created since the monitor started.
  function ownSessions() {
    const sessions = new Set(envSession ? [envSession] : []);
    const rows = store.read((db) => {
      if (leader) {
        return db
          .prepare("SELECT DISTINCT session_id FROM jobs WHERE leader_pid = ? AND leader_start_token = ? AND session_id IS NOT NULL")
          .all(leader.pid, String(leader.startToken));
      }
      if (envSession || hostPid !== null) {
        return [];
      }
      return db.prepare("SELECT DISTINCT session_id FROM jobs WHERE leader_pid IS NULL AND created_at >= ? AND session_id IS NOT NULL").all(startedAt);
    });
    for (const row of rows) {
      sessions.add(row.session_id);
    }
    return sessions;
  }

  // One line per unprinted event of this monitor's sessions, after the delivery grace and only
  // when no command returned the outcome; the print is recorded after the line is written, so a
  // monitor that dies in between prints the same event id again.
  function announceEvents() {
    for (const sessionId of ownSessions()) {
      for (const event of listEvents(store, { sessionId, unprinted: true })) {
        if (event.deliveredAt !== null && event.deliveredAt !== undefined) {
          markEventPrinted(store, event.id, sessionId);
          continue;
        }
        if (wallNow() - event.createdAt < DELIVERY_GRACE_MS) {
          continue;
        }
        const delivered = store.read((db) => db.prepare("SELECT delivered_at FROM jobs WHERE id = ?").get(event.jobId)?.delivered_at ?? null);
        if (delivered === null) {
          boundary("stdout");
          process.stdout.write(`${eventLine(event)}
`);
          testPoint("monitor-after-print");
        }
        markEventPrinted(store, event.id, sessionId);
      }
    }
  }

  const tracker = createStaleTracker({ stalePolls: STALE_POLLS, gapMs: GAP_MS });
  let verdicts = new Map();
  let scanning = false;
  let scanRequested = false;
  let lastPruneAt = -Infinity;
  let lastIntegrityAt = -Infinity;

  // One sample of every active execution's heartbeat file into the stale tracker.
  function sampleHeartbeats() {
    const executions = store.read(
      (db) =>
        db
          .prepare("SELECT id, exec_gen, worker_pid, worker_start_token FROM jobs WHERE claimed_at IS NOT NULL AND exec_released_at IS NULL")
          .all(),
      { attemptMs: RETRY_BUDGETS.monitor.attemptMs }
    );
    const samples = new Map();
    for (const row of executions) {
      const claim = { pid: row.worker_pid, startToken: row.worker_start_token, jobId: row.id, execGen: row.exec_gen };
      samples.set(`${row.id}:${row.exec_gen}`, { claim, sample: readLiveSample(stateDir, claim) });
    }
    verdicts = tracker.observeBatch(performance.now(), samples);
    return [...verdicts.values()].some((entry) => entry.verdict === "stale");
  }

  async function maintain(deadline) {
    const now = performance.now();
    if (now - lastPruneAt >= PRUNE_INTERVAL_MS) {
      lastPruneAt = now;
      const { prunedJobIds } = pruneChains(store, {}, { deadline, attemptMs: RETRY_BUDGETS.monitor.attemptMs });
      await pruneArtifacts(stateDir, prunedJobIds);
    }
    if (now - lastIntegrityAt >= INTEGRITY_INTERVAL_MS) {
      lastIntegrityAt = now;
      if (reserveIntegrityCheck(store, {}, { deadline, attemptMs: RETRY_BUDGETS.monitor.attemptMs })) {
        const verdict = checkIntegrity(store);
        if (verdict !== "ok") {
          stop(
            1,
            `The job store failed its integrity check (${verdict.split("\n").slice(0, 2).join(" ")}). Close every session that uses this ` +
              "workspace, then run: agent-companion.mjs store recover"
          );
        }
      }
    }
  }

  let leaderScans = 0;
  async function scan() {
    if (scanning || stopping) {
      scanRequested = scanning;
      return;
    }
    scanning = true;
    try {
      if (leader) {
        // The cheap check runs every scan. The identity query starts a helper process on Windows,
        // so it runs only every LEADER_IDENTITY_SCANS scans, to catch a process id that was reused.
        leaderScans += 1;
        if (!isProcessAlive(leader.pid)) {
          stop(0);
          return;
        }
        if (leaderScans % LEADER_IDENTITY_SCANS === 0 && confirmIdentity(leader, await readProcessIdentity(leader.pid, { deadline: performance.now() + LEADER_TIMEOUT_MS })) === "absent") {
          stop(0);
          return;
        }
      }
      const deadline = performance.now() + SCAN_DEADLINE_MS;
      await scanWorkspace(store, {
        deadline,
        stateDir,
        attemptMs: RETRY_BUDGETS.monitor.attemptMs,
        heartbeats: verdicts,
        launch: (jobId) => launchWorker(store, stateDir, jobId, { deadline }),
        leaderCheck: (views) => readLeaderStates(views, { deadline })
      });
      await maintain(deadline);
    } catch (error) {
      failOn(error);
    } finally {
      scanning = false;
    }
    if (scanRequested && !stopping) {
      scanRequested = false;
      setImmediate(scan);
    }
  }

  function poll() {
    if (stopping || paused()) {
      return;
    }
    if (hostPid !== null && !isProcessAlive(hostPid)) {
      stop(0);
      return;
    }
    try {
      if (sampleHeartbeats()) {
        scan();
      }
      announceEvents();
    } catch (error) {
      failOn(error);
    }
  }

  setInterval(poll, POLL_MS);
  setInterval(() => {
    if (!paused()) {
      scan();
    }
  }, SCAN_MS);
  poll();
  scan();
}

main().catch((error) => {
  process.stderr.write(`The job monitor stopped: ${messageOf(error)}\n`);
  process.exit(1);
});
