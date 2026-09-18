import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PollDetail, PollSummary } from "./types.ts";

interface SeedPoll extends Omit<PollDetail, "memberCount" | "optionCount" | "eligibleMemberCommitments"> {}
interface CatalogSeed { polls: SeedPoll[]; memberCommitments: string[] }
interface PollRow {
  id: string; title: string; summary: string; description: string;
  organizer: string; status: "open"; published_at: string; closes_at: string;
  options_json: string;
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
    close() { db.close(); }
  };
}
