# 任务续跑

[English](task-continuation.md) | 中文

task-continuation seam 会在一个经独立批准的能力操作完成期间停放准确的原任务 claim。[`dsh-task-continuation`](../../packages/continuation/task-continuation) 发布 `ctx.taskContinuations` 及其 verifier registry；[`dsh-task-continuation-driver`](../../packages/continuation/task-continuation-driver) 把 claim 保存在 SQLite 中，并跨 Host 重启恢复。

## Claim 与 verification

claim 绑定调用方幂等 key、Session、原始 direct-user message、derived-need digest、task revision、受限冷恢复 route、verifier id、verification-payload digest、expiry，以及 provider 创建的 continuation 与 dispatch identity。route 只包含最多 256 UTF-8 byte 的 provider 与 model identifier，以及上限为 1,000,000 的可选 `maxTokens`。创建会排入一个模型可见 marker，但不会唤醒 turn，并会 flush Session。`reserve()` 可以在 Host 重启后仅凭持久 reference 重建或恢复该准确 claim。完成操作的扩展注册具名 verifier。只有准确回显每个绑定 identity 与 digest 的正向结果，才能推动 claim 进入 dispatch；缺失、过期、已到期、已取消、已替换或负向 verification 都不会产生 Agent turn。Consumer 必须检查类 identity 与 `protocolVersion === 1`。

## 持久化准入

版本 4 driver 在 SQLite 中串行化 claim transition，并拒绝 state 与固定 record revision 不可达的记录。它会按需恢复准确的持久化 Session，并在 verification 前占用 Agent 的 idle maintenance phase。`consumed` 是可恢复的 dispatch intent。wake 前只有一个 Host 能取得可续租的 owner/incarnation lease；downstream pre-step listener 运行时会持续续租，返回后重新检查 expiry 与全部 record fence，并在 AgentLoop 可能调用模型前，以 `synchronous=FULL` 提交受 owner 保护的 `consumed` 到 `claimed` transition。该流程采用 at-most-once 语义：barrier 前崩溃时可在 lease 过期后接管；barrier 后崩溃时可能没有 continuation event 或请求，恢复不会重投。在 verification、consumption、dispatch 与 barrier commit 前，replacement fence 会扫描已提交 Session event、当前 claimed batch 与两条 pending inbox 队列；任何更新的 direct-user message 都会原子 supersede 旧任务，并产生零 continuation request。公开取消与替换只会在 claim 处于 `pending` 或 `ready` 时胜出；内部 replacement fence 仍可在 barrier 前 supersede `consumed`。唯一的 earliest-due timer 会发现其他 Host 创建的数据库或推进的 mutation，使停放 claim 到期、重新检查 lease deadline，并在无外部事件时重试暂态恢复故障。provider-owned cold Agent 会在同一 Session 仍有 active claim 时保持注册，并在最后一个 claim 进入终态后 dispose；调用方持有的 live Agent 不受影响。Provider teardown 会在发布前中止卡住的 cold creation，并尝试全部自有 cleanup。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.zh.md)

Source: [`packages/continuation/task-continuation/src/index.ts`](../../packages/continuation/task-continuation/src/index.ts)
<!-- END GENERATED cordis-surface -->
