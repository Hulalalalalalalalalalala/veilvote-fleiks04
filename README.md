# VeilVote

社区议题匿名投票应用：浏览议题、以 Semaphore 零知识证明匿名投票、查询回执与计票结果。

需要 Node.js 24。SQLite 使用 Node 内置模块，无需单独安装数据库。

```sh
npm ci
npm run build
npm start
```

打开 `http://127.0.0.1:3414`。可用 `PORT` 更换端口，`DATA_DIR` 指定 SQLite 数据目录（默认 `data`）。从 Windows 切换到 WSL 时先在 WSL 执行 `npm ci`，以安装对应平台的构建依赖。

`npm test` 检查查询接口、成员版本管理、投票闭环（真实证明的接受、去重、篡改拒绝、计票）以及数据库重启后的数据；`npm run demo` 在临时端口启动产品服务，经真实 API 完成成员轮换与投票，演示旧版本证明被拒、冻结后变更被拒、重复投票与篡改被拒、回执查询和重启后的持久计票，然后退出。前端开发使用 `npm run dev`，另开终端运行 `npm run dev:api`（默认 API 端口 3414）。

## 接口

- `GET /api/health`：服务状态。
- `GET /api/polls`：`{ polls: [...] }` 议题摘要。
- `GET /api/polls/:id`：`{ poll: {...} }`，包含 `options`、`eligibleMemberCommitments`、`groupVersion` 与 `merkleRoot`；三者来自同一份持久化的成员版本快照，重启后不变。不存在时返回 404。
- `POST /api/polls/:id/group`：变更成员名单，提交 `{ operation, expectedVersion, ... }`。`join` 携带 `commitment` 追加成员；`rotate` 携带 `oldCommitment` 与 `newCommitment` 原位替换；`revoke` 携带 `commitment` 移除成员。每次成功变更都会持久化一个不可变的新版本（承诺列表 + Merkle 根 + 递增版本号）并返回 201 与 `{ group: { pollId, version, merkleRoot, memberCount, commitments } }`。议题不存在 404；报文格式非法、目标承诺不存在、承诺重复或变更后名单为空 400；`expectedVersion` 过期 409 `group_version_changed`；议题已有选票（名单已冻结）409 `group_frozen`。
- `POST /api/polls/:id/votes`：提交 `{ optionId, proof }`（Semaphore v4 证明，message 为选项 id、scope 为议题 id），可附带 `groupVersion` 声明所基于的成员版本；省略时按证明的 Merkle 根解析版本以兼容旧客户端。成功返回 201 与 `{ receipt: { id, pollId, optionId, nullifier, acceptedAt } }`，首张选票会在同一事务中冻结当前版本。议题不存在 404；报文格式或选项非法 400；证明无效或被篡改（message/scope/merkle 根不匹配）、证明根不属于任何已知版本 422；议题未开放或已过 `closesAt`、同一 nullifier 重复投票（跨版本去重）、版本已过期 409（分别为 `poll_closed`、`duplicate_nullifier`、`group_version_changed`）。
- `GET /api/polls/:id/results`：`{ result: { pollId, total, options: [{ id, count }] } }`，零票选项也会列出；议题不存在返回 404。
- `GET /api/receipts/:id`：返回 `{ receipt: {...} }`；未知回执返回 404。

## 投票流程

浏览器端用身份秘密创建 `Identity`，以议题详情中的公开承诺（当前版本快照）重建 `Group`，以选项 id 为 message、议题 id 为 scope 生成证明，并随选票提交该快照的 `groupVersion`。身份秘密只保存在页面内存中，不上传、不持久化。服务端按版本快照核验证明的 merkle 根、message、scope 及密码学有效性；快照确认、冻结、nullifier 查重与写票在事务中原子完成，并以 `(poll_id, nullifier)` 唯一约束抵御并发重复（去重跨版本生效）。并发的成员变更与投票只有一方能成功：投票先提交则变更得到 409 `group_frozen`，变更先提交则投票得到 409 `group_version_changed`。选票、回执与全部历史成员版本持久化于 SQLite，重启不丢失。服务端可见选项与计数，但数据库不存储任何承诺与选票的关联。

首次运行会载入 2 个演示议题和 8 个公开成员承诺（作为各议题的版本 1 快照；既有数据库首次启动时会自动迁移出版本 1）。演示身份可用 `new Identity("veilvote-demo-member-01")` 至 `new Identity("veilvote-demo-member-08")` 复现（从 `@semaphore-protocol/identity` 导入）；这些公开输入只属于合成演示成员，不可用于真实用户。首次生成证明时会从 snark-artifacts CDN 下载证明参数（浏览器与 Node 均会自动缓存）。
