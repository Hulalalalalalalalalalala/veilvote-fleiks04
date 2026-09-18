import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { Identity } from "@semaphore-protocol/identity";
import { Group } from "@semaphore-protocol/group";
import { generateProof } from "@semaphore-protocol/proof";
import { createApp } from "../src/app.ts";
import { terminateProverWorkers } from "../src/voting.ts";
import type { GroupVersionSummary, PollDetail, PollResults, PollSummary, SemaphoreProofPayload, VoteReceipt } from "../src/types.ts";

const directory = mkdtempSync(join(tmpdir(), "veilvote-demo-"));
const databasePath = join(directory, "veilvote.sqlite");

async function serve(): Promise<{ server: Server; base: string }> {
  const server = createApp(databasePath);
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Service has no TCP address");
  return { server, base: `http://127.0.0.1:${address.port}` };
}
async function stop(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}
async function postJson(base: string, path: string, payload: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
}
async function postVote(base: string, pollId: string, payload: unknown) {
  const result = await postJson(base, `/api/polls/${encodeURIComponent(pollId)}/votes`, payload);
  return { status: result.status, body: result.body as { receipt?: VoteReceipt; error?: string; groupVersion?: number } };
}
async function postGroup(base: string, pollId: string, payload: unknown) {
  const result = await postJson(base, `/api/polls/${encodeURIComponent(pollId)}/group`, payload);
  return { status: result.status, body: result.body as { group?: GroupVersionSummary; error?: string } };
}
async function pollDetail(base: string, pollId: string): Promise<PollDetail> {
  const response = await fetch(`${base}/api/polls/${encodeURIComponent(pollId)}`);
  if (!response.ok) throw new Error(`Poll lookup returned ${response.status}`);
  return ((await response.json()) as { poll: PollDetail }).poll;
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
async function proofFor(secret: string, commitments: string[], optionId: string, pollId: string): Promise<SemaphoreProofPayload> {
  return generateProof(new Identity(secret), new Group(commitments), optionId, pollId) as Promise<SemaphoreProofPayload>;
}
const commitmentOf = (secret: string) => new Identity(secret).commitment.toString();
function check(label: string, condition: boolean, detail = "") {
  if (!condition) throw new Error(`断言失败：${label} ${detail}`);
  console.log(`   ✔ ${label}${detail ? `（${detail}）` : ""}`);
}

try {
  const { server, base } = await serve();
  console.log(`\nVeilVote · 可版本化成员资格快照演示\n本地产品 API：${base}\n`);

  const { polls } = await (await fetch(`${base}/api/polls`)).json() as { polls: PollSummary[] };
  const pollId = polls[0].id;
  let poll = await pollDetail(base, pollId);
  console.log(`议题：${poll.title}（${poll.id}）`);
  console.log(`初始快照：groupVersion=v${poll.groupVersion}，成员 ${poll.eligibleMemberCommitments.length} 位`);
  console.log(`merkleRoot=${poll.merkleRoot}`);
  check("初始数据迁移为 version 1", poll.groupVersion === 1);
  const v1Commitments = poll.eligibleMemberCommitments.slice();
  const v1Root = poll.merkleRoot;
  const [optionA, optionB] = poll.options;

  console.log("\n1) /group 输入校验：");
  let r: { status: number; body: Record<string, any> } = await postGroup(base, "missing-poll", { operation: "join", expectedVersion: 1, commitment: commitmentOf("veilvote-demo-member-09") });
  check("议题不存在返回 404", r.status === 404, r.body.error);
  r = await postGroup(base, pollId, { operation: "banana", expectedVersion: 1, commitment: commitmentOf("veilvote-demo-member-09") });
  check("非法 operation 返回 400", r.status === 400, r.body.error);
  r = await postGroup(base, pollId, { operation: "join", expectedVersion: 1, commitment: "not-a-number" });
  check("承诺格式非法返回 400", r.status === 400, r.body.error);
  r = await postGroup(base, pollId, { operation: "join", expectedVersion: 1, commitment: v1Commitments[0] });
  check("重复承诺返回 400", r.status === 400, r.body.error);
  r = await postGroup(base, pollId, { operation: "revoke", expectedVersion: 1, commitment: commitmentOf("veilvote-demo-member-99") });
  check("目标缺失返回 400", r.status === 400, r.body.error);
  r = await postGroup(base, pollId, { operation: "join", expectedVersion: 99, commitment: commitmentOf("veilvote-demo-member-09") });
  check("版本过期返回 409 group_version_changed", r.status === 409 && r.body.error === "group_version_changed", `当前 v${r.body.groupVersion}`);

  console.log("\n2) join 新成员 09（expectedVersion=1）…");
  r = await postGroup(base, pollId, { operation: "join", expectedVersion: 1, commitment: commitmentOf("veilvote-demo-member-09") });
  check("返回 201 与新版本摘要", r.status === 201 && r.body.group?.groupVersion === 2, `v${r.body.group?.groupVersion}，${r.body.group?.memberCount} 位成员`);

  console.log("\n3) rotate：成员 08 的承诺原位替换为成员 10…");
  r = await postGroup(base, pollId, { operation: "rotate", expectedVersion: 2, oldCommitment: commitmentOf("veilvote-demo-member-08"), newCommitment: commitmentOf("veilvote-demo-member-10") });
  check("返回 201 v3，成员数不变（9 位）", r.status === 201 && r.body.group?.groupVersion === 3 && r.body.group?.memberCount === 9);

  console.log("\n4) revoke：撤销成员 07…");
  r = await postGroup(base, pollId, { operation: "revoke", expectedVersion: 3, commitment: commitmentOf("veilvote-demo-member-07") });
  check("返回 201 v4，成员数减为 8", r.status === 201 && r.body.group?.groupVersion === 4 && r.body.group?.memberCount === 8);
  poll = await pollDetail(base, pollId);
  console.log(`   当前 merkleRoot=${poll.merkleRoot}`);

  console.log("\n5) 旧证明被拒：按 v1 旧快照为成员 01 生成证明，并钉住 groupVersion=1…");
  const staleProof = await proofFor("veilvote-demo-member-01", v1Commitments, optionA.id, pollId);
  check("旧证明的根确实是 v1 根", staleProof.merkleTreeRoot === v1Root);
  r = await postVote(base, pollId, { optionId: optionA.id, proof: staleProof, groupVersion: 1 });
  check("历史版本返回 409 group_version_changed", r.status === 409 && r.body.error === "group_version_changed", `服务端当前 v${r.body.groupVersion}`);

  console.log("\n6) 兼容旧客户端：省略 groupVersion，服务端按证明根解析（同样拒绝旧根）…");
  r = await postVote(base, pollId, { optionId: optionA.id, proof: staleProof });
  check("旧根解析为历史版本，返回 409", r.status === 409 && r.body.error === "group_version_changed");

  console.log(`\n7) 新证明成功：按 v4 当前快照重新生成证明（成员 02，不带 groupVersion 模拟旧客户端）…`);
  const freshProof = await proofFor("veilvote-demo-member-02", poll.eligibleMemberCommitments, optionA.id, pollId);
  r = await postVote(base, pollId, { optionId: optionA.id, proof: freshProof });
  check("首张选票 201，并在同事务冻结 v4", r.status === 201 && r.body.receipt?.groupVersion === 4, `回执 ${r.body.receipt?.id}`);
  const receipt = r.body.receipt!;
  poll = await pollDetail(base, pollId);
  check("详情显示快照已冻结", poll.frozen === true);

  console.log("\n8) 冻结之后任何成员变更都被拒绝…");
  r = await postGroup(base, pollId, { operation: "join", expectedVersion: poll.groupVersion, commitment: commitmentOf("veilvote-demo-member-11") });
  check("返回 409 group_frozen", r.status === 409 && r.body.error === "group_frozen");

  console.log("\n9) 钉住当前版本的新证明仍可投票（成员 01，groupVersion=4）…");
  const pinnedProof = await proofFor("veilvote-demo-member-01", poll.eligibleMemberCommitments, optionB.id, pollId);
  r = await postVote(base, pollId, { optionId: optionB.id, proof: pinnedProof, groupVersion: 4 });
  check("返回 201，选票记录在 v4", r.status === 201 && r.body.receipt?.groupVersion === 4);

  console.log("\n10) 去重跨版本：成员 01 即便换选项/重开证明也被拒…");
  r = await postVote(base, pollId, { optionId: optionA.id, proof: await proofFor("veilvote-demo-member-01", poll.eligibleMemberCommitments, optionA.id, pollId), groupVersion: 4 });
  check("返回 409 duplicate_nullifier", r.status === 409 && r.body.error === "duplicate_nullifier");

  console.log("\n11) 篡改与未知根仍返回 422：");
  r = await postVote(base, pollId, { optionId: optionB.id, proof: await proofFor("veilvote-demo-member-03", poll.eligibleMemberCommitments, optionA.id, pollId), groupVersion: 4 });
  check("证明绑定选项 A 却投选项 B → 422", r.status === 422, r.body.error);
  const unknownRootGroup = [...poll.eligibleMemberCommitments, commitmentOf("veilvote-demo-member-11")];
  r = await postVote(base, pollId, { optionId: optionA.id, proof: await proofFor("veilvote-demo-member-04", unknownRootGroup, optionA.id, pollId), groupVersion: 4 });
  check("证明来自未知 Merkle 根 → 422", r.status === 422, r.body.error);

  console.log("\n12) 当前计票：");
  showResults(await results(base, pollId), poll);

  await stop(server);
  console.log("\n13) 服务已停止，使用同一 SQLite 文件重启…");
  const restarted = await serve();
  try {
    const reloaded = await pollDetail(restarted.base, pollId);
    check("重启后版本仍为 v4", reloaded.groupVersion === 4);
    check("重启后 merkleRoot 不变（重启稳定）", reloaded.merkleRoot === poll.merkleRoot);
    check("重启后冻结状态保持", reloaded.frozen === true);
    check("承诺列表与重启前一致", JSON.stringify(reloaded.eligibleMemberCommitments) === JSON.stringify(poll.eligibleMemberCommitments));
    const persistedReceipt = await fetch(`${restarted.base}/api/receipts/${receipt.id}`);
    check("回执重启后仍可查询", persistedReceipt.status === 200);
    showResults(await results(restarted.base, pollId), poll);
    r = await postGroup(restarted.base, pollId, { operation: "join", expectedVersion: 4, commitment: commitmentOf("veilvote-demo-member-12") });
    check("重启后变更仍被 group_frozen 拒绝", r.status === 409 && r.body.error === "group_frozen");
  } finally {
    await stop(restarted.server);
  }
  console.log("\n演示完成：版本化快照、join/rotate/revoke、旧证明拒绝/新证明接受、冻结与重启持久化均已验证。");
} finally {
  await terminateProverWorkers();
  rmSync(directory, { recursive: true, force: true });
}
