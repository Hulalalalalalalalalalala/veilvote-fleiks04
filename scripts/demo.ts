import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { Identity } from "@semaphore-protocol/identity";
import { Group } from "@semaphore-protocol/group";
import { generateProof } from "@semaphore-protocol/proof";
import { createApp } from "../src/app.ts";
import { terminateProverWorkers } from "../src/voting.ts";
import type { AuditEvent, AuditPage, PollDetail, PollResults, PollSnapshot, PollSummary, SemaphoreProofPayload, VoteReceipt } from "../src/types.ts";

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
function digestOf(snapshot: PollSnapshot): string {
  const { pollId, groupVersion, total, options, closedAt } = snapshot;
  return createHash("sha256").update(JSON.stringify({ pollId, groupVersion, total, options, closedAt }), "utf8").digest("hex");
}
function showSnapshot(result: PollResults): PollSnapshot {
  const snapshot = result.snapshot!;
  console.log(`  关闭快照：closedAt=${snapshot.closedAt} groupVersion=v${snapshot.groupVersion} total=${snapshot.total}`);
  console.log(`  选项计数（按议题原顺序）：${snapshot.options.map(option => `${option.id}=${option.count}`).join(" / ")}`);
  console.log(`  digest=${snapshot.digest}`);
  console.log(`  按规则重算 digest 一致？${digestOf(snapshot) === snapshot.digest}`);
  return snapshot;
}
async function verifyReceipt(base: string, receipt: VoteReceipt, patch: Partial<VoteReceipt> = {}) {
  const response = await fetch(`${base}/api/receipts/${encodeURIComponent(receipt.id)}/verify`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pollId: receipt.pollId, optionId: receipt.optionId, nullifier: receipt.nullifier, ...patch })
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
  const firstReceipt = vote.body.receipt!;
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

  console.log("\n8) open → closed → archived，closed/archived 公开不可变快照…");
  const closed = await api(base, `/api/polls/${draftId}/status`, { method: "POST", body: JSON.stringify({ status: "closed", expectedStatus: "open" }) });
  console.log(`   open → closed：${closed.status}`);
  const closedResult = (await (await fetch(`${base}/api/polls/${draftId}/results`)).json() as { result: PollResults }).result;
  showResults(closedResult, poll);
  const snapshot = showSnapshot(closedResult);

  console.log("\n8b) 回执核验（POST /api/receipts/:id/verify，不涉及身份秘密）…");
  const verified = await verifyReceipt(base, firstReceipt);
  console.log(`   字段全符：${verified.status} valid=${(verified.body.valid as boolean) ?? false}`);
  const mismatch = await verifyReceipt(base, firstReceipt, { optionId: poll.options[1].id });
  console.log(`   optionId 不符：${mismatch.status} ${mismatch.body.error}`);
  const unknown = await verifyReceipt(base, { ...firstReceipt, id: "00000000-0000-0000-0000-000000000000" });
  console.log(`   未知回执：${unknown.status} ${unknown.body.error}`);
  const malformed = await fetch(`${base}/api/receipts/${firstReceipt.id}/verify`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pollId: firstReceipt.pollId })
  });
  console.log(`   缺字段格式错误：${malformed.status} ${(await malformed.json() as { error: string }).error}`);

  const archived = await api(base, `/api/polls/${draftId}/status`, { method: "POST", body: JSON.stringify({ status: "archived", expectedStatus: "closed" }) });
  console.log(`   closed → archived：${archived.status}；归档后快照不变：`);
  const archivedResult = (await (await fetch(`${base}/api/polls/${draftId}/results`)).json() as { result: PollResults }).result;
  console.log(`   归档前后快照完全一致？${JSON.stringify(archivedResult.snapshot) === JSON.stringify(snapshot)}`);

  console.log("\n9) 审计查询（GET /api/admin/audit）：筛选、严格时间与分页…");
  const audit = await api(base, "/api/admin/audit", { method: "GET" });
  const events = audit.body.events as AuditEvent[];
  console.log(`   默认查询共 ${events.length} 条（默认每页 50、倒序）；不泄露令牌？${JSON.stringify(audit.body).includes(ADMIN_TOKEN) === false}`);
  const asPage = (body: Record<string, unknown>): AuditPage => body as unknown as AuditPage;
  const failures = await api(base, "/api/admin/audit?result=failure", { method: "GET" });
  console.log(`   result=failure：${asPage(failures.body).total} 条，全部为失败？${(asPage(failures.body).events).every(e => e.result === "failure")}`);
  const byPoll = await api(base, `/api/admin/audit?pollId=${encodeURIComponent(deadlineId)}`, { method: "GET" });
  console.log(`   pollId=${deadlineId}：${asPage(byPoll.body).total} 条`);
  const nowIso = new Date().toISOString();
  const paged = await api(base, "/api/admin/audit?pageSize=5&page=1", { method: "GET" });
  console.log(`   pageSize=5&page=1：返回 ${asPage(paged.body).events.length} 条，totalPages=${asPage(paged.body).totalPages}`);
  const paged2 = await api(base, "/api/admin/audit?pageSize=5&page=2", { method: "GET" });
  console.log(`   pageSize=5&page=2：返回 ${asPage(paged2.body).events.length} 条，倒序且与第一页不重叠？${
    asPage(paged2.body).events.every(e2 => !(asPage(paged.body).events).some(e1 => e1.id === e2.id))
  }`);
  const cap = await api(base, "/api/admin/audit?pageSize=999", { method: "GET" });
  console.log(`   pageSize=999 截断为 ${asPage(cap.body).pageSize}（上限 200）`);
  const range = await api(base, `/api/admin/audit?from=${encodeURIComponent(nowIso)}`, { method: "GET" });
  console.log(`   带时区严格 ISO8601（from=${nowIso}）：${range.status}`);
  for (const loose of ["2026-09-20 10:00:00", "2026/09/20", "2026-09-20T10:00:00"]) {
    const bad = await api(base, `/api/admin/audit?from=${encodeURIComponent(loose)}`, { method: "GET" });
    console.log(`   拒绝宽松时间 ${JSON.stringify(loose)}：${bad.status} ${bad.body.error}`);
  }
  const inverted = await api(base, `/api/admin/audit?from=${encodeURIComponent(nowIso)}&to=2020-01-01T00:00:00Z`, { method: "GET" });
  console.log(`   倒置区间（from 晚于 to）：${inverted.status} ${inverted.body.error}`);

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
    console.log(`   重启后快照与关闭时完全一致？${JSON.stringify(recoveredResult.result.snapshot) === JSON.stringify(snapshot)}`);
    console.log(`   重启后 closedAt=${recoveredResult.result.snapshot!.closedAt} digest=${recoveredResult.result.snapshot!.digest}`);
  } finally {
    await stop(restarted.server);
  }
  console.log("\n演示完成：管理授权、draft 生命周期、非法转换拒绝、首票冻结、截止并发裁决、不可变快照与归档/重启一致、回执核验成败、严格时间校验、审计筛选翻页与重启恢复均已验证。");
} finally {
  await terminateProverWorkers();
  rmSync(directory, { recursive: true, force: true });
}
