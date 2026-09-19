import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Server } from "node:http";
import { JSDOM } from "jsdom";
import { build, type Plugin } from "esbuild";
import { createApp } from "../src/app.ts";
import { openCatalog } from "../src/store.ts";
import type { PollSnapshot, VoteReceipt } from "../src/types.ts";

const ADMIN_TOKEN = "frontend-test-token";

// Bundle the real frontend once for the whole file. CSS is stubbed; the
// Semaphore packages stay external because the lazy proof-generation imports
// are never reached in these interaction tests (no vote is cast in the browser).
const buildDirectory = mkdtempSync(join(tmpdir(), "veilvote-frontend-build-"));
const bundlePath = join(buildDirectory, "app.mjs");
{
  const cssStub: Plugin = {
    name: "css-empty",
    setup(builder) {
      builder.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: "css-empty" }));
      builder.onLoad({ filter: /.*/, namespace: "css-empty" }, () => ({ contents: "", loader: "js" }));
    }
  };
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const built = await build({
    entryPoints: [join(projectRoot, "web/main.ts")],
    bundle: true, format: "esm", platform: "browser", write: false,
    absWorkingDir: projectRoot, external: ["@semaphore-protocol/*"], plugins: [cssStub]
  });
  writeFileSync(bundlePath, built.outputFiles[0].text);
}
let pageSerial = 0;

type FetchOverride = (input: RequestInfo | URL, init: RequestInit | undefined, next: typeof fetch) => Promise<Response>;

interface Page {
  document: Document;
  window: any;
  clipboard: { value: string };
  fetchSpy: { auditUrls: string[]; calls: number };
  realFetch: typeof fetch;
  setFetchOverride(fn: FetchOverride | null): void;
  cleanup(): Promise<void>;
}

/**
 * Mounts the real bundled frontend in a fresh jsdom window. Relative fetches
 * are routed to the live API server; tests may temporarily override fetch to
 * simulate 400/network failures (the override receives `next` = the real
 * undici fetch, so it can proxy rewritten requests). Each mount installs a
 * fresh module instance.
 */
async function mountPage(base: string): Promise<Page> {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, {
    url: "http://veilvote.test/", pretendToBeVisual: true
  });
  const window = dom.window;
  const clipboard = { value: "" };
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value: string) => { clipboard.value = value; } }
  });
  const globalNames = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement",
    "HTMLFormElement", "HTMLButtonElement", "Element", "Node", "NodeList", "Document", "DocumentFragment",
    "Event", "MouseEvent", "Option", "FormData", "customElements", "getComputedStyle", "fetch"];
  const saved: Record<string, PropertyDescriptor | undefined> = {};
  for (const name of globalNames) saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);

  const fetchSpy = { auditUrls: [] as string[], calls: 0 };
  const realFetch = globalThis.fetch.bind(globalThis);
  let override: FetchOverride | null = null;
  const routingFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    fetchSpy.calls += 1;
    const href = typeof input === "string" && input.startsWith("/") ? `${base}${input}` : input;
    if (typeof href === "string" && href.includes("/api/admin/audit")) {
      fetchSpy.auditUrls.push(href.slice(href.indexOf("/api/admin/audit")));
    }
    if (override) return override(href as RequestInfo | URL, init, realFetch);
    return realFetch(href as RequestInfo | URL, init);
  };

  for (const name of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLSelectElement",
    "HTMLFormElement", "HTMLButtonElement", "Element", "Node", "NodeList", "Document", "DocumentFragment",
    "Event", "MouseEvent", "Option", "FormData", "customElements"]) {
    Object.defineProperty(globalThis, name, { value: window[name], configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, "getComputedStyle", { value: window.getComputedStyle.bind(window), configurable: true, writable: true });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true, writable: true });
  Object.defineProperty(globalThis, "fetch", { value: routingFetch, configurable: true, writable: true });

  await import(pathToFileURL(bundlePath).href + `?page=${++pageSerial}`);

  return {
    document: window.document as Document,
    window,
    clipboard,
    fetchSpy,
    realFetch,
    setFetchOverride(fn) { override = fn; },
    async cleanup() {
      // Let any in-flight fetch continuations drain against this window before
      // restoring Node globals, so they never resolve into a documentless world.
      await new Promise(resolve => setTimeout(resolve, 60));
      window.close();
      for (const name of globalNames) {
        if (saved[name]) Object.defineProperty(globalThis, name, saved[name]!);
        else delete (globalThis as Record<string, unknown>)[name];
      }
    }
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`waitFor timed out after ${timeoutMs}ms`);
}
// While a page is mounted, global Event is jsdom's Event, which is what
// jsdom's dispatchEvent expects.
const dispatch = (element: Element, type: string) =>
  element.dispatchEvent(new (globalThis as unknown as { Event: typeof Event }).Event(type, { bubbles: true, cancelable: true }));
const click = (element: Element) => dispatch(element, "click");
const change = (element: Element) => dispatch(element, "change");
const submit = (page: Page, form: Element) => form.dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));

async function serve(databasePath: string, token: string | undefined = ADMIN_TOKEN): Promise<{ server: Server; base: string }> {
  const server = createApp(databasePath, undefined, { adminToken: token });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, base: `http://127.0.0.1:${address.port}` };
}
async function stop(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}
async function jsonFetch(base: string, path: string, init: RequestInit & { token?: string | false } = {}) {
  const headers = new Headers(init.headers);
  if (init.token !== false) headers.set("X-Admin-Token", init.token ?? ADMIN_TOKEN);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${base}${path}`, { ...init, headers });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
}
function pollPayload(id: string) {
  return {
    id, title: "快照测试议题", summary: "s", description: "d", organizer: "o",
    publishedAt: "2026-09-01T08:00:00Z", closesAt: "2026-12-31T00:00:00Z",
    // Deliberately non-alphabetical order: the snapshot must preserve it.
    options: [{ id: "plan-b", label: "方案 B（先列出）" }, { id: "plan-a", label: "方案 A（后列出）" }],
    commitments: ["11", "22", "33"]
  };
}
async function startVotedServer(databasePath: string) {
  const served = await serve(databasePath);
  const pollId = "snap-ordered";
  const created = await jsonFetch(served.base, "/api/polls", { method: "POST", body: JSON.stringify(pollPayload(pollId)) });
  assert.equal(created.status, 201);
  const opened = await jsonFetch(served.base, `/api/polls/${pollId}/status`, {
    method: "POST", body: JSON.stringify({ status: "open", expectedStatus: "draft" })
  });
  assert.equal(opened.status, 200);
  // Ballots through a second catalog connection keep the DOM test proof-free.
  const writer = openCatalog(databasePath);
  const receipts: VoteReceipt[] = [];
  for (const [option, nullifier] of [["plan-b", "dom-n-1"], ["plan-b", "dom-n-2"], ["plan-a", "dom-n-3"]] as const) {
    const outcome = writer.commitVote(pollId, option, nullifier, 1, Date.parse("2026-09-20T10:00:00Z"));
    assert.ok(outcome.ok);
    receipts.push((outcome as { receipt: VoteReceipt }).receipt);
  }
  writer.close();
  const closed = await jsonFetch(served.base, `/api/polls/${pollId}/status`, {
    method: "POST", body: JSON.stringify({ status: "closed", expectedStatus: "open" })
  });
  assert.equal(closed.status, 200);
  return { ...served, pollId, receipts };
}
function pickPollCard(documentRef: Document, pollId: string): HTMLButtonElement {
  const card = [...documentRef.querySelectorAll<HTMLButtonElement>(".poll-card")].find(candidate => candidate.dataset.id === pollId);
  assert.ok(card, `poll card for ${pollId}`);
  return card!;
}
async function setAdminToken(page: Page, token: string) {
  const input = page.document.querySelector<HTMLInputElement>("#admin-token")!;
  input.value = token;
  const callsBefore = page.fetchSpy.calls;
  click(page.document.querySelector("#admin-set")!);
  await waitFor(() => page.fetchSpy.calls > callsBefore);
  await new Promise(resolve => setTimeout(resolve, 30));
}

test("frontend: open polls show live counts only; drafts stay hidden; token stays in memory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "veilvote-fe-open-"));
  const databasePath = join(directory, "veilvote.sqlite");
  const { server, base } = await serve(databasePath);
  const page = await mountPage(base);
  try {
    await waitFor(() => page.document.querySelectorAll(".poll-card").length === 2);
    pickPollCard(page.document, "community-garden-autumn").click();
    await waitFor(() => page.document.querySelector(".results-live") !== null);
    assert.match(page.document.querySelector(".results-live h3")!.textContent!, /实时计数/);
    assert.equal(page.document.querySelector(".snapshot-panel"), null, "open polls have no snapshot panel");

    // A draft created out-of-band never appears on the public list.
    await jsonFetch(base, "/api/polls", { method: "POST", body: JSON.stringify(pollPayload("hidden-draft")) });
    assert.ok(![...page.document.querySelectorAll<HTMLButtonElement>(".poll-card")].some(card => card.dataset.id === "hidden-draft"));

    // The token lives in page memory only: the password input is cleared and
    // nothing reaches web storage.
    await setAdminToken(page, ADMIN_TOKEN);
    assert.equal(page.document.querySelector<HTMLInputElement>("#admin-token")!.value, "");
    assert.equal(page.window.localStorage.length, 0);
    assert.equal(page.window.sessionStorage.length, 0);
    // With the token set, the manager sees the draft.
    await waitFor(() => page.document.querySelector('.poll-card[data-id="hidden-draft"]') !== null);
  } finally {
    await page.cleanup();
    await stop(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("frontend: closed snapshot renders ordered counts, survives refresh and restart, and is copyable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "veilvote-fe-snap-"));
  const databasePath = join(directory, "veilvote.sqlite");
  const started = await startVotedServer(databasePath);
  const page = await mountPage(started.base);
  let digestBefore = "";
  try {
    await waitFor(() => page.document.querySelectorAll(".poll-card").length >= 1);
    pickPollCard(page.document, started.pollId).click();
    await waitFor(() => page.document.querySelector(".snapshot-meta") !== null);

    // Counts keep the poll's original option order rather than id sorting.
    const items = [...page.document.querySelectorAll<HTMLElement>(".tally li")].map(li => li.textContent!);
    assert.equal(items.length, 2);
    assert.match(items[0], /方案 B（先列出）/);
    assert.match(items[0], /2 票/);
    assert.match(items[1], /方案 A（后列出）/);
    assert.match(items[1], /1 票/);

    const metas = () => [...page.document.querySelectorAll(".snapshot-meta dd")].map(dd => dd.textContent!);
    assert.match(metas()[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "closedAt is shown");
    assert.equal(metas()[1], "v1", "groupVersion is shown");
    assert.equal(metas()[2], "3", "total is shown");
    digestBefore = metas()[3];
    assert.match(digestBefore, /^[0-9a-f]{64}$/, "digest is shown");

    const snapshot = JSON.parse(page.document.querySelector(".snapshot-json")!.textContent!) as PollSnapshot;
    assert.equal(snapshot.pollId, started.pollId);
    assert.equal(snapshot.groupVersion, 1);
    assert.deepEqual(snapshot.options, [{ id: "plan-b", count: 2 }, { id: "plan-a", count: 1 }]);

    // Re-fetch confirms stability via the digest comparison.
    const refreshButton = [...page.document.querySelectorAll<HTMLButtonElement>(".snapshot-actions button")]
      .find(button => button.textContent!.includes("重新拉取"))!;
    refreshButton.click();
    await waitFor(() => page.document.querySelector(".snapshot-status")?.textContent?.includes("digest 与上次一致") === true);
    assert.equal(metas()[3], digestBefore);

    // The snapshot summary copies as JSON.
    const copyButton = [...page.document.querySelectorAll<HTMLButtonElement>(".snapshot-actions button")]
      .find(button => button.textContent!.includes("复制"))!;
    copyButton.click();
    await waitFor(() => page.clipboard.value.length > 0);
    const copied = JSON.parse(page.clipboard.value) as PollSnapshot;
    assert.deepEqual(copied.options, snapshot.options);
    assert.equal(copied.digest, digestBefore);
    assert.equal(copied.closedAt, snapshot.closedAt);
  } finally {
    await page.cleanup();
    await stop(started.server);
  }

  // Restart the service against the same SQLite file: same digest, same counts.
  const restarted = await serve(databasePath);
  const page2 = await mountPage(restarted.base);
  try {
    await waitFor(() => page2.document.querySelectorAll(".poll-card").length >= 1);
    pickPollCard(page2.document, started.pollId).click();
    await waitFor(() => page2.document.querySelector(".snapshot-meta") !== null);
    const digest = [...page2.document.querySelectorAll(".snapshot-meta dd")].map(dd => dd.textContent!)[3];
    assert.equal(digest, digestBefore, "snapshot unchanged after restart");
    const refreshButton = [...page2.document.querySelectorAll<HTMLButtonElement>(".snapshot-actions button")]
      .find(button => button.textContent!.includes("重新拉取"))!;
    refreshButton.click();
    await waitFor(() => page2.document.querySelector(".snapshot-status")?.textContent?.includes("digest 与上次一致") === true);
  } finally {
    await page2.cleanup();
    await stop(restarted.server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("frontend: receipt verification reports success, 404 and 422 and keeps no secret", async () => {
  const directory = mkdtempSync(join(tmpdir(), "veilvote-fe-verify-"));
  const databasePath = join(directory, "veilvote.sqlite");
  const started = await startVotedServer(databasePath);
  const page = await mountPage(started.base);
  try {
    await waitFor(() => page.document.querySelectorAll(".poll-card").length >= 1);
    pickPollCard(page.document, started.pollId).click();
    await waitFor(() => page.document.querySelector(".verify-form") !== null);

    const form = page.document.querySelector<HTMLFormElement>(".verify-form")!;
    const field = (id: string) => page.document.querySelector<HTMLInputElement>(id)!;
    const inputs = {
      receiptId: field("#verify-receipt-id"),
      pollId: field("#verify-poll-id"),
      optionId: field("#verify-option-id"),
      nullifier: field("#verify-nullifier")
    };
    assert.equal(inputs.pollId.value, started.pollId, "pollId is prefilled from the current poll");
    const statusLine = () => page.document.querySelector(".verify-status")!;
    const doSubmit = () => submit(page, form);

    // Happy path.
    const receipt = started.receipts[0];
    inputs.receiptId.value = receipt.id;
    inputs.optionId.value = receipt.optionId;
    inputs.nullifier.value = receipt.nullifier;
    doSubmit();
    await waitFor(() => statusLine().textContent!.includes("核验成功"));
    assert.ok(statusLine().textContent!.includes(receipt.acceptedAt));

    // Unknown receipt id -> 404.
    inputs.receiptId.value = "00000000-0000-0000-0000-000000000000";
    doSubmit();
    await waitFor(() => statusLine().textContent!.includes("404"));
    assert.match(statusLine().textContent!, /未找到/);

    // A known receipt with a wrong field -> 422 receipt_mismatch, retryable.
    inputs.receiptId.value = receipt.id;
    inputs.optionId.value = "plan-a";
    doSubmit();
    await waitFor(() => statusLine().textContent!.includes("422"));
    assert.match(statusLine().textContent!, /receipt_mismatch/);

    // Empty fields are caught client-side; no request is sent.
    inputs.optionId.value = "";
    const callsBefore = page.fetchSpy.calls;
    doSubmit();
    assert.ok(statusLine().textContent!.includes("请填写"));
    assert.equal(page.fetchSpy.calls, callsBefore);

    // The results page never renders an identity-secret input; the only
    // password field anywhere is the header's admin-token box.
    assert.equal(page.document.querySelector("#poll-detail input[type='password']"), null);
    assert.equal(page.document.querySelector(".verify-form input[type='password']"), null);
  } finally {
    await page.cleanup();
    await stop(started.server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("frontend: verification handles 400 and network failures, locks while pending and allows retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "veilvote-fe-verify2-"));
  const databasePath = join(directory, "veilvote.sqlite");
  const started = await startVotedServer(databasePath);
  const page = await mountPage(started.base);
  try {
    await waitFor(() => page.document.querySelectorAll(".poll-card").length >= 1);
    pickPollCard(page.document, started.pollId).click();
    await waitFor(() => page.document.querySelector(".verify-form") !== null);
    const form = page.document.querySelector<HTMLFormElement>(".verify-form")!;
    const field = (id: string) => page.document.querySelector<HTMLInputElement>(id)!;
    const statusLine = () => page.document.querySelector(".verify-status")!;
    const submitButton = () => page.document.querySelector<HTMLButtonElement>(".verify-form button")!;
    const allInputs = () => [...page.document.querySelectorAll<HTMLInputElement>(".verify-form input")];
    const fill = () => {
      field("#verify-receipt-id").value = "r-1";
      field("#verify-poll-id").value = started.pollId;
      field("#verify-option-id").value = "plan-b";
      field("#verify-nullifier").value = "dom-n-1";
    };

    // 400 invalid_verification is rendered distinctly.
    page.setFetchOverride(async () => new Response(JSON.stringify({ error: "invalid_verification" }), {
      status: 400, headers: { "Content-Type": "application/json" }
    }));
    fill();
    submit(page, form);
    await waitFor(() => statusLine().textContent!.includes("400"));
    assert.match(statusLine().textContent!, /格式错误/);
    assert.equal(submitButton().disabled, false, "the form unlocks after the failure");

    // Network failure: fetch rejects with a TypeError, like a dropped connection.
    page.setFetchOverride(async () => { throw new TypeError("Failed to fetch"); });
    submit(page, form);
    await waitFor(() => statusLine().textContent!.includes("网络失败"));
    assert.ok(allInputs().every(input => !input.disabled), "the form is editable again for retry");

    // A pending submission disables the whole form and ignores a double submit.
    let release: () => void = () => {};
    let calls = 0;
    page.setFetchOverride(() => {
      calls += 1;
      return new Promise<Response>(resolve => {
        release = () => resolve(new Response(JSON.stringify({ valid: true, receipt: started.receipts[0] }), {
          status: 200, headers: { "Content-Type": "application/json" }
        }));
      });
    });
    submit(page, form);
    await waitFor(() => submitButton().disabled === true);
    assert.ok(allInputs().every(input => input.disabled), "every input is disabled while pending");
    submit(page, form);
    assert.equal(calls, 1, "a repeated submit while pending does not fire another request");
    release();
    await waitFor(() => statusLine().textContent!.includes("核验成功"));
    assert.equal(submitButton().disabled, false);

    // With the real network restored, corrected values can be retried.
    page.setFetchOverride(null);
    field("#verify-receipt-id").value = started.receipts[1].id;
    field("#verify-option-id").value = started.receipts[1].optionId;
    field("#verify-nullifier").value = started.receipts[1].nullifier;
    submit(page, form);
    await waitFor(() => statusLine().textContent!.includes("核验成功"));
  } finally {
    await page.cleanup();
    await stop(started.server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("frontend: audit view loads, filters reset to page 1, paginates, and handles empty/401/400/out-of-range", async () => {
  const directory = mkdtempSync(join(tmpdir(), "veilvote-fe-audit-"));
  const databasePath = join(directory, "veilvote.sqlite");
  const { server, base } = await serve(databasePath);
  const page = await mountPage(base);
  try {
    await waitFor(() => page.document.querySelectorAll(".poll-card").length === 2);
    // 12 successful creates + 2 rejected transitions = 14 events.
    for (let i = 1; i <= 12; i += 1) {
      const result = await jsonFetch(base, "/api/polls", { method: "POST", body: JSON.stringify(pollPayload(`evt-${String(i).padStart(2, "0")}`)) });
      assert.equal(result.status, 201);
    }
    for (let i = 0; i < 2; i += 1) {
      await jsonFetch(base, "/api/polls/evt-01/status", {
        method: "POST", body: JSON.stringify({ status: "closed", expectedStatus: "draft" })
      });
    }
    await setAdminToken(page, ADMIN_TOKEN);
    page.document.querySelector<HTMLButtonElement>("#admin-audit")!.click();
    const state = () => page.document.querySelector(".audit-state")!;
    const summary = () => page.document.querySelector(".audit-summary")!;
    const indicator = () => page.document.querySelector("#audit-page-indicator")!;
    const rowCount = () => page.document.querySelectorAll(".audit-table tbody tr").length;
    await waitFor(() => /共 14 条/.test(summary().textContent ?? ""));
    assert.match(indicator().textContent!, /第 1 \/ 1 页/, "default page size 50 fits everything on one page");
    assert.equal(rowCount(), 14);

    // Page size 10 produces two pages and ten rows on page 1.
    const pageSizeFilter = page.document.querySelector<HTMLSelectElement>("#audit-page-size")!;
    pageSizeFilter.value = "10";
    change(pageSizeFilter);
    await waitFor(() => /第 1 \/ 2 页/.test(indicator().textContent!));
    assert.equal(rowCount(), 10);

    // Move to page 2, then change a filter: the request must return to page 1.
    page.document.querySelector<HTMLButtonElement>("#audit-next")!.click();
    await waitFor(() => /第 2 \/ 2 页/.test(indicator().textContent!));
    assert.equal(rowCount(), 4);
    const resultFilter = page.document.querySelector<HTMLSelectElement>("#audit-filter-result")!;
    resultFilter.value = "failure";
    change(resultFilter);
    await waitFor(() => rowCount() === 2);
    assert.match(page.fetchSpy.auditUrls.at(-1)!, /result=failure/);
    assert.match(page.fetchSpy.auditUrls.at(-1)!, /[?&]page=1(?!\d)/, "filter change resets to page 1");
    assert.ok([...page.document.querySelectorAll(".audit-table tbody tr")].every(tr => /失败/.test(tr.children[3].textContent!)));

    // Exact pollId filter: create + two rejected transitions for evt-01.
    resultFilter.value = "";
    change(resultFilter);
    await waitFor(() => /共 14 条/.test(summary().textContent ?? ""));
    const pollFilter = page.document.querySelector<HTMLInputElement>("#audit-filter-poll-id")!;
    pollFilter.value = "evt-01";
    change(pollFilter);
    await waitFor(() => /共 3 条/.test(summary().textContent ?? ""));
    assert.ok([...page.document.querySelectorAll(".audit-table tbody tr")].every(tr => tr.children[2].textContent === "evt-01"));

    // Empty result set renders the empty state, not an error.
    pollFilter.value = "no-such-poll";
    change(pollFilter);
    await waitFor(() => state().textContent!.includes("没有符合"));
    assert.equal(rowCount(), 0);

    // Wrong token -> 401 state. The modal is never reopened (that would replace
    // its DOM and detach the filter elements); a change-event reload on the
    // still-mounted modal picks up the new in-memory token.
    pollFilter.value = "";
    const reload = () => change(page.document.querySelector<HTMLSelectElement>("#audit-filter-action")!);
    page.document.querySelector<HTMLButtonElement>("#admin-clear")!.click();
    await waitFor(() => page.document.querySelector<HTMLButtonElement>("#admin-audit")!.hidden === true);
    await setAdminToken(page, "wrong-token");
    reload();
    await waitFor(() => state().textContent!.includes("401"));
    assert.match(state().textContent!, /admin_unauthorized|未授权/);
    page.document.querySelector<HTMLButtonElement>("#admin-clear")!.click();
    await waitFor(() => page.document.querySelector<HTMLButtonElement>("#admin-audit")!.hidden === true);
    await setAdminToken(page, ADMIN_TOKEN);
    reload();
    await waitFor(() => /共 14 条/.test(summary().textContent ?? ""));
    assert.equal(rowCount(), 10);

    // 400 from the server surfaces with the server error text.
    page.setFetchOverride(async () => new Response(JSON.stringify({ error: "invalid_time_range" }), {
      status: 400, headers: { "Content-Type": "application/json" }
    }));
    change(pollFilter);
    await waitFor(() => state().textContent!.includes("400"));
    assert.match(state().textContent!, /时间范围/);
    page.setFetchOverride(null);
    // Out-of-range page without crashing. A (simulated) trail with many pages
    // walks the pager onto page 3; restoring the real server (whose trail has
    // only 2 pages) turns further navigation into empty out-of-range pages,
    // while first/previous still provide a way back.
    page.setFetchOverride(async input => {
      const requested = Number(new URL(String(input)).searchParams.get("page") ?? "1");
      return new Response(JSON.stringify({ events: [], total: 1000, page: requested, pageSize: 10, totalPages: 100 }), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    });
    change(pollFilter);
    await waitFor(() => /第 1 \/ 100 页/.test(indicator().textContent!));
    page.document.querySelector<HTMLButtonElement>("#audit-next")!.click();
    await waitFor(() => /第 2 \/ 100 页/.test(indicator().textContent!));
    page.document.querySelector<HTMLButtonElement>("#audit-next")!.click();
    await waitFor(() => /第 3 \/ 100 页/.test(indicator().textContent!));
    page.setFetchOverride(null);
    page.document.querySelector<HTMLButtonElement>("#audit-next")!.click();
    await waitFor(() => state().textContent!.includes("超出范围"));
    assert.equal(rowCount(), 0);
    assert.match(indicator().textContent!, /第 4 \/ 2 页/);
    assert.equal(page.document.querySelector<HTMLButtonElement>("#audit-first")!.disabled, false);
    assert.equal(page.document.querySelector<HTMLButtonElement>("#audit-prev")!.disabled, false);
    page.document.querySelector<HTMLButtonElement>("#audit-first")!.click();
    await waitFor(() => rowCount() === 10);
    // Last-page button jumps to the final page known from the response.
    change(pollFilter);
    await waitFor(() => /共 14 条/.test(summary().textContent ?? ""));
    page.document.querySelector<HTMLButtonElement>("#audit-last")!.click();
    await waitFor(() => /第 2 \/ 2 页/.test(indicator().textContent!));
    assert.match(page.fetchSpy.auditUrls.at(-1)!, /[?&]page=2(?!\d)/);
  } finally {
    await page.cleanup();
    await stop(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test.after(() => { rmSync(buildDirectory, { recursive: true, force: true }); });
