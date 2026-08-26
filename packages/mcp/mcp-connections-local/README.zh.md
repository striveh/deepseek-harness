# @deepseek-ai/dsh-mcp-connections-local

[English](README.md) | 中文

`ctx.mcpConnections` 的本地 Service Provider。它在 Harness home 下存储带校验和的期望状态，并为每个已启用记录挂载一个既有 `@deepseek-ai/dsh-mcp-client` fiber，从而保留该插件的重连、两阶段工具替换、命名空间所有权和完全停稳的 dispose 行为。每个提供方实例都公开 Service Definition 的准确 `protocolVersion: 1`。

## 配置

| 字段 | 必填 | 说明 |
|---|---|---|
| `path` | 否 | 期望状态文件；显式路径覆盖 `dshHome` |
| `dshHome` | 否 | 省略 `path` 时使用的 Harness home；解析遵循 `$DSH_HOME` 和 `~/.dsh` |
| `lockWaitMs` | 否 | SQLite writer reservation 的等待毫秒数；默认 `10000`，范围为 `0` 至 `2147483647` |

默认文件是 `<dshHome>/mcp/connections.json`。状态文件、last-good 副本、journal、SQLite coordinator 与损坏证据由仅所有者可访问的父目录保护。

## 持久性与恢复

每次变更先为 canonical state 路径取得进程内异步 mutex，再取得 SQLite `BEGIN IMMEDIATE` 跨进程 reservation。进程内 mutex 防止 SQLite 的同步 busy wait 阻塞正在等待文件系统操作的同进程 writer；writer 进程死亡时，操作系统会释放 SQLite reservation，因此下一 Host 无需删除孤儿 pathname lock 就能修复 crash window。writer 会重新读取带校验和的状态，应用记录 CAS 和持久化幂等，把每个替换内容写入独占 sibling，fsync 内容后 rename 覆盖目标，并在 Node 能公开目录 handle 的平台 fsync 父目录。目录 setup 会从 filesystem root 开始遍历，并在创建以及观察到 `EEXIST` 后 fsync 每个 component 的 parent，因此竞态 creator 不能在 authority path entry durable 前暴露它。Journal append 在成功前也会依次 fsync 文件与父目录。journal 以 SHA-256 条目摘要串联，并记录不含传输秘密且经过准确校验的变更收据。Purge 只接受调用方所读准确 revision 的已移除记录，并在 tombstone 消失后仍保留收据以支持准确回放。

全新 home 在 state、last-good 和 journal 都不存在时，会从空清单启动且不写 authority 文件。一旦 journal 证明曾有持久权威状态，同时丢失 current 与 last-good 文件就会让启动失败，而不是凭空生成空状态。损坏的当前状态会使用同一持久替换协议保留为按内容寻址的证据，并从校验通过的 last-good 副本恢复。当前状态有效时，缺失、损坏或落后的 last-good 副本会在 journal 修复前与其对齐；损坏的备份 bytes 仍保留为按内容寻址的证据。截断或损坏的 journal 后缀会被保留并从活动 journal 中移除，随后追加恢复条目，把 journal head 绑定到权威状态。State 与 journal admission 会拒绝未知字段、无效标识符或摘要、不可能的收据 revision 关系，以及 global snapshot revision 未连续推进至权威 revision 的变更历史。Admission 还会按 connection 重放抽象的 configure/active/remove/restore/purge lifecycle，并要求最终 active 与 removed inventory 的位置、record revision、desired digest 和 removal revision 全部精确匹配。

每项公共变更（`configure`、`enable`、`disable`、`update`、`remove`、`restore` 和 `purge`）都会在进入串行变更队列前同步克隆并递归冻结调用方输入。Configure 与 update 还会在任何持久写入前解析完整 descriptor。方法调用后的外部修改无法在没有新变更的情况下改变排队请求的摘要、目标、CAS revision 或已提交权威状态。

## 运行时对齐

已启用记录以严格启动失败模式挂载公开 `mcp-client` 插件入口。激活先发布 `connecting`，随后发布带实际工具 generation 的 `ready`，或在保留期望启用状态的同时发布 `error`。禁用、更新、移除、提供方 dispose 和冷恢复都会等待该记录的受管 Fiber 完成 dispose 后再完成其运行时对齐。

如果受管 Fiber 的 dispose 拒绝，提供方会保留 live ownership 引用，重新投影仍实际注册的工具，把记录标为 `error`，并让生命周期操作失败。相同变更的精确重放会先重试这项清理，再进行任何替代激活。如果启动主失败后的清理也拒绝，提供方会传播两项错误，而不会虚报空 generation；提供方 dispose 会尝试所有 live Fiber 后再聚合失败，并且只有已完成的 Fiber dispose 才会清除其 live ownership 并发布空工具投影。

每次激活都会为 `mcp-client` 提供一个隔离的 `tools` service；该 service 把注册委托给共享 ToolRuntime，同时保留这个受管 Fiber 注册的确切 `ToolDefinition` identity。只有当 Fiber 仍存活，且共享 registry 仍把名称解析到该确切 definition 时，工具才会进入记录的 generation；仅匹配 `mcp__<connectionId>__` 前缀不能建立归属。名称不变的 schema 变化仍会推进 generation 摘要。每个视图中的期望状态修订版本、Host generation 和工具 generation 始终分离。

在 `configure`、`enable` 或已启用的 `restore` 写入期望状态前，provider 会拒绝其 `mcp__<connectionId>__` namespace 中任何已有的 context-global 工具，并原子取得 direct `mcp-client` 实例使用的同一 app-root server-name reservation，包括零工具 client。provider 会跨持久提交、activation、update replacement 与失败 cleanup 持有该 reservation，并且只在受管 Fiber 完全停稳后释放。精确幂等重放会在这项提交前校验之前解析。之后新增的 foreign ToolRuntime 注册不会被该记录报告，禁用或移除也只会 dispose 受管 Fiber 的注册。

## 模型体验

### 动态管理的 MCP 工具

#### 模型看到的内容

已启用连接到达 `ready` 后，既有 MCP 客户端以 `mcp__<connectionId>__<rawName>` 暴露服务器工具，并使用服务器提供的描述和输入 schema。禁用或移除会在生命周期操作返回前注销该受管 Fiber 的工具；相同前缀的 foreign 工具会保持注册，也绝不会出现在该记录的工具 generation 中。

#### Token 影响

每个就绪连接都会向每次请求加入由数据决定的 MCP 工具 schema。更新会替换上一 generation；禁用和移除会从后续请求中减去已移除 schema。

#### KV Cache 影响

就绪工具 generation 不变时前缀稳定。schema 的变化、新增或移除可能从首个变化的工具定义开始使复用失效；恢复出的相同 generation 会保留相同定义。

## 已知限制与延后工作

- **无法直接观测重连退避** — `mcp-client` 暴露启动和 dispose 完成状态，但没有公开的重连状态事件，因此该提供方报告管理器生命周期和实际工具 generation，不虚构尝试计数。
- **不会实时监视外部状态编辑** — 其他进程的变更会在下次操作或 Host 重启时对齐；每个写入方仍在共享锁下获得 CAS 保护。
- **环境和请求头值以字面量存储** — 文件仅所有者可访问，journal 条目不包含值，但凭据引用解析仍为延后工作。
