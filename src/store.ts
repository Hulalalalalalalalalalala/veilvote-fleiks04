import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Group } from "@semaphore-protocol/group";
import type { GroupVersionSummary, PollDetail, PollResults, PollSummary, VoteReceipt } from "./types.ts";

interface SeedPoll extends Omit<PollDetail, "memberCount" | "optionCount" | "eligibleMemberCommitments" | "groupVersion" | "merkleRoot"> {}
interface CatalogSeed { polls: SeedPoll[]; memberCommitments: string[] }
interface PollRow {
  id: string; title: string; summary: string; description: string;
  organizer: string; status: "open"; published_at: string; closes_at: string;
  options_json: string; group_version: number; frozen_version: number | null;
}
interface GroupVersionRow { poll_id: string; version: number; commitments_json: string; merkle_root: string; created_at: string }
interface VoteRow { id: string; poll_id: string; option_id: string; nullifier: string; accepted_at: string }

export interface GroupSnapshot { version: number; commitments: string[]; merkleRoot: string }
export type GroupOperation =
  | { type: "join"; commitment: string }
  | { type: "rotate"; oldCommitment: string; newCommitment: string }
  | { type: "revoke"; commitment: string };
export type GroupOperationOutcome =
  | { ok: true; group: GroupVersionSummary }
  | { ok: false; reason: "poll_missing" | "group_frozen" | "group_version_changed" | "duplicate_commitment" | "commitment_not_found" | "empty_group" };
export type CommitVoteOutcome =
  | { ok: true; receipt: VoteReceipt }
  | { ok: false; reason: "poll_closed" | "invalid_option" | "duplicate_nullifier" | "group_version_changed" };

function toReceipt(row: VoteRow): VoteReceipt {
  return { id: row.id, pollId: row.poll_id, optionId: row.option_id, nullifier: row.nullifier, acceptedAt: row.accepted_at };
}
function toSnapshot(row: GroupVersionRow): GroupSnapshot {
  return { version: row.version, commitments: JSON.parse(row.commitments_json) as string[], merkleRoot: row.merkle_root };
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

  function members(): string[] {
    return (db.prepare("SELECT commitment FROM members ORDER BY position").all() as { commitment: string }[]).map(row => row.commitment);
  }
  function pollRow(id: string): PollRow | undefined {
    return db.prepare("SELECT * FROM polls WHERE id = ?").get(id) as PollRow | undefined;
  }
  function isOpen(row: PollRow, now: number): boolean {
    return row.status === "open" && now < Date.parse(row.closes_at);
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
    list(): PollSummary[] {
      return (db.prepare("SELECT * FROM polls ORDER BY published_at DESC, id").all() as unknown as PollRow[]).map(summarize);
    },
    get(id: string): PollDetail | undefined {
      const row = pollRow(id);
      if (!row) return undefined;
      const snapshot = currentSnapshot(id);
      if (!snapshot) return undefined;
      return {
        ...summarize(row), description: row.description, options: JSON.parse(row.options_json),
        eligibleMemberCommitments: snapshot.commitments, groupVersion: snapshot.version, merkleRoot: snapshot.merkleRoot
      };
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
     * Applies a membership change as a new immutable version. The optimistic
     * expectedVersion check, the frozen check and the pointer update happen in
     * one immediate transaction, so a concurrent vote either freezes the group
     * first (this then fails with group_frozen) or observes the new version.
     */
    applyGroupOperation(pollId: string, operation: GroupOperation, expectedVersion: number): GroupOperationOutcome {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = pollRow(pollId);
        if (!row) { db.exec("ROLLBACK"); return { ok: false, reason: "poll_missing" }; }
        if (row.frozen_version !== null) { db.exec("ROLLBACK"); return { ok: false, reason: "group_frozen" }; }
        if (row.group_version !== expectedVersion) { db.exec("ROLLBACK"); return { ok: false, reason: "group_version_changed" }; }
        const snapshot = currentSnapshot(pollId);
        if (!snapshot) { db.exec("ROLLBACK"); return { ok: false, reason: "poll_missing" }; }
        const commitments = [...snapshot.commitments];
        if (operation.type === "join") {
          if (commitments.includes(operation.commitment)) { db.exec("ROLLBACK"); return { ok: false, reason: "duplicate_commitment" }; }
          commitments.push(operation.commitment);
        } else if (operation.type === "rotate") {
          const index = commitments.indexOf(operation.oldCommitment);
          if (index === -1) { db.exec("ROLLBACK"); return { ok: false, reason: "commitment_not_found" }; }
          if (commitments.includes(operation.newCommitment)) { db.exec("ROLLBACK"); return { ok: false, reason: "duplicate_commitment" }; }
          commitments[index] = operation.newCommitment;
        } else {
          const index = commitments.indexOf(operation.commitment);
          if (index === -1) { db.exec("ROLLBACK"); return { ok: false, reason: "commitment_not_found" }; }
          if (commitments.length === 1) { db.exec("ROLLBACK"); return { ok: false, reason: "empty_group" }; }
          commitments.splice(index, 1);
        }
        const version = expectedVersion + 1;
        const merkleRoot = merkleRootOf(commitments);
        db.prepare("INSERT INTO group_versions (poll_id, version, commitments_json, merkle_root, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(pollId, version, JSON.stringify(commitments), merkleRoot, new Date().toISOString());
        db.prepare("UPDATE polls SET group_version = ? WHERE id = ?").run(version, pollId);
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
     * duplicates and deduplicates across versions.
     */
    commitVote(pollId: string, optionId: string, nullifier: string, groupVersion: number, now = Date.now()): CommitVoteOutcome {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = pollRow(pollId);
        if (!row || !isOpen(row, now)) { db.exec("ROLLBACK"); return { ok: false, reason: "poll_closed" }; }
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
    results(pollId: string): PollResults | undefined {
      const row = pollRow(pollId);
      if (!row) return undefined;
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
    close() { db.close(); }
  };
}
