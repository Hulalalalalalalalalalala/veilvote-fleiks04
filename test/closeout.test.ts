import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Server } from "node:http";
import { createApp } from "../src/app.ts";
import { openCatalog } from "../src/store.ts";
import type { AuditEvent, AuditPage, PollResults, PollSnapshot, VoteReceipt } from "../src/types.ts";

const ADMIN_TOKEN = "test-admin-token";
const adminHeaders = { "Content-Type": "application/json", "X-Admin-Token": ADMIN_TOKEN };
const CLOSED_AT_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function serve(databasePath: string, token?: string): Promise<{ server: Server; base: string }> {
  const server = createApp(databasePath, undefined, { adminToken: token });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, base: `http://127.0.0.1:${address.port}` };
}
async function stop(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}
function makePoll(id: string, closesAt = "2026-10-10T00:00:00Z") {
  return {
    id, title: "t", summary: "s", description: "d", organizer: "o",
    publishedAt: "2026-09-01T00:00:00Z", closesAt,
    options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    commitments: ["11", "22", "33"]
  };
}
function digestOf(snapshot: PollSnapshot): string {
  const { pollId, groupVersion, total, options, closedAt } = snapshot;
  return createHash("sha256").update(JSON.stringify({ pollId, groupVersion, total, options, closedAt }), "utf8").digest("hex");
}
async function withTempDb(run: (path: string) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "veilvote-closeout-"));
  try {
    await run(join(directory, "veilvote.sqlite"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("manual close captures an immutable snapshot that survives archive and restart", async () => {
  await withTempDb(async path => {
    const catalog = openCatalog(path);
    assert.ok(catalog.createPoll(makePoll("snap-poll")).ok);
    assert.deepEqual(catalog.transitionStatus("snap-poll", "open", "draft"), { ok: true, status: "open" });
    assert.ok(catalog.commitVote("snap-poll", "a", "n-1", 1, Date.parse("2026-09-20T10:00:00Z")).ok);
    assert.ok(catalog.commitVote("snap-poll", "a", "n-2", 1, Date.parse("2026-09-20T10:01:00Z")).ok);
    assert.ok(catalog.commitVote("snap-poll", "b", "n-3", 1, Date.parse("2026-09-20T10:02:00Z")).ok);
    const closeNow = Date.parse("2026-09-21T11:00:00Z");
    assert.deepEqual(catalog.transitionStatus("snap-poll", "closed", "open", closeNow), { ok: true, status: "closed" });

    const closed = catalog.results("snap-poll", closeNow)!;
    assert.ok(closed.snapshot, "closed results carry the snapshot");
    assert.equal(closed.snapshot.pollId, "snap-poll");
    assert.equal(closed.snapshot.groupVersion, 1);
    assert.equal(closed.snapshot.total, 3);
    assert.deepEqual(closed.snapshot.options, [{ id: "a", count: 2 }, { id: "b", count: 1 }]);
    assert.equal(closed.snapshot.closedAt, "2026-09-21T11:00:00.000Z");
    assert.match(closed.snapshot.closedAt, CLOSED_AT_FORMAT);
    assert.equal(closed.snapshot.digest, digestOf(closed.snapshot));

    // Archiving must not touch the snapshot.
    assert.deepEqual(catalog.transitionStatus("snap-poll", "archived", "closed"), { ok: true, status: "archived" });
    assert.deepEqual(catalog.results("snap-poll")!.snapshot, closed.snapshot);
    catalog.close();

    // Nor does a restart.
    const reopened = openCatalog(path);
    assert.deepEqual(reopened.results("snap-poll")!.snapshot, closed.snapshot);
    reopened.close();

    // The API exposes the same snapshot; an open poll has none and a draft 404s.
    const { server, base } = await serve(path, ADMIN_TOKEN);
    try {
      const body = await (await fetch(`${base}/api/polls/snap-poll/results`)).json() as { result: PollResults };
      assert.deepEqual(body.result.snapshot, closed.snapshot);
      const open = await (await fetch(`${base}/api/polls/community-garden-autumn/results`)).json() as { result: PollResults };
      assert.equal("snapshot" in open.result, false);
      const draft = await fetch(`${base}/api/polls`, {
        method: "POST", headers: adminHeaders,
        body: JSON.stringify({ ...makePoll("snap-draft"), commitments: ["11", "22"] })
      });
      assert.equal(draft.status, 201);
      assert.equal((await fetch(`${base}/api/polls/snap-draft/results`)).status, 404);
    } finally { await stop(server); }
  });
});

test("deadline close writes the snapshot in the adjudicating transaction", async () => {
  await withTempDb(path => {
    const catalog = openCatalog(path);
    assert.ok(catalog.createPoll(makePoll("deadline-snap", "2026-09-10T00:00:00Z")).ok);
    assert.deepEqual(catalog.transitionStatus("deadline-snap", "open", "draft"), { ok: true, status: "open" });
    const deadline = Date.parse("2026-09-10T00:00:00Z");
    assert.deepEqual(catalog.commitVote("deadline-snap", "a", "n-1", 1, deadline), { ok: false, reason: "poll_closed" });
    const result = catalog.results("deadline-snap", deadline)!;
    assert.ok(result.snapshot);
    assert.equal(result.snapshot.closedAt, "2026-09-10T00:00:00.000Z");
    assert.equal(result.snapshot.total, 0);
    assert.deepEqual(result.snapshot.options, [{ id: "a", count: 0 }, { id: "b", count: 0 }]);
    assert.equal(result.snapshot.digest, digestOf(result.snapshot));
    catalog.close();
  });
});

test("legacy closed polls are backfilled once with the documented fallbacks", async () => {
  await withTempDb(path => {
    const catalog = openCatalog(path);
    // legacy-a: has a successful close audit event -> closedAt from the audit.
    assert.ok(catalog.createPoll(makePoll("legacy-a")).ok);
    catalog.transitionStatus("legacy-a", "open", "draft");
    catalog.commitVote("legacy-a", "a", "n-1", 1, Date.parse("2026-09-20T10:00:00Z"));
    catalog.transitionStatus("legacy-a", "closed", "open", Date.parse("2026-09-21T11:00:00Z"));
    // legacy-b: close audit removed -> closedAt from the last accepted vote.
    assert.ok(catalog.createPoll(makePoll("legacy-b")).ok);
    catalog.transitionStatus("legacy-b", "open", "draft");
    catalog.commitVote("legacy-b", "a", "n-1", 1, Date.parse("2026-09-20T10:00:00Z"));
    catalog.commitVote("legacy-b", "b", "n-2", 1, Date.parse("2026-09-20T10:05:00Z"));
    catalog.transitionStatus("legacy-b", "closed", "open", Date.parse("2026-09-21T11:00:00Z"));
    // legacy-c: no close audit and no votes -> closedAt from closesAt.
    assert.ok(catalog.createPoll(makePoll("legacy-c", "2026-09-15T08:30:00Z")).ok);
    catalog.transitionStatus("legacy-c", "open", "draft");
    catalog.transitionStatus("legacy-c", "closed", "open", Date.parse("2026-09-21T11:00:00Z"));
    catalog.close();

    // Simulate a pre-snapshot database: drop the snapshots, the close audits
    // for b/c and the votes for c.
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE polls SET snapshot_json = NULL");
    raw.exec("DELETE FROM audit_events WHERE poll_id IN ('legacy-b', 'legacy-c')");
    raw.exec("DELETE FROM votes WHERE poll_id = 'legacy-c'");
    raw.close();

    const backfilled = openCatalog(path);
    const a = backfilled.results("legacy-a")!.snapshot!;
    assert.equal(a.closedAt, "2026-09-21T11:00:00.000Z");
    assert.equal(a.groupVersion, 1);
    assert.deepEqual(a.options, [{ id: "a", count: 1 }, { id: "b", count: 0 }]);
    assert.equal(a.digest, digestOf(a));
    const b = backfilled.results("legacy-b")!.snapshot!;
    assert.equal(b.closedAt, "2026-09-20T10:05:00.000Z");
    assert.deepEqual(b.options, [{ id: "a", count: 1 }, { id: "b", count: 1 }]);
    assert.equal(b.digest, digestOf(b));
    const c = backfilled.results("legacy-c")!.snapshot!;
    assert.equal(c.closedAt, "2026-09-15T08:30:00.000Z");
    assert.equal(c.total, 0);
    assert.equal(c.digest, digestOf(c));
    backfilled.close();

    // The backfill is written once and then fixed: a second open changes nothing.
    const again = openCatalog(path);
    assert.deepEqual(again.results("legacy-a")!.snapshot, a);
    assert.deepEqual(again.results("legacy-b")!.snapshot, b);
    assert.deepEqual(again.results("legacy-c")!.snapshot, c);
    again.close();
  });
});

test("POST /api/receipts/:id/verify confirms matching receipts without identity linkage", async () => {
  await withTempDb(async path => {
    const catalog = openCatalog(path);
    assert.ok(catalog.createPoll(makePoll("verify-poll")).ok);
    catalog.transitionStatus("verify-poll", "open", "draft");
    const vote = catalog.commitVote("verify-poll", "a", "nullifier-7", 1, Date.parse("2026-09-20T10:00:00Z"));
    assert.ok(vote.ok);
    const receipt = (vote as { ok: true; receipt: VoteReceipt }).receipt;
    catalog.close();

    const { server, base } = await serve(path, ADMIN_TOKEN);
    try {
      const url = `${base}/api/receipts/${receipt.id}/verify`;
      // Full match -> 200 with the receipt.
      const match = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pollId: "verify-poll", optionId: "a", nullifier: "nullifier-7" })
      });
      assert.equal(match.status, 200);
      const matched = await match.json() as { valid: boolean; receipt: VoteReceipt };
      assert.equal(matched.valid, true);
      assert.deepEqual(matched.receipt, receipt);

      // Any field mismatch -> 422 receipt_mismatch.
      for (const body of [
        { pollId: "other", optionId: "a", nullifier: "nullifier-7" },
        { pollId: "verify-poll", optionId: "b", nullifier: "nullifier-7" },
        { pollId: "verify-poll", optionId: "a", nullifier: "nullifier-8" }
      ]) {
        const mismatch = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        assert.equal(mismatch.status, 422);
        assert.equal((await mismatch.json() as { error: string }).error, "receipt_mismatch");
      }

      // Unknown receipt -> 404; malformed payloads -> 400; wrong method -> 405.
      const unknown = await fetch(`${base}/api/receipts/does-not-exist/verify`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pollId: "verify-poll", optionId: "a", nullifier: "nullifier-7" })
      });
      assert.equal(unknown.status, 404);
      const missing = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pollId: "verify-poll" }) });
      assert.equal(missing.status, 400);
      assert.equal((await fetch(url, { method: "GET" })).status, 405);
    } finally { await stop(server); }
  });
});

test("audit query filters, paginates and validates the time range", async () => {
  await withTempDb(async path => {
    const { server, base } = await serve(path, ADMIN_TOKEN);
    try {
      // Generate a handful of events across two polls, successes and failures.
      for (const id of ["audit-a", "audit-b"]) {
        const created = await fetch(`${base}/api/polls`, {
          method: "POST", headers: adminHeaders,
          body: JSON.stringify({ ...makePoll(id), commitments: ["11", "22"] })
        });
        assert.equal(created.status, 201);
      }
      await fetch(`${base}/api/polls/audit-a/status`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ status: "open", expectedStatus: "draft" }) });
      await fetch(`${base}/api/polls/audit-a/status`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ status: "archived", expectedStatus: "open" }) });

      const audit = async (query: string) => {
        const response = await fetch(`${base}/api/admin/audit${query}`, { headers: { "X-Admin-Token": ADMIN_TOKEN } });
        return { status: response.status, body: await response.json() as AuditPage & { error?: string } };
      };

      // Default page: newest first, page 1 with the default page size.
      const all = await audit("");
      assert.equal(all.status, 200);
      assert.equal(all.body.page, 1);
      assert.equal(all.body.pageSize, 50);
      assert.equal(all.body.total, all.body.events.length);
      assert.equal(all.body.totalPages, 1);
      const timestamps = all.body.events.map(event => Date.parse(event.at));
      assert.deepEqual(timestamps, [...timestamps].sort((x, y) => y - x));

      // Exact-match filters compose.
      const byPoll = await audit("?pollId=audit-a");
      assert.ok(byPoll.body.events.length > 0);
      assert.ok(byPoll.body.events.every(event => event.pollId === "audit-a"));
      const byAction = await audit("?pollId=audit-a&action=poll_create");
      assert.deepEqual(byAction.body.events.map(event => event.action), ["poll_create"]);
      const failures = await audit("?result=failure");
      assert.ok(failures.body.events.length > 0);
      assert.ok(failures.body.events.every(event => event.result === "failure"));

      // from/to are ISO8601 and inclusive at both ends.
      const pivot = all.body.events[1].at;
      const around = await audit(`?from=${encodeURIComponent(pivot)}&to=${encodeURIComponent(pivot)}`);
      assert.ok(around.body.events.length >= 1);
      assert.ok(around.body.events.every(event => event.at === pivot));
      const bounded = await audit(`?from=${encodeURIComponent(all.body.events[all.body.events.length - 1].at)}&to=${encodeURIComponent(all.body.events[0].at)}`);
      assert.equal(bounded.body.total, all.body.total);

      // Invalid or inverted ranges are 400.
      assert.equal((await audit("?from=not-a-date")).status, 400);
      assert.equal((await audit("?to=2026-13-01T00:00:00Z")).status, 400);
      assert.equal((await audit("?from=2026-09-20T00:00:00Z&to=2026-09-19T00:00:00Z")).status, 400);

      // Pagination: pageSize capped at 200, pages line up with the total.
      const capped = await audit("?pageSize=500");
      assert.equal(capped.body.pageSize, 200);
      const paged = await audit("?pageSize=2&page=2");
      assert.equal(paged.body.page, 2);
      assert.equal(paged.body.pageSize, 2);
      assert.equal(paged.body.events.length, 2);
      assert.equal(paged.body.totalPages, Math.ceil(paged.body.total / 2));
      assert.deepEqual(paged.body.events.map(event => event.id), all.body.events.slice(2, 4).map(event => event.id));
      assert.equal((await audit("?page=0")).status, 400);
      assert.equal((await audit("?pageSize=abc")).status, 400);

      // Still admin-only.
      assert.equal((await fetch(`${base}/api/admin/audit`)).status, 401);
    } finally { await stop(server); }
  });
});
