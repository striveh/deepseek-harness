# @deepseek-ai/dsh-profile-transactions

English | [中文](README.zh.md)

Service Definition for complete Profile generation transactions on `ctx.profileTransactions`. The CLI bootstrap Consumer resolves the active generation before the main Loader exists, while the `dsh-base` runtime Provider exposes the same owner to the Extension Center for changes that take effect after restart.

Dynamic Consumers require both `instanceof ProfileTransactions` and the literal `protocolVersion === 1`; a same-name service or another protocol revision is not compatible.

## Operations

- `snapshot(profile)` is read-only and returns the monotonic revision, complete effective-tree digest, effective path, active/last-good/rollback ids, and boot status.
- `stage(request)` durably binds the caller's `mutationId` to one exact mutation, applies it to a complete isolated Profile, and returns only after the Provider-owned real Loader validator accepts the unchanged candidate. An exact replay returns the same generation; different input under that id fails.
- `commit(request)` publishes a staged generation under revision and complete-tree compare-and-swap fences; the receipt requires restart.
- `abort(request)` removes only a generation that no authoritative pointer names.
- `restoreLastGood(request)` durably binds its own `mutationId`, publishes the appropriate verified recovery generation, and returns the same receipt after retry or crash recovery; activation requires restart.
- `getRestoreReceipt(request)` resolves that exact terminal restore by Profile and `mutationId`; it completes an already durable journal before returning the original before/after snapshots and never selects a new target.
- `acknowledgeBoot(request)` promotes the active generation to last-good only after the real app Loader booted that exact revision and tree digest.
- `list(profile)` reports the snapshot plus complete staged and recoverable generations without writing.

`ExactProfileMutation` is a closed P0 union: exact local `.tgz` install/update, installed-package uninstall, or installed-package-owned `cordis.patch.yml` replacement. Configure carries the current content digest, fully normalized next UTF-8 bytes, and next digest; the transaction owner never parses or edits YAML on an adapter's behalf.

`ProfileRevisionConflictError`, `ProfileTreeConflictError`, `ProfileContentConflictError`, and `ProfileMutationConflictError` distinguish a competing publication, an external effective-tree edit, stale patch bytes, and caller-key reuse with different immutable input. All cross-package ids and digests are branded and constructed through the exported validators.

The transaction owns mutation, validation admission, publication, boot acknowledgement, and recovery. Discovery, download, trust policy, human approval, typed configuration adapters, restart orchestration, and original-task continuation remain Consumers' responsibilities. Validation executes already-admitted candidate code; the CLI minimizes inherited credentials but does not provide a filesystem or network sandbox.

Design and recovery rationale: [Profile generation transactions](../../../.agents/notes/implemented/architecture/2026-08-25-profile-generation-transactions.md). Type and service reference: [Profile generation transactions](../../../docs/subsystems/profile-transactions.md).

## Model Experience

### Profile lifecycle state

#### What the model sees

Nothing. `ctx.profileTransactions` registers no prompt, message, tool schema, stream content, or tool result.

#### Token effect

Zero live-request tokens.

#### KV Cache effect

None; Profile lifecycle state never enters a model request prefix.

## Known Limitations and Deferred Work

- P0 accepts one mutation per generation and complete `.tgz` artifacts without regular/optional/bundled dependencies, lifecycle installation scripts, or `bin` entries.
- The product CLI's isolated activation validator currently admits Web Profiles only.
- Candidate validation has the host user's filesystem and network authority after ambient environment minimization.
- Superseded generation retention and multi-package graph transactions are deferred.
