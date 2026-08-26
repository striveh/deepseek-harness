# Agent Note: Managed MCP tool ownership uses Fiber provenance

Status: implemented

English | [中文](2026-08-25-managed-mcp-tool-provenance.zh.md)

## Problem

`mcp__<connectionId>__` is a public-name qualifier, not evidence that `mcp-connections-local` owns a ToolRuntime registration. Computing a managed record's tool generation from every schema with that prefix lets a sibling plugin appear in the record, keeps a disabled record apparently populated, and makes later teardown claims depend on names rather than the disposer that created each registration. The `mcp-client` exact-name collision check also permits a different foreign tool under the same server prefix, so a new desired record could commit before the namespace conflict became visible.

## Decision

Each managed activation creates a private `tools` service isolation and mounts the existing `mcp-client` below its owner Fiber. The isolated service delegates `register()` to the shared ToolRuntime through the calling child context, preserving ToolRuntime validation, global model visibility, and effect-scoped cleanup. It also retains the exact `ToolDefinition` identity for every registration made through that owner Fiber and removes the identity before the delegated disposer unregisters the tool.

Tool-generation refresh requires three facts at once: the record has a live owner Fiber, that Fiber recorded the tool name and definition, and the shared ToolRuntime still resolves the name to the same definition object. The generation schema comes from ToolRuntime only after these ownership checks. Prefix equality remains a naming fact and is never used as registration provenance.

`configure`, `enable`, and enabled `restore` check the context-global ToolRuntime namespace after durable idempotency detection and the pure desired-state transform, but before the mutation writes its state, last-good, or journal entry. They also acquire the app-root reservation enforced by `mcp-client`, so a direct client with the same `serverName` rejects the mutation even when it has no tools. The manager lends the opaque token to its child and retains it through commit, activation, update replacement, and failed cleanup. An existing owner rejects the new mutation without changing desired state; exact replay returns its original receipt without revalidating the already-owned namespace.

Every public mutation synchronously clones and recursively freezes caller input before serialized mutation work begins. Queued or post-commit caller mutation therefore cannot change the durable request digest, target, CAS revision, in-memory desired state, or later reconciliation without another revisioned operation.

Disable and remove dispose the record's owner Fiber and await its child `mcp-client`. Once that owner is absent, refresh publishes an empty active generation regardless of same-prefix foreign registrations. Teardown invokes only the effect disposers created through the owner Fiber; it neither removes nor attributes foreign tools.

If owner-Fiber disposal rejects after releasing its registrations, reconciliation retains an `error` observation for that desired revision instead of immediately overwriting it with `disabled`. A later desired mutation advances the revision and may publish the resulting lifecycle state.

## Alternatives considered

**Keep prefix-filtering `ctx.tools.schemas()`.** Rejected because a stable public name does not identify which Fiber registered it, and a disabled or removed owner has no registration that could justify attribution.

**Copy MCP discovery and registration into the manager.** Rejected because the existing `mcp-client` already owns protocol synchronization, reconnect, two-phase replacement, and quiescent teardown. Duplicating that implementation would create two lifecycle authorities.

**Add manager-specific ownership fields to ToolRuntime.** Rejected because the manager needs only an exact registration set for one child Fiber. A private isolated service supplies that fact without expanding the shared tool API or changing unrelated tool providers.

## Verification

The package's real `mcp-client` composition test mounts unmanaged tools from sibling Cordis Fibers. It proves that an occupied same-server prefix rejects configure without changing revision zero on a cold reopen, a foreign tool added beside a live managed client is absent from its generation, an exact-name foreign replacement after disable leaves the disabled generation empty, and remove leaves both foreign registrations live. Caller-alias tests mutate nested configure and update values, plus the scalar target of every other lifecycle request, while queued and after commit without changing the request digest, selected record, receipt, or committed authority. Canonical digests retain own `__proto__` environment and header keys, so checksum validation and idempotency distinguish their values. Durable-state tests replay every per-id receipt, reject operations from the wrong lifecycle location, and reject final inventory records whose revision, desired digest, or removal revision does not match that history. A current-first crash window is followed by last-good reconciliation before journal repair, and later current corruption still restores the latest committed receipt. Injected Error and non-Error disposal failures prove that managed tools disappear while the current revision retains its diagnostic. Existing stdio, Streamable HTTP, update, restore, cold-resume, startup-error, quiescent-remove, durability, and recovery cases continue through the same composed provider.

## Consequences

Each live managed connection owns one additional Fiber, isolated service facade, and app-root `mcp-client` reservation. The facade intentionally implements the `register()` operation used by the current `mcp-client`; a future client dependency on another ToolRuntime method requires an explicit delegation decision. Ownership identities and reservation tokens are process-local observations and do not enter the durable desired-state format. A foreign ToolRuntime registration created after pre-commit validation may coexist under the prefix, but it cannot enter the record's generation or be removed by the record's teardown.
