# VeilVote

社区议题匿名投票应用：管理授权、议题生命周期（draft → open → closed → archived）、浏览议题、以 Semaphore 零知识证明匿名投票、查询回执与计票结果，并持久化全部管理动作的审计记录。

需要 Node.js 24。SQLite 使用 Node 内置模块，无需单独安装数据库。

```sh
npm ci
npm run build
ADMIN_TOKEN=choose-a-long-random-secret npm start
```

打开 `http://127.0.0.1:3414`。可用 `PORT` 更换端口，`DATA_DIR` 指定 SQLite 数据目录（默认 `data`），`ADMIN_TOKEN` 配置管理令牌（仅保存在服务进程内存中，不入库、不记日志）。**未设置 `ADMIN_TOKEN` 时，所有管理接口对任何人都返回 `401 admin_unauthorized`。** 从 Windows 切换到 WSL 时先在 WSL 执行 `npm ci`，以安装对应平台的构建依赖。

`npm test` 检查查询接口、管理授权、议题生命周期、成员版本管理、投票闭环（真实证明的接受、去重、篡改拒绝、计票）、截止时刻的并发裁决、审计持久化以及数据库重启后的数据；`npm run demo` 在临时端口启动产品服务，经真实 API 完成未授权拒绝、草案创建与开放、非法转换拒绝、成员轮换、投票冻结、截止并发拒绝、归档、审计查询和重启恢复，然后退出。前端开发使用 `npm run dev`，另开终端运行 `npm run dev:api`（默认 API 端口 3414）。

## 管理授权

以下操作均须在请求头携带 `X-Admin-Token: <ADMIN_TOKEN>`：创建议题、成员变更、状态转换、审计查询（以及管理员视角的草案详情与管理员议题列表）。令牌缺失、错误，或服务未配置 `ADMIN_TOKEN`，一律返回 `401 { "error": "admin_unauthorized" }`，且在校验通过前不解析请求体、不写任何数据（审计表也不写）。令牌比较使用恒定时间比较。普通查询、公开投票与回执查询不需要令牌。

## 议题生命周期

议题状态只允许沿 `draft → open → closed → archived` 单向转换：

- **draft（草案）**：创建后的初始状态。不进公共列表（`GET /api/polls`），普通详情与结果返回 404，不能投票；仅持令牌的管理员可见、可改成员。
- **open（投票中）**：唯一可投票状态。成员只可在 draft 阶段、或 open 但尚无选票时变更；第一张被接受的选票在同一事务中冻结成员版本，此后成员不可变更。
- **closed（已截止）**：到达 `closesAt` 时，关闭会被**原子持久化**（投票或状态请求进入事务时落库，公开列表/详情/结果读取时也会先落库，重启时统一补偿），越界选票按事务内的持久状态裁决并返回 409；结果继续公开。
- **archived（已归档）**：终态，结果仍公开，不再接受投票或成员变更。

旧数据库中的既有议题在首次启动时迁移为 `open`；既有查询、投票、回执与旧版成员快照完全兼容。

## 接口

- `GET /api/health`：服务状态。
- `GET /api/polls`：`{ polls: [...] }` 公开议题摘要（不含 draft；读取前会把已过 `closesAt` 的 open 议题持久化为 closed）。
- `GET /api/polls/:id`：`{ poll: {...} }`，包含 `status`、`options`、`eligibleMemberCommitments`、`groupVersion` 与 `merkleRoot`；三者来自同一份持久化的成员版本快照，重启后不变。draft 对普通请求返回 404；携带正确 `X-Admin-Token` 时管理员可读取 draft。不存在时返回 404。
- `POST /api/polls`（**需 X-Admin-Token**）：创建 draft 议题。接收既有议题字段 `id,title,summary,description,organizer,publishedAt,closesAt`、`commitments`（非空、无重复的成员承诺数组）以及 `options`（至少两个、id 唯一且 id/label 非空）；`closesAt` 须晚于 `publishedAt`。成功返回 `201 { poll }`；字段非法返回 `400 { error: "invalid_poll", fields: [...] }`；id 冲突返回 `409 { error: "poll_exists" }`；未授权返回 401。
- `POST /api/polls/:id/status`（**需 X-Admin-Token**）：提交 `{ status, expectedStatus? }`。仅允许相邻状态沿 `draft→open→closed→archived` 转换。非法转换返回 `409 invalid_status_transition`；`expectedStatus` 与当前状态不符或状态未变化返回 `409 status_conflict`；议题不存在 404。到 `closesAt` 时对 open 议题的该请求会先在同一流程中持久化 closed。成功返回 `200 { poll }`。
- `GET /api/admin/polls`（**需 X-Admin-Token**）：`{ polls, legalTransitions }`，管理员议题列表（含 draft）及各状态的合法后继状态。
- `POST /api/polls/:id/group`（**需 X-Admin-Token**）：变更成员名单，提交 `{ operation, expectedVersion, ... }`。`join` 携带 `commitment` 追加成员；`rotate` 携带 `oldCommitment` 与 `newCommitment` 原位替换；`revoke` 携带 `commitment` 移除成员。仅 draft 或未投票的 open 议题可变更；closed/archived 返回 `409 poll_not_editable`。每次成功变更都会持久化一个不可变的新版本（承诺列表 + Merkle 根 + 递增版本号）并返回 201 与 `{ group: { pollId, version, merkleRoot, memberCount, commitments } }`。议题不存在 404；报文格式非法、目标承诺不存在、承诺重复或变更后名单为空 400；`expectedVersion` 过期 409 `group_version_changed`；议题已有选票（名单已冻结）409 `group_frozen`。
- `POST /api/polls/:id/votes`：提交 `{ optionId, proof }`（Semaphore v4 证明，message 为选项 id、scope 为议题 id），可附带 `groupVersion` 声明所基于的成员版本；省略时按证明的 Merkle 根解析版本以兼容旧客户端。仅 open 且未到 `closesAt` 可投票。成功返回 201 与 `{ receipt: { id, pollId, optionId, nullifier, acceptedAt } }`，首张选票会在同一事务中冻结当前版本。议题不存在或为 draft 404；报文格式或选项非法 400；证明无效或被篡改（message/scope/merkle 根不匹配）、证明根不属于任何已知版本 422；议题未开放、已过 `closesAt`（截止关闭在同一事务中持久化）、同一 nullifier 重复投票（跨版本去重）、版本已过期 409（分别为 `poll_closed`、`duplicate_nullifier`、`group_version_changed`）。
- `GET /api/polls/:id/results`：`{ result: { pollId, total, options: [{ id, count }] } }`，零票选项也会列出；closed/archived 继续公开，draft 返回 404，议题不存在返回 404。
- `GET /api/receipts/:id`：返回 `{ receipt: {...} }`；未知回执返回 404。
- `GET /api/admin/audit`（**需 X-Admin-Token**）：`{ events: [...] }`，按时间倒序返回审计事件，可带 `?limit=`（1–500，默认 100）。事件含 `id, at, action, pollId, result, detail`，`action` 为 `poll_created` / `status_changed` / `members_changed` / `vote_accepted` / `vote_rejected`，`result` 为 `success` / `failure`。事件持久化于 SQLite，重启不丢失。

## 审计

所有已授权的管理请求都会留下审计事件：成功的业务变更与其审计记录在**同一数据库事务**中提交（要么同时生效，要么都不生效）；业务失败（非法转换、状态冲突、成员变更被拒、投票被拒、字段非法等）也会独立提交一条 `failure` 事件，而不写入任何业务数据。截止自动关闭记录为 `status_changed` 成功事件（`detail.reason = "deadline_persisted"`）。审计只记录动作、议题、结果、时间与非敏感详情（如选项 id、版本号、失败原因），**绝不记录管理令牌、身份秘密、证明（含 nullifier/points）**。未通过令牌校验的请求不产生任何事件、不写任何数据。

## 投票流程

浏览器端用身份秘密创建 `Identity`，以议题详情中的公开承诺（当前版本快照）重建 `Group`，以选项 id 为 message、议题 id 为 scope 生成证明，并随选票提交该快照的 `groupVersion`。身份秘密只保存在页面内存中，不上传、不持久化；管理令牌同样只保存在页面内存中。服务端按版本快照核验证明的 merkle 根、message、scope 及密码学有效性；快照确认、截止关闭、冻结、nullifier 查重与写票在事务中原子完成，并以 `(poll_id, nullifier)` 唯一约束抵御并发重复（去重跨版本生效）。并发的成员变更与投票只有一方能成功：投票先提交则变更得到 409 `group_frozen`，变更先提交则投票得到 409 `group_version_changed`；并发到达截止时刻的选票都在事务内读到持久化的 closed 而被拒绝。选票、回执、全部历史成员版本与审计事件持久化于 SQLite，重启不丢失。服务端可见选项与计数，但数据库不存储任何承诺与选票的关联。

首次运行会载入 2 个演示议题和 8 个公开成员承诺（作为各议题的版本 1 快照；既有数据库首次启动时会自动迁移为 open 并补出版本 1）。演示身份可用 `new Identity("veilvote-demo-member-01")` 至 `new Identity("veilvote-demo-member-08")` 复现（从 `@semaphore-protocol/identity` 导入）；这些公开输入只属于合成演示成员，不可用于真实用户。首次生成证明时会从 snark-artifacts CDN 下载证明参数（浏览器与 Node 均会自动缓存）。
