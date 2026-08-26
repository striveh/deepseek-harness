# @deepseek-ai/dsh-task-continuation-driver

[English](README.md) | 中文

`ctx.taskContinuations` 的 SQLite 持久化 provider。配置根目录包含严格的版本 4 claim 数据库。Provider 启动时会打开并校验已有数据库以执行冷恢复；空部署则把 `node:sqlite` 导入与数据库创建推迟到第一次 reservation。没有数据库时，read 与 terminal no-op 保持零写。SQLite 打开数据库前，store 会从文件系统根开始，以非递归方式逐级创建到配置 root。每个 component 无论刚创建，还是收到 `EEXIST` 后被确认为目录，都会在继续前 flush 其 parent。因此，竞争进程在创建后、自身 flush 前被杀死时，另一进程不会接受未持久化的目录 authority。任何必需的 directory sync 失败都会拒绝初始化。仅在 Windows 上，当 Node 无法打开或 flush directory handle 时，才接受 `EACCES`、`EINVAL`、`ENOTSUP` 或 `EPERM`；file fsync、SQLite `synchronous=FULL` 与其他全部失败仍为强制要求。open 失败会关闭 SQLite handle，并只释放该次准确的 in-flight initialization，因此同一进程中的后续恢复可以重试。schema 读取、创建与精确校验会在同一个 `BEGIN IMMEDIATE` 下完成；失败会一并回滚 application id、version、table 与 index。校验要求完整的 `table_xinfo` column metadata、规范且含约束的 `CREATE TABLE ... STRICT` SQL、primary-key index、caller/mutation unique index、无额外 schema object，以及准确的 state/revision 关系（`pending=0`、`ready=1`、`consumed=2`、`claimed=3`，或可达的终态 revision）。每次生命周期变更都是跨进程 compare-and-set transition；未知 application id、schema 版本、schema object、状态、lease 字段或其他字段都会 fail closed。成功的 transition 会把 `updatedAtMs` 持久化为请求时间、当前时间与创建时间中的最大值，因此墙钟回拨不会违反行约束或卡住 claim。

延迟加载 `node:sqlite` 时只会抑制 Node 22 对 SQLite 发出的准确 `ExperimentalWarning`，因此普通 CLI 的 stderr 仍只用于产品诊断。

调用 `close()` 会先把 store 置为不可逆终止态，再等待当前的 in-flight initialization。观察到终止态的 open 会在发布前关闭自己的局部 SQLite handle，而 provider teardown 会在先前 cleanup group 之后等待 store close 完成。

`verifierTimeoutMs` 默认为 30,000，接受 1 至 2,147,483,647 的整数毫秒值。每个 verifier 都会收到与该 deadline 和 provider teardown 合并的 signal。超时会产生警告、尝试执行受 revision 保护的 `pending` 到 `invalid` transition，并在该 transition 获胜时移除 marker，随后继续恢复其他 Session；超时 claim 不会被 dispatch。`recoveryRetryInitialMs` 与 `recoveryRetryMaxMs` 默认为 100 和 5,000，且最大值不得小于初始 delay。resume、verifier、flush、scan 或 cleanup 异常会安排一个合并且受上限约束的指数退避 retry。verifier 明确返回 `not-ready` 不属于故障，但 claim 仍受持久 expiry 约束。`recoveryPollMs` 默认为 1,000。唯一的 earliest-due timer 统一覆盖未激活 store 的发现、跨 Host 数据库推进、claim expiry、其他 owner 的 lease deadline 与故障 retry；显式 reservation 失败不能取消该恢复调度。

创建流程先持久化 pending record，再通过 `agent.send(..., 'next-turn', false)` 停放固定消息并 checkpoint Session。caller-bound `reserve()` 使用唯一 `(callerId, mutationId)` key 与确切不可变 payload，因此并发和冷启动重试会收敛，不同输入会失败。同一 provider 内使用相同 key 的调用会共享完整的停放与 checkpoint Promise：winner 的 marker 持久化前，任何 replay 都不会返回；第一次 checkpoint 失败时，会先把 record 置为 `invalid`，再让所有参与者收到同一个拒绝。同一个离线 Session 上使用不同 key 的并发 reservation 会先共享一次进行中的 cold resume，再由每个请求重新校验完整 route 与 payload。其闭合 cold-resume route 只接受最多 256 UTF-8 byte 的 provider 与 model identifier，以及可选的 1 至 1,000,000 `maxTokens`；live 或调用方提供的 route 超限时，会在 Agent resolution 或 claim 持久化前拒绝。启动时枚举 active record；精确 Session 不在线时自动 resume；正常 Agent teardown 清空 inbox 后，会用同一个 dispatch message identity 重建。只有指定 verifier 会被调用。完整回显的正向结果进入 `ready`；inbox 插入持久化后进入可恢复的 `consumed` intent。`dispatchLeaseMs` 默认为 30,000，用于定义可续租的跨进程 owner 生命周期。只有一个 Host 能在 wake 前取得 owner/incarnation lease；downstream pre-step admission 阻塞期间会持续续租，其他 Host 只能在 lease 过期后接管。

pre-step fence 会先执行下游准入，并要求最终 batch 恰好包含一条规范 continuation message，之后再根据已提交的 Session event、当前 claimed batch 与 pending inbox work，重新检查确切 lease、expiry、record revision、message identity 与 direct-user task replacement。在向 AgentLoop 返回 `enter` 前，它会执行一次启用 `synchronous=FULL` 且受 owner/incarnation 保护的 `consumed` 到 `claimed` CAS。只有该 winner 能进入模型，因此跨 Host 与重启的 dispatch 采用 at-most-once 语义。barrier 前崩溃时可在 lease 过期后接管；barrier 后崩溃时可能没有 continuation `user/message` event 或模型请求，恢复不会重投。已有的确切 dispatch event 仍可把恢复出的 `consumed` 终态化而不创建新 turn。公开 cancellation 与 supersession 在 `consumed` 时停止；内部 direct-user replacement fence 可在 barrier 前将其终态化。错误 session、revision、digest、verifier 回显、过期、取消、替换、inbox content、重复 continuation、lease 或更新的 direct-user message 都会产生零 continuation dispatch。

公开 list、cancellation 与 supersession 输入会在第一次异步 store 操作前完成规范化并与调用方对象脱离，因此调用方后续修改无法重定向 filter 或 transition。cold-resumed `AgentHandle` 只归本 provider 所有：同一 Session 仍有 `pending`、`ready` 或 `consumed` claim 时保持注册，最后一个 claim 进入终态后恰好 dispose 一次；调用方持有的 live handle 永不由 driver dispose。每次 cold resume 都会收到 provider-lifetime creation signal，因此 teardown 能在发布前取消卡住的 persistence load 或 setup。provider 正常卸载会先 abort 该 signal，再用 `keepInbox` 中止 maintenance，取消 due timer 与 lease heartbeat，之后尝试完成全部 scan、probe、resume、lease、handle 与 store cleanup，并按操作顺序报告失败。只有实际 dispose 成功的 handle 才会从 ownership table 删除。claim record 会保留原 Agent options，但不含任务文本；record 不会被删除，因此 Agent 正常 teardown 清空 inbox 不影响 barrier 前恢复。

## 模型体验

### 恢复后的续行轮次

#### 模型看到的内容

指定 verifier 成功且持久化 claimed barrier 提交后，存活进程会在一个新轮次中把 `dsh-task-continuation` 定义的固定续行消息交给模型。紧随其后的 write-behind 窗口若发生崩溃，可能没有该轮次。store record、verifier payload、CAS revision、lease 与恢复诊断均不会进入模型上下文。

#### Token 影响

每个成功的 claimed dispatch 增加一条固定用户角色消息，以及该轮次生成的普通 assistant 响应。恢复最多准入一个副本；barrier 后崩溃窗口可能一个也不准入。

#### KV Cache 影响

新轮次追加在持久对话前缀之后。barrier 前恢复会重建相同的 Session history 与 dispatch identity，而不是把早期任务复制到新前缀。

## 已知限制与暂缓事项

- `claimed` 只证明 provider 调用前持久化的 at-most-once barrier，不证明 Session event、模型 provider 调用或下游副作用。
- 冷 resume 会恢复 claim 中的 Agent options 与持久 preset metadata；需要额外 resume-time composition 的部署必须通过 Agent factory 安装。
