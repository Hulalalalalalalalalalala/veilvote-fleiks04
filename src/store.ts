import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Group } from "@semaphore-protocol/group";
import type {
  AuditAction, AuditEvent, GroupVersionSummary, PollDetail, PollResults, PollStatus, PollSummary, VoteReceipt
} from "./types.ts";

interface SeedPoll extends Omit<PollDetail, "memberCount" | "optionCount" | "eligibleMemberCommitments" | "groupVersion" | "merkleRoot"> {}
interface CatalogSeed { polls: SeedPoll[]; memberCommitments: string[] }
interface PollRow {
  id: string; title: string; summary: string; description: string;
  organizer: string; status: PollStatus; published_at: string; closes_at: string;
  options_json: string; group_version: number; frozen_version: number | null;
}
interface GroupVersionRow { poll_id: string; version: number; commitments_json: string; merkle_root: string; created_at: string }
interface VoteRow { id: string; poll_id: string; option_id: string; nullifier: string; accepted_at: string }
interface AuditRow { id: string; action: AuditAction; poll_id: string; result: "success" | "failure"; at: string; details_json: string }

export interface GroupSnapshot { version: number; commitments: string[]; merkleRoot: string }
export type GroupOperation =
  | { type: "join"; commitment: string }
  | { type: "rotate"; oldCommitment: string; newCommitment: string }
  | { type: "revoke"; commitment: string };
export type GroupOperationOutcome =
  | { ok: true; group: GroupVersionSummary }
  | { ok: false; reason: "poll_missing" | "poll_not_editable" | "group_frozen" | "group_version_changed" | "duplicate_commitment" | "commitment_not_found" | "empty_group" };
export type CommitVoteOutcome =
  | { ok: true; receipt: VoteReceipt }
  | { ok: false; reason: "poll_closed" | "invalid_option" | "duplicate_nullifier" | "group_version_changed" };

export interface NewPollInput {
  id: string;
  title: string;
  summary: string;
  description: string;
  organizer: string;
  publishedAt: string;
  closesAt: string;
  options: { id: string; label: string }[];
  commitments: string[];
}
export type CreatePollOutcome =
  | { ok: true; poll: PollDetail }
  | { ok: false; reason: "poll_exists" };
/** Legal lifecycle edges, in order. */
const STATUS_FLOW: Record<PollStatus, PollStatus | null> = {
  draft: "open",
  open: "closed",
  closed: "archived",
  archived: null
};
export const STATUSES: readonly PollStatus[] = ["draft", "open", "closed", "archived"];
export type StatusTransitionOutcome =
  | { ok: true; status: PollStatus }
  | { ok: false; reason: "poll_missing" | "invalid_status" | "status_conflict" | "illegal_transition" };

function toReceipt(row: VoteRow): VoteReceipt {
  return { id: row.id, pollId: row.poll_id, optionId: row.option_id, nullifier: row.nullifier, acceptedAt: row.accepted_at };
}
function toSnapshot(row: GroupVersionRow): GroupSnapshot {
  return { version: row.version, commitments: JSON.parse(row.commitments_json) as string[], merkleRoot: row.merkle_root };
}
function toAuditEvent(row: AuditRow): AuditEvent {
  return { id: row.id, action: row.action, pollId: row.poll_id, result: row.result, at: row.at, details: JSON.parse(row.details_json) as Record<string, unknown> };
}
function merkleRootOf(commitments: string[]): string {
  return new Group(commitments).root.toString();
}

export function openCatalog(databasePath: string) {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS polls (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL,
      description TEXT NOT NULL, organizer TEXT NOT NULL, status TEXT NOT NULL,
      published_at TEXT NOT NULL, closes_at TEXT NOT NULL, options_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS members (
      commitment TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS votes (
      id TEXT PRIMARY KEY,
      poll_id TEXT NOT NULL REFERENCES polls (id),
      option_id TEXT NOT NULL,
      nullifier TEXT NOT NULL,
      accepted_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS votes_poll_nullifier ON votes (poll_id, nullifier);
    CREATE TABLE IF NOT EXISTS group_versions (
      poll_id TEXT NOT NULL REFERENCES polls (id),
      version INTEGER NOT NULL,
      commitments_json TEXT NOT NULL,
      merkle_root TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (poll_id, version)
    );
    CREATE INDEX IF NOT EXISTS group_versions_root ON group_versions (poll_id, merkle_root);
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      poll_id TEXT NOT NULL,
      result TEXT NOT NULL,
      at TEXT NOT NULL,
      details_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_events_time ON audit_events (at DESC, id DESC);
  `);
  // Migrate pre-versioning databases: add the group columns to existing polls.
  const pollColumns = new Set((db.prepare("PRAGMA table_info(polls)").all() as { name: string }[]).map(column => column.name));
  if (!pollColumns.has("group_version")) db.exec("ALTER TABLE polls ADD COLUMN group_version INTEGER NOT NULL DEFAULT 1");
  if (!pollColumns.has("frozen_version")) db.exec("ALTER TABLE polls ADD COLUMN frozen_version INTEGER");

  const existing = db.prepare("SELECT count(*) AS count FROM polls").get() as { count: number };
  if (existing.count === 0) {
    const seed = JSON.parse(readFileSync(new URL("../fixtures/catalog.json", import.meta.url), "utf8")) as CatalogSeed;
    db.exec("BEGIN");
    try {
      const insertPoll = db.prepare("INSERT INTO polls (id, title, summary, description, organizer, status, published_at, closes_at, options_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const poll of seed.polls) insertPoll.run(poll.id, poll.title, poll.summary, poll.description, poll.organizer, poll.status, poll.publishedAt, poll.closesAt, JSON.stringify(poll.options));
      const insertMember = db.prepare("INSERT INTO members VALUES (?, ?)");
      seed.memberCommitments.forEach((commitment, index) => insertMember.run(commitment, index));
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); db.close(); throw error; }
  }
  // Legacy databases only ever knew the "open" state: normalize any poll whose
  // status is not part of the lifecycle to open, so old issues migrate forward.
  db.exec(`UPDATE polls SET status = 'open' WHERE status NOT IN ('draft', 'open', 'closed', 'archived')`);
  // Snapshot the legacy member list as immutable version 1 for every poll that
  // has no versions yet (fresh seeds and databases migrated from before
  // versioned groups). The snapshot, its Merkle root and the version number
  // are persisted together so all three stay consistent across restarts.
  const versioned = db.prepare("SELECT count(*) AS count FROM group_versions").get() as { count: number };
  if (versioned.count === 0) {
    const commitments = members();
    if (commitments.length > 0) {
      const merkleRoot = merkleRootOf(commitments);
      const createdAt = new Date().toISOString();
      const insertVersion = db.prepare("INSERT INTO group_versions (poll_id, version, commitments_json, merkle_root, created_at) VALUES (?, 1, ?, ?, ?)");
      const pollIds = db.prepare("SELECT id FROM polls").all() as { id: string }[];
      db.exec("BEGIN");
      try {
        for (const poll of pollIds) insertVersion.run(poll.id, JSON.stringify(commitments), merkleRoot, createdAt);
        // Polls that already accepted votes are frozen on version 1, matching
        // the freeze-on-first-vote rule applied to new votes.
        db.exec("UPDATE polls SET frozen_version = 1 WHERE frozen_version IS NULL AND id IN (SELECT DISTINCT poll_id FROM votes)");
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); db.close(); throw error; }
    }
  }

  /** Insert an audit row. Must be called inside an open transaction. */
  function insertAudit(action: AuditAction, pollId: string, result: "success" | "failure", details: Record<string, unknown>, atIso: string) {
    db.prepare("INSERT INTO audit_events (id, action, poll_id, result, at, details_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), action, pollId, result, atIso, JSON.stringify(details));
  }
  /** Persist an audit event for an authorized request whose change did not commit (validation/business failure). */
  function recordAudit(action: AuditAction, pollId: string, result: "failure", details: Record<string, unknown>, now = Date.now()) {
    insertAudit(action, pollId, result, details, new Date(now).toISOString());
  }
  function members(): string[] {
    return (db.prepare("SELECT commitment FROM members ORDER BY position").all() as { commitment: string }[]).map(row => row.commitment);
  }
  function pollRow(id: string): PollRow | undefined {
    return db.prepare("SELECT * FROM polls WHERE id = ?").get(id) as PollRow | undefined;
  }
  /**
   * Lazily persists the deadline transition for every open poll whose
   * closesAt has passed. Each status change and its audit row commit in one
   * transaction; a no-op read starts no write transaction. commitVote repeats
   * this check inside its own transaction, which is the authoritative
   * adjudication for a vote racing the cutoff.
   */
  function closeExpired(now = Date.now()) {
    const open = db.prepare("SELECT id, closes_at FROM polls WHERE status = 'open'").all() as { id: string; closes_at: string }[];
    const due = open.filter(row => now >= Date.parse(row.closes_at)).map(row => row.id);
    if (due.length === 0) return;
    db.exec("BEGIN IMMEDIATE");
    try {
      const at = new Date(now).toISOString();
      for (const pollId of due) {
        const result = db.prepare("UPDATE polls SET status = 'closed' WHERE id = ? AND status = 'open'").run(pollId);
        if (result.changes > 0) insertAudit("poll_status_change", pollId, "success", { from: "open", to: "closed", reason: "deadline" }, at);
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function currentSnapshot(pollId: string): GroupSnapshot | undefined {
    const row = db.prepare(`
      SELECT gv.* FROM polls p
      JOIN group_versions gv ON gv.poll_id = p.id AND gv.version = p.group_version
      WHERE p.id = ?
    `).get(pollId) as GroupVersionRow | undefined;
    return row ? toSnapshot(row) : undefined;
  }
  function summarize(row: PollRow): PollSummary {
    return {
      id: row.id, title: row.title, summary: row.summary, organizer: row.organizer,
      status: row.status, publishedAt: row.published_at, closesAt: row.closes_at,
      memberCount: currentSnapshot(row.id)?.commitments.length ?? 0, optionCount: JSON.parse(row.options_json).length
    };
  }
  return {
    /** Public catalog hides drafts; an authorized manager can list them too. */
    list(now = Date.now(), includeDrafts = false): PollSummary[] {
      closeExpired(now);
      const rows = db.prepare(includeDrafts ? "SELECT * FROM polls ORDER BY published_at DESC, id" : "SELECT * FROM polls WHERE status != 'draft' ORDER BY published_at DESC, id").all() as unknown as PollRow[];
      return rows.map(summarize);
    },
    get(id: string, now = Date.now()): PollDetail | undefined {
      closeExpired(now);
      const row = pollRow(id);
      if (!row) return undefined;
      const snapshot = currentSnapshot(id);
      if (!snapshot) return undefined;
      return {
        ...summarize(row), description: row.description, options: JSON.parse(row.options_json),
        eligibleMemberCommitments: snapshot.commitments, groupVersion: snapshot.version, merkleRoot: snapshot.merkleRoot
      };
    },
    /**
     * Creates a poll in draft with its immutable version-1 member snapshot.
     * The insert, the snapshot and the success audit row commit together; a
     * conflicting id aborts everything (the caller audits that failure).
     */
    createPoll(input: NewPollInput, now = Date.now()): CreatePollOutcome {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (pollRow(input.id)) { db.exec("ROLLBACK"); return { ok: false, reason: "poll_exists" }; }
        const at = new Date(now).toISOString();
        db.prepare(`
          INSERT INTO polls (id, title, summary, description, organizer, status, published_at, closes_at, options_json, group_version, frozen_version)
          VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, 1, NULL)
        `).run(input.id, input.title, input.summary, input.description, input.organizer, input.publishedAt, input.closesAt, JSON.stringify(input.options));
        const merkleRoot = merkleRootOf(input.commitments);
        db.prepare("INSERT INTO group_versions (poll_id, version, commitments_json, merkle_root, created_at) VALUES (?, 1, ?, ?, ?)")
          .run(input.id, JSON.stringify(input.commitments), merkleRoot, at);
        insertAudit("poll_create", input.id, "success", { optionCount: input.options.length, memberCount: input.commitments.length }, at);
        db.exec("COMMIT");
        const poll = this.get(input.id);
        if (!poll) throw new Error("Created poll could not be read back");
        return { ok: true, poll };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    /**
     * Applies a lifecycle transition draft→open→closed→archived with an
     * optimistic expectedStatus guard. The status update and its audit row
     * commit atomically; conflicts and illegal edges leave a failure event.
     */
    transitionStatus(pollId: string, target: PollStatus, expectedStatus: PollStatus, now = Date.now()): StatusTransitionOutcome {
      db.exec("BEGIN IMMEDIATE");
      // Every authorized attempt leaves an event; failures commit only the audit row.
      const reject = (reason: Exclude<StatusTransitionOutcome, { ok: true }>["reason"], actual?: PollStatus): StatusTransitionOutcome => {
        db.exec("ROLLBACK");
        recordAudit(
          "status_change_rejected", pollId, "failure",
          { requested: target, expected: expectedStatus, reason, ...(actual ? { actual } : {}) },
          now
        );
        return { ok: false, reason };
      };
      try {
        const row = pollRow(pollId);
        if (!row) return reject("poll_missing");
        if (!STATUSES.includes(target) || !STATUSES.includes(expectedStatus)) return reject("invalid_status", row.status);
        if (row.status !== expectedStatus) return reject("status_conflict", row.status);
        if (STATUS_FLOW[row.status] !== target) return reject("illegal_transition", row.status);
        const at = new Date(now).toISOString();
        db.prepare("UPDATE polls SET status = ? WHERE id = ?").run(target, pollId);
        insertAudit("poll_status_change", pollId, "success", { from: row.status, to: target }, at);
        db.exec("COMMIT");
        return { ok: true, status: target };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    /** Record an authorized management request that failed before changing data (malformed payload, etc.). */
    auditFailure(action: AuditAction, pollId: string, details: Record<string, unknown>, now = Date.now()): void {
      recordAudit(action, pollId, "failure", details, now);
    },
    /** The immutable snapshot a poll currently points at, or a specific historical version. */
    groupSnapshot(pollId: string, version?: number): GroupSnapshot | undefined {
      if (version === undefined) return currentSnapshot(pollId);
      const row = db.prepare("SELECT * FROM group_versions WHERE poll_id = ? AND version = ?").get(pollId, version) as GroupVersionRow | undefined;
      return row ? toSnapshot(row) : undefined;
    },
    /** The snapshot whose Merkle root matches, used to place proofs from clients that omit groupVersion. */
    groupSnapshotByRoot(pollId: string, merkleRoot: string): GroupSnapshot | undefined {
      const row = db.prepare("SELECT * FROM group_versions WHERE poll_id = ? AND merkle_root = ? ORDER BY version DESC LIMIT 1").get(pollId, merkleRoot) as GroupVersionRow | undefined;
      return row ? toSnapshot(row) : undefined;
    },
    /**
     * Applies a membership change as a new immutable version. Membership may
     * only be edited while the poll is a draft, or while open with no votes
     * yet (the first vote freezes the version). The optimistic
     * expectedVersion check, the status/frozen checks and the pointer update
     * happen in one immediate transaction, so a concurrent vote either freezes
     * the group first (this then fails with group_frozen) or observes the new
     * version. Successful changes and rejected attempts are both audited.
     */
    applyGroupOperation(pollId: string, operation: GroupOperation, expectedVersion: number, now = Date.now()): GroupOperationOutcome {
      db.exec("BEGIN IMMEDIATE");
      // Business failures roll the (never-applied) change back but still leave
      // a failure audit event, committed on its own after the rollback.
      const reject = (reason: Exclude<GroupOperationOutcome, { ok: true }>["reason"], status?: PollStatus): GroupOperationOutcome => {
        db.exec("ROLLBACK");
        recordAudit(
          "group_change_rejected", pollId, "failure",
          { operation: operation.type, expectedVersion, reason, ...(status ? { status } : {}) },
          now
        );
        return { ok: false, reason };
      };
      try {
        const row = pollRow(pollId);
        if (!row) return reject("poll_missing");
        // An open poll past its deadline is semantically closed: persist the
        // deadline transition (with the rejected-edit event) and refuse it.
        if (row.status === "open" && now >= Date.parse(row.closes_at)) {
          const at = new Date(now).toISOString();
          db.prepare("UPDATE polls SET status = 'closed' WHERE id = ?").run(pollId);
          insertAudit("poll_status_change", pollId, "success", { from: "open", to: "closed", reason: "deadline" }, at);
          insertAudit("group_change_rejected", pollId, "failure", { operation: operation.type, expectedVersion, reason: "poll_not_editable", status: "closed", deadline: true }, at);
          db.exec("COMMIT");
          return { ok: false, reason: "poll_not_editable" };
        }
        const editable = row.status === "draft" || (row.status === "open" && row.frozen_version === null);
        if (!editable) return reject(row.status === "open" ? "group_frozen" : "poll_not_editable", row.status);
        if (row.group_version !== expectedVersion) return reject("group_version_changed", row.status);
        const snapshot = currentSnapshot(pollId);
        if (!snapshot) return reject("poll_missing");
        const commitments = [...snapshot.commitments];
        if (operation.type === "join") {
          if (commitments.includes(operation.commitment)) return reject("duplicate_commitment", row.status);
          commitments.push(operation.commitment);
        } else if (operation.type === "rotate") {
          const index = commitments.indexOf(operation.oldCommitment);
          if (index === -1) return reject("commitment_not_found", row.status);
          if (commitments.includes(operation.newCommitment)) return reject("duplicate_commitment", row.status);
          commitments[index] = operation.newCommitment;
        } else {
          const index = commitments.indexOf(operation.commitment);
          if (index === -1) return reject("commitment_not_found", row.status);
          if (commitments.length === 1) return reject("empty_group", row.status);
          commitments.splice(index, 1);
        }
        const version = expectedVersion + 1;
        const merkleRoot = merkleRootOf(commitments);
        const at = new Date(now).toISOString();
        db.prepare("INSERT INTO group_versions (poll_id, version, commitments_json, merkle_root, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(pollId, version, JSON.stringify(commitments), merkleRoot, at);
        db.prepare("UPDATE polls SET group_version = ? WHERE id = ?").run(version, pollId);
        insertAudit("group_change", pollId, "success", { operation: operation.type, expectedVersion, version, memberCount: commitments.length }, at);
        db.exec("COMMIT");
        return { ok: true, group: { pollId, version, merkleRoot, memberCount: commitments.length, commitments } };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    /**
     * Re-validates the poll state, confirms the group version is still current,
     * freezes that version on the first accepted vote, rejects a reused
     * nullifier and persists the vote in a single immediate transaction; the
     * UNIQUE (poll_id, nullifier) index is the backstop against concurrent
     * duplicates and deduplicates across versions. When the deadline has
     * passed the poll is persisted as closed in that same transaction, so a
     * vote racing the cutoff is adjudicated by the transaction and rejected.
     */
    commitVote(pollId: string, optionId: string, nullifier: string, groupVersion: number, now = Date.now()): CommitVoteOutcome {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = pollRow(pollId);
        if (!row) { db.exec("ROLLBACK"); return { ok: false, reason: "poll_closed" }; }
        if (row.status !== "open") { db.exec("ROLLBACK"); return { ok: false, reason: "poll_closed" }; }
        if (now >= Date.parse(row.closes_at)) {
          // Atomic deadline transition: persist closed and refuse the out-of-window vote.
          const at = new Date(now).toISOString();
          db.prepare("UPDATE polls SET status = 'closed' WHERE id = ?").run(pollId);
          insertAudit("poll_status_change", pollId, "success", { from: "open", to: "closed", reason: "deadline" }, at);
          db.exec("COMMIT");
          return { ok: false, reason: "poll_closed" };
        }
        if (row.group_version !== groupVersion) { db.exec("ROLLBACK"); return { ok: false, reason: "group_version_changed" }; }
        const options = JSON.parse(row.options_json) as { id: string }[];
        if (!options.some(option => option.id === optionId)) { db.exec("ROLLBACK"); return { ok: false, reason: "invalid_option" }; }
        const duplicate = db.prepare("SELECT 1 AS found FROM votes WHERE poll_id = ? AND nullifier = ?").get(pollId, nullifier);
        if (duplicate) { db.exec("ROLLBACK"); return { ok: false, reason: "duplicate_nullifier" }; }
        const receipt: VoteReceipt = { id: randomUUID(), pollId, optionId, nullifier, acceptedAt: new Date(now).toISOString() };
        db.prepare("INSERT INTO votes (id, poll_id, option_id, nullifier, accepted_at) VALUES (?, ?, ?, ?, ?)")
          .run(receipt.id, receipt.pollId, receipt.optionId, receipt.nullifier, receipt.acceptedAt);
        if (row.frozen_version === null) db.prepare("UPDATE polls SET frozen_version = ? WHERE id = ?").run(groupVersion, pollId);
        db.exec("COMMIT");
        return { ok: true, receipt };
      } catch (error) {
        db.exec("ROLLBACK");
        if (error instanceof Error && error.message.includes("UNIQUE")) return { ok: false, reason: "duplicate_nullifier" };
        throw error;
      }
    },
    /** Results stay public for open/closed/archived polls; drafts have none. */
    results(pollId: string, now = Date.now()): PollResults | undefined {
      closeExpired(now);
      const row = pollRow(pollId);
      if (!row || row.status === "draft") return undefined;
      const counts = new Map(
        (db.prepare("SELECT option_id, count(*) AS count FROM votes WHERE poll_id = ? GROUP BY option_id").all(pollId) as { option_id: string; count: number }[])
          .map(entry => [entry.option_id, entry.count])
      );
      const options = (JSON.parse(row.options_json) as { id: string }[]).map(option => ({ id: option.id, count: counts.get(option.id) ?? 0 }));
      return { pollId, total: options.reduce((sum, option) => sum + option.count, 0), options };
    },
    receipt(id: string): VoteReceipt | undefined {
      const row = db.prepare("SELECT * FROM votes WHERE id = ?").get(id) as VoteRow | undefined;
      return row ? toReceipt(row) : undefined;
    },
    /** Audit trail, newest first; persisted in SQLite so it survives restarts. */
    auditEvents(limit = 200): AuditEvent[] {
      const rows = db.prepare("SELECT * FROM audit_events ORDER BY at DESC, id DESC LIMIT ?").all(limit) as unknown as AuditRow[];
      return rows.map(toAuditEvent);
    },
    close() { db.close(); }
  };
}
