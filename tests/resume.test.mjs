import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { decideNext, resolveStateDir } from "../plugins/agent/scripts/lib/state.mjs";
import { readProcessIdentity } from "../plugins/agent/scripts/lib/process.mjs";
import { NODE_LAUNCH_FLAGS, openStore } from "../plugins/agent/scripts/lib/store.mjs";
import { makeTempDir, stopOwnedProcess } from "./helpers.mjs";
import {
  jobProcesses,
  jobRow,
  rawAll,
  rawExec,
  readTrace,
  seedStore,
  startHelperProcess,
  startTestWorker,
  trackProcesses,
  waitFor,
  workerEnv
} from "./store-fixtures.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION = path.join(ROOT, "plugins", "agent", "scripts", "agent-companion.mjs");

// Runs agent-companion.mjs in `workspace`; resolves to { code, stdout, stderr, pid }. The test
// driver is the worker entry, so a launched worker runs the test driver's fake provider.
function companion(workspace, args, { env = {}, input = null } = {}) {
  const child = spawn(process.execPath, [...NODE_LAUNCH_FLAGS, COMPANION, ...args], {
    cwd: workspace,
    env: { ...process.env, ...workerEnv(), ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.on("error", () => {});
  child.stdin.end(input ?? "");
  const done = new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr, pid: child.pid })));
  done.child = child;
  return done;
}

// A workspace folder and its state folder.
function workspaceOf(t) {
  const workspace = makeTempDir(t);
  return { workspace, stateDir: resolveStateDir(workspace) };
}

const T0 = Date.now() - 60000;

function seededJob(id, fields = {}) {
  return {
    id,
    chain_id: fields.chain_id ?? id,
    provider: "codex",
    kind: "task",
    title: `job ${id}`,
    prompt: "do it",
    request_json: JSON.stringify({ cwd: ".", testDriver: fields.testDriver ?? {} }),
    cwd: ".",
    created_at: T0,
    updated_at: T0,
    session_id: "session-1",
    ...Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "testDriver"))
  };
}

function withStore(stateDir, fn) {
  const store = openStore(stateDir);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

// Stops the worker and provider processes the job's row and trace record when the test ends.
function trackJob(tracked, stateDir, jobId) {
  tracked.push(...jobProcesses(stateDir, jobId));
}

test("an exact id and a label resolve differently", async (t) => {
  const tracked = trackProcesses(t);
  const { workspace, stateDir } = workspaceOf(t);
  await seedStore(stateDir, {
    chains: [{ id: "task-j", tip_job_id: "task-j", live_label: "r", created_at: T0, activity_at: T0 }],
    jobs: [
      seededJob("task-j", {
        label: "r",
        testDriver: { delayMs: 60000 },
        end_state: "interrupted",
        end_at: T0 + 10,
        end_by: "reconcile",
        result_text: "the stored output of J",
        result_at: T0 + 10
      })
    ]
  });
  const { successorId: x } = withStore(stateDir, (store) =>
    decideNext(store, { ref: "task-j", observedTipId: "task-j" }, { action: "continue", requester: { sessionId: "session-1" } })
  );
  t.after(() => trackJob(tracked, stateDir, x));

  // status reconciles first, and the scan launches the successor's worker.
  const first = await companion(workspace, ["status"]);
  assert.equal(first.code, 0, first.stderr);
  await waitFor(() => jobRow(stateDir, x)?.started_at, { describe: "the successor's turn start" });
  trackJob(tracked, stateDir, x);

  const resultJ = await companion(workspace, ["result", "task-j"]);
  assert.equal(resultJ.code, 0, resultJ.stderr);
  assert.match(resultJ.stdout, /the stored output of J/);
  assert.ok(resultJ.stdout.includes(x), resultJ.stdout);

  const statusJ = await companion(workspace, ["status", "task-j", "--json"]);
  assert.equal(statusJ.code, 0, statusJ.stderr);
  const statusJobs = JSON.parse(statusJ.stdout).jobs;
  assert.deepEqual(
    statusJobs.map((job) => [job.id, job.status]),
    [["task-j", "interrupted"]]
  );

  const sendJ = await companion(workspace, ["send", "--json", "--timeout-ms", "500", "task-j", "hi"]);
  assert.equal(sendJ.code, 0, sendJ.stderr);
  assert.equal(JSON.parse(sendJ.stdout).jobId, x);

  const resultR = await companion(workspace, ["result", "r"]);
  assert.equal(resultR.code, 0, resultR.stderr);
  assert.ok(resultR.stdout.includes(x), resultR.stdout);
  assert.match(resultR.stdout, /running/);
  assert.doesNotMatch(resultR.stdout, /the stored output of J/);
});

// ---------------------------------------------------------------------------------------------
// resume

const DAY_MS = 24 * 60 * 60 * 1000;

// A job that ended `state` with a recorded thread; its continuation resumes that thread.
function endedJob(id, state, fields = {}) {
  return seededJob(id, {
    thread_id: `th-${id}`,
    resume_method: "thread",
    submit_intent_at: T0,
    end_state: state,
    end_at: T0 + 10,
    end_by: "worker",
    testDriver: { exitBeforeClaim: true },
    ...fields
  });
}

function chainRow(id, fields = {}) {
  return { id, tip_job_id: id, created_at: T0, activity_at: T0, ...fields };
}

function successorsOf(stateDir, jobId) {
  return rawAll(stateDir, "SELECT * FROM jobs WHERE continues = ?", [jobId]);
}

test("a carried message is delivered once where the provider can tell", async (t) => {
  const tracked = trackProcesses(t);
  for (const historyHolds of [false, true]) {
    const { workspace, stateDir } = workspaceOf(t);
    await seedStore(stateDir, {
      chains: [chainRow("task-c")],
      jobs: [endedJob("task-c", "interrupted", { claimed_at: T0, exec_gen: 1, exec_released_at: T0 + 20, release_kind: "confirmed" })],
      messages: [
        { chain_id: "task-c", text: "first", created_at: T0 + 1 },
        { chain_id: "task-c", text: "second", created_at: T0 + 2 }
      ]
    });
    rawExec(
      stateDir,
      "UPDATE messages SET state = 'dispatched', attempts = 1, dispatched_at = ?, dispatched_job_id = 'task-c', dispatched_gen = 1 WHERE id = 1",
      [T0 + 5]
    );
    const instance = rawAll(stateDir, "SELECT value FROM meta WHERE key = 'instance_id'")[0].value;
    const firstClientId = `agent-${instance}-1`;
    const testDriver = { steer: true, delayMs: 1500, historyPages: historyHolds ? [[], [firstClientId]] : [[], []] };
    rawExec(stateDir, "UPDATE jobs SET request_json = ? WHERE id = 'task-c'", [JSON.stringify({ cwd: ".", testDriver })]);

    const resumed = await companion(workspace, ["resume", "--json", "task-c"]);

    assert.equal(resumed.code, 0, resumed.stderr);
    const successor = JSON.parse(resumed.stdout).jobId;
    t.after(() => trackJob(tracked, stateDir, successor));
    await waitFor(() => jobRow(stateDir, successor)?.end_state, { describe: "the continuation's end" });
    trackJob(tracked, stateDir, successor);
    const requests = readTrace(stateDir, successor).filter((entry) => entry.type === "request" && ["start", "steer"].includes(entry.request));
    const messages = rawAll(stateDir, "SELECT * FROM messages ORDER BY id");
    for (const message of messages) {
      assert.equal(message.state, "consumed", JSON.stringify(message));
      assert.equal(message.consumed_job_id, successor);
    }
    const sent = requests.map((entry) => `${entry.request} ${entry.clientId}`);
    if (historyHolds) {
      assert.deepEqual(sent, [`start agent-${instance}-2`]);
      assert.match(requests[0].text, /^\[message 2\]\n/);
      assert.equal(messages[0].attempts, 1);
    } else {
      assert.deepEqual(sent, [`start ${firstClientId}`, `steer agent-${instance}-2`]);
      assert.match(requests[0].text, /^\[message 1\]\n/);
      assert.match(requests[1].text, /^\[message 2\]\n/);
      assert.equal(messages[0].attempts, 2);
    }
  }
});

test("a cancelled job can be continued only with --force", async (t) => {
  const { workspace, stateDir } = workspaceOf(t);
  await seedStore(stateDir, {
    chains: [chainRow("task-w"), chainRow("task-f"), chainRow("task-x")],
    jobs: [
      endedJob("task-w", "waiting", { question: "which?", next_action: "cancel", next_at: T0 + 20, cancelled_at: T0 + 20 }),
      endedJob("task-f", "failed", { error: "it broke" }),
      endedJob("task-x", "cancelled", { end_by: "cancel" })
    ],
    messages: [{ chain_id: "task-w", text: "dropped one", created_at: T0 + 1 }]
  });
  rawExec(stateDir, "UPDATE messages SET state = 'dropped', closed_at = ?, close_cause = 'cancelled' WHERE id = 1", [T0 + 20]);

  for (const jobId of ["task-w", "task-f", "task-x"]) {
    const refused = await companion(workspace, ["resume", jobId]);
    assert.equal(refused.code, 1, `${jobId}: ${refused.stdout}`);
    assert.match(refused.stderr, /resume --force/);
    assert.equal(successorsOf(stateDir, jobId).length, 0);
  }
  for (const jobId of ["task-w", "task-f", "task-x"]) {
    const forced = await companion(workspace, ["resume", jobId, "--force"]);
    assert.equal(forced.code, 0, `${jobId}: ${forced.stderr}`);
    assert.equal(successorsOf(stateDir, jobId).length, 1, jobId);
  }
  const first = jobRow(stateDir, "task-w");
  assert.ok(first.cancelled_at, "the first job no longer reads cancelled");
  assert.equal(first.next_action, "continue");
  assert.deepEqual(
    rawAll(stateDir, "SELECT state FROM messages").map((row) => row.state),
    ["dropped"]
  );
});

test("two forced resumes report one successor", async (t) => {
  for (let round = 0; round < 20; round += 1) {
    const { workspace, stateDir } = workspaceOf(t);
    await seedStore(stateDir, {
      chains: [chainRow("task-w")],
      jobs: [endedJob("task-w", "waiting", { question: "which?", next_action: "cancel", next_at: T0 + 20, cancelled_at: T0 + 20 })]
    });

    const results = await Promise.all([
      companion(workspace, ["resume", "--json", "task-w", "--force"]),
      companion(workspace, ["resume", "--json", "task-w", "--force"])
    ]);

    const successors = successorsOf(stateDir, "task-w");
    assert.equal(successors.length, 1, `round ${round}`);
    const replies = results.map((result) => {
      assert.equal(result.code, 0, result.stderr);
      return JSON.parse(result.stdout);
    });
    assert.deepEqual(replies.map((reply) => reply.status).sort(), ["continued", "existing"]);
    assert.deepEqual(
      replies.map((reply) => reply.jobId),
      [successors[0].id, successors[0].id]
    );
  }
});

test("resume refuses a stopping job", async (t) => {
  const { workspace, stateDir } = workspaceOf(t);
  await seedStore(stateDir, {
    chains: [chainRow("task-s")],
    jobs: [
      seededJob("task-s", {
        thread_id: "th-s",
        submit_intent_at: T0,
        claimed_at: T0,
        exec_gen: 1,
        started_at: T0 + 10,
        stop_requested_at: T0 + 20,
        stop_reason: "session-end",
        stopping_since: T0 + 30,
        stopping_cause: "unconfirmed-stop"
      })
    ]
  });

  const refused = await companion(workspace, ["resume", "task-s", "go on"]);

  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stderr, /earlier provider process has not been confirmed gone/);
  assert.equal(successorsOf(stateDir, "task-s").length, 0);
  assert.equal(rawAll(stateDir, "SELECT count(*) AS n FROM messages")[0].n, 0);
});

test("resume and send respect the thread barrier", async (t) => {
  const old = Date.now() - 16 * DAY_MS;
  const barrierFixture = async () => {
    const fixture = workspaceOf(t);
    await seedStore(fixture.stateDir, {
      chains: [chainRow("task-b", { created_at: old, activity_at: old })],
      jobs: [
        endedJob("task-b", "interrupted", {
          created_at: old,
          updated_at: old,
          end_at: old,
          end_by: "reconcile",
          claimed_at: old,
          exec_gen: 1,
          exec_released_at: old,
          release_kind: "unobserved",
          provider_exit_unobserved: 1
        })
      ],
      thread_barriers: [{ provider: "codex", thread_id: "th-task-b", job_id: "task-b", created_at: old }]
    });
    return fixture;
  };
  const warning = "Thread th-task-b was last used by job task-b, whose provider exit was not observed; it may still run and overlap this job.";

  for (const [command, ...rest] of [["resume", "task-b"], ["send", "task-b", "x"]]) {
    const { workspace, stateDir } = await barrierFixture();
    const refused = await companion(workspace, [command, ...rest]);
    assert.equal(refused.code, 1, `${command}: ${refused.stdout}`);
    assert.match(refused.stderr, /task-b/);
    assert.match(refused.stderr, /--force/);
    assert.equal(successorsOf(stateDir, "task-b").length, 0);

    const forced = await companion(workspace, [command, "--force", ...rest]);
    assert.equal(forced.code, 0, `${command} --force: ${forced.stderr}`);
    assert.ok(forced.stdout.includes(warning), forced.stdout);
    const [successor] = successorsOf(stateDir, "task-b");
    assert.equal(successor.forced, 1);
  }

  // After pruning the chain is gone and the barrier row remains.
  const { workspace, stateDir } = await barrierFixture();
  const recent = Date.now() - DAY_MS;
  await seedStore(stateDir, {
    chains: Array.from({ length: 50 }, (_, index) => chainRow(`task-n${index}`, { created_at: recent, activity_at: recent + index })),
    jobs: Array.from({ length: 50 }, (_, index) => endedJob(`task-n${index}`, "completed", { created_at: recent, updated_at: recent }))
  });
  const pruning = await companion(workspace, ["status"]);
  assert.equal(pruning.code, 0, pruning.stderr);
  assert.equal(jobRow(stateDir, "task-b"), undefined);
  assert.equal(rawAll(stateDir, "SELECT count(*) AS n FROM thread_barriers")[0].n, 1);
  for (const args of [
    ["resume", "task-b"],
    ["resume", "--force", "task-b"],
    ["send", "task-b", "x"],
    ["send", "--force", "task-b", "x"]
  ]) {
    const result = await companion(workspace, args);
    assert.equal(result.code, 1, `${args.join(" ")}: ${result.stdout}`);
    assert.match(result.stderr, /No job matches "task-b"/);
  }
});

test("two status commands launch a successor whose resume was stopped after its commit", async (t) => {
  const tracked = trackProcesses(t);
  const { workspace, stateDir } = workspaceOf(t);
  const pointsDir = makeTempDir(t);
  await seedStore(stateDir, { chains: [chainRow("task-d")], jobs: [endedJob("task-d", "completed", { testDriver: { delayMs: 100 } })] });

  const resuming = companion(workspace, ["resume", "task-d", "carry on"], {
    env: { AGENT_PLUGIN_TEST_POINTS: "after-decide-commit", AGENT_PLUGIN_TEST_POINTS_DIR: pointsDir }
  });
  tracked.push(resuming.child);
  await waitFor(() => fs.readdirSync(pointsDir).some((name) => name.startsWith("after-decide-commit-")), { describe: "the resume at its commit point" });
  assert.equal(await stopOwnedProcess(resuming.child), "stopped");
  await resuming;
  const [successor] = successorsOf(stateDir, "task-d");
  assert.ok(successor, "the resume committed no successor");
  assert.equal(successor.launch_attempts, 0);
  t.after(() => trackJob(tracked, stateDir, successor.id));

  const started = Date.now();
  const statuses = await Promise.all([companion(workspace, ["status"]), companion(workspace, ["status"])]);
  for (const status of statuses) {
    assert.equal(status.code, 0, status.stderr);
  }
  await waitFor(() => jobRow(stateDir, successor.id)?.end_state, { timeoutMs: 6000, describe: "the successor's end within 6 s" });
  assert.ok(Date.now() - started < 6000);
  trackJob(tracked, stateDir, successor.id);
  assert.equal(jobRow(stateDir, successor.id).exec_gen, 1);
  const starts = readTrace(stateDir, successor.id).filter((entry) => entry.type === "request" && entry.request === "start");
  assert.equal(starts.length, 1);
  assert.equal(successorsOf(stateDir, "task-d").length, 1);
});

// ---------------------------------------------------------------------------------------------
// cancel

// Cleanup contracts that let the test driver's provider release confirmed on this platform for
// both providers, so a stopped job ends instead of waiting out the grace window.
const BOTH_CONTRACTS = JSON.stringify(
  ["codex", "agy"].flatMap((provider) =>
    ["tree-stop", "own-exit", "owner-death"].map((trigger) => ({ provider, platform: process.platform, trigger, version: "0.0.1", windowMs: 0 }))
  )
);

function chainStates(stateDir, chainId) {
  return JSON.stringify(
    rawAll(stateDir, "SELECT id, end_state, next_action, cancelled_at IS NOT NULL AS cancelled FROM jobs WHERE chain_id = ? ORDER BY created_at, id", [chainId])
  );
}

test("cancel and resume cannot both win", async (t) => {
  for (let round = 0; round < 20; round += 1) {
    const { workspace, stateDir } = workspaceOf(t);
    await seedStore(stateDir, { chains: [chainRow("task-w")], jobs: [endedJob("task-w", "waiting", { question: "which?" })] });

    const [cancelled, resumed] = await Promise.all([companion(workspace, ["cancel", "task-w"]), companion(workspace, ["resume", "task-w", "go"])]);

    assert.equal(cancelled.code, 0, `round ${round}: ${cancelled.stderr}`);
    const first = jobRow(stateDir, "task-w");
    const successors = successorsOf(stateDir, "task-w");
    if (first.next_action === "cancel") {
      assert.equal(successors.length, 0, `round ${round}`);
      assert.equal(resumed.code, 1, resumed.stdout);
      assert.match(resumed.stderr, /cancelled/);
    } else {
      assert.equal(first.next_action, "continue");
      assert.equal(successors.length, 1, `round ${round}`);
      assert.equal(resumed.code, 0, resumed.stderr);
      assert.equal(jobRow(stateDir, successors[0].id).end_state, "cancelled", `round ${round}: ${chainStates(stateDir, "task-w")}`);
    }
    const reads = new Set(Array.from({ length: 10 }, () => chainStates(stateDir, "task-w")));
    assert.equal(reads.size, 1);
  }
});

test("cancel of a running non-interruptible job says how it stopped only with tree-stop evidence, and reports the final read otherwise", async (t) => {
  const tracked = trackProcesses(t);
  const stoppedLine = /Antigravity cannot be interrupted; it was stopped by process id\./;

  // A running Antigravity job whose worker stops the provider tree.
  {
    const { workspace, stateDir } = workspaceOf(t);
    await seedStore(stateDir, {
      chains: [chainRow("task-g")],
      jobs: [seededJob("task-g", { provider: "agy", testDriver: { interrupt: false, delayMs: 60000 } })]
    });
    startTestWorker(stateDir, "task-g", workerEnv({ AGENT_PLUGIN_TEST_CONTRACTS: BOTH_CONTRACTS }), tracked);
    await waitFor(() => jobRow(stateDir, "task-g")?.started_at, { describe: "the turn start" });
    trackJob(tracked, stateDir, "task-g");

    const cancelled = await companion(workspace, ["cancel", "task-g"], { env: { AGENT_PLUGIN_TEST_CONTRACTS: BOTH_CONTRACTS } });

    assert.equal(cancelled.code, 0, cancelled.stderr);
    const row = jobRow(stateDir, "task-g");
    assert.equal(row.end_state, "cancelled", JSON.stringify(row));
    assert.equal(row.end_reason, "tree-stop");
    assert.match(cancelled.stdout, stoppedLine);
  }

  // A claimed Antigravity job whose worker and provider are already gone: reconciliation ends it.
  {
    const { workspace, stateDir } = workspaceOf(t);
    await seedStore(stateDir, {
      chains: [chainRow("task-h")],
      jobs: [seededJob("task-h", { provider: "agy", claimed_at: T0, exec_gen: 1, worker_pid: 999999, worker_start_token: "gone", started_at: T0 + 5 })]
    });

    const cancelled = await companion(workspace, ["cancel", "task-h"]);

    assert.equal(cancelled.code, 0, cancelled.stderr);
    const row = jobRow(stateDir, "task-h");
    assert.equal(row.end_state, "cancelled", JSON.stringify(row));
    assert.notEqual(row.end_reason, "tree-stop");
    assert.match(cancelled.stdout, /task-h was cancelled/);
    assert.doesNotMatch(cancelled.stdout, stoppedLine);
  }

  // A job whose worker is alive and does not act on the stop stays stopping.
  {
    const { workspace, stateDir } = workspaceOf(t);
    const helper = await startHelperProcess();
    tracked.push(helper.process);
    const identity = await readProcessIdentity(helper.pid, { deadline: performance.now() + 15000 });
    assert.equal(identity.state, "present");
    await seedStore(stateDir, {
      chains: [chainRow("task-k")],
      jobs: [
        seededJob("task-k", {
          provider: "agy",
          claimed_at: Date.now(),
          exec_gen: 1,
          worker_pid: helper.pid,
          worker_start_token: identity.startToken,
          spawn_intent_at: Date.now(),
          started_at: Date.now()
        })
      ]
    });

    const cancelled = await companion(workspace, ["cancel", "task-k"]);

    assert.equal(cancelled.code, 0, cancelled.stderr);
    const row = jobRow(stateDir, "task-k");
    assert.equal(row.end_state, null, JSON.stringify(row));
    assert.match(cancelled.stdout, /task-k is (stopping|running)/);
    assert.ok(cancelled.stdout.includes(row.stopping_since === null ? "running" : "stopping"), cancelled.stdout);
    assert.doesNotMatch(cancelled.stdout, stoppedLine);
  }
});

test("resume runs the recovery scan, which launches committed work whose launcher was lost", async (t) => {
  const tracked = trackProcesses(t);
  const { workspace, stateDir } = workspaceOf(t);
  await seedStore(stateDir, {
    chains: [chainRow("task-q"), chainRow("task-r")],
    jobs: [
      // A queued job of another chain that no launcher ever started.
      seededJob("task-q"),
      endedJob("task-r", "completed", { claimed_at: T0, exec_gen: 1, exec_released_at: T0 + 20, release_kind: "confirmed" })
    ]
  });
  t.after(() => trackJob(tracked, stateDir, "task-q"));

  const resumed = await companion(workspace, ["resume", "--json", "task-r", "go on"]);
  assert.equal(resumed.code, 0, resumed.stderr);
  t.after(() => trackJob(tracked, stateDir, JSON.parse(resumed.stdout).jobId));

  assert.notEqual(jobRow(stateDir, "task-q").last_launch_at, null, "resume returned without launching the queued job of another chain");
});

test("cancel also cancels a successor created between its tip read and its stop request", async (t) => {
  const { workspace, stateDir } = workspaceOf(t);
  const pointsDir = makeTempDir(t);
  await seedStore(stateDir, {
    chains: [chainRow("task-a")],
    jobs: [seededJob("task-a", { claimed_at: T0, exec_gen: 1, worker_pid: 999999, worker_start_token: "gone", started_at: T0 + 5 })]
  });

  const cancelling = companion(workspace, ["cancel", "task-a"], {
    env: { AGENT_PLUGIN_TEST_POINTS: "cancel-before-stop", AGENT_PLUGIN_TEST_POINTS_DIR: pointsDir }
  });
  await waitFor(() => fs.readdirSync(pointsDir).some((name) => name.startsWith("cancel-before-stop-")), { describe: "cancel reading the tip" });
  // The running turn ends and a continuation for a pending message wins before the stop request.
  const now = Date.now();
  rawExec(
    stateDir,
    "UPDATE jobs SET end_state = 'completed', end_at = ?, end_by = 'worker', thread_id = 'th-a', resume_method = 'thread', submit_intent_at = ?, exec_released_at = ?, release_kind = 'confirmed' WHERE id = 'task-a'",
    [now, T0, now]
  );
  const { successorId } = withStore(stateDir, (store) =>
    decideNext(store, { ref: "task-a", observedTipId: "task-a" }, { action: "continue", requester: { sessionId: "session-1" } })
  );
  fs.writeFileSync(path.join(pointsDir, "cancel-before-stop.release"), "");
  const cancelled = await cancelling;

  assert.equal(cancelled.code, 0, cancelled.stderr);
  assert.equal(jobRow(stateDir, successorId).end_state, "cancelled", chainStates(stateDir, "task-a"));
  assert.ok(cancelled.stdout.includes(`Job ${successorId} was cancelled.`), cancelled.stdout);
});

test("cancel names a job that has already finished", async (t) => {
  const { workspace, stateDir } = workspaceOf(t);
  await seedStore(stateDir, { chains: [chainRow("task-e")], jobs: [endedJob("task-e", "completed")] });

  const cancelled = await companion(workspace, ["cancel", "task-e"]);

  assert.equal(cancelled.code, 1, cancelled.stdout);
  assert.match(cancelled.stderr, /Job task-e has already completed, so there is nothing to cancel\./);
  assert.equal(jobRow(stateDir, "task-e").cancelled_at, null);
});
