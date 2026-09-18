import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PollDetail, PollResults, PollSummary, VoteReceipt } from "./types.ts";

interface SeedPoll extends Omit<PollDetail, "memberCount" | "optionCount" | "eligibleMemberCommitments"> {}
interface CatalogSeed { polls: SeedPoll[]; memberCommitments: string[] }
interface PollRow {
  id: string; title: string; summary: string; description: string;
  organizer: string; status: "open"; published_at: string; closes_at: string;
  options_json: string;
}
interface VoteRow { id: string; poll_id: string; option_id: string; nullifier: string; accepted_at: string }

export type CommitVoteOutcome =
  | { ok: true; receipt: VoteReceipt }
  | { ok: false; reason: "poll_closed" | "invalid_option" | "duplicate_nullifier" };

function toReceipt(row: VoteRow): VoteReceipt {
  return { id: row.id, pollId: row.poll_id, optionId: row.option_id, nullifier: row.nullifier, acceptedAt: row.accepted_at };
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
  `);
  const existing = db.prepare("SELECT count(*) AS count FROM polls").get() as { count: number };
  if (existing.count === 0) {
    const seed = JSON.parse(readFileSync(new URL("../fixtures/catalog.json", import.meta.url), "utf8")) as CatalogSeed;
    db.exec("BEGIN");
    try {
      const insertPoll = db.prepare("INSERT INTO polls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const poll of seed.polls) insertPoll.run(poll.id, poll.title, poll.summary, poll.description, poll.organizer, poll.status, poll.publishedAt, poll.closesAt, JSON.stringify(poll.options));
      const insertMember = db.prepare("INSERT INTO members VALUES (?, ?)");
      seed.memberCommitments.forEach((commitment, index) => insertMember.run(commitment, index));
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); db.close(); throw error; }
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
  function summarize(row: PollRow): PollSummary {
    return {
      id: row.id, title: row.title, summary: row.summary, organizer: row.organizer,
      status: row.status, publishedAt: row.published_at, closesAt: row.closes_at,
      memberCount: members().length, optionCount: JSON.parse(row.options_json).length
    };
  }
  return {
    list(): PollSummary[] {
      return (db.prepare("SELECT * FROM polls ORDER BY published_at DESC, id").all() as unknown as PollRow[]).map(summarize);
    },
    get(id: string): PollDetail | undefined {
      const row = pollRow(id);
      if (!row) return undefined;
      return { ...summarize(row), description: row.description, options: JSON.parse(row.options_json), eligibleMemberCommitments: members() };
    },
    memberCommitments: members,
    /**
     * Re-validates the poll state, rejects a reused nullifier and persists the
     * vote in a single immediate transaction; the UNIQUE (poll_id, nullifier)
     * index is the backstop against concurrent duplicates.
     */
    commitVote(pollId: string, optionId: string, nullifier: string, now = Date.now()): CommitVoteOutcome {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = pollRow(pollId);
        if (!row || !isOpen(row, now)) { db.exec("ROLLBACK"); return { ok: false, reason: "poll_closed" }; }
        const options = JSON.parse(row.options_json) as { id: string }[];
        if (!options.some(option => option.id === optionId)) { db.exec("ROLLBACK"); return { ok: false, reason: "invalid_option" }; }
        const duplicate = db.prepare("SELECT 1 AS found FROM votes WHERE poll_id = ? AND nullifier = ?").get(pollId, nullifier);
        if (duplicate) { db.exec("ROLLBACK"); return { ok: false, reason: "duplicate_nullifier" }; }
        const receipt: VoteReceipt = { id: randomUUID(), pollId, optionId, nullifier, acceptedAt: new Date(now).toISOString() };
        db.prepare("INSERT INTO votes (id, poll_id, option_id, nullifier, accepted_at) VALUES (?, ?, ?, ?, ?)")
          .run(receipt.id, receipt.pollId, receipt.optionId, receipt.nullifier, receipt.acceptedAt);
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
