import test from "node:test";
import { renderTaskResult } from "../plugins/agent/scripts/lib/render.mjs";
import assert from "node:assert/strict";

import {
  fenceFor,
  renderNativeReviewResult,
  renderReviewResult,
  renderStatusJson
} from "../plugins/agent/scripts/lib/render.mjs";
import { listJobViews } from "../plugins/agent/scripts/lib/state.mjs";
import { openStore } from "../plugins/agent/scripts/lib/store.mjs";
import { makeStoreDir, seedStore } from "./store-fixtures.mjs";
import { renderSetupReport, renderUsageReport } from "../plugins/agent/scripts/providers/codex/render.mjs";

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Codex returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const NOW_SECONDS = NOW / 1000;

test("usage lists each limit window with percent and reset time", () => {
  const codex = {
    limitId: "codex",
    primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: NOW_SECONDS + 2 * 3600 + 5 * 60 },
    secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: NOW_SECONDS + 3 * 86400 + 4 * 3600 },
    credits: { hasCredits: true, unlimited: false, balance: "12.50" },
    planType: "plus"
  };
  const output = renderUsageReport(
    {
      rateLimits: codex,
      rateLimitsByLimitId: {
        codex,
        spark: { limitId: "spark", limitName: "Spark", primary: { usedPercent: 100, windowDurationMins: 45, resetsAt: null }, rateLimitReachedType: "rate_limit_reached" }
      }
    },
    { now: NOW }
  );

  assert.match(output, /^Plan: plus$/m);
  assert.match(output, /^Credits: 12\.50$/m);
  assert.match(output, /^codex:\n- 5-hour window: 42% used, resets 2026-10-02T14:05:00Z \(in 2 h 5 min\)\n- 7-day window: 7% used, resets 2026-10-05T16:00:00Z \(in 3 d 4 h\)$/m);
  assert.match(output, /^Spark:\n- 45-minute window: 100% used\n- Limit reached: rate_limit_reached$/m);
  assert.equal(output.match(/^codex:$/gm).length, 1);
});

test("usage shows the single snapshot when Codex sends no per-limit view", () => {
  const output = renderUsageReport(
    { rateLimits: { primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: NOW_SECONDS - 10 }, credits: { hasCredits: false, unlimited: false } } },
    { now: NOW }
  );
  assert.match(output, /^Plan: unknown$/m);
  assert.match(output, /^Credits: none$/m);
  assert.match(output, /^Codex:\n- 5-hour window: 3% used, resets .*\(now\)$/m);
});

test("setup shows the app server user agent when known", () => {
  const report = {
    ready: true,
    node: { detail: "v22" },
    npm: { detail: "10" },
    codex: { detail: "codex-cli 0.160.0" },
    auth: { detail: "logged in" },
    appServer: "codex_cli_rs/0.160.0 (Windows 10.0.26200; x86_64)",
    sessionRuntime: { label: "direct startup" },
    reviewGateEnabled: false,
    delegation: { model: "m-default", effort: "low", modelSource: "catalog-default", effortSource: "catalog-default" },
    actionsTaken: [],
    nextSteps: []
  };
  assert.match(renderSetupReport(report), /^- app server: codex_cli_rs\/0\.160\.0 \(Windows/m);
  assert.doesNotMatch(renderSetupReport({ ...report, appServer: null }), /app server/);
});

test("the Codex setup report names the write sandbox and its source", () => {
  const report = {
    ready: true,
    node: { detail: "v22" },
    npm: { detail: "10" },
    codex: { detail: "codex-cli 0.160.0" },
    auth: { detail: "logged in" },
    appServer: null,
    sessionRuntime: { label: "direct startup" },
    reviewGateEnabled: false,
    writeSandbox: "danger-full-access",
    sources: { model: "provider-default", effort: "provider-default", writeSandbox: "user" },
    delegation: { model: "m-default", effort: "low", modelSource: "catalog-default", effortSource: "catalog-default" },
    actionsTaken: [],
    nextSteps: []
  };
  assert.match(renderSetupReport(report), /^- write sandbox: danger-full-access \(user setting\)$/m);
  const defaulted = { ...report, writeSandbox: "workspace-write", sources: { ...report.sources, writeSandbox: "provider-default" } };
  assert.match(renderSetupReport(defaulted), /^- write sandbox: workspace-write \(provider-default\)$/m);
});

const REVIEW_META = { reviewLabel: "Review", targetLabel: "working tree diff" };

test("severity labels sort regardless of case", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "needs-attention",
        summary: "Two issues.",
        findings: [
          { severity: "Medium", title: "Medium thing", body: "b", file: "a.js" },
          { severity: "CRITICAL", title: "Critical thing", body: "b", file: "a.js" },
          { severity: "High", title: "High thing", body: "b", file: "a.js" }
        ],
        next_steps: []
      },
      rawOutput: "{}",
      parseError: null
    },
    REVIEW_META
  );

  const order = [...output.matchAll(/^- \[(\w+)\] (\w+) thing/gm)].map((match) => `${match[1]} ${match[2]}`);
  assert.deepEqual(order, ["critical Critical", "high High", "medium Medium"]);
});

test("raw output with a code fence stays inside its block", () => {
  const rawOutput = "before\n```\nINJECTED\n````\nafter";
  const output = renderReviewResult({ parsed: null, parseError: "Unexpected token", rawOutput }, REVIEW_META);

  assert.ok(output.includes(`\`\`\`\`\`text\n${rawOutput}\n\`\`\`\`\``), output);
  const native = renderNativeReviewResult({ status: 1, stdout: "", stderr: rawOutput }, REVIEW_META);
  assert.ok(native.includes(`\`\`\`\`\`text\n${rawOutput}\n\`\`\`\`\``), native);
  const plain = renderReviewResult({ parsed: null, parseError: "x", rawOutput: "no fences" }, REVIEW_META);
  assert.ok(plain.includes("```text\nno fences\n```"), plain);
});

test("usage shows no empty Codex block beside real buckets", () => {
  const output = renderUsageReport(
    {
      rateLimits: { planType: "pro", credits: { hasCredits: false, unlimited: false } },
      rateLimitsByLimitId: {
        codex: { limitId: "codex", primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null } }
      }
    },
    { now: NOW }
  );

  assert.match(output, /^codex:\n- 5-hour window: 10% used$/m);
  assert.doesNotMatch(output, /No usage window reported/);
  assert.doesNotMatch(output, /^Codex:$/m);
});

test("a window without a percent prints usage unknown, never undefined%", () => {
  const output = renderUsageReport(
    { rateLimits: { limitId: "codex", primary: { windowDurationMins: 300, resetsAt: null } } },
    { now: NOW }
  );

  assert.match(output, /^- 5-hour window: usage unknown$/m);
  assert.doesNotMatch(output, /undefined%/);
});

test("fenceFor handles text with very many backtick runs", () => {
  assert.equal(fenceFor("` x ".repeat(200000)), "```");
  assert.equal(fenceFor(`${"` x ".repeat(200000)}`.concat("`````")), "``````");
});

test("a finding without a file renders without a location", () => {
  const parsed = {
    verdict: "needs-attention",
    summary: "One concern.",
    target: "project",
    findings: [
      {
        severity: "medium",
        title: "No usage instructions",
        body: "Nothing explains how to run the project.",
        file: null,
        line_start: null,
        line_end: null,
        confidence: 0.6,
        recommendation: "Add a README."
      },
      {
        severity: "low",
        title: "Trailing spaces",
        body: "Line 3 ends in spaces.",
        file: "app.js",
        line_start: 3,
        line_end: 3,
        confidence: 0.9,
        recommendation: ""
      }
    ],
    next_steps: []
  };
  const output = renderReviewResult({ parsed, rawOutput: JSON.stringify(parsed), parseError: null }, { reviewLabel: "Review", targetLabel: "project /tmp/site" });
  assert.match(output, /^- \[medium\] No usage instructions$/m);
  assert.match(output, /^- \[low\] Trailing spaces \(app\.js:3\)$/m);
  assert.doesNotMatch(output, /unknown/);
  assert.match(output, /^# Codex Review \(project\)$/m);
});

test("a stored finding without target renders as a changes review", () => {
  const parsed = {
    verdict: "needs-attention",
    summary: "One issue.",
    findings: [{ severity: "high", title: "Guard", body: "Missing guard.", file: "src/app.js", line_start: 4, line_end: 6, confidence: 0.8, recommendation: "" }],
    next_steps: []
  };
  const output = renderReviewResult({ parsed, rawOutput: JSON.stringify(parsed), parseError: null }, { reviewLabel: "Review", targetLabel: "working tree diff" });
  assert.match(output, /^# Codex Review \(changes\)$/m);
  assert.match(output, /^- \[high\] Guard \(src\/app\.js:4-6\)$/m);
  const fromJob = renderReviewResult({ parsed, rawOutput: "", parseError: null }, { reviewLabel: "Review", targetLabel: "project /tmp/site", targetKind: "project" });
  assert.match(fromJob, /^# Codex Review \(project\)$/m);
});

test("the review heading names the target the job resolved, not the one the result claims", () => {
  const output = renderReviewResult(
    {
      parsed: { verdict: "approve", summary: "Fine.", target: "changes", findings: [], next_steps: [] },
      rawOutput: "{}",
      parseError: null
    },
    { reviewLabel: "Review", targetLabel: "project /work", targetKind: "project", providerLabel: "Codex" }
  );
  assert.match(output, /^# Codex Review \(project\)$/m);
  assert.doesNotMatch(output, /\(changes\)/);
});

// ---------------------------------------------------------------------------------------------
// status --json on the job store

const STATUS_JSON_FIELDS = [
  "id",
  "label",
  "runId",
  "provider",
  "model",
  "status",
  "chainId",
  "continues",
  "threadId",
  "resumable",
  "resumeMethod",
  "stopFailed",
  "stoppingCause",
  "providerExitUnobserved",
  "pendingMessages",
  "unreadEvents",
  "question",
  "resultTruncated",
  "structuredResultTooLarge",
  "createdAt",
  "updatedAt"
];

const T0 = Date.UTC(2026, 10, 18, 9, 0, 0);

function seededJob(id, fields = {}) {
  return {
    id,
    chain_id: fields.chain_id ?? id,
    provider: "codex",
    kind: "task",
    title: `job ${id}`,
    prompt: "do it",
    request_json: "{}",
    cwd: ".",
    created_at: T0,
    updated_at: T0 + 1000,
    session_id: "session-1",
    ...fields
  };
}

async function viewsOf(t, spec) {
  const stateDir = makeStoreDir(t);
  await seedStore(stateDir, spec);
  const store = openStore(stateDir);
  try {
    return listJobViews(store, { all: true });
  } finally {
    store.close();
  }
}

test("status --json carries the contract fields", async (t) => {
  const views = await viewsOf(t, {
    chains: [{ id: "task-a", tip_job_id: "task-b", live_label: "fix", created_at: T0, activity_at: T0 }],
    jobs: [
      seededJob("task-a", {
        label: "fix",
        run_id: "run-1",
        model: "m-1",
        thread_id: "th-1",
        resume_method: "thread",
        submit_intent_at: T0,
        end_state: "waiting",
        end_at: T0 + 500,
        question: "which branch?",
        result_text: "partial",
        result_truncated: 1,
        result_json_too_large: 1,
        next_action: "continue",
        next_at: T0 + 600
      }),
      seededJob("task-b", { chain_id: "task-a", continues: "task-a", label: "fix", thread_id: "th-1", created_at: T0 + 700 })
    ],
    messages: [{ chain_id: "task-a", text: "hello", created_at: T0 + 800 }],
    events: [{ job_id: "task-a", kind: "waiting", text: "which branch?", created_at: T0 + 500 }]
  });

  const { jobs } = renderStatusJson(views);

  assert.equal(jobs.length, 2);
  for (const job of jobs) {
    assert.deepEqual(Object.keys(job), STATUS_JSON_FIELDS);
  }
  const [b, a] = jobs;
  assert.deepEqual(a, {
    id: "task-a",
    label: "fix",
    runId: "run-1",
    provider: "codex",
    model: "m-1",
    status: "waiting",
    chainId: "task-a",
    continues: null,
    threadId: "th-1",
    resumable: true,
    resumeMethod: "thread",
    stopFailed: false,
    stoppingCause: null,
    providerExitUnobserved: false,
    pendingMessages: 1,
    unreadEvents: 1,
    question: "which branch?",
    resultTruncated: true,
    structuredResultTooLarge: true,
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0 + 1000).toISOString()
  });
  assert.equal(b.status, "queued");
  assert.equal(b.continues, "task-a");
  assert.equal(b.chainId, "task-a");
  assert.equal(b.question, null);
});

test("stopFailed is true for a stopping job", async (t) => {
  const views = await viewsOf(t, {
    chains: [{ id: "task-s", tip_job_id: "task-s", created_at: T0, activity_at: T0 }],
    jobs: [
      seededJob("task-s", {
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

  const [job] = renderStatusJson(views).jobs;

  assert.equal(job.status, "stopping");
  assert.equal(job.stopFailed, true);
  assert.equal(job.stoppingCause, "unconfirmed-stop");
});

test("a task result shows its structured output", () => {
  const text = renderTaskResult(
    { rawOutput: "Here is the answer.", failureMessage: "", structuredOutput: { answer: "x", parts: [1, 2] } },
    { title: "Antigravity Task", jobId: "task-1", write: false, providerLabel: "Antigravity" }
  );
  assert.match(text, /^Here is the answer\.$/m);
  assert.ok(text.includes('Structured output:\n{\n  "answer": "x",\n  "parts": [\n    1,\n    2\n  ]\n}'), text);
  const tooLarge = renderTaskResult({ rawOutput: "done", structuredResultTooLarge: true }, { title: "Antigravity Task", providerLabel: "Antigravity" });
  assert.match(tooLarge, /structured-result-too-large/);
});

test("a failed task result shows its failure reason beside its output", () => {
  const reason = "agy returned no structured output for the output schema.";
  const prose = renderTaskResult(
    { rawOutput: "Here is my answer.", failureMessage: reason, structuredOutput: null },
    { title: "Antigravity Task", jobId: "task-1", write: false, providerLabel: "Antigravity" }
  );
  assert.match(prose, /^Here is my answer\.$/m);
  assert.ok(prose.includes(reason), prose);
  const structured = renderTaskResult({ rawOutput: "", failureMessage: reason, structuredOutput: { answer: "x" } }, { providerLabel: "Antigravity" });
  assert.ok(structured.includes("Structured output:"), structured);
  assert.ok(structured.includes(reason), structured);
});

function storedView(row, request) {
  return {
    id: "job-1",
    provider: "agy",
    state: row.end_state ?? "completed",
    isTip: true,
    successorId: null,
    providerExitUnobserved: false,
    request,
    row: { kind: "task", title: "A job", result_text: null, result_json: null, error: null, question: null, thread_id: null, ...row }
  };
}

test("a stored schema-bound review is rendered as a review, with its model line", async () => {
  const { renderStoreResult } = await import("../plugins/agent/scripts/lib/render.mjs");
  const review = {
    verdict: "needs-attention",
    summary: "One problem found.",
    findings: [{ severity: "high", title: "Unchecked input", body: "The value is used unchecked.", file: "a.js", line_start: 3, line_end: 3, confidence: 0.9, recommendation: "Check it." }],
    next_steps: ["Add the check."]
  };
  const view = storedView(
    { kind: "review", result_text: "prose the model also wrote", result_json: JSON.stringify(review) },
    { model: null, providerModel: "Fake Model (High)", review: { target: "changes", stance: "critical", native: false, targetLabel: "working tree changes" } }
  );
  const text = renderStoreResult(view);
  assert.match(text, /^# Antigravity Critical Review \(changes\)$/m);
  assert.match(text, /^Target: working tree changes$/m);
  assert.match(text, /^Verdict: needs-attention$/m);
  assert.match(text, /^- \[high\] Unchecked input/m);
  assert.doesNotMatch(text, /Structured output:/);
  assert.match(text, /^Model: Fake Model \(High\) \(from the Antigravity settings\)$/m);
});

test("a stored result names the model only when the request named none", async () => {
  const { renderStoreResult } = await import("../plugins/agent/scripts/lib/render.mjs");
  const chosen = renderStoreResult(storedView({ result_text: "done" }, { model: null, providerModel: null }));
  assert.match(chosen, /^Model: chosen by Antigravity$/m);
  const named = renderStoreResult(storedView({ result_text: "done" }, { model: "some-model", providerModel: null }));
  assert.doesNotMatch(named, /^Model:/m);
  const unrecorded = renderStoreResult(storedView({ result_text: "done" }, { model: null }));
  assert.doesNotMatch(unrecorded, /^Model:/m);
});

test("a stored review without a structured result says so and keeps a native review as prose", async () => {
  const { renderStoreResult } = await import("../plugins/agent/scripts/lib/render.mjs");
  const failed = renderStoreResult(
    storedView({ kind: "review", end_state: "failed", error: "Antigravity ended the turn without an answer." }, { model: "m", review: { target: "changes", stance: "neutral", native: false, targetLabel: "working tree changes" } })
  );
  assert.match(failed, /did not return valid structured JSON/);
  assert.match(failed, /Parse error: Antigravity ended the turn without an answer\./);
  const native = renderStoreResult(storedView({ kind: "review", result_text: "native review prose" }, { model: "m", review: { target: "changes", stance: "neutral", native: true } }));
  assert.equal(native.split("\n")[0], "native review prose");
});
test("a stored task result names the command that opens its thread, unless the thread is ephemeral or a review", async () => {
  const { renderStoreResult, renderStoreJobStatus } = await import("../plugins/agent/scripts/lib/render.mjs");
  const view = (row) => ({ ...storedView({ result_text: "done", thread_id: "thr_9", ...row }, { model: "m" }), provider: "codex", pendingMessages: 0, unreadEvents: 0, label: null });
  assert.match(renderStoreResult(view({})), /^Resume in Codex: codex resume thr_9$/m);
  assert.match(renderStoreJobStatus(view({})), /^Resume in Codex: codex resume thr_9$/m);
  assert.doesNotMatch(renderStoreResult(view({ ephemeral: 1 })), /codex resume/);
  assert.doesNotMatch(renderStoreResult(view({ kind: "review" })), /codex resume/);
  assert.doesNotMatch(renderStoreResult(view({ thread_id: null })), /codex resume/);
});