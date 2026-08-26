# Agent Note: 扩展管理 Host owner

Status: implemented

[English](2026-08-25-extension-management-host-owners.md) | 中文

## 问题

生命周期产品不能通过编辑 live Profile YAML、绕过已发布期望状态挂载 MCP client，或在重启后重新发送原始任务文本来安全模拟 extension ownership。这些捷径会把 authority 拆给产品和 runtime 两方，丢失 optimistic conflict detection，并且不能证明 teardown 或持久 dispatch identity。

Plugin、MCP 与 continuation 支持也不能表示为一个 availability boolean。缺少一个 owner 时 Store 仍可只读，但局部支持不等于 `installed` 或 `acquisition available`。任务驱动获取必须区分三者，因为候选可能变更 Profile、创建 MCP connection，或要求原任务跨重启继续。

## 决策

DSH 发布生命周期管理器需要的三个产品无关 Host 能力：`ctx.profileTransactions` 上的不可变 Profile generation transaction、`ctx.mcpConnections` 上的持久化动态 MCP 期望状态，以及 `ctx.taskContinuations` 上经 verifier 门控的跨重启任务续跑。随附 base bundle 挂载它们的本地 provider。树外 Extension Center 通过普通 package peer 与 Cordis injection 消费这些 API；DSH 不内置它的目录、策略、计划、浏览器流程或扩展 ownership 记录。

每个 owner 都独立 revision 化并持久化，除 Service 类 identity 外还公开字面量 `protocolVersion: 1`。Profile mutation 会绑定调用方 id，在发布前 stage 完整不可变 generation，并保留具名 last-good generation。每个 building stage 都绑定 owner PID 与确切 OS process-creation identity，再为确切 stage Promise 持有独立 SQLite OS lock。contender 会跨 Worker thread 与进程探测该 lease：存活的 Worker 保留 reservation，Worker 异常退出时 OS 会释放 lease，之后的重试即可替换。Profile owner 会在 coordinator admission 前从文件系统根开始，以非递归方式逐级创建 transaction ancestry；每个 component 无论刚创建，还是收到 `EEXIST` 后被确认为目录，都会随后 parent-fsync。首次执行受 revision/tree fence 约束；commit 完成后，等价的 completed identity 可跨新 fence 返回原 generation 与 before/after receipt，不会再次验证或增加 revision。Commit 与 restore 会保留相关 journal，直到 SQLite 持有确切 receipt，因此在 state fsync 后恢复时只会补全同一 identity，不会重新发布。MCP 操作保存一个准确 descriptor，针对未受管理碰撞预留 Tool namespace，并等待普通 MCP client Fiber 发布或撤回它持有的 Tool generation；永久删除是对已移除记录单独执行的 revision-fenced purge。每个 MCP read-repair-write cycle 都在带有限等待的 SQLite `BEGIN IMMEDIATE` reservation 下运行，因此进程死亡会释放跨进程 ownership，而不会留下孤儿 pathname lock。Streamable HTTP descriptor 会把明确的 Fetch 重定向策略经期望状态 owner 传给 SDK transport。Extension Center 只准入 `redirect: "error"`，因此 endpoint 不能把经过审查的 zero-secret request 重定向到其他位置。Continuation reservation 绑定 branded task-revision 与 verifier identity、caller mutation key、一个原始 direct-user message、evidence digest、受限 cold-resume route、dispatch identity 与 expiry。同一 provider 内的相同 key 调用会共享完整 marker checkpoint 结果；同一个离线 Session 上的不同 key reservation 则共享一次可由 provider lifetime 取消的 Agent resume，之后再分别重新校验每个调用方的完整输入。版本 4 owner 会在打开 SQLite 前从文件系统根开始，以非递归方式逐级创建到配置 store root；每个 component 无论刚创建，还是收到 `EEXIST` 后被确认为目录，都会随后 parent-fsync。之后，它会在同一个 `BEGIN IMMEDIATE` 下校验准确受限的 `STRICT` schema、dispatch lease column 与固定 state/revision 关系。只有文档列出的 Windows directory-handle 错误可豁免。open 失败会关闭 SQLite handle，并释放准确的失败 initialization，使同一进程内的恢复可以重试。wake 前必须有一个 Host 持有可续租的 owner/incarnation lease。downstream pre-step admission 恰好返回一条规范 continuation message 后，同一 owner 会在 AgentLoop 可能调用模型前，以 `synchronous=FULL` 提交 `consumed` 到 `claimed` barrier。barrier 前崩溃允许 lease 到期后接管；barrier 后崩溃可能既没有 continuation event，也没有 provider request，并且绝不自动重投。唯一的 earliest-due timer 覆盖 inactive-store 发现、跨 Host 推进、claim expiry、lease 接管与有界故障 retry。provider-owned cold handle 会保持注册直到 Session 的最后一个 active claim 结束，之后恰好 dispose 一次；teardown 会中止卡住的 creation，并在不丢失主故障的前提下尝试所有 cleanup。

Continuation store 的 close 是不可逆终止操作。它会先把实例标记为 closed，再排空当前 opening Promise；观察到终止态的 open 会在发布前关闭自己的局部 SQLite handle。Provider teardown 会在先前 cleanup group 之后等待该 close，因此 close 故障仍处于操作顺序的最后位置。

## 组装与限制

`dsh-base` 为每个随附 Profile 挂载三个本地 provider。Profile owner 会挂载两次：短生命周期 CLI bootstrap instance 解析并确认当前进程使用的 tree，base instance 则接受影响下一进程的运行期请求。每个 CLI 调用都从 launcher 私有根文件挂载 Loader，并继续用选中的 Profile 解析相对 entry，因此并发启动和 Loader write-back 都不会改动不可变 generation。后续 Profile patch 禁用任一 row 时，会撤回对应 owner，并让依赖产品报告 `unavailable(host-capability)`。

## 验证

CLI 只过滤 Node 22 对 SQLite 发出的准确实验性警告，避免 lifecycle owner 污染产品 stderr。缺失的自定义 Profile 会报告准确的 transaction install 命令，而不只暴露目录前置条件。

Package test 覆盖 CAS conflict、墙钟回拨、贯穿第一次 marker-checkpoint 故障的并发 caller-key 幂等、staging reservation 与 restore journal 进程死亡、corruption recovery、MCP writer 进程死亡后的恢复、静默 MCP teardown、未受管理 Tool namespace 碰撞、真实 stdio 与 HTTP Tool generation、`consumed` intent 前取消、受限和 teardown-aborted verifier race、跨 Session 的 stalled-verifier 隔离、listener 返回后 expiry 与重复项拒绝、已提交 event、claimed batch 与 pending inbox 中更新用户消息的 supersession、严格 continuation schema 篡改、包含竞争创建者的首次 root durability fault、open 失败后的进程内重试、两个 Host 间的 barrier 前 lease 接管、barrier 后 kill window、cold-handle ownership、无外部事件的自动 retry 与 expiry，以及 stalled-resume teardown。protocol probe 会拒绝同名 fake 与错误修订。base bundle config gate 证明 provider 可从已发布 dependency closure 解析。最终 packed browser、Profile restart、provider lifecycle 与原任务收敛场景由独立 Extension Center 负责。

Continuation lifecycle suite 还固定了 in-flight open 期间的 terminal close、发布前释放局部 handle、并发真实 open 故障的传播，以及 driver 等待 close 并按顺序聚合其故障。

## 考虑过的替代方案

**让 Extension Center 通过更底层 primitive 编辑或 dispatch。** 直接 Profile 写入、私有 MCP Fiber 与原始任务重放会绕过唯一能够在进程死亡后继续执行 whole-tree、namespace 与 dispatch-evidence invariant 的组件。

**把全部 lifecycle state 放入 Extension Center 专用 Host service。** 这会让 DSH 耦合到一个 catalog 与 UI 产品，阻止 CLI 和 automation consumer 复用 mutation owner，并迫使三种 durability model 一同演进。

**只探测 method name 或发布一个聚合 capability flag。** 同名 fake 或不兼容 revision 可能被误认作 owner，而单一 flag 会隐藏究竟哪个 lifecycle 能够 mutation、verify、recover 或 continue。

## 后果

产品无关 owner 让变更走 CLI、UI 与 automation consumer 共用的 API，同时让 Extension Center 保持独立项目。代价是三项独立 durable service、三项 protocol probe，以及每个 lifecycle 产品都必须明确处理 partial availability。Verifier deadline 会有意选择 `invalid` false negative，而不让每个 Session 的恢复都被阻塞；需要更慢且有界 verification 的部署必须提高配置的 deadline。

这些 service 自身不授予 package、network、credential 或 model authority。它们接受准确的 caller 输入，执行 revision 与 durability 约束，并暴露证据。消费产品仍负责来源准入、artifact integrity、人工批准、credential reference、operation receipt 与恢复策略。MCP handshake 成功不等于安全审查；Profile 启动不等于证明每项 Plugin 行为；任务续跑不等于证明用户可见目标成功。
