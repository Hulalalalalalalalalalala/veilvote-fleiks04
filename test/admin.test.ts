import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { Identity } from "@semaphore-protocol/identity";
import { createApp } from "../src/app.ts";
import { openCatalog } from "../src/store.ts";
import type { AuditEvent, PollDetail } from "../src/types.ts";

const ADMIN_TOKEN = "test-admin-token";
const adminHeaders = { "Content-Type": "application/json", "X-Admin-Token": ADMIN_TOKEN };
const fakeProof = {
  merkleTreeDepth: 20, merkleTreeRoot: "1", message: "1", nullifier: "2", scope: "3",
  points: ["1", "2", "3", "4", "5", "6", "7", "8"]
};

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
async function seedPoll(base: string, overrides: Record<string, unknown> = {}, token = ADMIN_TOKEN) {
  const seeded = await (await fetch(`${base}/api/polls/community-garden-autumn`)).json() as { poll: PollDetail };
  const payload = {
    id: "draft-topic",
    title: "新议题", summary: "摘要", description: "描述", organizer: "组织方",
    publishedAt: "2026-09-18T08:00:00Z", closesAt: "2026-10-15T12:00:00Z",
    options: [{ id: "a", label: "甲" }, { id: "b", label: "乙" }],
    commitments: seeded.poll.eligibleMemberCommitments,
    ...overrides
  };
  const response = await fetch(`${base}/api/polls`, { method: "POST", headers: { ...adminHeaders, "X-Admin-Token": token }, body: JSON.stringify(payload) });
  return { response, payload };
}
async function postStatus(base: string, id: string, body: unknown, token?: string) {
  const response = await fetch(`${base}/api/polls/${encodeURIComponent(id)}/status`, {
    method: "POST",
    headers: token === undefined ? adminHeaders : { "Content-Type": "application/json", ...(token ? { "X-Admin-Token": token } : {}) },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() as { error?: string; status?: string } };
}

test("admin endpoints require X-Admin-Token and never write or audit when unauthorized", async () => {
  const { server, base } = await serve(":memory:", ADMIN_TOKEN);
  try {
    const before = (await (await fetch(`${base}/api/polls`)).json() as { polls: unknown[] }).polls.length;

    // No token configured on this server at all.
    const locked = await serve(":memory:", undefined);
    try {
      for (const init of [
        ["POST", "/api/polls", "{}"],
        ["POST", "/api/polls/community-garden-autumn/group", "{}"],
        ["POST", "/api/polls/community-garden-autumn/status", "{}"],
        ["GET", "/api/admin/audit", null]
      ] as const) {
        const response = await fetch(`${locked.base}${init[1]}`, { method: init[0], body: init[2] ?? undefined });
        assert.equal(response.status, 401);
        assert.equal((await response.json() as { error: string }).error, "admin_unauthorized");
      }
    } finally { await stop(locked.server); }

    // Token configured: missing and wrong headers are both 401 on every managed route.
    for (const path of ["/api/polls", "/api/polls/community-garden-autumn/group", "/api/polls/community-garden-autumn/status", "/api/admin/audit"]) {
      const missing = await fetch(`${base}${path}`, { method: path.endsWith("audit") ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: path.endsWith("audit") ? undefined : "{}" });
      assert.equal(missing.status, 401, path);
      const wrong = await fetch(`${base}${path}`, { method: path.endsWith("audit") ? "GET" : "POST", headers: { "Content-Type": "application/json", "X-Admin-Token": "nope" }, body: path.endsWith("audit") ? undefined : "{}" });
      assert.equal(wrong.status, 401, path);
    }

    // A rejected creation wrote nothing; unauthorized attempts left no audit rows.
    assert.equal((await (await fetch(`${base}/api/polls`)).json() as { polls: unknown[] }).polls.length, before);
    const audit = await fetch(`${base}/api/admin/audit`, { headers: { "X-Admin-Token": ADMIN_TOKEN } }).then(r => r.json()) as { events: AuditEvent[] };
    assert.equal(audit.events.length, 0);
  } finally { await stop(server); }
});

test("draft creation validates fields and conflicts on id", async () => {
  const { server, base } = await serve(":memory:", ADMIN_TOKEN);
  try {
    const created = await seedPoll(base);
    assert.equal(created.response.status, 201);
    const body = await created.response.json() as { poll: PollDetail };
    assert.equal(body.poll.status, "draft");
    assert.equal(body.poll.groupVersion, 1);
    assert.equal(body.poll.options.length, 2);

    // Same id conflicts.
    const conflict = await seedPoll(base);
    assert.equal(conflict.response.status, 409);
    assert.equal((await conflict.response.json() as { error: string }).error, "poll_exists");

    // Invalid payloads.
    const invalid: [string, Record<string, unknown>][] = [
      ["invalid_poll_id", { id: "  " }],
      ["invalid_poll", { id: "x", title: "" }],
      ["invalid_poll_dates", { id: "x", closesAt: "2026-01-01T00:00:00Z" }],
      // Dates must be strict ISO 8601 instants with an explicit timezone.
      ["invalid_poll_dates", { id: "x", publishedAt: "2026-09-18 08:00:00", closesAt: "2026-10-15T12:00:00Z" }],
      ["invalid_poll_dates", { id: "x", publishedAt: "2026-09-18T08:00:00", closesAt: "2026-10-15T12:00:00Z" }],
      ["invalid_poll_dates", { id: "x", publishedAt: "2026-09-18T08:00:00Z", closesAt: "2026/10/15 12:00" }],
      ["invalid_poll_dates", { id: "x", publishedAt: "2026-02-30T08:00:00Z", closesAt: "2026-10-15T12:00:00Z" }],
      ["invalid_options", { id: "x", options: [{ id: "a", label: "甲" }] }],
      ["duplicate_option_id", { id: "x", options: [{ id: "a", label: "甲" }, { id: "a", label: "乙" }] }],
      ["invalid_commitments", { id: "x", commitments: [] }],
      ["invalid_commitments", { id: "x", commitments: ["not-a-number"] }],
      ["duplicate_commitment", { id: "x", commitments: ["5", "5"] }]
    ];
    for (const [code, override] of invalid) {
      const attempt = await seedPoll(base, override);
      assert.equal(attempt.response.status, 400, `${code} -> ${attempt.response.status}`);
      assert.equal((await attempt.response.json() as { error: string }).error, code);
    }

    // Authorized failures still produced audit events; none leaked the token or commitments.
    const audit = await fetch(`${base}/api/admin/audit`, { headers: { "X-Admin-Token": ADMIN_TOKEN } }).then(r => r.json()) as { events: AuditEvent[] };
    assert.ok(audit.events.some(event => event.action === "poll_create" && event.result === "success"));
    assert.ok(audit.events.some(event => event.action === "poll_create" && event.result === "failure"));
    assert.equal(JSON.stringify(audit).includes(ADMIN_TOKEN), false);
    assert.equal(JSON.stringify(audit).includes(created.payload.commitments[0]), false);
  } finally { await stop(server); }
});

test("drafts are invisible to the public but manageable by an authorized admin", async () => {
  const { server, base } = await serve(":memory:", ADMIN_TOKEN);
  try {
    const created = await seedPoll(base);
    assert.equal(created.response.status, 201);

    // Public surface: list, detail, results and votes all hide the draft.
    const publicList = await (await fetch(`${base}/api/polls`)).json() as { polls: { id: string }[] };
    assert.ok(!publicList.polls.some(poll => poll.id === "draft-topic"));
    assert.equal((await fetch(`${base}/api/polls/draft-topic`)).status, 404);
    assert.equal((await fetch(`${base}/api/polls/draft-topic/results`)).status, 404);
    const vote = await fetch(`${base}/api/polls/draft-topic/votes`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optionId: "a", proof: fakeProof })
    });
    assert.equal(vote.status, 404);

    // Manager with a token sees and reads the draft; a wrong token still gets 404.
    const managedList = await fetch(`${base}/api/polls`, { headers: { "X-Admin-Token": ADMIN_TOKEN } }).then(r => r.json()) as { polls: { id: string; status: string }[] };
    assert.ok(managedList.polls.some(poll => poll.id === "draft-topic" && poll.status === "draft"));
    const detail = await fetch(`${base}/api/polls/draft-topic`, { headers: { "X-Admin-Token": ADMIN_TOKEN } });
    assert.equal(detail.status, 200);
    assert.equal((await fetch(`${base}/api/polls/draft-topic`, { headers: { "X-Admin-Token": "wrong" } })).status, 404);

    // Membership is editable in draft.
    const joiner = new Identity("veilvote-demo-member-09").commitment.toString();
    const group = await fetch(`${base}/api/polls/draft-topic/group`, {
      method: "POST", headers: adminHeaders,
      body: JSON.stringify({ operation: "join", expectedVersion: 1, commitment: joiner })
    });
    assert.equal(group.status, 201);
    assert.equal((await group.json() as { group: { version: number } }).group.version, 2);
  } finally { await stop(server); }
});

test("lifecycle enforces draft→open→closed→archived with optimistic expectedStatus", async () => {
  const { server, base } = await serve(":memory:", ADMIN_TOKEN);
  try {
    assert.equal((await seedPoll(base)).response.status, 201);

    // Skipping open is an illegal transition.
    const skip = await postStatus(base, "draft-topic", { status: "closed", expectedStatus: "draft" });
    assert.equal(skip.status, 409);
    assert.equal(skip.body.error, "illegal_transition");

    // A stale expectedStatus is a conflict.
    const conflict = await postStatus(base, "draft-topic", { status: "open", expectedStatus: "open" });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, "status_conflict");

    // Unknown poll is 404; bogus status values are 400.
    assert.equal((await postStatus(base, "missing", { status: "open", expectedStatus: "draft" })).status, 404);
    const invalid = await postStatus(base, "draft-topic", { status: "nope", expectedStatus: "draft" });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, "invalid_status");

    // Happy path, one edge at a time.
    for (const [to, expected] of [["open", "draft"], ["closed", "open"], ["archived", "closed"]] as const) {
      const result = await postStatus(base, "draft-topic", { status: to, expectedStatus: expected });
      assert.equal(result.status, 200, `${expected} -> ${to}`);
      assert.equal(result.body.status, to);
    }
    // Archived is terminal.
    const terminal = await postStatus(base, "draft-topic", { status: "open", expectedStatus: "archived" });
    assert.equal(terminal.status, 409);
    assert.equal(terminal.body.error, "illegal_transition");

    // Closed/archived results remain public; votes are refused.
    assert.equal((await fetch(`${base}/api/polls/draft-topic/results`)).status, 200);
    const vote = await fetch(`${base}/api/polls/draft-topic/votes`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optionId: "a", proof: fakeProof })
    });
    assert.equal(vote.status, 409);
    assert.equal((await vote.json() as { error: string }).error, "poll_closed");

    // Membership is no longer editable after opening once votes are impossible;
    // a closed poll rejects edits outright.
    const edit = await fetch(`${base}/api/polls/draft-topic/group`, {
      method: "POST", headers: adminHeaders,
      body: JSON.stringify({ operation: "join", expectedVersion: 1, commitment: new Identity("x").commitment.toString() })
    });
    assert.equal(edit.status, 409);
    assert.equal((await edit.json() as { error: string }).error, "poll_not_editable");

    // Audit trail records every success and failure, newest first.
    const { events } = await fetch(`${base}/api/admin/audit`, { headers: { "X-Admin-Token": ADMIN_TOKEN } }).then(r => r.json()) as { events: AuditEvent[] };
    const timestamps = events.map(event => Date.parse(event.at));
    assert.deepEqual(timestamps, [...timestamps].sort((a, b) => b - a));
    assert.ok(events.some(e => e.action === "status_change_rejected" && e.result === "failure"));
    const successes = events.filter(e => e.action === "poll_status_change" && e.result === "success");
    assert.deepEqual(successes.map(e => (e.details as { to: string }).to), ["archived", "closed", "open"]);
  } finally { await stop(server); }
});

test("membership is editable in draft and in open-before-first-vote; the first vote freezes it", () => {
  const catalog = openCatalog(":memory:");
  try {
    const commitments = ["11", "22", "33"];
    const created = catalog.createPoll({
      id: "freeze-poll", title: "t", summary: "s", description: "d", organizer: "o",
      publishedAt: "2026-09-01T00:00:00Z", closesAt: "2026-10-10T00:00:00Z",
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], commitments
    });
    assert.ok(created.ok);

    // Editable while a draft.
    const inDraft = catalog.applyGroupOperation("freeze-poll", { type: "join", commitment: "44" }, 1);
    assert.ok(inDraft.ok);

    // After opening, still editable because no vote has been cast.
    assert.deepEqual(catalog.transitionStatus("freeze-poll", "open", "draft"), { ok: true, status: "open" });
    const inOpen = catalog.applyGroupOperation("freeze-poll", { type: "join", commitment: "55" }, 2);
    assert.ok(inOpen.ok);

    // The first accepted vote freezes version 3.
    const vote = catalog.commitVote("freeze-poll", "a", "nullifier-1", 3);
    assert.ok(vote.ok);
    const frozen = catalog.applyGroupOperation("freeze-poll", { type: "join", commitment: "66" }, 3);
    assert.deepEqual(frozen, { ok: false, reason: "group_frozen" });

    // Moving to closed makes membership edits illegal even on the version.
    assert.deepEqual(catalog.transitionStatus("freeze-poll", "closed", "open"), { ok: true, status: "closed" });
    const afterClose = catalog.applyGroupOperation("freeze-poll", { type: "revoke", commitment: "55" }, 3);
    assert.deepEqual(afterClose, { ok: false, reason: "poll_not_editable" });

    // Successful and rejected member changes are all audited.
    const events = catalog.auditEvents();
    assert.ok(events.some(e => e.action === "group_change" && e.result === "success"));
    assert.ok(events.some(e => e.action === "group_change_rejected" && (e.details as { reason: string }).reason === "group_frozen"));
    assert.ok(events.some(e => e.action === "group_change_rejected" && (e.details as { reason: string }).reason === "poll_not_editable"));
  } finally { catalog.close(); }
});

test("deadline transition is persisted atomically, rejects out-of-window votes and survives restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "veilvote-deadline-"));
  const path = join(directory, "veilvote.sqlite");
  try {
    const catalog = openCatalog(path);
    const commitments = ["11", "22", "33"];
    const created = catalog.createPoll({
      id: "deadline-poll", title: "t", summary: "s", description: "d", organizer: "o",
      publishedAt: "2026-09-01T00:00:00Z", closesAt: "2026-09-10T00:00:00Z",
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], commitments
    });
    assert.ok(created.ok);
    assert.equal(catalog.transitionStatus("deadline-poll", "open", "draft").ok, true);

    // A vote arriving exactly at/after the deadline persists closed and is rejected.
    const deadline = Date.parse("2026-09-10T00:00:00Z");
    const outcome = catalog.commitVote("deadline-poll", "a", "nullifier-1", 1, deadline);
    assert.deepEqual(outcome, { ok: false, reason: "poll_closed" });
    // Another concurrent out-of-window vote observes the persisted closed state.
    const second = catalog.commitVote("deadline-poll", "b", "nullifier-2", 1, deadline + 50);
    assert.deepEqual(second, { ok: false, reason: "poll_closed" });
    assert.equal(catalog.get("deadline-poll", deadline)!.status, "closed");
    // Results stay public after the automatic close.
    assert.equal(catalog.results("deadline-poll", deadline)!.total, 0);
    // The deadline close was audited exactly once.
    const closes = catalog.auditEvents().filter(e => e.action === "poll_status_change" && (e.details as { reason?: string }).reason === "deadline");
    assert.equal(closes.length, 1);
    // A membership edit arriving after the cutoff is refused and never re-opens the poll.
    const lateEdit = catalog.applyGroupOperation("deadline-poll", { type: "join", commitment: "44" }, 1, deadline + 70);
    assert.deepEqual(lateEdit, { ok: false, reason: "poll_not_editable" });
    assert.equal(catalog.get("deadline-poll", deadline + 70)!.status, "closed");

    // Same rule when no read/vote has lazily closed it yet: the edit itself
    // is the operation that persists the deadline transition.
    const created2 = catalog.createPoll({
      id: "deadline-poll-2", title: "t", summary: "s", description: "d", organizer: "o",
      publishedAt: "2026-09-01T00:00:00Z", closesAt: "2026-09-12T00:00:00Z",
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], commitments
    });
    assert.ok(created2.ok);
    assert.equal(catalog.transitionStatus("deadline-poll-2", "open", "draft").ok, true);
    const edit2 = catalog.applyGroupOperation("deadline-poll-2", { type: "join", commitment: "44" }, 1, Date.parse("2026-09-12T00:00:00Z"));
    assert.deepEqual(edit2, { ok: false, reason: "poll_not_editable" });
    assert.equal(catalog.get("deadline-poll-2", Date.parse("2026-09-12T00:00:00Z"))!.status, "closed");
    catalog.close();
    // The persisted closed state and the audit row survive a restart.
    const reopened = openCatalog(path);
    assert.equal(reopened.get("deadline-poll")!.status, "closed");
    assert.deepEqual(reopened.commitVote("deadline-poll", "a", "nullifier-1", 1), { ok: false, reason: "poll_closed" });
    assert.ok(reopened.auditEvents().some(e => e.action === "poll_status_change" && (e.details as { to: string }).to === "closed"));
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("legacy open polls migrate to open and stay fully compatible", () => {
  const directory = mkdtempSync(join(tmpdir(), "veilvote-legacy-status-"));
  const path = join(directory, "veilvote.sqlite");
  try {
    const catalog = openCatalog(path);
    for (const poll of catalog.list()) assert.equal(poll.status, "open");
    // Old issues are public, votable-capable and have results.
    const seeded = catalog.get("community-garden-autumn")!;
    assert.equal(seeded.status, "open");
    assert.ok(catalog.results("community-garden-autumn"));
    catalog.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
