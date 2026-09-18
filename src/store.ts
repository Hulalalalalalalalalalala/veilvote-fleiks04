import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Group } from "@semaphore-protocol/group";
import type { GroupVersionSummary, PollDetail, PollResults, PollSummary, VoteReceipt } from "./types.ts";

interface SeedPoll extends Omit<PollDetail, "memberCount" | "optionCount" | "eligibleMemberCommitments" | "groupVersion" | "merkleRoot" | "frozen"> {}
interface CatalogSeed { polls: SeedPoll[]; memberCommitments: string[] }
interface PollRow {
  id: string; title: string; summary: string; description: string;
  organizer: string; status: "open"; published_at: string; closes_at: string;
  options_json: string;
}
interface PollGroupRow { poll_id: string; current_version: number; merkle_root: string; frozen: number }
interface GroupVersionRow { poll_id: string; version: number; merkle_root: string; created_at: string }
interface VoteRow { id: string; poll_id: string; option_id: string; nullifier: string; group_version: number; accepted_at: string }

export type CommitVoteOutcome =
  | { ok: true; receipt: VoteReceipt }
  | { ok: false; reason: "poll_closed" | "invalid_option" | "duplicate_nullifier" | "unknown_root" | "historical_version" };

export type GroupChangeOutcome =
  | { ok: true; summary: GroupVersionSummary }
  | {
      ok: false;
      reason:
        | "poll_not_found"
        | "poll_closed"
        | "group_frozen"
        | "version_conflict"
        | "commitment_not_found"
        | "duplicate_commitment"
        | "empty_group";
    };

function toReceipt(row: VoteRow): VoteReceipt {
  return {
    id: row.id, pollId: row.poll_id, optionId: row.option_id,
    nullifier: row.nullifier, groupVersion: row.group_version, acceptedAt: row.accepted_at
  };
}

function merkleRoot(commitments: string[]): string {
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
    CREATE TABLE IF NOT EXISTS poll_groups (
      poll_id TEXT PRIMARY KEY REFERENCES polls (id),
      current_version INTEGER NOT NULL,
      merkle_root TEXT NOT NULL,
      frozen INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS group_versions (
      poll_id TEXT NOT NULL REFERENCES polls (id),
      version INTEGER NOT NULL,
      merkle_root TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (poll_id, version)
    );
    CREATE TABLE IF NOT EXISTS group_members (
      poll_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      position INTEGER NOT NULL,
      commitment TEXT NOT NULL,
      PRIMARY KEY (poll_id, version, position),
      UNIQUE (poll_id, version, commitment)
    );
    CREATE TABLE IF NOT EXISTS votes (
      id TEXT PRIMARY KEY,
      poll_id TEXT NOT NULL REFERENCES polls (id),
      option_id TEXT NOT NULL,
      nullifier TEXT NOT NULL,
      group_version INTEGER NOT NULL DEFAULT 1,
      accepted_at TEXT NOT NULL
    );
  `);
  // Migration: votes created by older builds lack the frozen snapshot version;
  // they were accepted against version 1, the only snapshot that existed.
  const voteColumns = new Set((db.prepare("PRAGMA table_info(votes)").all() as { name: string }[]).map(column => column.name));
  if (!voteColumns.has("group_version")) {
    db.exec("ALTER TABLE votes ADD COLUMN group_version INTEGER");
    db.exec("UPDATE votes SET group_version = 1 WHERE group_version IS NULL");
  }
  // Nullifier uniqueness is scoped to a poll and spans every group version.
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS votes_poll_nullifier ON votes (poll_id, nullifier)");

  // Every poll carries an append-only chain of immutable member snapshots.
  // First boot with the versioned schema:
  //  - fresh database: seed polls and their v1 snapshot together;
  //  - legacy database: copy the shared `members` table into each poll's v1
  //    snapshot, freeze polls that already hold votes, then drop the table.
  const snapshotCount = db.prepare("SELECT count(*) AS count FROM poll_groups").get() as { count: number };
  if (snapshotCount.count === 0) {
    const pollCount = db.prepare("SELECT count(*) AS count FROM polls").get() as { count: number };
    const hasLegacyMembers = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'members'").get() as { name: string } | undefined) !== undefined;
    let seed: CatalogSeed | undefined;
    if (pollCount.count === 0) {
      seed = JSON.parse(readFileSync(new URL("../fixtures/catalog.json", import.meta.url), "utf8")) as CatalogSeed;
    }
    const commitments = hasLegacyMembers
      ? (db.prepare("SELECT commitment FROM members ORDER BY position").all() as { commitment: string }[]).map(row => row.commitment)
      : (seed?.memberCommitments ?? []);
    const createdAt = new Date().toISOString();
    db.exec("BEGIN");
    try {
      const insertPoll = db.prepare("INSERT INTO polls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const poll of seed?.polls ?? []) {
        insertPoll.run(poll.id, poll.title, poll.summary, poll.description, poll.organizer, poll.status, poll.publishedAt, poll.closesAt, JSON.stringify(poll.options));
      }
      const root = merkleRoot(commitments);
      const insertGroup = db.prepare("INSERT INTO poll_groups (poll_id, current_version, merkle_root, frozen) VALUES (?, 1, ?, 0)");
      const insertVersion = db.prepare("INSERT INTO group_versions (poll_id, version, merkle_root, created_at) VALUES (?, 1, ?, ?)");
      const insertMember = db.prepare("INSERT INTO group_members (poll_id, version, position, commitment) VALUES (?, 1, ?, ?)");
      for (const row of db.prepare("SELECT id FROM polls ORDER BY id").all() as unknown as { id: string }[]) {
        insertGroup.run(row.id, root);
        insertVersion.run(row.id, root, createdAt);
        commitments.forEach((commitment, index) => insertMember.run(row.id, index, commitment));
      }
      // Polls that already carried votes were frozen at their only snapshot.
      db.exec("UPDATE poll_groups SET frozen = 1 WHERE poll_id IN (SELECT DISTINCT poll_id FROM votes)");
      if (hasLegacyMembers) db.exec("DROP TABLE members");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); db.close(); throw error; }
  }

  function pollRow(id: string): PollRow | undefined {
    return db.prepare("SELECT * FROM polls WHERE id = ?").get(id) as PollRow | undefined;
  }
  function groupRow(pollId: string): PollGroupRow | undefined {
    return db.prepare("SELECT * FROM poll_groups WHERE poll_id = ?").get(pollId) as PollGroupRow | undefined;
  }
  function isOpen(row: PollRow, now: number): boolean {
    return row.status === "open" && now < Date.parse(row.closes_at);
  }
  function commitmentsAt(pollId: string, version: number): string[] {
    return (db.prepare("SELECT commitment FROM group_members WHERE poll_id = ? AND version = ? ORDER BY position").all(pollId, version) as { commitment: string }[]).map(row => row.commitment);
  }
  function summarize(row: PollRow): PollSummary {
    const group = groupRow(row.id)!;
    return {
      id: row.id, title: row.title, summary: row.summary, organizer: row.organizer,
      status: row.status, publishedAt: row.published_at, closesAt: row.closes_at,
      memberCount: commitmentsAt(row.id, group.current_version).length,
      optionCount: JSON.parse(row.options_json).length,
      groupVersion: group.current_version, merkleRoot: group.merkle_root, frozen: group.frozen === 1
    };
  }
  function toSummary(group: PollGroupRow): GroupVersionSummary {
    return {
      pollId: group.poll_id, groupVersion: group.current_version,
      merkleRoot: group.merkle_root, memberCount: commitmentsAt(group.poll_id, group.current_version).length,
      frozen: group.frozen === 1
    };
  }
  return {
    list(): PollSummary[] {
      return (db.prepare("SELECT * FROM polls ORDER BY published_at DESC, id").all() as unknown as PollRow[]).map(summarize);
    },
    get(id: string): PollDetail | undefined {
      const row = pollRow(id);
      if (!row) return undefined;
      const group = groupRow(id)!;
      return {
        ...summarize(row), description: row.description, options: JSON.parse(row.options_json),
        eligibleMemberCommitments: commitmentsAt(id, group.current_version)
      };
    },
    /** Root of a stored snapshot, used to bind a vote to an explicit version. */
    versionRoot(pollId: string, version: number): string | undefined {
      const row = db.prepare("SELECT merkle_root FROM group_versions WHERE poll_id = ? AND version = ?").get(pollId, version) as { merkle_root: string } | undefined;
      return row?.merkle_root;
    },
    /** Looks up a proof root among the stored snapshots. */
    snapshotByRoot(pollId: string, root: string): { version: number; current: boolean } | undefined {
      const row = db.prepare("SELECT version FROM group_versions WHERE poll_id = ? AND merkle_root = ?").get(pollId, root) as { version: number } | undefined;
      if (!row) return undefined;
      return { version: row.version, current: row.version === groupRow(pollId)!.current_version };
    },
    /**
     * Appends a new immutable member snapshot (join / rotate / revoke). Runs in
     * an immediate transaction so concurrent changes and the first vote (which
     * freezes the group) serialize: optimistic version check plus frozen guard
     * decide which side wins.
     */
    applyGroupChange(
      pollId: string,
      operation: "join" | "rotate" | "revoke",
      expectedVersion: number,
      params: { commitment?: string; oldCommitment?: string; newCommitment?: string },
      now = Date.now()
    ): GroupChangeOutcome {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = pollRow(pollId);
        if (!row) { db.exec("ROLLBACK"); return { ok: false, reason: "poll_not_found" }; }
        if (!isOpen(row, now)) { db.exec("ROLLBACK"); return { ok: false, reason: "poll_closed" }; }
        const group = groupRow(pollId)!;
        if (group.frozen === 1) { db.exec("ROLLBACK"); return { ok: false, reason: "group_frozen" }; }
        if (group.current_version !== expectedVersion) { db.exec("ROLLBACK"); return { ok: false, reason: "version_conflict" }; }
        const current = commitmentsAt(pollId, group.current_version);
        let next: string[];
        if (operation === "join") {
          const commitment = params.commitment!;
          if (current.includes(commitment)) { db.exec("ROLLBACK"); return { ok: false, reason: "duplicate_commitment" }; }
          next = [...current, commitment];
        } else if (operation === "rotate") {
          const oldCommitment = params.oldCommitment!;
          const newCommitment = params.newCommitment!;
          const index = current.indexOf(oldCommitment);
          if (index === -1) { db.exec("ROLLBACK"); return { ok: false, reason: "commitment_not_found" }; }
          if (current.includes(newCommitment)) { db.exec("ROLLBACK"); return { ok: false, reason: "duplicate_commitment" }; }
          next = current.slice();
          next[index] = newCommitment;
        } else {
          const commitment = params.commitment!;
          const index = current.indexOf(commitment);
          if (index === -1) { db.exec("ROLLBACK"); return { ok: false, reason: "commitment_not_found" }; }
          if (current.length === 1) { db.exec("ROLLBACK"); return { ok: false, reason: "empty_group" }; }
          next = current.slice();
          next.splice(index, 1);
        }
        const version = group.current_version + 1;
        const root = merkleRoot(next);
        const createdAt = new Date(now).toISOString();
        db.prepare("INSERT INTO group_versions (poll_id, version, merkle_root, created_at) VALUES (?, ?, ?, ?)").run(pollId, version, root, createdAt);
        const insertMember = db.prepare("INSERT INTO group_members (poll_id, version, position, commitment) VALUES (?, ?, ?, ?)");
        next.forEach((commitment, index) => insertMember.run(pollId, version, index, commitment));
        db.prepare("UPDATE poll_groups SET current_version = ?, merkle_root = ? WHERE poll_id = ?").run(version, root, pollId);
        db.exec("COMMIT");
        return { ok: true, summary: toSummary(groupRow(pollId)!) };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    /**
     * Resolves the proof's Merkle root to a stored snapshot, rejects roots of
     * superseded versions, and in the same immediate transaction freezes the
     * current version, rejects a reused nullifier and persists the vote. The
     * UNIQUE (poll_id, nullifier) index is the cross-version backstop against
     * concurrent duplicates.
     */
    commitVote(pollId: string, optionId: string, nullifier: string, proofRoot: string, now = Date.now()): CommitVoteOutcome {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = pollRow(pollId);
        if (!row || !isOpen(row, now)) { db.exec("ROLLBACK"); return { ok: false, reason: "poll_closed" }; }
        const options = JSON.parse(row.options_json) as { id: string }[];
        if (!options.some(option => option.id === optionId)) { db.exec("ROLLBACK"); return { ok: false, reason: "invalid_option" }; }
        const group = groupRow(pollId)!;
        const snapshot = db.prepare("SELECT version FROM group_versions WHERE poll_id = ? AND merkle_root = ?").get(pollId, proofRoot) as { version: number } | undefined;
        if (!snapshot) { db.exec("ROLLBACK"); return { ok: false, reason: "unknown_root" }; }
        if (snapshot.version !== group.current_version) { db.exec("ROLLBACK"); return { ok: false, reason: "historical_version" }; }
        const duplicate = db.prepare("SELECT 1 AS found FROM votes WHERE poll_id = ? AND nullifier = ?").get(pollId, nullifier);
        if (duplicate) { db.exec("ROLLBACK"); return { ok: false, reason: "duplicate_nullifier" }; }
        const receipt: VoteReceipt = {
          id: randomUUID(), pollId, optionId, nullifier,
          groupVersion: group.current_version, acceptedAt: new Date(now).toISOString()
        };
        db.prepare("INSERT INTO votes (id, poll_id, option_id, nullifier, group_version, accepted_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(receipt.id, receipt.pollId, receipt.optionId, receipt.nullifier, receipt.groupVersion, receipt.acceptedAt);
        // The first accepted vote freezes the eligible set to this snapshot.
        db.prepare("UPDATE poll_groups SET frozen = 1 WHERE poll_id = ?").run(pollId);
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
