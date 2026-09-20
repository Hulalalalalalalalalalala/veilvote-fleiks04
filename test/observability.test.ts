import test from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../src/app.ts";
import { textToField } from "../src/voting.ts";
import type { MetricsReport } from "../src/observability.ts";
import type { AuditEvent } from "../src/types.ts";

const ADMIN_TOKEN = "test-admin-token";
const adminHeaders = { "Content-Type": "application/json", "X-Admin-Token": ADMIN_TOKEN };

interface TestServer {
  server: Server;
  base: string;
  lines: string[];
}

async function serve(options: {
  token?: string;
  logSink?: (line: string) => void;
  verifyProofImpl?: () => Promise<boolean>;
  sqlitePing?: () => void;
} = {}): Promise<TestServer> {
  const lines: string[] = [];
  const server = createApp(":memory:", undefined, {
    adminToken: options.token,
    logSink: options.logSink ?? (line => lines.push(line)),
    verifyProofImpl: options.verifyProofImpl,
    sqlitePing: options.sqlitePing
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, base: `http://127.0.0.1:${address.port}`, lines };
}
async function stop(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}

/** A structurally valid, poll-bound vote body; the cryptographic check is delegated to verifyProofImpl. */
async function voteBody(base: string, optionId = "weekday-evenings") {
  const detail = await (await fetch(`${base}/api/polls/community-garden-autumn`)).json() as {
    poll: { id: string; merkleRoot: string };
  };
  return {
    optionId,
    proof: {
      merkleTreeDepth: 20,
      merkleTreeRoot: detail.poll.merkleRoot,
      message: textToField(optionId),
      nullifier: "987654321",
      scope: textToField(detail.poll.id),
      points: ["1", "2", "3", "4", "5", "6", "7", "8"]
    }
  };
}

test("every /api answer gets a fresh server-generated X-Request-Id and spoofs are ignored", async () => {
  const { server, base, lines } = await serve();
  try {
    const first = await fetch(`${base}/api/health`);
    const id1 = first.headers.get("x-request-id");
    assert.match(id1 ?? "", /^[0-9a-f-]{36}$/);

    const second = await fetch(`${base}/api/health`, { headers: { "X-Request-Id": "spoofed-id" } });
    const id2 = second.headers.get("x-request-id");
    assert.notEqual(id2, "spoofed-id");
    assert.notEqual(id1, id2);

    // Error answers carry it too.
    const missing = await fetch(`${base}/api/polls/nope`);
    assert.equal(missing.headers.get("x-request-id")?.length, 36);

    // The log line uses the same server id.
    assert.ok(lines.some(line => JSON.parse(line).requestId === id1));
  } finally { await stop(server); }
});

test("access logs are single-line privacy-safe JSON with the fixed schema", async () => {
  const { server, base, lines } = await serve({ token: ADMIN_TOKEN });
  try {
    // Success, rejection, unauthorized and proof-rejected paths, each carrying
    // values that must never appear in a log line.
    await fetch(`${base}/api/health`);
    await fetch(`${base}/api/polls/community-garden-autumn/results`);
    await fetch(`${base}/api/admin/audit`, { headers: { "X-Admin-Token": "wrong" } });
    await fetch(`${base}/api/admin/audit?pollId=community-garden-autumn&from=not-a-date`, {
      headers: { "X-Admin-Token": ADMIN_TOKEN }
    });
    await fetch(`${base}/api/polls/community-garden-autumn/group`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ operation: "join", expectedVersion: 99, commitment: "12345678901234567890" })
    });
    await fetch(`${base}/api/polls/community-garden-autumn/votes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await voteBody(base))
    });

    assert.ok(lines.length >= 6);
    for (const line of lines) {
      assert.equal(line.endsWith("\n"), true, "one record per line");
      const record = JSON.parse(line) as Record<string, unknown>;
      for (const key of ["at", "requestId", "operation", "statusCode", "outcome", "durationMs"]) {
        assert.ok(key in record, `missing ${key}`);
      }
      assert.match(record.at as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.match(record.requestId as string, /^[0-9a-f-]{36}$/);
      assert.equal(typeof record.statusCode, "number");
      assert.ok(["success", "rejected", "unauthorized", "error"].includes(record.outcome as string));
      assert.equal(Number.isInteger(record.durationMs), true);
      assert.ok((record.durationMs as number) >= 0);
      const allowedExtra = new Set(["errorCode", "decision"]);
      for (const key of Object.keys(record)) assert.ok(["at", "requestId", "operation", "statusCode", "outcome", "durationMs", ...allowedExtra].includes(key));
    }

    // Failures carry the stable error code; 401 is the unauthorized outcome.
    const unauthorized = lines.map(line => JSON.parse(line)).find(r => r.statusCode === 401);
    assert.equal(unauthorized.outcome, "unauthorized");
    assert.equal(unauthorized.errorCode, "admin_unauthorized");
    const badTime = lines.map(line => JSON.parse(line)).find(r => r.errorCode === "invalid_time_range");
    assert.equal(badTime.operation, "audit_query");

    // Vote and membership changes carry the admission decision.
    const rejectedVote = lines.map(line => JSON.parse(line)).find(r => r.operation === "vote_submit" && r.statusCode === 422);
    assert.equal(rejectedVote.decision, "rejected");
    const rejectedGroup = lines.map(line => JSON.parse(line)).find(r => r.operation === "group_change" && r.statusCode === 409);
    assert.equal(rejectedGroup.decision, "conflict");

    // Nothing sensitive ever reaches the log: token, raw query, poll ids,
    // commitments, proofs, nullifiers, receipt ids.
    const dump = lines.join("");
    for (const secret of [ADMIN_TOKEN, "community-garden-autumn", "12345678901234567890", "987654321", "not-a-date", "points", "merkleTreeRoot"]) {
      assert.equal(dump.includes(secret), false, `log leaked ${secret}`);
    }
  } finally { await stop(server); }
});

test("a logging failure never changes the business response", async () => {
  const { server, base, lines } = await serve({ logSink: () => { throw new Error("disk full"); } });
  try {
    const response = await fetch(`${base}/api/polls`);
    assert.equal(response.status, 200);
    assert.ok((await response.json() as { polls: unknown[] }).polls.length >= 2);
    assert.equal(response.headers.get("x-request-id")?.length, 36);
    // The throwing sink wrote nothing; the response is completely unaffected.
    assert.equal(lines.length, 0);
  } finally { await stop(server); }
});

test("GET /api/admin/metrics requires a token, is unauthorized without auditing, and is never counted", async () => {
  const { server, base, lines } = await serve({ token: ADMIN_TOKEN });
  try {
    const missing = await fetch(`${base}/api/admin/metrics`);
    assert.equal(missing.status, 401);
    assert.equal((await missing.json() as { error: string }).error, "admin_unauthorized");
    const wrong = await fetch(`${base}/api/admin/metrics`, { headers: { "X-Admin-Token": "nope" } });
    assert.equal(wrong.status, 401);
    // The 401s left neither log lines nor audit rows.
    assert.equal(lines.length, 0);
    const audit = await fetch(`${base}/api/admin/audit`, { headers: { "X-Admin-Token": ADMIN_TOKEN } }).then(r => r.json()) as { events: AuditEvent[] };
    assert.equal(audit.events.length, 0);

    // A real request shows up; the metrics fetch itself never does.
    await fetch(`${base}/api/health`);
    const metricsResponse = await fetch(`${base}/api/admin/metrics`, { headers: { "X-Admin-Token": ADMIN_TOKEN } });
    assert.equal(metricsResponse.status, 200);
    const report = await metricsResponse.json() as MetricsReport;
    assert.match(report.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const operations = report.metrics.map(row => row.operation);
    assert.ok(operations.includes("health"));
    assert.equal(operations.includes("metrics"), false);

    // Repeated metrics calls still don't count themselves.
    for (let i = 0; i < 3; i += 1) await fetch(`${base}/api/admin/metrics`, { headers: { "X-Admin-Token": ADMIN_TOKEN } });
    const again = await (await fetch(`${base}/api/admin/metrics`, { headers: { "X-Admin-Token": ADMIN_TOKEN } })).json() as MetricsReport;
    assert.equal(again.metrics.some(row => row.operation === "metrics"), false);
  } finally { await stop(server); }
});

test("metrics aggregate by operation/statusCode/errorCode/decision with count, sumMs and maxMs", async () => {
  const { server, base } = await serve({ token: ADMIN_TOKEN });
  try {
    await fetch(`${base}/api/health`);
    await fetch(`${base}/api/health`);
    await fetch(`${base}/api/health`);
    await fetch(`${base}/api/admin/audit`, { headers: { "X-Admin-Token": "wrong" } });
    await fetch(`${base}/api/polls/missing`);
    await fetch(`${base}/api/polls/missing`);

    const report = await (await fetch(`${base}/api/admin/metrics`, { headers: { "X-Admin-Token": ADMIN_TOKEN } })).json() as MetricsReport;
    const row = (operation: string, statusCode: number) =>
      report.metrics.find(r => r.operation === operation && r.statusCode === statusCode);

    const health = row("health", 200)!;
    assert.equal(health.count, 3);
    assert.ok(health.sumMs >= health.maxMs);
    assert.ok(health.maxMs >= 0);
    assert.equal(health.errorCode, null);
    assert.equal(health.decision, null);

    const denied = row("audit_query", 401)!;
    assert.equal(denied.count, 1);
    assert.equal(denied.errorCode, "admin_unauthorized");

    const notFound = row("poll_detail", 404)!;
    assert.equal(notFound.count, 2);
    assert.equal(notFound.errorCode, "poll_not_found");

    // Rows are keyed on all four labels; no poll ids or other high-cardinality tags exist.
    for (const r of report.metrics) {
      for (const key of Object.keys(r)) assert.ok(["operation", "statusCode", "errorCode", "decision", "count", "sumMs", "maxMs"].includes(key));
      assert.equal(JSON.stringify(r).includes("missing"), false);
    }
  } finally { await stop(server); }
});

test("metrics live in memory: a restarted app reports only requests since start", async () => {
  const first = await serve({ token: ADMIN_TOKEN });
  try {
    await fetch(`${first.base}/api/health`);
    await fetch(`${first.base}/api/health`);
    const before = await (await fetch(`${first.base}/api/admin/metrics`, { headers: { "X-Admin-Token": ADMIN_TOKEN } })).json() as MetricsReport;
    assert.equal(before.metrics.find(r => r.operation === "health")!.count, 2);
    await stop(first.server);
  } finally { /* stopped below */ }

  const second = await serve({ token: ADMIN_TOKEN });
  try {
    const after = await (await fetch(`${second.base}/api/admin/metrics`, { headers: { "X-Admin-Token": ADMIN_TOKEN } })).json() as MetricsReport;
    assert.equal(after.metrics.length, 0);
  } finally { await stop(second.server); }
});

test("concurrent requests are all counted without loss", async () => {
  const { server, base } = await serve({ token: ADMIN_TOKEN });
  try {
    await Promise.all(Array.from({ length: 50 }, () => fetch(`${base}/api/health`)));
    const report = await (await fetch(`${base}/api/admin/metrics`, { headers: { "X-Admin-Token": ADMIN_TOKEN } })).json() as MetricsReport;
    assert.equal(report.metrics.find(r => r.operation === "health" && r.statusCode === 200)!.count, 50);
  } finally { await stop(server); }
});

test("health stays a pure liveness probe; ready reports sqlite ok and the proof engine idle", async () => {
  const { server, base } = await serve();
  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { service: "veilvote", status: "ok" });

    const ready = await fetch(`${base}/api/ready`);
    assert.equal(ready.status, 200);
    const body = await ready.json() as {
      service: string; status: string;
      checks: { name: string; status: string; errorCode?: string }[];
    };
    assert.equal(body.service, "veilvote");
    assert.equal(body.status, "ready");
    assert.deepEqual(body.checks.map(c => ({ name: c.name, status: c.status })), [
      { name: "sqlite", status: "ok" },
      { name: "proof_engine", status: "idle" }
    ]);
    // Checks carry no paths, stacks or other keys.
    for (const check of body.checks) {
      for (const key of Object.keys(check)) assert.ok(["name", "status", "errorCode"].includes(key));
    }
  } finally { await stop(server); }
});

test("a proof engine failure latches ready to 503 with a stable code and clears after recovery", async () => {
  let engineBroken = true;
  const { server, base } = await serve({
    verifyProofImpl: async () => {
      if (engineBroken) throw new Error("snarkjs worker exploded at /opt/secret/zkey.wasm");
      return true;
    }
  });
  try {
    // The vote still gets its normal business answer (422); observability faults never alter it.
    const vote = await fetch(`${base}/api/polls/community-garden-autumn/votes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await voteBody(base))
    });
    assert.equal(vote.status, 422);
    assert.equal((await vote.json() as { error: string }).error, "invalid_proof");

    const degraded = await (await fetch(`${base}/api/ready`)).json() as {
      status: string; checks: { name: string; status: string; errorCode?: string }[];
    };
    assert.equal(degraded.status, "not_ready");
    const proof = degraded.checks.find(c => c.name === "proof_engine")!;
    assert.equal(proof.status, "error");
    assert.equal(proof.errorCode, "proof_engine_failure");
    assert.equal(JSON.stringify(degraded).includes("/opt/secret"), false);

    // Engine recovers: the next vote verifies successfully and clears the latch.
    engineBroken = false;
    const retry = await fetch(`${base}/api/polls/community-garden-autumn/votes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await voteBody(base))
    });
    assert.equal(retry.status, 201);

    const healthy = await fetch(`${base}/api/ready`);
    assert.equal(healthy.status, 200);
    const body = await healthy.json() as { status: string; checks: { name: string; status: string }[] };
    assert.equal(body.status, "ready");
    assert.equal(body.checks.find(c => c.name === "proof_engine")!.status, "ok");
  } finally { await stop(server); }
});

test("a SQLite probe failure makes ready return 503 not_ready with no internals", async () => {
  const { server, base } = await serve({ sqlitePing: () => { throw new Error("SQLITE_CANTOPEN at /var/secret/db.sqlite"); } });
  try {
    const response = await fetch(`${base}/api/ready`);
    assert.equal(response.status, 503);
    const body = await response.json() as {
      status: string; checks: { name: string; status: string; errorCode?: string }[];
    };
    assert.equal(body.status, "not_ready");
    const sqlite = body.checks.find(c => c.name === "sqlite")!;
    assert.equal(sqlite.status, "error");
    assert.equal(sqlite.errorCode, "sqlite_unavailable");
    assert.equal(JSON.stringify(body).includes("/var/secret"), false);
  } finally { await stop(server); }
});
