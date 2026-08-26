/** Focused lifecycle, fault, and admission coverage for the durable continuation driver. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions, PreStepDecision } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  LlmAdapter,
  MessageId,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {
  continuationDigest,
  continuationId,
  taskContinuationCallerId,
  taskContinuationMessage,
  taskContinuationMutationId,
  taskContinuationRevision,
  taskContinuationVerifierId,
  type ContinuationId,
  type CreateTaskContinuationRequest,
  type TaskContinuationClaim,
  type TaskContinuationReady,
} from '@deepseek-ai/dsh-task-continuation'
import DurableTaskContinuationDriver, {
  DEFAULT_CONTINUATION_BUSY_TIMEOUT_MS,
  DEFAULT_CONTINUATION_DISPATCH_LEASE_MS,
  DEFAULT_CONTINUATION_RECOVERY_POLL_MS,
  DEFAULT_CONTINUATION_RECOVERY_RETRY_INITIAL_MS,
  DEFAULT_CONTINUATION_RECOVERY_RETRY_MAX_MS,
  DEFAULT_CONTINUATION_VERIFIER_TIMEOUT_MS,
  MAX_CONTINUATION_VERIFIER_TIMEOUT_MS,
  type Config,
} from '../src/index.ts'
import {
  DurableTaskContinuationStore,
  type ContinuationDispatchLease,
  type ContinuationTransition,
} from '../src/store.ts'

const roots: string[] = []
const contexts: Context[] = []

class RecordingAdapter extends LlmAdapter {
  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface DriverInternals {
  readonly store: DurableTaskContinuationStore
  readonly lifetime: AbortController
  readonly verifierTimeoutMs: number
  readonly activeMaintenance: Map<SessionId, { readonly agent: Agent; readonly promise: Promise<void> }>
  readonly ownedHandles: Map<SessionId, AgentHandle>
  readonly handleDisposals: Map<SessionId, { readonly handle: AgentHandle; readonly promise: Promise<void> }>
  readonly dispatchLeases: Map<ContinuationId, {
    lease: ContinuationDispatchLease
    readonly abort: AbortController
    readonly promise: Promise<void>
  }>
  readonly reservationResumes: Map<SessionId, Promise<Agent>>
  readonly reservations: Map<string, Promise<TaskContinuationClaim>>
  readonly pendingUserWakeups: Set<SessionId>
  requested: boolean
  storeActivated: boolean
  run: Promise<void> | undefined
  dueTimer: ReturnType<typeof setTimeout> | undefined
  dueAtMs: number | undefined
  probe: Promise<void> | undefined
  stopping: boolean
  requestDrive(): void
  runRequested(): Promise<void>
  retireRun(run: Promise<void>): void
  scheduleRecoveryRetry(error: unknown, operation: string): void
  scheduleDue(delayMs: number): void
  clearDueTimer(): void
  startStoreProbe(): void
  reconcileAll(): Promise<void>
  resolveAgent(claim: TaskContinuationClaim): Promise<Agent | undefined>
  resolveReservationAgent(sessionId: SessionId, options: Readonly<AgentOptions>): Promise<Agent>
  reserveForAgent(
    agent: Agent,
    request: CreateTaskContinuationRequest,
    options: Readonly<AgentOptions>,
  ): Promise<TaskContinuationClaim>
  startMaintenance(agent: Agent, id: ContinuationId): Promise<void>
  processClaim(agent: Agent, id: ContinuationId, signal: AbortSignal): Promise<void>
  acquireOwnedDispatchLease(claim: TaskContinuationClaim): Promise<ContinuationDispatchLease | undefined>
  renewOwnedDispatchLease(claim: TaskContinuationClaim): Promise<ContinuationDispatchLease | undefined>
  maintainDispatchLease(
    id: ContinuationId,
    signal: AbortSignal,
    readOwned: () => {
      lease: ContinuationDispatchLease
      readonly abort: AbortController
      readonly promise: Promise<void>
    },
  ): Promise<void>
  retireOwnedDispatchLease(id: ContinuationId, release: boolean): Promise<void>
  admitContinuation(
    agent: Agent,
    messages: UserMessage[],
    signal: AbortSignal,
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision>
  reconcileDurableDispatch(agent: Agent, claim: TaskContinuationClaim): Promise<boolean>
  ensureExactMarker(agent: Agent, claim: TaskContinuationClaim): Promise<boolean>
  restoreOtherClaimed(
    agent: Agent,
    messages: readonly UserMessage[],
    excluded: ReadonlySet<MessageId>,
    wake?: boolean,
  ): void
  wakePendingDirectUser(agent: Agent): void
  removeOtherContinuationMarkers(agent: Agent, retained: MessageId): void
  transitionCaptured(
    claim: TaskContinuationClaim,
    to: ContinuationTransition['to'],
  ): Promise<TaskContinuationClaim | undefined>
  terminateReplacedTask(
    agent: Agent,
    claim: TaskContinuationClaim,
    claimed?: readonly UserMessage[],
    beforeSessionSeq?: number,
  ): Promise<boolean>
  removeLiveMarker(claim: TaskContinuationClaim): Promise<void>
  reconcileTerminalBestEffort(claim: TaskContinuationClaim): Promise<void>
  releaseOwnedHandleIfInactive(sessionId: SessionId, cancelMaintenance: boolean): Promise<void>
  disposeOwnedHandle(sessionId: SessionId, handle: AgentHandle): Promise<void>
  removeMarkerAndFlush(agent: Agent, claim: TaskContinuationClaim): Promise<void>
  requireSessionFlush(agent: Agent): Promise<void>
  assertLiveAgent(agent: Agent, sessionId: SessionId): void
  isExactLiveAgent(agent: Agent, sessionId: SessionId): boolean
  canContinue(signal?: AbortSignal): boolean
  isLifetimeAbort(error: unknown): boolean
  disposeDriver(): Promise<void>
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function allocateRoots(): Promise<{ sessions: string; claims: string }> {
  const sessions = await mkdtemp(join(tmpdir(), 'dsh-continuation-driver-sessions-'))
  const claims = await mkdtemp(join(tmpdir(), 'dsh-continuation-driver-claims-'))
  roots.push(sessions, claims)
  return { sessions, claims }
}

async function mountRuntime(
  rootsForRuntime: { sessions: string; claims: string },
  persistence: boolean = true,
  config: Omit<Config, 'root'> = {},
): Promise<Context> {
  const context = new Context()
  contexts.push(context)
  await mountAgentLoopTestDependencies(context)
  await context.plugin(AgentLoop, { agents: [] })
  if (persistence) {
    await context.plugin(JsonlSessionPersistence, { root: rootsForRuntime.sessions, compression: 'none' })
  }
  context.llm.registerAdapter(['mock'], new RecordingAdapter())
  await context.plugin(DurableTaskContinuationDriver, { ...config, root: rootsForRuntime.claims })
  return context
}

function driver(context: Context): DriverInternals {
  return context.taskContinuations as unknown as DriverInternals
}

function request(
  sessionId: SessionId,
  originalMessageId: MessageId,
  suffix: string,
  expiresAtMs: number = Date.now() + 60_000,
): CreateTaskContinuationRequest {
  return {
    callerId: taskContinuationCallerId('driver-tests'),
    mutationId: taskContinuationMutationId(suffix),
    sessionId,
    originalMessageId,
    needDigest: continuationDigest(`sha256:${'1'.repeat(64)}`),
    taskRevision: taskContinuationRevision(`revision-${suffix}`),
    verifierId: taskContinuationVerifierId('driver-verifier'),
    verificationPayloadDigest: continuationDigest(`sha256:${'2'.repeat(64)}`),
    expiresAtMs,
  }
}

async function pendingClaim(context: Context, suffix: string): Promise<{
  agent: Agent
  claim: TaskContinuationClaim
  original: UserMessage
}> {
  const sessionId = SessionId(`driver-${suffix}`)
  const handle = await context.agents.create({
    sessionId,
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  const original = createUserMessage({
    content: [{ type: 'text', text: 'original task' }],
    source: { kind: 'user' },
  })
  handle.agent.followup(original)
  await handle.agent.whenIdle()
  const claim = await context.taskContinuations.create(handle.agent, request(sessionId, original.id, suffix))
  return { agent: handle.agent, claim, original }
}

function terminal(claim: TaskContinuationClaim, state: TaskContinuationClaim['state']): TaskContinuationClaim {
  return Object.freeze({ ...claim, state, recordRevision: claim.recordRevision + 1, updatedAtMs: Date.now() })
}

function ready(claim: TaskContinuationClaim): TaskContinuationReady {
  return {
    kind: 'ready',
    continuationId: claim.continuationId,
    sessionId: claim.sessionId,
    originalMessageId: claim.originalMessageId,
    needDigest: claim.needDigest,
    taskRevision: claim.taskRevision,
    verificationPayloadDigest: claim.verificationPayloadDigest,
  }
}

function dispatchLease(claim: TaskContinuationClaim): ContinuationDispatchLease {
  return {
    continuationId: claim.continuationId,
    recordRevision: claim.recordRevision,
    ownerId: 'driver-test-owner',
    incarnation: 1,
    expiresAtMs: Date.now() + 60_000,
  }
}

interface TestInbox {
  readonly nextStep: UserMessage[]
  readonly nextTurn: UserMessage[]
  remove(id: MessageId): boolean
  prepend(target: 'next-step' | 'next-turn', message: UserMessage): void
}

type TestAgent = Agent & { readonly inbox: TestInbox }

function fakeAgent(claim: TaskContinuationClaim, events: unknown[] = []): TestAgent {
  const nextStep: UserMessage[] = []
  const nextTurn: UserMessage[] = []
  const remove = (id: MessageId): boolean => {
    const before = nextStep.length + nextTurn.length
    for (const queue of [nextStep, nextTurn]) {
      const index = queue.findIndex(message => message.id === id)
      if (index >= 0) queue.splice(index, 1)
    }
    return before !== nextStep.length + nextTurn.length
  }
  const prepend = (target: 'next-step' | 'next-turn', message: UserMessage): void => {
    ;(target === 'next-step' ? nextStep : nextTurn).unshift(message)
  }
  return {
    id: claim.sessionId,
    session: { id: claim.sessionId, events },
    inbox: { nextStep, nextTurn, remove, prepend },
    send: vi.fn((message: UserMessage, target: 'next-step' | 'next-turn') => {
      ;(target === 'next-step' ? nextStep : nextTurn).push(message)
    }),
  } as unknown as TestAgent
}

describe('durable task continuation driver boundaries', () => {
  it('defaults and bounds the verifier decision deadline', () => {
    expect(DurableTaskContinuationDriver.Config({ root: 'claims' })).toEqual({
      root: 'claims',
      busyTimeoutMs: DEFAULT_CONTINUATION_BUSY_TIMEOUT_MS,
      verifierTimeoutMs: DEFAULT_CONTINUATION_VERIFIER_TIMEOUT_MS,
      dispatchLeaseMs: DEFAULT_CONTINUATION_DISPATCH_LEASE_MS,
      recoveryPollMs: DEFAULT_CONTINUATION_RECOVERY_POLL_MS,
      recoveryRetryInitialMs: DEFAULT_CONTINUATION_RECOVERY_RETRY_INITIAL_MS,
      recoveryRetryMaxMs: DEFAULT_CONTINUATION_RECOVERY_RETRY_MAX_MS,
    })
    expect(DurableTaskContinuationDriver.Config({
      root: 'claims',
      verifierTimeoutMs: MAX_CONTINUATION_VERIFIER_TIMEOUT_MS,
    })).toMatchObject({ verifierTimeoutMs: MAX_CONTINUATION_VERIFIER_TIMEOUT_MS })
    for (const verifierTimeoutMs of [0, 1.5, Number.NaN, MAX_CONTINUATION_VERIFIER_TIMEOUT_MS + 1]) {
      expect(() => DurableTaskContinuationDriver.Config({ root: 'claims', verifierTimeoutMs })).toThrow()
    }
  })

  it('rejects a recovery retry maximum below its initial delay', async () => {
    const context = new Context()
    expect(() => new DurableTaskContinuationDriver(context, {
      root: 'claims',
      recoveryRetryInitialMs: 2,
      recoveryRetryMaxMs: 1,
    })).toThrow('recoveryRetryMaxMs must be at least recoveryRetryInitialMs')
    await context.fiber.dispose()
  })

  it('keeps read and terminal no-ops side-effect free before the database exists', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const missingId = continuationId('11111111-1111-4111-8111-111111111111')
    const missingSession = SessionId('missing-session')

    await expect(context.taskContinuations.get(missingId)).resolves.toBeUndefined()
    await expect(context.taskContinuations.list()).resolves.toEqual([])
    await expect(context.taskContinuations.cancel({
      id: missingId,
      sessionId: missingSession,
      taskRevision: taskContinuationRevision('missing'),
    })).resolves.toBe(false)
    await expect(context.taskContinuations.supersede({
      id: missingId,
      sessionId: missingSession,
      taskRevision: taskContinuationRevision('missing'),
      replacementTaskRevision: taskContinuationRevision('replacement'),
    })).resolves.toBe(false)
    await expect(context.taskContinuations.list({
      mutationId: taskContinuationMutationId('orphan-mutation'),
    }))
      .rejects.toThrow(/requires callerId/)
  })

  it('activates externally created state and coalesces every due-work source', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots, true, { recoveryPollMs: 10_000 })
    const internal = driver(context)
    internal.clearDueTimer()
    const external = new DurableTaskContinuationStore(runtimeRoots.claims, 1_000)
    await external.initialize()
    await external.close()
    const requested = vi.spyOn(internal, 'requestDrive').mockImplementation(() => undefined)
    await expect(context.taskContinuations.get(
      continuationId('10101010-1010-4010-8010-101010101010'),
    )).resolves.toBeUndefined()
    expect(internal.storeActivated).toBe(true)
    expect(requested).toHaveBeenCalledOnce()

    internal.scheduleDue(50)
    const later = internal.dueAtMs
    internal.scheduleDue(100)
    expect(internal.dueAtMs).toBe(later)
    internal.scheduleDue(5)
    expect(internal.dueAtMs).toBeLessThan(later ?? Number.POSITIVE_INFINITY)
    await new Promise<void>(resolve => setTimeout(resolve, 15))
    expect(requested).toHaveBeenCalledTimes(2)

    internal.storeActivated = false
    const probeStarted = vi.spyOn(internal, 'startStoreProbe').mockImplementation(() => undefined)
    internal.scheduleDue(5)
    await new Promise<void>(resolve => setTimeout(resolve, 15))
    expect(probeStarted).toHaveBeenCalledOnce()
    probeStarted.mockRestore()

    const initializeIfPresent = vi.spyOn(internal.store, 'initializeIfPresent')
    initializeIfPresent.mockResolvedValueOnce(false)
    internal.startStoreProbe()
    const absentProbe = internal.probe
    internal.startStoreProbe()
    await absentProbe
    expect(internal.dueTimer).toBeDefined()
    internal.clearDueTimer()

    const retry = vi.spyOn(internal, 'scheduleRecoveryRetry').mockImplementation(() => undefined)
    initializeIfPresent.mockRejectedValueOnce(new Error('probe fault'))
    internal.startStoreProbe()
    await internal.probe
    expect(retry).toHaveBeenCalledWith(expect.any(Error), 'durable store probe failed')

    const probeResult = Promise.withResolvers<boolean>()
    initializeIfPresent.mockReturnValueOnce(probeResult.promise)
    internal.startStoreProbe()
    const staleProbe = internal.probe
    const replacementProbe = Promise.resolve()
    internal.probe = replacementProbe
    probeResult.resolve(false)
    await staleProbe
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(internal.probe).toBe(replacementProbe)
    internal.probe = undefined

    const retirementFault = new Error('probe retirement failed')
    initializeIfPresent.mockRejectedValueOnce(new Error('probe initialization failed'))
    retry.mockImplementationOnce(() => { throw retirementFault })
    internal.startStoreProbe()
    const rejectedProbe = internal.probe
    await expect(rejectedProbe).rejects.toBe(retirementFault)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(internal.probe).toBeUndefined()

    initializeIfPresent.mockResolvedValueOnce(true)
    internal.startStoreProbe()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(requested).toHaveBeenCalledTimes(3)
    expect(() => { internal.scheduleDue(Number.MAX_SAFE_INTEGER) }).toThrow('safe integer range')

    internal.stopping = true
    internal.clearDueTimer()
    internal.scheduleDue(1)
    internal.startStoreProbe()
    expect(internal.dueTimer).toBeUndefined()
    const lifetimeReason = new Error('provider lifetime ended')
    internal.lifetime.abort(lifetimeReason)
    expect(internal.isLifetimeAbort(lifetimeReason)).toBe(true)
    expect(internal.isLifetimeAbort(new Error('other'))).toBe(false)
  })

  it('automatically converges after one transient durable-store probe failure', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots, true, {
      recoveryPollMs: 60_000,
      recoveryRetryInitialMs: 1,
      recoveryRetryMaxMs: 1,
    })
    const internal = driver(context)
    internal.clearDueTimer()
    internal.storeActivated = false
    const probe = vi.spyOn(internal.store, 'initializeIfPresent')
      .mockRejectedValueOnce(new Error('transient store open fault'))
      .mockResolvedValue(true)
    const warn = vi.spyOn(context.logger, 'warn').mockImplementation(() => undefined)

    internal.startStoreProbe()
    await new Promise<void>((resolve, reject) => {
      const startedAt = Date.now()
      const poll = (): void => {
        if (internal.storeActivated) resolve()
        else if (Date.now() - startedAt > 1_000) reject(new Error('store retry did not converge'))
        else setTimeout(poll, 1)
      }
      poll()
    })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('transient store open fault'))
  })

  it('rejects malformed creation identities, deadlines, stale agents, missing originals, and option mismatches', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const sessionId = SessionId('driver-boundary-errors')
    const handle = await context.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const missing = MessageId('missing-original')
    const valid = request(sessionId, missing, 'boundary')

    await expect(context.taskContinuations.create(handle.agent, { ...valid, expiresAtMs: Number.NaN }))
      .rejects.toThrow(/non-negative/)
    await expect(context.taskContinuations.create(handle.agent, { ...valid, expiresAtMs: -1 }))
      .rejects.toThrow(/non-negative/)
    await expect(context.taskContinuations.create(handle.agent, { ...valid, sessionId: SessionId('') }))
      .rejects.toThrow(/must be non-empty/)
    await expect(context.taskContinuations.create(handle.agent, { ...valid, originalMessageId: MessageId('') }))
      .rejects.toThrow(/must be non-empty/)
    await expect(context.taskContinuations.create(handle.agent, valid))
      .rejects.toThrow(/is not in session/)
    await expect(context.taskContinuations.reserve({
      ...valid,
      originalMessageId: missing,
      resumeAgentOptions: { provider: 'other', model: 'mock' },
    })).rejects.toThrow(/resume options do not match live session/)
    await expect(context.taskContinuations.reserve({
      ...valid,
      expiresAtMs: Date.now() - 1,
      resumeAgentOptions: { provider: 'mock', model: 'mock' },
    })).rejects.toThrow(/must be a future/)

    const other = await context.agents.create({
      sessionId: SessionId('driver-other-agent'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await expect(context.taskContinuations.create(other.agent, valid))
      .rejects.toThrow(/requires exact live session/)
  })

  it('replays exact live reservations and supports successful cancel and supersede cleanup', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const first = await pendingClaim(context, 'replay')
    const replayed = await context.taskContinuations.create(
      first.agent,
      request(first.agent.id, first.original.id, 'replay', first.claim.expiresAtMs),
    )
    expect(replayed.continuationId).toBe(first.claim.continuationId)
    await expect(context.taskContinuations.cancel({
      id: first.claim.continuationId,
      sessionId: first.claim.sessionId,
      taskRevision: first.claim.taskRevision,
    })).resolves.toBe(true)

    const second = await pendingClaim(context, 'supersede')
    await expect(context.taskContinuations.supersede({
      id: second.claim.continuationId,
      sessionId: second.claim.sessionId,
      taskRevision: second.claim.taskRevision,
      replacementTaskRevision: taskContinuationRevision('replacement-revision'),
    })).resolves.toBe(true)
  })

  it('replays the store winner when another process wins between lookup and reservation', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const base = await pendingClaim(context, 'store-reservation-race')
    vi.spyOn(internal.store, 'getByMutation').mockResolvedValueOnce(undefined)
    vi.spyOn(internal.store, 'createOrGet').mockResolvedValueOnce({
      created: false,
      claim: base.claim,
    })
    const drive = vi.spyOn(internal, 'requestDrive').mockImplementation(() => undefined)

    await expect(internal.reserveForAgent(
      base.agent,
      request(base.claim.sessionId, base.original.id, 'store-reservation-race', base.claim.expiresAtMs),
      base.claim.resumeAgentOptions,
    )).resolves.toBe(base.claim)
    expect(drive).toHaveBeenCalled()
  })

  it('detaches every management request before the first asynchronous store boundary', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const cancelTarget = await pendingClaim(context, 'detached-cancel-target')
    const cancelDecoy = await pendingClaim(context, 'detached-cancel-decoy')
    const cancelRequest = {
      id: cancelTarget.claim.continuationId,
      sessionId: cancelTarget.claim.sessionId,
      taskRevision: cancelTarget.claim.taskRevision,
    }

    const cancellation = context.taskContinuations.cancel(cancelRequest)
    cancelRequest.id = cancelDecoy.claim.continuationId
    cancelRequest.sessionId = cancelDecoy.claim.sessionId
    cancelRequest.taskRevision = cancelDecoy.claim.taskRevision
    await expect(cancellation).resolves.toBe(true)
    await expect(context.taskContinuations.get(cancelTarget.claim.continuationId))
      .resolves.toMatchObject({ state: 'canceled' })
    await expect(context.taskContinuations.get(cancelDecoy.claim.continuationId))
      .resolves.toMatchObject({ state: 'pending' })

    const supersedeDecoy = await pendingClaim(context, 'detached-supersede-decoy')
    const supersedeRequest = {
      id: cancelDecoy.claim.continuationId,
      sessionId: cancelDecoy.claim.sessionId,
      taskRevision: cancelDecoy.claim.taskRevision,
      replacementTaskRevision: taskContinuationRevision('detached-replacement'),
    }
    const supersession = context.taskContinuations.supersede(supersedeRequest)
    supersedeRequest.id = supersedeDecoy.claim.continuationId
    supersedeRequest.sessionId = supersedeDecoy.claim.sessionId
    supersedeRequest.taskRevision = supersedeDecoy.claim.taskRevision
    supersedeRequest.replacementTaskRevision = taskContinuationRevision('mutated-replacement')
    await expect(supersession).resolves.toBe(true)
    await expect(context.taskContinuations.get(cancelDecoy.claim.continuationId)).resolves.toMatchObject({
      state: 'superseded',
      supersededByTaskRevision: 'detached-replacement',
    })
    await expect(context.taskContinuations.get(supersedeDecoy.claim.continuationId))
      .resolves.toMatchObject({ state: 'pending' })

    const listRequest = { sessionId: cancelTarget.claim.sessionId }
    const listing = context.taskContinuations.list(listRequest)
    listRequest.sessionId = supersedeDecoy.claim.sessionId
    await expect(listing).resolves.toEqual([
      expect.objectContaining({ continuationId: cancelTarget.claim.continuationId }),
    ])
  })

  it('invalidates a reservation when its first marker cannot be durably checkpointed', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const sessionId = SessionId('driver-missing-persistence')
    const handle = await context.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const original = createUserMessage({
      content: [{ type: 'text', text: 'task' }],
      source: { kind: 'user' },
    })
    handle.agent.followup(original)
    await handle.agent.whenIdle()
    vi.spyOn(context.sessions, 'flush').mockResolvedValue(false)

    await expect(context.taskContinuations.create(handle.agent, request(sessionId, original.id, 'no-persistence')))
      .rejects.toThrow(/has no persistence participant/)
    await expect(context.taskContinuations.list()).resolves.toEqual([
      expect.objectContaining({ state: 'invalid' }),
    ])
  })

  it('preserves the reservation failure before every invalidation cleanup failure', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const sessionId = SessionId('driver-reservation-cleanup-order')
    const handle = await context.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const original = createUserMessage({
      content: [{ type: 'text', text: 'task' }],
      source: { kind: 'user' },
    })
    handle.agent.followup(original)
    await handle.agent.whenIdle()
    const primary = new Error('marker checkpoint failed')
    const transitionCleanup = new Error('invalidation failed')
    const flushCleanup = new Error('marker cleanup checkpoint failed')
    const flush = vi.spyOn(context.sessions, 'flush')
      .mockRejectedValueOnce(primary)
      .mockRejectedValueOnce(flushCleanup)
    const transition = vi.spyOn(internal.store, 'transition').mockRejectedValueOnce(transitionCleanup)

    try {
      await context.taskContinuations.create(handle.agent, request(sessionId, original.id, 'cleanup-order'))
      expect.unreachable('reservation ignored durability failures')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toEqual([primary, transitionCleanup, flushCleanup])
      expect((error as AggregateError).cause).toBe(primary)
    }

    const retained = (await internal.store.list())[0]
    if (retained === undefined) throw new Error('failed reservation record disappeared')
    const secondPrimary = new Error('second marker checkpoint failed')
    const handleCleanup = new Error('cold handle release failed')
    flush.mockRejectedValueOnce(secondPrimary).mockResolvedValueOnce(true)
    transition.mockResolvedValue(terminal(retained, 'invalid'))
    const releaseHandle = vi.spyOn(internal, 'releaseOwnedHandleIfInactive').mockRejectedValue(handleCleanup)
    try {
      await context.taskContinuations.create(handle.agent, request(sessionId, original.id, 'release-cleanup'))
      expect.unreachable('reservation ignored handle cleanup failure')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toEqual([secondPrimary, handleCleanup])
    }
    expect(releaseHandle).toHaveBeenCalled()
  })

  it('filters every list identity independently', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const pending = await pendingClaim(context, 'filters')

    await expect(context.taskContinuations.list({ sessionId: SessionId('other') })).resolves.toEqual([])
    await expect(context.taskContinuations.list({
      callerId: taskContinuationCallerId('other'),
    })).resolves.toEqual([])
    await expect(context.taskContinuations.list({
      callerId: pending.claim.callerId,
      mutationId: taskContinuationMutationId('other'),
    })).resolves.toEqual([])
    await expect(context.taskContinuations.list({
      callerId: pending.claim.callerId,
      mutationId: pending.claim.mutationId,
      sessionId: pending.claim.sessionId,
    })).resolves.toEqual([expect.objectContaining({ continuationId: pending.claim.continuationId })])
  })
})

describe('durable task continuation driver lifecycle faults', () => {
  it('attempts every teardown, preserves primary error order, and retains an unreleased cold handle', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const sessionId = SessionId('driver-unreleased-cold-handle')
    const handle = await context.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    internal.ownedHandles.set(sessionId, handle)
    const primary = new Error('active scan failed')
    const run = Promise.reject(primary)
    void run.catch(() => undefined)
    internal.run = run
    const cleanup = new Error('cold handle stayed live')
    const dispose = vi.spyOn(handle, 'dispose').mockRejectedValue(cleanup)

    try {
      await internal.disposeDriver()
      expect.unreachable('driver teardown accepted an unreleased handle')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toEqual([primary, cleanup])
    }
    expect(dispose).toHaveBeenCalledOnce()
    expect(internal.ownedHandles.get(sessionId)).toBe(handle)
    expect(context.agents.get(sessionId)).toBe(handle.agent)
    dispose.mockRestore()
    await handle.dispose()
  })

  it('awaits store close after active work and preserves teardown failure order', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const probeFailure = new Error('active probe failed')
    internal.probe = Promise.reject(probeFailure)
    internal.reservationResumes.set(
      SessionId('driver-teardown-resume'),
      Promise.resolve({ id: SessionId('driver-teardown-resume') } as Agent),
    )
    internal.reservations.set(
      'driver-teardown-reservation',
      Promise.resolve({} as TaskContinuationClaim),
    )
    const closeFailure = new Error('store close failed')
    const closeStarted = Promise.withResolvers<undefined>()
    const releaseClose = Promise.withResolvers<undefined>()
    const close = internal.store.close.bind(internal.store)
    vi.spyOn(internal.store, 'close').mockImplementation(async () => {
      closeStarted.resolve(undefined)
      await releaseClose.promise
      await close()
      throw closeFailure
    })

    let settled = false
    const disposing = internal.disposeDriver()
    const observedDisposal = disposing.then(
      () => { settled = true },
      () => { settled = true },
    )
    await closeStarted.promise
    await Promise.resolve()
    expect(settled).toBe(false)
    releaseClose.resolve(undefined)
    try {
      await disposing
      expect.unreachable('driver teardown ignored ordered close failure')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toEqual([probeFailure, closeFailure])
    }
    await observedDisposal
    expect(internal.reservationResumes.size).toBe(0)
    expect(internal.reservations.size).toBe(0)
  })

  it('uses the constructor timeout fallback and reacts to an explicit Agent disposal', async () => {
    const runtimeRoots = await allocateRoots()
    const bare = new Context()
    contexts.push(bare)
    const constructed = new DurableTaskContinuationDriver(bare, { root: runtimeRoots.claims })
    expect(constructed.protocolVersion).toBe(1)
    expect((constructed as unknown as DriverInternals).verifierTimeoutMs)
      .toBe(DEFAULT_CONTINUATION_VERIFIER_TIMEOUT_MS)

    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    internal.storeActivated = true
    const drive = vi.spyOn(internal, 'requestDrive')
    const handle = await context.agents.create({
      sessionId: SessionId('driver-explicit-dispose'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    drive.mockClear()
    await handle.dispose()
    expect(drive).toHaveBeenCalled()
  })

  it('retires completed and failed heartbeat owners and detects renewal authority loss', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots, true, { dispatchLeaseMs: 3 })
    const internal = driver(context)
    const base = await pendingClaim(context, 'heartbeat-authority')
    const consumed = Object.freeze({ ...base.claim, state: 'consumed' as const, recordRevision: 2 })
    const lease = dispatchLease(consumed)
    vi.spyOn(internal.store, 'acquireDispatchLease').mockResolvedValue(lease)
    const retry = vi.spyOn(internal, 'scheduleRecoveryRetry').mockImplementation(() => undefined)
    const maintain = vi.spyOn(internal, 'maintainDispatchLease').mockResolvedValueOnce(undefined)

    await expect(internal.acquireOwnedDispatchLease(consumed)).resolves.toBe(lease)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(internal.dispatchLeases.has(consumed.continuationId)).toBe(false)

    const heartbeatFault = new Error('heartbeat failed')
    maintain.mockRejectedValueOnce(heartbeatFault)
    await expect(internal.acquireOwnedDispatchLease(consumed)).resolves.toBe(lease)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(internal.dispatchLeases.has(consumed.continuationId)).toBe(false)
    expect(retry).toHaveBeenCalledWith(heartbeatFault, expect.stringContaining('renewal failed'))

    const lateFault = new Error('stale heartbeat failed')
    const lateHeartbeat = Promise.withResolvers<undefined>()
    maintain.mockReturnValueOnce(lateHeartbeat.promise)
    await internal.acquireOwnedDispatchLease(consumed)
    const replacement = {
      lease: { ...lease, incarnation: 2 },
      abort: new AbortController(),
      promise: Promise.resolve(),
    }
    internal.dispatchLeases.set(consumed.continuationId, replacement)
    lateHeartbeat.reject(lateFault)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(internal.dispatchLeases.get(consumed.continuationId)).toBe(replacement)
    internal.dispatchLeases.clear()
    maintain.mockRestore()

    const preAborted = new AbortController()
    preAborted.abort()
    const owned = { lease, abort: preAborted, promise: Promise.resolve() }
    await expect(internal.maintainDispatchLease(
      consumed.continuationId,
      preAborted.signal,
      () => owned,
    )).resolves.toBeUndefined()

    const renew = vi.spyOn(internal.store, 'renewDispatchLease').mockResolvedValueOnce(undefined)
    const lost = new AbortController()
    await expect(internal.maintainDispatchLease(
      consumed.continuationId,
      lost.signal,
      () => ({ lease, abort: lost, promise: Promise.resolve() }),
    )).resolves.toBeUndefined()
    expect(renew).toHaveBeenCalledOnce()

    const mismatch = { lease, abort: new AbortController(), promise: Promise.resolve() }
    renew.mockResolvedValueOnce({ ...lease, expiresAtMs: lease.expiresAtMs + 1 })
    await expect(internal.maintainDispatchLease(
      consumed.continuationId,
      mismatch.abort.signal,
      () => mismatch,
    )).resolves.toBeUndefined()
  })

  it('fences stale local leases and preserves heartbeat failure before release failure', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const base = await pendingClaim(context, 'lease-cleanup-order')
    const consumed = Object.freeze({ ...base.claim, state: 'consumed' as const, recordRevision: 2 })
    const lease = dispatchLease(consumed)

    await expect(internal.renewOwnedDispatchLease(consumed)).resolves.toBeUndefined()
    const stale = { lease, abort: new AbortController(), promise: Promise.resolve() }
    internal.dispatchLeases.set(consumed.continuationId, stale)
    vi.spyOn(internal.store, 'holdsDispatchLease').mockResolvedValue(false)
    vi.spyOn(internal.store, 'acquireDispatchLease').mockResolvedValue({ ...lease, incarnation: 2 })
    const heartbeat = Promise.withResolvers<undefined>()
    vi.spyOn(internal, 'maintainDispatchLease').mockReturnValue(heartbeat.promise)
    await expect(internal.acquireOwnedDispatchLease(consumed)).resolves.toMatchObject({ incarnation: 2 })
    expect(stale.abort.signal.aborted).toBe(true)
    heartbeat.resolve(undefined)
    await new Promise<void>(resolve => setImmediate(resolve))

    const renewalLost = vi.spyOn(internal.store, 'renewDispatchLease').mockResolvedValue(undefined)
    internal.dispatchLeases.set(consumed.continuationId, {
      lease: { ...lease, incarnation: 2 },
      abort: new AbortController(),
      promise: Promise.resolve(),
    })
    await expect(internal.renewOwnedDispatchLease(consumed)).resolves.toBeUndefined()
    expect(renewalLost).toHaveBeenCalledOnce()

    const retirement = Promise.withResolvers<undefined>()
    const retiring = {
      lease,
      abort: new AbortController(),
      promise: retirement.promise,
    }
    const replacement = {
      lease: { ...lease, incarnation: 3 },
      abort: new AbortController(),
      promise: Promise.resolve(),
    }
    internal.dispatchLeases.set(consumed.continuationId, retiring)
    const retirementRun = internal.retireOwnedDispatchLease(consumed.continuationId, false)
    internal.dispatchLeases.set(consumed.continuationId, replacement)
    retirement.resolve(undefined)
    await retirementRun
    expect(internal.dispatchLeases.get(consumed.continuationId)).toBe(replacement)

    const primary = new Error('heartbeat cleanup failed')
    const cleanup = new Error('lease release failed')
    const failedHeartbeat = Promise.reject(primary)
    void failedHeartbeat.catch(() => undefined)
    internal.dispatchLeases.set(consumed.continuationId, {
      lease,
      abort: new AbortController(),
      promise: failedHeartbeat,
    })
    vi.spyOn(internal.store, 'releaseDispatchLease').mockRejectedValue(cleanup)
    try {
      await internal.retireOwnedDispatchLease(consumed.continuationId, true)
      expect.unreachable('lease cleanup ignored failures')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toEqual([primary, cleanup])
      expect((error as AggregateError).cause).toBe(primary)
    }
    expect(internal.dispatchLeases.has(consumed.continuationId)).toBe(true)
  })

  it('waits for active ownership and disposes a cold handle exactly once after the last claim', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const sessionId = SessionId('driver-handle-release-fences')
    const handle = await context.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    internal.ownedHandles.set(sessionId, handle)
    vi.spyOn(internal.store, 'hasActiveForSession')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
    const dispose = vi.spyOn(handle, 'dispose').mockResolvedValue(undefined)

    await internal.releaseOwnedHandleIfInactive(SessionId('missing-handle'), true)
    await internal.releaseOwnedHandleIfInactive(sessionId, true)
    const cancel = vi.fn()
    internal.activeMaintenance.set(sessionId, {
      agent: { cancel } as unknown as Agent,
      promise: Promise.resolve(),
    })
    await internal.releaseOwnedHandleIfInactive(sessionId, false)
    await internal.releaseOwnedHandleIfInactive(sessionId, true)
    expect(cancel).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()
    await internal.releaseOwnedHandleIfInactive(sessionId, true)
    expect(cancel).toHaveBeenCalledTimes(2)
    expect(dispose).toHaveBeenCalledOnce()
    expect(internal.ownedHandles.has(sessionId)).toBe(false)

    const inFlight = Promise.withResolvers<undefined>()
    const replacement = { agent: handle.agent, dispose: vi.fn() } as AgentHandle
    internal.ownedHandles.set(sessionId, handle)
    dispose.mockReturnValueOnce(inFlight.promise)
    const disposing = internal.disposeOwnedHandle(sessionId, handle)
    const sameDisposal = internal.disposeOwnedHandle(sessionId, handle)
    internal.ownedHandles.set(sessionId, replacement)
    internal.handleDisposals.set(sessionId, { handle: replacement, promise: Promise.resolve() })
    inFlight.resolve(undefined)
    await Promise.all([disposing, sameDisposal])
    expect(internal.ownedHandles.get(sessionId)).toBe(replacement)
    expect(internal.handleDisposals.get(sessionId)?.handle).toBe(replacement)
  })

  it('coalesces recovery triggers, logs synchronous and asynchronous scanner failures, and retires exact runs', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    internal.storeActivated = true
    internal.stopping = false
    internal.run = undefined
    const warn = vi.spyOn(context.logger, 'warn').mockImplementation(() => undefined)
    const withoutInitiator = vi.spyOn(context.agents, 'withoutInitiator')

    withoutInitiator.mockImplementationOnce(() => { throw 'sync recovery failure' })
    internal.requestDrive()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sync recovery failure'))

    const rejected = Promise.reject(new Error('async recovery failure'))
    withoutInitiator.mockReturnValueOnce(rejected)
    internal.run = undefined
    internal.requestDrive()
    await rejected.catch(() => undefined)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('async recovery failure'))

    const active = Promise.resolve()
    internal.run = active
    internal.retireRun(Promise.resolve())
    expect(internal.run).toBe(active)
    internal.requested = true
    internal.stopping = true
    internal.retireRun(active)
    expect(internal.run).toBeUndefined()
  })

  it('reconciles terminal, expired, busy, and stopped claims without crossing their lifecycle fences', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const { claim } = await pendingClaim(context, 'reconcile-branches')
    internal.stopping = false
    const terminalClaim = terminal(claim, 'claimed')
    const expiredClaim = Object.freeze({ ...claim, expiresAtMs: Date.now() - 1 })
    const activeClaim = Object.freeze({ ...claim, continuationId: continuationId('22222222-2222-4222-8222-222222222222') })
    const remove = vi.spyOn(internal, 'removeLiveMarker').mockResolvedValue(undefined)
    const transition = vi.spyOn(internal, 'transitionCaptured')
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(terminal(expiredClaim, 'expired'))
    const resolve = vi.spyOn(internal, 'resolveAgent')
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ status: 'running' } as unknown as Agent)
    vi.spyOn(internal.store, 'list').mockResolvedValue([
      terminalClaim,
      expiredClaim,
      Object.freeze({ ...expiredClaim, continuationId: continuationId('33333333-3333-4333-8333-333333333333') }),
      activeClaim,
      Object.freeze({ ...activeClaim, continuationId: continuationId('44444444-4444-4444-8444-444444444444') }),
    ])

    await internal.reconcileAll()
    expect(remove).toHaveBeenCalledWith(terminalClaim)
    expect(transition).toHaveBeenCalledTimes(2)
    expect(resolve).toHaveBeenCalledTimes(2)

    internal.stopping = true
    await internal.reconcileAll()
  })

  it('resolves live, unavailable, owned, stopped-after-resume, and failed cold agents', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const { agent, claim } = await pendingClaim(context, 'resolve-agent')

    await expect(internal.resolveAgent(claim)).resolves.toBe(agent)

    const missingSession = SessionId('driver-resolve-missing')
    const missing = Object.freeze({ ...claim, sessionId: missingSession })
    vi.spyOn(context.sessions, 'get').mockReturnValueOnce(agent.session)
    await expect(internal.resolveAgent(missing)).resolves.toBeUndefined()

    const ownedAgent = Object.assign({}, agent, { id: missingSession }) as Agent
    const ownedHandle = { agent: ownedAgent, dispose: vi.fn() }
    const failedRelease = Promise.reject(new Error('prior handle release failed'))
    void failedRelease.catch(() => undefined)
    internal.handleDisposals.set(missingSession, { handle: ownedHandle, promise: failedRelease })
    internal.ownedHandles.set(missingSession, ownedHandle)
    await expect(internal.resolveAgent(missing)).resolves.toBe(ownedAgent)
    internal.handleDisposals.clear()
    internal.ownedHandles.clear()

    const dispose = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(context.agents, 'resume').mockImplementationOnce(async () => {
      internal.stopping = true
      return { agent: ownedAgent, dispose }
    })
    await expect(internal.resolveAgent(missing)).resolves.toBeUndefined()
    expect(dispose).toHaveBeenCalledOnce()

    internal.stopping = false
    const resume = vi.spyOn(context.agents, 'resume').mockRejectedValueOnce(new Error('resume failure'))
    await expect(internal.resolveAgent(missing)).rejects.toThrow(/could not resume session/)

    const teardownSession = Object.freeze({ ...claim, sessionId: SessionId('driver-resolve-teardown') })
    resume.mockImplementationOnce(({ signal }) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => { reject(signal.reason as Error) }, { once: true })
    }))
    const resolving = internal.resolveAgent(teardownSession)
    await Promise.resolve()
    await expect(internal.disposeDriver()).resolves.toBeUndefined()
    await expect(resolving).resolves.toBeUndefined()
  })

  it('rejects unavailable and stopped cold reservations while reusing owned authority', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const { agent } = await pendingClaim(context, 'resolve-reservation')
    const missing = SessionId('driver-reservation-missing')
    const options = { provider: 'mock', model: 'mock' }

    await expect(internal.resolveReservationAgent(agent.id, options)).resolves.toBe(agent)
    vi.spyOn(context.sessions, 'get').mockReturnValueOnce(agent.session)
    await expect(internal.resolveReservationAgent(missing, options)).rejects.toThrow(/unavailable/)

    const ownedAgent = Object.assign({}, agent, { id: missing }) as Agent
    const ownedHandle = { agent: ownedAgent, dispose: vi.fn() }
    internal.handleDisposals.set(missing, { handle: ownedHandle, promise: Promise.resolve() })
    internal.ownedHandles.set(missing, ownedHandle)
    await expect(internal.resolveReservationAgent(missing, options)).resolves.toBe(ownedAgent)
    internal.handleDisposals.clear()
    internal.ownedHandles.clear()

    const dispose = vi.fn().mockResolvedValue(undefined)
    const resume = vi.spyOn(context.agents, 'resume').mockImplementationOnce(async () => {
      internal.stopping = true
      return { agent: ownedAgent, dispose }
    })
    await expect(internal.resolveReservationAgent(missing, options)).rejects.toThrow(/stopped during cold reservation/)
    expect(dispose).toHaveBeenCalledOnce()

    internal.stopping = false
    resume.mockRejectedValueOnce(new Error('cold resume failed'))
    await expect(internal.resolveReservationAgent(missing, options)).rejects.toThrow(/cold resume failed/)
    resume.mockResolvedValueOnce({ agent: ownedAgent, dispose })
    await expect(internal.resolveReservationAgent(missing, options)).resolves.toBe(ownedAgent)
    expect(resume).toHaveBeenCalledTimes(3)
  })

  it('handles duplicate, busy, rejected, stopped, and stale maintenance ownership', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const { claim } = await pendingClaim(context, 'maintenance-faults')
    const warn = vi.spyOn(context.logger, 'warn').mockImplementation(() => undefined)
    const process = vi.spyOn(internal, 'processClaim').mockResolvedValue(undefined)
    const id = claim.sessionId

    const duplicate = { id } as Agent
    internal.activeMaintenance.set(id, { agent: duplicate, promise: Promise.resolve() })
    await internal.startMaintenance(duplicate, claim.continuationId)
    expect(process).not.toHaveBeenCalled()
    internal.activeMaintenance.clear()

    const busy = {
      id,
      runMaintenance: () => { throw new Error('busy') },
    } as unknown as Agent
    await internal.startMaintenance(busy, claim.continuationId)

    const rejected = Promise.reject(new Error('maintenance rejected'))
    const failing = {
      id,
      runMaintenance: () => rejected,
    } as unknown as Agent
    internal.stopping = false
    await internal.startMaintenance(failing, claim.continuationId)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('maintenance rejected'))

    const stoppedFailure = Promise.reject(new Error('stopped rejection'))
    const stopped = {
      id,
      runMaintenance: () => stoppedFailure,
    } as unknown as Agent
    internal.stopping = true
    await internal.startMaintenance(stopped, claim.continuationId)
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('stopped rejection'))

    internal.stopping = false
    const release = Promise.withResolvers<undefined>()
    const stale = {
      id,
      runMaintenance: () => release.promise,
    } as unknown as Agent
    const running = internal.startMaintenance(stale, claim.continuationId)
    internal.activeMaintenance.set(id, { agent: stale, promise: Promise.resolve() })
    release.resolve(undefined)
    await running
    expect(internal.activeMaintenance.has(id)).toBe(true)
    internal.activeMaintenance.clear()

    const cleanup = new Error('owned handle cleanup failed')
    vi.spyOn(internal, 'releaseOwnedHandleIfInactive').mockRejectedValueOnce(cleanup)
    const retry = vi.spyOn(internal, 'scheduleRecoveryRetry').mockImplementation(() => undefined)
    await internal.startMaintenance({
      id,
      runMaintenance: () => Promise.resolve(),
    } as unknown as Agent, claim.continuationId)
    expect(retry).toHaveBeenCalledWith(cleanup, expect.stringContaining('claim'))
  })
})

describe('durable task continuation claim processing', () => {
  it('honors aborted and stopped signals before verification', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const { agent, claim } = await pendingClaim(context, 'process-stop')
    const controller = new AbortController()
    controller.abort()
    await internal.processClaim(agent, claim.continuationId, controller.signal)

    internal.stopping = true
    await internal.processClaim(agent, claim.continuationId, new AbortController().signal)
  })

  it('stops on durable dispatch evidence and on authority loss before wake publication', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const base = await pendingClaim(context, 'process-dispatch-authority')
    const consumed = Object.freeze({ ...base.claim, state: 'consumed' as const, recordRevision: 2 })
    const agent = fakeAgent(consumed)
    vi.spyOn(internal, 'isExactLiveAgent').mockReturnValue(true)
    vi.spyOn(internal, 'terminateReplacedTask').mockResolvedValue(false)
    vi.spyOn(internal.store, 'get').mockResolvedValue(consumed)
    const reconcile = vi.spyOn(internal, 'reconcileDurableDispatch').mockResolvedValueOnce(true)
    const acquire = vi.spyOn(internal, 'acquireOwnedDispatchLease')
      .mockImplementation(claim => Promise.resolve(dispatchLease(claim)))

    await internal.processClaim(agent, consumed.continuationId, new AbortController().signal)
    expect(reconcile).toHaveBeenCalled()

    reconcile.mockResolvedValue(false)
    acquire.mockClear()
    vi.spyOn(internal, 'ensureExactMarker').mockResolvedValue(true)
    vi.spyOn(internal, 'requireSessionFlush').mockResolvedValue(undefined)
    const renew = vi.spyOn(internal, 'renewOwnedDispatchLease').mockResolvedValue(undefined)
    await internal.processClaim(agent, consumed.continuationId, new AbortController().signal)
    expect(renew).toHaveBeenCalledWith(consumed)
    expect(agent.inbox.nextTurn).toEqual([])
  })

  it('expires captured claims before verification with both winning and losing transitions', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const base = await pendingClaim(context, 'process-expiry')
    const expired = Object.freeze({ ...base.claim, expiresAtMs: Date.now() - 1 })
    const agent = fakeAgent(expired)
    vi.spyOn(internal, 'isExactLiveAgent').mockReturnValue(true)
    vi.spyOn(internal, 'terminateReplacedTask').mockResolvedValue(false)
    vi.spyOn(internal.store, 'get').mockResolvedValue(expired)
    const transition = vi.spyOn(internal, 'transitionCaptured')
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(terminal(expired, 'expired'))
    const remove = vi.spyOn(internal, 'removeMarkerAndFlush').mockResolvedValue(undefined)

    await internal.processClaim(agent, expired.continuationId, new AbortController().signal)
    await internal.processClaim(agent, expired.continuationId, new AbortController().signal)
    expect(transition.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(remove).toHaveBeenCalled()
  })

  it('handles not-ready, stale, invalid, and lost ready verifier decisions', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const base = await pendingClaim(context, 'process-verifier')
    const agent = fakeAgent(base.claim)
    vi.spyOn(internal, 'isExactLiveAgent').mockReturnValue(true)
    vi.spyOn(internal, 'terminateReplacedTask').mockResolvedValue(false)
    const get = vi.spyOn(internal.store, 'get')
    const transition = vi.spyOn(internal, 'transitionCaptured')
    const remove = vi.spyOn(internal, 'removeMarkerAndFlush').mockResolvedValue(undefined)
    const verifier = context.taskContinuations.registerVerifier({
      id: taskContinuationVerifierId('driver-verifier'),
      verify: () => Promise.resolve({ kind: 'not-ready' }),
    })

    get.mockResolvedValue(base.claim)
    await internal.processClaim(agent, base.claim.continuationId, new AbortController().signal)

    verifier()
    context.taskContinuations.registerVerifier({
      id: taskContinuationVerifierId('driver-verifier'),
      verify: claim => Promise.resolve(ready(claim)),
    })
    get.mockReset().mockResolvedValueOnce(base.claim).mockResolvedValueOnce(undefined)
    await internal.processClaim(agent, base.claim.continuationId, new AbortController().signal)

    get.mockReset().mockResolvedValue(base.claim)
    transition.mockReset().mockResolvedValueOnce(undefined)
    context.taskContinuations.registerVerifier({
      id: taskContinuationVerifierId('wrong-ready-verifier'),
      verify: claim => Promise.resolve({ ...ready(claim), taskRevision: taskContinuationRevision('wrong') }),
    })
    const wrongVerifierClaim = Object.freeze({
      ...base.claim,
      verifierId: taskContinuationVerifierId('wrong-ready-verifier'),
    })
    get.mockReset().mockResolvedValue(wrongVerifierClaim)
    await internal.processClaim(agent, wrongVerifierClaim.continuationId, new AbortController().signal)
    expect(remove).not.toHaveBeenCalled()

    transition.mockReset().mockResolvedValueOnce(terminal(wrongVerifierClaim, 'invalid'))
    remove.mockClear()
    await internal.processClaim(agent, wrongVerifierClaim.continuationId, new AbortController().signal)
    expect(remove).toHaveBeenCalled()

    transition.mockReset().mockResolvedValueOnce(undefined)
    get.mockReset().mockResolvedValue(base.claim)
    await internal.processClaim(agent, base.claim.continuationId, new AbortController().signal)
  })

  it('settles an already-aborted verifier race without waiting for a non-cooperative verifier', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const base = await pendingClaim(context, 'process-verifier-abort')
    const agent = fakeAgent(base.claim)
    const controller = new AbortController()
    vi.spyOn(internal, 'isExactLiveAgent').mockReturnValue(true)
    vi.spyOn(internal, 'terminateReplacedTask').mockImplementation(async () => {
      controller.abort()
      return false
    })
    vi.spyOn(internal.store, 'get').mockResolvedValue(base.claim)
    context.taskContinuations.registerVerifier({
      id: taskContinuationVerifierId('driver-verifier'),
      verify: () => new Promise(() => {}),
    })

    await internal.processClaim(agent, base.claim.continuationId, controller.signal)
  })

  it('propagates verifier failures but settles a failure caused by upstream cancellation', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const base = await pendingClaim(context, 'process-verifier-failure')
    const agent = fakeAgent(base.claim)
    vi.spyOn(internal, 'isExactLiveAgent').mockReturnValue(true)
    vi.spyOn(internal, 'terminateReplacedTask').mockResolvedValue(false)
    vi.spyOn(internal.store, 'get').mockResolvedValue(base.claim)
    const failedVerifier = context.taskContinuations.registerVerifier({
      id: taskContinuationVerifierId('driver-verifier'),
      verify: () => Promise.reject(new Error('verifier failed')),
    })

    await expect(internal.processClaim(agent, base.claim.continuationId, new AbortController().signal))
      .rejects.toThrow('verifier failed')
    failedVerifier()

    const started = Promise.withResolvers<undefined>()
    const controller = new AbortController()
    context.taskContinuations.registerVerifier({
      id: taskContinuationVerifierId('driver-verifier'),
      verify: (_claim, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('verifier canceled')) }, { once: true })
        started.resolve(undefined)
      }),
    })
    const processing = internal.processClaim(agent, base.claim.continuationId, controller.signal)
    await started.promise
    controller.abort()
    await expect(processing).resolves.toBeUndefined()
  })

  it('leaves a concurrent terminal transition authoritative after verifier timeout', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots, true, { verifierTimeoutMs: 1 })
    const internal = driver(context)
    const base = await pendingClaim(context, 'process-verifier-timeout-race')
    const agent = fakeAgent(base.claim)
    vi.spyOn(internal, 'isExactLiveAgent').mockReturnValue(true)
    vi.spyOn(internal, 'terminateReplacedTask').mockResolvedValue(false)
    vi.spyOn(internal.store, 'get').mockResolvedValue(base.claim)
    const transition = vi.spyOn(internal, 'transitionCaptured').mockResolvedValue(undefined)
    const warn = vi.spyOn(context.logger, 'warn').mockImplementation(() => undefined)
    context.taskContinuations.registerVerifier({
      id: taskContinuationVerifierId('driver-verifier'),
      verify: () => new Promise(() => {}),
    })

    await internal.processClaim(agent, base.claim.continuationId, new AbortController().signal)
    expect(transition).toHaveBeenCalledWith(base.claim, 'invalid')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timed out after 1ms'))
  })

  it('covers every ready and consumed fence before dispatch', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const base = await pendingClaim(context, 'process-ready')
    const readyClaim = terminal(base.claim, 'ready')
    const consumed = terminal(readyClaim, 'consumed')
    const agent = fakeAgent(readyClaim)
    vi.spyOn(internal, 'isExactLiveAgent').mockReturnValue(true)
    vi.spyOn(internal, 'terminateReplacedTask').mockResolvedValue(false)
    vi.spyOn(internal, 'requireSessionFlush').mockResolvedValue(undefined)
    const get = vi.spyOn(internal.store, 'get')
    const marker = vi.spyOn(internal, 'ensureExactMarker')
    const transition = vi.spyOn(internal, 'transitionCaptured')
    vi.spyOn(internal, 'acquireOwnedDispatchLease').mockImplementation(claim => Promise.resolve(dispatchLease(claim)))
    vi.spyOn(internal, 'renewOwnedDispatchLease').mockImplementation(claim => Promise.resolve(dispatchLease(claim)))

    get.mockResolvedValue(readyClaim)
    marker.mockResolvedValueOnce(false)
    await internal.processClaim(agent, readyClaim.continuationId, new AbortController().signal)

    marker.mockReset().mockResolvedValue(true)
    vi.spyOn(internal, 'terminateReplacedTask').mockReset().mockResolvedValueOnce(true)
    await internal.processClaim(agent, readyClaim.continuationId, new AbortController().signal)

    vi.spyOn(internal, 'terminateReplacedTask').mockReset().mockResolvedValue(false)
    transition.mockReset().mockResolvedValueOnce(undefined)
    await internal.processClaim(agent, readyClaim.continuationId, new AbortController().signal)

    transition.mockReset().mockResolvedValueOnce(readyClaim)
    await internal.processClaim(agent, readyClaim.continuationId, new AbortController().signal)

    const expiredConsumed = Object.freeze({ ...consumed, expiresAtMs: Date.now() - 1 })
    get.mockReset().mockResolvedValue(expiredConsumed)
    transition.mockReset().mockResolvedValueOnce(undefined).mockResolvedValueOnce(terminal(expiredConsumed, 'expired'))
    await internal.processClaim(agent, expiredConsumed.continuationId, new AbortController().signal)
    await internal.processClaim(agent, expiredConsumed.continuationId, new AbortController().signal)

    get.mockReset().mockResolvedValue(consumed)
    marker.mockReset().mockResolvedValue(false)
    await internal.processClaim(agent, consumed.continuationId, new AbortController().signal)
  })

  it('rejects stale consumed snapshots and survives both dispatch checkpoint cleanup outcomes', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const base = await pendingClaim(context, 'process-dispatch-fault')
    const consumed = Object.freeze({ ...base.claim, state: 'consumed' as const, recordRevision: 2 })
    const agent = fakeAgent(consumed)
    vi.spyOn(internal, 'isExactLiveAgent').mockReturnValue(true)
    vi.spyOn(internal, 'terminateReplacedTask').mockResolvedValue(false)
    vi.spyOn(internal, 'reconcileDurableDispatch').mockResolvedValue(false)
    vi.spyOn(internal, 'ensureExactMarker').mockResolvedValue(true)
    vi.spyOn(internal, 'acquireOwnedDispatchLease').mockImplementation(claim => Promise.resolve(dispatchLease(claim)))
    vi.spyOn(internal, 'renewOwnedDispatchLease').mockImplementation(claim => Promise.resolve(dispatchLease(claim)))
    const flush = vi.spyOn(internal, 'requireSessionFlush').mockResolvedValue(undefined)
    const get = vi.spyOn(internal.store, 'get')

    for (const latest of [
      undefined,
      Object.freeze({ ...consumed, recordRevision: 3 }),
      Object.freeze({ ...consumed, state: 'ready' as const }),
    ]) {
      get.mockReset().mockResolvedValueOnce(consumed).mockResolvedValueOnce(latest)
      await internal.processClaim(agent, consumed.continuationId, new AbortController().signal)
    }

    get.mockReset().mockResolvedValue(consumed)
    vi.spyOn(internal, 'terminateReplacedTask').mockReset()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    await internal.processClaim(agent, consumed.continuationId, new AbortController().signal)

    vi.spyOn(internal, 'terminateReplacedTask').mockReset().mockResolvedValue(false)
    flush.mockReset()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('dispatch flush failed'))
      .mockResolvedValueOnce(undefined)
    get.mockReset().mockResolvedValue(consumed)
    await expect(internal.processClaim(agent, consumed.continuationId, new AbortController().signal))
      .rejects.toThrow(/dispatch flush failed/)

    flush.mockReset()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('dispatch flush failed twice'))
      .mockRejectedValueOnce(new Error('cleanup flush failed'))
    await expect(internal.processClaim(agent, consumed.continuationId, new AbortController().signal))
      .rejects.toThrow(/dispatch flush failed twice/)

    flush.mockReset().mockResolvedValue(undefined)
    for (const flushed of [
      undefined,
      Object.freeze({ ...consumed, recordRevision: 3 }),
      Object.freeze({ ...consumed, state: 'ready' as const }),
    ]) {
      get.mockReset()
        .mockResolvedValueOnce(consumed)
        .mockResolvedValueOnce(consumed)
        .mockResolvedValueOnce(flushed)
      await internal.processClaim(agent, consumed.continuationId, new AbortController().signal)
    }
  })

  it('rechecks expiry after readiness changes while the claim is being consumed', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const base = await pendingClaim(context, 'process-midflight-expiry')
    const readyClaim = Object.freeze({ ...base.claim, state: 'ready' as const, recordRevision: 1 })
    const consumed = Object.freeze({ ...readyClaim, state: 'consumed' as const, recordRevision: 2 })
    const agent = fakeAgent(readyClaim)
    let now = readyClaim.expiresAtMs - 1
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    vi.spyOn(internal, 'isExactLiveAgent').mockReturnValue(true)
    vi.spyOn(internal, 'terminateReplacedTask').mockResolvedValue(false)
    vi.spyOn(internal.store, 'get').mockResolvedValue(readyClaim)
    vi.spyOn(internal, 'ensureExactMarker').mockResolvedValue(true)
    vi.spyOn(internal, 'requireSessionFlush').mockImplementation(async () => { now += 1 })
    let expiryWins = false
    const transition = vi.spyOn(internal, 'transitionCaptured').mockImplementation((_claim, to) => {
      if (to === 'consumed') return Promise.resolve(consumed)
      if (to === 'expired') {
        return Promise.resolve(expiryWins ? terminal(consumed, 'expired') : undefined)
      }
      return Promise.resolve(undefined)
    })
    const remove = vi.spyOn(internal, 'removeMarkerAndFlush').mockResolvedValue(undefined)

    await internal.processClaim(agent, readyClaim.continuationId, new AbortController().signal)
    now = readyClaim.expiresAtMs - 1
    expiryWins = true
    await internal.processClaim(agent, readyClaim.continuationId, new AbortController().signal)
    expect(transition.mock.calls.filter(([, to]) => to === 'expired').length).toBeGreaterThanOrEqual(2)
    expect(remove).toHaveBeenCalled()
  })
})

describe('durable task continuation admission', () => {
  it('delegates ordinary work and rejects duplicate, stopping, malformed, and cross-session markers', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const base = await pendingClaim(context, 'admission-inputs')
    const consumed = Object.freeze({ ...base.claim, state: 'consumed' as const, recordRevision: 2 })
    const message = taskContinuationMessage(consumed)
    const agent = fakeAgent(consumed)
    const ordinary = createUserMessage({ content: [{ type: 'text', text: 'ordinary' }], source: { kind: 'user' } })
    const enter = { kind: 'enter' as const, messages: [ordinary] }
    const next = vi.fn().mockResolvedValue(enter)

    await expect(internal.admitContinuation(agent, [ordinary], new AbortController().signal, next))
      .resolves.toBe(enter)
    expect(next).toHaveBeenCalledOnce()

    const restore = vi.spyOn(internal, 'restoreOtherClaimed').mockImplementation(() => undefined)
    const duplicate = Object.freeze({ ...message, id: MessageId('duplicate-continuation') })
    await expect(internal.admitContinuation(agent, [message, duplicate], new AbortController().signal, next))
      .resolves.toEqual({ kind: 'reject' })
    expect(restore).toHaveBeenCalled()

    internal.stopping = true
    await expect(internal.admitContinuation(agent, [message], new AbortController().signal, next))
      .resolves.toEqual({ kind: 'reject' })
    internal.stopping = false

    const malformed = Object.freeze({ ...message, source: { kind: 'task-continuation' as const } }) as UserMessage
    await expect(internal.admitContinuation(agent, [malformed], new AbortController().signal, next))
      .resolves.toEqual({ kind: 'reject' })
    const crossSession = Object.freeze({
      ...message,
      source: { ...message.source, sessionId: SessionId('other-session') },
    }) as UserMessage
    await expect(internal.admitContinuation(agent, [crossSession], new AbortController().signal, next))
      .resolves.toEqual({ kind: 'reject' })
  })

  it('rejects every absent, stale, expired, and non-canonical durable marker', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const base = await pendingClaim(context, 'admission-claim-fences')
    const consumed = Object.freeze({ ...base.claim, state: 'consumed' as const, recordRevision: 2 })
    const message = taskContinuationMessage(consumed)
    const agent = fakeAgent(consumed)
    const get = vi.spyOn(internal.store, 'get')
    const transition = vi.spyOn(internal, 'transitionCaptured').mockResolvedValue(undefined)
    vi.spyOn(internal, 'restoreOtherClaimed').mockImplementation(() => undefined)
    vi.spyOn(internal, 'requestDrive').mockImplementation(() => undefined)
    const next = vi.fn<() => Promise<PreStepDecision>>().mockResolvedValue({ kind: 'enter', messages: [message] })

    const invalidClaims: Array<TaskContinuationClaim | undefined> = [
      undefined,
      base.claim,
      Object.freeze({ ...consumed, sessionId: SessionId('other-session') }),
      Object.freeze({ ...consumed, taskRevision: taskContinuationRevision('wrong-revision') }),
    ]
    for (const claim of invalidClaims) {
      get.mockReset().mockResolvedValue(claim)
      await expect(internal.admitContinuation(agent, [message], new AbortController().signal, next))
        .resolves.toEqual({ kind: 'reject' })
    }

    const expired = Object.freeze({ ...consumed, expiresAtMs: Date.now() - 1 })
    get.mockReset().mockResolvedValue(expired)
    await expect(internal.admitContinuation(agent, [taskContinuationMessage(expired)], new AbortController().signal, next))
      .resolves.toEqual({ kind: 'reject' })
    expect(transition).toHaveBeenCalledWith(expired, 'expired')
  })

  it('rejects replacement before and after downstream admission', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const base = await pendingClaim(context, 'admission-replacement')
    const consumed = Object.freeze({ ...base.claim, state: 'consumed' as const, recordRevision: 2 })
    const message = taskContinuationMessage(consumed)
    const agent = fakeAgent(consumed)
    vi.spyOn(internal.store, 'get').mockResolvedValue(consumed)
    vi.spyOn(internal, 'restoreOtherClaimed').mockImplementation(() => undefined)
    vi.spyOn(internal, 'requestDrive').mockImplementation(() => undefined)
    vi.spyOn(internal, 'renewOwnedDispatchLease').mockImplementation(claim => Promise.resolve(dispatchLease(claim)))
    const replaced = vi.spyOn(internal, 'terminateReplacedTask')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const next = vi.fn<() => Promise<PreStepDecision>>().mockResolvedValue({ kind: 'enter', messages: [message] })

    await expect(internal.admitContinuation(agent, [message], new AbortController().signal, next))
      .resolves.toEqual({ kind: 'reject' })
    await expect(internal.admitContinuation(agent, [message], new AbortController().signal, next))
      .resolves.toEqual({ kind: 'reject' })
    expect(replaced.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('rejects authority loss at every pre-provider lease and barrier fence', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const base = await pendingClaim(context, 'admission-authority-loss')
    const consumed = Object.freeze({ ...base.claim, state: 'consumed' as const, recordRevision: 2 })
    const message = taskContinuationMessage(consumed)
    const decision = { kind: 'enter' as const, messages: [message] }
    const agent = fakeAgent(consumed)
    vi.spyOn(internal.store, 'get').mockResolvedValue(consumed)
    vi.spyOn(internal, 'terminateReplacedTask').mockResolvedValue(false)
    const restore = vi.spyOn(internal, 'restoreOtherClaimed').mockImplementation(() => undefined)
    const drive = vi.spyOn(internal, 'requestDrive').mockImplementation(() => undefined)
    const renew = vi.spyOn(internal, 'renewOwnedDispatchLease')
    const claimDispatch = vi.spyOn(internal.store, 'claimDispatch')
    const next = vi.fn<() => Promise<PreStepDecision>>().mockResolvedValue(decision)

    renew.mockResolvedValueOnce(undefined)
    await expect(internal.admitContinuation(agent, [message], new AbortController().signal, next))
      .resolves.toEqual({ kind: 'reject' })
    expect(next).not.toHaveBeenCalled()

    renew.mockReset()
      .mockResolvedValueOnce(dispatchLease(consumed))
      .mockResolvedValueOnce(undefined)
    await expect(internal.admitContinuation(agent, [message], new AbortController().signal, next))
      .resolves.toEqual({ kind: 'reject' })
    expect(next).toHaveBeenCalledOnce()
    expect(claimDispatch).not.toHaveBeenCalled()

    next.mockClear()
    renew.mockReset().mockImplementation(claim => Promise.resolve(dispatchLease(claim)))
    claimDispatch.mockResolvedValueOnce(undefined)
    await expect(internal.admitContinuation(agent, [message], new AbortController().signal, next))
      .resolves.toEqual({ kind: 'reject' })
    expect(next).toHaveBeenCalledOnce()
    expect(claimDispatch).toHaveBeenCalledOnce()
    expect(restore).toHaveBeenCalledTimes(3)
    expect(drive).toHaveBeenCalledTimes(3)
  })

  it('restores downstream work for explicit rejection and an aborted enter decision', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const base = await pendingClaim(context, 'admission-downstream-reject')
    const consumed = Object.freeze({ ...base.claim, state: 'consumed' as const, recordRevision: 2 })
    const message = taskContinuationMessage(consumed)
    const ordinary = createUserMessage({ content: [{ type: 'text', text: 'restore me' }], source: { kind: 'user' } })
    const agent = fakeAgent(consumed)
    vi.spyOn(internal.store, 'get').mockResolvedValue(consumed)
    vi.spyOn(internal, 'terminateReplacedTask').mockResolvedValue(false)
    vi.spyOn(internal, 'renewOwnedDispatchLease').mockImplementation(claim => Promise.resolve(dispatchLease(claim)))
    vi.spyOn(internal.store, 'claimDispatch').mockImplementation(claim => Promise.resolve(terminal(claim, 'claimed')))
    vi.spyOn(internal, 'retireOwnedDispatchLease').mockResolvedValue(undefined)
    const restore = vi.spyOn(internal, 'restoreOtherClaimed').mockImplementation(() => undefined)
    vi.spyOn(internal, 'requestDrive').mockImplementation(() => undefined)

    const rejected = { kind: 'reject' as const }
    await expect(internal.admitContinuation(
      agent,
      [message, ordinary],
      new AbortController().signal,
      () => Promise.resolve(rejected),
    )).resolves.toBe(rejected)

    const controller = new AbortController()
    controller.abort()
    await expect(internal.admitContinuation(
      agent,
      [message],
      controller.signal,
      () => Promise.resolve({ kind: 'enter', messages: [message, ordinary] }),
    )).resolves.toEqual({ kind: 'reject' })
    expect(restore).toHaveBeenNthCalledWith(1, agent, [message, ordinary], expect.any(Set))
    expect(restore).toHaveBeenNthCalledWith(2, agent, [message, ordinary], expect.any(Set))
  })

  it('rejects a downstream batch containing duplicate canonical continuation messages', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const base = await pendingClaim(context, 'admission-duplicate-final')
    const consumed = Object.freeze({ ...base.claim, state: 'consumed' as const, recordRevision: 2 })
    const message = taskContinuationMessage(consumed)
    const agent = fakeAgent(consumed)
    vi.spyOn(internal.store, 'get').mockResolvedValue(consumed)
    vi.spyOn(internal, 'terminateReplacedTask').mockResolvedValue(false)
    vi.spyOn(internal, 'renewOwnedDispatchLease')
      .mockImplementation(claim => Promise.resolve(dispatchLease(claim)))
    const claimDispatch = vi.spyOn(internal.store, 'claimDispatch')
    const restore = vi.spyOn(internal, 'restoreOtherClaimed').mockImplementation(() => undefined)
    vi.spyOn(internal, 'requestDrive').mockImplementation(() => undefined)

    await expect(internal.admitContinuation(
      agent,
      [message],
      new AbortController().signal,
      () => Promise.resolve({ kind: 'enter', messages: [message, message] }),
    )).resolves.toEqual({ kind: 'reject' })
    expect(claimDispatch).not.toHaveBeenCalled()
    expect(restore).toHaveBeenCalledWith(agent, [message, message], new Set([message.id]), true)
  })

  it('checks every post-listener durable fence, expiry, canonical message, and success path', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const base = await pendingClaim(context, 'admission-post-fences')
    const consumed = Object.freeze({ ...base.claim, state: 'consumed' as const, recordRevision: 2 })
    const message = taskContinuationMessage(consumed)
    const agent = fakeAgent(consumed)
    const get = vi.spyOn(internal.store, 'get')
    const terminate = vi.spyOn(internal, 'terminateReplacedTask').mockResolvedValue(false)
    const restore = vi.spyOn(internal, 'restoreOtherClaimed').mockImplementation(() => undefined)
    const transition = vi.spyOn(internal, 'transitionCaptured').mockResolvedValue(undefined)
    vi.spyOn(internal, 'renewOwnedDispatchLease').mockImplementation(claim => Promise.resolve(dispatchLease(claim)))
    vi.spyOn(internal.store, 'claimDispatch').mockImplementation(claim => Promise.resolve(terminal(claim, 'claimed')))
    vi.spyOn(internal, 'retireOwnedDispatchLease').mockResolvedValue(undefined)
    vi.spyOn(internal, 'requestDrive').mockImplementation(() => undefined)
    const decision = { kind: 'enter' as const, messages: [message] }

    const staleClaims: Array<TaskContinuationClaim | undefined> = [
      undefined,
      Object.freeze({ ...consumed, state: 'ready' as const }),
      Object.freeze({ ...consumed, recordRevision: 3 }),
      Object.freeze({ ...consumed, sessionId: SessionId('other-session') }),
      Object.freeze({ ...consumed, taskRevision: taskContinuationRevision('other-revision') }),
    ]
    for (const latest of staleClaims) {
      get.mockReset().mockResolvedValueOnce(consumed).mockResolvedValueOnce(latest)
      await expect(internal.admitContinuation(
        agent,
        [message],
        new AbortController().signal,
        () => Promise.resolve(decision),
      )).resolves.toEqual({ kind: 'reject' })
    }

    const expired = Object.freeze({ ...consumed, expiresAtMs: Date.now() - 1 })
    get.mockReset().mockResolvedValueOnce(consumed).mockResolvedValueOnce(expired)
    await expect(internal.admitContinuation(
      agent,
      [message],
      new AbortController().signal,
      () => Promise.resolve(decision),
    )).resolves.toEqual({ kind: 'reject' })
    expect(transition).toHaveBeenCalledWith(expired, 'expired')

    get.mockReset().mockResolvedValue(consumed)
    terminate.mockReset().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await expect(internal.admitContinuation(
      agent,
      [message],
      new AbortController().signal,
      () => Promise.resolve(decision),
    )).resolves.toEqual({ kind: 'reject' })

    terminate.mockReset().mockResolvedValue(false)
    await expect(internal.admitContinuation(
      agent,
      [message],
      new AbortController().signal,
      () => Promise.resolve({ kind: 'enter', messages: [] }),
    )).resolves.toEqual({ kind: 'reject' })
    await expect(internal.admitContinuation(
      agent,
      [message],
      new AbortController().signal,
      () => Promise.resolve(decision),
    )).resolves.toBe(decision)
    expect(restore).toHaveBeenCalled()
  })

  it('keeps the SIGKILL window after admission at-most-once through a durable claimed barrier', async () => {
    const runtimeRoots = await allocateRoots()
    const first = await mountRuntime(runtimeRoots)
    const internal = driver(first)
    const base = await pendingClaim(first, 'claimed-kill-window')
    await new Promise<void>(resolve => setTimeout(resolve, 20))
    const readyClaim = await internal.store.transition({
      id: base.claim.continuationId,
      from: ['pending'],
      to: 'ready',
      expectedRecordRevision: 0,
      updatedAtMs: Date.now(),
    })
    if (readyClaim === undefined) throw new Error('kill-window ready transition lost')
    const consumed = await internal.store.transition({
      id: readyClaim.continuationId,
      from: ['ready'],
      to: 'consumed',
      expectedRecordRevision: 1,
      updatedAtMs: Date.now(),
    })
    if (consumed === undefined) throw new Error('kill-window consumed transition lost')
    await internal.acquireOwnedDispatchLease(consumed)
    vi.spyOn(internal, 'terminateReplacedTask').mockResolvedValue(false)
    const message = taskContinuationMessage(consumed)

    await expect(internal.admitContinuation(
      fakeAgent(consumed),
      [message],
      new AbortController().signal,
      () => Promise.resolve({ kind: 'enter', messages: [message] }),
    )).resolves.toEqual({ kind: 'enter', messages: [message] })
    await expect(first.taskContinuations.get(consumed.continuationId)).resolves.toMatchObject({ state: 'claimed' })
    expect(base.agent.session.events.some(event => event.type === 'user/message'
      && event.data.id === consumed.dispatchMessageId)).toBe(false)

    await first.fiber.dispose()
    const second = await mountRuntime(runtimeRoots)
    await new Promise<void>(resolve => setTimeout(resolve, 30))
    await expect(second.taskContinuations.get(consumed.continuationId)).resolves.toMatchObject({ state: 'claimed' })
    expect(second.agents.get(consumed.sessionId)).toBeUndefined()
  })
})

describe('durable task continuation dispatch reconciliation', () => {
  it('classifies absent, duplicate, malformed, and late durable dispatch events', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const base = await pendingClaim(context, 'reconcile-dispatch')
    const consumed = Object.freeze({ ...base.claim, state: 'consumed' as const, recordRevision: 2 })
    const dispatch = taskContinuationMessage(consumed)
    const event = { type: 'user/message', seq: 2, time: Date.now(), data: dispatch }
    const transition = vi.spyOn(internal, 'transitionCaptured')
    const remove = vi.spyOn(internal, 'removeMarkerAndFlush').mockResolvedValue(undefined)

    await expect(internal.reconcileDurableDispatch(fakeAgent(consumed), consumed)).resolves.toBe(false)

    transition.mockResolvedValueOnce(undefined)
    await expect(internal.reconcileDurableDispatch(fakeAgent(consumed, [event, event]), consumed)).resolves.toBe(true)

    transition.mockResolvedValueOnce(terminal(consumed, 'invalid'))
    const malformed = { ...event, data: { ...dispatch, content: [] } }
    await expect(internal.reconcileDurableDispatch(fakeAgent(consumed, [malformed]), consumed)).resolves.toBe(true)
    expect(remove).toHaveBeenCalled()

    const lateClaim = Object.freeze({ ...consumed, expiresAtMs: event.time })
    const lateEvent = { ...event, data: taskContinuationMessage(lateClaim) }
    transition.mockResolvedValueOnce(undefined)
    await expect(internal.reconcileDurableDispatch(fakeAgent(lateClaim, [lateEvent]), lateClaim)).resolves.toBe(true)
    transition.mockResolvedValueOnce(terminal(lateClaim, 'expired'))
    await expect(internal.reconcileDurableDispatch(fakeAgent(lateClaim, [lateEvent]), lateClaim)).resolves.toBe(true)
  })

  it('checks replacement around the flush and fences the consumed-to-claimed transition', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const base = await pendingClaim(context, 'reconcile-dispatch-fences')
    const consumed = Object.freeze({ ...base.claim, state: 'consumed' as const, recordRevision: 2 })
    const event = {
      type: 'user/message',
      seq: 2,
      time: Date.now(),
      data: taskContinuationMessage(consumed),
    }
    const agent = fakeAgent(consumed, [event])
    const terminate = vi.spyOn(internal, 'terminateReplacedTask')
    const flush = vi.spyOn(internal, 'requireSessionFlush').mockResolvedValue(undefined)
    const transition = vi.spyOn(internal, 'transitionCaptured')
    const remove = vi.spyOn(internal, 'removeMarkerAndFlush').mockResolvedValue(undefined)

    terminate.mockResolvedValueOnce(true)
    await expect(internal.reconcileDurableDispatch(agent, consumed)).resolves.toBe(true)
    expect(flush).not.toHaveBeenCalled()

    terminate.mockReset().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await expect(internal.reconcileDurableDispatch(agent, consumed)).resolves.toBe(true)
    expect(flush).toHaveBeenCalled()

    terminate.mockReset().mockResolvedValue(false)
    transition.mockResolvedValueOnce(undefined)
    await expect(internal.reconcileDurableDispatch(agent, consumed)).resolves.toBe(true)
    transition.mockResolvedValueOnce(terminal(consumed, 'claimed'))
    await expect(internal.reconcileDurableDispatch(agent, consumed)).resolves.toBe(true)
    expect(remove).toHaveBeenCalled()
  })

  it('repairs missing and next-step markers and invalidates duplicate or malformed identities', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const base = await pendingClaim(context, 'marker-repair')
    const claim = base.claim
    const marker = taskContinuationMessage(claim)
    const transition = vi.spyOn(internal, 'transitionCaptured')
    const remove = vi.spyOn(internal, 'removeMarkerAndFlush').mockResolvedValue(undefined)

    const absent = fakeAgent(claim)
    await expect(internal.ensureExactMarker(absent, claim)).resolves.toBe(true)
    expect(absent.inbox.nextTurn).toEqual([marker])

    const parked = fakeAgent(claim)
    parked.inbox.nextTurn.push(marker)
    await expect(internal.ensureExactMarker(parked, claim)).resolves.toBe(true)

    const moved = fakeAgent(claim)
    moved.inbox.nextStep.push(marker)
    await expect(internal.ensureExactMarker(moved, claim)).resolves.toBe(true)
    expect(moved.inbox.nextStep).toEqual([])
    expect(moved.inbox.nextTurn).toEqual([marker])

    const duplicate = fakeAgent(claim)
    duplicate.inbox.nextStep.push(marker)
    duplicate.inbox.nextTurn.push(marker)
    transition.mockResolvedValueOnce(undefined)
    await expect(internal.ensureExactMarker(duplicate, claim)).resolves.toBe(false)

    const malformed = fakeAgent(claim)
    malformed.inbox.nextTurn.push(Object.freeze({ ...marker, content: [] }))
    transition.mockResolvedValueOnce(terminal(claim, 'invalid'))
    await expect(internal.ensureExactMarker(malformed, claim)).resolves.toBe(false)
    expect(remove).toHaveBeenCalled()
  })
})

describe('durable task continuation inbox recovery helpers', () => {
  it('restores unique claimed work, ignores exclusions and queued identities, and schedules a direct-user wake', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const base = await pendingClaim(context, 'restore-claimed')
    const agent = fakeAgent(base.claim)
    const first = createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } })
    const duplicate = Object.freeze({ ...first })
    const excluded = createUserMessage({ content: [{ type: 'text', text: 'excluded' }], source: { kind: 'user' } })
    const queued = createUserMessage({ content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' } })
    agent.inbox.nextTurn.push(queued)

    internal.restoreOtherClaimed(agent, [first, duplicate, excluded, queued], new Set([excluded.id]), true)
    expect(agent.inbox.nextStep).toEqual([first])
    expect(internal.pendingUserWakeups.has(agent.id)).toBe(true)

    internal.restoreOtherClaimed(agent, [], new Set(), false)
    const continuation = taskContinuationMessage(base.claim)
    const continuationOnly = fakeAgent(base.claim)
    internal.restoreOtherClaimed(continuationOnly, [continuation], new Set(), true)
    expect(internal.pendingUserWakeups.has(continuationOnly.id)).toBe(true)
  })

  it('wakes direct-user next-step and next-turn work and tolerates empty wake registrations', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const base = await pendingClaim(context, 'wake-user')
    const none = fakeAgent(base.claim)
    internal.wakePendingDirectUser(none)

    internal.pendingUserWakeups.add(none.id)
    none.inbox.nextStep.push(taskContinuationMessage(base.claim))
    internal.wakePendingDirectUser(none)

    const nextStepAgent = fakeAgent(Object.freeze({ ...base.claim, sessionId: SessionId('wake-step') }))
    const step = createUserMessage({ content: [{ type: 'text', text: 'step' }], source: { kind: 'user' } })
    nextStepAgent.inbox.nextStep.push(step)
    internal.pendingUserWakeups.add(nextStepAgent.id)
    internal.wakePendingDirectUser(nextStepAgent)
    expect(nextStepAgent.inbox.nextStep[0]).toBe(step)

    const nextTurnAgent = fakeAgent(Object.freeze({ ...base.claim, sessionId: SessionId('wake-turn') }))
    const turn = createUserMessage({ content: [{ type: 'text', text: 'turn' }], source: { kind: 'user' } })
    nextTurnAgent.inbox.nextTurn.push(turn)
    internal.pendingUserWakeups.add(nextTurnAgent.id)
    internal.wakePendingDirectUser(nextTurnAgent)
    expect(nextTurnAgent.inbox.nextTurn[0]).toBe(turn)
  })

  it('removes only other continuation markers and covers invalid and lost replacement transitions', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const base = await pendingClaim(context, 'helper-replacement')
    const retained = taskContinuationMessage(base.claim)
    const otherClaim = Object.freeze({
      ...base.claim,
      continuationId: continuationId('55555555-5555-4555-8555-555555555555'),
      dispatchMessageId: MessageId('other-dispatch'),
    })
    const other = taskContinuationMessage(otherClaim)
    const user = createUserMessage({ content: [{ type: 'text', text: 'user' }], source: { kind: 'user' } })
    const agent = fakeAgent(base.claim)
    agent.inbox.nextStep.push(other, user)
    agent.inbox.nextTurn.push(retained)
    internal.removeOtherContinuationMarkers(agent, retained.id)
    expect(agent.inbox.nextStep).toEqual([user])
    expect(agent.inbox.nextTurn).toEqual([retained])

    const invalidAgent = fakeAgent(base.claim)
    const transition = vi.spyOn(internal, 'transitionCaptured')
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(terminal(base.claim, 'invalid'))
    const remove = vi.spyOn(internal, 'removeMarkerAndFlush').mockResolvedValue(undefined)
    await expect(internal.terminateReplacedTask(invalidAgent, base.claim)).resolves.toBe(true)
    await expect(internal.terminateReplacedTask(invalidAgent, base.claim)).resolves.toBe(true)
    expect(remove).toHaveBeenCalled()

    const originalEvent = {
      type: 'user/message',
      seq: 1,
      time: Date.now(),
      data: base.original,
    }
    const replacementAgent = fakeAgent(base.claim, [originalEvent])
    const replacement = createUserMessage({ content: [{ type: 'text', text: 'replacement' }], source: { kind: 'user' } })
    transition.mockReset()
    vi.spyOn(internal.store, 'transition').mockResolvedValue(undefined)
    await expect(internal.terminateReplacedTask(replacementAgent, base.claim, [replacement]))
      .resolves.toBe(true)
    await expect(internal.terminateReplacedTask(replacementAgent, base.claim, [], 2))
      .resolves.toBe(false)
    const lateReplacement = {
      type: 'user/message',
      seq: 3,
      time: Date.now(),
      data: replacement,
    }
    await expect(internal.terminateReplacedTask(
      fakeAgent(base.claim, [originalEvent, lateReplacement]),
      base.claim,
      [],
      2,
    )).resolves.toBe(false)
  })

  it('surfaces terminal cleanup while the committed API wrapper schedules recovery', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots)
    const internal = driver(context)
    const base = await pendingClaim(context, 'cleanup-warning')
    const missing = Object.freeze({ ...base.claim, sessionId: SessionId('missing-cleanup-session') })
    await internal.removeLiveMarker(missing)

    const remove = vi.spyOn(internal, 'removeMarkerAndFlush').mockRejectedValue('cleanup failed')
    const warn = vi.spyOn(context.logger, 'warn').mockImplementation(() => undefined)
    await expect(internal.removeLiveMarker(base.claim)).rejects.toBe('cleanup failed')
    await internal.reconcileTerminalBestEffort(base.claim)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cleanup failed'))

    remove.mockResolvedValue(undefined)
    const handleCleanup = new Error('terminal handle release failed')
    vi.spyOn(internal, 'releaseOwnedHandleIfInactive').mockRejectedValueOnce(handleCleanup)
    await expect(internal.removeLiveMarker(base.claim)).rejects.toBe(handleCleanup)
  })
})
