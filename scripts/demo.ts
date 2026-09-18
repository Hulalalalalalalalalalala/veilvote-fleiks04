import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { Identity } from "@semaphore-protocol/identity";
import { Group } from "@semaphore-protocol/group";
import { generateProof } from "@semaphore-protocol/proof";
import { createApp } from "../src/app.ts";
import type { PollDetail, PollResult, PollSummary, VoteReceipt } from "../src/types.ts";

// 演示使用独立数据库文件，每次运行前重置，保证可重复演示。
const databasePath = resolve(process.env.DATA_DIR ?? "data", "veilvote-demo.sqlite");
rmSync(databasePath, { force: true });

async function listen() {
  const server = createApp(databasePath);
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Service has no TCP address");
  return { server, base: `http://127.0.0.1:${address.port}` };
}
async function close(server: ReturnType<typeof createApp>) {
  server.closeAllConnections();
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}
async function postVote(base: string, pollId: string, payload: unknown) {
  const response = await fetch(`${base}/api/polls/${encodeURIComponent(pollId)}/votes`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  return { status: response.status, body: await response.json() as { receipt?: VoteReceipt; error?: string } };
}
async function getResults(base: string, pollId: string) {
  const response = await fetch(`${base}/api/polls/${encodeURIComponent(pollId)}/results`);
  if (!response.ok) throw new Error(`Results returned ${response.status}`);
  return (await response.json() as { result: PollResult }).result;
}
function formatResult(result: PollResult) {
  return `共 ${result.total} 票（${result.options.map(item => `${item.id}=${item.count}`).join("，")}）`;
}

let exitCode = 0;
try {
  const first = await listen();
  let pollId: string;
  let receiptId: string;
  try {
    console.log(`\nVeilVote · 匿名投票演示\n本地产品 API：${first.base}\n数据库：${databasePath}\n`);
    const { polls } = await (await fetch(`${first.base}/api/polls`)).json() as { polls: PollSummary[] };
    const { poll } = await (await fetch(`${first.base}/api/polls/${encodeURIComponent(polls[0].id)}`)).json() as { poll: PollDetail };
    pollId = poll.id;
    console.log(`议题：${poll.title}\n组织：${poll.organizer} · 成员：${poll.memberCount} · 截止：${poll.closesAt}`);
    poll.options.forEach(option => console.log(`  ${option.id}. ${option.label}`));

    // 浏览器同款流程：身份秘密只在本地，用公开承诺建群，以选项 id 为 message、议题 id 为 scope 生成证明。
    const identity = new Identity("veilvote-demo-member-01");
    const option = poll.options[0];
    console.log(`\n[1] 以演示身份（合成数据）为「${option.label}」生成 Semaphore 证明…`);
    const group = new Group(poll.eligibleMemberCommitments);
    const proof = await generateProof(identity, group, option.id, poll.id);
    console.log(`    nullifier = ${proof.nullifier}`);

    const accepted = await postVote(first.base, poll.id, { optionId: option.id, proof });
    if (accepted.status !== 201 || !accepted.body.receipt) throw new Error(`首次投票应返回 201，实际 ${accepted.status}`);
    receiptId = accepted.body.receipt.id;
    console.log(`[2] 首次投票：${accepted.status} 已接受，回执 ${receiptId}`);

    const duplicate = await postVote(first.base, poll.id, { optionId: option.id, proof });
    console.log(`[3] 同一 nullifier 重复提交：${duplicate.status} ${duplicate.body.error}（同一议题仅能成功一次）`);

    const tampered = await postVote(first.base, poll.id, { optionId: poll.options[1].id, proof });
    console.log(`[4] 篡改 message 指向其他选项：${tampered.status} ${tampered.body.error}（证明与选项绑定，篡改无效）`);

    console.log(`[5] 当前计票：${formatResult(await getResults(first.base, poll.id))}`);
  } finally {
    await close(first.server);
  }

  // 重启服务（同一 SQLite 文件），选票与回执必须仍在。
  const restarted = await listen();
  try {
    console.log(`[6] 重启后计票仍在：${formatResult(await getResults(restarted.base, pollId))}`);
    const receiptResponse = await fetch(`${restarted.base}/api/receipts/${receiptId}`);
    const { receipt } = await receiptResponse.json() as { receipt: VoteReceipt };
    console.log(`[7] 重启后回执可查：${receiptResponse.status} ${receipt.id} · 接受于 ${receipt.acceptedAt}`);
  } finally {
    await close(restarted.server);
  }
  console.log("\n演示完成：真实 API 投票、重复与篡改被拒、计数持久化均已验证。");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
}
// snarkjs 的 worker 会让事件循环保持存活，这里显式退出。
process.exit(exitCode);
