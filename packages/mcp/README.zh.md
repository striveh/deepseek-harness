# MCP — 模型上下文协议

[English](README.md) | 中文

将 harness 与 MCP 生态系统桥接的包。

| 包 | 职责 |
|---|---|
| [`mcp-client/`](mcp-client/README.zh.md) | MCP 客户端桥接，将外部服务器工具注册到 `ctx.tools` |
| [`mcp-connections/`](mcp-connections/README.zh.md) | 受管连接期望状态与运行时证据的 revision 化 Service Definition |
| [`mcp-connections-local/`](mcp-connections-local/README.zh.md) | 持久化本地 provider，负责动态 `mcp-client` Fiber 与静默完成的生命周期变更 |
