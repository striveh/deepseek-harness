# @deepseek-ai/dsh-profile-transactions

[English](README.md) | 中文

这是 `ctx.profileTransactions` 上完整 Profile generation 事务的 Service Definition。CLI bootstrap Consumer 会在主 Loader 存在前解析 active generation，`dsh-base` 中的运行期 Provider 则向 Extension Center 暴露同一个 owner，变更在重启后生效。

动态 Consumer 必须同时检查 `instanceof ProfileTransactions` 与字面量 `protocolVersion === 1`；同名 service 或其他协议修订不兼容。

## 操作

- `snapshot(profile)` 完全只读，返回单调 revision、完整 effective-tree digest、effective path、active/last-good/rollback id 与 boot status。
- `stage(request)` 会把调用方的 `mutationId` 持久绑定到一个确切 mutation，对完整隔离 Profile 应用该 mutation，且只有 Provider 持有的真实 Loader validator 接受未被修改的 candidate 后才返回。完全相同的重试返回同一 generation；同 id 的不同输入会失败。
- `commit(request)` 在 revision 与完整树 compare-and-swap fence 下发布 staged generation；receipt 标记必须重启。
- `abort(request)` 只删除未被任何权威 pointer 引用的 generation。
- `restoreLastGood(request)` 会持久绑定自己的 `mutationId`，发布适当的已验证恢复 generation，并在重试或崩溃恢复后返回同一 receipt；激活要求重启。
- `getRestoreReceipt(request)` 会按 Profile 与 `mutationId` 解析该确切终态 restore；它会先完成已经持久化的 journal，再返回原 before/after snapshot，并且绝不选择新 target。
- `acknowledgeBoot(request)` 只有在真实应用 Loader 启动了确切 revision 和 tree digest 后，才把 active generation 提升为 last-good。
- `list(profile)` 无写入地报告 snapshot、完整 staged generation 与 recoverable generation。

`ExactProfileMutation` 是封闭的 P0 union：以本地确切 `.tgz` install/update、卸载已安装 package，或由已安装 package 持有的 `cordis.patch.yml` 替换。configure 携带当前 content digest、完全规范化的下一份 UTF-8 bytes 与 next digest；transaction owner 不替 adapter 解析或编辑 YAML。

`ProfileRevisionConflictError`、`ProfileTreeConflictError`、`ProfileContentConflictError` 与 `ProfileMutationConflictError` 分别区分竞争发布、外部 effective-tree 编辑、过期 patch bytes，以及调用方 key 被不同不可变输入复用。所有跨包 id 与 digest 都是 branded type，并由导出的 validator 构造。

事务负责 mutation、validation admission、发布、boot acknowledgement 与恢复。发现、下载、信任策略、人工审批、typed configuration adapter、重启编排和原任务继续仍由 Consumer 负责。validation 会执行已经接纳的 candidate code；CLI 会最小化继承的 credential，但不提供文件系统或网络沙箱。

设计与恢复原理见 [Profile generation 事务](../../../.agents/notes/implemented/architecture/2026-08-25-profile-generation-transactions.zh.md)，类型与服务参考见 [Profile generation 事务](../../../docs/subsystems/profile-transactions.zh.md)。

## 模型体验

### Profile 生命周期状态

#### 模型看到什么

什么也看不到。`ctx.profileTransactions` 不注册 prompt、message、tool schema、stream content 或 tool result。

#### Token 影响

实时请求 token 为零。

#### KV Cache 影响

无；Profile 生命周期状态不会进入模型请求前缀。

## 已知限制与延期工作

- P0 每个 generation 接受一个 mutation，完整 `.tgz` artifact 不得包含普通/可选/打包 dependency、安装 lifecycle script 或 `bin` entry。
- 产品 CLI 的隔离 activation validator 目前只接纳 Web Profile。
- candidate validation 在 ambient environment 最小化后仍拥有 host 用户的文件系统与网络权限。
- 被替代 generation 的 retention policy 与多 package graph 事务延期处理。
