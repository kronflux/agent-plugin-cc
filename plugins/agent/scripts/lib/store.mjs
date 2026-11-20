import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

import { listLiveFiles } from "./live.mjs";

// The job store: one SQLite database per workspace under <stateDir>/store, opened through
// node:sqlite.

const require = createRequire(import.meta.url);

// Flags every launch command the plugin controls passes to Node, so the ExperimentalWarning that
// node:sqlite prints on the 22 line does not reach hook output or a command's stderr.
export const NODE_LAUNCH_FLAGS = Object.freeze(["--disable-warning=ExperimentalWarning"]);
// The synchronous pragma of every connection.
export const SYNCHRONOUS = "FULL";

// SQLite before 3.51.3 can corrupt a WAL database used by several connections at once; 3.44.6 and
// 3.50.7 carry the fix within their lines.
const MINIMUM_SQLITE = [3, 51, 3];
const BACKPORTS = [
  [3, 44, 6],
  [3, 50, 7]
];

function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ""));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareTriples(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

/** True when `version` has the WAL-reset corruption fix. */
export function sqliteVersionPasses(version) {
  const parsed = parseVersion(version);
  if (!parsed) {
    return false;
  }
  if (compareTriples(parsed, MINIMUM_SQLITE) >= 0) {
    return true;
  }
  return BACKPORTS.some((fixed) => parsed[0] === fixed[0] && parsed[1] === fixed[1] && parsed[2] >= fixed[2]);
}

let sqliteModule = null;

// Loads node:sqlite synchronously. AGENT_PLUGIN_TEST_SQLITE_VERSION=import-fail makes the load fail.
function loadSqlite() {
  if (process.env.AGENT_PLUGIN_TEST_SQLITE_VERSION === "import-fail") {
    throw new Error("node:sqlite did not load");
  }
  sqliteModule ??= require("node:sqlite");
  return sqliteModule;
}

/**
 * Checks that node:sqlite loads and that its SQLite has the WAL-reset fix. Creates no file.
 * AGENT_PLUGIN_TEST_SQLITE_VERSION replaces the version SQLite reports.
 */
export function checkRuntime() {
  const node = process.version;
  let sqlite;
  try {
    const { DatabaseSync } = loadSqlite();
    const db = new DatabaseSync(":memory:");
    try {
      sqlite = db.prepare("select sqlite_version() AS version").get().version;
    } finally {
      db.close();
    }
  } catch (error) {
    return { ok: false, node, sqlite: null, reason: error instanceof Error ? error.message : String(error) };
  }
  const stub = process.env.AGENT_PLUGIN_TEST_SQLITE_VERSION;
  if (stub) {
    sqlite = stub;
  }
  if (!sqliteVersionPasses(sqlite)) {
    return { ok: false, node, sqlite, reason: "sqlite-too-old" };
  }
  return { ok: true, node, sqlite, reason: null };
}

/** The one message every entry point prints when the runtime gate refuses. */
export function runtimeGateMessage(result) {
  const sqlite = result?.sqlite ?? "none (node:sqlite did not load)";
  return (
    `Node ${result?.node ?? process.version} provides SQLite ${sqlite}; the job store needs SQLite 3.51.3 or later ` +
    "(or 3.44.6+ within 3.44, 3.50.7+ within 3.50)."
  );
}

// ---------------------------------------------------------------------------------------------
// Errors

const RECOVER_COMMAND = "agent-companion.mjs store recover";

/**
 * An error of the store. `class` is `availability` (busy, locked, permission, full disk, I/O,
 * deadline, not migrated), `corruption`, `future-version`, `store-moved` or `in-use`; `code`
 * narrows it.
 */
export class StoreError extends Error {
  /**
   * @param {string} errorClass
   * @param {string} message
   * @param {{ code?: string | null, cause?: unknown, [key: string]: unknown }} [details]
   */
  constructor(errorClass, message, { code = null, cause = undefined, ...extra } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "StoreError";
    this.class = errorClass;
    this.code = code;
    Object.assign(this, extra);
  }
}

const SQLITE_CODES = new Map([
  [3, "perm"],
  [5, "busy"],
  [6, "locked"],
  [8, "readonly"],
  [10, "ioerr"],
  [11, "corrupt"],
  [13, "full"],
  [14, "cantopen"],
  [26, "notadb"]
]);
const AVAILABILITY_CODES = new Set(["perm", "busy", "locked", "readonly", "ioerr", "full", "cantopen"]);
const FS_AVAILABILITY_CODES = new Set(["EACCES", "EPERM", "EBUSY", "ENOSPC", "EROFS", "EMFILE"]);

function corruptionError(detail, cause) {
  return new StoreError(
    "corruption",
    `The job store is corrupt (${detail}). It is never reset automatically. Close every session that uses this ` +
      `workspace, then run: ${RECOVER_COMMAND}`,
    { code: "corrupt", cause }
  );
}

/**
 * Turns an error from node:sqlite or the file system into a StoreError when it is an availability
 * or corruption error; any other error, such as a constraint violation, is returned unchanged.
 */
export function classifySqliteError(error) {
  if (error instanceof StoreError || !(error instanceof Error)) {
    return error;
  }
  const errcode = /** @type {any} */ (error).errcode;
  if (typeof errcode === "number") {
    const name = SQLITE_CODES.get(errcode & 0xff);
    if (name === "corrupt" || name === "notadb") {
      return corruptionError(error.message, error);
    }
    if (name && AVAILABILITY_CODES.has(name)) {
      return new StoreError("availability", `The job store is unavailable (${name}): ${error.message}`, { code: name, cause: error });
    }
    return error;
  }
  const fsCode = /** @type {any} */ (error).code;
  if (typeof fsCode === "string" && FS_AVAILABILITY_CODES.has(fsCode)) {
    return new StoreError("availability", `The job store is unavailable (${fsCode}): ${error.message}`, {
      code: fsCode.toLowerCase(),
      cause: error
    });
  }
  return error;
}

function deadlineError() {
  return new StoreError("availability", "The job store operation did not fit in the time left for this step.", { code: "deadline" });
}

function storeMovedError(storeDir) {
  return new StoreError(
    "store-moved",
    `The job store folder ${storeDir} was moved or replaced, most likely by ${RECOVER_COMMAND}; this process stops.`,
    { code: "store-moved" }
  );
}

// ---------------------------------------------------------------------------------------------
// Test seams. Each reads its variable only when it is set; production never sets them.

let openTransactions = 0;

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

const testPointHits = new Map();

/**
 * Blocks for the milliseconds AGENT_PLUGIN_TEST_DELAYS (a JSON object) gives `name`, as a slow
 * read right before a deadline check would. Names: `launch-attempt` (inside the launch attempt
 * transaction, before its COMMIT), `tree-signal`, `command`.
 */
export function testDelay(name) {
  const text = process.env.AGENT_PLUGIN_TEST_DELAYS;
  if (!text) {
    return;
  }
  let delays;
  try {
    delays = JSON.parse(text);
  } catch {
    return;
  }
  const milliseconds = Number(delays?.[name]);
  if (milliseconds > 0) {
    sleepSync(milliseconds);
  }
}

/**
 * Blocks at a named point when AGENT_PLUGIN_TEST_POINTS names it (`<name>`, or `<name>#<n>` for
 * only its n-th occurrence in this process): writes
 * `<AGENT_PLUGIN_TEST_POINTS_DIR>/<name>-<pid>.reached` and waits until `<name>.release` exists.
 */
export function testPoint(name) {
  const list = process.env.AGENT_PLUGIN_TEST_POINTS;
  const dir = process.env.AGENT_PLUGIN_TEST_POINTS_DIR;
  if (!list || !dir) {
    return;
  }
  const hit = (testPointHits.get(name) ?? 0) + 1;
  testPointHits.set(name, hit);
  const entries = list.split(",").map((entry) => entry.trim());
  if (!entries.includes(name) && !entries.includes(`${name}#${hit}`)) {
    return;
  }
  fs.writeFileSync(path.join(dir, `${name}-${process.pid}.reached`), `${Date.now()}\n`);
  const release = path.join(dir, `${name}.release`);
  while (!fs.existsSync(release)) {
    sleepSync(20);
  }
}

/**
 * Marks an external boundary (`provider-request`, `spawn`, `process-query`, `wait`, `stdout`).
 * With AGENT_PLUGIN_TEST_TXN_LOG it appends `<kind> <1 if a transaction of this process is open>`.
 */
export function boundary(kind) {
  const file = process.env.AGENT_PLUGIN_TEST_TXN_LOG;
  if (file) {
    fs.appendFileSync(file, `${kind} ${openTransactions > 0 ? 1 : 0}\n`);
  }
}

/** Epoch milliseconds; AGENT_PLUGIN_TEST_CLOCK_OFFSET_FILE adds the integer it holds. */
export function wallNow() {
  const file = process.env.AGENT_PLUGIN_TEST_CLOCK_OFFSET_FILE;
  if (!file) {
    return Date.now();
  }
  let offset = 0;
  try {
    offset = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10) || 0;
  } catch {
    offset = 0;
  }
  return Date.now() + offset;
}

// ---------------------------------------------------------------------------------------------
// Schema

const SCHEMA_V1 = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE chains (
  id           TEXT PRIMARY KEY,
  tip_job_id   TEXT NOT NULL,
  live_label   TEXT CHECK (live_label IS NULL OR (length(live_label) BETWEEN 1 AND 40
                 AND live_label NOT GLOB '*[^a-z0-9-]*')),
  created_at   INTEGER NOT NULL,
  activity_at  INTEGER NOT NULL,
  FOREIGN KEY (id, tip_job_id) REFERENCES jobs(chain_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE UNIQUE INDEX chains_live_label ON chains(live_label) WHERE live_label IS NOT NULL;
CREATE INDEX chains_activity ON chains(activity_at);

CREATE TABLE jobs (
  id                  TEXT PRIMARY KEY,
  chain_id            TEXT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
  continues           TEXT,
  provider            TEXT NOT NULL CHECK (provider IN ('codex','agy')),
  kind                TEXT NOT NULL CHECK (kind IN ('task','review')),
  title               TEXT NOT NULL,
  label               TEXT CHECK (label IS NULL OR (length(label) BETWEEN 1 AND 40
                        AND label NOT GLOB '*[^a-z0-9-]*')),
  run_id              TEXT,
  prompt              TEXT NOT NULL,
  request_json        TEXT NOT NULL,
  cwd                 TEXT NOT NULL,
  model               TEXT,
  allow_questions     INTEGER NOT NULL DEFAULT 0 CHECK (allow_questions IN (0,1)),
  foreground          INTEGER NOT NULL DEFAULT 0 CHECK (foreground IN (0,1)),
  forced              INTEGER NOT NULL DEFAULT 0 CHECK (forced IN (0,1)),
  thread_id           TEXT,
  ephemeral           INTEGER NOT NULL DEFAULT 0 CHECK (ephemeral IN (0,1)),
  resume_method       TEXT CHECK (resume_method IN
                        ('thread','conversation','stored-prompt','new-thread')),
  session_id          TEXT,
  leader_pid          INTEGER,
  leader_start_token  TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  launch_attempts     INTEGER NOT NULL DEFAULT 0 CHECK (launch_attempts >= 0),
  last_launch_at      INTEGER,
  last_refusal        TEXT CHECK (last_refusal IN ('admission','thread-busy')),
  exec_gen            INTEGER NOT NULL DEFAULT 0 CHECK (exec_gen >= 0),
  worker_pid          INTEGER,
  worker_start_token  TEXT,
  claimed_at          INTEGER,
  worker_group_id     INTEGER,
  exec_released_at    INTEGER,
  release_kind        TEXT CHECK (release_kind IN ('confirmed','unobserved')),
  active_thread_key   TEXT,
  spawn_intent_at     INTEGER,
  provider_pid        INTEGER,
  provider_start_token TEXT,
  grace_started_at    INTEGER,
  provider_exit_unobserved INTEGER NOT NULL DEFAULT 0 CHECK (provider_exit_unobserved IN (0,1)),
  submit_intent_at    INTEGER,
  client_message_id   TEXT,
  turn_id             TEXT,
  started_at          INTEGER,
  stop_requested_at   INTEGER,
  stop_deadline       INTEGER,
  stop_reason         TEXT CHECK (stop_reason IN
                        ('session-end','leader-gone','cancel','stale-worker')),
  stop_session_id     TEXT,
  cancel_requested_at INTEGER,
  stopping_since      INTEGER,
  stopping_cause      TEXT CHECK (stopping_cause IN
                        ('unconfirmed-stop','unrecorded-child','stale-worker')),
  end_state           TEXT CHECK (end_state IN
                        ('completed','failed','waiting','interrupted','cancelled')),
  end_at              INTEGER,
  end_by              TEXT CHECK (end_by IN ('worker','hook','reconcile','cancel')),
  end_reason          TEXT,
  question            TEXT,
  error               TEXT,
  summary             TEXT,
  result_text         TEXT,
  result_json         TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  result_truncated    INTEGER NOT NULL DEFAULT 0 CHECK (result_truncated IN (0,1)),
  result_json_too_large INTEGER NOT NULL DEFAULT 0 CHECK (result_json_too_large IN (0,1)),
  result_logged       INTEGER NOT NULL DEFAULT 0 CHECK (result_logged IN (0,1)),
  result_at           INTEGER,
  next_action         TEXT CHECK (next_action IN ('continue','cancel')),
  next_at             INTEGER,
  next_session_id     TEXT,
  cancelled_at        INTEGER,
  delivered_at        INTEGER,
  UNIQUE (chain_id, id),
  UNIQUE (continues),
  FOREIGN KEY (chain_id, continues) REFERENCES jobs(chain_id, id),
  CHECK (continues IS NULL OR continues <> id),
  CHECK (next_action IS NULL OR end_state IS NOT NULL),
  CHECK (end_state IS NULL OR end_at IS NOT NULL),
  CHECK (stopping_since IS NULL OR stopping_cause IS NOT NULL),
  CHECK ((exec_released_at IS NULL) = (release_kind IS NULL)),
  CHECK (exec_released_at IS NULL OR claimed_at IS NOT NULL),
  CHECK (result_json_too_large = 0 OR (result_json IS NULL AND result_truncated = 1))
) STRICT;
CREATE INDEX jobs_chain     ON jobs(chain_id, created_at);
CREATE INDEX jobs_open      ON jobs(session_id) WHERE end_state IS NULL;
CREATE INDEX jobs_label     ON jobs(label, created_at) WHERE label IS NOT NULL;
CREATE INDEX jobs_run       ON jobs(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX jobs_executing ON jobs(provider) WHERE claimed_at IS NOT NULL AND exec_released_at IS NULL;
CREATE UNIQUE INDEX jobs_active_thread ON jobs(active_thread_key) WHERE active_thread_key IS NOT NULL;

CREATE TRIGGER jobs_end_once BEFORE UPDATE OF end_state, end_at, end_by, end_reason, question, error
  ON jobs WHEN OLD.end_state IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'end decision is immutable'); END;
CREATE TRIGGER jobs_next_once BEFORE UPDATE OF next_action, next_at, next_session_id ON jobs
  WHEN OLD.next_action IS NOT NULL
   AND (NEW.next_action IS NOT OLD.next_action OR NEW.next_at IS NOT OLD.next_at
        OR NEW.next_session_id IS NOT OLD.next_session_id)
   AND NOT (OLD.next_action = 'cancel' AND NEW.next_action = 'continue')
  BEGIN SELECT RAISE(ABORT, 'next decision is already set'); END;
CREATE TRIGGER jobs_cancel_once BEFORE UPDATE OF cancelled_at ON jobs
  WHEN OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS NOT OLD.cancelled_at
  BEGIN SELECT RAISE(ABORT, 'cancel time is immutable'); END;
CREATE TRIGGER jobs_grace_once BEFORE UPDATE OF grace_started_at ON jobs
  WHEN OLD.grace_started_at IS NOT NULL AND NEW.grace_started_at IS NOT OLD.grace_started_at
  BEGIN SELECT RAISE(ABORT, 'grace start is immutable'); END;
CREATE TRIGGER jobs_release_once BEFORE UPDATE OF exec_released_at, release_kind ON jobs
  WHEN OLD.exec_released_at IS NOT NULL
   AND (NEW.exec_released_at IS NOT OLD.exec_released_at OR NEW.release_kind IS NOT OLD.release_kind)
  BEGIN SELECT RAISE(ABORT, 'release is immutable'); END;

CREATE TABLE messages (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id           TEXT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
  text               TEXT NOT NULL,
  sender_session_id  TEXT,
  created_at         INTEGER NOT NULL,
  state              TEXT NOT NULL DEFAULT 'pending' CHECK (state IN
                       ('pending','dispatched','consumed','withdrawn','dropped')),
  attempts           INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  dispatched_at      INTEGER,
  dispatched_job_id  TEXT,
  dispatched_gen     INTEGER,
  consumed_at        INTEGER,
  consumed_job_id    TEXT,
  closed_at          INTEGER,
  close_cause        TEXT CHECK (close_cause IN ('withdrawn','cancelled','failed')),
  FOREIGN KEY (chain_id, dispatched_job_id) REFERENCES jobs(chain_id, id),
  FOREIGN KEY (chain_id, consumed_job_id)   REFERENCES jobs(chain_id, id),
  CHECK (state NOT IN ('dispatched','consumed') OR dispatched_job_id IS NOT NULL),
  CHECK (state <> 'consumed' OR (consumed_job_id IS NOT NULL AND consumed_at IS NOT NULL)),
  CHECK (state NOT IN ('withdrawn','dropped') OR (closed_at IS NOT NULL AND close_cause IS NOT NULL))
) STRICT;
CREATE INDEX messages_open ON messages(chain_id, id) WHERE state IN ('pending','dispatched');

CREATE TRIGGER messages_text_fixed BEFORE UPDATE OF text, chain_id, created_at ON messages
  BEGIN SELECT RAISE(ABORT, 'message text is immutable'); END;
CREATE TRIGGER messages_transition BEFORE UPDATE OF state ON messages
  WHEN NOT ((OLD.state = 'pending' AND NEW.state IN ('dispatched','withdrawn','dropped'))
         OR (OLD.state = 'dispatched' AND NEW.state IN ('dispatched','consumed','dropped')))
  BEGIN SELECT RAISE(ABORT, 'illegal message transition'); END;
CREATE TRIGGER messages_insert_pending BEFORE INSERT ON messages
  WHEN NEW.state <> 'pending' OR NEW.attempts <> 0
  BEGIN SELECT RAISE(ABORT, 'a new message is pending with no attempts'); END;
CREATE TRIGGER messages_dispatch_counts BEFORE UPDATE OF state ON messages
  WHEN NEW.state = 'dispatched' AND NEW.attempts IS NOT OLD.attempts + 1
  BEGIN SELECT RAISE(ABORT, 'a dispatch raises attempts by one'); END;
CREATE TRIGGER messages_attempts_fixed BEFORE UPDATE OF attempts ON messages
  WHEN NEW.attempts IS NOT OLD.attempts
   AND NOT (NEW.state = 'dispatched' AND OLD.state IN ('pending','dispatched')
            AND NEW.attempts = OLD.attempts + 1)
  BEGIN SELECT RAISE(ABORT, 'attempts change only by a dispatch'); END;

CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('completed','failed','waiting','interrupted')),
  text        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  read_at     INTEGER
) STRICT;
CREATE TRIGGER events_match_end BEFORE INSERT ON events
  WHEN NEW.kind IS NOT (SELECT end_state FROM jobs WHERE id = NEW.job_id)
  BEGIN SELECT RAISE(ABORT, 'event kind differs from the end state'); END;

CREATE TABLE thread_barriers (
  provider    TEXT NOT NULL CHECK (provider IN ('codex','agy')),
  thread_id   TEXT NOT NULL,
  job_id      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (provider, thread_id)
) STRICT;

CREATE TABLE event_marks (
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,
  printed_at  INTEGER NOT NULL,
  PRIMARY KEY (event_id, session_id)
) STRICT;

CREATE TABLE job_notes (
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,
  noted_at    INTEGER NOT NULL,
  PRIMARY KEY (job_id, session_id)
) STRICT;
`;

/**
 * The schema migrations in order, one entry per schema version. `openStore` applies every entry
 * above the stored `user_version` in one transaction. A new version appends an entry.
 */
export const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    apply(db) {
      db.exec(SCHEMA_V1);
      const insert = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
      insert.run("instance_id", randomBytes(8).toString("hex"));
      insert.run("created_at", String(wallNow()));
    }
  }),
  Object.freeze({
    version: 2,
    apply(db) {
      // The process group the provider leads on Linux (it is spawned detached), recorded with the
      // provider's pid; null elsewhere and for rows written before this version.
      db.exec("ALTER TABLE jobs ADD COLUMN provider_group_id INTEGER");
    }
  }),
  Object.freeze({
    version: 3,
    apply(db) {
      // When the worker saw its provider root exit with no tree stop of its own and could not
      // release on that exit; a later scan then credits the provider's own exit, never its owner's
      // death. Null when the worker saw no such exit and for rows written before this version.
      db.exec("ALTER TABLE jobs ADD COLUMN provider_exit_seen_at INTEGER");
    }
  })
]);

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

// AGENT_PLUGIN_TEST_EXTRA_MIGRATION=1 appends a test-only entry one version above SCHEMA_VERSION.
function activeMigrations() {
  if (process.env.AGENT_PLUGIN_TEST_EXTRA_MIGRATION !== "1") {
    return MIGRATIONS;
  }
  return [
    ...MIGRATIONS,
    {
      version: SCHEMA_VERSION + 1,
      apply(db) {
        db.exec("CREATE TABLE test_extra_migration (id INTEGER PRIMARY KEY) STRICT");
      }
    }
  ];
}

// ---------------------------------------------------------------------------------------------
// Connections

const PRIVATE_DIR_MODE = 0o700;
const DEFAULT_BUSY_TIMEOUT_MS = 2000;
const TRANSACTION_CONTROL = /(^|;)\s*(BEGIN|COMMIT|ROLLBACK|END|SAVEPOINT|RELEASE)\b/i;

function makeDir(dir, { recursive = false } = {}) {
  try {
    fs.mkdirSync(dir, { recursive, mode: PRIVATE_DIR_MODE });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
}

/** The device and inode of `<stateDir>/store`, as strings; null when it does not exist. */
export function storeFolderIdentity(stateDir) {
  try {
    const stat = fs.statSync(path.join(stateDir, "store"), { bigint: true });
    return stat.isDirectory() ? { dev: String(stat.dev), ino: String(stat.ino) } : null;
  } catch {
    return null;
  }
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function isThenable(value) {
  return value !== null && (typeof value === "object" || typeof value === "function") && typeof value.then === "function";
}

// The statement a transaction callback runs: every call first binds the busy timeout to the
// caller's remaining allowance.
class StatementHandle {
  constructor(owner, statement) {
    this.owner = owner;
    this.statement = statement;
  }

  run(...params) {
    this.owner.beforeStatement();
    return this.statement.run(...params);
  }

  get(...params) {
    this.owner.beforeStatement();
    return this.statement.get(...params);
  }

  all(...params) {
    this.owner.beforeStatement();
    return this.statement.all(...params);
  }
}

// The handle a transaction callback receives. It refuses transaction-control statements and
// every call after its transaction ended.
class TransactionHandle {
  constructor(store, opts) {
    this.store = store;
    this.opts = opts;
    this.active = true;
  }

  beforeStatement() {
    if (!this.active) {
      throw new TypeError("This store handle belongs to a transaction that has ended.");
    }
    this.store.applyBusyTimeout(this.opts);
  }

  prepare(sql) {
    this.beforeStatement();
    if (TRANSACTION_CONTROL.test(sql)) {
      throw new TypeError("A store transaction callback cannot run a transaction-control statement.");
    }
    return new StatementHandle(this, this.store.statement(sql));
  }

  exec(sql) {
    this.beforeStatement();
    if (TRANSACTION_CONTROL.test(sql)) {
      throw new TypeError("A store transaction callback cannot run a transaction-control statement.");
    }
    this.store.db.exec(sql);
  }
}

/**
 * One connection to a workspace's job store. Every write is one `transact` call; every read is
 * one `read` call. Both check the store folder's identity first.
 */
export class Store {
  constructor(db, { stateDir, identity, busyTimeoutMs }) {
    this.db = db;
    this.stateDir = stateDir;
    this.storeDir = path.join(stateDir, "store");
    this.identity = identity;
    this.busyTimeoutMs = busyTimeoutMs;
    this.instanceId = null;
    this.currentBusyTimeout = null;
    this.statements = new Map();
    this.open = false;
    this.closed = false;
  }

  statement(sql) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  // Sets the busy timeout to the smaller of the attempt allowance and the time left before the
  // caller's deadline; a spent deadline throws.
  applyBusyTimeout(opts = {}) {
    const remaining = opts.deadline === undefined || opts.deadline === null ? Infinity : opts.deadline - performance.now();
    if (remaining <= 0) {
      throw deadlineError();
    }
    const milliseconds = Math.max(1, Math.floor(Math.min(opts.attemptMs ?? this.busyTimeoutMs, remaining)));
    if (milliseconds !== this.currentBusyTimeout) {
      this.db.exec(`PRAGMA busy_timeout = ${milliseconds}`);
      this.currentBusyTimeout = milliseconds;
    }
  }

  checkIdentity() {
    if (!sameIdentity(storeFolderIdentity(this.stateDir), this.identity)) {
      this.close();
      throw storeMovedError(this.storeDir);
    }
  }

  inTransaction() {
    return this.open;
  }

  transact(fn, opts = {}) {
    return this.run("BEGIN IMMEDIATE", fn, opts);
  }

  read(fn, opts = {}) {
    return this.run("BEGIN", fn, opts);
  }

  run(begin, fn, opts) {
    if (typeof fn !== "function") {
      throw new TypeError("A store transaction needs a callback.");
    }
    if (openTransactions > 0) {
      throw new TypeError("A store transaction is already open in this process; transactions do not nest.");
    }
    if (this.closed) {
      throw new StoreError("availability", "The job store connection is closed.", { code: "closed" });
    }
    this.checkIdentity();
    try {
      this.applyBusyTimeout(opts);
      this.db.exec(begin);
    } catch (error) {
      throw classifySqliteError(error);
    }
    openTransactions += 1;
    this.open = true;
    const handle = new TransactionHandle(this, opts);
    try {
      const result = fn(handle);
      if (isThenable(result)) {
        result.then(
          () => {},
          () => {}
        );
        throw new TypeError("A store transaction callback must be synchronous; it returned a promise.");
      }
      this.applyBusyTimeout(opts);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // A failed COMMIT or statement may already have ended the transaction.
      }
      throw classifySqliteError(error);
    } finally {
      handle.active = false;
      openTransactions -= 1;
      this.open = false;
    }
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.statements.clear();
    try {
      this.db.close();
    } catch {
      // A connection that failed while opening may already be unusable.
    }
  }
}

function readUserVersion(db) {
  return Number(db.prepare("PRAGMA user_version").get().user_version);
}

function futureVersionError(found, supported) {
  return new StoreError(
    "future-version",
    `The job store has schema version ${found}, but this plugin supports schema version ${supported}; update the plugin.`,
    { code: "future-version", found, supported }
  );
}

function migrate(store, opts) {
  const migrations = activeMigrations();
  const target = migrations[migrations.length - 1].version;
  const { db } = store;
  let version = readUserVersion(db);
  if (version > target) {
    throw futureVersionError(version, target);
  }
  if (version === target) {
    return;
  }
  if (!opts.migrate) {
    throw new StoreError("availability", `The job store has schema version ${version} and needs a migration to ${target}.`, {
      code: "not-migrated"
    });
  }
  store.applyBusyTimeout(opts);
  db.exec("BEGIN IMMEDIATE");
  let applied = 0;
  try {
    version = readUserVersion(db);
    if (version > target) {
      throw futureVersionError(version, target);
    }
    for (const migration of migrations) {
      if (migration.version > version) {
        migration.apply(db);
        db.exec(`PRAGMA user_version = ${migration.version}`);
        applied += 1;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The failed statement may already have ended the transaction.
    }
    throw error;
  }
  const countFile = process.env.AGENT_PLUGIN_TEST_MIGRATION_COUNT_FILE;
  if (applied > 0 && countFile) {
    fs.appendFileSync(countFile, `${process.pid}\n`);
  }
}

/**
 * Opens the job store of a workspace state folder, creating `<stateDir>/store` when it is missing,
 * and migrates it to SCHEMA_VERSION when `migrate` is true. The busy timeout of the open is the
 * smaller of `busyTimeoutMs` and the time left before `deadline` (a `performance.now()` value).
 */
export function openStore(stateDir, { busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS, deadline = undefined, migrate: allowMigration = true } = {}) {
  const { DatabaseSync } = loadSqlite();
  const storeDir = path.join(stateDir, "store");
  let identity;
  let db;
  try {
    makeDir(stateDir, { recursive: true });
    makeDir(storeDir);
    makeDir(path.join(storeDir, "live"));
    makeDir(path.join(storeDir, "artifacts"));
    identity = storeFolderIdentity(stateDir);
    if (!identity) {
      throw storeMovedError(storeDir);
    }
    db = new DatabaseSync(path.join(storeDir, "state.db"));
  } catch (error) {
    throw classifySqliteError(error);
  }
  const store = new Store(db, { stateDir, identity, busyTimeoutMs });
  const opts = { deadline, attemptMs: busyTimeoutMs, migrate: allowMigration };
  try {
    store.applyBusyTimeout(opts);
    const mode = db.prepare("PRAGMA journal_mode=WAL").get();
    if (String(mode?.journal_mode).toLowerCase() !== "wal") {
      throw new StoreError("availability", `The job store could not use WAL mode (journal_mode answered ${mode?.journal_mode}).`, {
        code: "journal-mode"
      });
    }
    db.exec(`PRAGMA synchronous=${SYNCHRONOUS}`);
    db.exec("PRAGMA foreign_keys=ON");
    if (!sameIdentity(storeFolderIdentity(stateDir), identity)) {
      throw storeMovedError(storeDir);
    }
    migrate(store, opts);
    const row = db.prepare("SELECT value FROM meta WHERE key = 'instance_id'").get();
    store.instanceId = row?.value ?? null;
  } catch (error) {
    store.close();
    throw classifySqliteError(error);
  }
  return store;
}

// ---------------------------------------------------------------------------------------------
// Retries and integrity

/**
 * Busy retry budgets per caller kind: the busy timeout of one attempt, the total time for one
 * logical operation, and the pause between attempts. A hook passes its phase deadline instead of
 * a total.
 */
export const RETRY_BUDGETS = Object.freeze({
  command: Object.freeze({ attemptMs: 2000, totalMs: 10000, yieldMs: 0 }),
  monitor: Object.freeze({ attemptMs: 1000, totalMs: 3000, yieldMs: 0 }),
  worker: Object.freeze({ attemptMs: 250, totalMs: 30000, yieldMs: 20 }),
  hook: Object.freeze({ attemptMs: 2000, totalMs: 0, yieldMs: 0 })
});

function isRetryable(error) {
  return error instanceof StoreError && error.class === "availability" && (error.code === "busy" || error.code === "locked");
}

/**
 * Runs `fn({ deadline, attemptMs })` until it returns, retrying busy and locked errors within the
 * budget (a RETRY_BUDGETS name or entry) and before `deadline`. The total time is measured on the
 * monotonic clock, and each attempt's busy wait is capped by the time left. With `deadline`, the
 * wait before a retry is checked against it last: once it has passed the last error is thrown
 * with no wait, and no wait runs past it. `onRetry(error, attempt)` is called before each retry.
 * Throws the last error.
 */
export async function withRetry(fn, budget, { deadline = undefined, onRetry = undefined } = {}) {
  const spec = typeof budget === "string" ? RETRY_BUDGETS[budget] : budget;
  if (!spec) {
    throw new TypeError(`Unknown retry budget: ${budget}`);
  }
  const start = performance.now();
  let end = spec.totalMs > 0 ? start + spec.totalMs : Infinity;
  if (deadline !== undefined && deadline !== null) {
    end = Math.min(end, deadline);
  }
  if (end === Infinity) {
    end = start + spec.attemptMs;
  }
  let lastError = null;
  for (let attempt = 1; ; attempt += 1) {
    const remaining = end - performance.now();
    if (remaining <= 0) {
      throw lastError ?? deadlineError();
    }
    try {
      return await fn({ deadline: end, attemptMs: Math.min(spec.attemptMs, remaining) });
    } catch (error) {
      if (!isRetryable(error)) {
        throw error;
      }
      lastError = error;
      onRetry?.(error, attempt);
      // With a deadline, no wait starts once it has passed, and no wait outlasts it.
      const left = deadline === undefined || deadline === null ? Infinity : deadline - performance.now();
      if (left <= 0) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(spec.yieldMs, left)));
    }
  }
}

const INTEGRITY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Reserves the periodic integrity check: true only for the one caller that moved
 * `meta.last_integrity_check_at` to `now` because it was missing or older than 24 hours.
 */
export function reserveIntegrityCheck(store, { now = wallNow() } = {}, opts = {}) {
  return store.transact((db) => {
    const updated = db
      .prepare("UPDATE meta SET value = ? WHERE key = 'last_integrity_check_at' AND CAST(value AS INTEGER) <= ?")
      .run(String(now), now - INTEGRITY_INTERVAL_MS);
    if (updated.changes > 0) {
      return true;
    }
    const inserted = db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('last_integrity_check_at', ?)").run(String(now));
    return inserted.changes > 0;
  }, opts);
}

/** Runs PRAGMA integrity_check; returns "ok" or the failure text. */
export function checkIntegrity(store, opts = {}) {
  if (process.env.AGENT_PLUGIN_TEST_INTEGRITY_FAIL === "1") {
    return "*** in database main ***\nintegrity failure simulated by AGENT_PLUGIN_TEST_INTEGRITY_FAIL";
  }
  const rows = store.read((db) => db.prepare("PRAGMA integrity_check").all(), opts);
  return rows.map((row) => Object.values(row)[0]).join("\n");
}

// ---------------------------------------------------------------------------------------------
// Artifacts

const ORPHAN_LOG_AGE_MS = 60 * 60 * 1000;

/**
 * Deletes the logs of pruned jobs, and logs in store/artifacts whose job no longer exists and that
 * are older than one hour. Touches nothing outside store/artifacts. Resolves to the number of logs
 * deleted.
 */
export async function pruneArtifacts(stateDir, prunedJobIds = []) {
  const artifacts = path.join(stateDir, "store", "artifacts");
  let names;
  try {
    names = await fs.promises.readdir(artifacts);
  } catch {
    return 0;
  }
  const logs = names.filter((name) => name.endsWith(".log"));
  const pruned = new Set(prunedJobIds.map((jobId) => `${jobId}.log`));
  let known = new Set();
  const store = openStore(stateDir, { migrate: false });
  try {
    known = new Set(store.read((db) => db.prepare("SELECT id FROM jobs").all().map((row) => `${row.id}.log`)));
  } finally {
    store.close();
  }
  let deleted = 0;
  for (const name of logs) {
    const file = path.join(artifacts, name);
    let remove = pruned.has(name) && !known.has(name);
    if (!remove && !known.has(name)) {
      try {
        remove = Date.now() - (await fs.promises.stat(file)).mtimeMs > ORPHAN_LOG_AGE_MS;
      } catch {
        remove = false;
      }
    }
    if (remove) {
      try {
        await fs.promises.rm(file, { force: true });
        deleted += 1;
      } catch {
        // A log another process holds open stays until the next prune.
      }
    }
  }
  return deleted;
}

// ---------------------------------------------------------------------------------------------
// Offline recovery

const REFUSED_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function utcStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/**
 * The offline recovery of a workspace's store: runs the integrity check and, only when it fails,
 * the file cannot be read as SQLite, or `force` is set, moves `<stateDir>/store` whole to
 * `store.corrupt-<UTC yyyymmddThhmmssZ>-<8 hex>` with one rename. A healthy store is left alone.
 * A refused rename throws `StoreError` class `in-use` with the identity files it could read and
 * changes nothing.
 */
export function recoverStore(stateDir, { force = false } = {}) {
  const storeDir = path.join(stateDir, "store");
  if (!fs.existsSync(storeDir)) {
    return { healthy: true };
  }
  let corrupt = false;
  try {
    const store = openStore(stateDir, { migrate: false });
    try {
      corrupt = checkIntegrity(store) !== "ok";
    } finally {
      store.close();
    }
  } catch (error) {
    if (error instanceof StoreError && error.class === "corruption") {
      corrupt = true;
    } else if (!(error instanceof StoreError && error.code === "not-migrated")) {
      throw error;
    }
  }
  if (!corrupt && !force) {
    return { healthy: true };
  }
  testPoint("inside-recover");
  const target = path.join(stateDir, `store.corrupt-${utcStamp()}-${randomBytes(4).toString("hex")}`);
  try {
    fs.renameSync(storeDir, target);
  } catch (error) {
    if (REFUSED_RENAME_CODES.has(error?.code)) {
      const liveFiles = listLiveFiles(stateDir);
      throw new StoreError(
        "in-use",
        `The job store folder ${storeDir} is in use and was not moved (${error.code}). Close every Claude Code session and ` +
          "command that uses this workspace, then run the recovery again.",
        { code: "in-use", liveFiles, cause: error }
      );
    }
    throw error;
  }
  return { renamedTo: target };
}
