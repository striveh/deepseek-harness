# Profile Generation 事务

[English](profile-transactions.md) | 中文

Profile transaction seam 负责完整不可变 Profile generation，以及下一次应用启动选择的 pointer。[`dsh-profile-transactions`](../../packages/profile/profile-transactions) 是 Service Definition，[`dsh-profile-transactions-local`](../../packages/profile/profile-transactions-local) 是本地 Provider，产品 CLI 与运行期 Extension Center 是 Consumer。该能力位于 agent loop 之外，不贡献模型可见状态。

来源：[`packages/profile/profile-transactions/src/types.ts`](../../packages/profile/profile-transactions/src/types.ts)

## 状态与冲突 fence

`ProfileSnapshot` 包含单调 revision、完整 effective-tree digest、effective directory、active generation、last-good generation、rollback generation，以及 `live`、`pending-restart` 或 `verified` boot status。每次 stage、commit、restore 与 boot acknowledgement 都携带所持有的 revision 和 tree digest。stage 与 restore 还携带调用方 mutation id：完全相同的重试返回同一 generation 或 receipt，同 id 被不同不可变输入复用则失败。竞争发布、外部 tree edit、过期 configure bytes 与调用方 key 冲突分别产生不同错误；任何路径都不采用 last-write-wins。动态 Consumer 必须检查 `instanceof ProfileTransactions` 与 `protocolVersion === 1`。

`getRestoreReceipt({ profile, mutationId })` 会在不选择 target 的前提下解析一个确切终态 restore。committed 结果绑定调用方 id、原 before/after snapshot、target generation/tree digest 与 required-restart 状态；不存在时返回 `null`。

tree digest 覆盖排序后的 directory entry、普通文件 bytes 与 executable bit，以及内部 symlink target。launcher 持有的 `cordis.yml`、transaction metadata 和 runtime scratch 被排除。除此之外，generation 包含完整可启动 Profile：manifest、bundle list、patch、workspace settings、pnpm lockfile、保留 archive 与真实已安装 package 文件。

## Mutation 生命周期

P0 每个 generation 接受一个确切 mutation。install/update 接受已经落到本地的 `.tgz`、package kind、确切 name/version 与调用方 SHA-256。uninstall 指定已安装 package。configure 指定一个已安装 package，其 typed adapter 必须为 Profile 根 `cordis.patch.yml` 生成确切替换，包含当前/下一份 content digest 与规范化下一份 UTF-8 bytes。owner 不解析 YAML，也不能定位其他文件。

staging 会复制完整 effective Profile，确认副本仍匹配所持 tree，对 candidate 应用 mutation，将 `package.json`、有序 bundles、真实 package 文件、保留 artifact，以及 pnpm importer/package/snapshot record 一起更新，再调用本地 Provider 的隔离 validator。公开 Service 不接受 validation callback。validation failure、candidate 修改或 lockfile 不一致都会删除 candidate，不改变权威状态。

本地 Provider 会通过 CLI 的隐藏 argv router 启动有界 detached child，以只读方式加载 candidate，组合真实 patch layer，在 loopback 的 port zero 上启动真实 Web Loader，再将其释放。合成 `cordis.yml` 位于用后即删的 validation home，而明确 Loader base URL 仍指向 candidate Profile 根，因此 validation 不写 staged tree，相对 entry 也保持生产语义。P0 对非 Web candidate validation 明确失败。parent 对输出和时间设限，失败时终止 child process tree。

validator child 只继承进程启动、locale 与临时目录环境变量。Harness state、凭据特征名称、凭据文件指针、provider endpoint override、proxy、SSH agent authority、Node 注入选项和其他所有 ambient name 都会被丢弃；candidate 激活前，child 会把 home、Harness home、XDG、application-data 与临时目录替换为一个用后即删的目录。这只是 credential minimization，不是文件系统或网络沙箱。已接纳的 candidate code 仍以 host 用户的操作系统权限运行，能够访问 host path 或网络，因此 trust policy 与人工审批必须发生在 validation 前。

## 发布、启动与恢复

首次 commit 会把原始 live Profile 捕获为不可变 baseline 与 last-good recovery target。candidate 变为 `pending-restart` active generation；任何事务都不会改变发布它的当前进程 effective tree。下一次启动时，短生命周期 pre-Loader Consumer 会解析 active generation，把它复制到当前调用私有的 runtime root，按所选 tree digest 验证副本，加载该副本，并在 Loader 激活前确认同一 transaction snapshot。私有副本是 Loader 的相对 entry 解析基准，因此之后替换 authoritative generation 不能提供被导入的 bytes。每个 runtime root 都记录 owner PID 与 process incarnation；后续 preparation 会移除确切的 dead-owner 与 PID-reuse residue，同时保留仍存活的并发调用。

CLI 首次 install 可能早于普通 Web Profile boot。CLI 初始化随附 Web template 后、stage 前，会用相同 app-boot authority 修复安装持有的 `profiles/node_modules` fallback，因此真实 validator 解析标准 base 与 Web row 的方式和后续产品启动完全一致。

真实应用 Loader 激活后，bootstrap Consumer 确认确切 generation/revision/tree，再释放自身。只有该 acknowledgement 会把 generation 提升为 `verified` last-good，并把原 last-good 移至 rollback。boot failure 不改变 last-good。active generation 未验证时 restore 选择 last-good；generation 已验证后选择 rollback；两者都要求重启。

managed generation 的 patch 文件不会被 HMR watcher 监听或重新读取。home-level patch 仍可热更新，而 Profile configuration change 必须创建并验证另一个 generation。外部 generation edit 会触发下一次 whole-tree fence，不会成为授权热更新。

## 双重组合与恢复

CLI 会在主 Loader 之前，于短生命周期 bootstrap Context 中挂载 `LocalProfileTransactions`。`dsh-base` 在运行期以 `profilesDir: dshHomePath('profiles')` 挂载第二个 instance，服务 Extension Center 请求。两者使用相同 per-Profile SQLite reservation 和 journal。运行期 Provider 只能发布下一进程的 pointer，不能改变当前进程 effective path。

pointer writer 使用短 SQLite `BEGIN IMMEDIATE` transaction。stage transaction 先预留调用方 mutation id，再释放 SQLite，由 owner 构建并验证完整 generation，最后在另一个短 transaction 中把该准确 generation 标记为 complete。死亡 builder 可用同一 key 恢复；仍存活的并发 builder 会被等待。pointer 发布会校验 next state 引用的每个 generation，flush journal，替换并 flush state，最后删除 journal。restore 会记录 mutation id 与确切 transition receipt。receipt 查询会取得 writer reservation 并完成相关持久 journal，因此进程在 state fsync 后、receipt 持久化前死亡时，会返回原结果而不再增加 revision。snapshot/list 保持只读并投影有效 durable journal；下一 mutation 或确切 receipt 查询会完成恢复。格式错误或不相关状态会明确失败，不会猜测。

## P0 限制

P0 archive 不得声明普通、可选或打包 dependency、安装 lifecycle script 或 `bin` entry。隔离产品 validator 只接纳 Web Profile，且不提供操作系统级文件系统或网络 confinement。多 package graph 事务、自动 generation pruning、在线发现、信任判断、审批 UX、重启编排与原任务继续由后续层或 Consumer 负责。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxprofiletransactions--profiletransactions-abstract-seam"></a>

### `ctx.profileTransactions` — `ProfileTransactions` (abstract seam)

Transaction owner for complete named Profile generations.

```ts cordis-catalog
/**
 * Read the authoritative state and complete effective-tree digest without writing.
 * @param profile - Profile to inspect.
 * @returns the state and effective directory app boot must consume.
 */
abstract snapshot(profile: ProfileId): Promise<ProfileSnapshot>

/**
 * Build a complete isolated candidate and run the Provider-owned real activation validator.
 * @param request - semantic mutation identity and fences for its first execution; a completed equivalent identity may carry newer fences.
 * @returns the newly validated or durably replayed original generation handle.
 */
abstract stage(request: StageProfileGenerationRequest): Promise<StagedProfileGeneration>

/**
 * Publish one validated generation; its activation requires process restart.
 * @param request - generation and current fences for first publication; a completed generation may carry newer fences.
 * @returns the new or durably replayed original transition receipt.
 */
abstract commit(request: CommitProfileGenerationRequest): Promise<ProfileCommitReceipt>

/**
 * Remove one generation that no authoritative state names.
 * @param request - exact Profile and generation to discard.
 * @returns whether a generation directory was removed.
 */
abstract abort(request: AbortProfileGenerationRequest): Promise<boolean>

/**
 * Publish the appropriate last-good or rollback recovery generation.
 * @param request - Profile and both current conflict fences.
 * @returns the durable transition receipt.
 */
abstract restoreLastGood(request: RestoreLastGoodProfileRequest): Promise<ProfileCommitReceipt>

/**
 * Resolve a retained restore outcome, completing an already durable journal if process death interrupted receipt publication.
 * @param request - exact Profile and caller mutation identity to query.
 * @returns the original committed receipt, or `null` when that identity has no restore transaction.
 */
abstract getRestoreReceipt(request: GetProfileRestoreReceiptRequest): Promise<ProfileRestoreReceipt | null>

/**
 * Promote the active generation only after the real app Loader boot succeeds.
 * @param request - exact active generation and both current conflict fences.
 * @returns the durable verification receipt.
 */
abstract acknowledgeBoot(request: AcknowledgeProfileBootRequest): Promise<ProfileCommitReceipt>

/**
 * List complete staged and recovery generations without changing disk state.
 * @param profile - Profile to inspect.
 * @returns current snapshot plus staged and recoverable generations.
 */
abstract list(profile: ProfileId): Promise<ProfileGenerationInventory>
```

Source: [`packages/profile/profile-transactions/src/index.ts`](../../packages/profile/profile-transactions/src/index.ts)
<!-- END GENERATED cordis-surface -->
