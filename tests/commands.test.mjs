import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { parseCommandInput } from "../plugins/agent/scripts/lib/companion-cli.mjs";
import { parseReviewArguments } from "../plugins/agent/scripts/lib/review-target.mjs";
import { KNOWN_REASONING_EFFORTS } from "../plugins/agent/scripts/providers/codex/model-catalog.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "agent");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review commands stay review-only and ask once before running", () => {
  for (const [name, provider] of [["codex-review", "Codex"], ["agy-review", "Antigravity"]]) {
    const source = read("commands/" + name + ".md");
    assert.match(source, /AskUserQuestion/, name);
    assert.match(source, /Do not fix issues/i, name);
    assert.match(source, /review-only/i, name);
    assert.match(source, new RegExp("return " + provider + "'s output verbatim to the user", "i"), name);
    assert.match(source, /```bash/, name);
    assert.match(source, /review '\$ARGUMENTS'/, name);
    assert.match(source, /\[--scope auto\|working-tree\|branch\]/, name);
    assert.match(source, /\[--target auto\|changes\|project\] \[--path <path>\]\.\.\. \[--stance peer\|critical\]/, name);
    assert.match(source, /git status --short --untracked-files=all/, name);
    assert.match(source, /git diff --shortstat/, name);
    assert.match(source, /Treat untracked files or directories as reviewable work/i, name);
    assert.match(source, /Recommend waiting only when the review is clearly tiny, roughly 1-2 files total/i, name);
    assert.match(source, /In every other case, including unclear size, recommend background/i, name);
    assert.match(source, /The companion script parses `--wait` and `--background`/i, name);
    assert.match(source, /When in doubt, run the review/i, name);
    assert.match(source, /\(Recommended\)/, name);
    assert.match(source, /--target project/, name);
    assert.match(source, /--stance peer/, name);
    assert.match(source, /--stance critical/, name);
  }
});

test("delegate command absorbs continue semantics", () => {
  const delegate = read("commands/codex-delegate.md");
  const agent = read("agents/codex-delegate.md");
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");

  assert.match(delegate, /The final user-visible response must be Codex's output verbatim/i);
  assert.match(delegate, /allowed-tools:\s*Bash\(node:\*\),\s*AskUserQuestion,\s*Agent/);
  // The delegate command must name the Agent-tool transport explicitly and run
  // inline. Under `context: fork` a general-purpose subagent has no `Agent`
  // tool, falls back to `Skill(agent:codex-delegate)`, and re-enters this command.
  assert.match(delegate, /subagent_type: "agent:codex-delegate"/);
  assert.match(delegate, /do not call `Skill\(agent:codex-delegate\)`/i);
  assert.doesNotMatch(delegate, /^context:\s*fork\b/m);
  assert.match(delegate, /--background\|--wait/);
  assert.match(delegate, /--resume\|--fresh/);
  assert.match(delegate, /--model <id\|family\|default\|configured>/);
  assert.match(delegate, /--effort <none\|minimal\|low\|medium\|high\|xhigh\|max\|ultra>/);
  assert.match(delegate, /task-resume-candidate --json/);
  assert.match(delegate, /AskUserQuestion/);
  assert.match(delegate, /Continue current Codex thread/);
  assert.match(delegate, /Start a new Codex thread/);
  assert.match(delegate, /run the `agent:codex-delegate` subagent in the background in every case/i);
  assert.match(delegate, /present its output and stop/i);
  assert.match(delegate, /Do not forward them to `task`/i);
  assert.match(delegate, /`--model` and `--effort` are runtime-selection flags/i);
  assert.match(delegate, /Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort/i);
  assert.match(delegate, /Pass `--model` only when the user names a model, a family word, `default` or `configured`/i);
  assert.match(delegate, /If the request includes `--resume`, do not ask whether to continue/i);
  assert.match(delegate, /If the request includes `--fresh`, do not ask whether to continue/i);
  assert.match(delegate, /If the user chooses continue, add `--resume`/i);
  assert.match(delegate, /If the user chooses a new thread, add `--fresh`/i);
  assert.match(delegate, /thin forwarder only/i);
  assert.match(delegate, /Return the Codex companion stdout verbatim to the user/i);
  assert.match(delegate, /Do not paraphrase, summarize, rewrite, or add commentary before or after it/i);
  assert.match(delegate, /returns that command's stdout as-is\. It never returns only a job ID/i);
  assert.match(delegate, /`\/agent:send <job-id> <message>`/);
  assert.match(delegate, /Leave `--resume` and `--fresh` in the forwarded request/i);
  assert.match(agent, /--resume/);
  assert.match(agent, /--fresh/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /task --background --json \[routing flags\] -- "<task text>"/);
  assert.match(agent, /result <jobId> --wait --timeout-ms 540000/);
  assert.match(agent, /whose `timeout` parameter is `600000`/);
  assert.match(agent, /If that call exits with code 75, the job is still running\. Run the same command again/i);
  assert.match(agent, /Never return only a job ID/i);
  assert.match(agent, /Do not inspect the repository, read files, grep, summarize output, or do any follow-up work of your own/i);
  assert.match(agent, /Do not call `review`, `status`, `send`, or `cancel`/i);
  assert.match(agent, /Leave `--effort` unset unless the user explicitly requests a specific reasoning effort/i);
  assert.match(agent, /Leave model unset by default/i);
  assert.match(agent, /Pass `--model` only when the user names a model, a family word, `default` or `configured`/i);
  assert.match(agent, /Pass the `--model` value through as the user gave it/i);
  assert.match(agent, /Return the stdout of the last `result` call exactly as-is/i);
  assert.match(agent, /If a call fails with any exit code other than 75, return its output, including stderr, exactly as-is and stop/i);
  assert.match(agent, /codex-prompting/);
  assert.match(agent, /only to tighten the user's request into a better Codex prompt/i);
  assert.match(agent, /Do not use that skill to inspect the repository, reason through the problem yourself, draft a solution, or do any independent work/i);
  assert.match(runtimeSkill, /only job is to start one `task` in the background, wait for it with `result --wait`, and return the final `result` stdout unchanged/i);
  assert.match(runtimeSkill, /Do not call `setup`, `review`, `status`, `send`, or `cancel`/i);
  assert.match(runtimeSkill, /use the `codex-prompting` skill to rewrite the user's request into a tighter Codex prompt/i);
  assert.match(runtimeSkill, /That prompt drafting is the only Claude-side work allowed/i);
  assert.match(runtimeSkill, /Leave `--effort` unset unless the user explicitly requests a specific effort/i);
  assert.match(runtimeSkill, /Leave model unset by default/i);
  assert.match(runtimeSkill, /Pass `--model` only when the user names a model, a family word, `default` or `configured`/i);
  assert.match(runtimeSkill, /If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only/i);
  assert.match(runtimeSkill, /Strip it before calling `task`/i);
  assert.match(runtimeSkill, /`--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`/i);
  assert.match(runtimeSkill, /Do not inspect the repository, read files, grep, poll status, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(runtimeSkill, /If a call fails with any exit code other than 75, return its output/i);
});

test("transfer, result, and cancel commands are exposed as deterministic runtime entrypoints", () => {
  const transfer = read("commands/codex-transfer.md");
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const resultHandling = read("skills/codex-result-handling/SKILL.md");

  assert.match(transfer, /disable-model-invocation:\s*true/);
  assert.match(transfer, /codex-companion\.mjs" transfer "\$ARGUMENTS"/);
  assert.match(transfer, /codex resume <session-id>/);
  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /agent-companion\.mjs" result "\$ARGUMENTS"/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /agent-companion\.mjs" cancel "\$ARGUMENTS"/);
  assert.match(resultHandling, /do not turn a failed or incomplete Codex run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if Codex was never successfully invoked, do not generate a substitute answer at all/i);
});

test("internal docs use task terminology for delegated runs", () => {
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");
  const promptingSkill = read("skills/codex-prompting/SKILL.md");
  const promptRecipes = read("skills/codex-prompting/references/codex-prompt-recipes.md");

  assert.match(runtimeSkill, /codex-companion\.mjs" task --background --json \[flags\] -- "<task text>"/);
  assert.match(runtimeSkill, /agent-companion\.mjs" result <jobId> --wait --timeout-ms 540000/);
  assert.match(runtimeSkill, /Use `task` for every delegation request/i);
  assert.match(runtimeSkill, /task --resume-last/i);
  assert.match(promptingSkill, /Use `task` when the task is diagnosis/i);
  assert.match(promptRecipes, /Codex task prompts/i);
  assert.match(promptRecipes, /Use these as starting templates for Codex task prompts/i);
  assert.match(promptRecipes, /## Diagnosis/);
  assert.match(promptRecipes, /## Narrow Fix/);
  // Diagnosis stays read-only, follow-ups target the intended job, the delegate never routes to
  // review, and a delegated run returns a blocking question instead of asking.
  const promptBlocks = read("skills/codex-prompting/references/prompt-blocks.md");
  assert.match(promptRecipes, /run the diagnosis, review and research recipes read-only, without `--write`, unless the user asks for edits/);
  assert.doesNotMatch(promptRecipes, /diagnosis and fix-oriented recipes in write mode/);
  assert.match(promptingSkill, /Diagnosis, review and research runs stay read-only/);
  assert.match(promptingSkill, /`task --resume-thread <thread-id>`/);
  assert.match(promptingSkill, /`\/agent:send <job-id> <message>`/);
  assert.match(promptingSkill, /Use `task --resume-last` only when the newest Codex task of this repository is the one the user means/);
  assert.match(promptingSkill, /The delegate runs `task` only and never calls `review`/);
  assert.doesNotMatch(promptingSkill, /Use the built-in `review` command/);
  for (const [label, text] of [["SKILL.md", promptingSkill], ["recipes", promptRecipes], ["blocks", promptBlocks]]) {
    assert.match(text, /return(s)? the blocking question as (its|your) final (result|answer)/, label);
    assert.doesNotMatch(text, /stop (and|to) ask/i, label);
  }
});

test("hooks keep session-end cleanup and stop gating enabled", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.mjs/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
});

test("setup command can offer Codex install and still points users to codex login", () => {
  const setup = read("commands/codex-setup.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(setup, /argument-hint:\s*'\[--model <id\|family\|default\|configured>\] \[--effort <[a-z|]+>\] \[--write-sandbox workspace-write\|danger-full-access\] \[--enable-review-gate\|--disable-review-gate\]'/);
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /npm install -g @openai\/codex/);
  assert.match(setup, /codex-companion\.mjs" setup "--json \$ARGUMENTS"/);
  assert.match(readme, /!codex login/);
  assert.match(readme, /offer to install Codex for you/i);
  assert.match(readme, /\/agent:codex-setup --enable-review-gate/);
  assert.match(readme, /\/agent:codex-setup --disable-review-gate/);
});

const COMMAND_NAMES = [
  "agy-delegate",
  "agy-review",
  "agy-setup",
  "cancel",
  "codex-delegate",
  "codex-fleet",
  "codex-review",
  "codex-setup",
  "codex-transfer",
  "codex-usage",
  "result",
  "send",
  "status"
];
const AGENT_NAMES = ["agy-delegate", "codex-delegate"];
const SKILL_NAMES = ["codex-cli-runtime", "codex-prompting", "codex-result-handling"];
const REMOVED_WORDS = /rescue|adversarial|fanout|gpt-5-4/;

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(child) : [child];
  });
}

// Reads one flat YAML scalar. A single-quoted scalar doubles its quotes, a double-quoted one uses
// JSON-compatible escapes, and a plain scalar must read as its own text: one that YAML would read
// as a collection, an alias, a tag, a block scalar or a comment, or that holds `: ` or ` #`, throws.
function parseYamlScalar(text) {
  if (text.startsWith("'")) {
    const quoted = text.match(/^'((?:[^']|'')*)'$/);
    if (!quoted) {
      throw new Error(`unterminated single-quoted scalar: ${text}`);
    }
    return quoted[1].replace(/''/g, "'");
  }
  if (text.startsWith("\"")) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(text)) {
      throw new Error(`unterminated double-quoted scalar: ${text}`);
    }
    return JSON.parse(text);
  }
  if (/^[[\]{}&*!|>%@`#,]|^[-?:](\s|$)/.test(text) || /:(\s|$)|\s#/.test(text)) {
    throw new Error(`plain scalar that YAML does not read as text: ${text}`);
  }
  if (text === "true" || text === "false") {
    return text === "true";
  }
  return text === "null" || text === "~" ? null : text;
}

// Parses the frontmatter of a definition file as flat YAML: `key: scalar` lines, and `key:`
// followed by `  - scalar` items. Returns `{ values, raw }`, where `raw` holds each key's scalar
// as written. A file without a closed block, a repeated key, or any other line throws.
function parseFrontmatter(file) {
  const label = path.relative(ROOT, file);
  const match = fs.readFileSync(file, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) {
    throw new Error(`${label} has no closed frontmatter block`);
  }
  const values = {};
  const raw = {};
  let listKey = null;
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const item = line.match(/^\s+-\s+(.*)$/);
      if (item) {
        if (!listKey) {
          throw new Error(`list item without a key: ${line}`);
        }
        values[listKey].push(parseYamlScalar(item[1]));
        continue;
      }
      const pair = line.match(/^([A-Za-z][\w-]*):(?:[ \t]+(.*?))?[ \t]*$/);
      if (!pair) {
        throw new Error(`not a key/value line: ${line}`);
      }
      const [, key, text = ""] = pair;
      if (Object.hasOwn(values, key)) {
        throw new Error(`repeated key ${key}`);
      }
      raw[key] = text;
      listKey = text === "" ? key : null;
      values[key] = text === "" ? [] : parseYamlScalar(text);
    } catch (error) {
      throw new Error(`${label}: ${error.message}`);
    }
  }
  return { values, raw };
}

function readFrontmatter(file) {
  return parseFrontmatter(file).values;
}

test("the definition folders hold exactly the renamed files", () => {
  const folder = (name) => fs.readdirSync(path.join(PLUGIN_ROOT, name)).sort();
  assert.deepEqual(folder("commands"), COMMAND_NAMES.map((name) => `${name}.md`));
  assert.deepEqual(folder("agents"), AGENT_NAMES.map((name) => `${name}.md`));
  assert.deepEqual(folder("skills"), SKILL_NAMES);
  for (const name of AGENT_NAMES) {
    assert.equal(readFrontmatter(path.join(PLUGIN_ROOT, "agents", `${name}.md`)).name, name);
  }
  for (const name of SKILL_NAMES) {
    assert.equal(readFrontmatter(path.join(PLUGIN_ROOT, "skills", name, "SKILL.md")).name, name);
  }
  const offenders = ["commands", "agents", "skills"]
    .flatMap((name) => listFiles(path.join(PLUGIN_ROOT, name)))
    .filter((file) => {
      // Skill reference files have no frontmatter, so only their path is checked.
      const name = /^---\r?\n/.test(fs.readFileSync(file, "utf8")) ? readFrontmatter(file).name : null;
      return REMOVED_WORDS.test(path.relative(PLUGIN_ROOT, file)) || REMOVED_WORDS.test(name ?? "");
    });
  assert.deepEqual(offenders, []);
});

const SCAN_EXTENSIONS = new Set([".md", ".mjs", ".js", ".json"]);
const SCAN_SKIPPED_FOLDERS = new Set(["node_modules", ".generated"]);
const REMOVED_SUBCOMMANDS = "status|result|send|cancel|adversarial-review";
const OLD_IDENTIFIERS = /codex-rescue|agy-rescue|codex-adversarial-review|codex-fanout|gpt-5-4-prompting/;
// The removed-forward probe calls the removed subcommands on purpose; its test is the only exception.
const DELIBERATE_PROBE = { file: "tests/providers.test.mjs", title: "the removed codex-companion forwards fail as unknown subcommands" };

function scanFiles() {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SCAN_SKIPPED_FOLDERS.has(entry.name)) {
          walk(child);
        }
      } else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(child);
      }
    }
  };
  walk(PLUGIN_ROOT);
  walk(path.join(ROOT, "tests"));
  files.push(path.join(ROOT, "README.md"));
  return files
    .map((file) => ({ file, relative: path.relative(ROOT, file).split(path.sep).join("/") }))
    .filter(({ relative }) => relative !== "tests/commands.test.mjs");
}

// The text of a file with the deliberate probe's test removed.
function scanText({ file, relative }) {
  let text = fs.readFileSync(file, "utf8");
  if (relative === DELIBERATE_PROBE.file) {
    const start = text.indexOf(`test("${DELIBERATE_PROBE.title}"`);
    if (start !== -1) {
      const end = text.indexOf("\ntest(", start + 1);
      text = text.slice(0, start) + (end === -1 ? "" : text.slice(end));
    }
  }
  return text;
}

test("no executable call site names a removed subcommand or old identifier", () => {
  const direct = new RegExp(String.raw`codex-companion\.mjs"?\s+(${REMOVED_SUBCOMMANDS})\b`);
  const offenders = [];
  for (const entry of scanFiles()) {
    const text = scanText(entry);
    // Constants of this file that point at the Codex entry script.
    const constants = [...text.matchAll(/\bconst\s+(\w+)\s*=[^;]{0,200}?codex-companion\.mjs/g)].map((match) => match[1]);
    const array = constants.length
      ? new RegExp(String.raw`\[\s*(?:${constants.join("|")})\s*,\s*"(?:${REMOVED_SUBCOMMANDS})"`)
      : null;
    text.split(/\r?\n/).forEach((line, index) => {
      if (direct.test(line) || array?.test(line)) {
        offenders.push(`${entry.relative}:${index + 1}: ${line.trim().slice(0, 120)}`);
      }
    });
    // The changelog records the old names.
    if (entry.relative !== "plugins/agent/CHANGELOG.md" && OLD_IDENTIFIERS.test(text)) {
      offenders.push(`${entry.relative}: names a removed command, agent or skill`);
    }
  }
  assert.deepEqual(offenders, []);
});

const FRONTMATTER_ORDER = ["description", "argument-hint", "disable-model-invocation", "allowed-tools"];
const PRINT_ONLY = "Bash(node:*)";
const REVIEW_TOOLS = "Bash(node:*), Bash(git:*), AskUserQuestion";
// Each command: the allowed-tools line, whether the model may invoke it, and the call its body makes.
const COMMAND_TABLE = {
  "codex-delegate": {
    tools: "Bash(node:*), AskUserQuestion, Agent",
    modelInvocation: true,
    calls: [/subagent_type: "agent:codex-delegate"/, /codex-companion\.mjs" task-resume-candidate --json/]
  },
  "agy-delegate": {
    tools: "Agent",
    modelInvocation: true,
    calls: [/subagent_type: "agent:agy-delegate"/]
  },
  "codex-review": { tools: REVIEW_TOOLS, modelInvocation: true, calls: [/codex-companion\.mjs" review '\$ARGUMENTS'/] },
  "agy-review": { tools: REVIEW_TOOLS, modelInvocation: true, calls: [/agy-companion\.mjs" review '\$ARGUMENTS'/] },
  "codex-fleet": { tools: PRINT_ONLY, modelInvocation: false, calls: [/codex-companion\.mjs" task '--manifest \$ARGUMENTS'/] },
  "codex-transfer": { tools: PRINT_ONLY, modelInvocation: false, calls: [/codex-companion\.mjs" transfer "\$ARGUMENTS"/] },
  "codex-usage": { tools: PRINT_ONLY, modelInvocation: false, calls: [/codex-companion\.mjs" usage "\$ARGUMENTS"/] },
  "codex-setup": {
    tools: "Bash(node:*), Bash(npm:*), AskUserQuestion",
    modelInvocation: true,
    calls: [/codex-companion\.mjs" setup "--json \$ARGUMENTS"/]
  },
  "agy-setup": { tools: PRINT_ONLY, modelInvocation: false, calls: [/agy-companion\.mjs" setup "\$ARGUMENTS"/] },
  send: { tools: PRINT_ONLY, modelInvocation: false, calls: [/agent-companion\.mjs" send "\$ARGUMENTS"/] },
  cancel: { tools: PRINT_ONLY, modelInvocation: false, calls: [/agent-companion\.mjs" cancel "\$ARGUMENTS"/] },
  result: { tools: PRINT_ONLY, modelInvocation: false, calls: [/agent-companion\.mjs" result "\$ARGUMENTS"/] },
  status: { tools: PRINT_ONLY, modelInvocation: false, calls: [/agent-companion\.mjs" status "\$ARGUMENTS"/] }
};
// What in a command body shows that the body uses a tool.
const TOOL_EVIDENCE = {
  "Bash(node:*)": /\bnode "/,
  "Bash(git:*)": /\bgit (status|diff)\b/,
  "Bash(npm:*)": /\bnpm install\b/,
  AskUserQuestion: /AskUserQuestion/,
  Agent: /`Agent` tool/
};

function frontmatterKeys(file) {
  return Object.keys(parseFrontmatter(file).values);
}

function commandFile(name) {
  return path.join(PLUGIN_ROOT, "commands", `${name}.md`);
}

test("command frontmatter keys are in one order and argument-hint is single-quoted", () => {
  for (const name of COMMAND_NAMES) {
    const keys = frontmatterKeys(commandFile(name));
    assert.deepEqual(keys, FRONTMATTER_ORDER.filter((key) => keys.includes(key)), `${name} key order`);
    for (const key of ["description", "argument-hint", "allowed-tools"]) {
      assert.ok(keys.includes(key), `${name} lacks ${key}`);
    }
    assert.match(parseFrontmatter(commandFile(name)).raw["argument-hint"], /^'.*'$/, `${name} argument-hint`);
  }
});

test("allowed-tools lists only tools the body uses", () => {
  for (const name of COMMAND_NAMES) {
    const listed = readFrontmatter(commandFile(name))["allowed-tools"];
    assert.equal(listed, COMMAND_TABLE[name].tools, `${name} allowed-tools`);
    const body = fs.readFileSync(commandFile(name), "utf8").replace(/^---[\s\S]*?\r?\n---/, "");
    for (const tool of listed.split(", ")) {
      assert.ok(TOOL_EVIDENCE[tool]?.test(body), `${name} lists ${tool} but its body does not use it`);
    }
  }
});

test("model invocation is allowed only for the delegate commands, the review commands and codex-setup", () => {
  for (const name of COMMAND_NAMES) {
    const value = readFrontmatter(commandFile(name))["disable-model-invocation"];
    assert.equal(value, COMMAND_TABLE[name].modelInvocation ? undefined : true, name);
  }
});

test("every command body calls the script and subcommand of the names table", () => {
  assert.deepEqual(Object.keys(COMMAND_TABLE).sort(), COMMAND_NAMES);
  for (const name of COMMAND_NAMES) {
    const source = fs.readFileSync(commandFile(name), "utf8");
    for (const call of COMMAND_TABLE[name].calls) {
      assert.match(source, call, name);
    }
  }
});

test("command descriptions name their providers", () => {
  for (const name of COMMAND_NAMES) {
    const description = readFrontmatter(commandFile(name)).description;
    const expected = ["send", "cancel", "result", "status"].includes(name)
      ? /\bCodex or Antigravity job\b/
      : name.startsWith("agy-")
        ? /Antigravity/
        : /Codex/;
    assert.match(description, expected, name);
  }
});

test("Codex commands show the full effort hint", () => {
  const hint = `--effort <${KNOWN_REASONING_EFFORTS.join("|")}>`;
  for (const name of ["codex-delegate", "codex-review", "codex-fleet", "codex-setup"]) {
    assert.ok(readFrontmatter(commandFile(name))["argument-hint"].includes(hint), `${name} lacks ${hint}`);
  }
});

// Splits a shell command line into words as a POSIX shell quotes them: single quotes keep every
// character, double quotes keep every character except that a backslash escapes $ ` " \ and a
// newline, and an unquoted backslash escapes the next character. A $ or ` outside single quotes
// would expand, so it throws, except in the plugin root variable.
function shellWords(line) {
  const words = [];
  let current = null;
  let index = 0;
  const append = (text) => {
    current = (current ?? "") + text;
  };
  const checkExpansion = (rest) => {
    if ((rest[0] === "$" && !rest.startsWith("${CLAUDE_PLUGIN_ROOT}")) || rest[0] === "`") {
      throw new Error(`the shell would expand ${rest.slice(0, 12)}`);
    }
  };
  while (index < line.length) {
    const character = line[index];
    if (/\s/.test(character)) {
      if (current !== null) {
        words.push(current);
        current = null;
      }
      index += 1;
    } else if (character === "'") {
      const end = line.indexOf("'", index + 1);
      if (end === -1) {
        throw new Error("unterminated single quote");
      }
      append(line.slice(index + 1, end));
      index = end + 1;
    } else if (character === "\"") {
      append("");
      index += 1;
      while (line[index] !== "\"") {
        if (index >= line.length) {
          throw new Error("unterminated double quote");
        }
        checkExpansion(line.slice(index));
        if (line[index] === "\\" && "$`\"\\\n".includes(line[index + 1])) {
          index += 1;
        }
        append(line[index]);
        index += 1;
      }
      index += 1;
    } else if (character === "\\") {
      append(line[index + 1] ?? "");
      index += 2;
    } else {
      checkExpansion(line.slice(index));
      append(character);
      index += 1;
    }
  }
  if (current !== null) {
    words.push(current);
  }
  return words;
}

// The argv a command definition hands to its companion subcommand when the user typed `userArgs`.
// Claude Code puts the raw argument text in place of $ARGUMENTS. `form` is the quoted argument of
// the subcommand, for example `"$ARGUMENTS"`; it defaults to the one in the definition's call.
function companionArgv(name, subcommand, userArgs, form = null) {
  const source = fs.readFileSync(commandFile(name), "utf8");
  const head = `.mjs" ${subcommand} `;
  const call = source.split(/\r?\n/).find((line) => line.includes(head));
  assert.ok(call, `${name} has no ${subcommand} call`);
  const command = call.replace(/^!`/, "").replace(/`$/, "");
  const at = command.indexOf(head) + head.length;
  const quoted = `${command.slice(0, at)}${form ?? command.slice(at)}`;
  const words = shellWords(quoted.replaceAll("$ARGUMENTS", userArgs));
  return words.slice(words.indexOf(subcommand) + 1);
}

// The quoted argument of the example a review command gives for adding the chosen execution flag.
function chosenFlagForm(name, flag) {
  const source = fs.readFileSync(commandFile(name), "utf8");
  const example = source.match(new RegExp("`review ((['\"])[^`]*\\$ARGUMENTS[^`]*\\2)`"));
  assert.ok(example, `${name} gives no example of the added flag`);
  assert.ok(example[1].includes("--background"), `${name} example does not add --background`);
  return example[1].replace("--background", flag);
}

test("review commands pass the plugin's background flag and name /agent:result", () => {
  for (const name of ["codex-review", "agy-review"]) {
    const source = fs.readFileSync(commandFile(name), "utf8");
    assert.doesNotMatch(source, /run_in_background/, name);
    assert.doesNotMatch(source, /```typescript/, name);
    assert.match(source, /`\/agent:status <job-id>`/, name);
    assert.match(source, /`\/agent:result <job-id>`/, name);
    for (const flag of ["--background", "--wait"]) {
      // Words after `--` are review instructions, so the added flag must still reach the parser as a flag.
      const parsed = parseReviewArguments(companionArgv(name, "review", "--stance critical -- inspect retries", chosenFlagForm(name, flag)));
      assert.equal(parsed.background, flag === "--background", `${name} ${flag}`);
      assert.equal(parsed.options.wait, flag === "--wait" ? true : undefined, `${name} ${flag}`);
      assert.equal(parsed.instructions, "inspect retries", `${name} ${flag}`);
      assert.equal(parsed.stance, "critical", `${name} ${flag}`);
    }
  }
});

test("review and fleet commands keep a quoted path with a space as one value", () => {
  const userArgs = "--path \"docs/Release Notes.md\" --path src -- check retries";
  for (const name of ["codex-review", "agy-review"]) {
    for (const form of [null, chosenFlagForm(name, "--background")]) {
      const parsed = parseReviewArguments(companionArgv(name, "review", userArgs, form));
      assert.deepEqual(parsed.paths, ["docs/Release Notes.md", "src"], `${name} ${form ?? "as given"}`);
      assert.equal(parsed.instructions, "check retries", `${name} ${form ?? "as given"}`);
    }
    // A single quote in the arguments, written as the command tells the model to write it.
    const escape = String.raw`\'\''`;
    assert.ok(fs.readFileSync(commandFile(name), "utf8").includes(`write each one as \`${escape}\``), `${name} escape rule`);
    const quoted = parseReviewArguments(companionArgv(name, "review", "--path \"a b.md\" check the user's $HOME".replaceAll("'", escape)));
    assert.deepEqual(quoted.paths, ["a b.md"], name);
    assert.equal(quoted.instructions, "check the user's $HOME", name);
  }
  const fleet = parseCommandInput(companionArgv("codex-fleet", "task", "\"C:\\fleet runs\\jobs.json\" --write"), {
    valueOptions: ["manifest", "model", "effort"],
    booleanOptions: ["write", "worktree"]
  });
  assert.equal(fleet.options.manifest, "C:\\fleet runs\\jobs.json");
  assert.equal(fleet.options.write, true);
  assert.deepEqual(fleet.positionals, []);
});

// A model id or family name written into a file; the program grep pattern, matched without regard to case.
const MODEL_ID = /gpt-[0-9]|spark|terra|luna|astra|gemini-[0-9]|claude-(opus|sonnet)/i;

test("no model id appears in definitions or README", () => {
  // Every file of the plugin except the scripts and the generated types, and the README.
  const files = fs
    .readdirSync(PLUGIN_ROOT, { withFileTypes: true })
    .filter((entry) => !["scripts", ".generated", "node_modules"].includes(entry.name))
    .flatMap((entry) => (entry.isDirectory() ? listFiles(path.join(PLUGIN_ROOT, entry.name)) : [path.join(PLUGIN_ROOT, entry.name)]))
    .concat(path.join(ROOT, "README.md"));
  const offenders = files
    .filter((file) => MODEL_ID.test(fs.readFileSync(file, "utf8")) || MODEL_ID.test(path.relative(ROOT, file)))
    .map((file) => path.relative(ROOT, file));
  assert.deepEqual(offenders, []);
});

const README = () => fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

test("the README documents every command", () => {
  const readme = README();
  for (const name of COMMAND_NAMES) {
    assert.ok(readme.includes(`### \`/agent:${name}\`\n`), `the README has no section for /agent:${name}`);
  }
  const headings = [...readme.matchAll(/^### `\/agent:([\w-]+)`$/gm)].map((match) => match[1]).sort();
  assert.deepEqual(headings, COMMAND_NAMES);
});

test("the README describes the delegate commands, review targets and the model policy", () => {
  const readme = README();
  assert.match(readme, /`agent:codex-delegate` subagent/i);
  assert.match(readme, /`agent:agy-delegate` subagent/i);
  assert.match(readme, /--model <id> --effort medium/);
  assert.match(readme, /`--model` takes a catalog id, a family word, `default` or `configured`/i);
  assert.match(readme, /continue a previous Codex task/i);
  assert.match(readme, /--target auto\|changes\|project|`--target` picks what is reviewed/);
  assert.match(readme, /`--path <path>`/);
  assert.match(readme, /--stance critical/);
  assert.match(readme, /`peer` is the default/);
  assert.match(readme, /`--background` starts the review as a tracked background job/);
  assert.match(readme, /\/agent:codex-review --stance critical --base main challenge whether this was the right caching and retry design/);
  assert.match(readme, /^## Models and effort$/m);
  assert.match(readme, /the visible model that `model\/list` marks as its default/);
  assert.match(readme, /a model set in your Codex configuration applies/);
  assert.match(readme, /Codex chose the model; a model set in the Codex configuration applies\./);
  assert.match(readme, /`--model default` clears the stored setting/);
  assert.match(readme, /Model: <name> \(from the Antigravity settings\)/);
  assert.match(readme, /^## Configuration$/m);
  assert.match(readme, /"models": \{/);
  assert.match(readme, /`--from-last-review` sends the output of the newest finished review job that has output, from `\/agent:codex-review` or `\/agent:agy-review`/);
  assert.match(readme, /newest visible model of the Sol family in `codex debug models`/);
  assert.match(readme, /The plugin still sends an effort given with `--effort` or stored in the delegation setting/);
  assert.match(readme, /a model you name is sent as given, with one line that says it was not checked/);
  assert.match(readme, /An Antigravity job uses `--model` from the command, then, on a continued conversation, the model choice of the job it continues, then the delegation setting/);
  assert.match(readme, /the output of a delegated job shows, after Antigravity's result and before any resume information, `Model: <name>/);
  // The model behavior of earlier versions is gone from the text.
  assert.doesNotMatch(readme, /preferring runs from the current Claude session/);
  assert.doesNotMatch(readme, /the output starts with `Model:/);
  assert.doesNotMatch(readme, /`config\.toml` model and reasoning effort apply/);
  assert.doesNotMatch(readme, /Codex chooses its own defaults/i);
  assert.doesNotMatch(readme, /always use `[^`]*` on `high`/i);
});

test("every command, agent and skill has parseable frontmatter with a description", () => {
  const files = [
    ...COMMAND_NAMES.map((name) => path.join("commands", `${name}.md`)),
    ...AGENT_NAMES.map((name) => path.join("agents", `${name}.md`)),
    ...SKILL_NAMES.map((name) => path.join("skills", name, "SKILL.md"))
  ];
  for (const file of files) {
    const description = parseFrontmatter(path.join(PLUGIN_ROOT, file)).values.description;
    assert.ok(typeof description === "string" && description.trim(), `${file} has no description`);
  }
});

test("the frontmatter parser reads flat YAML and rejects what YAML would read differently", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "commands-frontmatter-"));
  const parse = (body) => {
    const file = path.join(scratch, "definition.md");
    fs.writeFileSync(file, `---\n${body}\n---\nbody\n`);
    return parseFrontmatter(file);
  };
  try {
    assert.deepEqual(parse("description: Plain text, with commas\nargument-hint: '[--x] [it''s]'\nflag: true\nskills:\n  - one\n  - two").values, {
      description: "Plain text, with commas",
      "argument-hint": "[--x] [it's]",
      flag: true,
      skills: ["one", "two"]
    });
    assert.equal(parse("argument-hint: '[--x]'").raw["argument-hint"], "'[--x]'");
    for (const body of ["argument-hint: [--x]", "description: a: b", "description: text # note", "description: 'open", "a: 1\na: 2", "just text"]) {
      assert.throws(() => parse(body), /definition\.md: /, body);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("the delegate agents keep model sonnet", () => {
  for (const name of AGENT_NAMES) {
    const front = readFrontmatter(path.join(PLUGIN_ROOT, "agents", `${name}.md`));
    assert.equal(front.model, "sonnet", name);
    assert.equal(front.tools, "Bash", name);
    assert.match(fs.readFileSync(path.join(PLUGIN_ROOT, "agents", `${name}.md`), "utf8"), /agent-companion\.mjs" result <jobId> --wait --timeout-ms 540000/, name);
  }
  const skills = fs.readFileSync(path.join(PLUGIN_ROOT, "agents", "codex-delegate.md"), "utf8").match(/^skills:\r?\n((?:  - .*\r?\n?)+)/m)?.[1];
  assert.deepEqual(skills?.match(/- (\S+)/g)?.map((entry) => entry.slice(2)), SKILL_NAMES);
});
