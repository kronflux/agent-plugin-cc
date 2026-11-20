// Renders SESSION-MAP.md from a transfer manifest, for an agent that continues the session in
// another client and has never seen the source client's files. Client names come from the
// manifest's display names.

const KIND_ORDER = [
  "transcript",
  "subagent-transcript",
  "subagent-meta",
  "tool-result",
  "file-history",
  "session-env",
  "prompt-history",
  "paste",
  "shell-snapshot",
  "task",
  "team",
  "notes"
];

const KIND_DESCRIPTIONS = {
  transcript: "the main record of the session's conversation and tool activity",
  "subagent-transcript": "the conversation records of sub-agents the session started",
  "subagent-meta": "the name, type and description of each sub-agent",
  "tool-result": "tool output that was stored outside the transcript",
  "file-history": "copies of files from before the session edited them",
  "session-env": "environment scripts written for the session",
  "prompt-history": "the profile's prompt history, which holds this session's prompts",
  paste: "text pasted into the session's prompts",
  "shell-snapshot": "shell state captured while the session ran",
  task: "the session's task list state",
  team: "a team of agents the session led",
  notes: "session notes written by a hook"
};

function code(text) {
  const value = String(text ?? "");
  const longestRun = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longestRun + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

function known(value) {
  return value === null || value === undefined || value === "" ? "unknown" : String(value);
}

function plural(count, word, many = `${word}s`) {
  return `${count} ${count === 1 ? word : many}`;
}

function sum(values) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function whatThisIs(manifest) {
  const source = manifest.source.agentDisplayName ?? "source";
  const target = manifest.target.agentDisplayName ?? "target";
  if (manifest.target.method === "prompt-only") {
    return [
      `This ${target} thread was started to continue a ${source} session. The thread holds none of that session's conversation. This file describes the session and says where its records are: the conversation, the tool activity, the files it touched, its sub-agents and its other files.`
    ];
  }
  return [
    `This thread was imported from a ${source} session into ${target}. The thread holds only the text the import kept from the conversation; the section "Fidelity and warnings" says what that is. This file says where everything else is: the tool activity, the files the session touched, its sub-agents and its other files.`
  ];
}

function howToContinue(manifest) {
  const { source } = manifest;
  const lines = [
    `- Project folder: ${source.cwd ? code(source.cwd) : "unknown"}`,
    `- Git branch at the end of the session: ${source.gitBranch ? code(source.gitBranch) : "unknown"}; commit: ${source.gitCommit ? code(source.gitCommit) : "unknown"}`,
    `- Model: ${known(source.model)}; effort: ${known(source.effort)}; permission mode: ${known(source.permissionMode)}`,
    `- Session ${code(known(source.sessionId))}${source.title ? `, titled ${code(source.title)}` : ""}, from ${known(source.startedAt)} to ${known(source.endedAt)}`
  ];
  if (source.lastRequest) {
    lines.push(
      `- Last user request, at line ${source.lastRequest.line} of the transcript (first 200 characters, secrets redacted):`,
      "",
      `  > ${source.lastRequest.text}`
    );
  } else {
    lines.push("- Last user request: none recorded.");
  }
  return lines;
}

function notInThread(manifest) {
  const { counts } = manifest;
  const toolEntries = Object.entries(counts.toolCalls ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const toolTotal = sum(toolEntries.map(([, count]) => count));
  const lines = [`- ${plural(toolTotal, "tool call")}${toolEntries.length > 0 ? ", by tool name:" : "."}`];
  for (const [name, count] of toolEntries) {
    lines.push(`  - ${name}: ${count}`);
  }
  lines.push(
    `- ${plural(counts.toolErrors, "tool call")} that returned an error`,
    `- ${plural(counts.thinkingBlocks, "thinking block")}`,
    `- ${plural(counts.attachments, "attachment")}`,
    `- ${plural(counts.images, "image")}`,
    `- ${plural(counts.compactions, "compaction")}`,
    `- ${plural(manifest.subagents.length, "sub-agent")}`,
    `- ${plural(manifest.source.unparseableLines ?? 0, "unparseable line")} in the transcript`
  );
  return lines;
}

function filesTouched(manifest) {
  if (manifest.filesTouched.length === 0) {
    return ["No file was changed by an edit or write tool."];
  }
  return manifest.filesTouched.map(
    (file) => `- ${code(file.path)}: ${plural(file.changes, "change")}; pre-edit copy: ${file.hasHistory ? "yes, in file history" : "no"}`
  );
}

function commandsRun(manifest) {
  if (manifest.commands.length === 0) {
    return ["No shell command was recorded."];
  }
  return [
    `The last ${plural(manifest.commands.length, "shell command")}, oldest first, each cut to 160 characters with secrets redacted:`,
    "",
    ...manifest.commands.map((command) => `- line ${command.line}: ${code(command.text)}`)
  ];
}

function subagentLines(manifest) {
  if (manifest.subagents.length === 0) {
    return ["The session started no sub-agent."];
  }
  return manifest.subagents.map(
    (agent) =>
      `- ${agent.name ? code(agent.name) : code(agent.id)}; type: ${known(agent.type)}; description: ${known(agent.description)}; status: ${known(agent.status)}; transcript: ${code(agent.transcriptPath)}`
  );
}

function openItems(manifest) {
  const lines = [];
  if (manifest.todoState) {
    const { line, completed, open } = manifest.todoState;
    lines.push(`The last to-do list, at line ${line} of the transcript: ${completed} completed, ${open} open.`, "");
    for (const item of manifest.openItems) {
      lines.push(`- open: ${item.text}`);
    }
  } else {
    lines.push("The session recorded no to-do list.");
  }
  const waiting = manifest.subagents.filter((agent) => agent.status !== "returned");
  lines.push("");
  if (waiting.length === 0) {
    lines.push("Every sub-agent had returned.");
  } else {
    lines.push("Sub-agents that had not returned:");
    for (const agent of waiting) {
      lines.push(`- ${agent.name ? code(agent.name) : code(agent.id)} (status: ${known(agent.status)})`);
    }
  }
  return lines;
}

function resourceLegend(manifest) {
  const lines = [];
  for (const kind of KIND_ORDER) {
    const entries = manifest.resources.filter((resource) => resource.kind === kind);
    if (entries.length === 0) {
      lines.push(`- **${kind}**: ${KIND_DESCRIPTIONS[kind]}. none for this session.`);
      continue;
    }
    const paths = entries.map((entry) => {
      const size = entry.bytes === null || entry.bytes === undefined ? "folder" : plural(entry.bytes, "byte");
      return `  - ${code(entry.path)} (${size}${entry.sha256 ? `, SHA-256 ${entry.sha256}` : ""})`;
    });
    lines.push(`- **${kind}**: ${KIND_DESCRIPTIONS[kind]}. ${entries[0].readHint}`, ...paths);
  }
  const unknownKinds = manifest.resources.filter((resource) => !KIND_ORDER.includes(resource.kind));
  for (const entry of unknownKinds) {
    lines.push(`- **${entry.kind}**: ${entry.readHint}`, `  - ${code(entry.path)}`);
  }
  if (manifest.source.profileNotes.length > 0) {
    lines.push("", "Profile folders that are not part of this session:", "");
    for (const note of manifest.source.profileNotes) {
      lines.push(`- **${note.name}**: ${note.note}.`);
    }
  }
  return lines;
}

function fidelityAndWarnings(manifest) {
  const { target, fidelity, source } = manifest;
  const lines = [
    `- Imported into the thread: ${fidelity.imported.length > 0 ? fidelity.imported.join("; ") : "nothing"}.`,
    `- Not imported: ${fidelity.dropped.length > 0 ? fidelity.dropped.join("; ") : "nothing"}.`
  ];
  if (target.staged) {
    lines.push(
      `- The transcript was copied once to a temporary folder, and that one copy was hashed, imported and described here; the copy ${target.stagedCopyRemoved ? "was removed afterwards" : "could not be removed"}.`
    );
  }
  if (target.pointerInjected) {
    lines.push("- A message naming this file was added to the end of the thread.");
  } else if (target.method === "prompt-only") {
    lines.push("- The thread's first turn names this file.");
  } else {
    lines.push("- No message naming this file was added to the thread; the resume command names it.");
  }
  lines.push(
    `- The transcript is described as of ${known(source.snapshotAt)}, when the copy was taken, and the other resources as of ${known(manifest.resourcesObservedAt)}.`
  );
  if (fidelity.warnings.length === 0) {
    lines.push("- Warnings: none.");
  } else {
    lines.push("- Warnings:");
    for (const warning of fidelity.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  return lines;
}

/** Renders the session map for `manifest` as Markdown with nine level-2 sections. */
export function renderSessionMap(manifest) {
  const sections = [
    ["What this is", whatThisIs(manifest)],
    ["How to continue", howToContinue(manifest)],
    ["What the thread does not contain", notInThread(manifest)],
    ["Files touched", filesTouched(manifest)],
    ["Commands run", commandsRun(manifest)],
    ["Sub-agents", subagentLines(manifest)],
    ["Open items", openItems(manifest)],
    ["Resource legend", resourceLegend(manifest)],
    ["Fidelity and warnings", fidelityAndWarnings(manifest)]
  ];
  const parts = ["# Session map", ""];
  for (const [heading, lines] of sections) {
    parts.push(`## ${heading}`, "", ...lines, "");
  }
  return parts.join("\n");
}
