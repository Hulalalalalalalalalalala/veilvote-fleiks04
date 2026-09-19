import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Server } from "node:http";
import { Identity } from "@semaphore-protocol/identity";
import { Group } from "@semaphore-protocol/group";
import { generateProof } from "@semaphore-protocol/proof";
import { createApp } from "../src/app.ts";
import { terminateProverWorkers } from "../src/voting.ts";
import type { AuditEvent, PollDetail, PollStatus, PollSummary, SemaphoreProofPayload } from "../src/types.ts";

const ADMIN_TOKEN = "test-admin-token";

test.after(() => terminateProverWorkers());

async function serve(databasePath: string, token?: string): Promise<{ server: Server; base: string }> {
  const server = createApp(databasePath, undefined, token ?? ADMIN_TOKEN);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, base: `http://127.0.0.1:${address.port}` };
}
async function stop(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}

const adminHeaders = (token: string | null = ADMIN_TOKEN): Record<string, string> =>
  token === null ? { "Content-Type": "application/json" } : { "Content-Type": "application/json", "X-Admin-Token": token };

async function api<T = { error?: string }>(base: string, path: string, init?: RequestInit, token: string | null = ADMIN_TOKEN) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { ...adminHeaders(token), ...(init?.headers ?? {}) } });
  let body: unknown;
  try { body = await response.json(); } catch { body = undefined; }
  return { status: response.status, body: body as T };
}

const commitmentOf = (secret: string) => new Identity(secret).commitment.toString();
const baseCommitments = () =>
  ["veilvote-admin-member-01", "veilvote-admin-member-02"].map(commitmentOf);

function draftBody(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: "new-issue-2026",
    title: "新议题",
    summary: "一个用于测试的草案",
    description: "完整描述",
    organizer: "测试组",
    publishedAt: new Date(now - 60_000).toISOString(),
    closesAt: new Date(now + 86_400_000).toISOString(),
    options: [{ id: "opt-a", label: "方案甲" }, { id: "opt-b", label: "方案乙" }],
    commitments: baseCommitments(),
    ...overrides
  };
}
async function createDraft(base: string, overrides: Record<string, unknown> = {}) {
  return api<{ poll: PollDetail; error?: string; fields?: string[] }>(base, "/api/polls", { method: "POST", body: JSON.stringify(draftBody(overrides)) });
}
async function transition(base: string, id: string, status: PollStatus, expectedStatus?: PollStatus) {
  return api<{ poll: PollDetail; error?: string }>(base, `/api/polls/${encodeURIComponent(id)}/status`, {
    method: "POST", body: JSON.stringify(expectedStatus ? { status, expectedStatus } : { status })
  });
}
async function auditEvents(base: string, token: string | null = ADMIN_TOKEN) {
  return api<{ events: AuditEvent[]; error?: string }>(base, "/api/admin/audit", undefined, token);
}

test("admin endpoints reject missing, wrong or unconfigured tokens without writing data", async () => {
  // Service with no ADMIN_TOKEN configured.
  const unconfigured = createApp(":memory:");
  await new Promise<void>(done => unconfigured.listen(0, "127.0.0.1", done));
  {
    const address = unconfigured.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const before = (await (await fetch(`${base}/api/polls`)).json() as { polls: PollSummary[] }).polls.length;
      for (const token of [null, "anything"]) {
        const created = await api<{ error?: string }>(base, "/api/polls", { method: "POST", body: JSON.stringify(draftBody()) }, token);
        assert.equal(created.status, 401);
        assert.equal(created.body.error, "admin_unauthorized");
        const events = await auditEvents(base, token);
        assert.equal(events.status, 401);
        assert.equal(events.body.error, "admin_unauthorized");
        const status = await transition(base, "community-garden-autumn", "closed");
        assert.equal(status.status, 401);
      }
      const after = (await (await fetch(`${base}/api/polls`)).json() as { polls: PollSummary[] }).polls.length;
      assert.equal(after, before, "unauthorized attempts must not create data");
    } finally {
      unconfigured.closeAllConnections();
      await new Promise<void>((done, reject) => unconfigured.close(error => error ? reject(error) : done()));
    }
  }

  // Configured service: missing and wrong tokens are 401.
  const { server, base } = await serve(":memory:");
  try {
    const missing = await api(base, "/api/polls", { method: "POST", body: JSON.stringify(draftBody()) }, null);
    assert.equal(missing.status, 401);
    const wrong = await api<{ error?: string }>(base, "/api/polls", { method: "POST", body: JSON.stringify(draftBody()) }, "wrong");
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error, "admin_unauthorized");
    // No poll_created event exists because the requests never reached the catalog.
    const events = (await auditEvents(base)).body.events!;
    assert.ok(!events.some(event => event.action === "poll_created"));
  } finally {
    await stop(server);
  }
});

test("draft creation validates fields and returns 201/400/409", async () => {
  const { server, base } = await serve(":memory:");
  try {
    // Malformed bodies.
    assert.equal((await createDraft(base, { title: "" })).status, 400);
    assert.equal((await createDraft(base, { options: [{ id: "only", label: "One" }] })).status, 400);
    assert.equal((await createDraft(base, {
      options: [{ id: "dup", label: "A" }, { id: "dup", label: "B" }]
    })).status, 400);
    assert.equal((await createDraft(base, { commitments: [] })).status, 400);
    assert.equal((await createDraft(base, { commitments: ["1", "1"] })).status, 400);
    assert.equal((await createDraft(base, { commitments: ["not-a-field-element"] })).status, 400);
    assert.equal((await createDraft(base, {
      publishedAt: new Date(Date.now() + 3_600_000).toISOString(),
      closesAt: new Date(Date.now() - 1000).toISOString()
    })).status, 400);

    // Valid draft.
    const created = await createDraft(base);
    assert.equal(created.status, 201);
    const draft = created.body.poll!;
    assert.equal(draft.status, "draft");
    assert.equal(draft.groupVersion, 1);
    assert.equal(draft.eligibleMemberCommitments.length, 2);
    assert.equal(draft.merkleRoot, new Group(baseCommitments()).root.toString());

    // Duplicate id conflicts.
    const conflict = await createDraft(base);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, "poll_exists");
  } finally {
    await stop(server);
  }
});

test("drafts are invisible publicly, visible to admins, and follow the lifecycle", async () => {
  const { server, base } = await serve(":memory:");
  try {
    const created = await createDraft(base);
    const id = created.body.poll!.id;

    // Not in the public catalog.
    const list = (await (await fetch(`${base}/api/polls`)).json() as { polls: PollSummary[] }).polls;
    assert.ok(!list.some(poll => poll.id === id));
    // Ordinary detail and results are 404.
    assert.equal((await fetch(`${base}/api/polls/${id}`)).status, 404);
    assert.equal((await fetch(`${base}/api/polls/${id}/results`)).status, 404);
    // But an admin can read it.
    const adminDetail = await api<{ poll: PollDetail }>(base, `/api/polls/${id}`);
    assert.equal(adminDetail.status, 200);
    assert.equal(adminDetail.body.poll.status, "draft");
    // The admin catalog includes it.
    const adminList = await api<{ polls: PollSummary[] }>(base, "/api/admin/polls");
    assert.ok(adminList.body.polls.some(poll => poll.id === id));

    // Voting on a draft is impossible (publicly it does not exist).
    const vote = await fetch(`${base}/api/polls/${id}/votes`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optionId: "opt-a", proof: {} })
    });
    assert.equal(vote.status, 404);

    // Illegal transition: draft -> closed is not allowed.
    const illegal = await transition(base, id, "closed", "draft");
    assert.equal(illegal.status, 409);
    assert.equal(illegal.body.error, "invalid_status_transition");
    // draft is unchanged.
    assert.equal((await api<{ poll: PollDetail }>(base, `/api/polls/${id}`)).body.poll.status, "draft");

    // Optimistic expectedStatus mismatch conflicts.
    const mismatch = await transition(base, id, "open", "open");
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.error, "status_conflict");

    // Legal chain draft -> open -> closed -> archived.
    const opened = await transition(base, id, "open", "draft");
    assert.equal(opened.status, 200);
    assert.equal(opened.body.poll.status, "open");
    assert.ok((await (await fetch(`${base}/api/polls`)).json() as { polls: PollSummary[] }).polls.some(poll => poll.id === id));

    // closed cannot reopen.
    const closed = await transition(base, id, "closed", "open");
    assert.equal(closed.status, 200);
    const reopen = await transition(base, id, "open", "closed");
    assert.equal(reopen.status, 409);
    assert.equal(reopen.body.error, "invalid_status_transition");
    // No-op / already-in-status is a conflict.
    const again = await transition(base, id, "closed", "closed");
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "status_conflict");
    const archived = await transition(base, id, "archived", "closed");
    assert.equal(archived.status, 200);
    assert.equal(archived.body.poll.status, "archived");
    // Terminal: archived cannot move.
    const terminal = await transition(base, id, "closed", "archived");
    assert.equal(terminal.status, 409);

    // Closed and archived results remain public.
    assert.equal((await fetch(`${base}/api/polls/${id}/results`)).status, 200);
  } finally {
    await stop(server);
  }
});

test("only open polls accept votes; members are editable only in draft or unvoted open, frozen on first vote", async () => {
  const { server, base } = await serve(":memory:");
  try {
    const id = "freeze-issue";
    assert.equal((await createDraft(base, { id })).status, 201);
    // Member change is allowed while draft.
    const joinDraft = await api(base, `/api/polls/${id}/group`, {
      method: "POST",
      body: JSON.stringify({ operation: "join", expectedVersion: 1, commitment: commitmentOf("veilvote-admin-member-03") })
    });
    assert.equal(joinDraft.status, 201);

    assert.equal((await transition(base, id, "open", "draft")).status, 200);
    const poll = (await (await fetch(`${base}/api/polls/${id}`)).json() as { poll: PollDetail }).poll;
    const [optionA] = poll.options;

    const identity = new Identity("veilvote-admin-member-01");
    const proof = await generateProof(identity, new Group(poll.eligibleMemberCommitments), optionA.id, id) as SemaphoreProofPayload;
    const accepted = await fetch(`${base}/api/polls/${id}/votes`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optionId: optionA.id, groupVersion: poll.groupVersion, proof })
    });
    assert.equal(accepted.status, 201);

    // First vote froze the group: a member change on an open, voted poll is 409.
    const frozen = await api(base, `/api/polls/${id}/group`, {
      method: "POST",
      body: JSON.stringify({ operation: "join", expectedVersion: poll.groupVersion, commitment: commitmentOf("veilvote-admin-member-04") })
    });
    assert.equal(frozen.status, 409);
    assert.equal(frozen.body.error, "group_frozen");

    // Close it; votes are rejected now.
    assert.equal((await transition(base, id, "closed", "open")).status, 200);
    const identity2 = new Identity("veilvote-admin-member-02");
    const closedPoll = (await (await fetch(`${base}/api/polls/${id}`)).json() as { poll: PollDetail }).poll;
    const lateProof = await generateProof(identity2, new Group(closedPoll.eligibleMemberCommitments), optionA.id, id) as SemaphoreProofPayload;
    const late = await fetch(`${base}/api/polls/${id}/votes`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optionId: optionA.id, groupVersion: closedPoll.groupVersion, proof: lateProof })
    });
    assert.equal(late.status, 409);
    assert.equal((await late.json() as { error: string }).error, "poll_closed");

    // Member changes are impossible once closed.
    const editClosed = await api(base, `/api/polls/${id}/group`, {
      method: "POST",
      body: JSON.stringify({ operation: "join", expectedVersion: poll.groupVersion, commitment: commitmentOf("veilvote-admin-member-04") })
    });
    assert.equal(editClosed.status, 409);
    assert.equal(editClosed.body.error, "poll_not_editable");
  } finally {
    await stop(server);
  }
});

test("at closesAt the close is persisted atomically and out-of-bounds votes are rejected, even concurrently", async () => {
  const { server, base } = await serve(":memory:");
  try {
    const id = "deadline-issue";
    // Already-expired window: published in the past, closesAt one second ago.
    assert.equal((await createDraft(base, {
      id,
      publishedAt: new Date(Date.now() - 3_600_000).toISOString(),
      closesAt: new Date(Date.now() - 1_000).toISOString()
    })).status, 201);
    assert.equal((await transition(base, id, "open", "draft")).status, 200);

    const poll = (await (await fetch(`${base}/api/polls/${id}`)).json() as { poll: PollDetail }).poll;
    // The public detail read already persisted the deadline close.
    assert.equal(poll.status, "closed");
    // A structurally valid payload is enough: the closed status is checked
    // before proof verification, so no prover run is needed for these rejects.
    const dummyProof = {
      merkleTreeDepth: 20, merkleTreeRoot: "1", message: "1", nullifier: "1", scope: "1",
      points: ["1", "2", "3", "4", "5", "6", "7", "8"]
    };
    const makeVote = (nullifier: string) => fetch(`${base}/api/polls/${id}/votes`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optionId: poll.options[0].id, groupVersion: poll.groupVersion, proof: { ...dummyProof, nullifier } })
    }).then(response => response.status);
    // Fire two out-of-bounds votes concurrently; transactions adjudicate on
    // the persisted status, so both are rejected and the close happens once.
    const statuses = await Promise.all([makeVote("11"), makeVote("22")]);
    assert.deepEqual([...statuses].sort(), [409, 409]);

    // The close is durable.
    const after = await api<{ poll: PollDetail }>(base, `/api/polls/${id}`);
    assert.equal(after.body.poll.status, "closed");
    // Results show zero accepted votes.
    const result = (await (await fetch(`${base}/api/polls/${id}/results`)).json() as { result: { total: number } }).result;
    assert.equal(result.total, 0);
  } finally {
    await stop(server);
  }
});

test("audit trail records authorized actions and failures without secrets, newest first, and survives restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "veilvote-admin-"));
  const path = join(directory, "veilvote.sqlite");
  try {
    const first = await serve(path);
    try {
      assert.equal((await createDraft(first.base, { id: "audited-issue" })).status, 201);
      // A business failure (illegal transition) is also audited.
      assert.equal((await transition(first.base, "audited-issue", "closed", "draft")).status, 409);
      assert.equal((await transition(first.base, "audited-issue", "open", "draft")).status, 200);
      // A rejected member change is audited.
      const badJoin = await api(first.base, "/api/polls/audited-issue/group", {
        method: "POST", body: JSON.stringify({ operation: "join", expectedVersion: 99, commitment: commitmentOf("veilvote-admin-member-09") })
      });
      assert.equal(badJoin.status, 409);

      const poll = (await (await fetch(`${first.base}/api/polls/audited-issue`)).json() as { poll: PollDetail }).poll;
      const identity = new Identity("veilvote-admin-member-01");
      const proof = await generateProof(identity, new Group(poll.eligibleMemberCommitments), poll.options[0].id, "audited-issue") as SemaphoreProofPayload;
      const vote = await fetch(`${first.base}/api/polls/audited-issue/votes`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optionId: poll.options[0].id, groupVersion: poll.groupVersion, proof })
      });
      assert.equal(vote.status, 201);
    } finally {
      await stop(first.server);
    }

    const second = await serve(path);
    try {
      const events = (await auditEvents(second.base)).body.events!;
      assert.ok(events.length >= 5);
      // Newest first: at is non-increasing.
      for (let index = 1; index < events.length; index += 1) {
        assert.ok(Date.parse(events[index - 1].at) >= Date.parse(events[index].at));
      }
      const actions = new Set(events.map(event => event.action));
      for (const action of ["poll_created", "status_changed", "members_changed", "vote_accepted"] as const) {
        assert.ok(actions.has(action), `missing audit action ${action}`);
      }
      // Failure events are present too.
      assert.ok(events.some(event => event.result === "failure" && event.action === "status_changed"));
      assert.ok(events.some(event => event.result === "failure" && event.action === "members_changed"));
      // No token, secret, proof or nullifier is ever recorded.
      const serialized = JSON.stringify(events);
      assert.ok(!serialized.includes(ADMIN_TOKEN));
      assert.ok(!serialized.includes("nullifier"));
      assert.ok(!serialized.includes("points"));

      // The draft-turned-open poll survived the restart.
      const poll = (await (await fetch(`${second.base}/api/polls/audited-issue`)).json() as { poll: PollDetail }).poll;
      assert.equal(poll.status, "open");
    } finally {
      await stop(second.server);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an open poll past its deadline is persisted closed on restart (recovery)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "veilvote-recovery-"));
  const path = join(directory, "veilvote.sqlite");
  try {
    const first = await serve(path);
    try {
      // Move a seeded open poll's deadline into the past while it is open.
      const db = new DatabaseSync(path);
      db.prepare("UPDATE polls SET closes_at = ? WHERE id = ?").run(new Date(Date.now() - 5_000).toISOString(), "community-garden-autumn");
      db.close();
    } finally {
      await stop(first.server);
    }
    const second = await serve(path);
    try {
      const poll = (await (await fetch(`${second.base}/api/polls/community-garden-autumn`)).json() as { poll: PollDetail }).poll;
      assert.equal(poll.status, "closed");
      const events = (await auditEvents(second.base)).body.events!;
      assert.ok(events.some(event => event.action === "status_changed" && event.detail.reason === "deadline_persisted"));
    } finally {
      await stop(second.server);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
