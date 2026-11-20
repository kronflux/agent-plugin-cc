// Reports for the Codex-only commands: /agent:codex-setup and /agent:codex-usage.

export function renderSetupReport(report) {
  const lines = [
    "# Codex Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- npm: ${report.npm.detail}`,
    `- codex: ${report.codex.detail}`,
    `- auth: ${report.auth.detail}`,
    ...(report.appServer ? [`- app server: ${report.appServer}`] : []),
    `- session runtime: ${report.sessionRuntime.label}`,
    `- review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`,
    ""
  ];

  if (report.actionsTaken.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }

  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function formatWindowLabel(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return "Usage window";
  }
  if (minutes % 1440 === 0) {
    return `${minutes / 1440}-day window`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}-hour window`;
  }
  return `${minutes}-minute window`;
}

function formatTimeUntil(seconds) {
  if (seconds <= 0) {
    return "now";
  }
  const minutes = Math.ceil(seconds / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) {
    return `in ${days} d ${hours} h`;
  }
  return hours > 0 ? `in ${hours} h ${rest} min` : `in ${rest} min`;
}

function formatUsageWindow(window, nowMs) {
  const usage = Number.isFinite(window.usedPercent) ? `${window.usedPercent}% used` : "usage unknown";
  const parts = [`${formatWindowLabel(window.windowDurationMins)}: ${usage}`];
  if (Number.isFinite(window.resetsAt)) {
    const resetsAt = new Date(window.resetsAt * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    parts.push(`resets ${resetsAt} (${formatTimeUntil(window.resetsAt - nowMs / 1000)})`);
  }
  return `- ${parts.join(", ")}`;
}

function formatCredits(credits) {
  if (!credits) {
    return null;
  }
  if (credits.unlimited) {
    return "unlimited";
  }
  if (!credits.hasCredits) {
    return "none";
  }
  return credits.balance ?? "available";
}

/**
 * Renders the `account/rateLimits/read` response. Each metered limit is listed once; the
 * top-level `rateLimits` snapshot mirrors one of them. The snapshot gets its own block only
 * when no bucket has its limit id and it names a limit or carries a window, or when there are
 * no buckets at all.
 */
export function renderUsageReport(response, options = {}) {
  const nowMs = options.now ?? Date.now();
  const main = response?.rateLimits ?? {};
  const byId = response?.rateLimitsByLimitId && typeof response.rateLimitsByLimitId === "object" ? response.rateLimitsByLimitId : {};
  const buckets = Object.values(byId).filter(Boolean);
  const mainHasContent = Boolean(main.limitId || main.primary || main.secondary);
  const mainDuplicated = buckets.some((bucket) => bucket.limitId && bucket.limitId === main.limitId);
  if (!mainDuplicated && (mainHasContent || buckets.length === 0)) {
    buckets.unshift(main);
  }

  const lines = ["# Codex Usage", ""];
  lines.push(`Plan: ${main.planType ?? "unknown"}`);
  const credits = formatCredits(main.credits);
  if (credits) {
    lines.push(`Credits: ${credits}`);
  }
  const resetCredits = response?.rateLimitResetCredits?.availableCount;
  if (Number.isFinite(resetCredits) && resetCredits > 0) {
    lines.push(`Limit reset credits available: ${resetCredits}`);
  }

  for (const bucket of buckets) {
    const windows = [bucket.primary, bucket.secondary].filter(Boolean);
    lines.push("", `${bucket.limitName ?? bucket.limitId ?? "Codex"}:`);
    if (windows.length === 0) {
      lines.push("- No usage window reported.");
    }
    for (const window of windows) {
      lines.push(formatUsageWindow(window, nowMs));
    }
    if (bucket.rateLimitReachedType) {
      lines.push(`- Limit reached: ${bucket.rateLimitReachedType}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
