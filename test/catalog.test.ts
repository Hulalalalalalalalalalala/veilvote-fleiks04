import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { openCatalog } from "../src/store.ts";

test("catalog persists its two seeded polls and eight distinct commitments", () => {
  const directory = mkdtempSync(join(tmpdir(), "veilvote-catalog-"));
  const path = join(directory, "catalog.sqlite");
  try {
    const first = openCatalog(path);
    const expected = first.list();
    assert.equal(expected.length, 2);
    for (const poll of expected) {
      const detail = first.get(poll.id)!;
      assert.equal(new Set(detail.eligibleMemberCommitments).size, 8);
      assert.ok(detail.options.length >= 2);
    }
    first.close();
    const reopened = openCatalog(path);
    assert.deepEqual(reopened.list(), expected);
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("HTTP API exposes catalog details and clear errors", async () => {
  const server = createApp(":memory:");
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const list = await fetch(`${base}/api/polls`).then(response => response.json()) as { polls: { id: string }[] };
    assert.equal(list.polls.length, 2);
    const detail = await fetch(`${base}/api/polls/${list.polls[0].id}`).then(response => response.json()) as { poll: { eligibleMemberCommitments: string[] } };
    assert.equal(detail.poll.eligibleMemberCommitments.length, 8);
    assert.equal((await fetch(`${base}/api/polls/missing`)).status, 404);
    assert.equal((await fetch(`${base}/api/polls/%E0%A4%A`)).status, 400);
    const write = await fetch(`${base}/api/polls`, { method: "POST" });
    assert.equal(write.status, 405);
    assert.equal(write.headers.get("allow"), "GET");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  }
});
