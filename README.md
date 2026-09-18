# VeilVote

社区议题浏览应用，提供议题内容、可选方案和成员公开承诺查询。

需要 Node.js 24。SQLite 使用 Node 内置模块，无需单独安装数据库。

```sh
npm ci
npm run build
npm start
```

打开 `http://127.0.0.1:3414`。可用 `PORT` 更换端口，`DATA_DIR` 指定 SQLite 数据目录（默认 `data`）。从 Windows 切换到 WSL 时先在 WSL 执行 `npm ci`，以安装对应平台的构建依赖。

`npm test` 检查查询接口及数据库重新打开后的数据；`npm run demo` 启动一个临时端口上的产品服务，从真实 API 读取并展示议题，然后退出。前端开发使用 `npm run dev`，另开终端运行 `npm run dev:api`（默认 API 端口 3414）。

已有接口：

- `GET /api/health`：服务状态。
- `GET /api/polls`：`{ polls: [...] }` 议题摘要。
- `GET /api/polls/:id`：`{ poll: {...} }`，包含 `options` 和 `eligibleMemberCommitments`；不存在时返回 404。

首次运行会载入 2 个演示议题和 8 个公开成员承诺。演示身份可用 `new Identity("veilvote-demo-member-01")` 至 `new Identity("veilvote-demo-member-08")` 复现（从 `@semaphore-protocol/identity` 导入）；这些公开输入只属于合成演示成员，不可用于真实用户。界面和 API 当前仅支持读取，议题的时间与状态来自演示数据。已安装 Semaphore 身份、群组和证明库，应用当前未提供证明生成或提交功能。
