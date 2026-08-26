# @deepseek-ai/dsh-task-continuation

[English](README.md) | 中文

`ctx.taskContinuations` 的单次任务续行声明 Service Definition。每条声明精确绑定 session、原始直接用户消息、能力缺口摘要、任务修订、verifier、验证载荷摘要、dispatch identity 与过期时间；不会保存原始任务文本或安装载荷。

动态 Consumer 必须同时检查 `instanceof TaskContinuationService` 与字面量 `protocolVersion === 1`。revision 与 verifier identity 分别使用 `TaskContinuationRevision` 和 `TaskContinuationVerifierId`，并通过各自的校验 helper 构造。`create()` 只停放固定的插件 `UserMessage`，不会唤醒 Agent。`reserve()` 还会把 caller id 与 mutation id 绑定到确切的持久化 Session/task reference 和受限 Agent resume options，使冷启动调用方重试返回同一 claim。verifier 只有完整回显全部授权字段才能报告 ready。`cancel()` 与 `supersede()` 必须携带完全一致的 session 与任务修订；claim 进入可恢复的 `consumed` dispatch intent 后，两者返回 `false`。具体 driver 负责持久化、恢复、dispatch claim 与模型请求准入。

状态区分等待验证的 `pending`、已验证的 `ready`、可恢复 dispatch intent 的 `consumed`、provider 调用前持久化的 at-most-once barrier `claimed`，以及取消、替换、过期和无效证据等终态。provider 可以用同一 message identity 恢复 `consumed`，但必须在向 AgentLoop 返回 pre-step 准入前持久化转为 `claimed`。barrier 之后发生崩溃时，可能没有 continuation `user/message` event 或模型请求；恢复不会再次投递该 claim。权威 Session 中出现更新的 direct-user message 时，旧任务会在 verification、consumption、dispatch 或 barrier commit 前进入 superseded。

## 模型体验

### 已验证的续行消息

#### 模型看到的内容

只有通过验证的 `consumed` claim 可以通过 pre-step 检查，且 provider 必须在 AgentLoop 进入请求前提交 `claimed`。pending 与其他终态 claim 会在模型请求前被拒绝；固定消息不会复制原始任务或验证载荷：

##### 固定续行提示词

```markdown
The requested capability is now verified for the existing task. Re-check it and continue that task.
```

#### Token 影响

每个已准入声明增加一条固定用户角色消息。该消息会保留在 Session 历史中，并持续为后续请求贡献固定 token，直到常规 compaction 替换该段历史。

#### KV Cache 影响

续行消息追加在既有可复用前缀之后。固定文本保持稳定；claim identity 与 digest 只存在于消息 attribution，不改变模型可见内容。

## 已知限制与暂缓事项

- **需要 provider**：本包只定义值、验证和 verifier 注册；具体 provider 负责持久 record、恢复和 pre-step 准入。
- **at-most-once barrier 不等于完成**：`claimed` 只证明 provider 在 AgentLoop 可能调用模型前持久关闭了重投。紧随其后的 write-behind 窗口若发生崩溃，可能没有 continuation event 或请求；该状态不能证明 provider 完成、网络送达或下游副作用。
