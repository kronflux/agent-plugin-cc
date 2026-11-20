import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { outputCommandResult, parseCommandInput, resolveCommandCwd } from "../lib/companion-cli.mjs";
import { isGitRepository } from "../lib/git.mjs";
import { getSessionId } from "../lib/host.mjs";
import { reconcileStore } from "../lib/job-control.mjs";
import { fenceFor, renderFleetTable } from "../lib/render.mjs";
import {
  ManifestError,
  buildRunRecord,
  checkProviders,
  finalizeRunRecord,
  memberStatusObject,
  newRunId,
  providerFailureLine,
  readFleetManifest,
  readRunMemberViews,
  readRunRecord,
  runCompanion,
  startMember,
  writeRunRecord
} from "../lib/runs.mjs";
import { RETRY_BUDGETS } from "../lib/store.mjs";
import { commandStateDir, retrying, withCommandStore } from "./store.mjs";

// `fleet`: a set of independent background jobs started together from one manifest and tracked
// as one run.

export const usage =
  "fleet start <manifest.json> [--allow-outside-files] | status|wait|results|cancel <run-id> [--any] [--timeout-ms <ms>] [--out <dir>] [--json]";

function renderStart(record) {
  const lines = [`Fleet ${record.id}${record.name ? ` (${record.name})` : ""}: ${record.members.length} members`];
  for (const member of record.members) {
    lines.push(
      member.jobId ? `- ${member.label}: ${member.provider} ${member.jobId}` : `- ${member.label}: ${member.provider} start failed: ${member.startError}`
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * `fleet start <manifest.json>`, in a fixed order: the manifest is checked, each provider is
 * checked once, the run record is written, every member is started in parallel, and the record is
 * finalised once with every outcome. A manifest or provider failure exits 1 with no job and no
 * record; a member that fails to start is recorded and the command still exits 0.
 */
async function startFleet(options, positionals) {
  const file = positionals[0];
  if (!file || positionals.length > 1) {
    throw new Error(`Usage: node scripts/agent-companion.mjs fleet start <manifest.json> [--allow-outside-files] [--json]`);
  }
  const cwd = resolveCommandCwd(options);
  let manifest;
  try {
    manifest = readFleetManifest(file, { cwd, inGitRepo: isGitRepository(cwd), allowOutsideFiles: options["allow-outside-files"] === true });
  } catch (error) {
    if (error instanceof ManifestError) {
      throw new Error(error.message);
    }
    throw error;
  }
  const checks = await checkProviders(
    manifest.members.map((member) => member.provider),
    { cwd, env: process.env }
  );
  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    throw new Error(failed.map(providerFailureLine).join("\n"));
  }
  const stateDir = commandStateDir(options);
  const runId = newRunId();
  writeRunRecord(stateDir, buildRunRecord({ id: runId, name: manifest.name, sessionId: getSessionId(process.env), members: manifest.members }));
  const outcomes = await Promise.all(manifest.members.map((member) => startMember(member, { cwd, env: process.env, runId })));
  const record = finalizeRunRecord(stateDir, runId, outcomes);
  outputCommandResult({ run: record }, renderStart(record), options.json);
}

// ---------------------------------------------------------------------------------------------
// Commands over a run's job rows

/** How often `fleet wait` reads the members' states. */
export const FLEET_WAIT_POLL_MS = 1000;
/** How long `fleet wait` waits by default. */
export const DEFAULT_FLEET_WAIT_MS = 600000;
// How often `fleet wait` runs the store's reconciliation scan, which ends the jobs of dead workers.
const RECONCILE_EVERY_MS = 10000;
const WAIT_TIMEOUT_EXIT = 75;
const ACTIVE_STATES = new Set(["queued", "running", "stopping"]);
const FINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const NOT_STARTED = new Set(["start-failed", "start-unknown", "pruned"]);
const AGENT_COMPANION = fileURLToPath(new URL("../agent-companion.mjs", import.meta.url));

function runArgument(positionals, action) {
  const runId = positionals[0];
  if (!runId || positionals.length > 1) {
    throw new Error(`Usage: node scripts/agent-companion.mjs fleet ${action} <run-id>`);
  }
  return runId;
}

function loadRecord(stateDir, runId) {
  const record = readRunRecord(stateDir, runId);
  if (!record) {
    throw new Error(`No fleet run ${runId} in this workspace.`);
  }
  return record;
}

// The record and its members' entries (`readRunMemberViews`), read once from the store.
async function readMembers(stateDir, record) {
  return withCommandStore(stateDir, (store) => retrying((opts) => readRunMemberViews(store, record, opts)));
}

function statusPayload(record, entries) {
  return { run: record, members: entries.map(memberStatusObject) };
}

function renderStatus(record, entries) {
  const members = entries.map(memberStatusObject);
  return `Fleet ${record.id}${record.name ? ` (${record.name})` : ""}\n\n${renderFleetTable(members)}`;
}

/** `fleet status <run-id>`: one row per member from the store's job rows; changes nothing. */
async function fleetStatus(options, positionals) {
  const stateDir = commandStateDir(options);
  const record = loadRecord(stateDir, runArgument(positionals, "status"));
  const entries = await readMembers(stateDir, record);
  outputCommandResult(statusPayload(record, entries), renderStatus(record, entries), options.json);
}

function parseTimeout(value) {
  if (value === undefined) {
    return DEFAULT_FLEET_WAIT_MS;
  }
  const timeoutMs = Number(String(value).trim());
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number of milliseconds.");
  }
  return timeoutMs;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `fleet wait <run-id> [--any] [--timeout-ms <ms>]`: reads the members every second until none is
 * queued, running or stopping (with --any, until one is not). A member that never started counts
 * as done. On timeout it prints the table and exits 75.
 */
async function fleetWait(options, positionals) {
  const stateDir = commandStateDir(options);
  const record = loadRecord(stateDir, runArgument(positionals, "wait"));
  const timeoutMs = parseTimeout(options["timeout-ms"]);
  const started = performance.now();
  let lastReconcile = started;
  let entries;
  for (;;) {
    entries = await readMembers(stateDir, record);
    const active = entries.filter((entry) => ACTIVE_STATES.has(entry.status)).length;
    const done = options.any ? active < entries.length : active === 0;
    if (done) {
      break;
    }
    const elapsed = performance.now() - started;
    if (elapsed >= timeoutMs) {
      outputCommandResult(statusPayload(record, entries), renderStatus(record, entries), options.json);
      process.stderr.write(`Fleet ${record.id} still has ${active} members running after ${timeoutMs} ms.\n`);
      process.exitCode = WAIT_TIMEOUT_EXIT;
      return;
    }
    await sleep(Math.min(FLEET_WAIT_POLL_MS, timeoutMs - elapsed));
    if (performance.now() - lastReconcile >= RECONCILE_EVERY_MS) {
      lastReconcile = performance.now();
      await reconcileStore(stateDir, { deadline: performance.now() + RETRY_BUDGETS.command.totalMs, budget: "command" }).catch(() => null);
    }
  }
  outputCommandResult(statusPayload(record, entries), renderStatus(record, entries), options.json);
}

function parseResultJson(row) {
  if (!row?.result_json) {
    return null;
  }
  try {
    return JSON.parse(row.result_json);
  } catch {
    return null;
  }
}

// The section `fleet results` prints for one member.
function resultSection(entry) {
  const row = entry.view?.row ?? null;
  const header = `## ${entry.label} (${entry.provider}, ${entry.view?.id ?? "none"}, ${entry.status})`;
  let body;
  if (NOT_STARTED.has(entry.status) && entry.startError) {
    body = `(start failed: ${entry.startError})`;
  } else if (row && (row.result_text || row.result_json)) {
    const parts = [];
    if (row.result_text) {
      parts.push(row.result_text.replace(/\n+$/, ""));
    }
    const json = parseResultJson(row);
    if (json !== null) {
      const text = JSON.stringify(json, null, 2);
      const fence = fenceFor(text);
      parts.push(`${fence}json\n${text}\n${fence}`);
    }
    body = parts.join("\n\n");
  } else {
    body = `(no result yet: ${entry.status})`;
  }
  return `${header}\n\n${body}\n`;
}

/**
 * `fleet results <run-id> [--out <dir>]`: each member's result under its label; with --out, one
 * `<label>.md` file per member in that folder as well.
 */
async function fleetResults(options, positionals) {
  const stateDir = commandStateDir(options);
  const record = loadRecord(stateDir, runArgument(positionals, "results"));
  const entries = await readMembers(stateDir, record);
  const sections = entries.map(resultSection);
  if (options.out) {
    const outDir = path.resolve(resolveCommandCwd(options), String(options.out));
    fs.mkdirSync(outDir, { recursive: true });
    entries.forEach((entry, index) => fs.writeFileSync(path.join(outDir, `${entry.label}.md`), sections[index], "utf8"));
  }
  const payload = {
    run: record,
    members: entries.map((entry) => ({
      label: entry.label,
      provider: entry.provider,
      jobId: entry.view?.id ?? null,
      status: entry.status,
      resultText: entry.view?.row.result_text ?? null,
      resultJson: parseResultJson(entry.view?.row),
      startError: entry.startError
    }))
  };
  outputCommandResult(payload, sections.join("\n"), options.json);
}

// The outcome of one member of `fleet cancel`, from its state before and after.
function cancelOutcome(before, after, exit) {
  if (NOT_STARTED.has(before.status)) {
    return { outcome: "not-started", detail: before.startError ?? before.status };
  }
  if (FINAL_STATES.has(before.status)) {
    return { outcome: "already-ended", detail: before.status };
  }
  const state = after?.status ?? before.status;
  if (state === "cancelled") {
    return { outcome: "cancelled", detail: after?.view?.providerExitUnobserved ? "its provider's exit was not observed; the provider may still run" : null };
  }
  if (FINAL_STATES.has(state)) {
    return { outcome: "already-ended", detail: state };
  }
  if (exit && exit.code !== 0) {
    const line = String(exit.stderr ?? "").split(/\r?\n/).map((text) => text.trim()).find(Boolean);
    return { outcome: "error", detail: line ?? (exit.error ? exit.error.message : `cancel exited ${exit.code}`) };
  }
  return { outcome: "stopping", detail: state };
}

/**
 * `fleet cancel <run-id>`: runs the neutral `cancel` on the chain tip of every member that has not
 * ended, in parallel, then reads each tip once more.
 */
async function fleetCancel(options, positionals) {
  const stateDir = commandStateDir(options);
  const record = loadRecord(stateDir, runArgument(positionals, "cancel"));
  const cwd = resolveCommandCwd(options);
  const before = await readMembers(stateDir, record);
  const exits = await Promise.all(
    before.map((entry) =>
      entry.view && !FINAL_STATES.has(entry.status) ? runCompanion(AGENT_COMPANION, ["cancel", entry.view.id, "--cwd", cwd], { cwd, env: process.env }) : null
    )
  );
  const after = await readMembers(stateDir, record);
  const members = before.map((entry, index) => ({
    label: entry.label,
    jobId: entry.view?.id ?? null,
    ...cancelOutcome(entry, after[index], exits[index])
  }));
  const lines = members.map((member) => `- ${member.label}${member.jobId ? ` (${member.jobId})` : ""}: ${member.outcome}${member.detail ? ` (${member.detail})` : ""}`);
  outputCommandResult({ run: record.id, members }, `Fleet ${record.id}: cancel\n${lines.join("\n")}\n`, options.json);
  if (members.some((member) => member.outcome === "error")) {
    process.exitCode = 1;
  }
}

const ACTIONS = {
  start: startFleet,
  status: fleetStatus,
  wait: fleetWait,
  results: fleetResults,
  cancel: fleetCancel
};

/** `fleet <action> ...`; a single argument string is split as the command file passes it. */
export async function handleFleet(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "out"],
    booleanOptions: ["json", "any", "allow-outside-files"]
  });
  const [action, ...rest] = positionals;
  const handler = action && Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
  if (!handler) {
    throw new Error(`Unknown fleet action${action ? ` "${action}"` : ""}. Usage: node scripts/agent-companion.mjs ${usage}`);
  }
  await handler(options, rest);
}

export const run = handleFleet;
