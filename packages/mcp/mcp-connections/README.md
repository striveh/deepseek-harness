# @deepseek-ai/dsh-mcp-connections

English | [中文](README.zh.md)

Service Definition for `ctx.mcpConnections`, the revisioned desired-state owner for dynamically managed MCP connections. A Service Provider persists records and reconciles enabled records with live MCP clients; inventory, RPC, and product plugins remain consumers of this API. `McpConnections.protocolVersion` is the literal `1`; a same-process consumer pairs class identity with this exact revision before relying on the API.

## State model

Each active view keeps three independently revisioned facts: `desired` is the durable configuration and enabled state, `observed` is the current Host lifecycle phase, and `tools` is the actual server-qualified tool-schema generation. A desired revision never proves a connection is ready, and a ready observation never substitutes for the current tool generation.

Removed records leave the active inventory and retain their complete prior desired state under `snapshot().removed`. `restore()` moves that record back and reconciles its retained enabled state; `purge()` permanently deletes only an exact removed record and never changes a live runtime.

## Operations

| Method | Durable effect | Runtime completion |
|---|---|---|
| `configure` | Creates revision 1 from a complete stdio or Streamable HTTP descriptor | Activates when `enabled` |
| `enable` | Sets the desired enabled flag | Waits for initial connection and tool discovery |
| `disable` | Clears the desired enabled flag | Waits for the live client to dispose and tools to disappear |
| `update` | Replaces the complete resolved transport | Replaces an enabled live client |
| `remove` | Moves the record to the removed inventory | Waits for teardown to reach quiescence |
| `restore` | Moves the removed record back to active inventory | Reconciles the retained enabled state |
| `purge` | Permanently deletes an exact removed record | No live runtime exists |

Every mutation carries the record revision the caller read and a durable mutation id. A stale revision rejects with `MCP_CONNECTION_CONFLICT`; an exact mutation-id replay returns the original receipt without another write, while reuse for different request fields rejects with `MCP_CONNECTION_IDEMPOTENCY_MISMATCH`.

## Descriptor validation

`parseMcpConnectionDesired()` and `parseMcpTransportDescriptor()` accept exact JSON objects, reject unknown keys, and return recursively frozen values. Descriptors are fully resolved: timeout, reconnect, and Streamable HTTP redirect fields are mandatory rather than defaulted inside execution. Tool-call timeouts and reconnect delays are positive integers no greater than Node's 2,147,483,647 ms timer limit, and the local provider revalidates complete configure and update descriptors before persistence. Stdio commands and arguments bypass a shell; Streamable HTTP endpoints must use HTTP or HTTPS and carry an explicit `error`, `follow`, or `manual` Fetch redirect policy.

## Events

`mcp-connections/change` fires after desired state commits or after the provider publishes an observed/tool generation. Consumers refetch through `get()` or `snapshot()`; a `removed` change is already absent from the active inventory, and a `purged` change is absent from both active and removed inventories.

## Model Experience

### Managed connection state

#### What the model sees

Nothing directly. This package registers no prompt, tool, or message; an enabled provider delegates discovered MCP tool schemas and results to `@deepseek-ai/dsh-mcp-client`.

#### Token effect

Zero direct token effect. The dynamically mounted MCP client owns the data-dependent schema and result cost.

#### KV Cache effect

This package does not change model requests. MCP tool additions, removals, or schema changes may invalidate reuse from the first changed tool definition under the mounted MCP client.

## Known Limitations and Deferred Work

- **Reconnect internals are provider-owned** — the Service Definition separates lifecycle observation from tool generations but cannot require one transport-specific backoff vocabulary.
- **Descriptor values may contain secrets** — wire consumers must redact `env` and `headers`; a credential-reference descriptor value is not yet part of this API.
