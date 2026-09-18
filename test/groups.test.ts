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
import { openCatalog } from "../src/store.ts";
import { terminateProverWorkers } from "../src/voting.ts";
import type { GroupVersionSummary, PollDetail, SemaphoreProofPayload } from "../src/types.ts";

// Release the snarkjs worker pool so the test process can exit.
test.after(() => terminateProverWorkers());

const commitmentOf = (secret: string) => new Identity(secret).commitment.toString();

async function serve(databasePath: string): Promise<{ server: Server; base: string }> {
  const server = createApp(databasePath);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, base: `http://127.0.0.1:${address.port}` };
}
async function stop(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}
async function getPoll(base: string, id: string): Promise<PollDetail> {
  const response = await fetch(`${base}/api/polls/${encodeURIComponent(id)}`);
  assert.equal(response.status, 200);
  return ((await response.json()) as { poll: PollDetail }).poll;
}
async function postGroup(base: string, pollId: string, payload: unknown) {
  const response = await fetch(`${base}/api/polls/${encodeURIComponent(pollId)}/group`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof payload === "string" ? payload : JSON.stringify(payload)
  });
  return { status: response.status, body: await response.json() as { group?: GroupVersionSummary; error?: string; groupVersion?: number; merkleRoot?: string } };
}
async function postVote(base: string, pollId: string, payload: unknown) {
  const response = await fetch(`${base}/api/polls/${encodeURIComponent(pollId)}/votes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof payload === "string" ? payload : JSON.stringify(payload)
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
async function proofFor(secret: string, commitments: string[], optionId: string, pollId: string): Promise<SemaphoreProofPayload> {
  return generateProof(new Identity(secret), new Group(commitments), optionId, pollId) as Promise<SemaphoreProofPayload>;
}

test("fresh seed: every poll starts at immutable version 1 with a matching root", () => {
  const catalog = openCatalog(":memory:");
  try {
    for (const summary of catalog.list()) {
      const detail = catalog.get(summary.id)!;
      assert.equal(detail.groupVersion, 1);
      assert.equal(detail.frozen, false);
      assert.equal(detail.merkleRoot, new Group(detail.eligibleMemberCommitments).root.toString());
      assert.equal(detail.merkleRoot, catalog.versionRoot(detail.id, 1));
      assert.equal(detail.memberCount, 8);
    }
  } finally { catalog.close(); }
});

test("legacy database migrates the shared member table to per-poll v1 snapshots", () => {
  const directory = mkdtempSync(join(tmpdir(), "veilvote-migrate-"));
  const path = join(directory, "legacy.sqlite");
  try {
    // Build a database exactly like the pre-versioning schema.
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE polls (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL,
        description TEXT NOT NULL, organizer TEXT NOT NULL, status TEXT NOT NULL,
        published_at TEXT NOT NULL, closes_at TEXT NOT NULL, options_json TEXT NOT NULL
      );
      CREATE TABLE members (commitment TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE);
      CREATE TABLE votes (id TEXT PRIMARY KEY, poll_id TEXT NOT NULL, option_id TEXT NOT NULL, nullifier TEXT NOT NULL, accepted_at TEXT NOT NULL);
    `);
    const options = JSON.stringify([{ id: "opt-a", label: "A" }, { id: "opt-b", label: "B" }]);
    const insertPoll = db.prepare("INSERT INTO polls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const id of ["legacy-voted", "legacy-open"]) {
      insertPoll.run(id, "t", "s", "d", "o", "open", "2026-09-01T00:00:00Z", "2099-01-01T00:00:00Z", options);
    }
    const commitments = [commitmentOf("legacy-member-01"), commitmentOf("legacy-member-02"), commitmentOf("legacy-member-03")];
    commitments.forEach((commitment, index) => db.prepare("INSERT INTO members VALUES (?, ?)").run(commitment, index));
    db.prepare("INSERT INTO votes VALUES (?, ?, ?, ?, ?)").run("receipt-1", "legacy-voted", "opt-a", "nullifier-x", "2026-09-10T00:00:00Z");
    db.close();

    const catalog = openCatalog(path);
    try {
      const voted = catalog.get("legacy-voted")!;
      assert.equal(voted.groupVersion, 1);
      assert.equal(voted.frozen, true, "polls that already held votes migrate frozen");
      assert.deepEqual(voted.eligibleMemberCommitments, commitments);
      assert.equal(voted.merkleRoot, new Group(commitments).root.toString());
      const open = catalog.get("legacy-open")!;
      assert.equal(open.frozen, false);
      assert.deepEqual(open.eligibleMemberCommitments, commitments);
      const migrated = new DatabaseSync(path);
      assert.equal(migrated.prepare("SELECT name FROM sqlite_master WHERE name = 'members'").get(), undefined);
      assert.equal((migrated.prepare("SELECT group_version FROM votes WHERE id = 'receipt-1'").get() as { group_version: number }).group_version, 1);
      migrated.close();
    } finally { catalog.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("group endpoint: join / rotate / revoke append immutable versions with 201 summaries", async () => {
  const { server, base } = await serve(":memory:");
  try {
    const pollId = "community-garden-autumn";
    const initial = await getPoll(base, pollId);
    assert.equal(initial.groupVersion, 1);
    const v1Root = initial.merkleRoot;
    const member08 = commitmentOf("veilvote-demo-member-08");
    const member09 = commitmentOf("veilvote-demo-member-09");
    const member10 = commitmentOf("veilvote-demo-member-10");

    let r = await postGroup(base, pollId, { operation: "join", expectedVersion: 1, commitment: member09 });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.group, { pollId, groupVersion: 2, merkleRoot: r.body.group!.merkleRoot, memberCount: 9, frozen: false });
    assert.notEqual(r.body.group.merkleRoot, v1Root);

    // rotate replaces the commitment in place: count is stable, index preserved.
    r = await postGroup(base, pollId, { operation: "rotate", expectedVersion: 2, oldCommitment: member08, newCommitment: member10 });
    assert.equal(r.status, 201);
    assert.equal(r.body.group!.groupVersion, 3);
    assert.equal(r.body.group!.memberCount, 9);
    const v3 = await getPoll(base, pollId);
    assert.equal(v3.eligibleMemberCommitments[7], member10);
    assert.ok(!v3.eligibleMemberCommitments.includes(member08));
    assert.equal(v3.merkleRoot, new Group(v3.eligibleMemberCommitments).root.toString());

    // revoke removes a member and bumps the version again.
    r = await postGroup(base, pollId, { operation: "revoke", expectedVersion: 3, commitment: commitmentOf("veilvote-demo-member-07") });
    assert.equal(r.status, 201);
    assert.equal(r.body.group!.groupVersion, 4);
    assert.equal(r.body.group!.memberCount, 8);

    // Superseded snapshots remain immutable; detail reports the newest root.
    assert.equal((await getPoll(base, pollId)).merkleRoot, r.body.group!.merkleRoot);
  } finally {
    await stop(server);
  }
});

test("group endpoint: 404 / 400 / 409 validation and optimistic version conflicts", async () => {
  const { server, base } = await serve(":memory:");
  try {
    const pollId = "community-garden-autumn";
    const poll = await getPoll(base, pollId);
    const member09 = commitmentOf("veilvote-demo-member-09");

    assert.equal((await postGroup(base, "missing-poll", { operation: "join", expectedVersion: 1, commitment: member09 })).status, 404);
    assert.equal((await fetch(`${base}/api/polls/${pollId}/group`)).status, 405);
    assert.equal((await postGroup(base, pollId, "not-json{")).status, 400);
    assert.equal((await postGroup(base, pollId, {})).status, 400);
    assert.equal((await postGroup(base, pollId, { operation: "expel", expectedVersion: 1, commitment: member09 })).status, 400);
    assert.equal((await postGroup(base, pollId, { operation: "join", expectedVersion: "1", commitment: member09 })).status, 400);
    assert.equal((await postGroup(base, pollId, { operation: "join", expectedVersion: 0, commitment: member09 })).status, 400);
    assert.equal((await postGroup(base, pollId, { operation: "join", expectedVersion: 1, commitment: "0" })).status, 400);
    assert.equal((await postGroup(base, pollId, { operation: "join", expectedVersion: 1, commitment: "not-a-field-element" })).status, 400);
    assert.equal((await postGroup(base, pollId, { operation: "join", expectedVersion: 1, commitment: poll.eligibleMemberCommitments[0] })).status, 400);
    assert.equal((await postGroup(base, pollId, { operation: "rotate", expectedVersion: 1, oldCommitment: member09, newCommitment: commitmentOf("veilvote-demo-member-10") })).status, 400);
    assert.equal((await postGroup(base, pollId, { operation: "revoke", expectedVersion: 1, commitment: member09 })).status, 400);

    // Stale expectedVersion: refreshable conflict carrying the new snapshot.
    const joined = await postGroup(base, pollId, { operation: "join", expectedVersion: 1, commitment: member09 });
    assert.equal(joined.status, 201);
    const stale = await postGroup(base, pollId, { operation: "join", expectedVersion: 1, commitment: commitmentOf("veilvote-demo-member-10") });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "group_version_changed");
    assert.equal(stale.body.groupVersion, 2);
    assert.equal(stale.body.merkleRoot, joined.body.group!.merkleRoot);

    // Duplicate new commitment on rotate is a format-level 400.
    const dup = await postGroup(base, pollId, { operation: "rotate", expectedVersion: 2, oldCommitment: poll.eligibleMemberCommitments[0], newCommitment: poll.eligibleMemberCommitments[1] });
    assert.equal(dup.status, 400);
    assert.equal(dup.body.error, "duplicate_commitment");

    // The group must never end up empty: revoke down to one, then the last is refused.
    let version = 2;
    for (let i = 0; i < 9; i++) {
      const current = await getPoll(base, pollId);
      const outcome = await postGroup(base, pollId, { operation: "revoke", expectedVersion: version, commitment: current.eligibleMemberCommitments[0] });
      version += 1;
      if (current.eligibleMemberCommitments.length === 1) {
        assert.equal(outcome.status, 400);
        assert.equal(outcome.body.error, "empty_group");
        break;
      }
      assert.equal(outcome.status, 201);
    }
  } finally {
    await stop(server);
  }
});

test("versions and freeze survive restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "veilvote-group-restart-"));
  const path = join(directory, "veilvote.sqlite");
  try {
    const first = await serve(path);
    try {
      const r = await postGroup(first.base, "shared-space-improvement", { operation: "join", expectedVersion: 1, commitment: commitmentOf("veilvote-demo-member-09") });
      assert.equal(r.status, 201);
    } finally { await stop(first.server); }
    const second = await serve(path);
    try {
      const poll = await getPoll(second.base, "shared-space-improvement");
      assert.equal(poll.groupVersion, 2);
      assert.equal(poll.memberCount, 9);
      assert.equal(poll.frozen, false);
      assert.ok(poll.eligibleMemberCommitments.includes(commitmentOf("veilvote-demo-member-09")));
    } finally { await stop(second.server); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("votes: stale snapshot 409, current snapshot 201 and freezes, unknown root 422", async () => {
  const { server, base } = await serve(":memory:");
  try {
    const pollId = "shared-space-improvement";
    const v1 = await getPoll(base, pollId);
    const option = v1.options[0];
    const joined = await postGroup(base, pollId, { operation: "join", expectedVersion: 1, commitment: commitmentOf("veilvote-demo-member-09") });
    assert.equal(joined.status, 201);
    const v2 = await getPoll(base, pollId);

    // Proof against the v1 snapshot, client pins v1: refreshable conflict.
    const staleProof = await proofFor("veilvote-demo-member-01", v1.eligibleMemberCommitments, option.id, pollId);
    let r = await postVote(base, pollId, { optionId: option.id, proof: staleProof, groupVersion: 1 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "group_version_changed");
    assert.equal(r.body.groupVersion, 2);

    // Legacy client without groupVersion: server resolves the root, same verdict.
    r = await postVote(base, pollId, { optionId: option.id, proof: staleProof });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "group_version_changed");

    // Proof for an unknown root while pinning the current version is 422.
    const unknownRootProof = await proofFor("veilvote-demo-member-02", [...v2.eligibleMemberCommitments, commitmentOf("veilvote-demo-member-11")], option.id, pollId);
    r = await postVote(base, pollId, { optionId: option.id, proof: unknownRootProof, groupVersion: 2 });
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "proof_binding_mismatch");

    // Malformed groupVersion is 400.
    r = await postVote(base, pollId, { optionId: option.id, proof: staleProof, groupVersion: "2" });
    assert.equal(r.status, 400);

    // Fresh proof at v2 freezes the group inside the vote transaction.
    const fresh = await proofFor("veilvote-demo-member-01", v2.eligibleMemberCommitments, option.id, pollId);
    r = await postVote(base, pollId, { optionId: option.id, proof: fresh, groupVersion: 2 });
    assert.equal(r.status, 201);
    const receipt = r.body.receipt as { groupVersion: number; nullifier: string };
    assert.equal(receipt.groupVersion, 2);

    const frozen = await getPoll(base, pollId);
    assert.equal(frozen.frozen, true);
    assert.equal(frozen.groupVersion, 2);

    // Replay: same nullifier stays rejected across the frozen snapshot.
    r = await postVote(base, pollId, { optionId: option.id, proof: await proofFor("veilvote-demo-member-01", v2.eligibleMemberCommitments, option.id, pollId), groupVersion: 2 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "duplicate_nullifier");

    // Any later membership change is refused.
    r = await postGroup(base, pollId, { operation: "join", expectedVersion: 2, commitment: commitmentOf("veilvote-demo-member-12") });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "group_frozen");
  } finally {
    await stop(server);
  }
});

test("concurrent first vote and group change: exactly one side wins", async () => {
  const { server, base } = await serve(":memory:");
  try {
    const pollId = "community-garden-autumn";
    const v1 = await getPoll(base, pollId);
    const proof = await proofFor("veilvote-demo-member-04", v1.eligibleMemberCommitments, v1.options[0].id, pollId);
    const [voteResult, changeResult] = await Promise.all([
      postVote(base, pollId, { optionId: v1.options[0].id, proof, groupVersion: 1 }),
      postGroup(base, pollId, { operation: "join", expectedVersion: 1, commitment: commitmentOf("veilvote-demo-member-09") })
    ]);
    const voteWon = voteResult.status === 201;
    const changeWon = changeResult.status === 201;
    assert.notEqual(voteWon, changeWon, "exactly one of the concurrent operations must succeed");
    if (voteWon) {
      assert.equal(changeResult.body.error, "group_frozen");
      assert.equal((await getPoll(base, pollId)).frozen, true);
    } else {
      assert.equal(voteResult.body.error, "group_version_changed");
      assert.equal(changeResult.body.group!.groupVersion, 2);
      assert.equal((await getPoll(base, pollId)).frozen, false);
    }
  } finally {
    await stop(server);
  }
});

test("store ordering: freeze blocks changes; advanced version rejects old roots; nullifier dedup spans versions", () => {
  const directory = mkdtempSync(join(tmpdir(), "veilvote-store-order-"));
  const path = join(directory, "store.sqlite");
  try {
    // Vote first: the snapshot freezes and every later change fails.
    let catalog = openCatalog(path);
    const pollId = "community-garden-autumn";
    const v1Root = catalog.get(pollId)!.merkleRoot;
    const vote = catalog.commitVote(pollId, catalog.get(pollId)!.options[0].id, "nullifier-A", v1Root);
    assert.equal(vote.ok, true);
    const blocked = catalog.applyGroupChange(pollId, "join", 1, { commitment: commitmentOf("veilvote-demo-member-09") });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, "group_frozen");
    catalog.close();

    // Rewind-freeze scenario on a second file: change first, then an old-root vote loses.
    const path2 = join(directory, "store2.sqlite");
    catalog = openCatalog(path2);
    const changed = catalog.applyGroupChange(pollId, "join", 1, { commitment: commitmentOf("veilvote-demo-member-09") });
    assert.equal(changed.ok, true);
    const stale = catalog.commitVote(pollId, catalog.get(pollId)!.options[0].id, "nullifier-B", v1Root);
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, "historical_version");

    // Cross-version dedup: hand-craft a v3 snapshot on the same poll and replay
    // the nullifier used at v2.
    const v2Root = catalog.get(pollId)!.merkleRoot;
    const firstAtV2 = catalog.commitVote(pollId, catalog.get(pollId)!.options[0].id, "nullifier-C", v2Root);
    assert.equal(firstAtV2.ok, true);
    catalog.close();
    const db = new DatabaseSync(path2);
    db.exec("BEGIN");
    const v3Commitments = (db.prepare("SELECT commitment FROM group_members WHERE poll_id = ? AND version = 2 ORDER BY position").all(pollId) as { commitment: string }[]).map(row => row.commitment);
    v3Commitments.push(commitmentOf("veilvote-demo-member-10"));
    const v3Root = new Group(v3Commitments).root.toString();
    db.prepare("INSERT INTO group_versions (poll_id, version, merkle_root, created_at) VALUES (?, 3, ?, ?)").run(pollId, v3Root, new Date().toISOString());
    v3Commitments.forEach((commitment, index) => db.prepare("INSERT INTO group_members (poll_id, version, position, commitment) VALUES (?, 3, ?, ?)").run(pollId, index, commitment));
    db.prepare("UPDATE poll_groups SET current_version = 3, merkle_root = ?, frozen = 0 WHERE poll_id = ?").run(v3Root, pollId);
    db.exec("COMMIT");
    db.close();
    catalog = openCatalog(path2);
    const replay = catalog.commitVote(pollId, catalog.get(pollId)!.options[0].id, "nullifier-C", v3Root);
    assert.equal(replay.ok, false);
    assert.equal(replay.reason, "duplicate_nullifier");
    catalog.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
