# @deepseek-ai/dsh-mcp-connections

[English](README.md) | 中文

`ctx.mcpConnections` 的 Service Definition，负责动态管理 MCP 连接的带修订版本的期望状态。Service Provider 持久化记录，并把已启用的记录与实时 MCP 客户端对齐；清单、RPC 和产品插件仍是该 API 的消费方。`McpConnections.protocolVersion` 是字面量 `1`；同进程消费方在依赖该 API 前，会把类 identity 与这个准确修订版本配对检查。

## 状态模型

每个活动视图分别保留三项独立修订的事实：`desired` 是持久化配置和启用状态，`observed` 是当前 Host 生命周期阶段，`tools` 是实际带服务器限定名的工具 schema generation。期望状态修订版本不能证明连接已就绪，就绪观测也不能代替当前工具 generation。

已移除记录离开活动清单，并在 `snapshot().removed` 下保留完整的原期望状态。`restore()` 把该记录移回活动清单，并对齐其保留的启用状态；`purge()` 只永久删除准确的已移除记录，绝不改变实时运行时。

## 操作

| 方法 | 持久化效果 | 运行时完成条件 |
|---|---|---|
| `configure` | 从完整 stdio 或 Streamable HTTP 描述符创建修订版本 1 | `enabled` 时激活 |
| `enable` | 设置期望启用标记 | 等待初始连接和工具发现 |
| `disable` | 清除期望启用标记 | 等待实时客户端 dispose（资源释放）且工具消失 |
| `update` | 替换完整已解析传输配置 | 替换已启用的实时客户端 |
| `remove` | 把记录移入已移除清单 | 等待拆卸完全停稳 |
| `restore` | 把已移除记录移回活动清单 | 对齐保留的启用状态 |
| `purge` | 永久删除准确的已移除记录 | 不存在实时运行时 |

每次变更都携带调用方读取的记录修订版本和持久化 mutation id。陈旧修订版本以 `MCP_CONNECTION_CONFLICT` 拒绝；完全相同的 mutation id 回放返回原始收据且不再次写入，把该 id 用于不同请求字段则以 `MCP_CONNECTION_IDEMPOTENCY_MISMATCH` 拒绝。

## 描述符校验

`parseMcpConnectionDesired()` 和 `parseMcpTransportDescriptor()` 接受字段严格的 JSON 对象，拒绝未知键，并返回递归冻结的值。描述符必须完全解析：超时、重连和 Streamable HTTP redirect 字段为必填项，执行阶段不会再补默认值。工具调用超时与重连延迟都必须是正整数且不超过 Node 的 2,147,483,647 ms 定时器上限；本地 provider 会在持久化前重新校验完整 configure 与 update descriptor。Stdio 命令和参数不经过 shell；Streamable HTTP 端点必须使用 HTTP 或 HTTPS，并明确携带 `error`、`follow` 或 `manual` Fetch 重定向策略。

## 事件

`mcp-connections/change` 在期望状态提交后，或提供方发布观测／工具 generation 后触发。消费方通过 `get()` 或 `snapshot()` 重新读取；`removed` 变更在触发时已经不在活动清单中，`purged` 变更在活动与已移除清单中都不存在。

## 模型体验

### 托管连接状态

#### 模型看到的内容

没有直接内容。该包不注册提示词、工具或消息；已启用的提供方把发现的 MCP 工具 schema 和结果委托给 `@deepseek-ai/dsh-mcp-client`。

#### Token 影响

直接 token 影响为零。动态挂载的 MCP 客户端负责由数据决定的 schema 和结果成本。

#### KV Cache 影响

该包不改变模型请求。MCP 工具新增、移除或 schema 变化可能从挂载的 MCP 客户端中首个变化的工具定义开始使复用失效。

## 已知限制与延后工作

- **重连内部状态由提供方负责** — Service Definition 会区分生命周期观测和工具 generation，但不能要求一种传输特定的退避词汇。
- **描述符值可能包含秘密** — 协议消费方必须对 `env` 和 `headers` 做脱敏；该 API 尚未定义凭据引用描述符值。
