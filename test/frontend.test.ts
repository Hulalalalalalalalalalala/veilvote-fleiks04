import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createApp } from "../src/app.ts";
import { openCatalog } from "../src/store.ts";
import { mountApp, waitFor, type MountedApp } from "./support/dom.ts";
import type { PollSnapshot, VoteReceipt } from "../src/types.ts";

const ADMIN_TOKEN = "frontend-admin-token";

function makePoll(id: string, closesAt = "2026-12-31T00:00:00Z") {
  return {
    id, title: `议题 ${id}`, summary: "摘要", description: "描述", organizer: "组织方",
    publishedAt: "2026-09-01T00:00:00Z", closesAt,
    options: [{ id: "a", label: "方案甲" }, { id: "b", label: "方案乙" }],
    commitments: ["11", "22", "33"]
  };
}

let directory = "";
let dbPath = "";
let closedSnapshot: PollSnapshot;
let archivedSnapshot: PollSnapshot;
let receipt: VoteReceipt;

test.before(() => {
  directory = mkdtempSync(join(tmpdir(), "veilvote-frontend-"));
  dbPath = join(directory, "veilvote.sqlite");
  // Votes/snapshots are seeded directly through the store (store-level votes
  // need no SNARK) to keep DOM tests fast and deterministic.
  const catalog = openCatalog(dbPath);
  assert.ok(catalog.createPoll(makePoll("dom-draft")).ok);

  assert.ok(catalog.createPoll(makePoll("dom-closed")).ok);
  catalog.transitionStatus("dom-closed", "open", "draft");
  assert.ok(catalog.commitVote("dom-closed", "a", "closed-n1", 1, Date.parse("2026-09-20T10:00:00Z")).ok);
  const second = catalog.commitVote("dom-closed", "a", "closed-n2", 1, Date.parse("2026-09-20T10:01:00Z"));
  assert.ok(second.ok);
  receipt = (second as { ok: true; receipt: VoteReceipt }).receipt;
  assert.ok(catalog.commitVote("dom-closed", "b", "closed-n3", 1, Date.parse("2026-09-20T10:02:00Z")).ok);
  catalog.transitionStatus("dom-closed", "closed", "open", Date.parse("2026-09-21T12:00:00Z"));
  closedSnapshot = catalog.results("dom-closed")!.snapshot!;

  assert.ok(catalog.createPoll(makePoll("dom-archived")).ok);
  catalog.transitionStatus("dom-archived", "open", "draft");
  assert.ok(catalog.commitVote("dom-archived", "b", "archived-n1", 1, Date.parse("2026-09-19T09:00:00Z")).ok);
  catalog.transitionStatus("dom-archived", "closed", "open", Date.parse("2026-09-20T09:00:00Z"));
  catalog.transitionStatus("dom-archived", "archived", "closed");
  archivedSnapshot = catalog.results("dom-archived")!.snapshot!;

  // Enough management events for multi-page audit views at pageSize 10.
  for (let i = 0; i < 6; i++) {
    const id = `dom-audit-${i}`;
    assert.ok(catalog.createPoll(makePoll(id)).ok);
    catalog.transitionStatus(id, "open", "draft");
    if (i % 2 === 0) catalog.transitionStatus(id, "closed", "open");
  }
  catalog.close();
});

let server: Server | undefined;
let base = "";
let mounted: MountedApp | undefined;

async function serve(): Promise<void> {
  server = createApp(dbPath, undefined, { adminToken: ADMIN_TOKEN });
  await new Promise<void>((done, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", done); });
  const address = server!.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
}
async function stop(): Promise<void> {
  if (!server) return;
  const current = server;
  server = undefined;
  current.closeAllConnections();
  await new Promise<void>((done, reject) => current.close(error => error ? reject(error) : done()));
}

test.beforeEach(async () => { await serve(); });
test.afterEach(async () => { mounted?.close(); mounted = undefined; await stop(); });
test.after(() => { rmSync(directory, { recursive: true, force: true }); });

async function freshPage(): Promise<MountedApp> {
  mounted = await mountApp(base);
  return mounted;
}
async function openPoll(page: MountedApp, id: string): Promise<void> {
  await waitFor(page.document, doc => !!doc.querySelector(`button.poll-card[data-id="${id}"]`));
  page.document.querySelector<HTMLButtonElement>(`button.poll-card[data-id="${id}"]`)!.click();
}
function statusText(page: MountedApp, selector: string): string {
  return page.document.querySelector(selector)?.textContent ?? "";
}
function setValue(page: MountedApp, selector: string, value: string): void {
  const input = page.document.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
}
/** Wrap the page fetch, recording calls while delegating to the real network. */
function spyFetch(page: MountedApp): { calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const real = page.window.fetch;
  page.window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, init });
    return real(input, init);
  };
  return { calls };
}

test("closed poll renders the immutable snapshot: closedAt, version, digest, counts in option order", async () => {
  const page = await freshPage();
  await openPoll(page, "dom-closed");
  await waitFor(page.document, doc => !!doc.querySelector(".snapshot-digest code"));

  assert.match(statusText(page, ".results h3"), /最终结果/);
  // Counts follow the poll option order (a then b), not vote arrival order.
  const rows = [...page.document.querySelectorAll(".results ul li")].map(li => li.textContent);
  assert.deepEqual(rows, ["方案甲2 票", "方案乙1 票"]);

  const meta = statusText(page, ".snapshot-meta");
  assert.ok(meta.includes(closedSnapshot.closedAt), `meta shows UTC closedAt: ${meta}`);
  assert.ok(meta.includes(`v${closedSnapshot.groupVersion}`));
  assert.ok(meta.includes(String(closedSnapshot.total)));
  assert.equal(page.document.querySelector(".snapshot-digest code")!.textContent, closedSnapshot.digest);

  // The copyable summary covers every snapshot field in digest order.
  page.document.querySelector<HTMLButtonElement>(".snapshot-copy")!.click();
  await waitFor(page.document, () => page.clipboard.length > 0);
  const summary = page.clipboard[0];
  const lines = summary.split("\n");
  assert.deepEqual(lines, [
    `pollId: dom-closed`,
    `groupVersion: ${closedSnapshot.groupVersion}`,
    `total: ${closedSnapshot.total}`,
    `options.a: 2`,
    `options.b: 1`,
    `closedAt: ${closedSnapshot.closedAt}`,
    `digest: ${closedSnapshot.digest}`
  ]);
  // The selectable textarea fallback carries the same canonical content.
  page.document.querySelector<HTMLButtonElement>(".snapshot-show-text")!.click();
  assert.equal(page.document.querySelector<HTMLTextAreaElement>(".snapshot-summary-text")!.value, summary);
});

test("archived poll shows the same snapshot; it is unchanged by a server restart", async () => {
  const page = await freshPage();
  await openPoll(page, "dom-archived");
  await waitFor(page.document, doc => !!doc.querySelector(".snapshot-digest code"));
  assert.equal(page.document.querySelector(".snapshot-digest code")!.textContent, archivedSnapshot.digest);
  assert.ok(statusText(page, ".snapshot-meta").includes(archivedSnapshot.closedAt));

  page.close();
  await stop();
  await serve();
  const restarted = await freshPage();
  await openPoll(restarted, "dom-archived");
  await waitFor(restarted.document, doc => !!doc.querySelector(".snapshot-digest code"));
  assert.equal(restarted.document.querySelector(".snapshot-digest code")!.textContent, archivedSnapshot.digest);
  assert.ok(statusText(restarted, ".snapshot-meta").includes(archivedSnapshot.closedAt));
  await new Promise(resolve => setTimeout(resolve, 50));
  mounted = restarted;
});

test("open polls show live counts only (no snapshot metadata)", async () => {
  const page = await freshPage();
  await openPoll(page, "community-garden-autumn");
  await waitFor(page.document, doc => !!doc.querySelector(".results-mount .results h3"));
  assert.match(statusText(page, ".results-mount .results h3"), /当前结果/);
  assert.equal(page.document.querySelector(".snapshot-digest"), null);
  assert.equal(page.document.querySelector(".snapshot-meta"), null);
});

test("draft polls stay out of the public catalog and are not publicly reachable", async () => {
  const page = await freshPage();
  await waitFor(page.document, doc => doc.querySelectorAll("button.poll-card").length > 0);
  assert.equal(page.document.querySelector('button.poll-card[data-id="dom-draft"]'), null);
  assert.equal((await fetch(`${base}/api/polls/dom-draft`)).status, 404);
  assert.equal((await fetch(`${base}/api/polls/dom-draft/results`)).status, 404);
});

test("receipt verification reports success, 404, 422 and format errors; retries after failure", async () => {
  const page = await freshPage();
  await openPoll(page, "dom-closed");
  await waitFor(page.document, doc => !!doc.querySelector(".receipt-verify"));
  const field = (name: string) => page.document.querySelector<HTMLInputElement>(`.verify-form input[data-field="${name}"]`)!;
  const submit = () => page.document.querySelector<HTMLButtonElement>(".verify-submit")!;
  const line = () => page.document.querySelector(".verify-status")!;

  // Success with the seeded receipt.
  field("id").value = receipt.id;
  field("pollId").value = receipt.pollId;
  field("optionId").value = receipt.optionId;
  field("nullifier").value = receipt.nullifier;
  submit().click();
  await waitFor(page.document, () => line().textContent!.includes("核验成功"));
  assert.ok(statusText(page, ".verify-result").includes(receipt.acceptedAt));

  // Unknown receipt id -> 404.
  field("id").value = "no-such-receipt";
  submit().click();
  await waitFor(page.document, () => line().textContent!.includes("404"));
  assert.ok(line().className.includes("error"));
  assert.equal(submit().disabled, false, "submit is re-enabled after failure");

  // A wrong nullifier -> 422 receipt_mismatch, then correcting it succeeds.
  field("id").value = receipt.id;
  field("nullifier").value = "wrong-nullifier";
  submit().click();
  await waitFor(page.document, () => line().textContent!.includes("422"));
  field("nullifier").value = receipt.nullifier;
  submit().click();
  await waitFor(page.document, () => line().textContent!.includes("核验成功"));

  // Client-side format guard for empty fields.
  field("optionId").value = "";
  submit().click();
  await waitFor(page.document, () => line().textContent!.includes("400"));
});

test("receipt verification distinguishes network failure and blocks duplicate submits", async () => {
  const page = await freshPage();
  await openPoll(page, "dom-closed");
  await waitFor(page.document, doc => !!doc.querySelector(".receipt-verify"));
  const field = (name: string) => page.document.querySelector<HTMLInputElement>(`.verify-form input[data-field="${name}"]`)!;
  const submit = () => page.document.querySelector<HTMLButtonElement>(".verify-submit")!;
  const line = () => page.document.querySelector(".verify-status")!;
  field("id").value = receipt.id;
  field("pollId").value = receipt.pollId;
  field("optionId").value = receipt.optionId;
  field("nullifier").value = receipt.nullifier;

  // A hanging request: a second click while busy must not issue another call.
  let attempts = 0;
  let release: ((response: Response) => void) | undefined;
  const realFetch = page.window.fetch;
  page.window.fetch = () => {
    attempts += 1;
    return new Promise<Response>(resolve => { release = resolve; });
  };
  submit().click();
  assert.equal(submit().disabled, true);
  submit().click();
  assert.equal(attempts, 1, "duplicate submission while busy is suppressed");
  // Complete the in-flight call successfully and confirm the form recovers.
  release!(new Response(JSON.stringify({ valid: true, receipt }), { status: 200, headers: { "Content-Type": "application/json" } }));
  await waitFor(page.document, () => line().textContent!.includes("核验成功"));
  assert.equal(submit().disabled, false);

  // A rejected fetch (offline) is reported as a network failure and retryable.
  page.window.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
  field("nullifier").value = "something-else";
  submit().click();
  await waitFor(page.document, () => line().textContent!.includes("网络失败"));
  assert.equal(submit().disabled, false);
  page.window.fetch = realFetch;
  field("nullifier").value = receipt.nullifier;
  submit().click();
  await waitFor(page.document, () => line().textContent!.includes("核验成功"));
});

test("receipt verification never sends the admin token or any identity secret", async () => {
  const page = await freshPage();
  // Put management mode on first; the public verify call must stay anonymous.
  setValue(page, "#admin-token", ADMIN_TOKEN);
  page.document.querySelector<HTMLButtonElement>("#admin-set")!.click();
  await waitFor(page.document, () => !page.document.querySelector<HTMLButtonElement>("#admin-audit")!.hidden);
  await openPoll(page, "dom-closed");
  await waitFor(page.document, doc => !!doc.querySelector(".receipt-verify"));

  const calls = spyFetch(page);
  const field = (name: string) => page.document.querySelector<HTMLInputElement>(`.verify-form input[data-field="${name}"]`)!;
  field("id").value = receipt.id;
  field("pollId").value = receipt.pollId;
  field("optionId").value = receipt.optionId;
  field("nullifier").value = receipt.nullifier;
  page.document.querySelector<HTMLButtonElement>(".verify-submit")!.click();
  await waitFor(page.document, () => statusText(page, ".verify-status").includes("核验成功"));

  const verifyCalls = calls.calls.filter(call => call.url.includes("/verify"));
  assert.equal(verifyCalls.length, 1);
  assert.equal(verifyCalls[0].init?.headers instanceof Headers, true);
  assert.equal((verifyCalls[0].init!.headers as Headers).has("X-Admin-Token"), false);
  // The verify form has no identity-secret input; nothing is persisted.
  assert.equal(page.document.querySelector(".receipt-verify input[type=password]"), null);
  assert.equal(page.window.localStorage.length, 0);
  assert.equal(page.window.sessionStorage.length, 0);
});

test("audit view: 401 with a wrong token and clear loading/error states", async () => {
  const page = await freshPage();
  // The audit entry point stays hidden without a token; the API itself is 401.
  assert.equal(page.document.querySelector<HTMLButtonElement>("#admin-audit")!.hidden, true);
  assert.equal((await fetch(`${base}/api/admin/audit`)).status, 401);

  setValue(page, "#admin-token", "wrong-token");
  page.document.querySelector<HTMLButtonElement>("#admin-set")!.click();
  await waitFor(page.document, () => !page.document.querySelector<HTMLButtonElement>("#admin-audit")!.hidden);
  page.document.querySelector<HTMLButtonElement>("#admin-audit")!.click();
  await waitFor(page.document, doc => !!doc.querySelector(".audit-error")?.textContent?.includes("401"));
  assert.match(page.document.querySelector(".audit-error")!.textContent!, /401/);
  assert.equal(page.document.querySelector<HTMLElement>(".audit-pager")!.hidden, true);
});

test("audit view: filtering, pagination controls and reset-to-first-page behavior", async () => {
  const page = await freshPage();
  setValue(page, "#admin-token", ADMIN_TOKEN);
  page.document.querySelector<HTMLButtonElement>("#admin-set")!.click();
  await waitFor(page.document, () => !page.document.querySelector<HTMLButtonElement>("#admin-audit")!.hidden);

  const calls = spyFetch(page);
  page.document.querySelector<HTMLButtonElement>("#admin-audit")!.click();
  await waitFor(page.document, doc => !!doc.querySelector(".audit-table tbody tr"));
  const firstUrl = () => calls.calls.filter(call => call.url.includes("/api/admin/audit")).at(-1)!.url;
  assert.ok(firstUrl().includes("page=1"));
  assert.ok(firstUrl().includes("pageSize=10"));
  const info = () => page.document.querySelector(".audit-page-info")!.textContent!;
  assert.match(info(), /共 \d+ 条 · 第 1 \//);

  // First/prev are disabled on page 1; next advances with page=2.
  assert.equal(page.document.querySelector<HTMLButtonElement>(".audit-first")!.disabled, true);
  assert.equal(page.document.querySelector<HTMLButtonElement>(".audit-prev")!.disabled, true);
  page.document.querySelector<HTMLButtonElement>(".audit-next")!.click();
  await waitFor(page.document, () => firstUrl().includes("page=2") && info().includes("第 2 /"));
  assert.match(info(), /第 2 \//);
  page.document.querySelector<HTMLButtonElement>(".audit-prev")!.click();
  await waitFor(page.document, () => firstUrl().includes("page=1") && info().includes("第 1 /"));

  // Last page button jumps to the server-reported totalPages.
  page.document.querySelector<HTMLButtonElement>(".audit-last")!.click();
  await waitFor(page.document, () => {
    const match = /第 (\d+) \/ (\d+)/.exec(info());
    return !!match && match[1] === match[2];
  });

  // A pollId filter restarts at page 1 and only matching rows render.
  setValue(page, '.audit-filters input[data-filter="pollId"]', "dom-closed");
  page.document.querySelector<HTMLButtonElement>(".audit-search")!.click();
  await waitFor(page.document, doc => {
    const url = calls.calls.filter(call => call.url.includes("/api/admin/audit")).at(-1)?.url ?? "";
    return url.includes("page=1") && url.includes("pollId=dom-closed");
  });
  await waitFor(page.document, doc => [...doc.querySelectorAll(".audit-table tbody tr")].length > 0);
  for (const cell of page.document.querySelectorAll(".audit-table tbody tr td:nth-child(3)")) {
    assert.equal(cell.textContent, "dom-closed");
  }

  // Action + result selects compose and also reset to page 1.
  const action = page.document.querySelector<HTMLSelectElement>('select[data-filter="action"]')!;
  action.value = "poll_create";
  action.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  await waitFor(page.document, () => {
    const url = calls.calls.filter(call => call.url.includes("/api/admin/audit")).at(-1)?.url ?? "";
    return url.includes("action=poll_create") && url.includes("page=1");
  });
  for (const cell of page.document.querySelectorAll(".audit-table tbody tr td:nth-child(2)")) assert.equal(cell.textContent, "创建议题");

  // A strict-ISO typo is surfaced as the 400 time-range error, not results.
  setValue(page, '.audit-filters input[data-filter="from"]', "2026-09-20");
  page.document.querySelector<HTMLButtonElement>(".audit-search")!.click();
  await waitFor(page.document, doc => !!doc.querySelector(".audit-error")?.textContent?.includes("严格 ISO8601"));
});

test("audit view: empty results and out-of-range pages render without crashing", async () => {
  const page = await freshPage();
  setValue(page, "#admin-token", ADMIN_TOKEN);
  page.document.querySelector<HTMLButtonElement>("#admin-set")!.click();
  await waitFor(page.document, () => !page.document.querySelector<HTMLButtonElement>("#admin-audit")!.hidden);
  const calls = spyFetch(page);
  page.document.querySelector<HTMLButtonElement>("#admin-audit")!.click();
  await waitFor(page.document, doc => !!doc.querySelector(".audit-table tbody tr, .audit-empty"));

  // A filter matching nothing shows the empty state.
  setValue(page, '.audit-filters input[data-filter="pollId"]', "no-such-poll");
  page.document.querySelector<HTMLButtonElement>(".audit-search")!.click();
  await waitFor(page.document, doc => !!doc.querySelector(".audit-empty"));
  assert.ok(page.document.querySelector(".audit-empty")!.textContent!.includes("暂无"));
  assert.equal(page.document.querySelector(".audit-table"), null);

  // The server answers an out-of-range page with an empty 200 page (no crash);
  // the client's own navigation is bounded by the disabled next/last buttons.
  const response = await fetch(`${base}/api/admin/audit?page=999&pageSize=10`, { headers: { "X-Admin-Token": ADMIN_TOKEN } });
  assert.equal(response.status, 200);
  const body = await response.json() as { events: unknown[]; total: number; page: number; totalPages: number };
  assert.equal(body.events.length, 0);
  assert.equal(body.page, 999);
  assert.ok(body.total > 0);
  assert.ok(body.totalPages < 999);
  // Requests issued by the view always carried positive integer pagination.
  for (const call of calls.calls.filter(call => call.url.includes("/api/admin/audit"))) {
    const params = new URL(call.url, base).searchParams;
    assert.ok(Number(params.get("page")) >= 1);
    assert.ok(Number(params.get("pageSize")) >= 1 && Number(params.get("pageSize")) <= 200);
  }
});

test("admin token lives in page memory only and is gone on reload", async () => {
  const page = await freshPage();
  setValue(page, "#admin-token", ADMIN_TOKEN);
  page.document.querySelector<HTMLButtonElement>("#admin-set")!.click();
  await waitFor(page.document, () => !page.document.querySelector<HTMLButtonElement>("#admin-audit")!.hidden);
  assert.equal(page.window.localStorage.length, 0);
  assert.equal(page.window.sessionStorage.length, 0);
  // The password field is cleared after applying the token.
  assert.equal(page.document.querySelector<HTMLInputElement>("#admin-token")!.value, "");
  // Let the token-triggered catalog/detail requests settle before tearing the
  // server down so their rejection handling stays inside the app.
  await new Promise(resolve => setTimeout(resolve, 100));

  page.close();
  await stop();
  await serve();
  const reloaded = await freshPage();
  await waitFor(reloaded.document, doc => !!doc.querySelector("button.poll-card"));
  assert.equal(reloaded.document.querySelector<HTMLButtonElement>("#admin-audit")!.hidden, true);
  assert.equal(reloaded.document.querySelector<HTMLInputElement>("#admin-token")!.disabled, false);
  mounted = reloaded;
});
