# Agent Note: 受管 MCP 工具所有权使用 Fiber 来源

Status: implemented

[English](2026-08-25-managed-mcp-tool-provenance.md) | 中文

## Problem

`mcp__<connectionId>__` 是公开名称限定符，不是 `mcp-connections-local` 拥有某项 ToolRuntime 注册的证据。按该前缀下的全部 schema 计算受管记录的工具 generation，会让 sibling plugin 出现在该记录中，让已禁用记录看起来仍有工具，也会使后续 teardown 保证依赖名称，而不是创建每项注册的 disposer。`mcp-client` 的精确名称 collision 检查还允许同一服务器前缀下存在另一个名称不同的 foreign 工具，因此新的期望记录可能先完成提交，之后才显现 namespace 冲突。

## Decision

每次受管激活都会创建一个私有 `tools` service isolation，并在其 owner Fiber 之下挂载既有 `mcp-client`。隔离 service 通过调用方 child context 把 `register()` 委托给共享 ToolRuntime，从而保留 ToolRuntime 校验、全局模型可见性和 effect-scoped cleanup。它还会保留经由该 owner Fiber 创建的每项注册的确切 `ToolDefinition` identity，并在委托 disposer 注销工具前移除这项 identity。

工具 generation 刷新必须同时满足三项事实：记录有存活的 owner Fiber、该 Fiber 记录了工具名称与 definition，并且共享 ToolRuntime 仍把该名称解析到同一个 definition 对象。只有通过这些 ownership 检查后，generation schema 才取自 ToolRuntime。前缀相等仍只是一项命名事实，绝不作为注册来源。

`configure`、`enable` 与已启用的 `restore` 会先完成持久幂等检测和纯期望状态转换，再检查 context-global ToolRuntime namespace，并且检查发生在该 mutation 写入 state、last-good 或 journal entry 之前。它们还会取得由 `mcp-client` 强制执行的 app-root reservation，因此同 `serverName` 的 direct client 即使没有工具也会拒绝该 mutation。manager 会把 opaque token 借给 child，并跨 commit、activation、update replacement 与失败 cleanup 持有它。既有 owner 会在不改变期望状态的情况下拒绝新 mutation；精确重放会直接返回原 receipt，不会重新校验已经归属的 namespace。

每项公共 mutation 都会在串行工作开始前同步克隆并递归冻结调用方输入。因此，无论调用方在排队期间还是提交后修改对象，都不能在没有另一项带 revision 操作的情况下改变持久请求摘要、目标、CAS revision、内存期望状态或后续运行时对齐。

禁用和移除会 dispose 记录的 owner Fiber，并等待其 child `mcp-client`。owner 不存在后，无论相同前缀下是否有 foreign 注册，刷新都会为活动记录发布空 generation。Teardown 只调用经由 owner Fiber 创建的 effect disposer；它既不会移除 foreign 工具，也不会把它们归属于该记录。

如果 owner Fiber 在释放其注册后于 dispose 阶段拒绝，运行时对齐会为该期望状态 revision 保留 `error` observation，而不会立即用 `disabled` 覆盖。后续期望状态 mutation 会推进 revision，并可发布相应生命周期状态。

## Alternatives considered

**继续按前缀过滤 `ctx.tools.schemas()`。** 不采用，因为稳定的公开名称不能标识注册它的 Fiber，而已禁用或已移除 owner 没有任何注册可以支撑归属判断。

**在 manager 中复制 MCP discovery 与 registration。** 不采用，因为既有 `mcp-client` 已经负责协议同步、重连、两阶段替换和完全停稳的 teardown。复制这套实现会产生两个生命周期 authority。

**向 ToolRuntime 增加 manager 专用 ownership 字段。** 不采用，因为 manager 只需要一个 child Fiber 的确切注册集合。私有隔离 service 可以提供这项事实，无需扩展共享工具 API，也无需改变无关工具 provider。

## Verification

该 package 的真实 `mcp-client` composition 测试会从 sibling Cordis Fiber 挂载 unmanaged 工具。测试证明：被占用的同服务器前缀会拒绝 configure，冷启动重开时 revision zero 仍不变；在存活受管 client 旁新增的 foreign 工具不会进入其 generation；禁用后由 foreign 工具占用相同精确名称，已禁用 generation 仍为空；remove 会让两项 foreign 注册继续存活。调用方 alias 测试会在排队期间与提交后修改嵌套 configure/update 值和其他每项生命周期请求的标量目标，并证明请求摘要、所选记录、receipt 和已提交权威状态不变。canonical digest 会保留自有 `__proto__` environment 与 header key，因此 checksum validation 和幂等会区分其值。持久状态测试会重放每个 id 的全部 receipt，拒绝从错误 lifecycle location 执行的操作，并拒绝 revision、desired digest 或 removal revision 与历史不匹配的最终 inventory record。current-first 崩溃窗口之后会先对齐 last-good，再修复 journal；以后 current 损坏时仍能恢复最新的已提交 receipt。注入的 Error 与非 Error dispose 故障证明受管工具会消失，同时当前 revision 保留诊断。现有 stdio、Streamable HTTP、update、restore、cold-resume、startup-error、quiescent-remove、durability 与 recovery 用例继续通过同一个组装后的 provider。

## Consequences

每个存活的受管连接会多拥有一个 Fiber、隔离 service facade 与 app-root `mcp-client` reservation。该 facade 有意只实现当前 `mcp-client` 使用的 `register()` 操作；未来 client 若依赖另一项 ToolRuntime method，需要作出显式 delegation 决策。Ownership identity 与 reservation token 都是进程内 observation，不进入持久期望状态格式。提交前校验完成后创建的 foreign ToolRuntime 注册可以在该前缀下共存，但不能进入记录的 generation，也不会被记录的 teardown 移除。
