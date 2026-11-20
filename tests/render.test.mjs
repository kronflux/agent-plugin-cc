import test from "node:test";
import assert from "node:assert/strict";

import {
  fenceFor,
  renderJobStatusReport,
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult
} from "../plugins/agent/scripts/lib/render.mjs";
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

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Codex Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Codex Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Codex Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Codex session ID: thr_123/);
  assert.match(output, /Resume in Codex: codex resume thr_123/);
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

test("status and result print no resume command for an ephemeral thread", () => {
  const job = { id: "task-eph", status: "completed", jobClass: "task", threadId: "thr_eph", ephemeralThread: true };
  const stored = { ...job, rendered: "Done.\n" };

  const status = renderJobStatusReport(job);
  assert.match(status, /Codex session ID: thr_eph/);
  assert.doesNotMatch(status, /codex resume/);
  assert.doesNotMatch(renderStoredJobResult(job, stored), /codex resume/);
  assert.doesNotMatch(renderStoredJobResult(job, { threadId: "thr_eph" }), /codex resume/);

  const durable = { ...job, ephemeralThread: undefined };
  assert.match(renderJobStatusReport(durable), /Resume in Codex: codex resume thr_eph/);
  assert.match(renderStoredJobResult(durable, { ...durable, rendered: "Done.\n" }), /Resume in Codex: codex resume thr_eph/);
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
