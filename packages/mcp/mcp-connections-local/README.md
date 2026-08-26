# @deepseek-ai/dsh-mcp-connections-local

English | [中文](README.zh.md)

Local Service Provider for `ctx.mcpConnections`. It stores checksummed desired state under the Harness home and mounts one existing `@deepseek-ai/dsh-mcp-client` fiber for each enabled record, preserving that plugin's reconnect, two-phase tool replacement, namespace ownership, and quiescent disposal behavior. Every provider instance exposes the Service Definition's exact `protocolVersion: 1`.

## Config

| Field | Required | Description |
|---|---|---|
| `path` | no | Desired-state file; an explicit path overrides `dshHome` |
| `dshHome` | no | Harness home used when `path` is omitted; resolution follows `$DSH_HOME` and `~/.dsh` |
| `lockWaitMs` | no | SQLite writer-reservation wait in milliseconds; default `10000`, range `0` through `2147483647` |

The default file is `<dshHome>/mcp/connections.json`. The state file, last-good copy, journal, SQLite coordinator, and corruption evidence are protected by the owner-only parent directory.

## Durability and recovery

Each mutation first takes a process-local asynchronous mutex for the canonical state path and then a SQLite `BEGIN IMMEDIATE` cross-process reservation. The local mutex prevents SQLite's synchronous busy wait from blocking an in-process writer that is awaiting filesystem work; the operating system releases the SQLite reservation when a writer process dies, so the next Host can repair a crash window without deleting an orphan pathname lock. The writer re-reads the checksummed state, applies record CAS and durable idempotency, writes each replacement to an exclusive sibling, fsyncs its contents, renames it over the target, and fsyncs the parent directory on platforms where Node exposes directory handles. Directory setup walks from the filesystem root and fsyncs every component's parent after both creation and `EEXIST`, so a competing creator cannot expose an authority path before its entry is durable. Journal appends are followed by file and parent-directory fsync before success. The journal chains SHA-256 entry digests and records exact validated mutation receipts without transport secrets. Purge accepts only a removed record at the caller's exact revision and retains its receipt for exact replay after the tombstone is gone.

On a pristine home with no state, last-good, or journal, boot begins from an empty inventory without writing authority files. Once a journal proves prior durable authority, losing both current and last-good files fails startup instead of inventing empty state. A corrupt current state is preserved with the same durable replacement protocol as content-addressed evidence and restored from the validated last-good copy. When current state is valid, a missing, corrupt, or stale last-good copy is reconciled to it before journal repair; corrupt backup bytes remain as content-addressed evidence. A truncated or corrupt journal suffix is preserved, removed from the active journal, and followed by a recovery entry binding the journal head to the authoritative state. State and journal admission reject unknown fields, invalid identifiers or digests, impossible receipt revision relationships, and mutation histories whose global snapshot revisions are not contiguous through the authoritative revision. Admission also replays each connection's abstract configure/active/remove/restore/purge lifecycle and requires the final active and removed inventories to match its exact location, record revision, desired digest, and removal revision.

Every public mutation (`configure`, `enable`, `disable`, `update`, `remove`, `restore`, and `purge`) synchronously clones and recursively freezes caller input before entering the serialized mutation queue. Configure and update also parse the complete descriptor before any durable write. Caller changes after method invocation cannot alter the queued request digest, target, CAS revision, or committed authority without a new mutation.

## Runtime reconciliation

An enabled record mounts the public `mcp-client` plugin entry with strict startup failure. Activation publishes `connecting`, then either `ready` with the actual tool generation or `error` while retaining desired enabled state. Disable, update, remove, provider disposal, and cold recovery await the record's managed Fiber disposal before completing their runtime reconciliation.

If managed Fiber disposal rejects, the provider retains the live ownership reference, republishes the tools that are still actually registered, marks the record `error`, and rejects the lifecycle operation. An exact mutation replay retries that cleanup before any replacement activation. A startup failure whose cleanup also rejects propagates both errors instead of reporting an empty generation, and provider disposal attempts every live Fiber before aggregating failures; only a resolved Fiber disposal clears its live ownership and publishes an empty-tool projection.

Each activation gives `mcp-client` an isolated `tools` service that delegates to the shared ToolRuntime while retaining the exact `ToolDefinition` identities registered by that managed Fiber. A tool enters the record's generation only while the Fiber is live and the shared registry still resolves the name to that exact definition; a matching `mcp__<connectionId>__` prefix alone never establishes ownership. Schema changes with stable names still advance the generation digest. Desired revision, Host generation, and tool generation remain separate in every view.

Before `configure`, `enable`, or an enabled `restore` writes desired state, the provider rejects any existing context-global tool in its `mcp__<connectionId>__` namespace and atomically acquires the same app-root server-name reservation used by direct `mcp-client` instances, including clients with zero tools. The provider holds that reservation through durable commit, activation, update replacement, and failed cleanup, and releases it only after the managed Fiber reaches quiescence. Exact idempotent replay is resolved before this pre-commit validation. Foreign ToolRuntime registrations added later are not reported by the record, and disable or remove disposes only the managed Fiber's registrations.

## Model Experience

### Dynamically managed MCP tools

#### What the model sees

After an enabled connection reaches `ready`, the existing MCP client exposes the server's tools under `mcp__<connectionId>__<rawName>` with server-provided descriptions and input schemas. Disable or remove unregisters that managed Fiber's tools before the lifecycle operation returns; same-prefix foreign tools remain registered and never appear in the record's tool generation.

#### Token effect

Each ready connection adds the data-dependent MCP tool schemas to every request. Updates replace the prior generation; disable and remove reduce subsequent requests by the removed schemas.

#### KV Cache effect

Prefix-stable while the ready tool generation is unchanged. A changed, added, or removed schema may invalidate reuse from the first changed tool definition; a recovered identical generation preserves the same definitions.

## Known Limitations and Deferred Work

- **Reconnect backoff is not directly observable** — `mcp-client` exposes startup and disposal completion but no public reconnect-state event, so this provider reports manager lifecycle and actual tool generations without inventing attempt counters.
- **External state edits are not watched live** — another process is reconciled on the next mutation or Host restart; every writer still receives CAS protection under the shared lock.
- **Environment and header values are stored literally** — files are owner-only and journal entries omit values, but credential-reference resolution is deferred.
