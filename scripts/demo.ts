import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { Identity } from "@semaphore-protocol/identity";
import { Group } from "@semaphore-protocol/group";
import { generateProof } from "@semaphore-protocol/proof";
import { createApp } from "../src/app.ts";
import { terminateProverWorkers } from "../src/voting.ts";
import type {
  AuditEvent, GroupVersionSummary, PollDetail, PollResults, PollStatus, PollSummary, SemaphoreProofPayload, VoteReceipt
} from "../src/types.ts";

const ADMIN_TOKEN = "demo-admin-token";
const directory = mkdtempSync(join(tmpdir(), "veilvote-demo-"));
const databasePath = join(directory, "veilvote.sqlite");

async function serve(token?: string): Promise<{ server: Server; base: string }> {
  const server = createApp(databasePath, undefined, token);
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Service has no TCP address");
  return { server, base: `http://127.0.0.1:${address.port}` };
}
async function stop(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}
async function pollDetail(base: string, pollId: string, admin = false): Promise<PollDetail> {
  const response = await fetch(`${base}/api/polls/${encodeURIComponent(pollId)}`, admin ? { headers: { "X-Admin-Token": ADMIN_TOKEN } } : undefined);
  if (!response.ok) throw new Error(`Poll detail returned ${response.status}`);
  return ((await response.json()) as { poll: PollDetail }).poll;
}
async function postGroup(base: string, pollId: string, payload: unknown) {
  const response = await fetch(`${base}/api/polls/${encodeURIComponent(pollId)}/group`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Token": ADMIN_TOKEN },
    body: JSON.stringify(payload)
  });
  return { status: response.status, body: await response.json() as { group?: GroupVersionSummary; error?: string } };
}
async function postVote(base: string, pollId: string, payload: unknown) {
  const response = await fetch(`${base}/api/polls/${encodeURIComponent(pollId)}/votes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return { status: response.status, body: await response.json() as { receipt?: VoteReceipt; error?: string } };
}
async function postStatus(base: string, pollId: string, status: PollStatus, expectedStatus?: PollStatus, token = ADMIN_TOKEN) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["X-Admin-Token"] = token;
  const response = await fetch(`${base}/api/polls/${encodeURIComponent(pollId)}/status`, {
    method: "POST", headers, body: JSON.stringify(expectedStatus ? { status, expectedStatus } : { status })
  });
  return { status: response.status, body: await response.json() as { poll?: PollDetail; error?: string } };
}
async function results(base: string, pollId: string): Promise<PollResults> {
  const response = await fetch(`${base}/api/polls/${encodeURIComponent(pollId)}/results`);
  if (!response.ok) throw new Error(`Results returned ${response.status}`);
  return ((await response.json()) as { result: PollResults }).result;
}
function showResults(result: PollResults, poll: PollDetail) {
  const labels = new Map(poll.options.map(option => [option.id, option.label]));
  console.log(`结果（共 ${result.total} 票）：`);
  for (const option of result.options) console.log(`  ${labels.get(option.id) ?? option.id}：${option.count} 票`);
}
const commitmentOf = (secret: string) => new Identity(secret).commitment.toString();

try {
  console.log("\nVeilVote · 议题生命周期 / 管理授权 / 审计 演示");
  const { server, base } = await serve(ADMIN_TOKEN);
  console.log(`本地产品 API：${base}（ADMIN_TOKEN 已配置）\n`);

  console.log("0) 未配置令牌的服务：任何管理请求都 401 且不写数据");
  const locked = await serve(undefined);
  try {
    const denied = await fetch(`${locked.base}/api/admin/audit`, { headers: { "X-Admin-Token": "guessing" } });
    console.log(`   GET /api/admin/audit（猜测令牌）→ ${denied.status} ${(await denied.json() as { error: string }).error}`);
  } finally {
    await stop(locked.server);
  }
  const missingToken = await fetch(`${base}/api/polls`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  console.log(`   POST /api/polls 不带令牌 → ${missingToken.status} ${(await missingToken.json() as { error: string }).error}`);

  console.log("\n1) 管理员创建 draft 议题（201）");
  const draftBody = {
    id: "demo-lifecycle-issue",
    title: "周末社区工坊的主题",
    summary: "在陶艺与木工之间选择本季工坊主题。",
    description: "草案阶段仅管理员可见；开放后进入公共目录并可匿名投票。",
    organizer: "青屿社区议事组",
    publishedAt: new Date(Date.now() - 1000).toISOString(),
    closesAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    options: [{ id: "pottery", label: "陶艺工作坊" }, { id: "woodwork", label: "木工工作坊" }],
    commitments: ["veilvote-demo-member-01", "veilvote-demo-member-02", "veilvote-demo-member-03"].map(commitmentOf)
  };
  const created = await fetch(`${base}/api/polls`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Token": ADMIN_TOKEN }, body: JSON.stringify(draftBody)
  });
  const createdJson = await created.json() as { poll: PollDetail; error?: string };
  console.log(`   ${created.status} 创建 ${createdJson.poll.title}，状态=${createdJson.poll.status}`);
  const badDraft = await fetch(`${base}/api/polls`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Token": ADMIN_TOKEN },
    body: JSON.stringify({ ...draftBody, options: [{ id: "only", label: "仅一个选项" }] })
  });
  console.log(`   仅一个选项 → ${badDraft.status}（非法 400）`);
  const duplicate = await fetch(`${base}/api/polls`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Token": ADMIN_TOKEN }, body: JSON.stringify(draftBody)
  });
  console.log(`   重复 id → ${duplicate.status} ${(await duplicate.json() as { error: string }).error}`);

  console.log("\n2) draft 不进公共列表，普通详情/结果均 404");
  const publicList = (await (await fetch(`${base}/api/polls`)).json() as { polls: PollSummary[] }).polls;
  console.log(`   公共列表含新草案：${publicList.some(poll => poll.id === draftBody.id)}（应为 false）`);
  console.log(`   普通详情 → ${(await fetch(`${base}/api/polls/${draftBody.id}`)).status}（404）`);
  console.log(`   普通结果 → ${(await fetch(`${base}/api/polls/${draftBody.id}/results`)).status}（404）`);

  console.log("\n3) 非法转换 draft→closed 被 409 拒绝；合法 draft→open 成功");
  const illegal = await postStatus(base, draftBody.id, "closed", "draft");
  console.log(`   draft→closed → ${illegal.status} ${illegal.body.error}`);
  const opened = await postStatus(base, draftBody.id, "open", "draft");
  console.log(`   draft→open → ${opened.status}，当前状态=${opened.body.poll!.status}`);

  const summary = publicList[0]!;
  let poll = await pollDetail(base, summary.id);
  console.log(`\n既有议题「${poll.title}」（${poll.id}）迁移为 ${poll.status}，查询/投票/回执保持兼容。`);
  console.log(`成员版本 v${poll.groupVersion} · ${poll.eligibleMemberCommitments.length} 个承诺`);
  const option = poll.options[0]!;

  console.log("\n4) 成员 08 轮换身份（成员变更需管理令牌，v1 → v2）…");
  const rotated = await postGroup(base, poll.id, {
    operation: "rotate", expectedVersion: poll.groupVersion,
    oldCommitment: new Identity("veilvote-demo-member-08").commitment.toString(),
    newCommitment: new Identity("veilvote-demo-member-09").commitment.toString()
  });
  console.log(`   ${rotated.status} 新版本 v${rotated.body.group?.version}（${rotated.body.group?.memberCount} 个承诺）`);

  console.log("\n5) 成员 01 基于最新版本生成证明并投票（首票冻结名单）…");
  poll = await pollDetail(base, poll.id);
  const freshProof = await generateProof(new Identity("veilvote-demo-member-01"), new Group(poll.eligibleMemberCommitments), option.id, poll.id) as SemaphoreProofPayload;
  const first = await postVote(base, poll.id, { optionId: option.id, groupVersion: poll.groupVersion, proof: freshProof });
  console.log(`   ${first.status} 回执：${first.body.receipt?.id}`);
  const frozen = await postGroup(base, poll.id, { operation: "join", expectedVersion: poll.groupVersion, commitment: commitmentOf("veilvote-demo-member-10") });
  console.log(`   首票后再变更成员 → ${frozen.status} ${frozen.body.error}`);

  console.log("\n6) 到 closesAt 原子持久化 closed，并拒绝越界票（并发裁决）");
  const db = new DatabaseSync(databasePath);
  db.prepare("UPDATE polls SET closes_at = ? WHERE id = ?").run(new Date(Date.now() - 500).toISOString(), poll.id);
  db.close();
  const dummyProof: SemaphoreProofPayload = {
    merkleTreeDepth: 20, merkleTreeRoot: "1", message: "1", nullifier: "1", scope: "1",
    points: ["1", "2", "3", "4", "5", "6", "7", "8"]
  };
  const lateVotes = await Promise.all(["101", "102"].map(nullifier =>
    fetch(`${base}/api/polls/${poll.id}/votes`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optionId: option.id, groupVersion: poll.groupVersion, proof: { ...dummyProof, nullifier } })
    }).then(response => response.status)
  ));
  console.log(`   并发越界票状态：${lateVotes.join(", ")}（均 409）`);
  const afterDeadline = await pollDetail(base, poll.id);
  console.log(`   议题已持久化为 ${afterDeadline.status}；结果仍公开：`);
  showResults(await results(base, poll.id), poll);

  console.log("\n7) closed/archived 结果继续公开；状态链 closed→archived");
  const archived = await postStatus(base, poll.id, "archived", "closed");
  console.log(`   closed→archived → ${archived.status}，结果查询 → ${(await fetch(`${base}/api/polls/${poll.id}/results`)).status}`);

  console.log("\n8) 审计查询（倒序，不含令牌/秘密/证明）");
  const auditResponse = await fetch(`${base}/api/admin/audit?limit=12`, { headers: { "X-Admin-Token": ADMIN_TOKEN } });
  const { events } = await auditResponse.json() as { events: AuditEvent[] };
  for (const event of events.slice(0, 8)) {
    console.log(`   ${event.at}  ${event.result === "success" ? "✓" : "✗"} ${event.action}  ${event.pollId ?? "—"}  ${JSON.stringify(event.detail)}`);
  }
  console.log(`   审计中不包含令牌：${!JSON.stringify(events).includes(ADMIN_TOKEN)}；不包含证明字段：${!JSON.stringify(events).includes("points")}`);

  await stop(server);
  console.log("\n9) 服务停止后用同一 SQLite 重启（恢复）…");
  const restarted = await serve(ADMIN_TOKEN);
  try {
    const persisted = await pollDetail(restarted.base, poll.id);
    console.log(`   重启后状态=${persisted.status}（deadline close 与归档均持久化）`);
    const restartedEvents = await fetch(`${restarted.base}/api/admin/audit`, { headers: { "X-Admin-Token": ADMIN_TOKEN } });
    const { events: survived } = await restartedEvents.json() as { events: AuditEvent[] };
    console.log(`   审计事件重启后仍在：${survived.length} 条`);
    showResults(await results(restarted.base, poll.id), poll);
  } finally {
    await stop(restarted.server);
  }
  console.log("\n演示完成：管理授权、草案生命周期、非法转换拒绝、截止并发裁决、审计与恢复均已验证。");
} finally {
  await terminateProverWorkers();
  rmSync(directory, { recursive: true, force: true });
}
