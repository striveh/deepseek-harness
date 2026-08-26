# Task Continuation

English | [中文](task-continuation.zh.md)

The task-continuation seam parks one exact original-task claim while a separately approved capability operation completes. [`dsh-task-continuation`](../../packages/continuation/task-continuation) publishes `ctx.taskContinuations` and its verifier registry; [`dsh-task-continuation-driver`](../../packages/continuation/task-continuation-driver) stores claims in SQLite and recovers them across Host restarts.

## Claim and verification

A claim binds a caller idempotency key, the Session, original direct-user message, derived-need digest, task revision, restricted cold-resume route, verifier id, verification-payload digest, expiry, and a provider-created continuation and dispatch identity. The route contains only provider and model identifiers bounded to 256 UTF-8 bytes and optional `maxTokens` bounded to 1,000,000. Creation queues a model-visible marker without waking a turn and flushes the Session. `reserve()` can recreate or recover that exact claim from only durable references after Host restart. The extension that completed the operation registers the named verifier. Only an exact positive echo of every bound identity and digest can move the claim toward dispatch; missing, stale, expired, canceled, superseded, or negative verification produces no Agent turn. Consumers require class identity and `protocolVersion === 1`.

## Durable admission

The version-4 driver serializes claim transitions in SQLite and rejects any state whose fixed record revision is unreachable. It resumes the exact persisted Session when needed and claims the Agent's idle maintenance phase before verification. `consumed` is recoverable dispatch intent. Before wake, one Host acquires a renewable owner/incarnation lease; it renews that lease while downstream pre-step listeners run, rechecks expiry and every record fence after they return, and commits an owner-fenced `consumed` to `claimed` transition with `synchronous=FULL` before AgentLoop may invoke the model. This is at-most-once: a crash before the barrier permits takeover after lease expiry, while a crash after it may leave no continuation event or request and recovery never redelivers. Before verification, consumption, dispatch, and barrier commit, the replacement fence scans committed Session events, the current claimed batch, and both pending inbox queues; any newer direct-user message atomically supersedes the old task and produces zero continuation request. Public cancellation and supersession win only while a claim is `pending` or `ready`; the internal replacement fence can still supersede `consumed` before the barrier. One earliest-due timer discovers a database or mutation from another Host, expires parked claims, revisits lease deadlines, and retries transient recovery faults without an external event. A provider-owned cold Agent remains registered while the Session has any active claim and is disposed after the last one becomes terminal; caller-owned live Agents are untouched. Provider teardown aborts stalled cold creation before publication and attempts every owned cleanup.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtaskcontinuations--taskcontinuationservice-abstract-seam"></a>

### `ctx.taskContinuations` — `TaskContinuationService` (abstract seam)

Service API for durable, verifier-gated continuation claims.

```ts cordis-catalog
/**
 * Park one continuation for an exact live Agent without waking a turn.
 * @param agent - exact live Agent whose session owns the task.
 * @param request - task, need, verifier, payload-digest, and expiry fences.
 * @returns the durably created pending claim.
 */
abstract create(agent: Agent, request: CreateTaskContinuationRequest): Promise<TaskContinuationClaim>

/**
 * Idempotently create or recover one caller-owned reservation without requiring a live Agent object.
 * @param request - caller key, Session/task fences, verifier payload, expiry, and restricted resume route.
 * @returns the one durable claim bound to the caller key.
 */
abstract reserve(request: ReserveTaskContinuationRequest): Promise<TaskContinuationClaim>

/**
 * Read one claim by stable identity.
 * @param id - continuation identity to read.
 * @returns the immutable durable view, or `undefined` when absent.
 */
abstract get(id: ContinuationId): Promise<TaskContinuationClaim | undefined>

/**
 * List claims, optionally restricted to one exact session.
 * @param request - optional management filter.
 * @returns immutable views in deterministic creation order.
 */
abstract list(request?: ListTaskContinuationsRequest): Promise<readonly TaskContinuationClaim[]>

/**
 * Make one exact pending or ready claim permanently canceled.
 * @param ref - continuation, session, and task-revision fence.
 * @returns whether this call won before the claim reached consumed dispatch intent.
 */
abstract cancel(ref: TaskContinuationRef): Promise<boolean>

/**
 * Make one exact pending or ready claim terminal in favor of a newer task revision.
 * @param request - old exact fence and replacement revision.
 * @returns whether this call won before the claim reached consumed dispatch intent.
 */
abstract supersede(request: SupersedeTaskContinuationRequest): Promise<boolean>

/**
 * Register an extension-owned verifier under an effect-scoped identity.
 * @param verifier - non-mutating evidence verifier.
 * @returns the exact single-use registration disposer.
 */
registerVerifier(verifier: TaskContinuationVerifier): () => void
```

Types: [Agent](core.md)

Source: [`packages/continuation/task-continuation/src/index.ts`](../../packages/continuation/task-continuation/src/index.ts)
<!-- END GENERATED cordis-surface -->
