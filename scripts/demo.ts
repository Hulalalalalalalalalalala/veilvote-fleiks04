import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { Identity } from "@semaphore-protocol/identity";
import { Group } from "@semaphore-protocol/group";
import { generateProof } from "@semaphore-protocol/proof";
import { createApp } from "../src/app.ts";
import { terminateProverWorkers } from "../src/voting.ts";
import type { AuditEvent, AuditPage, PollDetail, PollResults, PollSummary, SemaphoreProofPayload, VoteReceipt } from "../src/types.ts";

const ADMIN_TOKEN = "demo-admin-token";
const directory = mkdtempSync(join(tmpdir(), "veilvote-demo-"));
const databasePath = join(directory, "veilvote.sqlite");
const adminHeaders = { "Content-Type": "application/json", "X-Admin-Token": ADMIN_TOKEN };

async function serve(): Promise<{ server: Server; base: string }> {
  const server = createApp(databasePath, undefined, { adminToken: ADMIN_TOKEN });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Service has no TCP address");
  return { server, base: `http://127.0.0.1:${address.port}` };
}
async function stop(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}
async function pollDetail(base: string, pollId: string, token?: string) {
  const response = await fetch(`${base}/api/polls/${encodeURIComponent(pollId)}`, token ? { headers: { "X-Admin-Token": token } } : undefined);
  if (!response.ok) throw new Error(`Poll detail returned ${response.status}`);
  return ((await response.json()) as { poll: PollDetail }).poll;
}
async function api(base: string, path: string, init: RequestInit & { token?: string | false } = {}) {
  const headers = new Headers(init.headers);
  if (init.token !== false) headers.set("X-Admin-Token", init.token ?? ADMIN_TOKEN);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${base}${path}`, { ...init, headers });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
}
function showResults(result: PollResults, poll: PollDetail) {
  const labels = new Map(poll.options.map(option => [option.id, option.label]));
  console.log(`结果（共 ${result.total} 票）：`);
  for (const option of result.options) console.log(`  ${labels.get(option.id) ?? option.id}：${option.count} 票`);
}
/** Canonical, copyable snapshot summary in the same field order as the digest input. */
function snapshotText(result: PollResults): string {
  const snapshot = result.snapshot!;
  return [
    `pollId: ${snapshot.pollId}`,
    `groupVersion: ${snapshot.groupVersion}`,
    `total: ${snapshot.total}`,
    ...snapshot.options.map(option => `options.${option.id}: ${option.count}`),
    `closedAt: ${snapshot.closedAt}`,
    `digest: ${snapshot.digest}`
  ].join("\n");
}
async function verifyReceipt(base: string, id: string, body: unknown) {
  const response = await fetch(`${base}/api/receipts/${encodeURIComponent(id)}/verify`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
}
const commitmentOf = (secret: string) => new Identity(secret).commitment.toString();

try {
  const { server, base } = await serve();
  console.log(`\nVeilVote · 议题生命周期 / 管理授权 / 审计 演示\n本地产品 API：${base}\n管理令牌：${ADMIN_TOKEN}（仅用于下列带 X-Admin-Token 的请求）\n`);

  console.log("1) 未授权请求一律 401 admin_unauthorized，且不写数据、不留审计…");
  console.log(`   POST /api/polls            无令牌 → ${(await api(base, "/api/polls", { method: "POST", token: false, body: "{}" })).status}`);
  console.log(`   POST .../group             错令牌 → ${(await api(base, "/api/polls/community-garden-autumn/group", { method: "POST", token: "wrong", body: "{}" })).status}`);
  console.log(`   GET  /api/admin/audit      无令牌 → ${(await api(base, "/api/admin/audit", { method: "GET", token: false })).status}`);

  console.log("\n2) 管理员创建议题（POST /api/polls），初始为 draft…");
  const seeded = await pollDetail(base, "community-garden-autumn");
  const draftId = "demo-tea-corner";
  const created = await api(base, "/api/polls", {
    method: "POST",
    body: JSON.stringify({
      id: draftId, title: "公共茶室的轮值安排", summary: "确定茶室每日常态开放的轮值方式。",
      description: "社区希望以轮值方式维护公共茶室，请成员在两个方案中选择。", organizer: "青屿社区议事组",
      publishedAt: new Date().toISOString(), closesAt: "2026-12-31T12:00:00Z",
      options: [{ id: "weekly", label: "按周轮值" }, { id: "monthly", label: "按月轮值" }],
      commitments: seeded.eligibleMemberCommitments
    })
  });
  console.log(`   ${created.status} 已创建草稿「${draftId}」，状态 ${(created.body.poll as PollDetail).status}`);
  console.log(`   id 冲突再创建 → ${(await api(base, "/api/polls", { method: "POST", body: JSON.stringify({ id: draftId, title: "x", summary: "y", description: "z", organizer: "o", publishedAt: "2026-09-01T00:00:00Z", closesAt: "2026-12-31T00:00:00Z", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], commitments: seeded.eligibleMemberCommitments }) })).status} poll_exists`);

  console.log("\n3) draft 不进公共列表，普通详情/结果均 404…");
  const publicPolls = (await (await fetch(`${base}/api/polls`)).json() as { polls: PollSummary[] }).polls;
  console.log(`   公共列表含草稿？${publicPolls.some(poll => poll.id === draftId)}（应为 false）`);
  console.log(`   普通详情 → ${(await fetch(`${base}/api/polls/${draftId}`)).status}，结果 → ${(await fetch(`${base}/api/polls/${draftId}/results`)).status}`);

  console.log("\n4) 非法状态转换被拒（draft 不能直接 closed）…");
  const illegal = await api(base, `/api/polls/${draftId}/status`, { method: "POST", body: JSON.stringify({ status: "closed", expectedStatus: "draft" }) });
  console.log(`   draft → closed：${illegal.status} ${illegal.body.error}`);

  console.log("\n5) draft 阶段可变更成员；随后 draft → open…");
  const joined = await api(base, `/api/polls/${draftId}/group`, { method: "POST", body: JSON.stringify({ operation: "join", expectedVersion: 1, commitment: commitmentOf("veilvote-demo-member-09") }) });
  console.log(`   join 第 9 位成员 → ${joined.status}，新版本 v${(joined.body.group as { version: number }).version}`);
  const opened = await api(base, `/api/polls/${draftId}/status`, { method: "POST", body: JSON.stringify({ status: "open", expectedStatus: "draft" }) });
  console.log(`   draft → open：${opened.status}，当前状态 ${opened.body.status}`);

  console.log("\n6) 开放后未投票仍可变更；成员 01 投出首票后名单冻结…");
  let poll = await pollDetail(base, draftId, ADMIN_TOKEN);
  const identity = new Identity("veilvote-demo-member-01");
  const proof = await generateProof(identity, new Group(poll.eligibleMemberCommitments), poll.options[0].id, poll.id) as SemaphoreProofPayload;
  const vote = await fetch(`${base}/api/polls/${draftId}/votes`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ optionId: poll.options[0].id, groupVersion: poll.groupVersion, proof })
  }).then(async r => ({ status: r.status, body: await r.json() as { receipt?: VoteReceipt; error?: string } }));
  console.log(`   首票 → ${vote.status}，回执 ${vote.body.receipt?.id.slice(0, 8)}…`);
  const frozen = await api(base, `/api/polls/${draftId}/group`, { method: "POST", body: JSON.stringify({ operation: "join", expectedVersion: poll.groupVersion, commitment: commitmentOf("veilvote-demo-member-10") }) });
  console.log(`   首票后再 join → ${frozen.status} ${frozen.body.error}`);

  console.log("\n7) 截止并发：创建一个即将截止的议题，截止瞬间并发投票由事务裁决…");
  const deadlineId = "demo-fast-deadline";
  const closesAtIso = new Date(Date.now() + 1500).toISOString();
  await api(base, "/api/polls", {
    method: "POST",
    body: JSON.stringify({
      id: deadlineId, title: "短时议题", summary: "s", description: "d", organizer: "o",
      publishedAt: new Date().toISOString(), closesAt: closesAtIso,
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], commitments: seeded.eligibleMemberCommitments
    })
  });
  await api(base, `/api/polls/${deadlineId}/status`, { method: "POST", body: JSON.stringify({ status: "open", expectedStatus: "draft" }) });
  console.log(`   议题已开放，截止时间 ${closesAtIso}，等待越过截止…`);
  await new Promise(resolve => setTimeout(resolve, 1700));
  // Structurally valid votes racing the cutoff: the deadline gate precedes
  // proof verification, so both are adjudicated by the transaction and the
  // poll is atomically persisted closed exactly once.
  const fakeVote = { optionId: "a", proof: { merkleTreeDepth: 20, merkleTreeRoot: "1", message: "1", nullifier: "9", scope: "1", points: ["1", "2", "3", "4", "5", "6", "7", "8"] } };
  const [late1, late2] = await Promise.all([
    api(base, `/api/polls/${deadlineId}/votes`, { method: "POST", token: false, body: JSON.stringify(fakeVote) }),
    api(base, `/api/polls/${deadlineId}/votes`, { method: "POST", token: false, body: JSON.stringify({ ...fakeVote, proof: { ...fakeVote.proof, nullifier: "10" } }) })
  ]);
  console.log(`   并发越界票：${late1.status} ${late1.body.error} / ${late2.status} ${late2.body.error}`);
  const afterDeadline = await pollDetail(base, deadlineId, ADMIN_TOKEN);
  console.log(`   截止后议题状态已原子持久化为：${afterDeadline.status}`);

  console.log("\n8) open → closed → archived，closed/archived 结果继续公开，快照字段完整可复制…");
  const closed = await api(base, `/api/polls/${draftId}/status`, { method: "POST", body: JSON.stringify({ status: "closed", expectedStatus: "open" }) });
  console.log(`   open → closed：${closed.status}`);
  const closedResult = (await (await fetch(`${base}/api/polls/${draftId}/results`)).json() as { result: PollResults }).result;
  showResults(closedResult, poll);
  const closedSnapshot = closedResult.snapshot!;
  console.log("   不可变快照（与计票同事务写入，字段顺序即摘要可复制顺序）：");
  console.log(snapshotText(closedResult).split("\n").map(line => `     ${line}`).join("\n"));
  const archived = await api(base, `/api/polls/${draftId}/status`, { method: "POST", body: JSON.stringify({ status: "archived", expectedStatus: "closed" }) });
  console.log(`   closed → archived：${archived.status}；归档后结果 → ${(await fetch(`${base}/api/polls/${draftId}/results`)).status}`);
  const archivedSnapshot = ((await (await fetch(`${base}/api/polls/${draftId}/results`)).json() as { result: PollResults }).result).snapshot!;
  console.log(`   归档后快照 digest 与关闭时一致：${archivedSnapshot.digest === closedSnapshot.digest}`);

  console.log("\n8a) 回执核验 POST /api/receipts/:id/verify（公开接口，不涉及身份秘密）…");
  console.log(`   字段全部相符 → ${(await verifyReceipt(base, vote.body.receipt!.id, { pollId: draftId, optionId: poll.options[0].id, nullifier: vote.body.receipt!.nullifier })).status}`);
  console.log(`   nullifier 不符 → ${(await verifyReceipt(base, vote.body.receipt!.id, { pollId: draftId, optionId: poll.options[0].id, nullifier: "bogus" })).status} receipt_mismatch`);
  console.log(`   未知回执编号 → ${(await verifyReceipt(base, "no-such-receipt", { pollId: draftId, optionId: poll.options[0].id, nullifier: "x" })).status} receipt_not_found`);
  console.log(`   缺字段（格式错误）→ ${(await verifyReceipt(base, vote.body.receipt!.id, { pollId: draftId })).status} invalid_verification`);

  console.log("\n9) 审计查询（GET /api/admin/audit，倒序、筛选、分页、严格时间校验）…");
  const audit = await api(base, "/api/admin/audit", { method: "GET" });
  const auditPage = audit.body as unknown as AuditPage;
  const events = auditPage.events;
  console.log(`   共 ${auditPage.total} 条事件，第 ${auditPage.page}/${auditPage.totalPages} 页（默认每页 ${auditPage.pageSize} 条），最近 5 条：`);
  for (const event of events.slice(0, 5)) {
    console.log(`   [${event.at}] ${event.action} / ${event.pollId} / ${event.result} / ${JSON.stringify(event.details)}`);
  }
  console.log(`   审计中是否泄露令牌？${JSON.stringify(audit.body).includes(ADMIN_TOKEN)}（应为 false）`);

  // Filters: exact-match pollId/action/result compose; filters and pagination
  // travel together on one query string.
  const onlyDraft = await api(base, `/api/admin/audit?pollId=${encodeURIComponent(draftId)}&action=poll_status_change&pageSize=5`, { method: "GET" });
  const draftEvents = (onlyDraft.body as unknown as AuditPage).events;
  console.log(`   筛选 pollId=${draftId}&action=poll_status_change：${onlyDraft.body.total} 条，全部匹配：${draftEvents.every(e => e.pollId === draftId && e.action === "poll_status_change")}`);

  // Pagination contract: capped page size, out-of-range page is an empty 200.
  const capped = await api(base, "/api/admin/audit?pageSize=999", { method: "GET" });
  console.log(`   pageSize=999 被截断为 ${capped.body.pageSize}（上限 200）；page=999 返回空页：${((await api(base, "/api/admin/audit?page=999", { method: "GET" })).body.events as AuditEvent[]).length === 0}`);

  // from/to accept only strict timezone-aware ISO 8601 instants.
  const pivot = events[events.length - 1]?.at ?? new Date().toISOString();
  const range = await api(base, `/api/admin/audit?from=${encodeURIComponent(pivot)}&to=${encodeURIComponent(pivot)}`, { method: "GET" });
  console.log(`   含端点区间 from=to=${pivot}：${range.status}，命中 ${((range.body.events as AuditEvent[]).filter(e => e.at === pivot).length >= 1) ? "是" : "否"}`);
  for (const loose of ["2026-09-20", "2026-09-20 10:00:00Z", "2026-09-20T10:00:00", "2026-02-29T00:00:00Z"]) {
    const rejected = await api(base, `/api/admin/audit?from=${encodeURIComponent(loose)}`, { method: "GET" });
    console.log(`   宽松时间「${loose}」→ ${rejected.status} ${rejected.body.error}`);
  }
  const invertedAudit = await api(base, "/api/admin/audit?from=2026-12-31T00:00:00Z&to=2026-01-01T00:00:00Z", { method: "GET" });
  console.log(`   倒置区间 → ${invertedAudit.status} ${invertedAudit.body.error}`);

  await stop(server);
  console.log("\n10) 服务已停止，使用同一 SQLite 文件重启，验证恢复…");
  const restarted = await serve();
  try {
    const recovered = await pollDetail(restarted.base, draftId, ADMIN_TOKEN);
    console.log(`   重启后 ${draftId} 状态：${recovered.status}（应为 archived）`);
    const recoveredDeadline = await pollDetail(restarted.base, deadlineId, ADMIN_TOKEN);
    console.log(`   重启后 ${deadlineId} 状态：${recoveredDeadline.status}（截止关闭持久化，应为 closed）`);
    const restartedAudit = await api(restarted.base, "/api/admin/audit", { method: "GET" });
    const restartedEvents = restartedAudit.body.events as AuditEvent[];
    console.log(`   重启后审计事件数：${restartedEvents.length}（与重启前一致：${restartedEvents.length === events.length}）`);
    const recoveredResult = await (await fetch(`${restarted.base}/api/polls/${draftId}/results`)).json() as { result: PollResults };
    showResults(recoveredResult.result, recovered);
    const restartedDigest = recoveredResult.result.snapshot!.digest;
    console.log(`   重启后快照 closedAt=${recoveredResult.result.snapshot!.closedAt}、groupVersion=v${recoveredResult.result.snapshot!.groupVersion}`);
    console.log(`   重启后 digest 与关闭时完全一致：${restartedDigest === archivedSnapshot.digest}（${restartedDigest.slice(0, 16)}…）`);
  } finally {
    await stop(restarted.server);
  }
  console.log("\n演示完成：管理授权、draft 生命周期、非法转换拒绝、首票冻结、截止并发裁决、closed/archived 快照（含可复制摘要与 digest）、回执核验四种结果、审计严格时间校验/筛选/翻页与重启恢复均已验证。");
} finally {
  await terminateProverWorkers();
  rmSync(directory, { recursive: true, force: true });
}
