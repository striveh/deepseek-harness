/** Durable verifier-gated continuation Service Provider and Agent driver. @module @deepseek-ai/dsh-task-continuation-driver */

import { createHash, randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, AgentHandle, AgentOptions, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { deadline, MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'
import {
  TaskContinuationService,
  TaskContinuationMutationConflictError,
  allocateContinuationId,
  continuationDigest,
  decodeTaskContinuationSource,
  isTaskContinuationMessage,
  taskContinuationMessage,
  taskContinuationCallerId,
  taskContinuationMutationId,
  taskContinuationRevision,
  taskContinuationVerifierId,
  type ContinuationId,
  type CreateTaskContinuationRequest,
  type ListTaskContinuationsRequest,
  type ReserveTaskContinuationRequest,
  type SupersedeTaskContinuationRequest,
  type TaskContinuationClaim,
  type TaskContinuationReady,
  type TaskContinuationRef,
  type TaskContinuationVerification,
} from '@deepseek-ai/dsh-task-continuation'
import {
  DurableTaskContinuationStore,
  type ContinuationDispatchLease,
  type ContinuationTransition,
  type NewContinuationRecord,
} from './store.ts'
import {
  normalizeContinuationAgentOptions,
  sameContinuationAgentOptions,
} from './options.ts'

/** Largest writer wait accepted by SQLite's signed millisecond interface. */
export const MAX_CONTINUATION_BUSY_TIMEOUT_MS = 2_147_483_647
/** Default cross-process writer-reservation wait. */
export const DEFAULT_CONTINUATION_BUSY_TIMEOUT_MS = 10_000
/** Largest verifier deadline Node schedules without delay clamping. */
export const MAX_CONTINUATION_VERIFIER_TIMEOUT_MS = MAX_TIMER_DELAY_MS
/** Default deadline for one continuation verifier decision. */
export const DEFAULT_CONTINUATION_VERIFIER_TIMEOUT_MS = 30_000
/** Default lifetime renewed for one cross-process consumed-dispatch owner. */
export const DEFAULT_CONTINUATION_DISPATCH_LEASE_MS = 30_000
/** Default first retry delay after a transient recovery fault. */
export const DEFAULT_CONTINUATION_RECOVERY_RETRY_INITIAL_MS = 100
/** Default maximum retry delay after repeated transient recovery faults. */
export const DEFAULT_CONTINUATION_RECOVERY_RETRY_MAX_MS = 5_000
/** Default interval for detecting a claim database created by another Host. */
export const DEFAULT_CONTINUATION_RECOVERY_POLL_MS = 1_000

/** Capability-owned deadline reason for one continuation verifier decision. */
const CONTINUATION_VERIFIER_TIMEOUT_CODE = 'TASK_CONTINUATION_VERIFIER_TIMEOUT'

/** Local durable continuation-driver configuration. */
export interface Config {
  /** Directory containing the versioned claim database. */
  root: string
  /** Maximum wait for another process's atomic claim transition. */
  busyTimeoutMs?: number
  /** Maximum wait for one verifier decision before the claim becomes invalid. */
  verifierTimeoutMs?: number
  /** Renewable cross-process authority lifetime for one consumed dispatch. */
  dispatchLeaseMs?: number
  /** First automatic recovery retry delay after a transient fault. */
  recoveryRetryInitialMs?: number
  /** Maximum exponential recovery retry delay. */
  recoveryRetryMaxMs?: number
  /** Read-only poll interval while another Host may create or advance durable work. */
  recoveryPollMs?: number
}

/** One process-local maintenance activity owned by this provider. */
interface ActiveMaintenance {
  readonly agent: Agent
  readonly promise: Promise<void>
}

/** Process-owned renewable authority for one consumed dispatch. */
interface OwnedDispatchLease {
  lease: ContinuationDispatchLease
  readonly abort: AbortController
  readonly promise: Promise<void>
}

/** One in-flight attempt to tear down a provider-owned cold Agent. */
interface OwnedHandleDisposal {
  readonly handle: AgentHandle
  readonly promise: Promise<void>
}

/** Detached list filters with explicit absent values for internal comparisons. */
interface NormalizedListRequest {
  readonly sessionId: SessionId | undefined
  readonly callerId: ReturnType<typeof taskContinuationCallerId> | undefined
  readonly mutationId: ReturnType<typeof taskContinuationMutationId> | undefined
}

/** SQLite-backed task-continuation provider with restart recovery and pre-step admission. */
export class DurableTaskContinuationDriver extends TaskContinuationService {
  static inject = ['agents', 'sessions', 'sessionPersistence']

  /** Runtime loader schema. */
  static Config: z<Config> = z.object({
    root: z.string().required(),
    busyTimeoutMs: z.number().step(1).min(0).max(MAX_CONTINUATION_BUSY_TIMEOUT_MS)
      .default(DEFAULT_CONTINUATION_BUSY_TIMEOUT_MS),
    verifierTimeoutMs: z.number().step(1).min(1).max(MAX_CONTINUATION_VERIFIER_TIMEOUT_MS)
      .default(DEFAULT_CONTINUATION_VERIFIER_TIMEOUT_MS),
    dispatchLeaseMs: z.number().step(1).min(3).max(MAX_TIMER_DELAY_MS)
      .default(DEFAULT_CONTINUATION_DISPATCH_LEASE_MS),
    recoveryRetryInitialMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS)
      .default(DEFAULT_CONTINUATION_RECOVERY_RETRY_INITIAL_MS),
    recoveryRetryMaxMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS)
      .default(DEFAULT_CONTINUATION_RECOVERY_RETRY_MAX_MS),
    recoveryPollMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS)
      .default(DEFAULT_CONTINUATION_RECOVERY_POLL_MS),
  })

  private readonly store: DurableTaskContinuationStore
  private readonly verifierTimeoutMs: number
  private readonly dispatchLeaseMs: number
  private readonly recoveryRetryInitialMs: number
  private readonly recoveryRetryMaxMs: number
  private readonly recoveryPollMs: number
  private readonly dispatchOwnerId = randomUUID()
  private readonly lifetime = new AbortController()
  private readonly activeMaintenance = new Map<SessionId, ActiveMaintenance>()
  private readonly ownedHandles = new Map<SessionId, AgentHandle>()
  private readonly handleDisposals = new Map<SessionId, OwnedHandleDisposal>()
  private readonly dispatchLeases = new Map<ContinuationId, OwnedDispatchLease>()
  private readonly reservationResumes = new Map<SessionId, Promise<Agent>>()
  private readonly reservations = new Map<string, Promise<TaskContinuationClaim>>()
  private readonly pendingUserWakeups = new Set<SessionId>()
  private requested = false
  private storeActivated = false
  private run: Promise<void> | undefined
  private dueTimer: ReturnType<typeof setTimeout> | undefined
  private dueAtMs: number | undefined
  private probe: Promise<void> | undefined
  private nextRetryDelayMs: number
  private recoveryFailureEpoch = 0
  private stopping = false
  private disposal: Promise<void> | undefined

  readonly protocolVersion = 1 as const

  constructor(ctx: Context, readonly config: Config) {
    super(ctx)
    this.store = new DurableTaskContinuationStore(
      config.root,
      config.busyTimeoutMs ?? DEFAULT_CONTINUATION_BUSY_TIMEOUT_MS,
    )
    this.verifierTimeoutMs = config.verifierTimeoutMs ?? DEFAULT_CONTINUATION_VERIFIER_TIMEOUT_MS
    this.dispatchLeaseMs = config.dispatchLeaseMs ?? DEFAULT_CONTINUATION_DISPATCH_LEASE_MS
    this.recoveryRetryInitialMs = config.recoveryRetryInitialMs
      ?? DEFAULT_CONTINUATION_RECOVERY_RETRY_INITIAL_MS
    this.recoveryRetryMaxMs = config.recoveryRetryMaxMs ?? DEFAULT_CONTINUATION_RECOVERY_RETRY_MAX_MS
    this.recoveryPollMs = config.recoveryPollMs ?? DEFAULT_CONTINUATION_RECOVERY_POLL_MS
    if (this.recoveryRetryMaxMs < this.recoveryRetryInitialMs) {
      throw new Error('task continuation recoveryRetryMaxMs must be at least recoveryRetryInitialMs')
    }
    this.nextRetryDelayMs = this.recoveryRetryInitialMs

    ctx.effect(function* (this: DurableTaskContinuationDriver) {
      ctx.on('agent/created', () => { this.requestDrive() })
      ctx.on('agent/disposed', () => { this.requestDrive() })
      ctx.on('agent/session-start', () => { this.requestDrive() })
      ctx.on('agent/status', ({ agent, status }) => {
        if (status === 'idle') {
          this.wakePendingDirectUser(agent)
          this.requestDrive()
        }
      })
      ctx.on('session/event', (_session, event) => {
        if (event.type === 'user/message' && event.data.source.kind === 'user') this.requestDrive()
      })
      ctx.on('agent/pre-step', (payload, next) => this.admitContinuation(payload.agent, payload.messages, payload.signal, next))
      yield () => this.disposeDriver()
    }.bind(this), 'task-continuation-driver.lifecycle()')
  }

  /** Open prior durable state before publication, then recover active claims. */
  protected async [Service.init](): Promise<void> {
    this.storeActivated = await this.store.initializeIfPresent()
    if (this.storeActivated) this.requestDrive()
    else this.scheduleDue(this.recoveryPollMs)
  }

  async create(agent: Agent, request: CreateTaskContinuationRequest): Promise<TaskContinuationClaim> {
    const normalized = normalizeCreateRequest(request)
    const resumeAgentOptions = normalizeContinuationAgentOptions(agent.options)
    await this.activateStore()
    return this.shareReservation(normalized, resumeAgentOptions, () =>
      this.reserveForAgent(agent, normalized, resumeAgentOptions))
  }

  async reserve(request: ReserveTaskContinuationRequest): Promise<TaskContinuationClaim> {
    const normalized = normalizeCreateRequest(request)
    const resumeAgentOptions = normalizeContinuationAgentOptions(request.resumeAgentOptions)
    await this.activateStore()
    return this.shareReservation(normalized, resumeAgentOptions, async () => {
      const existing = await this.store.getByMutation(normalized.callerId, normalized.mutationId)
      if (existing !== undefined) {
        assertSameReservation(existing, normalized, resumeAgentOptions)
        this.requestDrive()
        return existing
      }
      assertFutureExpiry(normalized.expiresAtMs)
      const agent = await this.resolveReservationAgent(normalized.sessionId, resumeAgentOptions)
      return this.reserveForAgent(agent, normalized, resumeAgentOptions)
    })
  }

  /** Share one caller mutation through its complete Agent marker checkpoint. */
  private shareReservation(
    normalized: CreateTaskContinuationRequest,
    resumeAgentOptions: Readonly<AgentOptions>,
    start: () => Promise<TaskContinuationClaim>,
  ): Promise<TaskContinuationClaim> {
    const key = reservationKey(normalized.callerId, normalized.mutationId)
    const existing = this.reservations.get(key)
    if (existing !== undefined) {
      return existing.then((claim) => {
        assertSameReservation(claim, normalized, resumeAgentOptions)
        return claim
      })
    }
    const reservation = start()
    this.reservations.set(key, reservation)
    const retire = (): void => {
      /* v8 ignore else -- the exact key cannot be replaced while every entrant observes this promise. */
      if (this.reservations.get(key) === reservation) this.reservations.delete(key)
    }
    void reservation.then(retire, retire)
    return reservation
  }

  /** Create or replay one exact caller key while holding its live Agent authority. */
  private async reserveForAgent(
    agent: Agent,
    normalized: CreateTaskContinuationRequest,
    resumeAgentOptions: Readonly<AgentOptions>,
  ): Promise<TaskContinuationClaim> {
    this.assertLiveAgent(agent, normalized.sessionId)
    if (!sameContinuationAgentOptions(agent.options, resumeAgentOptions)) {
      throw new Error(`task continuation resume options do not match live session "${normalized.sessionId}"`)
    }
    const existing = await this.store.getByMutation(normalized.callerId, normalized.mutationId)
    if (existing !== undefined) {
      assertSameReservation(existing, normalized, resumeAgentOptions)
      this.requestDrive()
      return existing
    }
    assertFutureExpiry(normalized.expiresAtMs)
    if (!agent.session.events.some(event => event.type === 'user/message'
      && event.data.id === normalized.originalMessageId
      && event.data.source.kind === 'user')) {
      throw new Error(`original direct-user message "${normalized.originalMessageId}" is not in session "${agent.id}"`)
    }
    const input: NewContinuationRecord = {
      kind: 'task-continuation',
      version: 1,
      continuationId: allocateContinuationId(),
      callerId: normalized.callerId,
      mutationId: normalized.mutationId,
      dispatchMessageId: MessageId(randomUUID()),
      resumeAgentOptions,
      sessionId: normalized.sessionId,
      originalMessageId: normalized.originalMessageId,
      needDigest: normalized.needDigest,
      taskRevision: normalized.taskRevision,
      verifierId: normalized.verifierId,
      verificationPayloadDigest: normalized.verificationPayloadDigest,
      createdAtMs: Date.now(),
      expiresAtMs: normalized.expiresAtMs,
    }
    const reserved = await this.store.createOrGet(input)
    const claim = reserved.claim
    assertSameReservation(claim, normalized, resumeAgentOptions)
    if (!reserved.created) {
      this.requestDrive()
      return claim
    }
    try {
      agent.send(taskContinuationMessage(claim), 'next-turn', false)
      await this.requireSessionFlush(agent)
    } catch (error: unknown) {
      agent.inbox.remove(claim.dispatchMessageId)
      const failures: unknown[] = [error]
      let invalid: TaskContinuationClaim | undefined
      try {
        invalid = await this.store.transition({
          id: claim.continuationId,
          from: ['pending'],
          to: 'invalid',
          expectedRecordRevision: claim.recordRevision,
          updatedAtMs: Date.now(),
        })
      } catch (cleanupError: unknown) {
        failures.push(cleanupError)
      }
      try {
        await this.requireSessionFlush(agent)
      } catch (cleanupError: unknown) {
        failures.push(cleanupError)
      }
      if (invalid !== undefined) {
        try {
          await this.releaseOwnedHandleIfInactive(invalid.sessionId, true)
        } catch (cleanupError: unknown) {
          failures.push(cleanupError)
        }
      }
      throw orderedErrors(`task continuation reservation failed: ${renderThrown(error)}`, failures)
    }
    this.requestDrive()
    return claim
  }

  async get(id: ContinuationId): Promise<TaskContinuationClaim | undefined> {
    if (!await this.activateExistingStore()) return undefined
    return this.store.get(id)
  }

  async list(request: ListTaskContinuationsRequest = {}): Promise<readonly TaskContinuationClaim[]> {
    const normalized = normalizeListRequest(request)
    if (!await this.activateExistingStore()) return []
    const claims = await this.store.list()
    return claims.filter(claim => (normalized.sessionId === undefined || claim.sessionId === normalized.sessionId)
      && (normalized.callerId === undefined || claim.callerId === normalized.callerId)
      && (normalized.mutationId === undefined || claim.mutationId === normalized.mutationId))
  }

  async cancel(ref: TaskContinuationRef): Promise<boolean> {
    const normalized = normalizeContinuationRef(ref)
    if (!await this.activateExistingStore()) return false
    const changed = await this.store.transition({
      id: normalized.id,
      from: ['pending', 'ready'],
      to: 'canceled',
      expectedSessionId: normalized.sessionId,
      expectedTaskRevision: normalized.taskRevision,
      updatedAtMs: Date.now(),
    })
    if (changed === undefined) return false
    await this.reconcileTerminalBestEffort(changed)
    return true
  }

  async supersede(request: SupersedeTaskContinuationRequest): Promise<boolean> {
    const normalized = normalizeSupersedeRequest(request)
    if (!await this.activateExistingStore()) return false
    const changed = await this.store.transition({
      id: normalized.id,
      from: ['pending', 'ready'],
      to: 'superseded',
      expectedSessionId: normalized.sessionId,
      expectedTaskRevision: normalized.taskRevision,
      supersededByTaskRevision: normalized.replacementTaskRevision,
      updatedAtMs: Date.now(),
    })
    if (changed === undefined) return false
    await this.reconcileTerminalBestEffort(changed)
    return true
  }

  /** Re-run recovery when a verifier appears or disappears. */
  protected override onVerifierRegistryChanged(): void {
    this.requestDrive()
  }

  /** Coalesce every lifecycle and verifier trigger onto one global durable scanner. */
  private requestDrive(): void {
    if (this.stopping || !this.storeActivated) return
    this.clearDueTimer()
    this.requested = true
    if (this.run !== undefined) return
    let run: Promise<void>
    try {
      run = this.ctx.agents.withoutInitiator(() => this.runRequested())
    } catch (error: unknown) {
      this.scheduleRecoveryRetry(error, 'could not start recovery')
      return
    }
    this.run = run
    void run.then(
      () => { this.retireRun(run) },
      (error: unknown) => {
        this.scheduleRecoveryRetry(error, 'recovery failed')
        this.retireRun(run)
      },
    )
  }

  /** Open the database before an explicit API call may read or create claims. */
  private async activateStore(): Promise<void> {
    await this.store.initialize()
    this.storeActivated = true
    this.requestDrive()
  }

  /** Open a prior database without materializing state for a read or terminal no-op. */
  private async activateExistingStore(): Promise<boolean> {
    if (this.storeActivated) return true
    this.storeActivated = await this.store.initializeIfPresent()
    if (this.storeActivated) {
      this.clearDueTimer()
      this.requestDrive()
    }
    return this.storeActivated
  }

  /** Drain requested complete scans serially. */
  private async runRequested(): Promise<void> {
    while (this.requested && !this.stopping) {
      this.requested = false
      const failureEpoch = this.recoveryFailureEpoch
      await this.reconcileAll()
      if (failureEpoch === this.recoveryFailureEpoch) this.nextRetryDelayMs = this.recoveryRetryInitialMs
    }
  }

  /** Schedule one coalesced exponential retry and emit the fault immediately. */
  private scheduleRecoveryRetry(error: unknown, operation: string): void {
    if (this.stopping) return
    this.recoveryFailureEpoch += 1
    this.ctx.logger.warn(`task-continuation-driver: ${operation}: ${renderThrown(error)}`)
    const delayMs = this.nextRetryDelayMs
    this.nextRetryDelayMs = Math.min(this.recoveryRetryMaxMs, delayMs * 2)
    this.scheduleDue(delayMs)
  }

  /** Recheck a live lease without treating another Host's ownership as a fault. */
  private scheduleRecoveryWake(delayMs: number): void {
    this.scheduleDue(delayMs)
  }

  /** Keep one earliest timer for claim expiry, lease takeover, retry, or store discovery. */
  private scheduleDue(delayMs: number): void {
    if (this.stopping) return
    const dueAtMs = safeDeadline(Date.now(), Math.max(1, Math.floor(delayMs)))
    if (this.dueAtMs !== undefined && this.dueAtMs <= dueAtMs) return
    this.clearDueTimer()
    this.dueAtMs = dueAtMs
    this.dueTimer = setTimeout(() => {
      this.dueTimer = undefined
      this.dueAtMs = undefined
      if (this.storeActivated) this.requestDrive()
      else this.startStoreProbe()
    }, Math.max(1, dueAtMs - Date.now()))
    this.dueTimer.unref()
  }

  /** Cancel the currently scheduled due-work callback. */
  private clearDueTimer(): void {
    if (this.dueTimer !== undefined) clearTimeout(this.dueTimer)
    this.dueTimer = undefined
    this.dueAtMs = undefined
  }

  /** Probe for a database materialized by another Host without creating one locally. */
  private startStoreProbe(): void {
    if (this.stopping || this.storeActivated || this.probe !== undefined) return
    const probe = (async () => {
      try {
        this.storeActivated = await this.store.initializeIfPresent()
        if (this.storeActivated) this.requestDrive()
        else this.scheduleDue(this.recoveryPollMs)
      } catch (error: unknown) {
        this.scheduleRecoveryRetry(error, 'durable store probe failed')
      }
    })()
    this.probe = probe
    const retire = (): void => { if (this.probe === probe) this.probe = undefined }
    void probe.then(retire, retire)
  }

  /** Retire one exact scan promise and honor a final coalesced trigger. */
  private retireRun(run: Promise<void>): void {
    if (this.run !== run) return
    this.run = undefined
    if (this.requested && !this.stopping) this.requestDrive()
  }

  /** Recover markers and drive every active claim in deterministic order. */
  private async reconcileAll(): Promise<void> {
    const claims = await this.store.list()
    const nowMs = Date.now()
    this.scheduleDue(this.recoveryPollMs)
    const nextExpiryAtMs = claims
      .filter(isActive)
      .map(claim => claim.expiresAtMs)
      .filter(expiresAtMs => expiresAtMs > nowMs)
      .reduce<number | undefined>(
        (earliest, expiresAtMs) => earliest === undefined ? expiresAtMs : Math.min(earliest, expiresAtMs),
        undefined,
      )
    if (nextExpiryAtMs !== undefined) this.scheduleDue(nextExpiryAtMs - nowMs)
    for (const claim of claims) {
      if (this.stopping) return
      if (!isActive(claim)) {
        await this.removeLiveMarker(claim)
        continue
      }
      if (claim.state !== 'consumed' && claim.expiresAtMs <= Date.now()) {
        const expired = await this.transitionCaptured(claim, 'expired')
        if (expired !== undefined) await this.removeLiveMarker(expired)
        continue
      }
      const agent = await this.resolveAgent(claim)
      if (agent === undefined || agent.status !== 'idle') continue
      await this.startMaintenance(agent, claim.continuationId)
    }
  }

  /** Resolve the exact live Agent or cold-resume its persisted session. */
  private async resolveAgent(claim: TaskContinuationClaim): Promise<Agent | undefined> {
    const { sessionId } = claim
    const releasing = this.handleDisposals.get(sessionId)
    if (releasing !== undefined) {
      try {
        await releasing.promise
      } catch (_releaseFailure: unknown) {
        // The retained owned handle remains the only process-local authority after a failed release.
      }
    }
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) return live
    if (this.ctx.sessions.get(sessionId) !== undefined || this.stopping) return undefined
    const existingHandle = this.ownedHandles.get(sessionId)
    if (existingHandle !== undefined) return existingHandle.agent
    try {
      const handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: claim.resumeAgentOptions,
        signal: this.lifetime.signal,
      })
      if (!this.canContinue()) {
        await handle.dispose()
        return undefined
      }
      this.ownedHandles.set(sessionId, handle)
      return handle.agent
    } catch (error: unknown) {
      if (this.isLifetimeAbort(error)) return undefined
      throw new Error(`task continuation could not resume session "${sessionId}"`, { cause: error })
    }
  }

  /** Resolve or cold-resume one exact Session for a caller's not-yet-created reservation. */
  private async resolveReservationAgent(
    sessionId: SessionId,
    resumeAgentOptions: Readonly<AgentOptions>,
  ): Promise<Agent> {
    const releasing = this.handleDisposals.get(sessionId)
    if (releasing !== undefined) await releasing.promise
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) return live
    if (this.ctx.sessions.get(sessionId) !== undefined || this.stopping) {
      throw new Error(`task continuation cannot reserve unavailable session "${sessionId}"`)
    }
    const existingHandle = this.ownedHandles.get(sessionId)
    if (existingHandle !== undefined) return existingHandle.agent
    const existingResume = this.reservationResumes.get(sessionId)
    if (existingResume !== undefined) return existingResume
    const resume = this.resumeReservationAgent(sessionId, resumeAgentOptions)
    this.reservationResumes.set(sessionId, resume)
    void resume.then(
      () => { this.reservationResumes.delete(sessionId) },
      () => { this.reservationResumes.delete(sessionId) },
    )
    return resume
  }

  /** Publish one caller-owned cold-resume before releasing its shared in-flight identity. */
  private async resumeReservationAgent(
    sessionId: SessionId,
    resumeAgentOptions: Readonly<AgentOptions>,
  ): Promise<Agent> {
    const handle = await this.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: resumeAgentOptions,
      signal: this.lifetime.signal,
    })
    if (!this.canContinue()) {
      await handle.dispose()
      throw new Error('task continuation provider stopped during cold reservation')
    }
    this.ownedHandles.set(sessionId, handle)
    return handle.agent
  }

  /** Claim the Agent's true idle phase for one exact continuation decision. */
  private async startMaintenance(agent: Agent, id: ContinuationId): Promise<void> {
    if (this.activeMaintenance.has(agent.id)) return
    let promise: Promise<void>
    try {
      promise = agent.runMaintenance(signal => this.processClaim(agent, id, signal))
    } catch (_busy: unknown) {
      return
    }
    const active: ActiveMaintenance = { agent, promise }
    this.activeMaintenance.set(agent.id, active)
    let primary: unknown
    try {
      await promise
    } catch (error: unknown) {
      primary = error
    } finally {
      if (this.activeMaintenance.get(agent.id) === active) this.activeMaintenance.delete(agent.id)
    }
    let cleanup: unknown
    try {
      await this.releaseOwnedHandleIfInactive(agent.id, false)
    } catch (error: unknown) {
      cleanup = error
    }
    if (primary !== undefined || cleanup !== undefined) {
      const failure = orderedErrors(
        `task continuation claim "${id}" processing and cleanup failed`,
        [primary, cleanup].filter(error => error !== undefined),
      )
      this.scheduleRecoveryRetry(failure, `claim "${id}" failed`)
    }
  }

  /** Verify, checkpoint, consume, and safely wake one captured durable identity. */
  private async processClaim(agent: Agent, id: ContinuationId, signal: AbortSignal): Promise<void> {
    let claim = await this.store.get(id)
    if (claim === undefined || !isActive(claim) || !this.isExactLiveAgent(agent, claim.sessionId)) return
    if (signal.aborted || this.stopping) return
    if (await this.terminateReplacedTask(agent, claim)) return
    if (claim.state === 'consumed' && await this.reconcileDurableDispatch(agent, claim)) return
    if (claim.expiresAtMs <= Date.now()) {
      const expired = await this.transitionCaptured(claim, 'expired')
      if (expired !== undefined) await this.removeMarkerAndFlush(agent, expired)
      return
    }

    if (claim.state === 'pending') {
      const verifier = this.resolveVerifier(claim.verifierId)
      if (verifier === undefined) return
      using verificationDeadline = deadline(
        signal,
        this.verifierTimeoutMs,
        CONTINUATION_VERIFIER_TIMEOUT_CODE,
      )
      let decision: TaskContinuationVerification | undefined
      try {
        decision = await verifierDecision(
          verifier.verify(claim, verificationDeadline.signal),
          verificationDeadline.signal,
        )
      } catch (error: unknown) {
        if (!verificationDeadline.signal.aborted) throw error
      }
      const timeout = timeoutOf(verificationDeadline.signal, CONTINUATION_VERIFIER_TIMEOUT_CODE)
      if (timeout !== undefined) {
        this.ctx.logger.warn(`task-continuation-driver: verifier "${claim.verifierId}" timed out after ${String(timeout.timeoutMs)}ms for claim "${claim.continuationId}"`)
        const invalid = await this.transitionCaptured(claim, 'invalid')
        if (invalid !== undefined) await this.removeMarkerAndFlush(agent, invalid)
        return
      }
      if (decision === undefined || !this.canContinue(signal)) return
      if (await this.terminateReplacedTask(agent, claim)) return
      const latest = await this.store.get(id)
      if (latest === undefined || latest.recordRevision !== claim.recordRevision || latest.state !== 'pending') {
        this.scheduleRecoveryWake(Math.max(1, Math.floor(this.dispatchLeaseMs / 3)))
        return
      }
      if (decision.kind === 'not-ready') return
      if (!matchesReady(decision, claim)) {
        const invalid = await this.transitionCaptured(claim, 'invalid')
        if (invalid !== undefined) await this.removeMarkerAndFlush(agent, invalid)
        return
      }
      const ready = await this.transitionCaptured(claim, 'ready')
      if (ready === undefined) {
        this.scheduleRecoveryWake(Math.max(1, Math.floor(this.dispatchLeaseMs / 3)))
        return
      }
      claim = ready
    }

    if (claim.state === 'ready') {
      if (!await this.ensureExactMarker(agent, claim)) return
      await this.requireSessionFlush(agent)
      if (await this.terminateReplacedTask(agent, claim)) return
      const consumed = await this.transitionCaptured(claim, 'consumed')
      if (consumed === undefined) {
        this.scheduleRecoveryWake(Math.max(1, Math.floor(this.dispatchLeaseMs / 3)))
        return
      }
      claim = consumed
    }

    if (claim.state !== 'consumed' || !this.canContinue(signal)) return
    if (claim.expiresAtMs <= Date.now()) {
      const expired = await this.transitionCaptured(claim, 'expired')
      if (expired !== undefined) await this.removeMarkerAndFlush(agent, expired)
      return
    }
    if (await this.acquireOwnedDispatchLease(claim) === undefined) return
    if (!await this.ensureExactMarker(agent, claim)) return
    await this.requireSessionFlush(agent)
    const latest = await this.store.get(id)
    if (latest === undefined || latest.recordRevision !== claim.recordRevision || latest.state !== 'consumed') return
    if (await this.terminateReplacedTask(agent, latest)) return
    if (await this.renewOwnedDispatchLease(latest) === undefined) return

    this.removeOtherContinuationMarkers(agent, claim.dispatchMessageId)
    agent.inbox.remove(claim.dispatchMessageId)
    const dispatch = taskContinuationMessage(claim)
    agent.send(dispatch, 'next-turn', true)
    // The waking send latches one turn even while maintenance owns the Agent.
    // Put its exact identity first so another parked continuation cannot consume
    // that latch and create a rejected empty turn.
    agent.inbox.remove(claim.dispatchMessageId)
    agent.inbox.prepend('next-turn', dispatch)
    try {
      await this.requireSessionFlush(agent)
    } catch (error: unknown) {
      agent.inbox.remove(claim.dispatchMessageId)
      try {
        await this.requireSessionFlush(agent)
      } catch (_cleanupFailure: unknown) {
        // The consumed database record reconstructs this same dispatch identity after restart.
      }
      throw error
    }
    const flushed = await this.store.get(id)
    if (flushed === undefined || flushed.recordRevision !== claim.recordRevision
      || flushed.state !== 'consumed') return
    await this.terminateReplacedTask(agent, flushed)
  }

  /** Admit only an exact consumed dispatch after every downstream listener and durable fence still accepts it. */
  private async admitContinuation(
    agent: Agent,
    messages: UserMessage[],
    signal: AbortSignal,
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> {
    const submitted = messages.filter(message => message.source.kind === 'task-continuation')
    if (submitted.length === 0) return next()
    if (submitted.length !== 1 || this.stopping) {
      this.restoreOtherClaimed(agent, messages, new Set(submitted.map(message => message.id)), true)
      return { kind: 'reject' }
    }
    const message = submitted[0]
    /* v8 ignore next -- submitted.length === 1 guarantees index zero exists. */
    if (message === undefined) return { kind: 'reject' }
    const source = decodeTaskContinuationSource(message.source)
    if (source === undefined || source.sessionId !== agent.id) {
      this.restoreOtherClaimed(agent, messages, new Set([message.id]), true)
      return { kind: 'reject' }
    }
    const claim = await this.store.get(source.continuationId)
    if (claim === undefined || claim.state !== 'consumed' || claim.sessionId !== agent.id
      || claim.expiresAtMs <= Date.now() || !isTaskContinuationMessage(message, claim)) {
      if (claim?.state === 'consumed' && claim.expiresAtMs <= Date.now()) {
        await this.transitionCaptured(claim, 'expired')
      }
      this.restoreOtherClaimed(agent, messages, new Set([message.id]), true)
      this.requestDrive()
      return { kind: 'reject' }
    }
    if (await this.terminateReplacedTask(agent, claim, messages)) {
      this.restoreOtherClaimed(agent, messages, new Set([message.id]), true)
      this.requestDrive()
      return { kind: 'reject' }
    }
    if (await this.renewOwnedDispatchLease(claim) === undefined) {
      this.restoreOtherClaimed(agent, messages, new Set([message.id]), true)
      this.requestDrive()
      return { kind: 'reject' }
    }

    const decision = await next()
    if (signal.aborted || decision.kind === 'reject') {
      this.restoreOtherClaimed(agent, decision.kind === 'enter' ? decision.messages : messages, new Set([message.id]))
      this.requestDrive()
      return decision.kind === 'reject' ? decision : { kind: 'reject' }
    }
    const latest = await this.store.get(claim.continuationId)
    if (latest === undefined || latest.state !== 'consumed'
      || latest.recordRevision !== claim.recordRevision
      || latest.sessionId !== agent.id
      || latest.taskRevision !== claim.taskRevision) {
      this.restoreOtherClaimed(agent, decision.messages, new Set([message.id]), true)
      this.requestDrive()
      return { kind: 'reject' }
    }
    if (latest.expiresAtMs <= Date.now()) {
      await this.transitionCaptured(latest, 'expired')
      this.restoreOtherClaimed(agent, decision.messages, new Set([message.id]), true)
      this.requestDrive()
      return { kind: 'reject' }
    }
    if (await this.terminateReplacedTask(agent, latest, decision.messages)) {
      this.restoreOtherClaimed(agent, decision.messages, new Set([message.id]), true)
      this.requestDrive()
      return { kind: 'reject' }
    }
    const finalContinuationCount = decision.messages
      .filter(candidate => candidate.source.kind === 'task-continuation').length
    if (finalContinuationCount !== 1
      || !decision.messages.some(candidate => isTaskContinuationMessage(candidate, latest))) {
      this.restoreOtherClaimed(agent, decision.messages, new Set([message.id]), true)
      this.requestDrive()
      return { kind: 'reject' }
    }
    const lease = await this.renewOwnedDispatchLease(latest)
    if (lease === undefined) {
      this.restoreOtherClaimed(agent, decision.messages, new Set([message.id]), true)
      this.requestDrive()
      return { kind: 'reject' }
    }
    const claimed = await this.store.claimDispatch(latest, lease, Date.now())
    if (claimed === undefined) {
      this.restoreOtherClaimed(agent, decision.messages, new Set([message.id]), true)
      this.requestDrive()
      return { kind: 'reject' }
    }
    await this.retireOwnedDispatchLease(claimed.continuationId, false)
    return decision
  }

  /** Acquire one cross-process consumed-dispatch incarnation and keep it renewed. */
  private async acquireOwnedDispatchLease(
    claim: TaskContinuationClaim,
  ): Promise<ContinuationDispatchLease | undefined> {
    const existing = this.dispatchLeases.get(claim.continuationId)
    if (existing !== undefined) {
      if (existing.lease.recordRevision === claim.recordRevision
        && await this.store.holdsDispatchLease(existing.lease, Date.now())) return existing.lease
      await this.retireOwnedDispatchLease(claim.continuationId, false)
    }
    const nowMs = Date.now()
    const lease = await this.store.acquireDispatchLease(
      claim,
      this.dispatchOwnerId,
      nowMs,
      safeDeadline(nowMs, this.dispatchLeaseMs),
    )
    if (lease === undefined) {
      const leaseExpiryAtMs = await this.store.getDispatchLeaseExpiry(claim)
      this.scheduleRecoveryWake(leaseExpiryAtMs === undefined
        ? this.dispatchLeaseMs
        : Math.max(1, leaseExpiryAtMs - Date.now()))
      return undefined
    }
    const abort = new AbortController()
    const ownedRef: { current?: OwnedDispatchLease } = {}
    const promise = this.maintainDispatchLease(claim.continuationId, abort.signal, () => {
      /* v8 ignore next -- the first heartbeat timer cannot elapse before synchronous publication below. */
      if (ownedRef.current === undefined) throw new Error('task continuation dispatch lease was not published')
      return ownedRef.current
    })
    const owned: OwnedDispatchLease = { lease, abort, promise }
    ownedRef.current = owned
    this.dispatchLeases.set(claim.continuationId, owned)
    void promise.then(
      () => {
        if (this.dispatchLeases.get(claim.continuationId) === owned && !abort.signal.aborted) {
          this.dispatchLeases.delete(claim.continuationId)
        }
      },
      (error: unknown) => {
        if (this.dispatchLeases.get(claim.continuationId) === owned) {
          this.dispatchLeases.delete(claim.continuationId)
        }
        this.scheduleRecoveryRetry(error, `dispatch lease renewal failed for "${claim.continuationId}"`)
      },
    )
    return lease
  }

  /** Renew an exact locally owned lease before a dispatch-side effect fence. */
  private async renewOwnedDispatchLease(
    claim: TaskContinuationClaim,
  ): Promise<ContinuationDispatchLease | undefined> {
    const owned = this.dispatchLeases.get(claim.continuationId)
    if (owned === undefined || owned.lease.recordRevision !== claim.recordRevision) return undefined
    const renewed = await this.store.renewDispatchLease(
      owned.lease,
      safeDeadline(Date.now(), this.dispatchLeaseMs),
    )
    if (renewed === undefined) {
      await this.retireOwnedDispatchLease(claim.continuationId, false)
      return undefined
    }
    owned.lease = renewed
    return renewed
  }

  /** Renew one lease until it is terminalized, relinquished, or lost. */
  private async maintainDispatchLease(
    id: ContinuationId,
    signal: AbortSignal,
    readOwned: () => OwnedDispatchLease,
  ): Promise<void> {
    const intervalMs = Math.max(1, Math.floor(this.dispatchLeaseMs / 3))
    while (await waitForTimer(intervalMs, signal)) {
      const owned = readOwned()
      const renewed = await this.store.renewDispatchLease(
        owned.lease,
        safeDeadline(Date.now(), this.dispatchLeaseMs),
      )
      if (renewed === undefined) return
      owned.lease = renewed
      if (this.dispatchLeases.get(id) !== owned) return
    }
  }

  /** Stop one heartbeat and optionally relinquish its still-consumed durable lease. */
  private async retireOwnedDispatchLease(id: ContinuationId, release: boolean): Promise<void> {
    const owned = this.dispatchLeases.get(id)
    if (owned === undefined) return
    owned.abort.abort()
    let primary: unknown
    try {
      await owned.promise
    } catch (error: unknown) {
      primary = error
    }
    let cleanup: unknown
    if (release) {
      try {
        await this.store.releaseDispatchLease(owned.lease)
      } catch (error: unknown) {
        cleanup = error
      }
    }
    if (primary === undefined && cleanup === undefined) {
      if (this.dispatchLeases.get(id) === owned) this.dispatchLeases.delete(id)
      return
    }
    throw orderedErrors('task continuation dispatch lease cleanup failed', [primary, cleanup]
      .filter(error => error !== undefined))
  }

  /**
   * Reconcile one consumed intent against an already durable Session event.
   * One canonical event terminalizes the intent without another admission;
   * absence still requires the owner lease and pre-provider barrier.
   */
  private async reconcileDurableDispatch(agent: Agent, claim: TaskContinuationClaim): Promise<boolean> {
    const matches = agent.session.events.filter((event): event is SessionEvent<'user/message'> =>
      event.type === 'user/message' && event.data.id === claim.dispatchMessageId)
    if (matches.length === 0) return false
    const dispatched = matches[0]
    if (matches.length !== 1 || dispatched === undefined
      || !isTaskContinuationMessage(dispatched.data, claim)) {
      const invalid = await this.transitionCaptured(claim, 'invalid')
      if (invalid !== undefined) await this.removeMarkerAndFlush(agent, invalid)
      return true
    }
    if (dispatched.time >= claim.expiresAtMs) {
      const expired = await this.transitionCaptured(claim, 'expired')
      if (expired !== undefined) await this.removeMarkerAndFlush(agent, expired)
      return true
    }
    if (await this.terminateReplacedTask(agent, claim, [], dispatched.seq)) return true
    await this.requireSessionFlush(agent)
    if (await this.terminateReplacedTask(agent, claim, [], dispatched.seq)) return true
    const claimed = await this.transitionCaptured(claim, 'claimed')
    if (claimed !== undefined) await this.removeMarkerAndFlush(agent, claimed)
    return true
  }

  /** Ensure exactly one canonical marker is parked at the next-turn boundary. */
  private async ensureExactMarker(agent: Agent, claim: TaskContinuationClaim): Promise<boolean> {
    const matches = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
      .filter(message => message.id === claim.dispatchMessageId)
    if (matches.length > 1 || (matches[0] !== undefined && !isTaskContinuationMessage(matches[0], claim))) {
      const invalid = await this.transitionCaptured(claim, 'invalid')
      if (invalid !== undefined) await this.removeMarkerAndFlush(agent, invalid)
      return false
    }
    const existing = matches[0]
    if (existing !== undefined && agent.inbox.nextTurn.includes(existing)) return true
    if (existing !== undefined) agent.inbox.remove(existing.id)
    agent.send(taskContinuationMessage(claim), 'next-turn', false)
    return true
  }

  /** Restore non-continuation context removed by a rejected proposed step. */
  private restoreOtherClaimed(
    agent: Agent,
    messages: readonly UserMessage[],
    excluded: ReadonlySet<MessageId>,
    wake: boolean = false,
  ): void {
    const restored = messages.filter(candidate => !excluded.has(candidate.id)
      && !agent.inbox.nextStep.some(queued => queued.id === candidate.id)
      && !agent.inbox.nextTurn.some(queued => queued.id === candidate.id))
    for (const message of restored.toReversed()) {
      if (agent.inbox.nextStep.some(candidate => candidate.id === message.id)
        || agent.inbox.nextTurn.some(candidate => candidate.id === message.id)) continue
      agent.inbox.prepend('next-step', message)
    }
    if (wake && [...agent.inbox.nextStep, ...agent.inbox.nextTurn]
      .some(message => message.source.kind === 'user')) {
      this.pendingUserWakeups.add(agent.id)
    }
  }

  /** Wake one direct-user message after a continuation-only rejection reaches idle. */
  private wakePendingDirectUser(agent: Agent): void {
    if (!this.pendingUserWakeups.delete(agent.id)) return
    const nextStep = agent.inbox.nextStep.find(message => message.source.kind === 'user')
    const nextTurn = agent.inbox.nextTurn.find(message => message.source.kind === 'user')
    const message = nextStep ?? nextTurn
    if (message === undefined) return
    const target = nextStep === undefined ? 'next-turn' : 'next-step'
    agent.inbox.remove(message.id)
    agent.send(message, target, true)
    agent.inbox.remove(message.id)
    agent.inbox.prepend(target, message)
  }

  /** Park other durable claims in the database while one exact next turn drains. */
  private removeOtherContinuationMarkers(agent: Agent, retained: MessageId): void {
    for (const message of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) {
      if (message.id !== retained && message.source.kind === 'task-continuation') {
        agent.inbox.remove(message.id)
      }
    }
  }

  /** Apply a record-revision-fenced state transition. */
  private transitionCaptured(
    claim: TaskContinuationClaim,
    to: ContinuationTransition['to'],
  ): Promise<TaskContinuationClaim | undefined> {
    return this.transitionAndRetireLease(claim, to)
  }

  /** Apply one state transition and stop a lease made obsolete by its terminal result. */
  private async transitionAndRetireLease(
    claim: TaskContinuationClaim,
    to: ContinuationTransition['to'],
  ): Promise<TaskContinuationClaim | undefined> {
    const transitioned = await this.store.transition({
      id: claim.continuationId,
      from: [claim.state],
      to,
      expectedRecordRevision: claim.recordRevision,
      expectedSessionId: claim.sessionId,
      expectedTaskRevision: claim.taskRevision,
      updatedAtMs: Date.now(),
    })
    if (transitioned !== undefined && !isActive(transitioned)) {
      await this.retireOwnedDispatchLease(transitioned.continuationId, false)
    }
    return transitioned
  }

  /** Terminalize a claim when committed, claimed, or pending direct-user work replaced its task before dispatch. */
  private async terminateReplacedTask(
    agent: Agent,
    claim: TaskContinuationClaim,
    claimed: readonly UserMessage[] = [],
    beforeSessionSeq?: number,
  ): Promise<boolean> {
    const original = agent.session.events.filter((event): event is SessionEvent<'user/message'> =>
      event.type === 'user/message' && event.data.id === claim.originalMessageId && event.data.source.kind === 'user')
    if (original.length !== 1 || original[0] === undefined) {
      const invalid = await this.transitionCaptured(claim, 'invalid')
      if (invalid !== undefined) await this.removeMarkerAndFlush(agent, invalid)
      return true
    }
    const [originalEvent] = original
    const committed = agent.session.events.findLast((event): event is SessionEvent<'user/message'> =>
      event.type === 'user/message' && event.seq > originalEvent.seq
      && (beforeSessionSeq === undefined || event.seq < beforeSessionSeq)
      && event.data.source.kind === 'user')
    const queued = beforeSessionSeq === undefined
      ? [...claimed, ...agent.inbox.nextStep, ...agent.inbox.nextTurn]
        .findLast(message => message.id !== claim.originalMessageId && message.source.kind === 'user')
      : undefined
    const replacementId = queued?.id ?? committed?.data.id
    if (replacementId === undefined) return false
    const replacementTaskRevision = taskContinuationRevision(`message:${createHash('sha256')
      .update(replacementId)
      .digest('hex')}`)
    const superseded = await this.store.transition({
      id: claim.continuationId,
      from: [claim.state],
      to: 'superseded',
      expectedRecordRevision: claim.recordRevision,
      expectedSessionId: claim.sessionId,
      expectedTaskRevision: claim.taskRevision,
      supersededByTaskRevision: replacementTaskRevision,
      updatedAtMs: Date.now(),
    })
    if (superseded !== undefined) {
      await this.retireOwnedDispatchLease(superseded.continuationId, false)
      await this.removeMarkerAndFlush(agent, superseded)
    }
    return true
  }

  /** Remove a terminal marker and release a provider-owned cold Agent after its last active claim. */
  private async removeLiveMarker(claim: TaskContinuationClaim): Promise<void> {
    const agent = this.ctx.agents.get(claim.sessionId)
    let primary: unknown
    try {
      if (agent !== undefined) await this.removeMarkerAndFlush(agent, claim)
    } catch (error: unknown) {
      primary = error
    }
    let cleanup: unknown
    try {
      await this.releaseOwnedHandleIfInactive(claim.sessionId, true)
    } catch (error: unknown) {
      cleanup = error
    }
    if (primary !== undefined || cleanup !== undefined) {
      throw orderedErrors(`task continuation terminal cleanup failed for "${claim.continuationId}"`, [primary, cleanup]
        .filter(error => error !== undefined))
    }
  }

  /** Keep a committed terminal API result while scheduling failed process-local cleanup. */
  private async reconcileTerminalBestEffort(claim: TaskContinuationClaim): Promise<void> {
    try {
      await this.removeLiveMarker(claim)
    } catch (error: unknown) {
      this.scheduleRecoveryRetry(error, `terminal cleanup failed for "${claim.continuationId}"`)
    }
  }

  /** Dispose the provider-owned cold handle only after the Session has no active claim. */
  private async releaseOwnedHandleIfInactive(sessionId: SessionId, cancelMaintenance: boolean): Promise<void> {
    const handle = this.ownedHandles.get(sessionId)
    if (handle === undefined || await this.store.hasActiveForSession(sessionId)) return
    const active = this.activeMaintenance.get(sessionId)
    if (active !== undefined) {
      if (!cancelMaintenance) return
      active.agent.cancel({ kind: 'disposed' }, { keepInbox: true })
      await active.promise
      if (await this.store.hasActiveForSession(sessionId)) return
    }
    await this.disposeOwnedHandle(sessionId, handle)
  }

  /** Memoize one handle release, deleting ownership only after actual quiescence. */
  private async disposeOwnedHandle(sessionId: SessionId, handle: AgentHandle): Promise<void> {
    const existing = this.handleDisposals.get(sessionId)
    if (existing !== undefined) return existing.promise
    const disposal: OwnedHandleDisposal = { handle, promise: handle.dispose() }
    this.handleDisposals.set(sessionId, disposal)
    try {
      await disposal.promise
      if (this.ownedHandles.get(sessionId) === handle) this.ownedHandles.delete(sessionId)
    } finally {
      if (this.handleDisposals.get(sessionId) === disposal) this.handleDisposals.delete(sessionId)
    }
  }

  /** Remove the exact dispatch identity and checkpoint the resulting inbox. */
  private async removeMarkerAndFlush(agent: Agent, claim: TaskContinuationClaim): Promise<void> {
    if (agent.inbox.remove(claim.dispatchMessageId)) await this.requireSessionFlush(agent)
  }

  /** Require an actual persistence listener at every inbox durability barrier. */
  private async requireSessionFlush(agent: Agent): Promise<void> {
    if (!await this.ctx.sessions.flush(agent.session)) {
      throw new Error(`session "${agent.id}" has no persistence participant`)
    }
  }

  /** Reject a stale or cross-session Agent capability. */
  private assertLiveAgent(agent: Agent, sessionId: SessionId): void {
    if (!this.isExactLiveAgent(agent, sessionId)) {
      throw new Error(`task continuation requires exact live session "${sessionId}"`)
    }
  }

  /** Whether one exact Agent and Session lifecycle remains registered. */
  private isExactLiveAgent(agent: Agent, sessionId: SessionId): boolean {
    return agent.id === sessionId && agent.session.id === sessionId
      && this.ctx.agents.get(sessionId) === agent
      && this.ctx.sessions.get(sessionId) === agent.session
  }

  /** Re-read teardown and optional cancellation state after asynchronous work. */
  private canContinue(signal?: AbortSignal): boolean {
    return !this.stopping && signal?.aborted !== true
  }

  /** Whether one rejected creation was canceled by this provider's own teardown. */
  private isLifetimeAbort(error: unknown): boolean {
    return this.stopping && this.lifetime.signal.aborted && error === this.lifetime.signal.reason
  }

  /** Stop scheduling, attempt every owned cleanup, and surface every unreleased resource. */
  private disposeDriver(): Promise<void> {
    return (this.disposal ??= (async () => {
      this.stopping = true
      this.lifetime.abort(new Error('task continuation provider disposed during Agent resume'))
      this.requested = false
      this.clearDueTimer()
      this.pendingUserWakeups.clear()
      for (const owned of this.dispatchLeases.values()) owned.abort.abort()
      for (const { agent } of this.activeMaintenance.values()) {
        agent.cancel({ kind: 'disposed' }, { keepInbox: true })
      }
      const errors: unknown[] = []
      const waits = new Set<Promise<unknown>>(
        [...this.activeMaintenance.values()].map(active => active.promise),
      )
      if (this.run !== undefined) waits.add(this.run)
      if (this.probe !== undefined) waits.add(this.probe)
      for (const resume of this.reservationResumes.values()) waits.add(resume)
      for (const reservation of this.reservations.values()) waits.add(reservation)
      errors.push(...settledErrors(await Promise.allSettled(waits))
        .filter(error => !this.isLifetimeAbort(error)))
      this.reservationResumes.clear()
      this.reservations.clear()
      const leases = [...this.dispatchLeases.entries()]
      errors.push(...settledErrors(await Promise.allSettled(
        leases.map(async ([id]) => { await this.retireOwnedDispatchLease(id, true) }),
      )))
      const handles = [...this.ownedHandles.entries()]
      errors.push(...settledErrors(await Promise.allSettled(
        handles.map(async ([sessionId, handle]) => { await this.disposeOwnedHandle(sessionId, handle) }),
      )))
      try {
        await this.store.close()
      } catch (error: unknown) {
        errors.push(error)
      }
      if (errors.length > 0) throw orderedErrors('task continuation provider teardown failed', errors)
    })())
  }
}

/** Detach management filters before the first asynchronous store boundary. */
function normalizeListRequest(request: ListTaskContinuationsRequest): NormalizedListRequest {
  const callerId = request.callerId === undefined
    ? undefined
    : taskContinuationCallerId(request.callerId)
  const mutationId = request.mutationId === undefined
    ? undefined
    : taskContinuationMutationId(request.mutationId)
  if (mutationId !== undefined && callerId === undefined) {
    throw new Error('task continuation mutation filter requires callerId')
  }
  return {
    sessionId: request.sessionId,
    callerId,
    mutationId,
  }
}

/** Encode one exact caller-scoped mutation identity without prototype-key semantics. */
function reservationKey(callerId: string, mutationId: string): string {
  return JSON.stringify([callerId, mutationId])
}

/** Detach and normalize a terminal mutation fence before store activation. */
function normalizeContinuationRef(ref: TaskContinuationRef): TaskContinuationRef {
  return {
    id: ref.id,
    sessionId: ref.sessionId,
    taskRevision: taskContinuationRevision(ref.taskRevision),
  }
}

/** Detach and normalize every supersession fence before store activation. */
function normalizeSupersedeRequest(request: SupersedeTaskContinuationRequest): SupersedeTaskContinuationRequest {
  return {
    ...normalizeContinuationRef(request),
    replacementTaskRevision: taskContinuationRevision(request.replacementTaskRevision),
  }
}

/** Normalize and validate all fields crossing the public create boundary. */
function normalizeCreateRequest(
  request: CreateTaskContinuationRequest,
): CreateTaskContinuationRequest {
  if (!Number.isSafeInteger(request.expiresAtMs) || request.expiresAtMs < 0) {
    throw new Error('task continuation expiry must be a non-negative epoch-millisecond integer')
  }
  if (request.sessionId === '' || request.originalMessageId === '') {
    throw new Error('task continuation session and original message identities must be non-empty')
  }
  return {
    callerId: taskContinuationCallerId(request.callerId),
    mutationId: taskContinuationMutationId(request.mutationId),
    sessionId: request.sessionId,
    originalMessageId: request.originalMessageId,
    needDigest: continuationDigest(request.needDigest),
    taskRevision: taskContinuationRevision(request.taskRevision),
    verifierId: taskContinuationVerifierId(request.verifierId),
    verificationPayloadDigest: continuationDigest(request.verificationPayloadDigest),
    expiresAtMs: request.expiresAtMs,
  }
}

/** Require a future deadline only when a caller key has not already been reserved. */
function assertFutureExpiry(expiresAtMs: number): void {
  if (expiresAtMs <= Date.now()) {
    throw new Error('task continuation expiry must be a future epoch-millisecond integer')
  }
}

/** Reject replay of a caller key with any different immutable input. */
function assertSameReservation(
  existing: TaskContinuationClaim,
  request: CreateTaskContinuationRequest,
  resumeAgentOptions: Readonly<AgentOptions>,
): void {
  if (existing.callerId !== request.callerId
    || existing.mutationId !== request.mutationId
    || existing.sessionId !== request.sessionId
    || existing.originalMessageId !== request.originalMessageId
    || existing.needDigest !== request.needDigest
    || existing.taskRevision !== request.taskRevision
    || existing.verifierId !== request.verifierId
    || existing.verificationPayloadDigest !== request.verificationPayloadDigest
    || existing.expiresAtMs !== request.expiresAtMs
    || !sameContinuationAgentOptions(existing.resumeAgentOptions, resumeAgentOptions)) {
    throw new TaskContinuationMutationConflictError(existing.callerId, existing.mutationId)
  }
}

/** Whether a durable state may still produce or recover one dispatch. */
function isActive(claim: TaskContinuationClaim): boolean {
  return claim.state === 'pending' || claim.state === 'ready' || claim.state === 'consumed'
}

/** Compare a positive verifier echo to every authority-bearing claim field. */
function matchesReady(ready: TaskContinuationReady, claim: TaskContinuationClaim): boolean {
  return ready.continuationId === claim.continuationId
    && ready.sessionId === claim.sessionId
    && ready.originalMessageId === claim.originalMessageId
    && ready.needDigest === claim.needDigest
    && ready.taskRevision === claim.taskRevision
    && ready.verificationPayloadDigest === claim.verificationPayloadDigest
}

/** Settle promptly on cancellation or deadline even when a verifier ignores its signal. */
async function verifierDecision(
  verification: Promise<TaskContinuationVerification>,
  signal: AbortSignal,
): Promise<TaskContinuationVerification | undefined> {
  if (signal.aborted) return undefined
  const aborted = Promise.withResolvers<undefined>()
  const onAbort = (): void => { aborted.resolve(undefined) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([verification, aborted.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Resolve a cancellable timer without leaving teardown-owned callbacks queued. */
function waitForTimer(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    timer.unref()
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Add a validated duration without exceeding JavaScript's exact integer range. */
function safeDeadline(nowMs: number, durationMs: number): number {
  const expiresAtMs = nowMs + durationMs
  if (!Number.isSafeInteger(expiresAtMs)) {
    throw new Error('task continuation dispatch lease deadline exceeds the safe integer range')
  }
  return expiresAtMs
}

/** Return rejection reasons in the same order as the attempted operations. */
function settledErrors(results: readonly PromiseSettledResult<unknown>[]): unknown[] {
  const errors: unknown[] = []
  for (const result of results) {
    if (result.status === 'rejected') errors.push(result.reason as unknown)
  }
  return errors
}

/** Preserve the primary operation failure before every later cleanup failure. */
function orderedErrors(message: string, errors: readonly unknown[]): unknown {
  if (errors.length === 1) return errors[0]
  return new AggregateError(errors, message, { cause: errors[0] })
}

/** Render an unknown failure for process-local diagnostics. */
function renderThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default DurableTaskContinuationDriver
