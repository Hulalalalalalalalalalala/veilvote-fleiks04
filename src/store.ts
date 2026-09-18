import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PollDetail, PollResult, PollSummary, VoteReceipt } from "./types.ts";

interface SeedPoll extends Omit<PollDetail, "memberCount" | "optionCount" | "eligibleMemberCommitments"> {}
interface CatalogSeed { polls: SeedPoll[]; memberCommitments: string[] }
interface PollRow {
  id: string; title: string; summary: string; description: string;
  organizer: string; status: "open"; published_at: string; closes_at: string;
  options_json: string;
}
interface VoteRow { id: string; poll_id: string; option_id: string; nullifier: string; accepted_at: string }

export type CastVoteResult =
  | { ok: true; receipt: VoteReceipt }
  | { ok: false; reason: "not_found" | "closed" | "duplicate" };

function toReceipt(row: VoteRow): VoteReceipt {
  return { id: row.id, pollId: row.poll_id, optionId: row.option_id, nullifier: row.nullifier, acceptedAt: row.accepted_at };
}
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
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
      poll_id TEXT NOT NULL REFERENCES polls(id),
      option_id TEXT NOT NULL,
      nullifier TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      UNIQUE (poll_id, nullifier)
    );
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
      const row = db.prepare("SELECT * FROM polls WHERE id = ?").get(id) as PollRow | undefined;
      if (!row) return undefined;
      return { ...summarize(row), description: row.description, options: JSON.parse(row.options_json), eligibleMemberCommitments: members() };
    },
    castVote(pollId: string, optionId: string, nullifier: string, receiptId: string, acceptedAt: string): CastVoteResult {
      // BEGIN IMMEDIATE takes the write lock up front; status check, nullifier
      // dedup and insert then commit as one atomic unit. The UNIQUE(poll_id,
      // nullifier) constraint is the backstop if two writers ever race.
      db.exec("BEGIN IMMEDIATE");
      try {
        const poll = db.prepare("SELECT status, closes_at FROM polls WHERE id = ?").get(pollId) as Pick<PollRow, "status" | "closes_at"> | undefined;
        if (!poll) { db.exec("ROLLBACK"); return { ok: false, reason: "not_found" }; }
        if (poll.status !== "open" || Date.parse(acceptedAt) > Date.parse(poll.closes_at)) {
          db.exec("ROLLBACK"); return { ok: false, reason: "closed" };
        }
        const duplicate = db.prepare("SELECT 1 FROM votes WHERE poll_id = ? AND nullifier = ?").get(pollId, nullifier);
        if (duplicate) { db.exec("ROLLBACK"); return { ok: false, reason: "duplicate" }; }
        db.prepare("INSERT INTO votes (id, poll_id, option_id, nullifier, accepted_at) VALUES (?, ?, ?, ?, ?)")
          .run(receiptId, pollId, optionId, nullifier, acceptedAt);
        db.exec("COMMIT");
        return { ok: true, receipt: { id: receiptId, pollId, optionId, nullifier, acceptedAt } };
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
        if (isUniqueViolation(error)) return { ok: false, reason: "duplicate" };
        throw error;
      }
    },
    results(pollId: string): PollResult | undefined {
      const row = db.prepare("SELECT options_json FROM polls WHERE id = ?").get(pollId) as Pick<PollRow, "options_json"> | undefined;
      if (!row) return undefined;
      const counts = new Map<string, number>();
      for (const countRow of db.prepare("SELECT option_id, COUNT(*) AS count FROM votes WHERE poll_id = ? GROUP BY option_id").all(pollId) as { option_id: string; count: number }[]) {
        counts.set(countRow.option_id, countRow.count);
      }
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
