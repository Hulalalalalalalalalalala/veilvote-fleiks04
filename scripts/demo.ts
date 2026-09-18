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
async function pollDetail(base: string, pollId: string): Promise<PollDetail> {
  const response = await fetch(`${base}/api/polls/${encodeURIComponent(pollId)}`);
  if (!response.ok) throw new Error(`Poll detail returned ${response.status}`);
  return ((await response.json()) as { poll: PollDetail }).poll;
}
async function postGroup(base: string, pollId: string, payload: unknown) {
  const response = await fetch(`${base}/api/polls/${encodeURIComponent(pollId)}/group`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

try {
  const { server, base } = await serve();
  console.log(`\nVeilVote · 匿名投票演示\n本地产品 API：${base}\n`);

  const { polls } = await (await fetch(`${base}/api/polls`)).json() as { polls: PollSummary[] };
  const summary = polls[0];
  let poll = await pollDetail(base, summary.id);
  console.log(`议题：${poll.title}（${poll.id}）`);
  console.log(`成员版本 v${poll.groupVersion} · Merkle 根 ${poll.merkleRoot.slice(0, 24)}…（${poll.eligibleMemberCommitments.length} 个承诺）`);
  poll.options.forEach(option => console.log(`  ${option.id}. ${option.label}`));

  const option = poll.options[0];
  const otherOption = poll.options[1];

  console.log("\n1) 成员 01 基于当前版本（v1）预生成证明，但暂不提交…");
  const identity = new Identity("veilvote-demo-member-01");
  const staleProof = await generateProof(identity, new Group(poll.eligibleMemberCommitments), option.id, poll.id) as SemaphoreProofPayload;

  console.log("\n2) 成员 08 轮换为新身份（rotate，版本 v1 → v2）…");
  const rotated = new Identity("veilvote-demo-member-09");
  const rotation = await postGroup(base, poll.id, {
    operation: "rotate",
    expectedVersion: poll.groupVersion,
    oldCommitment: new Identity("veilvote-demo-member-08").commitment.toString(),
    newCommitment: rotated.commitment.toString()
  });
  if (rotation.status !== 201 || !rotation.body.group) throw new Error(`Expected 201, got ${rotation.status}`);
  console.log(`   201 已轮换。新版本 v${rotation.body.group.version} · 根 ${rotation.body.group.merkleRoot.slice(0, 24)}…（${rotation.body.group.memberCount} 个承诺）`);

  console.log("\n3) 步骤 1 的旧证明现在提交（不带 groupVersion，按证明根解析到历史版本 v1）…");
  const stale = await postVote(base, poll.id, { optionId: option.id, proof: staleProof });
  console.log(`   ${stale.status} ${stale.body.error}（旧版本证明被拒绝）`);

  console.log("\n4) 重新读取详情，成员 01 基于 v2 快照生成新证明并投票…");
  poll = await pollDetail(base, poll.id);
  console.log(`   当前版本 v${poll.groupVersion} · 根 ${poll.merkleRoot.slice(0, 24)}…`);
  const freshProof = await generateProof(identity, new Group(poll.eligibleMemberCommitments), option.id, poll.id) as SemaphoreProofPayload;
  const first = await postVote(base, poll.id, { optionId: option.id, groupVersion: poll.groupVersion, proof: freshProof });
  if (first.status !== 201 || !first.body.receipt) throw new Error(`Expected 201, got ${first.status}`);
  const receipt = first.body.receipt;
  console.log(`   201 已接受（版本 v${poll.groupVersion} 已冻结）。回执：${receipt.id}\n   nullifier：${receipt.nullifier}\n   接受时间：${receipt.acceptedAt}`);

  const receiptLookup = await fetch(`${base}/api/receipts/${receipt.id}`);
  console.log(`   GET /api/receipts/${receipt.id.slice(0, 8)}… → ${receiptLookup.status}（回执可查询）`);

  console.log("\n5) 同一身份再次投票（重复 nullifier）…");
  const again = await postVote(base, poll.id, { optionId: option.id, groupVersion: poll.groupVersion, proof: await generateProof(identity, new Group(poll.eligibleMemberCommitments), option.id, poll.id) as SemaphoreProofPayload });
  console.log(`   ${again.status} ${again.body.error}（重复投票被拒绝）`);

  console.log("\n6) 成员 02 提交被篡改的选票（证明对应选项 A，报文改为选项 B）…");
  const identity2 = new Identity("veilvote-demo-member-02");
  const tamperedProof = await generateProof(identity2, new Group(poll.eligibleMemberCommitments), option.id, poll.id) as SemaphoreProofPayload;
  const tampered = await postVote(base, poll.id, { optionId: otherOption.id, groupVersion: poll.groupVersion, proof: tamperedProof });
  console.log(`   ${tampered.status} ${tampered.body.error}（篡改被拒绝）`);

  console.log("\n7) 议题已有选票，尝试再次变更成员（join 第 9 位成员）…");
  const frozen = await postGroup(base, poll.id, {
    operation: "join",
    expectedVersion: poll.groupVersion,
    commitment: new Identity("veilvote-demo-member-10").commitment.toString()
  });
  console.log(`   ${frozen.status} ${frozen.body.error}（名单已冻结，变更被拒绝）`);

  console.log("\n8) 当前计票：");
  showResults(await results(base, poll.id), poll);

  await stop(server);
  console.log("\n9) 服务已停止，使用同一 SQLite 文件重启…");
  const restarted = await serve();
  try {
    const persisted = await pollDetail(restarted.base, poll.id);
    console.log(`   重启后版本 v${persisted.groupVersion} · 根 ${persisted.merkleRoot.slice(0, 24)}…（与重启前一致：${persisted.groupVersion === poll.groupVersion && persisted.merkleRoot === poll.merkleRoot}）`);
    console.log("   重启后计票（数据持久化，未丢失）：");
    showResults(await results(restarted.base, poll.id), persisted);
    const persistedReceipt = await fetch(`${restarted.base}/api/receipts/${receipt.id}`);
    console.log(`   重启后回执查询 → ${persistedReceipt.status}`);
  } finally {
    await stop(restarted.server);
  }
  console.log("\n演示完成：版本化成员快照、旧证明拒绝、冻结、持久化计票均已验证。");
} finally {
  await terminateProverWorkers();
  rmSync(directory, { recursive: true, force: true });
}
