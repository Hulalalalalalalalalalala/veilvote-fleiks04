import { resolve } from "node:path";
import { createApp } from "../src/app.ts";
import type { PollDetail, PollSummary } from "../src/types.ts";

const server = createApp(resolve(process.env.DATA_DIR ?? "data", "veilvote.sqlite"));
await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
try {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Service has no TCP address");
  const base = `http://127.0.0.1:${address.port}`;
  console.log(`\nVeilVote · 议题浏览\n本地产品 API：${base}\n`);
  const response = await fetch(`${base}/api/polls`);
  if (!response.ok) throw new Error(`Poll list returned ${response.status}`);
  const { polls } = await response.json() as { polls: PollSummary[] };
  for (const item of polls) {
    const detail = await fetch(`${base}/api/polls/${encodeURIComponent(item.id)}`);
    if (!detail.ok) throw new Error(`Poll detail returned ${detail.status}`);
    const { poll } = await detail.json() as { poll: PollDetail };
    console.log(`${poll.title}\n${poll.description}\n组织：${poll.organizer} · 成员：${poll.memberCount} · 选项：${poll.optionCount}`);
    poll.options.forEach(option => console.log(`  ${option.id}. ${option.label}`));
    console.log(`公开成员承诺数量：${poll.eligibleMemberCommitments.length}\n`);
  }
  console.log(`已从 SQLite 读取并展示 ${polls.length} 个议题。`);
} finally {
  server.closeAllConnections();
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}
