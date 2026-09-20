# VeilVote

社区议题匿名投票应用：浏览议题、以 Semaphore 零知识证明匿名投票、查询回执与计票结果。

需要 Node.js 24。SQLite 使用 Node 内置模块，无需单独安装数据库。

```sh
npm ci
npm run build
npm start
```

打开 `http://127.0.0.1:3414`。可用 `PORT` 更换端口，`DATA_DIR` 指定 SQLite 数据目录（默认 `data`）。管理接口由 `ADMIN_TOKEN` 配置令牌：设置后，创建议题、成员变更、状态转换与审计查询都必须携带 `X-Admin-Token: <令牌>`；未设置 `ADMIN_TOKEN`（或令牌缺失、错误）时这些请求一律返回 `401 admin_unauthorized`，且不写任何数据、不留审计。从 Windows 切换到 WSL 时先在 WSL 执行 `npm ci`，以安装对应平台的构建依赖。

`npm test` 检查查询接口、成员版本管理、投票闭环（真实证明的接受、去重、篡改拒绝、计票）、管理授权与议题生命周期（草稿创建、非法转换、首票冻结、截止并发裁决、审计）、数据库重启后的数据、隐私安全运行观测（请求 id、单行访问日志、就绪探测、内存指标）以及基于真实 API 与 jsdom 的前端交互（快照展示、回执核验、审计筛选翻页、令牌内存约束）；`npm run demo` 在临时端口启动产品服务，经真实 API 演示未授权拒绝、草稿生命周期、非法转换与状态冲突、首票后冻结、截止时刻的并发投票裁决、closed/archived 结果公开与快照摘要、回执核验的四种结果、审计严格时间校验与筛选翻页、运行观测（X-Request-Id、/api/ready、/api/admin/metrics 与日志样本）和重启后的持久恢复，然后退出。前端开发使用 `npm run dev`，另开终端运行 `npm run dev:api`（默认 API 端口 3414）。

## 议题生命周期

议题经历四个状态，只能沿 `draft → open → closed → archived` 单向推进：

- `draft`（草稿）：由 `POST /api/polls` 创建。不进入公共列表，普通详情、结果与投票均返回 404；只有携带正确 `X-Admin-Token` 的管理员能看到并管理它，此阶段可任意调整成员名单。
- `open`（投票中）：`draft → open` 后对公众可见、可投票。成员名单仅在**尚未投出任何选票**时可变更；首张有效选票在同一事务内冻结当前版本，此后变更返回 `409 group_frozen`。
- `closed`（已截止）：到 `closesAt` 时，下一次读取或投票会在事务中**原子地持久化** `closed`；越界（截止时刻及之后）的选票被拒绝，并发投票由事务状态裁决，且只记录一次截止转换。也可由管理员 `open → closed` 手动截止。无论手动还是到期，关闭都会在与状态变更**同一事务**内写入不可变的结果快照 `snapshot = { pollId, groupVersion, total, options, closedAt, digest }`：字段依序序列化，`groupVersion` 取关闭当时的版本，`options` 按议题选项顺序列出 `{ id, count }`（整数为 JSON 数字），`closedAt` 为 UTC `YYYY-MM-DDTHH:mm:ss.sssZ`，`digest` 为前五字段经 `JSON.stringify`、UTF-8 编码、SHA-256 后的小写十六进制。快照归档与重启后不变。
- `archived`（已归档）：终态。`closed/archived` 均不再接受投票或成员变更，但结果继续公开可查。

旧数据库中的议题迁移为 `open`，既有查询、投票、回执与旧版成员快照完全兼容。旧库中已 `closed/archived` 但缺少结果快照的议题会在首次启动时**回填一次**：版本取当前值、计数取选票，`closedAt` 依次取成功关闭审计的 `at` → 末票的 `acceptedAt` → `closesAt` 中的首个可用值，写入后即固定。

## 接口

- `GET /api/health`：存活探测，恒返回 `{ service: "veilvote", status: "ok" }`，**只表示进程存活**，不代表依赖可用。
- `GET /api/ready`：就绪探测，真实检查 SQLite 与证明引擎。无故障返回 `200 { service, status: "ready", checks }`；任一依赖异常返回 `503 { service, status: "not_ready", checks }`。`checks` 每项只含依赖名、状态与稳定错误码：`sqlite` 为 `ok`/`error`（`sqlite_unavailable`）；`proof_engine` 在首次证明核验前为 `idle`、核验成功后为 `ok`、核验抛错时为 `error`（`proof_engine_failure`）——错误会锁定，直到之后某次证明核验成功才清除。`idle` 与 `ok` 均视为就绪，只有 `error` 导致 503。响应不含文件路径、堆栈或其他内部信息。
- `GET /api/admin/metrics`（**需令牌**）：内存指标，返回 `{ startedAt, metrics }`，进程启动后清零、重启即清空。`metrics` 按 `operation`、`statusCode`、`errorCode`、`decision` 四个**低基数**标签聚合，每行含 `count`、`sumMs`、`maxMs`（无对应标签时为 `null`）。该接口自身不计入指标；未携带或令牌错误时返回 401，且不写审计。
- `GET /api/polls`：`{ polls: [...] }` 议题摘要（不含草稿；管理员请求带令牌时可看到草稿）。
- `GET /api/polls/:id`：`{ poll: {...} }`，包含 `options`、`eligibleMemberCommitments`、`groupVersion` 与 `merkleRoot`；三者来自同一份持久化的成员版本快照，重启后不变。草稿对普通请求返回 404（管理员带令牌可读）。不存在时返回 404。
- `POST /api/polls`（**需 `X-Admin-Token`**）：创建 `draft` 议题。接收既有议题字段（`id`、`title`、`summary`、`description`、`organizer`、`publishedAt`、`closesAt`，时间均须为带时区的严格 ISO8601 时刻）、非空且无重复的 `commitments`，以及至少两个 `id` 唯一的 `options`。成功返回 201 与 `{ poll }`；字段非法返回 400；`id` 冲突返回 409 `poll_exists`；未授权返回 401。
- `POST /api/polls/:id/status`（**需令牌**）：提交 `{ status, expectedStatus }`，仅允许 `draft→open→closed→archived` 的相邻转换。成功返回 200 与 `{ status, poll }`；议题不存在 404；状态值非法 400 `invalid_status`；`expectedStatus` 与当前状态冲突 409 `status_conflict`；非法转换（跳级或终态再转）409 `illegal_transition`。
- `POST /api/polls/:id/group`（**需令牌**）：变更成员名单，提交 `{ operation, expectedVersion, ... }`。`join` 携带 `commitment` 追加成员；`rotate` 携带 `oldCommitment` 与 `newCommitment` 原位替换；`revoke` 携带 `commitment` 移除成员。每次成功变更都会持久化一个不可变的新版本（承诺列表 + Merkle 根 + 递增版本号）并返回 201 与 `{ group: { pollId, version, merkleRoot, memberCount, commitments } }`。议题不存在 404；报文格式非法、目标承诺不存在、承诺重复或变更后名单为空 400；`expectedVersion` 过期 409 `group_version_changed`；议题已有选票（名单已冻结）409 `group_frozen`；议题不在可编辑状态（非 draft/open）409 `poll_not_editable`。仅 draft 或未投票的 open 可变更。
- `POST /api/polls/:id/votes`：提交 `{ optionId, proof }`（Semaphore v4 证明，message 为选项 id、scope 为议题 id），可附带 `groupVersion` 声明所基于的成员版本；省略时按证明的 Merkle 根解析版本以兼容旧客户端。成功返回 201 与 `{ receipt: { id, pollId, optionId, nullifier, acceptedAt } }`，首张选票会在同一事务中冻结当前版本。议题不存在或为草稿 404；报文格式或选项非法 400；证明无效或被篡改（message/scope/merkle 根不匹配）、证明根不属于任何已知版本 422；议题非 open 或已过 `closesAt`、同一 nullifier 重复投票（跨版本去重）、版本已过期 409（分别为 `poll_closed`、`duplicate_nullifier`、`group_version_changed`）。
- `GET /api/polls/:id/results`：`{ result: { pollId, total, options: [{ id, count }] } }`，零票选项也会列出，选项按议题选项原顺序排列；`closed/archived` 额外携带关闭时写入的 `snapshot`（`{ pollId, groupVersion, total, options, closedAt, digest }`），`open` 无快照、计数实时；草稿与不存在返回 404。
- `GET /api/receipts/:id`：返回 `{ receipt: {...} }`；未知回执返回 404。
- `POST /api/receipts/:id/verify`：接收 `{ pollId, optionId, nullifier }` 核验回执。回执未知返回 404；任一字段不符返回 422 `receipt_mismatch`；全部相符返回 200 与 `{ valid: true, receipt }`。核验只比对回执自身的公开字段，不与任何身份关联。
- `GET /api/admin/audit`（**需令牌**）：审计事件按时间倒序分页返回 `{ events, total, page, pageSize, totalPages }`。查询参数：`pollId`、`action`、`result` 精确匹配；`from`/`to` 只接受**带时区的严格 ISO8601 时刻**（`YYYY-MM-DDTHH:mm:ss[.sss](Z|±hh:mm)`，如 `2026-09-20T10:00:00+08:00`），仅被 `Date.parse` 宽松接受的文本（日期-only、空格分隔、缺时区、不存在的日历日如 `2026-02-29`）一律 400 `invalid_time_range`，倒置区间同样 400；两端均含端点；`page` 默认 1；`pageSize` 默认 50、上限 200；越界页码返回空的 200 页。

## 审计

所有已授权的管理请求都会持久化审计事件，记录**动作、议题、结果（成功/失败）、时间与动作详情**（如状态转换的 from/to、成员变更的 operation/版本、失败原因），但**绝不记录管理令牌、身份秘密、承诺内容或零知识证明**。成功的变更与其审计行在同一数据库事务内提交（原子、要么都成功要么都回滚）；业务失败（非法转换、状态冲突、名单冻结、字段非法等）也会留下 `result: "failure"` 事件。未授权请求在鉴权阶段即被拒绝，不触碰数据、不产生事件。审计事件持久化于 SQLite（`audit_events` 表），重启不丢失。前端在页面内存中保存管理令牌（刷新即失效，不写入 localStorage），并提供状态徽标、合法状态转换操作、草稿创建与审计记录查看界面。

## 运行观测

每个 `/api` 请求由**服务端**生成一个 `requestId`（UUID），通过响应头 `X-Request-Id` 返回；客户端若发送同名头会被完全忽略（不回显、不可伪造关联）。请求结束时向日志输出**一行 JSON**，固定字段为：

```json
{"at":"2026-09-20T10:00:00.000Z","requestId":"…","operation":"vote_submit","statusCode":201,"outcome":"success","durationMs":19,"decision":"accepted"}
```

- `operation` 取固定低基数词表：`health`、`ready`、`poll_list`、`poll_create`、`poll_detail`、`poll_results`、`status_change`、`group_change`、`vote_submit`、`receipt_lookup`、`receipt_verify`、`audit_query`、`not_found`（405 归入所请求资源的操作）。`/api/admin/metrics` 自身的任何响应（200/401/405）都不记录。
- `outcome` 为 `success`（2xx）/ `rejected`（4xx 非 401）/ `unauthorized`（401）/ `error`（5xx）；失败时附稳定 `errorCode`（如 `invalid_proof`、`group_version_changed`）。
- 并发投票与成员变更额外带低基数 `decision`：`accepted`、`conflict`（409，事务并发/冲突裁决）、`rejected`（其余 4xx）、`unauthorized`、`error`；具体冲突原因仍由 `errorCode` 区分。
- 投票、状态转换、回执核验、审计查询的成功、拒绝、未授权与内部异常均会记录；日志或指标故障**绝不改变业务响应**。
- 日志与指标**禁止包含**请求正文、查询原文、管理令牌、身份秘密、承诺、证明、nullifier、回执编号与 pollId——只有操作名、状态码、稳定错误码、裁决标签和耗时。
- 指标只驻留内存，重启清零；`/api/admin/metrics` 自身不记录，并发请求在事件循环中逐条计数、不重不漏。

## 公开复核流程

- **结果页**：`open` 议题只显示实时计数；`closed/archived` 议题展示关闭事务内定格的不可变快照——关闭时刻 `closedAt`、`groupVersion`、按议题选项原顺序排列的计数与 `digest`（前五字段 JSON 序列化后 SHA-256）。快照摘要可一键复制（剪贴板不可用时退化为可全选文本），刷新页面、议题归档与服务重启后内容保持一致；`draft` 议题始终不公开，详情、结果、投票与回执均 404。
- **回执核验**：结果页提供公开核验表单，填写回执编号、`pollId`、`optionId`、`nullifier` 后调用 `POST /api/receipts/:id/verify`。界面分别反馈核验成功（200）、未知回执（404）、字段不符（422 `receipt_mismatch`）、格式错误（400）与网络失败；失败后可直接修改重试。提交期间按钮与输入禁用，杜绝重复提交。表单**从不索取身份秘密**，输入只存在于页面内存，且核验请求即使在管理模式下也不携带 `X-Admin-Token`。
- **审计视图**：管理模式下的审计界面支持 `pollId`、`action`、`result`、`from`、`to`、`pageSize` 筛选与首/末/前/后翻页，显示加载中、空结果、401、400（时间/分页）、总数与总页数；任何筛选变化都回到第一页，越界空页不导致界面崩溃。



## 投票流程

浏览器端用身份秘密创建 `Identity`，以议题详情中的公开承诺（当前版本快照）重建 `Group`，以选项 id 为 message、议题 id 为 scope 生成证明，并随选票提交该快照的 `groupVersion`。身份秘密只保存在页面内存中，不上传、不持久化。服务端按版本快照核验证明的 merkle 根、message、scope 及密码学有效性；快照确认、冻结、nullifier 查重与写票在事务中原子完成，并以 `(poll_id, nullifier)` 唯一约束抵御并发重复（去重跨版本生效）。并发的成员变更与投票只有一方能成功：投票先提交则变更得到 409 `group_frozen`，变更先提交则投票得到 409 `group_version_changed`。选票、回执与全部历史成员版本持久化于 SQLite，重启不丢失。服务端可见选项与计数，但数据库不存储任何承诺与选票的关联。

首次运行会载入 2 个演示议题和 8 个公开成员承诺（作为各议题的版本 1 快照；既有数据库首次启动时会自动迁移出版本 1）。演示身份可用 `new Identity("veilvote-demo-member-01")` 至 `new Identity("veilvote-demo-member-08")` 复现（从 `@semaphore-protocol/identity` 导入）；这些公开输入只属于合成演示成员，不可用于真实用户。首次生成证明时会从 snark-artifacts CDN 下载证明参数（浏览器与 Node 均会自动缓存）。
