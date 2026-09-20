import test from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { Identity } from "@semaphore-protocol/identity";
import { Group } from "@semaphore-protocol/group";
import { generateProof } from "@semaphore-protocol/proof";
import { createApp } from "../src/app.ts";
import { terminateProverWorkers } from "../src/voting.ts";
import type { AuditEvent, PollDetail, SemaphoreProofPayload, VoteReceipt } from "../src/types.ts";

// Release the snarkjs worker pool so the test process can exit.
test.after(() => terminateProverWorkers());

const ADMIN_TOKEN = "observability-admin-token";
const adminHeaders = { "Content-Type": "application/json", "X-Admin-Token": ADMIN_TOKEN };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface LogEntry {
  at: string; requestId: string; operation: string; statusCode: number;
  outcome: string; durationMs: number; errorCode?: string; decision?: string;
}
interface MetricRow {
  operation: string; statusCode: number; errorCode?: string; decision?: string;
  count: number; sumMs: number; maxMs: number;
}

async function serve(databasePath: string, token?: string, lines: string[] = []): Promise<{ server: Server; base: string; lines: string[] }> {
  const server = createApp(databasePath, undefined, { adminToken: token, logger: line => lines.push(line) });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, base: `http://127.0.0.1:${address.port}`, lines };
}
async function stop(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}
function entries(lines: string[]): LogEntry[] {
  return lines.map(line => {
    assert.equal(line.includes("\n"), false, "the request log must be single-line JSON");
    return JSON.parse(line) as LogEntry;
  });
}
async function pollDetail(base: string, id: string): Promise<PollDetail> {
  const response = await fetch(`${base}/api/polls/${encodeURIComponent(id)}`);
  assert.equal(response.status, 200);
  return ((await response.json()) as { poll: PollDetail }).poll;
}
async function proofFor(secret: string, optionId: string, poll: PollDetail): Promise<SemaphoreProofPayload> {
  const identity = new Identity(secret);
  const group = new Group(poll.eligibleMemberCommitments);
  return generateProof(identity, group, optionId, poll.id) as Promise<SemaphoreProofPayload>;
}
async function postVote(base: string, pollId: string, payload: unknown) {
  const response = await fetch(`${base}/api/polls/${encodeURIComponent(pollId)}/votes`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  return { status: response.status, body: await response.json() as { receipt?: VoteReceipt; error?: string } };
}

test("every /api request gets a server-generated X-Request-Id and one privacy-safe log line", async () => {
  const { server, base, lines } = await serve(":memory:", ADMIN_TOKEN);
  try {
    // The client's own X-Request-Id is ignored; the server always generates one.
    const health = await fetch(`${base}/api/health`, { headers: { "X-Request-Id": "client-supplied" } });
    assert.equal(health.status, 200);
    const requestId = health.headers.get("x-request-id");
    assert.ok(requestId && UUID.test(requestId));
    assert.notEqual(requestId, "client-supplied");
    await health.text();

    // Rejected, unauthorized and not-found requests are logged too.
    await fetch(`${base}/api/polls/missing-poll`).then(r => r.text());
    await fetch(`${base}/api/admin/audit`).then(r => r.text());
    const badVote = await fetch(`${base}/api/polls/community-garden-autumn/votes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "not json{" });
    assert.equal(badVote.status, 400);
    await badVote.text();
    // Static files are outside the /api log.
    await fetch(`${base}/nonexistent.css`).then(r => r.text());

    const log = entries(lines);
    assert.equal(log.length, 4);
    const healthEntry = log.find(entry => entry.operation === "health")!;
    assert.equal(healthEntry.requestId, requestId);
    assert.equal(healthEntry.statusCode, 200);
    assert.equal(healthEntry.outcome, "success");
    assert.ok(Number.isInteger(healthEntry.durationMs) && healthEntry.durationMs >= 0);
    assert.ok(!Number.isNaN(Date.parse(healthEntry.at)));
    const missing = log.find(entry => entry.operation === "poll_get")!;
    assert.deepEqual([missing.statusCode, missing.outcome, missing.errorCode], [404, "rejected", "poll_not_found"]);
    const unauthorized = log.find(entry => entry.operation === "audit_query")!;
    assert.deepEqual([unauthorized.statusCode, unauthorized.outcome, unauthorized.errorCode], [401, "unauthorized", "admin_unauthorized"]);
    const invalid = log.find(entry => entry.operation === "vote_cast")!;
    assert.deepEqual([invalid.statusCode, invalid.outcome, invalid.errorCode], [400, "rejected", "invalid_json"]);

    // Only the privacy-safe fields ever appear; nothing sensitive leaks.
    for (const entry of log) {
      assert.ok(Object.keys(entry).every(key => ["at", "requestId", "operation", "statusCode", "outcome", "durationMs", "errorCode", "decision"].includes(key)));
    }
    const blob = lines.join("\n");
    assert.equal(blob.includes(ADMIN_TOKEN), false);
    assert.equal(blob.includes("community-garden-autumn"), false);
    assert.equal(blob.includes("missing-poll"), false);
    assert.equal(blob.includes("client-supplied"), false);
  } finally { await stop(server); }
});

test("GET /api/ready probes SQLite and the proof engine with stable, opaque checks", async () => {
  const { server, base } = await serve(":memory:", ADMIN_TOKEN);
  try {
    const first = await fetch(`${base}/api/ready`);
    assert.equal(first.status, 200);
    const ready = await first.json() as { service: string; status: string; checks: Record<string, { status: string; errorCode?: string }> };
    assert.equal(ready.service, "veilvote");
    assert.equal(ready.status, "ready");
    assert.deepEqual(ready.checks.sqlite, { status: "ok" });
    // No verification has run yet: the engine reports idle, not ok.
    assert.deepEqual(ready.checks.proofEngine, { status: "idle" });
    // Checks carry only name/status/stable error code — no paths or stacks.
    assert.equal(JSON.stringify(ready.checks).includes("/"), false);
    assert.equal((await fetch(`${base}/api/ready`, { method: "POST" })).status, 405);

    // A successful proof verification marks the engine ok.
    const poll = await pollDetail(base, "community-garden-autumn");
    const proof = await proofFor("veilvote-demo-member-01", poll.options[0].id, poll);
    assert.equal((await postVote(base, poll.id, { optionId: poll.options[0].id, proof })).status, 201);
    const after = await (await fetch(`${base}/api/ready`)).json() as { status: string; checks: Record<string, { status: string }> };
    assert.equal(after.status, "ready");
    assert.equal(after.checks.proofEngine.status, "ok");

    // Liveness stays liveness: health never reflects dependency state.
    const health = await (await fetch(`${base}/api/health`)).json() as { status: string };
    assert.equal(health.status, "ok");
  } finally { await stop(server); }
});

test("concurrent vote/group adjudication is recorded as the request decision", async () => {
  const { server, base, lines } = await serve(":memory:", ADMIN_TOKEN);
  try {
    const poll = await pollDetail(base, "community-garden-autumn");
    const proof = await proofFor("veilvote-demo-member-02", poll.options[0].id, poll);
    assert.equal((await postVote(base, poll.id, { optionId: poll.options[0].id, proof, groupVersion: poll.groupVersion })).status, 201);

    // The first vote froze the group: a member change now loses the race.
    const joiner = new Identity("veilvote-demo-member-09").commitment.toString();
    const edit = await fetch(`${base}/api/polls/${poll.id}/group`, {
      method: "POST", headers: adminHeaders,
      body: JSON.stringify({ operation: "join", expectedVersion: poll.groupVersion, commitment: joiner })
    });
    assert.equal(edit.status, 409);
    assert.equal((await edit.json() as { error: string }).error, "group_frozen");

    // A replayed nullifier and a stale group version lose their races too.
    const replay = await postVote(base, poll.id, { optionId: poll.options[1].id, proof: await proofFor("veilvote-demo-member-02", poll.options[1].id, poll) });
    assert.equal(replay.status, 409);
    const stale = await postVote(base, poll.id, { optionId: poll.options[1].id, proof: await proofFor("veilvote-demo-member-03", poll.options[1].id, poll), groupVersion: poll.groupVersion + 1 });
    assert.equal(stale.status, 409);

    const log = entries(lines);
    const accepted = log.filter(entry => entry.operation === "vote_cast" && entry.statusCode === 201);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].decision, "accepted");
    const frozen = log.find(entry => entry.operation === "group_change" && entry.statusCode === 409)!;
    assert.equal(frozen.decision, "group_frozen");
    const duplicate = log.find(entry => entry.operation === "vote_cast" && entry.errorCode === "duplicate_nullifier")!;
    assert.equal(duplicate.decision, "duplicate_nullifier");
    const staleEntry = log.find(entry => entry.operation === "vote_cast" && entry.errorCode === "group_version_changed")!;
    assert.equal(staleEntry.decision, "group_version_changed");
    // Decisions never carry the nullifier, commitments or the poll id.
    const blob = lines.join("\n");
    for (const sensitive of [proof.nullifier, joiner, poll.id, ADMIN_TOKEN]) assert.equal(blob.includes(sensitive), false);
  } finally { await stop(server); }
});

test("GET /api/admin/metrics aggregates in memory, excludes itself and stays privacy-safe", async () => {
  const { server, base } = await serve(":memory:", ADMIN_TOKEN);
  try {
    // Unauthorized: 401, and no audit event is written.
    const denied = await fetch(`${base}/api/admin/metrics`);
    assert.equal(denied.status, 401);
    assert.equal((await denied.json() as { error: string }).error, "admin_unauthorized");
    const wrong = await fetch(`${base}/api/admin/metrics`, { headers: { "X-Admin-Token": "nope" } });
    assert.equal(wrong.status, 401);
    assert.equal((await fetch(`${base}/api/admin/metrics`, { method: "POST", headers: adminHeaders })).status, 405);

    // Generate traffic, including a concurrent burst to prove no update is lost.
    await fetch(`${base}/api/health`).then(r => r.text());
    await fetch(`${base}/api/polls/missing-poll`).then(r => r.text());
    await Promise.all(Array.from({ length: 8 }, () => fetch(`${base}/api/health`).then(r => r.text())));

    const metricsOf = async () => {
      const response = await fetch(`${base}/api/admin/metrics`, { headers: { "X-Admin-Token": ADMIN_TOKEN } });
      assert.equal(response.status, 200);
      return response.json() as Promise<{ service: string; startedAt: string; metrics: MetricRow[] }>;
    };
    const snapshot = await metricsOf();
    assert.equal(snapshot.service, "veilvote");
    assert.ok(!Number.isNaN(Date.parse(snapshot.startedAt)));
    const health = snapshot.metrics.find(row => row.operation === "health" && row.statusCode === 200)!;
    assert.equal(health.count, 9);
    assert.ok(health.sumMs >= health.maxMs && health.maxMs >= 0);
    const missing = snapshot.metrics.find(row => row.operation === "poll_get" && row.statusCode === 404)!;
    assert.deepEqual([missing.count, missing.errorCode], [1, "poll_not_found"]);
    // The metrics endpoint never counts itself, even across repeated scrapes.
    await metricsOf();
    const again = await metricsOf();
    assert.equal(again.metrics.some(row => row.operation === "admin_metrics"), false);
    assert.equal(again.metrics.find(row => row.operation === "health")!.count, 9);
    // Labels stay low-cardinality and privacy-safe: no poll ids, tokens, query text.
    const blob = JSON.stringify(again);
    for (const sensitive of ["missing-poll", "community-garden-autumn", ADMIN_TOKEN]) assert.equal(blob.includes(sensitive), false);

    // Unauthorized scrapes left no audit events behind.
    const audit = await fetch(`${base}/api/admin/audit`, { headers: { "X-Admin-Token": ADMIN_TOKEN } }).then(r => r.json()) as { events: AuditEvent[] };
    assert.equal(audit.events.length, 0);
  } finally { await stop(server); }
});

test("metrics are in-memory only: a restart resets them", async () => {
  const first = await serve(":memory:", ADMIN_TOKEN);
  try {
    await fetch(`${first.base}/api/health`).then(r => r.text());
    const snapshot = await (await fetch(`${first.base}/api/admin/metrics`, { headers: { "X-Admin-Token": ADMIN_TOKEN } })).json() as { metrics: MetricRow[] };
    assert.ok(snapshot.metrics.length > 0);
  } finally { await stop(first.server); }
  const second = await serve(":memory:", ADMIN_TOKEN);
  try {
    const snapshot = await (await fetch(`${second.base}/api/admin/metrics`, { headers: { "X-Admin-Token": ADMIN_TOKEN } })).json() as { metrics: MetricRow[] };
    assert.equal(snapshot.metrics.length, 0);
  } finally { await stop(second.server); }
});
