# @deepseek-ai/dsh-profile-transactions-local

[English](README.md) | 中文

这是 [`ctx.profileTransactions`](../profile-transactions/README.zh.md) 的本地 Provider。它在 `profilesDir/.dsh-profile-transactions/<profile>/` 下保存不可变的完整 Profile generation，以 SQLite `BEGIN IMMEDIATE` 作为进程所有的跨进程 writer reservation，并通过持久化 JSON journal 发布 pointer transition。

Provider activation 会校验必需的绝对 `installAnchor`，但不会导入 SQLite 或创建 transaction state。snapshot 与 list 保持仅访问文件系统；首次 writer 才导入 SQLite，因此在仍将 `node:sqlite` 标为 experimental 的 Node release 上，read-only CLI 输出保持干净。

该 package 还导出由 Provider 持有的 `copyProfileTree(sourceRoot, targetRoot)` 与 `digestProfileTree(root)` 文件系统 primitive。两者覆盖相同的完整 tree entry、可执行位与内部 link target，并排除 transaction 与 runtime scratch；CLI 会组合使用它们，从 active generation 物化并验证调用私有的 Loader tree。

产品有意挂载两个 provider instance。短生命周期 pre-Loader Context 解析并确认当前 CLI 进程使用的 tree；`dsh-base` Context 中的另一个 instance 服务运行期 Extension Center 请求。两者共享相同文件与 SQLite reservation；运行期 instance 只能发布下一进程的 active pointer，不能改变自身 effective tree。

## 配置

| 键 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `profilesDir` | string | 必填 | 直接子目录为具名 live Profile 的目录 |
| `installAnchor` | string | 无 | owner-managed Loader validation 使用的确切应用 package 文件；缺失时 mutation 明确失败 |
| `lockWaitMs` | 非负整数 | `10000` | 等待另一进程 Profile writer reservation 的最长时间 |
| `validationTimeoutMs` | `1` 至 `2147483647` 的整数 | `30000` | 隔离 Loader activation 与 disposal 的 wall-clock budget |

## 完整 generation

每个 generation 都包含 `package.json`、有序 `dsh.profile.bundles`、`cordis.patch.yml`、`pnpm-workspace.yaml`、owner 维护的 `pnpm-lock.yaml`、保留的 `.dsh-artifacts` archive，以及 `node_modules` 下真实 package 文件。install、update 与 uninstall 会把 manifest、bundle list、package 文件、保留 archive、root importer、package snapshot 与 integrity metadata 一起改变。压缩输入与声明的解压内容分别受 100 MiB 上限约束；初始文件大小与复制期间实际观察到的字节数都会被限制。格式错误或过期 lockfile 会在 staging 或权威发布前明确失败。

P0 archive admission 会校验确切 name、确切 SemVer、调用方 SHA-256、archive path/type/limit、bundle declaration，并拒绝 dependency、安装 lifecycle script 与 `bin` entry。带前导零的数字 prerelease identifier 不是确切 SemVer。对于当前直接列入 `dsh.profile.bundles`，或经 bundle install/update 后会直接列入其中的 package，owner 会使用 app-boot 优先采用的确切 `installAnchor` lookup。若该名称可从安装解析，首次请求会在 staging reservation、candidate 创建、archive 读取或 Loader validation 前失败；completed mutation replay 也会在返回持久 generation 前重新检查该归属。archive entry 预检与 extraction 会分别保留累计 entry 与 byte state；拒绝会在 reader callback 内被捕获，并通过 `stage()` Promise 返回，因此不安全或并发改写的已复制 archive 会 fail closed，不会产生未捕获的 callback 错误或一直 pending 的 stage。dependency map 使用自有 key membership 与 null-prototype mutation，因此与 Object prototype name 重叠的 package name 在 manifest 与 lockfile 中仍保持普通 package 语义。configure 只能改变根 `cordis.patch.yml`；它要求已安装 owner package、规范 UTF-8/LF/尾换行 bytes、content digest 与完整树 fence。Provider 会在首次 asynchronous store operation 前同步脱离每个 mutation 与 transition request。`stage` 自身会运行 Provider 持有的真实 composition validator；Consumer callback 无法替换它。`validationTimeoutMs` 会限制该 child 的 activation 与 disposal，且不会依赖 Node 对 overflow timer 的钳制行为。validator 会在 stdio 排空后的 child `close` 上 settle。若 output-limit 或 timeout 处理无法终止 process tree，parent 会先销毁两条 stdio pipe 并解除 child 的 event-loop 引用，再拒绝 Promise；原始 failure 因此仍排在 aggregate 首位，且不会保留 event-loop handle，彼此独立的 termination 与本端 release failure 则按操作顺序排在其后。

## 发布与恢复

首次 commit 会把原始 live Profile 复制成不可变 baseline，先将其命名为 last-good，再发布 pending-restart candidate。发布前 commit 失败时，只有在确认 state 与 journal 都没有引用该 baseline 后才会将其删除。只有真实应用 Loader 成功后，`acknowledgeBoot` 才提升 generation。active generation 尚未验证时，restore 选择 last-good；否则选择前一个已验证 rollback generation。revision 与 tree fence 约束首次执行。commit 后，相同 Profile、mutation id 与 semantic mutation 会跨更新后的 fence 重放原 staged generation 与 commit receipt；artifact transport path 不属于该 identity，任何 semantic change 都会冲突。commit 与 restore 会保留 correlated journal，直到 SQLite 持有确切 before/after receipt。`getRestoreReceipt` 会取得相同 writer reservation，完成任何相关持久 journal，并在不选择新 target 的前提下返回确切 committed restore 或 `null`。因此 writer 在 state fsync 后、receipt 持久化前被杀死时，receipt 查询或 mutation 重试都能恢复；两者都不会再次增加 revision 或重复应用 mutation。调用方 mutation id 会在短 SQLite transaction 中预留 staging work，而 archive 构建与真实 Loader validation 位于 transaction 之外；完全相同的并发请求会收敛到同一 generation。每个 building reservation 都绑定 owner PID 与确切 OS process-creation identity，先排除进程退出与 PID 重用。其确切 stage Promise 还会持有独立 SQLite OS lock，contender 会跨 Worker thread 与进程探测该 lock。只要该 Promise 的 Worker 仍存活并持有 lease，contender 就不会偷取 reservation。Worker 异常退出时 OS 会释放 lease，之后的重试可替换未完成 reservation。stage work 与 reservation cleanup 同时失败时，有序 aggregate 会把 stage failure 放在首位；lease 不再被持有后，重试可以替换 reservation。

state、journal，以及 generation 中每个受支持的文件和目录都会在发布前 flush。writer 创建或接受 `writer.sqlite` 前，会使用 app-boot 共享的 `ensureDurableProfileDirectory` primitive，从文件系统根开始以非递归方式逐级创建到 `.dsh-profile-transactions/<profile>/generations`。每个 component 无论刚创建，还是收到 `EEXIST` 后被确认为目录，都会在继续前 fsync 其 parent。因此，竞争进程在创建后、自身 fsync 前被杀死时，另一 writer 不会接受未持久化的 transaction authority。任何必需的 parent-directory fsync 失败都会在 coordinator admission 前中止操作。coordinator 只会在两个 table definition、完整 column metadata、constraint、`STRICT` declaration 以及确切 primary/unique index 全部匹配时接受当前 schema version。真实进程退出会释放 SQLite reservation。只读 snapshot/list 会投影有效 durable journal 而不清除它，并在向 CLI 返回 effective path 前把每个 pointer 指向的不可变 generation 与已记录 tree digest 比对；外部改变的 plugin 或 patch bytes 因此无法进入 Loader 执行。下一 writer 会完成当前 `before` state 对应的 journal，或接受已经发布的 `after` state。任何不相关、格式错误或不完整关系都会明确失败，不会猜测。

## 模型体验

### 本地 generation 存储

#### 模型看到什么

什么也看不到。`LocalProfileTransactions` 只执行 Host 文件系统协调，不注册任何模型可见内容。

#### Token 影响

实时请求 token 为零。

#### KV Cache 影响

无；本地 generation 文件不会进入模型请求前缀。

## 已知限制与延期工作

- Node 无法在 Windows 上 flush directory handle；file descriptor 会被 flush，rename 仍保持原子，directory metadata 持久化依赖文件系统。
- abort 会删除未提交 generation，但自动 retention pruning 延期处理。
- P0 Provider 持有的隔离 Loader admission 使用产品 launcher 的隐藏 child route，目前只支持 Web Profile。
- CLI validation 会最小化 ambient credential authority，但不会限制已接纳 code 的文件系统或网络访问。
