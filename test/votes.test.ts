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
import type { PollDetail, PollResults, SemaphoreProofPayload, VoteReceipt } from "../src/types.ts";

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
async function proofFor(secret: string, optionId: string, poll: PollDetail): Promise<SemaphoreProofPayload> {
  const identity = new Identity(secret);
  const group = new Group(poll.eligibleMemberCommitments);
  return generateProof(identity, group, optionId, poll.id) as Promise<SemaphoreProofPayload>;
}
async function postVote(base: string, pollId: string, payload: unknown) {
  const response = await fetch(`${base}/api/polls/${encodeURIComponent(pollId)}/votes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof payload === "string" ? payload : JSON.stringify(payload)
  });
  return { status: response.status, body: await response.json() as { receipt?: VoteReceipt; error?: string } };
}

test("anonymous vote lifecycle: accept, deduplicate, reject tampering, tally", async () => {
  const { server, base } = await serve(":memory:");
  try {
    const poll = await pollDetail(base, "community-garden-autumn");
    const [optionA, optionB] = poll.options;

    // Unknown poll and malformed submissions.
    const validProof = await proofFor("veilvote-demo-member-01", optionA.id, poll);
    assert.equal((await postVote(base, "missing-poll", { optionId: optionA.id, proof: validProof })).status, 404);
    assert.equal((await postVote(base, poll.id, "not json{")).status, 400);
    assert.equal((await postVote(base, poll.id, { optionId: optionA.id })).status, 400);
    assert.equal((await postVote(base, poll.id, { optionId: optionA.id, proof: { ...validProof, points: ["1"] } })).status, 400);
    assert.equal((await postVote(base, poll.id, { optionId: "no-such-option", proof: validProof })).status, 400);
    assert.equal((await fetch(`${base}/api/polls/${poll.id}/votes`)).status, 405);

    // A valid vote is accepted with a receipt.
    const accepted = await postVote(base, poll.id, { optionId: optionA.id, proof: validProof });
    assert.equal(accepted.status, 201);
    const receipt = accepted.body.receipt!;
    assert.equal(receipt.pollId, poll.id);
    assert.equal(receipt.optionId, optionA.id);
    assert.equal(receipt.nullifier, validProof.nullifier);
    assert.ok(receipt.id && receipt.acceptedAt);

    // The receipt is retrievable; unknown receipts are 404.
    const fetched = await fetch(`${base}/api/receipts/${receipt.id}`);
    assert.equal(fetched.status, 200);
    assert.deepEqual(((await fetched.json()) as { receipt: VoteReceipt }).receipt, receipt);
    assert.equal((await fetch(`${base}/api/receipts/nope`)).status, 404);

    // The same nullifier cannot vote twice in this poll, even with a fresh proof.
    const replay = await postVote(base, poll.id, { optionId: optionB.id, proof: await proofFor("veilvote-demo-member-01", optionB.id, poll) });
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error, "duplicate_nullifier");

    // Tampering: proof bound to option A but submitted for option B.
    const swapped = await postVote(base, poll.id, { optionId: optionB.id, proof: await proofFor("veilvote-demo-member-02", optionA.id, poll) });
    assert.equal(swapped.status, 422);
    // Tampering: proof bound to another poll's scope.
    const otherPoll = await pollDetail(base, "shared-space-improvement");
    const wrongScope = await postVote(base, poll.id, { optionId: optionA.id, proof: await proofFor("veilvote-demo-member-03", optionA.id, otherPoll) });
    assert.equal(wrongScope.status, 422);
    // Tampering: corrupted nullifier breaks the cryptographic proof.
    const corrupted = await proofFor("veilvote-demo-member-04", optionA.id, poll);
    corrupted.nullifier = validProof.nullifier;
    assert.equal((await postVote(base, poll.id, { optionId: optionA.id, proof: corrupted })).status, 422);

    // Results count the accepted vote and include zero-vote options.
    const result = ((await (await fetch(`${base}/api/polls/${poll.id}/results`)).json()) as { result: PollResults }).result;
    assert.equal(result.pollId, poll.id);
    assert.equal(result.total, 1);
    assert.deepEqual(result.options, poll.options.map(option => ({ id: option.id, count: option.id === optionA.id ? 1 : 0 })));
    assert.equal((await fetch(`${base}/api/polls/missing/results`)).status, 404);
  } finally {
    await stop(server);
  }
});

test("votes and receipts survive a restart; closed polls reject votes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "veilvote-votes-"));
  const path = join(directory, "veilvote.sqlite");
  try {
    const first = await serve(path);
    const poll = await pollDetail(first.base, "community-garden-autumn");
    const proof = await proofFor("veilvote-demo-member-05", poll.options[1].id, poll);
    const accepted = await postVote(first.base, poll.id, { optionId: poll.options[1].id, proof });
    assert.equal(accepted.status, 201);
    const receipt = accepted.body.receipt!;
    await stop(first.server);

    const second = await serve(path);
    try {
      const result = ((await (await fetch(`${second.base}/api/polls/${poll.id}/results`)).json()) as { result: PollResults }).result;
      assert.equal(result.total, 1);
      assert.equal(result.options.find(option => option.id === poll.options[1].id)?.count, 1);
      const persisted = await fetch(`${second.base}/api/receipts/${receipt.id}`);
      assert.equal(persisted.status, 200);
      assert.deepEqual(((await persisted.json()) as { receipt: VoteReceipt }).receipt, receipt);

      // Close the poll by moving its deadline into the past.
      const db = new DatabaseSync(path);
      db.prepare("UPDATE polls SET closes_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), poll.id);
      db.close();
      const late = await postVote(second.base, poll.id, { optionId: poll.options[0].id, proof: await proofFor("veilvote-demo-member-06", poll.options[0].id, poll) });
      assert.equal(late.status, 409);
      assert.equal(late.body.error, "poll_closed");
    } finally {
      await stop(second.server);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
