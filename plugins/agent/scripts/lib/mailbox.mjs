import { testPoint, wallNow } from "./store.mjs";
import {
  JobCancelledError,
  JobFailedError,
  MESSAGE_LIMIT_BYTES,
  MessageTooLargeError,
  NotResumableError,
  ThreadBarrierError,
  UnknownJobError,
  jobState,
  resumability,
  storeInternals
} from "./state.mjs";

// Chain messages, their dispatch and confirmation, the job events the monitor prints, and the
// text a job sends. A message belongs to a chain; whichever job of the chain runs takes it.

// lib/state.mjs can be mid-evaluation when this module loads (through the provider registry),
// so its helpers are read when a function runs, not at import time.
const getJobRow = (...args) => storeInternals.getJobRow(...args);
const getChainRow = (...args) => storeInternals.getChainRow(...args);
const chainForRef = (...args) => storeInternals.chainForRef(...args);
const tipRowOf = (...args) => storeInternals.tipRowOf(...args);
const barrierFor = (...args) => storeInternals.barrierFor(...args);
const fenceHolds = (...args) => storeInternals.fenceHolds(...args);
const insertSuccessor = (...args) => storeInternals.insertSuccessor(...args);
const utf8Bytes = (...args) => storeInternals.utf8Bytes(...args);

/** The fixed opening line of a continuation with no message waiting. */
export const CONTINUE_LINE = "Continue the work you were doing in this conversation.";
/** The line that follows `[message <id>]` when the message may already have been delivered. */
export const UNCERTAIN_PREFIX = "This message may already have reached you before the interruption:";
// Text the plugin adds to one request (the message line, the prefix and the fixed instructions).
const ADDED_TEXT_LIMIT_BYTES = 4096;

/** The client id of a message: the store's instance id and the message id. */
export function messageClientId(instanceId, messageId) {
  return `agent-${instanceId}-${messageId}`;
}

/** The client id of a job's stored prompt. */
export function submitClientId(instanceId, jobId) {
  return `agent-${instanceId}-${jobId}`;
}

/**
 * The text of one request: `[message <id>]` first when it carries a message, then the uncertain
 * prefix when asked, then the body, then the fixed additions. Throws a RangeError when the text
 * the plugin adds exceeds 4,096 bytes.
 */
export function composeRequestText({ messageId = null, uncertain = false, body = "", additions = [] } = {}) {
  const header = [];
  if (messageId !== null && messageId !== undefined) {
    header.push(`[message ${messageId}]`);
  }
  if (uncertain) {
    header.push(UNCERTAIN_PREFIX);
  }
  const extra = (additions ?? []).filter((line) => typeof line === "string" && line.length > 0).join("\n");
  const added = utf8Bytes(header.join("\n")) + utf8Bytes(extra);
  if (added > ADDED_TEXT_LIMIT_BYTES) {
    throw new RangeError(`The text added to a request is ${added} bytes; the limit is ${ADDED_TEXT_LIMIT_BYTES} bytes.`);
  }
  const text = [...header, String(body ?? "")].join("\n");
  return extra ? `${text}\n\n${extra}` : text;
}

function insertMessage(db, chainId, text, requester, at) {
  return Number(
    db
      .prepare("INSERT INTO messages (chain_id, text, sender_session_id, created_at) VALUES (?, ?, ?, ?)")
      .run(chainId, text, requester?.sessionId ?? null, at).lastInsertRowid
  );
}

/**
 * Stores a message for a chain in one transaction and acts on its current tip: a queued or
 * running tip takes it (`running`); a stopping tip keeps it pending (`pending-stopping`); a
 * waiting, interrupted or completed tip is continued with the message (`continued`, the sender
 * owns the successor). A cancelled or failed tip refuses it, and so does a thread behind a barrier
 * unless `force`.
 */
export function sendToChain(store, target, { text, requester = null, force = false } = {}, opts = {}) {
  const body = String(text ?? "");
  if (utf8Bytes(body) > MESSAGE_LIMIT_BYTES) {
    throw new MessageTooLargeError({ bytes: utf8Bytes(body) });
  }
  if (!target || typeof target !== "object" || typeof target.ref !== "string") {
    throw new TypeError("sendToChain needs a target object: { ref, observedTipId }.");
  }
  const outcome = store.transact((db) => {
    const chainId = chainForRef(db, target.ref);
    const chain = chainId ? getChainRow(db, chainId) : null;
    const tip = chain ? tipRowOf(db, chainId) : null;
    if (!tip) {
      throw new UnknownJobError({ ref: target.ref });
    }
    if (target.observedTipId && getJobRow(db, target.observedTipId)?.chain_id !== chainId) {
      throw new UnknownJobError({ ref: target.observedTipId });
    }
    const at = wallNow();
    const current = jobState(tip);
    if (current === "queued" || current === "running") {
      return { messageId: insertMessage(db, chainId, body, requester, at), outcome: "running", jobId: tip.id, barrierJobId: null };
    }
    if (current === "stopping") {
      return { messageId: insertMessage(db, chainId, body, requester, at), outcome: "pending-stopping", jobId: tip.id, barrierJobId: null };
    }
    if (current === "cancelled") {
      throw new JobCancelledError({ jobId: tip.id });
    }
    if (current === "failed") {
      throw new JobFailedError({ jobId: tip.id });
    }
    const { resumable, reason } = resumability(tip);
    if (!resumable) {
      throw new NotResumableError({ jobId: tip.id, reason });
    }
    const barrierJobId = barrierFor(db, tip.provider, tip.thread_id);
    if (barrierJobId && !force) {
      throw new ThreadBarrierError({ threadId: tip.thread_id, barrierJobId });
    }
    const decided = db
      .prepare("UPDATE jobs SET next_action = 'continue', next_at = ?, next_session_id = ?, updated_at = ? WHERE id = ? AND next_action IS NULL")
      .run(at, requester?.sessionId ?? null, at, tip.id);
    if (decided.changes !== 1) {
      throw new JobCancelledError({ jobId: tip.id });
    }
    const inserted = insertSuccessor(db, getJobRow(db, tip.id), { requester, forced: Boolean(barrierJobId), message: body, at });
    return { messageId: inserted.messageId, outcome: "continued", jobId: inserted.successorId, barrierJobId: barrierJobId ?? null };
  }, opts);
  testPoint("after-send-commit");
  return outcome;
}

/**
 * Commits that an execution is about to hand a message to its provider: the message is in the
 * job's chain, the job is the tip with a live claim of `execGen` and no stop, cancel or end, and
 * this execution has not dispatched it yet. Every dispatch raises `attempts` by one.
 */
export function dispatchMessage(store, messageId, { jobId, execGen }, opts = {}) {
  return store.transact((db) => {
    const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId);
    const job = getJobRow(db, jobId);
    if (!message || !job || message.chain_id !== job.chain_id) {
      return { won: false, state: message?.state ?? null, reason: "other-chain" };
    }
    if (message.state !== "pending" && message.state !== "dispatched") {
      return { won: false, state: message.state, reason: "closed" };
    }
    if (message.state === "dispatched" && message.dispatched_job_id === jobId && message.dispatched_gen === execGen) {
      return { won: false, state: message.state, reason: "already-dispatched" };
    }
    if (getChainRow(db, job.chain_id)?.tip_job_id !== jobId) {
      return { won: false, state: message.state, reason: "not-tip" };
    }
    if (job.end_state) {
      return { won: false, state: message.state, reason: "ended" };
    }
    if (!fenceHolds(job, execGen)) {
      return { won: false, state: message.state, reason: "fenced" };
    }
    const at = wallNow();
    db.prepare(
      `UPDATE messages SET state = 'dispatched', attempts = attempts + 1, dispatched_at = ?, dispatched_job_id = ?, dispatched_gen = ?
       WHERE id = ? AND state IN ('pending', 'dispatched')`
    ).run(at, jobId, execGen, messageId);
    return { won: true, attempts: message.attempts + 1 };
  }, opts);
}

/**
 * Marks a dispatched message consumed by the observing execution. A receipt proves delivery to
 * the dispatching execution itself; a history proof lets a continuing job confirm a message an
 * earlier job dispatched. Never changes a closed message.
 */
export function confirmMessage(store, messageId, { expectedJobId, expectedGen, observingJobId, observingGen, proof = "receipt" }, opts = {}) {
  return store.transact((db) => {
    const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId);
    const refused = () => ({
      confirmed: false,
      state: message?.state ?? null,
      dispatchedJobId: message?.dispatched_job_id ?? null,
      dispatchedGen: message?.dispatched_gen ?? null
    });
    if (!message || message.state !== "dispatched" || message.dispatched_job_id !== expectedJobId || message.dispatched_gen !== expectedGen) {
      return refused();
    }
    if (proof === "receipt" && (expectedJobId !== observingJobId || expectedGen !== observingGen)) {
      return refused();
    }
    const observer = getJobRow(db, observingJobId);
    if (!observer || observer.claimed_at === null || observer.exec_released_at !== null || observer.exec_gen !== observingGen) {
      return refused();
    }
    const update = db
      .prepare(
        `UPDATE messages SET state = 'consumed', consumed_at = ?, consumed_job_id = ?
         WHERE id = ? AND state = 'dispatched' AND dispatched_job_id = ? AND dispatched_gen = ?`
      )
      .run(wallNow(), observingJobId, messageId, expectedJobId, expectedGen);
    return update.changes === 1 ? { confirmed: true } : refused();
  }, opts);
}

/** Where a message stands, and the state of its chain's tip; null for an unknown message. */
export function readMessageOutcome(store, messageId, opts = {}) {
  return store.read((db) => {
    const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId);
    if (!message) {
      return null;
    }
    const tip = tipRowOf(db, message.chain_id);
    return {
      state: message.state,
      attempts: message.attempts,
      dispatchedJobId: message.dispatched_job_id,
      consumedJobId: message.consumed_job_id,
      closeCause: message.close_cause,
      tipId: tip?.id ?? null,
      tipState: tip ? jobState(tip) : null
    };
  }, opts);
}

function messageView(row) {
  return { ...row };
}

/** A chain's deliverable messages (pending, or dispatched and not consumed), in id order. */
export function deliverableMessages(store, chainId, opts = {}) {
  return store.read(
    (db) =>
      db
        .prepare("SELECT * FROM messages WHERE chain_id = ? AND state IN ('pending', 'dispatched') ORDER BY id")
        .all(chainId)
        .map(messageView),
    opts
  );
}

/** A chain's messages in id order, optionally only those in `states` (a snapshot). */
export function listMessages(store, chainId, { states = null } = {}, opts = {}) {
  return store.read((db) => {
    const rows = db.prepare("SELECT * FROM messages WHERE chain_id = ? ORDER BY id").all(chainId);
    return rows.filter((row) => !states || states.includes(row.state)).map(messageView);
  }, opts);
}

/** Takes back a message no worker dispatched; true when it was pending and is now withdrawn. */
export function withdrawMessage(store, messageId, opts = {}) {
  return store.transact((db) => {
    const at = wallNow();
    return (
      db
        .prepare("UPDATE messages SET state = 'withdrawn', closed_at = ?, close_cause = 'withdrawn' WHERE id = ? AND state = 'pending'")
        .run(at, messageId).changes === 1
    );
  }, opts);
}

/**
 * Job events in id order with the job's session, delivery time, provider and label: those of jobs
 * of `sessionId` when given, only those not yet printed to that session with `unprinted`, only
 * unread ones with `unread`.
 */
export function listEvents(store, { sessionId = null, unprinted = false, unread = false } = {}, opts = {}) {
  return store.read((db) => {
    const clauses = [];
    const params = [];
    if (sessionId) {
      clauses.push("jobs.session_id = ?");
      params.push(sessionId);
    }
    if (unprinted && sessionId) {
      clauses.push("NOT EXISTS (SELECT 1 FROM event_marks WHERE event_marks.event_id = events.id AND event_marks.session_id = ?)");
      params.push(sessionId);
    }
    if (unread) {
      clauses.push("events.read_at IS NULL");
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return db
      .prepare(
        `SELECT events.id, events.job_id, events.kind, events.text, events.created_at, events.read_at, jobs.session_id,
           jobs.delivered_at, jobs.provider, jobs.label
         FROM events JOIN jobs ON jobs.id = events.job_id ${where} ORDER BY events.id`
      )
      .all(...params)
      .map((row) => ({
        id: row.id,
        jobId: row.job_id,
        kind: row.kind,
        text: row.text,
        createdAt: row.created_at,
        readAt: row.read_at,
        jobSessionId: row.session_id,
        deliveredAt: row.delivered_at,
        provider: row.provider,
        label: row.label
      }));
  }, opts);
}

/** Records that an event was printed to a session; true for the first caller only. */
export function markEventPrinted(store, eventId, sessionId, opts = {}) {
  return store.transact(
    (db) => db.prepare("INSERT OR IGNORE INTO event_marks (event_id, session_id, printed_at) VALUES (?, ?, ?)").run(eventId, sessionId, wallNow()).changes === 1,
    opts
  );
}

/** Marks an event read; true when it was unread. */
export function markEventRead(store, eventId, opts = {}) {
  return store.transact((db) => db.prepare("UPDATE events SET read_at = ? WHERE id = ? AND read_at IS NULL").run(wallNow(), eventId).changes === 1, opts);
}

/** Records that a waiting command returned a job's outcome; true when it was not recorded yet. */
export function markDelivered(store, jobId, opts = {}) {
  return store.transact(
    (db) => db.prepare("UPDATE jobs SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL").run(wallNow(), jobId).changes === 1,
    opts
  );
}

/**
 * Records that jobs were noted to a session; returns the ids not noted to it before. A job that
 * is no longer its chain's tip (it was continued since it was read) is not noted.
 */
export function noteJobs(store, jobIds, sessionId, opts = {}) {
  return store.transact((db) => {
    const at = wallNow();
    const noted = [];
    for (const jobId of jobIds) {
      if (!getJobRow(db, jobId) || !db.prepare("SELECT 1 FROM chains WHERE tip_job_id = ?").get(jobId)) {
        continue;
      }
      if (db.prepare("INSERT OR IGNORE INTO job_notes (job_id, session_id, noted_at) VALUES (?, ?, ?)").run(jobId, sessionId, at).changes === 1) {
        noted.push(jobId);
      }
    }
    return noted;
  }, opts);
}
