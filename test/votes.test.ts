import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Identity } from "@semaphore-protocol/identity";
import { Group } from "@semaphore-protocol/group";
import { generateProof } from "@semaphore-protocol/proof";
import { createApp } from "../src/app.ts";
import type { PollDetail, PollResult, PollSummary, VoteReceipt } from "../src/types.ts";

interface Running { base: string; close: () => Promise<void> }
async function startApp(databasePath: string): Promise<Running> {
  const server = createApp(databasePath);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    base: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    }
  };
}
async function firstPoll(base: string): Promise<PollDetail> {
  const { polls } = await (await fetch(`${base}/api/polls`)).json() as { polls: PollSummary[] };
  const response = await fetch(`${base}/api/polls/${encodeURIComponent(polls[0].id)}`);
  return (await response.json() as { poll: PollDetail }).poll;
}
function postVote(base: string, pollId: string, payload: unknown) {
  return fetch(`${base}/api/polls/${encodeURIComponent(pollId)}/votes`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
}

test("anonymous voting lifecycle: accept, deduplicate, reject tampering, persist", async () => {
  const directory = mkdtempSync(join(tmpdir(), "veilvote-votes-"));
  const path = join(directory, "votes.sqlite");
  const app = await startApp(path);
  try {
    const poll = await firstPoll(app.base);
    const group = new Group(poll.eligibleMemberCommitments);
    const [option, other] = poll.options;
    const identity = new Identity("veilvote-demo-member-01");
    const proof = await generateProof(identity, group, option.id, poll.id);

    // 201 with a durable receipt
    const accepted = await postVote(app.base, poll.id, { optionId: option.id, proof });
    assert.equal(accepted.status, 201);
    const { receipt } = await accepted.json() as { receipt: VoteReceipt };
    assert.equal(receipt.pollId, poll.id);
    assert.equal(receipt.optionId, option.id);
    assert.equal(receipt.nullifier, proof.nullifier);
    assert.ok(receipt.id && receipt.acceptedAt);

    // Same nullifier on the same poll can only succeed once
    const duplicate = await postVote(app.base, poll.id, { optionId: option.id, proof });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json() as { error: string }).error, "duplicate_vote");

    // Tampering: message no longer matches the claimed option
    const tamperedOption = await postVote(app.base, poll.id, { optionId: other.id, proof });
    assert.equal(tamperedOption.status, 422);
    assert.equal((await tamperedOption.json() as { error: string }).error, "invalid_proof");

    // Tampering: proof points flipped
    const flipped = { ...proof, points: proof.points.map((point, index) => index === 0 ? "1" : point) };
    const tamperedProof = await postVote(app.base, poll.id, { optionId: option.id, proof: flipped });
    assert.equal(tamperedProof.status, 422);

    // Tampering: scope rebound to the other poll
    const { polls } = await (await fetch(`${app.base}/api/polls`)).json() as { polls: PollSummary[] };
    const otherPoll = polls.find(item => item.id !== poll.id)!;
    const rescoped = { ...proof, scope: otherPoll.id };
    const tamperedScope = await postVote(app.base, poll.id, { optionId: option.id, proof: rescoped });
    assert.equal(tamperedScope.status, 422);

    // 400s and 404s
    assert.equal((await postVote(app.base, poll.id, { optionId: "not-an-option", proof })).status, 400);
    assert.equal((await postVote(app.base, poll.id, { optionId: option.id })).status, 400);
    assert.equal((await postVote(app.base, poll.id, "nonsense")).status, 400);
    assert.equal((await postVote(app.base, "missing-poll", { optionId: option.id, proof })).status, 404);
    const malformed = await fetch(`${app.base}/api/polls/${encodeURIComponent(poll.id)}/votes`, { method: "POST", body: "{not json" });
    assert.equal(malformed.status, 400);

    // Results include zero-vote options
    const resultsResponse = await fetch(`${app.base}/api/polls/${encodeURIComponent(poll.id)}/results`);
    assert.equal(resultsResponse.status, 200);
    const { result } = await resultsResponse.json() as { result: PollResult };
    assert.equal(result.pollId, poll.id);
    assert.equal(result.total, 1);
    assert.equal(result.options.length, poll.options.length);
    assert.equal(result.options.find(item => item.id === option.id)?.count, 1);
    assert.equal(result.options.find(item => item.id === other.id)?.count, 0);
    assert.equal((await fetch(`${app.base}/api/polls/missing/results`)).status, 404);

    // Receipt lookup
    const receiptResponse = await fetch(`${app.base}/api/receipts/${receipt.id}`);
    assert.equal(receiptResponse.status, 200);
    assert.deepEqual((await receiptResponse.json() as { receipt: VoteReceipt }).receipt, receipt);
    assert.equal((await fetch(`${app.base}/api/receipts/unknown`)).status, 404);

    // A second member votes; concurrent duplicates are rejected exactly once
    const secondProof = await generateProof(new Identity("veilvote-demo-member-02"), group, other.id, poll.id);
    const [raceA, raceB] = await Promise.all([
      postVote(app.base, poll.id, { optionId: other.id, proof: secondProof }),
      postVote(app.base, poll.id, { optionId: other.id, proof: secondProof })
    ]);
    assert.deepEqual([raceA.status, raceB.status].sort(), [201, 409]);
    const afterRace = await (await fetch(`${app.base}/api/polls/${encodeURIComponent(poll.id)}/results`)).json() as { result: PollResult };
    assert.equal(afterRace.result.total, 2);
  } finally {
    await app.close();
  }

  // Votes and receipts survive a restart on the same database file
  const reopened = await startApp(path);
  try {
    const poll = await firstPoll(reopened.base);
    const { result } = await (await fetch(`${reopened.base}/api/polls/${encodeURIComponent(poll.id)}/results`)).json() as { result: PollResult };
    assert.equal(result.total, 2);
    const receipts = await fetch(`${reopened.base}/api/receipts/unknown`);
    assert.equal(receipts.status, 404);
  } finally {
    await reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("votes are rejected with 409 once the poll has closed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "veilvote-closed-"));
  const path = join(directory, "closed.sqlite");
  const app = await startApp(path);
  try {
    const poll = await firstPoll(app.base);
    // Close the poll by moving its deadline into the past (separate connection, WAL mode).
    const db = new DatabaseSync(path);
    db.prepare("UPDATE polls SET closes_at = ? WHERE id = ?").run("2020-01-01T00:00:00Z", poll.id);
    db.close();
    const group = new Group(poll.eligibleMemberCommitments);
    const proof = await generateProof(new Identity("veilvote-demo-member-03"), group, poll.options[0].id, poll.id);
    const response = await postVote(app.base, poll.id, { optionId: poll.options[0].id, proof });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { error: string }).error, "poll_closed");
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
