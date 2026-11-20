import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeCommittedRepo, makeTempDir, run } from "./helpers.mjs";
import { redactSecrets } from "../plugins/agent/scripts/lib/redact.mjs";
import { openStore } from "../plugins/agent/scripts/lib/store.mjs";
import {
  createJob,
  ensureStateDir,
  recordEnd,
  resolveStateDir,
  setConfig
} from "../plugins/agent/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "agent", "scripts", "codex-companion.mjs");
const NEUTRAL = path.join(ROOT, "plugins", "agent", "scripts", "agent-companion.mjs");

function filesUnder(dir) {
  return fs.readdirSync(dir, { recursive: true }).map((name) => path.join(dir, String(name)));
}

test("redactSecrets replaces credential values and keeps surrounding text", () => {
  assert.equal(redactSecrets("use token=abc123def to log in"), "use token=[redacted] to log in");
  assert.equal(redactSecrets('password: "hunter two"'), 'password: "[redacted]"');
  assert.equal(redactSecrets("Authorization: Bearer abcdefgh12345678"), "Authorization: Bearer [redacted]");
  assert.equal(redactSecrets("key sk-proj-ABCDEFGHIJKLMNOPQRSTUV end"), "key [redacted] end");
  assert.equal(redactSecrets("ghp_0123456789abcdefghijABCDEFGHIJ"), "[redacted]");
  assert.equal(redactSecrets("AKIAABCDEFGHIJKLMNOP"), "[redacted]");
  assert.equal(redactSecrets("Fix the flaky login test"), "Fix the flaky login test");
});

const CREDENTIAL_PROBES = [
  { text: "AWS_SECRET_ACCESS_KEY=abcd1234efgh", name: "AWS_SECRET_ACCESS_KEY", value: "abcd1234efgh" },
  { text: "client_secret=xyz12345", name: "client_secret", value: "xyz12345" },
  { text: "DB_PASSWORD=hunter2", name: "DB_PASSWORD", value: "hunter2" },
  { text: '{"password":"hunter2"}', name: '"password"', value: "hunter2" },
  { text: '"token": "abc123456"', name: '"token"', value: "abc123456" }
];

test("prefixed and JSON-style credentials are redacted", () => {
  for (const probe of CREDENTIAL_PROBES) {
    const redacted = redactSecrets(probe.text);
    assert.equal(redacted.includes(probe.value), false, redacted);
    assert.equal(redacted.includes(probe.name), true, redacted);
    assert.equal(redacted.includes("[redacted]"), true, redacted);
  }
  assert.equal(redactSecrets('{"password":"hunter2"}'), '{"password":"[redacted]"}');
});

test("redaction leaves prose and commit ids alone", () => {
  for (const text of ["password policy", "d4d9068cb31bda1c166a4b3802b65a075a110c16", "token count: 3"]) {
    assert.equal(redactSecrets(text), text);
  }
});

test("a job's title, error and question are stored and shown in redacted form", (t) => {
  const repo = makeCommittedRepo(t);
  const probes = CREDENTIAL_PROBES.map((probe) => probe.text).join(" ");
  const stateDir = resolveStateDir(repo);
  const store = openStore(stateDir);
  const requester = { sessionId: "session-1", leaderPid: null, leaderStartToken: null };
  const job = (title) => createJob(store, { provider: "codex", kind: "task", title, prompt: "do the work", request: { cwd: repo }, cwd: repo, requester }, {}).jobId;
  const failed = job(`deploy ${probes}`);
  const waiting = job("ask something");
  recordEnd(store, failed, { state: "failed", by: "reconcile", error: `the deploy failed: ${probes}` });
  recordEnd(store, waiting, { state: "waiting", by: "reconcile", question: `Which of these is right? ${probes}` });
  const rows = store.read((db) => db.prepare("SELECT title, error, question FROM jobs").all());
  const events = store.read((db) => db.prepare("SELECT text FROM events").all());
  store.close();

  const outputs = [
    JSON.stringify(rows),
    JSON.stringify(events),
    run("node", [NEUTRAL, "status", "--all", "--json"], { cwd: repo, check: true }).stdout,
    run("node", [NEUTRAL, "status", "--all"], { cwd: repo, check: true }).stdout,
    run("node", [NEUTRAL, "status", failed], { cwd: repo, check: true }).stdout,
    run("node", [NEUTRAL, "result", failed], { cwd: repo }).stdout,
    run("node", [NEUTRAL, "result", waiting], { cwd: repo }).stdout
  ];
  for (const output of outputs) {
    for (const probe of CREDENTIAL_PROBES) {
      assert.equal(output.includes(probe.value), false, output);
    }
  }
  for (const probe of CREDENTIAL_PROBES) {
    assert.equal(outputs[0].includes(probe.name.replaceAll('"', "")), true, outputs[0]);
  }
  assert.equal(outputs[0].includes("[redacted]"), true);
});

test("the session-start note shows a prompt preview without the credentials in it", (t) => {
  const repo = makeCommittedRepo(t);
  const store = openStore(resolveStateDir(repo));
  const requester = { sessionId: "earlier-session", leaderPid: null, leaderStartToken: null };
  const prompt = "use api_key=s3cr3tvalue4242 and Bearer abcdefgh12345678 to fetch the report, then summarise it";
  const { jobId } = createJob(store, { provider: "codex", kind: "task", title: "fetch", prompt, request: { cwd: repo }, cwd: repo, requester }, {});
  recordEnd(store, jobId, { state: "interrupted", by: "reconcile", reason: "session-end" });
  store.close();

  const hook = path.join(ROOT, "plugins", "agent", "scripts", "session-lifecycle-hook.mjs");
  const started = run("node", [hook, "SessionStart"], {
    cwd: repo,
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "new-session", cwd: repo }),
    timeout: 30000
  });
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, new RegExp(jobId));
  assert.equal(started.stdout.includes("s3cr3tvalue4242"), false, started.stdout);
  assert.equal(started.stdout.includes("abcdefgh12345678"), false, started.stdout);
});

test("a background task leaves its prompt in no file beside the job store", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "secret-marker-7731 investigate"], {
    cwd: repo,
    env: buildEnv(binDir),
    timeout: 60000
  });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);
  const waited = run("node", [NEUTRAL, "status", jobId, "--wait", "--timeout-ms", "15000", "--json"], {
    cwd: repo,
    env: buildEnv(binDir),
    check: true,
    timeout: 60000
  });
  assert.equal(JSON.parse(waited.stdout).jobs[0].status, "completed");

  // The job store keeps the prompt, so a worker can replay it, and logs record the agent's own
  // output, which can quote it. No other file may hold it: no JSON record, request file or
  // heartbeat file.
  const others = filesUnder(resolveStateDir(repo)).filter((file) => fs.statSync(file).isFile() && !/[\\/]store[\\/]state\.db/.test(file) && !file.endsWith(".log"));
  for (const file of others) {
    assert.equal(fs.readFileSync(file, "utf8").includes("secret-marker-7731"), false, file);
  }
});

test("state directories are private to their owner",{ skip: process.platform === "win32" && "POSIX modes" }, () => {
  const workspace = makeTempDir();
  setConfig(workspace, "stopReviewGate", false);
  ensureStateDir(workspace);
  const stateDir = resolveStateDir(workspace);
  assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(stateDir, "jobs")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(stateDir, "config.json")).mode & 0o777, 0o600);
});

// Every redaction pattern, and redactSecrets as a whole, must take time linear in the text
// length. Each seed is the start of a positive example; repeating it with a joiner builds text
// where a pattern that can restart inside the span it just scanned takes quadratic time. The
// timing runs in a child process so a quadratic pattern ends at a hard timeout instead of
// stalling the suite.
const SPEED_SEEDS = [
  "token",
  "a.",
  "eyJ-",
  "-eyJ",
  "-eyJabcdefgh.abcdefgh.abcdefgh",
  "x-eyJabcdefgh.abcdefgh.abcdefgh",
  "://a",
  '"token',
  "Bearer ",
  "sk-",
  "A_",
  String.raw`\"a\":\"`
];
const SPEED_JOINERS = ["", " ", "-", ".", ":", "/", "=", '"'];

test("redaction time grows linearly for every pattern and seed", { timeout: 120000 }, async () => {
  const { spawn } = await import("node:child_process");
  const redactModule = new URL("../plugins/agent/scripts/lib/redact.mjs", import.meta.url).href;
  const source = [
    `const redact = await import(${JSON.stringify(redactModule)});`,
    `const seeds = ${JSON.stringify(SPEED_SEEDS)};`,
    `const joiners = ${JSON.stringify(SPEED_JOINERS)};`,
    "const patterns = redact.REDACTION_PATTERNS ?? [];",
    "const build = (unit, size) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);",
    "const time = (run) => { let best = Infinity; for (let i = 0; i < 3; i += 1) { const s = performance.now(); run(); best = Math.min(best, performance.now() - s); } return best; };",
    "const scan = (pattern, text) => { const copy = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'); for (const _ of text.matchAll(copy)) {} };",
    "const failures = [];",
    "for (const seed of seeds) for (const joiner of joiners) {",
    "  const unit = seed + joiner;",
    "  const small = build(unit, 25000);",
    "  const large = build(unit, 100000);",
    "  const subjects = [['redactSecrets', (text) => redact.redactSecrets(text)], ...patterns.map((p) => [String(p), (text) => scan(p, text)])];",
    "  for (const [name, run] of subjects) {",
    "    const t25 = time(() => run(small));",
    "    const t100 = time(() => run(large));",
    "    const ratio = t100 / Math.max(t25, 1);",
    "    if (ratio >= 8 || t100 >= 250) failures.push({ seed: unit, name, t25: Math.round(t25), t100: Math.round(t100) });",
    "  }",
    "}",
    "process.stdout.write(JSON.stringify({ patterns: patterns.length, failures }));"
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("timed out after 90 s");
    }, 90000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  assert.equal(outcome, 0, stderr);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.failures, []);
  assert.notEqual(result.patterns, 0, "the module exports no pattern list");
});

const LONG_NAME = `${"A".repeat(65)}_PASSWORD`;

test("credential names longer than 64 characters are redacted", () => {
  assert.equal(redactSecrets(`${LONG_NAME}=example,placeholder`), `${LONG_NAME}=[redacted]`);
  assert.equal(redactSecrets(`{"${LONG_NAME}":"hunter2"}`), `{"${LONG_NAME}":"[redacted]"}`);
  const longSuffix = `api_key_${"x".repeat(70)}`;
  assert.equal(redactSecrets(`${longSuffix}: abc123`), `${longSuffix}: [redacted]`);
});

test("a URL password is redacted wherever the scheme starts", () => {
  assert.equal(redactSecrets("x.https://user:hunter2@example.com"), "x.https://user:[redacted]@example.com");
  assert.equal(redactSecrets("git+ssh://me:pw1234@host/repo"), "git+ssh://me:[redacted]@host/repo");
});

test("a credential after a plain assignment in one word is redacted", () => {
  assert.equal(redactSecrets("a=1,token=abc123"), "a=1,token=[redacted]");
  assert.equal(redactSecrets('{"note":"x","password":"y"}'), '{"note":"x","password":"[redacted]"}');
  assert.equal(redactSecrets("jwt eyJhbGciOiJI.eyJzdWIiOiIx.c2lnbmF0dXJl end"), "jwt [redacted] end");
});

test("a JWT after a hyphen or a dot is redacted and one inside a word is not", () => {
  const jwt = "eyJabcdefgh.abcdefgh.abcdefgh";
  assert.equal(redactSecrets(`-${jwt}`), "-[redacted]");
  assert.equal(redactSecrets(`x-${jwt}`), "x-[redacted]");
  assert.equal(redactSecrets(`a.${jwt} end`), "a.[redacted] end");
  assert.equal(redactSecrets(`${jwt}.${jwt}`), "[redacted].[redacted]");
  assert.equal(redactSecrets(`x${jwt}`), `x${jwt}`);
  assert.equal(redactSecrets(`_${jwt}`), `_${jwt}`);
  assert.equal(redactSecrets("-eyJabcdefgh.abcdefgh.abcdefg"), "-eyJabcdefgh.abcdefgh.abcdefg");
});

// A JWT starts at "eyJ" after the text start or a character outside [A-Za-z0-9_], and has
// three dot-separated parts of at least eight characters each after "eyJ".
const JWT_REFERENCE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

test("JWT redaction matches the reference pattern on generated text", () => {
  const pieces = ["eyJ", "abcdefgh", "abc", ".", "-", "_", " ", "x", "eyJabcdefgh.abcdefgh.abcdefgh"];
  let seed = 12345;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed;
  };
  for (let sample = 0; sample < 3000; sample += 1) {
    let text = "";
    const count = 1 + (next() % 14);
    for (let index = 0; index < count; index += 1) {
      text += pieces[next() % pieces.length];
    }
    assert.equal(redactSecrets(text), text.replace(JWT_REFERENCE, "[redacted]"), JSON.stringify(text));
  }
});

test("an unquoted credential value is redacted up to the next whitespace", () => {
  assert.equal(redactSecrets("DB_PASSWORD=abc,def"), "DB_PASSWORD=[redacted]");
  assert.equal(redactSecrets("token=abc;def next"), "token=[redacted] next");
  assert.equal(redactSecrets("export API_KEY=a,b;c\nnext line"), "export API_KEY=[redacted]\nnext line");
});

test("token counts are not credentials", () => {
  for (const text of ["input_tokens: 1200, max_tokens=4096", "prompt_token_count: 12", '{"total_tokens": 99}']) {
    assert.equal(redactSecrets(text), text);
  }
  assert.equal(redactSecrets("access_token=abc123"), "access_token=[redacted]");
});

test("basic authorization and URL passwords are redacted", () => {
  assert.equal(redactSecrets("Authorization: Basic dXNlcjpodW50ZXIy"), "Authorization: Basic [redacted]");
  assert.equal(redactSecrets("clone https://user:hunter2@example.com/repo.git"), "clone https://user:[redacted]@example.com/repo.git");
  assert.equal(redactSecrets("Basic usage is described below"), "Basic usage is described below");
  assert.equal(redactSecrets("see https://example.com:8080/path"), "see https://example.com:8080/path");
});
