import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { Identity } from "@semaphore-protocol/identity";
import { Group } from "@semaphore-protocol/group";
import { generateProof } from "@semaphore-protocol/proof";
import { createApp } from "../src/app.ts";
import { terminateProverWorkers } from "../src/voting.ts";
import type { PollDetail, PollResults, PollSummary, SemaphoreProofPayload, VoteReceipt } from "../src/types.ts";

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
async function postVote(base: string, pollId: string, optionId: string, proof: SemaphoreProofPayload) {
  const response = await fetch(`${base}/api/polls/${encodeURIComponent(pollId)}/votes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ optionId, proof })
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
  const { poll } = await (await fetch(`${base}/api/polls/${encodeURIComponent(summary.id)}`)).json() as { poll: PollDetail };
  console.log(`议题：${poll.title}（${poll.id}）`);
  poll.options.forEach(option => console.log(`  ${option.id}. ${option.label}`));

  const group = new Group(poll.eligibleMemberCommitments);
  const option = poll.options[0];
  const otherOption = poll.options[1];

  console.log(`\n1) 成员 01 为「${option.label}」生成证明并投票…`);
  const identity = new Identity("veilvote-demo-member-01");
  const proof = await generateProof(identity, group, option.id, poll.id) as SemaphoreProofPayload;
  const first = await postVote(base, poll.id, option.id, proof);
  if (first.status !== 201 || !first.body.receipt) throw new Error(`Expected 201, got ${first.status}`);
  const receipt = first.body.receipt;
  console.log(`   201 已接受。回执：${receipt.id}\n   nullifier：${receipt.nullifier}\n   接受时间：${receipt.acceptedAt}`);

  const receiptLookup = await fetch(`${base}/api/receipts/${receipt.id}`);
  console.log(`   GET /api/receipts/${receipt.id.slice(0, 8)}… → ${receiptLookup.status}（回执可查询）`);

  console.log("\n2) 同一身份再次投票（重复 nullifier）…");
  const again = await postVote(base, poll.id, option.id, await generateProof(identity, group, option.id, poll.id) as SemaphoreProofPayload);
  console.log(`   ${again.status} ${again.body.error}（重复投票被拒绝）`);

  console.log("\n3) 成员 02 提交被篡改的选票（证明对应选项 A，报文改为选项 B）…");
  const identity2 = new Identity("veilvote-demo-member-02");
  const tamperedProof = await generateProof(identity2, group, option.id, poll.id) as SemaphoreProofPayload;
  const tampered = await postVote(base, poll.id, otherOption.id, tamperedProof);
  console.log(`   ${tampered.status} ${tampered.body.error}（篡改被拒绝）`);

  console.log("\n4) 当前计票：");
  showResults(await results(base, poll.id), poll);

  await stop(server);
  console.log("\n5) 服务已停止，使用同一 SQLite 文件重启…");
  const restarted = await serve();
  try {
    console.log("   重启后计票（数据持久化，未丢失）：");
    showResults(await results(restarted.base, poll.id), poll);
    const persistedReceipt = await fetch(`${restarted.base}/api/receipts/${receipt.id}`);
    console.log(`   重启后回执查询 → ${persistedReceipt.status}`);
  } finally {
    await stop(restarted.server);
  }
  console.log("\n演示完成：真实 API 投票、重复与篡改拒绝、持久化计票均已验证。");
} finally {
  await terminateProverWorkers();
  rmSync(directory, { recursive: true, force: true });
}
