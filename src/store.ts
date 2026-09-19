import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Group } from "@semaphore-protocol/group";
import type { AuditAction, AuditEvent, GroupVersionSummary, PollDetail, PollResults, PollStatus, PollSummary, VoteReceipt } from "./types.ts";

interface SeedPoll extends Omit<PollDetail, "memberCount" | "optionCount" | "eligibleMemberCommitments" | "groupVersion" | "merkleRoot" | "status"> {
  status?: PollStatus;
}
interface CatalogSeed { polls: SeedPoll[]; memberCommitments: string[] }
interface PollRow {
  id: string; title: string; summary: string; description: string;
  organizer: string; status: PollStatus; published_at: string; closes_at: string;
  options_json: string; group_version: number; frozen_version: number | null;
}
interface GroupVersionRow { poll_id: string; version: number; commitments_json: string; merkle_root: string; created_at: string }
interface VoteRow { id: string; poll_id: string; option_id: string; nullifier: string; accepted_at: string }
interface AuditRow { id: string; at: string; action: string; poll_id: string | null; result: string; detail_json: string }

export interface DraftInput {
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
export interface GroupSnapshot { version: number; commitments: string[]; merkleRoot: string }
export type GroupOperation =
  | { type: "join"; commitment: string }
  | { type: "rotate"; oldCommitment: string; newCommitment: string }
  | { type: "revoke"; commitment: string };
export type GroupOperationOutcome =
  | { ok: true; group: GroupVersionSummary }
  | { ok: false; reason: "poll_missing" | "group_frozen" | "group_version_changed" | "duplicate_commitment" | "commitment_not_found" | "empty_group" | "poll_not_editable" };
export type CreateDraftOutcome =
  | { ok: true; poll: PollDetail }
  | { ok: false; reason: "poll_exists" };
export type ChangeStatusOutcome =
  | { ok: true; poll: PollDetail }
  | { ok: false; reason: "poll_missing" | "illegal_transition" | "status_conflict" };
export type CommitVoteOutcome =
  | { ok: true; receipt: VoteReceipt }
  | { ok: false; reason: "poll_closed" | "invalid_option" | "duplicate_nullifier" | "group_version_changed" };

const STATUS_TRANSITIONS: Record<PollStatus, PollStatus[]> = {
  draft: ["open"],
  open: ["closed"],
  closed: ["archived"],
  archived: []
};

function toReceipt(row: VoteRow): VoteReceipt {
  return { id: row.id, pollId: row.poll_id, optionId: row.option_id, nullifier: row.nullifier, acceptedAt: row.accepted_at };
}
function toSnapshot(row: GroupVersionRow): GroupSnapshot {
  return { version: row.version, commitments: JSON.parse(row.commitments_json) as string[], merkleRoot: row.merkle_root };
}
function toAuditEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id, at: row.at, action: row.action as AuditAction, pollId: row.poll_id,
    result: row.result as AuditEvent["result"], detail: JSON.parse(row.detail_json) as Record<string, unknown>
  };
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
      at TEXT NOT NULL,
      action TEXT NOT NULL,
      poll_id TEXT,
      result TEXT NOT NULL,
      detail_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_events_at ON audit_events (at, id);
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
      // Legacy polls are born into the lifecycle as open issues.
      const insertPoll = db.prepare("INSERT INTO polls (id, title, summary, description, organizer, status, published_at, closes_at, options_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const poll of seed.polls) insertPoll.run(poll.id, poll.title, poll.summary, poll.description, poll.organizer, poll.status ?? "open", poll.publishedAt, poll.closesAt, JSON.stringify(poll.options));
      const insertMember = db.prepare("INSERT INTO members VALUES (?, ?)");
      seed.memberCommitments.forEach((commitment, index) => insertMember.run(commitment, index));
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); db.close(); throw error; }
  } else {
    // Old databases (and any row carrying an unrecognized status) migrate
    // straight into the lifecycle as open issues.
    db.exec(`UPDATE polls SET status = 'open' WHERE status NOT IN ('draft', 'open', 'closed', 'archived')`);
  }
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
  // Persist deadline-driven closes that elapsed while the service was down:
  // every expired open poll becomes closed, each with an audit event, in one
  // transaction. Votes and status attempts perform the same adjudication
  // atomically while the service is running.
  {
    const openPolls = db.prepare("SELECT id, closes_at FROM polls WHERE status = 'open'").all() as { id: string; closes_at: string }[];
    const expired = openPolls.filter(poll => Date.now() >= Date.parse(poll.closes_at));
    if (expired.length > 0) {
      const close = db.prepare("UPDATE polls SET status = 'closed' WHERE id = ? AND status = 'open'");
      const insertAudit = db.prepare("INSERT INTO audit_events (id, at, action, poll_id, result, detail_json) VALUES (?, ?, 'status_changed', ?, 'success', ?)");
      db.exec("BEGIN");
      try {
        for (const poll of expired) {
          close.run(poll.id);
          insertAudit.run(randomUUID(), new Date().toISOString(), poll.id, JSON.stringify({ from: "open", to: "closed", reason: "deadline_persisted" }));
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); db.close(); throw error; }
    }
  }

  function members(): string[] {
    return (db.prepare("SELECT commitment FROM members ORDER BY position").all() as { commitment: string }[]).map(row => row.commitment);
  }
  function pollRow(id: string): PollRow | undefined {
    return db.prepare("SELECT * FROM polls WHERE id = ?").get(id) as PollRow | undefined;
  }
  /** Whether the poll accepts votes right now; the deadline is compared against the same clock as the caller. */
  function isOpen(row: PollRow, now: number): boolean {
    return row.status === "open" && now < Date.parse(row.closes_at);
  }
  /** Persists the deadline-driven close without a transition check (closing is always legal for an open poll). */
  function persistDeadlineClose(row: PollRow) {
    db.prepare("UPDATE polls SET status = 'closed' WHERE id = ? AND status = 'open'").run(row.id);
    row.status = "closed";
    recordAudit("status_changed", row.id, "success", { from: "open", to: "closed", reason: "deadline_persisted" });
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
  function detailOf(row: PollRow): PollDetail | undefined {
    const snapshot = currentSnapshot(row.id);
    if (!snapshot) return undefined;
    return {
      ...summarize(row), description: row.description, options: JSON.parse(row.options_json),
      eligibleMemberCommitments: snapshot.commitments, groupVersion: snapshot.version, merkleRoot: snapshot.merkleRoot
    };
  }
  function adminDetail(id: string): PollDetail | undefined {
    const row = pollRow(id);
    return row ? detailOf(row) : undefined;
  }
  /**
   * Inserts an audit event. Runs inside the caller's transaction so a
   * successful business change and its event commit atomically; failed
   * business attempts inside a rolled-back transaction are instead committed
   * by their own immediate transaction (see withAuditedFailure), so business
   * failures still leave an event without persisting any partial write.
   * Never receives tokens, identity secrets or proofs — callers pass only
   * non-sensitive action details.
   */
  function recordAudit(action: AuditAction, pollId: string | null, result: AuditEvent["result"], detail: Record<string, unknown>): AuditEvent {
    const event: AuditEvent = { id: randomUUID(), at: new Date().toISOString(), action, pollId, result, detail };
    db.prepare("INSERT INTO audit_events (id, at, action, poll_id, result, detail_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(event.id, event.at, event.action, event.pollId, event.result, JSON.stringify(event.detail));
    return event;
  }
  /** Runs a failing business attempt: rolls its writes back, then commits only the audit event. */
  function withAuditedFailure<T>(rollback: () => T, action: AuditAction, pollId: string | null, detail: Record<string, unknown>): T {
    db.exec("ROLLBACK");
    auditStandalone(action, pollId, "failure", detail);
    return rollback();
  }
  /** Commits one audit event in its own transaction, independent of any rolled-back business write. */
  function auditStandalone(action: AuditAction, pollId: string | null, result: AuditEvent["result"], detail: Record<string, unknown>): AuditEvent {
    db.exec("BEGIN IMMEDIATE");
    try {
      const event = recordAudit(action, pollId, result, detail);
      db.exec("COMMIT");
      return event;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  /**
   * Atomically persists the deadline close for every expired open poll (each
   * with an audit event). Called before public reads and on boot, so an issue
   * is never reported as open once its closesAt has passed, even with no vote
   * or status request arriving exactly at the deadline.
   */
  function sweepExpired(now = Date.now()): void {
    const openPolls = db.prepare("SELECT id, closes_at FROM polls WHERE status = 'open'").all() as { id: string; closes_at: string }[];
    const expired = openPolls.filter(poll => now >= Date.parse(poll.closes_at));
    if (expired.length === 0) return;
    const close = db.prepare("UPDATE polls SET status = 'closed' WHERE id = ? AND status = 'open'");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const poll of expired) {
        close.run(poll.id);
        recordAudit("status_changed", poll.id, "success", { from: "open", to: "closed", reason: "deadline_persisted" });
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  /** Atomically closes one poll if its deadline passed; returns true when its status changed. */
  function persistExpired(pollId: string, now = Date.now()): boolean {
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = pollRow(pollId);
      if (row && row.status === "open" && now >= Date.parse(row.closes_at)) {
        persistDeadlineClose(row);
        db.exec("COMMIT");
        return true;
      }
      db.exec("ROLLBACK");
      return false;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  return {
    sweepExpired,
    persistExpired,
    /** Public catalog: drafts are invisible until an admin opens them. */
    list(): PollSummary[] {
      sweepExpired();
      return (db.prepare("SELECT * FROM polls WHERE status != 'draft' ORDER BY published_at DESC, id").all() as unknown as PollRow[]).map(summarize);
    },
    /** Admin catalog: includes drafts, newest first. */
    listAll(): PollSummary[] {
      sweepExpired();
      return (db.prepare("SELECT * FROM polls ORDER BY published_at DESC, id").all() as unknown as PollRow[]).map(summarize);
    },
    /** Public detail: drafts are not exposed to ordinary queries. */
    get(id: string): PollDetail | undefined {
      const row = pollRow(id);
      if (!row || row.status === "draft") return undefined;
      if (row.status === "open" && Date.now() >= Date.parse(row.closes_at)) persistExpired(id);
      return detailOf(pollRow(id)!);
    },
    /** Admin-only view of a draft (or any poll). */
    getForAdmin(id: string): PollDetail | undefined {
      persistExpired(id);
      return adminDetail(id);
    },
    /**
     * Creates a draft issue and its version-1 member snapshot together with
     * the success audit event in one transaction. Drafts inherit the shared
     * member registry and never appear in the public catalog.
     */
    createDraft(input: DraftInput): CreateDraftOutcome {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (pollRow(input.id)) {
          return withAuditedFailure(() => ({ ok: false, reason: "poll_exists" }), "poll_created", input.id, {
            reason: "poll_exists", title: input.title
          });
        }
        db.prepare(`
          INSERT INTO polls (id, title, summary, description, organizer, status, published_at, closes_at, options_json, group_version)
          VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, 1)
        `).run(input.id, input.title, input.summary, input.description, input.organizer, input.publishedAt, input.closesAt, JSON.stringify(input.options));
        const commitments = [...input.commitments];
        const createdAt = new Date().toISOString();
        db.prepare("INSERT INTO group_versions (poll_id, version, commitments_json, merkle_root, created_at) VALUES (?, 1, ?, ?, ?)")
          .run(input.id, JSON.stringify(commitments), merkleRootOf(commitments), createdAt);
        recordAudit("poll_created", input.id, "success", {
          title: input.title, organizer: input.organizer,
          optionIds: input.options.map(option => option.id), memberCount: commitments.length,
          publishedAt: input.publishedAt, closesAt: input.closesAt
        });
        db.exec("COMMIT");
        const poll = adminDetail(input.id)!;
        return { ok: true, poll };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    /**
     * Applies a lifecycle transition with optimistic concurrency control. The
     * expectedStatus check, the transition validation and the update are one
     * immediate transaction: a concurrent transition wins exactly one side
     * with status_conflict, an illegal target status is illegal_transition.
     * Open polls past closesAt are persisted as closed first, so opening
     * another transition or a vote against a stale deadline is adjudicated on
     * the durable status.
     */
    changeStatus(pollId: string, target: PollStatus, expected: PollStatus | undefined, now = Date.now()): ChangeStatusOutcome {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = pollRow(pollId);
        if (!row) {
          db.exec("ROLLBACK");
          auditStandalone("status_changed", pollId, "failure", { to: target, expectedStatus: expected ?? null, reason: "poll_missing" });
          return { ok: false, reason: "poll_missing" };
        }
        let deadlineClosed = false;
        if (row.status === "open" && now >= Date.parse(row.closes_at) && target !== "closed") {
          persistDeadlineClose(row);
          deadlineClosed = true;
        }
        const fail = (reason: Extract<ChangeStatusOutcome, { ok: false }>["reason"], detail: Record<string, unknown>): ChangeStatusOutcome => {
          if (deadlineClosed) {
            // The deadline close must survive: commit it, then commit the
            // rejected attempt's audit event on its own.
            recordAudit("status_changed", pollId, "failure", detail);
            db.exec("COMMIT");
          } else {
            withAuditedFailure(() => undefined, "status_changed", pollId, detail);
          }
          return { ok: false, reason };
        };
        if (expected !== undefined && row.status !== expected) {
          return fail("status_conflict", { from: row.status, to: target, expectedStatus: expected, reason: "status_conflict" });
        }
        if (row.status === target) {
          return fail("status_conflict", { from: row.status, to: target, reason: "already_in_status" });
        }
        if (!STATUS_TRANSITIONS[row.status].includes(target)) {
          return fail("illegal_transition", { from: row.status, to: target, reason: "illegal_transition" });
        }
        const from = row.status;
        db.prepare("UPDATE polls SET status = ? WHERE id = ?").run(target, pollId);
        recordAudit("status_changed", pollId, "success", { from, to: target, expectedStatus: expected ?? null });
        db.exec("COMMIT");
        return { ok: true, poll: adminDetail(pollId)! };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
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
     * Applies a membership change as a new immutable version. Members may
     * only be changed while the issue is a draft, or while it is open with no
     * accepted vote yet: the first vote freezes the group for good. The
     * optimistic expectedVersion check and the pointer update happen in one
     * immediate transaction, so a concurrent vote either freezes the group
     * first (this then fails with group_frozen) or observes the new version.
     */
    applyGroupOperation(pollId: string, operation: GroupOperation, expectedVersion: number): GroupOperationOutcome {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = pollRow(pollId);
        if (!row) {
          db.exec("ROLLBACK");
          auditStandalone("members_changed", pollId, "failure", { operation: operation.type, expectedVersion, reason: "poll_missing" });
          return { ok: false, reason: "poll_missing" };
        }
        const fail = (reason: Extract<GroupOperationOutcome, { ok: false }>["reason"], extra: Record<string, unknown> = {}): GroupOperationOutcome =>
          withAuditedFailure<GroupOperationOutcome>(() => ({ ok: false, reason }), "members_changed", pollId, { operation: operation.type, expectedVersion, reason, ...extra });
        if (row.status !== "draft" && row.status !== "open") return fail("poll_not_editable", { status: row.status });
        if (row.frozen_version !== null) return fail("group_frozen");
        if (row.group_version !== expectedVersion) return fail("group_version_changed");
        const snapshot = currentSnapshot(pollId);
        if (!snapshot) {
          db.exec("ROLLBACK");
          auditStandalone("members_changed", pollId, "failure", { operation: operation.type, expectedVersion, reason: "poll_missing" });
          return { ok: false, reason: "poll_missing" };
        }
        const commitments = [...snapshot.commitments];
        if (operation.type === "join") {
          if (commitments.includes(operation.commitment)) return fail("duplicate_commitment");
          commitments.push(operation.commitment);
        } else if (operation.type === "rotate") {
          const index = commitments.indexOf(operation.oldCommitment);
          if (index === -1) return fail("commitment_not_found");
          if (commitments.includes(operation.newCommitment)) return fail("duplicate_commitment");
          commitments[index] = operation.newCommitment;
        } else {
          const index = commitments.indexOf(operation.commitment);
          if (index === -1) return fail("commitment_not_found");
          if (commitments.length === 1) return fail("empty_group");
          commitments.splice(index, 1);
        }
        const version = expectedVersion + 1;
        const merkleRoot = merkleRootOf(commitments);
        db.prepare("INSERT INTO group_versions (poll_id, version, commitments_json, merkle_root, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(pollId, version, JSON.stringify(commitments), merkleRoot, new Date().toISOString());
        db.prepare("UPDATE polls SET group_version = ? WHERE id = ?").run(version, pollId);
        recordAudit("members_changed", pollId, "success", {
          operation: operation.type,
          commitment: operation.type === "join" || operation.type === "revoke" ? operation.commitment : undefined,
          oldCommitment: operation.type === "rotate" ? operation.oldCommitment : undefined,
          newCommitment: operation.type === "rotate" ? operation.newCommitment : undefined,
          fromVersion: expectedVersion, version, memberCount: commitments.length
        });
        db.exec("COMMIT");
        return { ok: true, group: { pollId, version, merkleRoot, memberCount: commitments.length, commitments } };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    /**
     * Re-validates the poll state inside one immediate transaction: an open
     * poll past closesAt is atomically persisted as closed before the vote is
     * judged, so an out-of-bounds vote is rejected against durable state. The
     * transaction also confirms the group version is still current, freezes
     * that version on the first accepted vote, rejects a reused nullifier and
     * persists the vote; the UNIQUE (poll_id, nullifier) index is the
     * backstop against concurrent duplicates and deduplicates across
     * versions. Accepted votes and rejected business attempts are both
     * audited; neither event ever records the proof or the nullifier.
     */
    commitVote(pollId: string, optionId: string, nullifier: string, groupVersion: number, now = Date.now()): CommitVoteOutcome {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = pollRow(pollId);
        if (!row) {
          db.exec("ROLLBACK");
          auditStandalone("vote_rejected", pollId, "failure", { optionId, reason: "poll_missing" });
          return { ok: false, reason: "poll_closed" };
        }
        let deadlineClosed = false;
        if (row.status === "open" && now >= Date.parse(row.closes_at)) {
          persistDeadlineClose(row);
          deadlineClosed = true;
        }
        const reject = (reason: Extract<CommitVoteOutcome, { ok: false }>["reason"], detail: Record<string, unknown>): CommitVoteOutcome => {
          if (deadlineClosed) {
            // Keep the atomic deadline close; attach the rejection event to that commit.
            recordAudit("vote_rejected", pollId, "failure", detail);
            db.exec("COMMIT");
          } else {
            withAuditedFailure(() => undefined, "vote_rejected", pollId, detail);
          }
          return { ok: false, reason };
        };
        if (!isOpen(row, now)) {
          return reject("poll_closed", { optionId, reason: "poll_closed", status: row.status });
        }
        if (row.group_version !== groupVersion) {
          return reject("group_version_changed", {
            optionId, reason: "group_version_changed", groupVersion, currentVersion: row.group_version
          });
        }
        const options = JSON.parse(row.options_json) as { id: string }[];
        if (!options.some(option => option.id === optionId)) {
          return reject("invalid_option", { reason: "invalid_option" });
        }
        const duplicate = db.prepare("SELECT 1 AS found FROM votes WHERE poll_id = ? AND nullifier = ?").get(pollId, nullifier);
        if (duplicate) {
          return reject("duplicate_nullifier", { optionId, reason: "duplicate_nullifier" });
        }
        const receipt: VoteReceipt = { id: randomUUID(), pollId, optionId, nullifier, acceptedAt: new Date(now).toISOString() };
        db.prepare("INSERT INTO votes (id, poll_id, option_id, nullifier, accepted_at) VALUES (?, ?, ?, ?, ?)")
          .run(receipt.id, receipt.pollId, receipt.optionId, receipt.nullifier, receipt.acceptedAt);
        if (row.frozen_version === null) db.prepare("UPDATE polls SET frozen_version = ? WHERE id = ?").run(groupVersion, pollId);
        recordAudit("vote_accepted", pollId, "success", {
          optionId, receiptId: receipt.id, groupVersion, frozen: row.frozen_version === null
        });
        db.exec("COMMIT");
        return { ok: true, receipt };
      } catch (error) {
        db.exec("ROLLBACK");
        if (error instanceof Error && error.message.includes("UNIQUE")) {
          // Index backstop against a concurrent duplicate that raced the SELECT.
          db.exec("BEGIN IMMEDIATE");
          try {
            recordAudit("vote_rejected", pollId, "failure", { optionId, reason: "duplicate_nullifier" });
            db.exec("COMMIT");
          } catch (auditError) { db.exec("ROLLBACK"); throw auditError; }
          return { ok: false, reason: "duplicate_nullifier" };
        }
        throw error;
      }
    },
    /** Results stay public for closed and archived issues; drafts remain hidden. */
    results(pollId: string): PollResults | undefined {
      const initial = pollRow(pollId);
      if (!initial || initial.status === "draft") return undefined;
      if (initial.status === "open" && Date.now() >= Date.parse(initial.closes_at)) persistExpired(pollId);
      const row = pollRow(pollId)!;
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
    /** Audit trail, newest first. Persisted in audit_events so it survives restarts. */
    audit(limit = 100): AuditEvent[] {
      const count = Math.min(Math.max(limit, 1), 500);
      return (db.prepare("SELECT * FROM audit_events ORDER BY at DESC, id DESC LIMIT ?").all(count) as unknown as AuditRow[]).map(toAuditEvent);
    },
    /** Persists a single audit event in its own transaction (used for authorized attempts rejected at the API layer). */
    recordAuditEvent(action: AuditAction, pollId: string | null, result: AuditEvent["result"], detail: Record<string, unknown>): AuditEvent {
      return auditStandalone(action, pollId, result, detail);
    },
    close() { db.close(); }
  };
}
