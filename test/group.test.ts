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
import type { GroupVersionSummary, PollDetail, SemaphoreProofPayload, VoteReceipt } from "../src/types.ts";

// Release the snarkjs worker pool so the test process can exit.
test.after(() => terminateProverWorkers());

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
async function pollDetail(base: string, id: string): Promise<PollDetail> {
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
  return { status: response.status, body: await response.json() as { group?: GroupVersionSummary; error?: string } };
}
async function postVote(base: string, pollId: string, payload: unknown) {
  const response = await fetch(`${base}/api/polls/${encodeURIComponent(pollId)}/votes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof payload === "string" ? payload : JSON.stringify(payload)
  });
  return { status: response.status, body: await response.json() as { receipt?: VoteReceipt; error?: string } };
}
async function proofFor(secret: string, optionId: string, poll: PollDetail, commitments = poll.eligibleMemberCommitments): Promise<SemaphoreProofPayload> {
  const identity = new Identity(secret);
  const group = new Group(commitments);
  return generateProof(identity, group, optionId, poll.id) as Promise<SemaphoreProofPayload>;
}
const commitmentOf = (secret: string) => new Identity(secret).commitment.toString();

test("group operations create immutable, validated versions", async () => {
  const { server, base } = await serve(":memory:");
  try {
    const poll = await pollDetail(base, "community-garden-autumn");
    // Version 1 snapshot: commitments, version and Merkle root from one source.
    assert.equal(poll.groupVersion, 1);
    assert.equal(poll.eligibleMemberCommitments.length, 8);
    assert.equal(poll.merkleRoot, new Group(poll.eligibleMemberCommitments).root.toString());

    // Malformed requests and unknown polls.
    assert.equal((await postGroup(base, "missing-poll", { operation: "join", expectedVersion: 1, commitment: "5" })).status, 404);
    assert.equal((await postGroup(base, poll.id, "not json{")).status, 400);
    assert.equal((await postGroup(base, poll.id, { operation: "join", expectedVersion: 1 })).status, 400);
    assert.equal((await postGroup(base, poll.id, { operation: "explode", expectedVersion: 1, commitment: "5" })).status, 400);
    assert.equal((await postGroup(base, poll.id, { operation: "join", expectedVersion: "1", commitment: "5" })).status, 400);
    assert.equal((await postGroup(base, poll.id, { operation: "join", expectedVersion: 1, commitment: "not-a-commitment" })).status, 400);
    assert.equal((await fetch(`${base}/api/polls/${poll.id}/group`)).status, 405);

    // join appends and bumps the version.
    const joiner = commitmentOf("veilvote-demo-member-09");
    const joined = await postGroup(base, poll.id, { operation: "join", expectedVersion: 1, commitment: joiner });
    assert.equal(joined.status, 201);
    assert.equal(joined.body.group!.version, 2);
    assert.equal(joined.body.group!.memberCount, 9);
    assert.notEqual(joined.body.group!.merkleRoot, poll.merkleRoot);
    assert.equal(joined.body.group!.commitments.at(-1), joiner);
    // Duplicate commitments are rejected.
    const duplicate = await postGroup(base, poll.id, { operation: "join", expectedVersion: 2, commitment: joiner });
    assert.equal(duplicate.status, 400);
    assert.equal(duplicate.body.error, "duplicate_commitment");
    // Stale expectedVersion conflicts.
    const stale = await postGroup(base, poll.id, { operation: "join", expectedVersion: 1, commitment: commitmentOf("veilvote-demo-member-10") });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "group_version_changed");

    // rotate replaces in place.
    const rotatedTo = commitmentOf("veilvote-demo-member-10");
    const rotated = await postGroup(base, poll.id, { operation: "rotate", expectedVersion: 2, oldCommitment: joiner, newCommitment: rotatedTo });
    assert.equal(rotated.status, 201);
    assert.equal(rotated.body.group!.version, 3);
    assert.equal(rotated.body.group!.memberCount, 9);
    assert.equal(rotated.body.group!.commitments[8], rotatedTo);
    assert.ok(!rotated.body.group!.commitments.includes(joiner));
    // rotate with an unknown old commitment or an existing new one fails.
    assert.equal((await postGroup(base, poll.id, { operation: "rotate", expectedVersion: 3, oldCommitment: joiner, newCommitment: "7" })).body.error, "commitment_not_found");
    assert.equal((await postGroup(base, poll.id, { operation: "rotate", expectedVersion: 3, oldCommitment: rotatedTo, newCommitment: poll.eligibleMemberCommitments[0] })).body.error, "duplicate_commitment");

    // revoke removes; the detail endpoint reflects the current version.
    const revoked = await postGroup(base, poll.id, { operation: "revoke", expectedVersion: 3, commitment: rotatedTo });
    assert.equal(revoked.status, 201);
    assert.equal(revoked.body.group!.version, 4);
    assert.deepEqual(revoked.body.group!.commitments, poll.eligibleMemberCommitments);
    assert.equal(revoked.body.group!.merkleRoot, poll.merkleRoot);
    const detail = await pollDetail(base, poll.id);
    assert.equal(detail.groupVersion, 4);
    assert.equal(detail.merkleRoot, poll.merkleRoot);
    assert.deepEqual(detail.eligibleMemberCommitments, poll.eligibleMemberCommitments);
    assert.equal((await postGroup(base, poll.id, { operation: "revoke", expectedVersion: 4, commitment: rotatedTo })).body.error, "commitment_not_found");

    // The group may not be emptied: revoke the other poll down to one member.
    const other = await pollDetail(base, "shared-space-improvement");
    let version = other.groupVersion;
    let remaining = other.eligibleMemberCommitments;
    while (remaining.length > 1) {
      const outcome = await postGroup(base, other.id, { operation: "revoke", expectedVersion: version, commitment: remaining[0] });
      assert.equal(outcome.status, 201);
      version = outcome.body.group!.version;
      remaining = outcome.body.group!.commitments;
    }
    const emptied = await postGroup(base, other.id, { operation: "revoke", expectedVersion: version, commitment: remaining[0] });
    assert.equal(emptied.status, 400);
    assert.equal(emptied.body.error, "empty_group");
  } finally {
    await stop(server);
  }
});

test("existing databases migrate to an immutable version 1", () => {
  const directory = mkdtempSync(join(tmpdir(), "veilvote-migrate-"));
  const path = join(directory, "veilvote.sqlite");
  try {
    // Build a pre-versioning database by hand: no group columns, no snapshots.
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE polls (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL,
        description TEXT NOT NULL, organizer TEXT NOT NULL, status TEXT NOT NULL,
        published_at TEXT NOT NULL, closes_at TEXT NOT NULL, options_json TEXT NOT NULL
      );
      CREATE TABLE members (commitment TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE);
      CREATE TABLE votes (
        id TEXT PRIMARY KEY, poll_id TEXT NOT NULL REFERENCES polls (id),
        option_id TEXT NOT NULL, nullifier TEXT NOT NULL, accepted_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX votes_poll_nullifier ON votes (poll_id, nullifier);
    `);
    const options = JSON.stringify([{ id: "yes", label: "Yes" }, { id: "no", label: "No" }]);
    const insertPoll = db.prepare("INSERT INTO polls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insertPoll.run("legacy-with-votes", "Legacy", "s", "d", "o", "open", "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z", options);
    insertPoll.run("legacy-quiet", "Quiet", "s", "d", "o", "open", "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z", options);
    const insertMember = db.prepare("INSERT INTO members VALUES (?, ?)");
    ["11", "22", "33"].forEach((commitment, index) => insertMember.run(commitment, index));
    db.prepare("INSERT INTO votes VALUES (?, ?, ?, ?, ?)").run("vote-1", "legacy-with-votes", "yes", "nullifier-1", "2026-09-02T00:00:00Z");
    db.close();

    const catalog = openCatalog(path);
    const expectedRoot = new Group(["11", "22", "33"]).root.toString();
    const withVotes = catalog.get("legacy-with-votes")!;
    assert.equal(withVotes.groupVersion, 1);
    assert.equal(withVotes.merkleRoot, expectedRoot);
    assert.deepEqual(withVotes.eligibleMemberCommitments, ["11", "22", "33"]);
    // A poll that already has votes is frozen on its migrated version 1.
    const frozen = catalog.applyGroupOperation("legacy-with-votes", { type: "join", commitment: "44" }, 1);
    assert.deepEqual(frozen, { ok: false, reason: "group_frozen" });
    // A poll without votes can still evolve from version 1.
    const quiet = catalog.applyGroupOperation("legacy-quiet", { type: "join", commitment: "44" }, 1);
    assert.ok(quiet.ok);
    assert.equal(quiet.group.version, 2);
    assert.equal(catalog.get("legacy-quiet")!.groupVersion, 2);
    catalog.close();

    // Snapshots and the freeze survive a reopen.
    const reopened = openCatalog(path);
    assert.equal(reopened.get("legacy-with-votes")!.merkleRoot, expectedRoot);
    assert.equal(reopened.get("legacy-quiet")!.groupVersion, 2);
    assert.equal(reopened.groupSnapshot("legacy-quiet", 1)!.merkleRoot, expectedRoot);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("votes resolve versions, freeze the group and reject stale proofs", async () => {
  const { server, base } = await serve(":memory:");
  try {
    const poll = await pollDetail(base, "community-garden-autumn");
    const [optionA, optionB] = poll.options;

    // A proof bound to version 1, generated before the group changes.
    const v1Proof = await proofFor("veilvote-demo-member-03", optionA.id, poll);

    // The group moves to version 2 before any vote is cast.
    const joined = await postGroup(base, poll.id, { operation: "join", expectedVersion: 1, commitment: commitmentOf("veilvote-demo-member-09") });
    assert.equal(joined.status, 201);

    // The old proof is historical now: 409 whether the version is explicit or resolved by root.
    const staleExplicit = await postVote(base, poll.id, { optionId: optionA.id, groupVersion: 1, proof: v1Proof });
    assert.equal(staleExplicit.status, 409);
    assert.equal(staleExplicit.body.error, "group_version_changed");
    const staleByRoot = await postVote(base, poll.id, { optionId: optionA.id, proof: v1Proof });
    assert.equal(staleByRoot.status, 409);
    assert.equal(staleByRoot.body.error, "group_version_changed");
    // Declaring the current version while carrying the old root is a binding mismatch.
    const mismatched = await postVote(base, poll.id, { optionId: optionA.id, groupVersion: 2, proof: v1Proof });
    assert.equal(mismatched.status, 422);
    assert.equal(mismatched.body.error, "proof_binding_mismatch");
    // A root no version ever had is unprocessable.
    const stranger = new Identity("veilvote-stranger");
    const strangerProof = await generateProof(stranger, new Group([stranger.commitment.toString()]), optionA.id, poll.id) as SemaphoreProofPayload;
    const unknown = await postVote(base, poll.id, { optionId: optionA.id, proof: strangerProof });
    assert.equal(unknown.status, 422);
    assert.equal(unknown.body.error, "unknown_merkle_root");

    // Legacy clients (no groupVersion) vote against the current version by root resolution.
    const current = await pollDetail(base, poll.id);
    assert.equal(current.groupVersion, 2);
    const v2Proof = await proofFor("veilvote-demo-member-01", optionA.id, current);
    const accepted = await postVote(base, poll.id, { optionId: optionA.id, proof: v2Proof });
    assert.equal(accepted.status, 201);
    assert.equal(accepted.body.receipt!.nullifier, v2Proof.nullifier);

    // The first accepted vote froze version 2: further changes are rejected.
    const frozen = await postGroup(base, poll.id, { operation: "join", expectedVersion: 2, commitment: commitmentOf("veilvote-demo-member-10") });
    assert.equal(frozen.status, 409);
    assert.equal(frozen.body.error, "group_frozen");

    // Dedup still works on the frozen version, with an explicit version.
    const replay = await postVote(base, poll.id, { optionId: optionB.id, groupVersion: 2, proof: await proofFor("veilvote-demo-member-01", optionB.id, current) });
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error, "duplicate_nullifier");
  } finally {
    await stop(server);
  }
});

test("a concurrent group change and vote: exactly one succeeds", async () => {
  const { server, base } = await serve(":memory:");
  try {
    const poll = await pollDetail(base, "shared-space-improvement");
    const option = poll.options[0];
    const proof = await proofFor("veilvote-demo-member-01", option.id, poll);

    const [vote, change] = await Promise.all([
      postVote(base, poll.id, { optionId: option.id, groupVersion: 1, proof }),
      postGroup(base, poll.id, { operation: "join", expectedVersion: 1, commitment: commitmentOf("veilvote-demo-member-09") })
    ]);
    // Exactly one of the two commits; the loser gets a 409 conflict.
    const outcomes = [vote.status, change.status].sort();
    assert.deepEqual(outcomes, [201, 409]);
    if (change.status === 201) {
      assert.equal(vote.body.error, "group_version_changed");
      // The vote can be retried against the new version and then freezes it.
      const current = await pollDetail(base, poll.id);
      assert.equal(current.groupVersion, 2);
      const retry = await postVote(base, poll.id, { optionId: option.id, groupVersion: 2, proof: await proofFor("veilvote-demo-member-01", option.id, current) });
      assert.equal(retry.status, 201);
    } else {
      assert.equal(change.body.error, "group_frozen");
    }
    // Afterwards the group is frozen either way.
    const after = await pollDetail(base, poll.id);
    const frozen = await postGroup(base, poll.id, { operation: "join", expectedVersion: after.groupVersion, commitment: commitmentOf("veilvote-demo-member-10") });
    assert.equal(frozen.status, 409);
    assert.equal(frozen.body.error, "group_frozen");
  } finally {
    await stop(server);
  }
});

test("versions, freeze and votes survive a restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "veilvote-versions-"));
  const path = join(directory, "veilvote.sqlite");
  try {
    const first = await serve(path);
    const poll = await pollDetail(first.base, "community-garden-autumn");
    const v1Root = poll.merkleRoot;
    const v1Proof = await proofFor("veilvote-demo-member-02", poll.options[0].id, poll);

    const rotated = await postGroup(first.base, poll.id, {
      operation: "rotate", expectedVersion: 1,
      oldCommitment: poll.eligibleMemberCommitments[7], newCommitment: commitmentOf("veilvote-demo-member-09")
    });
    assert.equal(rotated.status, 201);
    const v2 = rotated.body.group!;
    const current = await pollDetail(first.base, poll.id);
    const accepted = await postVote(first.base, poll.id, { optionId: poll.options[0].id, groupVersion: 2, proof: await proofFor("veilvote-demo-member-01", poll.options[0].id, current) });
    assert.equal(accepted.status, 201);
    await stop(first.server);

    const second = await serve(path);
    try {
      // The current version, its root and its commitments are restart-stable.
      const persisted = await pollDetail(second.base, poll.id);
      assert.equal(persisted.groupVersion, 2);
      assert.equal(persisted.merkleRoot, v2.merkleRoot);
      assert.deepEqual(persisted.eligibleMemberCommitments, v2.commitments);
      // The group stays frozen and version 1 remains a known historical snapshot.
      const change = await postGroup(second.base, poll.id, { operation: "join", expectedVersion: 2, commitment: commitmentOf("veilvote-demo-member-10") });
      assert.equal(change.status, 409);
      assert.equal(change.body.error, "group_frozen");
      const historical = await postVote(second.base, poll.id, { optionId: poll.options[0].id, proof: v1Proof });
      assert.equal(historical.status, 409);
      assert.equal(historical.body.error, "group_version_changed");
      assert.notEqual(persisted.merkleRoot, v1Root);
    } finally {
      await stop(second.server);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
