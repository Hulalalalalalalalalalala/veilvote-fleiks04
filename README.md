# VeilVote

社区议题匿名投票应用：浏览议题与可选方案，以 Semaphore 零知识证明匿名投票，并查看不计名计票结果。

需要 Node.js 24。SQLite 使用 Node 内置模块，无需单独安装数据库。

```sh
npm ci
npm run build
npm start
```

打开 `http://127.0.0.1:3414`。可用 `PORT` 更换端口，`DATA_DIR` 指定 SQLite 数据目录（默认 `data`）。从 Windows 切换到 WSL 时先在 WSL 执行 `npm ci`，以安装对应平台的构建依赖。

`npm test` 检查查询接口、投票闭环及数据库重新打开后的数据；`npm run demo` 启动一个临时端口上的产品服务，经真实 API 完成一次匿名投票，展示重复提交与篡改证明被拒，以及重启后计数与回执仍然保留（演示使用独立的 `veilvote-demo.sqlite`，每次运行前重置）。前端开发使用 `npm run dev`，另开终端运行 `npm run dev:api`（默认 API 端口 3414）。

## 接口

- `GET /api/health`：服务状态。
- `GET /api/polls`：`{ polls: [...] }` 议题摘要。
- `GET /api/polls/:id`：`{ poll: {...} }`，包含 `options` 和 `eligibleMemberCommitments`；不存在时返回 404。
- `POST /api/polls/:id/votes`：提交 `{ optionId, proof }`。proof 为 Semaphore v4 证明，以选项 id 为 message、议题 id 为 scope，群组由服务端从 SQLite 中的成员承诺重建。议题不存在返回 404；请求格式或选项非法返回 400；证明无效或被篡改返回 422；议题非 open 或已过 `closesAt` 返回 409；同一 nullifier 在同一议题重复提交返回 409。成功返回 201 及 `{ receipt: { id, pollId, optionId, nullifier, acceptedAt } }`。状态检查、nullifier 查重与写入在同一事务中原子完成，并以 `UNIQUE (poll_id, nullifier)` 约束抵御并发重复。
- `GET /api/polls/:id/results`：`{ result: { pollId, total, options: [{ id, count }] } }`，零票选项也会出现；议题不存在返回 404。
- `GET /api/receipts/:id`：`{ receipt: {...} }` 返回原回执；未知回执返回 404。

选票与回执持久化在 SQLite 中，重启不丢失。服务端只能看到选项 id 与 nullifier，无法把选票关联到任何成员承诺。

## 演示身份

首次运行会载入 2 个演示议题和 8 个公开成员承诺。演示身份可用 `new Identity("veilvote-demo-member-01")` 至 `new Identity("veilvote-demo-member-08")` 复现（从 `@semaphore-protocol/identity` 导入）；这些公开输入只属于合成演示成员，不可用于真实用户。

前端投票时，身份秘密只在浏览器内存中使用：证明在本地生成，秘密不会上传、不会持久化。首次生成证明时会从 `snark-artifacts.pse.dev` 下载证明构件（浏览器与 demo 脚本均如此，Node 侧会缓存到系统临时目录）。
