# VeilVote

社区议题匿名投票应用：浏览议题、以 Semaphore 零知识证明匿名投票、查询回执与计票结果。

需要 Node.js 24。SQLite 使用 Node 内置模块，无需单独安装数据库。

```sh
npm ci
npm run build
npm start
```

打开 `http://127.0.0.1:3414`。可用 `PORT` 更换端口，`DATA_DIR` 指定 SQLite 数据目录（默认 `data`）。从 Windows 切换到 WSL 时先在 WSL 执行 `npm ci`，以安装对应平台的构建依赖。

`npm test` 检查查询接口、投票闭环（真实证明的接受、去重、篡改拒绝、计票）以及数据库重启后的数据；`npm run demo` 在临时端口启动产品服务，经真实 API 完成投票，演示重复投票与篡改被拒、回执查询和重启后的持久计票，然后退出。前端开发使用 `npm run dev`，另开终端运行 `npm run dev:api`（默认 API 端口 3414）。

## 接口

- `GET /api/health`：服务状态。
- `GET /api/polls`：`{ polls: [...] }` 议题摘要。
- `GET /api/polls/:id`：`{ poll: {...} }`，包含 `options` 和 `eligibleMemberCommitments`；不存在时返回 404。
- `POST /api/polls/:id/votes`：提交 `{ optionId, proof }`（Semaphore v4 证明，message 为选项 id、scope 为议题 id）。成功返回 201 与 `{ receipt: { id, pollId, optionId, nullifier, acceptedAt } }`。议题不存在 404；报文格式或选项非法 400；证明无效或被篡改（message/scope/merkle 根不匹配）422；议题未开放或已过 `closesAt` 409；同一 nullifier 重复投票 409。
- `GET /api/polls/:id/results`：`{ result: { pollId, total, options: [{ id, count }] } }`，零票选项也会列出；议题不存在返回 404。
- `GET /api/receipts/:id`：返回 `{ receipt: {...} }`；未知回执返回 404。

## 投票流程

浏览器端用身份秘密创建 `Identity`，以议题详情中的公开承诺重建 `Group`，以选项 id 为 message、议题 id 为 scope 生成证明。身份秘密只保存在页面内存中，不上传、不持久化。服务端从 SQLite 中的承诺重建群组，核验证明的 merkle 根、message、scope 及密码学有效性；验证、nullifier 查重与写票在事务中原子完成，并以 `(poll_id, nullifier)` 唯一约束抵御并发重复。选票与回执持久化于 SQLite，重启不丢失。服务端可见选项与计数，但数据库不存储任何承诺与选票的关联。

首次运行会载入 2 个演示议题和 8 个公开成员承诺。演示身份可用 `new Identity("veilvote-demo-member-01")` 至 `new Identity("veilvote-demo-member-08")` 复现（从 `@semaphore-protocol/identity` 导入）；这些公开输入只属于合成演示成员，不可用于真实用户。首次生成证明时会从 snark-artifacts CDN 下载证明参数（浏览器与 Node 均会自动缓存）。
