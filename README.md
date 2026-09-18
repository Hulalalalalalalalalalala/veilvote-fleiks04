# VeilVote

社区议题匿名投票应用：浏览议题、以 Semaphore 零知识证明匿名投票、查询回执与计票结果。

需要 Node.js 24。SQLite 使用 Node 内置模块，无需单独安装数据库。

```sh
npm ci
npm run build
npm start
```

打开 `http://127.0.0.1:3414`。可用 `PORT` 更换端口，`DATA_DIR` 指定 SQLite 数据目录（默认 `data`）。从 Windows 切换到 WSL 时先在 WSL 执行 `npm ci`，以安装对应平台的构建依赖。

`npm test` 检查查询接口、成员快照迁移与变更、投票闭环（真实证明的接受、去重、篡改拒绝、历史版本冲突、冻结、并发互斥、计票）以及数据库重启后的数据；`npm run demo` 在临时端口启动产品服务，经真实 API 完成 join/rotate/revoke 变更、旧证明被拒与新证明接受、冻结后拒绝变更、重复投票与篡改被拒，以及重启后的版本化持久计票，然后退出。前端开发使用 `npm run dev`，另开终端运行 `npm run dev:api`（默认 API 端口 3414）。

## 接口

- `GET /api/health`：服务状态。
- `GET /api/polls`：`{ polls: [...] }` 议题摘要（含 `groupVersion`、`merkleRoot`、`frozen`）。
- `GET /api/polls/:id`：`{ poll: {...} }`，包含 `options`、当前快照的 `eligibleMemberCommitments`，以及同源的 `groupVersion`（从 1 起递增）与 `merkleRoot`（当前 Semaphore Merkle 根），另含 `frozen`；不存在时返回 404。
- `POST /api/polls/:id/group`：提交 `{ operation, expectedVersion, ... }` 变更成员资格，成功时追加一份不可变快照、版本号加一，返回 201 与 `{ group: { pollId, groupVersion, merkleRoot, memberCount, frozen } }`。
  - `join`：`{ operation: "join", expectedVersion, commitment }`，在末尾追加承诺。
  - `rotate`：`{ operation: "rotate", expectedVersion, oldCommitment, newCommitment }`，以新承诺原位替换旧承诺（位置不变）。
  - `revoke`：`{ operation: "revoke", expectedVersion, commitment }`，删除承诺；不允许撤销最后一位成员。
  - 议题不存在返回 404；报文格式非法、承诺不是合法域元素、目标承诺缺失、承诺重复或会导致空组返回 400；`expectedVersion` 与当前版本不一致返回 409 `group_version_changed`（响应携带最新 `groupVersion`、`merkleRoot` 供刷新）；首张选票接受后快照冻结，此后变更返回 409 `group_frozen`。
- `POST /api/polls/:id/votes`：提交 `{ optionId, proof, groupVersion? }`（Semaphore v4 证明，message 为选项 id、scope 为议题 id）。新客户端携带 `groupVersion`，证明必须按该版本快照生成；省略时按证明中的 Merkle 根解析快照以兼容旧客户端。成功返回 201 与 `{ receipt: { id, pollId, optionId, nullifier, groupVersion, acceptedAt } }`，并在同一事务把成员资格冻结在当前版本。议题不存在 404；报文格式或选项非法 400；证明无效或被篡改（message/scope 不匹配、Merkle 根未知）422；议题未开放或已过 `closesAt` 409；证明针对历史版本（含旧客户端解析到旧根）返回 409 `group_version_changed`；同一 nullifier 跨版本重复投票 409 `duplicate_nullifier`；冻结后再变更成员返回 409 `group_frozen`。
- `GET /api/polls/:id/results`：`{ result: { pollId, total, options: [{ id, count }] } }`，零票选项也会列出；议题不存在返回 404。
- `GET /api/receipts/:id`：返回 `{ receipt: {...} }`；未知回执返回 404。

## 投票流程

浏览器端用身份秘密创建 `Identity`，以议题详情中当前版本的公开承诺重建 `Group`，以选项 id 为 message、议题 id 为 scope 生成证明，并随选票提交 `groupVersion`。身份秘密只保存在页面内存中，不上传、不持久化（成员变更也只在本地推导承诺后上传公开值）。服务端在 SQLite 中保存每个议题追加式、不可变的版本快照（承诺列表与该版本的 Semaphore Merkle 根）：成员变更在即时事务中校验 `expectedVersion` 并写入新版本；首张选票在同一即时事务中完成快照根确认、版本冻结、同议题 nullifier 查重（`(poll_id, nullifier)` 唯一约束，跨版本生效）与写票，因此并发变更与投票只有一方成功。历史版本根返回 409 供客户端刷新，未知根与密码学无效证明返回 422。选票与回执持久化于 SQLite，重启后版本、根、冻结状态与计票均不丢失。服务端可见选项与计数，但数据库不存储任何承诺与选票的关联。

首次运行会载入 2 个演示议题和 8 个公开成员承诺。演示身份可用 `new Identity("veilvote-demo-member-01")` 至 `new Identity("veilvote-demo-member-08")` 复现（从 `@semaphore-protocol/identity` 导入）；这些公开输入只属于合成演示成员，不可用于真实用户。首次生成证明时会从 snark-artifacts CDN 下载证明参数（浏览器与 Node 均会自动缓存）。
