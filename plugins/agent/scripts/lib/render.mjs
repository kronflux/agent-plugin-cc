import path from "node:path";
import { fileURLToPath } from "node:url";

import { getProvider } from "./providers.mjs";
import { NODE_LAUNCH_FLAGS } from "./store.mjs";

// The neutral companion, whose `worktree remove` a worktree note names.
const AGENT_COMPANION = fileURLToPath(new URL("../agent-companion.mjs", import.meta.url));

// Results name the provider that produced them; callers pass its label.
function labelFor(meta) {
  return meta?.providerLabel ?? getProvider().label;
}

function severityRank(severity) {
  switch (String(severity ?? "").toLowerCase()) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

// The location of a finding, " (file:lines)", or nothing for a finding without a file.
function formatLocation(finding) {
  return finding.file ? ` (${finding.file}${formatLineRange(finding)})` : "";
}

function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

function validateReviewResultShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  if (typeof data.verdict !== "string" || !data.verdict.trim()) {
    return "Missing string `verdict`.";
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return "Missing string `summary`.";
  }
  if (!Array.isArray(data.findings)) {
    return "Missing array `findings`.";
  }
  if (!Array.isArray(data.next_steps)) {
    return "Missing array `next_steps`.";
  }
  return null;
}

function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  const lineStart = Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd =
    Number.isInteger(source.line_end) && source.line_end > 0 && (!lineStart || source.line_end >= lineStart)
      ? source.line_end
      : lineStart;

  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim().toLowerCase() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : null,
    line_start: lineStart,
    line_end: lineEnd,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : ""
  };
}

const REVIEW_TARGET_KINDS = new Set(["changes", "project"]);

// The kind of target a review covered: the one the job resolved and recorded, else the one the
// result names, else "changes" for a record that names none.
function reviewTargetKind(data, meta) {
  if (REVIEW_TARGET_KINDS.has(meta?.targetKind)) {
    return meta.targetKind;
  }
  return typeof data?.target === "string" && REVIEW_TARGET_KINDS.has(data.target) ? data.target : "changes";
}

function reviewHeading(meta, data = null) {
  return `# ${labelFor(meta)} ${meta.reviewLabel} (${reviewTargetKind(data, meta)})`;
}

function normalizeReviewResultData(data, meta) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    target: reviewTargetKind(data, meta),
    findings: data.findings.map((finding, index) => normalizeReviewFinding(finding, index)),
    next_steps: data.next_steps
      .filter((step) => typeof step === "string" && step.trim())
      .map((step) => step.trim())
  };
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

/** Returns a backtick fence one longer than the longest backtick run in `text`, at least three. */
export function fenceFor(text) {
  let longestRun = 0;
  for (const run of String(text ?? "").matchAll(/`+/g)) {
    longestRun = Math.max(longestRun, run[0].length);
  }
  return "`".repeat(Math.max(3, longestRun + 1));
}

function fencedText(text) {
  const fence = fenceFor(text);
  return [`${fence}text`, text, fence];
}

function appendReasoningSection(lines, reasoningSummary) {
  if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) {
    return;
  }

  lines.push("", "Reasoning:");
  for (const section of reasoningSummary) {
    lines.push(`- ${section}`);
  }
}

/**
 * Renders a structured review result. `meta.targetKind` is the target kind the job recorded,
 * which wins over the one the result names. A finding without a file is shown without a location.
 */
export function renderReviewResult(parsedResult, meta) {
  if (!parsedResult.parsed) {
    const lines = [
      reviewHeading(meta),
      "",
      `${labelFor(meta)} did not return valid structured JSON.`,
      "",
      `- Parse error: ${parsedResult.parseError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", ...fencedText(parsedResult.rawOutput));
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const validationError = validateReviewResultShape(parsedResult.parsed);
  if (validationError) {
    const lines = [
      reviewHeading(meta, parsedResult.parsed),
      "",
      `Target: ${meta.targetLabel}`,
      `${labelFor(meta)} returned JSON with an unexpected review shape.`,
      "",
      `- Validation error: ${validationError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", ...fencedText(parsedResult.rawOutput));
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = normalizeReviewResultData(parsedResult.parsed, meta);
  const findings = [...data.findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [
    reviewHeading(meta, data),
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    ""
  ];

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      lines.push(`- [${finding.severity}] ${finding.title}${formatLocation(finding)}`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderNativeReviewResult(result, meta) {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const lines = [
    `# ${labelFor(meta)} ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    ""
  ];

  if (stdout) {
    lines.push(stdout);
  } else if (result.status === 0) {
    lines.push(`${labelFor(meta)} review completed without any stdout output.`);
  } else {
    lines.push(`${labelFor(meta)} review failed.`);
  }

  if (stderr) {
    lines.push("", "stderr:", "", ...fencedText(stderr));
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}

function renderWorktreeNote(meta) {
  if (!meta?.worktreePath) {
    return "";
  }
  // The worktree folder is named after the first job of its chain, which `worktree remove` takes.
  const command = ["node", ...NODE_LAUNCH_FLAGS, `"${AGENT_COMPANION}"`, "worktree", "remove", path.basename(meta.worktreePath)].join(" ");
  return `\nWorktree: ${meta.worktreePath} (branch ${meta.worktreeBranch}). ${labelFor(meta)} worked there, not in your checkout. When its work is merged, remove it with: ${command}\n`;
}

export function renderTaskResult(parsedResult, meta) {
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : "";
  const structured = renderStructuredOutput(parsedResult?.structuredOutput, { tooLarge: parsedResult?.structuredResultTooLarge });
  const failure = String(parsedResult?.failureMessage ?? "").trim();
  if (rawOutput || structured) {
    const text = rawOutput && !rawOutput.endsWith("\n") ? `${rawOutput}\n` : rawOutput;
    return `${text}${text && structured ? "\n" : ""}${structured}${failure ? `\n${failure}\n` : ""}${renderWorktreeNote(meta)}`;
  }

  const message = failure || `${labelFor(meta)} did not return a final message.`;
  return `${message}\n${renderWorktreeNote(meta)}`;
}

// ---------------------------------------------------------------------------------------------
// Job store views (status, result, cancel)

function isoTime(milliseconds) {
  return milliseconds === null || milliseconds === undefined ? null : new Date(milliseconds).toISOString();
}

/** The display name of a job view's provider. */
export function providerLabelOf(view) {
  try {
    return getProvider(view.provider).label;
  } catch {
    return view.provider;
  }
}

/** One job of `status --json`: exactly the fields of the status contract, times as ISO strings. */
function statusJsonJob(view) {
  const row = view.row;
  return {
    id: view.id,
    label: view.label ?? null,
    runId: row.run_id ?? null,
    provider: view.provider,
    model: row.model ?? null,
    status: view.state,
    chainId: view.chainId,
    continues: row.continues ?? null,
    threadId: row.thread_id ?? null,
    resumable: Boolean(view.resumable),
    resumeMethod: row.resume_method ?? null,
    stopFailed: row.stopping_since !== null && row.stopping_since !== undefined,
    stoppingCause: row.stopping_cause ?? null,
    providerExitUnobserved: Boolean(view.providerExitUnobserved),
    pendingMessages: view.pendingMessages,
    unreadEvents: view.unreadEvents,
    question: row.question ?? null,
    resultTruncated: Boolean(row.result_truncated),
    structuredResultTooLarge: Boolean(row.result_json_too_large),
    createdAt: isoTime(row.created_at),
    updatedAt: isoTime(row.updated_at)
  };
}

/** The `status --json` payload for job views: `{ jobs: [...] }`. */
export function renderStatusJson(views) {
  return { jobs: views.map(statusJsonJob) };
}

/** One job of `status --json` for a job view. */
export function renderStatusJsonJob(view) {
  return statusJsonJob(view);
}

/** An object with the keys of one `status --json` job, each null, then `fields` over them. */
export function blankStatusJsonJob(fields = {}) {
  const keys = Object.keys(
    statusJsonJob({ id: null, label: null, provider: null, state: null, chainId: null, row: {}, pendingMessages: null, unreadEvents: null })
  );
  return { ...Object.fromEntries(keys.map((key) => [key, null])), ...fields };
}

function fleetCell(value) {
  return escapeMarkdownCell(value === null || value === undefined ? "" : String(value));
}

/**
 * The table of a fleet's members, one row each (label, provider, job id, status, model), then one
 * line per member that did not start.
 */
export function renderFleetTable(members) {
  const lines = ["| Label | Provider | Job | Status | Model |", "| --- | --- | --- | --- | --- |"];
  for (const member of members) {
    lines.push(`| ${[member.label, member.provider, member.id, member.status, member.model].map(fleetCell).join(" | ")} |`);
  }
  const notes = members.filter((member) => member.startError).map((member) => `- ${member.label}: ${member.status}: ${member.startError}`);
  if (notes.length > 0) {
    lines.push("", ...notes);
  }
  return `${lines.join("\n")}\n`;
}

/** The command that fits a job's state, as one sentence. */
export function renderStateHint(view) {
  const id = view.id;
  switch (view.state) {
    case "queued":
    case "running":
      return `Add to its turn with /agent:send ${id} <message>; stop it with /agent:cancel ${id}.`;
    case "stopping":
      return "It is stopping: its provider process has not been confirmed gone, so it cannot be continued yet.";
    case "waiting":
      return `It is waiting for an answer; reply with /agent:send ${id} <answer>.`;
    case "interrupted":
    case "completed":
      return `Read its output with /agent:result ${id}; continue it with /agent:resume ${id} [message] or /agent:send ${id} <message>.`;
    default:
      return `Read its output with /agent:result ${id}; it can be continued only with /agent:resume ${id} --force.`;
  }
}

function chainText(view) {
  const parts = [`position ${view.chainPosition}`];
  if (view.row.continues) {
    parts.push(`continues ${view.row.continues}`);
  }
  if (view.successorId) {
    parts.push(`continued by ${view.successorId}`);
  }
  return parts.join(", ");
}

// The notes a job carries beyond its state: question, error, stop state, unobserved exit.
function jobNotes(view) {
  const row = view.row;
  const notes = [];
  if (row.question) {
    notes.push(`Question: ${row.question}`);
  }
  if (row.error) {
    notes.push(`Error: ${row.error}`);
  }
  if (row.stopping_since !== null && row.stopping_since !== undefined) {
    notes.push(`Stop not confirmed (${row.stopping_cause ?? "unknown cause"}) since ${isoTime(row.stopping_since)}.`);
  }
  if (view.providerExitUnobserved) {
    notes.push("Provider exit not observed: the provider may still run, so continuing its thread needs --force.");
  }
  return notes;
}

// The lines that say how complete a stored result is.
function resultNotes(view, logFile) {
  const row = view.row;
  const notes = [];
  if (row.result_truncated) {
    notes.push(
      row.result_logged && logFile
        ? `The stored result was truncated; the full output is in the log: ${logFile}`
        : "The stored result was truncated; the full output was not kept."
    );
  }
  if (row.result_json_too_large) {
    notes.push("structured-result-too-large: the structured result was larger than 1 MiB and was not stored.");
  }
  return notes;
}

/** The status table of several jobs, with the notes of each chain tip that has any. */
export function renderStoreStatus(views, { all = false } = {}) {
  const lines = ["# Agent Status", ""];
  if (views.length === 0) {
    lines.push(all ? "No jobs recorded yet." : "No jobs recorded for this session yet. Pass --all to list every job of this repository.");
    return `${lines.join("\n")}\n`;
  }
  lines.push("| Job | Agent | Kind | State | Label | Chain | Pending messages | Unread events | Title |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const view of views) {
    const cells = [
      view.id,
      providerLabelOf(view),
      view.row.kind,
      view.state + (view.providerExitUnobserved ? " (provider exit not observed)" : ""),
      view.label ?? "",
      chainText(view),
      String(view.pendingMessages),
      String(view.unreadEvents),
      view.row.title
    ];
    lines.push(`| ${cells.map(escapeMarkdownCell).join(" | ")} |`);
  }
  const notes = views.flatMap((view) => (view.isTip ? [...jobNotes(view), renderStateHint(view)].map((note) => `- ${view.id}: ${note}`) : []));
  lines.push("", ...notes);
  lines.push("", "An explicit job id names that exact job; a label names the newest job of its chain.");
  return `${lines.join("\n")}\n`;
}

/** The status of one job, with its last log lines as progress. */
export function renderStoreJobStatus(view, { progress = [], logFile = null } = {}) {
  const row = view.row;
  const label = providerLabelOf(view);
  const lines = [
    "# Job Status",
    "",
    `Job: ${view.id}`,
    `Agent: ${label}`,
    `Kind: ${row.kind}`,
    `Title: ${row.title}`,
    `State: ${view.state}`,
    `Label: ${view.label ?? "none"}`,
    `Chain: ${chainText(view)}`,
    `Pending messages: ${view.pendingMessages}`,
    `Unread events: ${view.unreadEvents}`
  ];
  if (row.thread_id) {
    lines.push(`${label} session ID: ${row.thread_id}`, ...storedResumeLine(view));
  }
  lines.push(...jobNotes(view), ...resultNotes(view, logFile));
  if (logFile) {
    lines.push(`Log: ${logFile}`);
  }
  if (progress.length > 0) {
    lines.push("Progress:", ...progress.map((line) => `  ${line}`));
  }
  lines.push(
    view.isTip
      ? renderStateHint(view)
      : `This job is not the newest of its chain; read its output with /agent:result ${view.id}, and act on the chain through ${view.successorId ?? "its newest job"}.`
  );
  return `${lines.join("\n")}\n`;
}

// A stored review bound to the review schema, rendered as a review (heading, target, verdict,
// findings) from its structured result; null for any other job, and for a native review, whose
// result is prose. A review that failed keeps its failure after the rendering.
function storedReview(view) {
  const row = view.row;
  const review = view.request?.review;
  if (row.kind !== "review" || !review || review.native) {
    return null;
  }
  const label = providerLabelOf(view);
  let parsed = null;
  let parseError = row.error || `${label} returned no structured review.`;
  if (row.result_json) {
    try {
      parsed = JSON.parse(row.result_json);
    } catch (error) {
      parseError = `the stored review is not valid JSON (${error.message})`;
    }
  }
  const meta = {
    reviewLabel: review.stance === "critical" ? "Critical Review" : "Review",
    targetLabel: review.targetLabel ?? "the reviewed changes",
    targetKind: review.target,
    providerLabel: label
  };
  const rendered = renderReviewResult({ parsed, rawOutput: row.result_text ?? "", parseError }, meta);
  return view.state !== "completed" && row.error && parsed ? `${rendered}${row.error}\n` : rendered;
}

// The command that opens a stored job's thread in the provider's own tool. None for a thread the
// provider does not keep (ephemeral) and none for a review, whose thread is not meant to be worked
// in.
function storedResumeLine(view) {
  const row = view.row;
  if (!row.thread_id || row.ephemeral || row.kind === "review") {
    return [];
  }
  try {
    const provider = getProvider(view.provider);
    return [`Resume in ${provider.label}: ${provider.resumeCommand(row.thread_id)}`];
  } catch {
    return [];
  }
}

// The line that names the model of a job whose request named none: the provider's saved model when
// the job recorded one, otherwise that the provider chose it.
function storedModelNote(view) {
  const request = view.request;
  if (!request || request.model || !Object.hasOwn(request, "providerModel")) {
    return [];
  }
  const label = providerLabelOf(view);
  return [request.providerModel ? `Model: ${request.providerModel} (from the ${label} settings)` : `Model: chosen by ${label}`];
}

/**
 * The stored result of one job: its output, then notes on truncation, a dropped structured result,
 * a waiting question, an unobserved provider exit and its successor. `successor` is the view of
 * the job that continued this one, or null. A job with no end decision gets one line saying so.
 */
export function renderStoreResult(view, { successor = null, logFile = null } = {}) {
  const row = view.row;
  const label = providerLabelOf(view);
  if (["queued", "running", "stopping"].includes(view.state)) {
    return `Job ${view.id} (${label}) is ${view.state} and has no result yet. Wait for it with /agent:result ${view.id} --wait.\n`;
  }
  let body;
  const review = storedReview(view);
  if (review) {
    body = review;
  } else if (typeof row.result_text === "string" && row.result_text) {
    body = row.result_json ? `${row.result_text.replace(/\n*$/, "")}\n\n${renderStructuredOutput(JSON.parse(row.result_json))}` : row.result_text;
    // A failed job keeps its prose; the failure follows it.
    if (view.state === "failed" && row.error) {
      body = `${body.replace(/\n*$/, "")}\n\n${row.error}`;
    }
  } else if (row.result_json) {
    body = renderStructuredOutput(JSON.parse(row.result_json));
  } else {
    body = [`# ${row.title || "Job Result"}`, "", `Job: ${view.id}`, `State: ${view.state}`, "", row.error || "No output was stored for this job."].join("\n");
  }
  const notes = [...storedModelNote(view), ...resultNotes(view, logFile)];
  if (view.state === "waiting" && row.question) {
    notes.push(`${label} is waiting for an answer: ${row.question}`, `Reply with /agent:send ${view.id} <answer>.`);
  }
  if (view.providerExitUnobserved) {
    notes.push("The provider's exit was not observed; it may still run, so continuing its thread needs --force.");
  }
  if (row.thread_id) {
    notes.push(`${label} session ID: ${row.thread_id}`, ...storedResumeLine(view));
  }
  const successorId = successor?.id ?? view.successorId;
  if (successorId) {
    const state = successor ? ` (${successor.state})` : "";
    notes.push(`This job was continued by ${successorId}${state}; /agent:result ${successorId} shows the newer output.`);
  }
  const worktree = view.request?.worktree;
  const output = body.endsWith("\n") ? body : `${body}\n`;
  const noteText = notes.length > 0 ? `\n${notes.join("\n")}\n` : "";
  const worktreeMeta = worktree?.path ? { worktreePath: worktree.path, worktreeBranch: worktree.branch, providerLabel: label } : null;
  return `${output}${noteText}${renderWorktreeNote(worktreeMeta)}`;
}

/**
 * The structured output of a task as indented JSON under a "Structured output:" line, or the
 * structured-result-too-large note when the result was too large to store; empty when there is
 * neither.
 */
export function renderStructuredOutput(value, { tooLarge = false } = {}) {
  if (tooLarge) {
    return "structured-result-too-large: the structured result was larger than 1 MiB and was not stored.\n";
  }
  if (value === null || value === undefined) {
    return "";
  }
  return `Structured output:\n${JSON.stringify(value, null, 2)}\n`;
}
